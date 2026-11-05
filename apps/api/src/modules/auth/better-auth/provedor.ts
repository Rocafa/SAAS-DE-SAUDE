/**
 * Provedor de sessão real (D4: Better Auth) atrás da porta `AuthProvider`. Desenho: autenticacao-better-auth.md §§5–6
 * e §12. Passa no contrato do #128 com os 6 ganchos (bancada em test/contrato-provedor-better-auth.rls.test.ts).
 *
 * A cada requisição: sessão da biblioteca → prazo absoluto de 12 h (R3) → conta ativa → campos NOSSOS da sessão
 * (clínica ativa, MFA e impressão dos perfis) → perfis SÓ de `clinic_members` (R6) → `mfaEm` só vale se os perfis não
 * mudaram desde o MFA (`perfis_no_mfa`, R13). A clínica nunca vem do cliente (regra 1).
 */
import { createHash, randomUUID } from 'node:crypto';
import type { TenantId, UserId } from '@plataforma/shared';
import { AuditAction } from '@plataforma/shared';
import { and, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm';

import { fromNodeHeaders } from 'better-auth/node';
import { clinicMembers, tenants } from '../../../db/schema';
import { conta, doisFatores, sessao, usuario, verificacao, vinculo } from '../../../db/identidade';
import { withTenant, type Database } from '../../../db/tenant-transaction';
import { registrarEventoDeSeguranca } from '../../../security/log-de-seguranca';
import { recordAudit } from '../../audit/audit-log';
import type { AuthContext, AuthProvider, ClinicaDaPessoa, ProvedorDeConvite, ProvedorDePessoa, RequisicaoParaSessao, SessaoDePessoa, SessaoListada } from '../auth-context';
import { PERFIS, type Perfil } from '../perfis';
import { PRAZO_ABSOLUTO_MS, type Autenticacao } from './instancia';
import { gerarHashDeSenha } from './senha';
import type { ConferirSenhaVazada } from './senha-vazada';

/** Impressão dos perfis no momento do MFA (16 hex): se os perfis mudam no banco, o MFA deixa de valer (R13). */
export function impressaoDosPerfis(perfis: readonly Perfil[]): string {
  return createHash('sha256').update([...perfis].sort().join(',')).digest('hex').slice(0, 16);
}

/** Só o cookie de sessão (`sessao` em dev/test, `__Host-sessao` fora) volta ao navegador pelo provedor. */
const COOKIE_DE_SESSAO = /^(__Host-)?sessao=/;

/** Prazo para a primeira escolha de clínica aproveitar o TOTP feito sem clínica (R7 do #152, R4 do desenho do PR 3). */
export const PRAZO_MFA_SEM_CLINICA_MS = 5 * 60 * 1000;

/** Resultado do TOTP aceito: MFA marcado, guardado para a escolha de clínica, ou nada (sessão sumiu, sem perfil). */
export type ResultadoDoMfa = 'marcado' | 'sem_clinica' | 'nada';

export interface DependenciasDoProvedor {
  readonly auth: Autenticacao;
  /** Pool do papel `app_auth` (schema identidade e a função de clínicas). */
  readonly dbAuth: Database;
  /** Pool do papel `app_user` (RLS por clínica) para ler os perfis e gravar a trilha. */
  readonly dbClinica: Database;
  readonly agora?: () => Date;
  /** `Set-Cookie` que expira o cookie de sessão (nome e atributos do ambiente), para o logout (R2 do código do 3a). */
  readonly cookieDeEncerramento?: string;
  /** Conferência de senha vazada (R15 e R5 do #152): chamada EXPLICITAMENTE nos caminhos nossos que definem senha. */
  readonly conferirSenhaVazada?: ConferirSenhaVazada;
}

/** R8: a sessão aberta no aceite só serve ao cadastro do TOTP, por no máximo 15 min. */
export const PRAZO_DO_CADASTRO_PENDENTE_MS = 15 * 60 * 1000;

export class BetterAuthProvider implements AuthProvider, ProvedorDePessoa, ProvedorDeConvite {
  readonly tipo = 'better-auth';
  private readonly agora: () => Date;

  constructor(private readonly d: DependenciasDoProvedor) {
    this.agora = d.agora ?? (() => new Date());
  }

  /**
   * Lê a sessão na biblioteca. Na rota de polling, sem estender (R19). Fora dela, quando a biblioteca estende a sessão,
   * só o `Set-Cookie` da SESSÃO volta ao navegador (pendência do #149; R5 do desenho do PR 3): sem isso, o cookie
   * morreria em 15 min com a sessão em uso.
   */
  private async lerSessao(req: RequisicaoParaSessao) {
    const r = await this.d.auth.api
      .getSession({ headers: fromNodeHeaders(req.headers), query: req.semRenovar ? { disableRefresh: true } : {}, returnHeaders: true })
      .catch(() => null);
    if (!r) return null;
    if (!req.semRenovar && req.aoRenovarCookie) {
      const daSessao = r.headers.getSetCookie().filter((c) => COOKIE_DE_SESSAO.test(c));
      if (daSessao.length > 0) req.aoRenovarCookie(daSessao);
    }
    return r.response;
  }

  async resolver(req: RequisicaoParaSessao): Promise<AuthContext | null> {
    const lida = await this.lerSessao(req);
    if (!lida) return null;
    const sessaoId = lida.session.id;
    const [linha] = await this.d.dbAuth
      .select({
        criadaEm: sessao.createdAt,
        clinicaAtiva: sessao.clinicaAtiva,
        mfaEm: sessao.mfaEm,
        perfisNoMfa: sessao.perfisNoMfa,
        cadastroPendenteAte: sessao.cadastroPendenteAte,
        usuarioId: sessao.userId,
        ativo: usuario.ativo,
      })
      .from(sessao)
      .innerJoin(usuario, eq(usuario.id, sessao.userId))
      .where(eq(sessao.id, sessaoId));
    if (!linha) return null;
    // R3: o prazo absoluto vale mesmo com a sessão em uso; a sessão vencida é APAGADA, não só recusada.
    if (this.agora().getTime() - linha.criadaEm.getTime() > PRAZO_ABSOLUTO_MS) {
      await this.encerrar(sessaoId, 'prazo_absoluto', linha.usuarioId);
      return null;
    }
    // Conta desligada (PR 3) não entra, e perde a sessão.
    if (!linha.ativo) {
      await this.encerrar(sessaoId, 'conta_inativa', linha.usuarioId);
      return null;
    }
    // R8: a sessão do aceite só serve ao cadastro do TOTP; nenhuma rota de negócio.
    if (linha.cadastroPendenteAte !== null) return null;
    const userId = linha.usuarioId;
    let tenantId = linha.clinicaAtiva;
    if (!tenantId) {
      // Com uma clínica só, a escolha é automática; com várias, a rota de escolha (PR 3) decide.
      const clinicas = await this.clinicasDoUsuario(userId);
      if (clinicas.length !== 1 || !clinicas[0]) return null;
      tenantId = clinicas[0];
      await this.definirClinica(sessaoId, userId, tenantId);
    }
    const perfis = await this.perfisNoBanco(tenantId, userId);
    if (perfis.length === 0) {
      // R6: vínculo inativo ou sem perfil de sessão ativo → sem acesso e sem clínica ativa.
      await this.d.dbAuth.update(sessao).set({ clinicaAtiva: null, mfaEm: null, perfisNoMfa: null }).where(eq(sessao.id, sessaoId));
      return null;
    }
    const mfaVale = linha.mfaEm !== null && linha.clinicaAtiva === tenantId && linha.perfisNoMfa === impressaoDosPerfis(perfis);
    return { tenantId: tenantId as TenantId, userId: userId as UserId, perfis, mfaEm: mfaVale ? linha.mfaEm : null };
  }

  /**
   * Sessão da pessoa SEM exigir clínica (PR 3a; R3 do desenho do PR 3): as mesmas travas do `resolver` (sessão da
   * biblioteca, prazo absoluto de 12 h que APAGA a sessão, conta ativa), sem ler clínica nem perfis.
   */
  async sessaoDePessoa(req: RequisicaoParaSessao): Promise<SessaoDePessoa | null> {
    const lida = await this.lerSessao(req);
    if (!lida) return null;
    const [linha] = await this.d.dbAuth
      .select({ criadaEm: sessao.createdAt, usuarioId: sessao.userId, ativo: usuario.ativo, cadastroPendenteAte: sessao.cadastroPendenteAte })
      .from(sessao)
      .innerJoin(usuario, eq(usuario.id, sessao.userId))
      .where(eq(sessao.id, lida.session.id));
    if (!linha) return null;
    if (this.agora().getTime() - linha.criadaEm.getTime() > PRAZO_ABSOLUTO_MS) {
      await this.encerrar(lida.session.id, 'prazo_absoluto', linha.usuarioId);
      return null;
    }
    if (!linha.ativo) {
      await this.encerrar(lida.session.id, 'conta_inativa', linha.usuarioId);
      return null;
    }
    // R7 do código do 3a: a sessão de cadastro pendente não usa as rotas da pessoa.
    if (linha.cadastroPendenteAte !== null) return null;
    return { sessaoId: lida.session.id, userId: linha.usuarioId };
  }

  /** Clínicas com vínculo ativo e o nome de cada uma (lido na própria clínica, com RLS). Sem perfis nem contagens. */
  async clinicasDaPessoa(userId: string): Promise<ClinicaDaPessoa[]> {
    const saida: ClinicaDaPessoa[] = [];
    for (const id of await this.clinicasDoUsuario(userId)) {
      const [t] = await withTenant(this.d.dbClinica, id as TenantId, (tx) => tx.select({ nome: tenants.displayName }).from(tenants).where(eq(tenants.id, id)), userId);
      if (t) saida.push({ id, nome: t.nome });
    }
    return saida;
  }

  escolherClinica(s: SessaoDePessoa, clinicaId: string): Promise<boolean> {
    return this.definirClinica(s.sessaoId, s.userId, clinicaId);
  }

  /** Só as sessões da própria pessoa, sem IP, user-agent nem clínica (R20). */
  async sessoesDaPessoa(s: SessaoDePessoa): Promise<SessaoListada[]> {
    const linhas = await this.d.dbAuth
      .select({ id: sessao.id, criadaEm: sessao.createdAt, atualizadaEm: sessao.updatedAt })
      .from(sessao)
      .where(and(eq(sessao.userId, s.userId), gt(sessao.expiresAt, this.agora())))
      .orderBy(desc(sessao.updatedAt));
    return linhas.map((l) => ({ id: l.id, criadaEm: l.criadaEm.toISOString(), ultimaAtividade: l.atualizadaEm.toISOString(), atual: l.id === s.sessaoId }));
  }

  /** Encerra UMA sessão da própria pessoa; o dono é conferido no banco pelo id completo (R6 do desenho do PR 3). */
  async encerrarSessaoDaPessoa(s: SessaoDePessoa, sessaoId: string): Promise<boolean> {
    const apagadas = await this.d.dbAuth
      .delete(sessao)
      .where(and(eq(sessao.id, sessaoId), eq(sessao.userId, s.userId)))
      .returning({ id: sessao.id });
    if (apagadas.length === 0) return false;
    registrarEventoDeSeguranca('LOGOUT', { motivo: 'logout', userId: s.userId });
    await this.trilhaDeSessaoNasClinicas(s.userId, 'session_revoked');
    return true;
  }

  cookieDeEncerramento(): string {
    return this.d.cookieDeEncerramento ?? 'sessao=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict';
  }

  /** Logout global: todas as sessões da pessoa, inclusive a atual. Trilha nas clínicas do vínculo. */
  async encerrarTodasDaPessoa(s: SessaoDePessoa): Promise<number> {
    const apagadas = await this.d.dbAuth.delete(sessao).where(eq(sessao.userId, s.userId)).returning({ id: sessao.id });
    registrarEventoDeSeguranca('LOGOUT', { motivo: 'logout_global', userId: s.userId, contagem: apagadas.length });
    await this.trilhaDeSessaoNasClinicas(s.userId, 'session_logout_global');
    return apagadas.length;
  }

  private async trilhaDeSessaoNasClinicas(userId: string, op: string): Promise<void> {
    for (const tenantId of await this.clinicasDoUsuario(userId)) {
      await withTenant(
        this.d.dbClinica,
        tenantId as TenantId,
        (tx) => recordAudit(tx, { tenantId: tenantId as TenantId, userId: userId as UserId, roles: [] }, { action: AuditAction.Update, scope: 'session', metadata: { op } }),
        userId,
      );
    }
  }

  /**
   * Expurgo diário do schema identidade (job `identidade-expurgo`): sessões vencidas, tokens de uso único vencidos há
   * mais de 24 h e cadastros de TOTP não concluídos há mais de 24 h. Devolve só contagens.
   */
  async expurgarComoSistema(): Promise<{ sessoes: number; verificacoes: number; cadastrosNaoConcluidos: number }> {
    const agora = this.agora();
    const umDia = new Date(agora.getTime() - 24 * 60 * 60 * 1000);
    const sessoes = await this.d.dbAuth.delete(sessao).where(lt(sessao.expiresAt, agora)).returning({ id: sessao.id });
    const verificacoes = await this.d.dbAuth.delete(verificacao).where(lt(verificacao.expiresAt, umDia)).returning({ id: verificacao.id });
    const cadastros = await this.d.dbAuth
      .delete(doisFatores)
      .where(and(eq(doisFatores.verified, false), lt(doisFatores.criadoEm, umDia)))
      .returning({ id: doisFatores.id });
    return { sessoes: sessoes.length, verificacoes: verificacoes.length, cadastrosNaoConcluidos: cadastros.length };
  }

  /** R8: o `enable` do TOTP só é aceito numa sessão de cadastro pendente dentro do prazo. */
  async cadastroLiberado(sessaoId: string): Promise<boolean> {
    const [s] = await this.d.dbAuth.select({ ate: sessao.cadastroPendenteAte }).from(sessao).where(eq(sessao.id, sessaoId));
    return s?.ate != null && s.ate.getTime() > this.agora().getTime();
  }

  /** Conta nova do convite: senha conferida contra vazadas, e-mail único (corrida = conta existente). */
  async criarContaDoConvite(e: {
    userId: string;
    email: string;
    nome: string;
    senha: string;
    clinicaDeOrigem: string;
    conviteDeOrigem: string;
  }): Promise<{ userId: string } | 'conta_existente' | 'senha_vazada'> {
    const email = e.email.trim().toLowerCase();
    const [ja] = await this.d.dbAuth.select({ id: usuario.id }).from(usuario).where(sql`lower(${usuario.email}) = ${email}`);
    if (ja) return 'conta_existente';
    if (this.d.conferirSenhaVazada) {
      try {
        if (await this.d.conferirSenhaVazada(e.senha)) {
          registrarEventoDeSeguranca('SENHA_VAZADA_RECUSADA', { motivo: 'senha_vazada' });
          return 'senha_vazada';
        }
      } catch {
        registrarEventoDeSeguranca('CONFERENCIA_DE_SENHA_INDISPONIVEL', { motivo: 'conferencia_indisponivel' });
      }
    }
    const userId = e.userId;
    try {
      await this.d.dbAuth.transaction(async (tx) => {
        await tx.insert(usuario).values({
          id: userId,
          name: e.nome.trim().slice(0, 200),
          email,
          emailVerified: false,
          clinicaDeOrigem: e.clinicaDeOrigem,
          conviteDeOrigem: e.conviteDeOrigem,
        });
        await tx.insert(conta).values({ id: randomUUID(), accountId: userId, providerId: 'credential', userId, password: await gerarHashDeSenha(e.senha) });
      });
    } catch {
      // Índice único do e-mail: outra pessoa criou a conta no meio do caminho.
      return 'conta_existente';
    }
    return { userId };
  }

  async abrirSessaoDeCadastro(e: { email: string; senha: string; cabecalhos: Headers }): Promise<string[]> {
    const r = await this.d.auth.api.signInEmail({ body: { email: e.email.trim().toLowerCase(), password: e.senha }, headers: e.cabecalhos, asResponse: true });
    const cookies = r.headers.getSetCookie().filter((c) => COOKIE_DE_SESSAO.test(c));
    if (r.status !== 200 || cookies.length === 0) throw new Error('sessao_de_cadastro_nao_abriu');
    const lida = await this.d.auth.api.getSession({ headers: new Headers({ cookie: cookies.map((c) => c.split(';')[0]).join('; ') }) });
    if (!lida) throw new Error('sessao_de_cadastro_nao_abriu');
    await this.d.dbAuth
      .update(sessao)
      .set({ cadastroPendenteAte: new Date(this.agora().getTime() + PRAZO_DO_CADASTRO_PENDENTE_MS) })
      .where(eq(sessao.id, lida.session.id));
    return cookies;
  }

  /** Clínicas com vínculo ativo, pelo espelho `identidade.vinculo` (0064, só ids). */
  async clinicasDoUsuario(userId: string): Promise<string[]> {
    const linhas = await this.d.dbAuth.selectDistinct({ clinicaId: vinculo.clinicaId }).from(vinculo).where(eq(vinculo.usuarioId, userId)).orderBy(vinculo.clinicaId);
    return linhas.map((l) => l.clinicaId);
  }

  /** Perfis de sessão ATIVOS na clínica (RLS da clínica, usuário travado na transação). */
  private async perfisNoBanco(tenantId: string, userId: string): Promise<Perfil[]> {
    const linhas = await withTenant(
      this.d.dbClinica,
      tenantId as TenantId,
      (tx) =>
        tx
          .select({ role: clinicMembers.role })
          .from(clinicMembers)
          .where(and(eq(clinicMembers.tenantId, tenantId), eq(clinicMembers.userId, userId), isNull(clinicMembers.revokedAt))),
      userId,
    );
    const ativos = new Set(linhas.map((l) => l.role));
    return PERFIS.filter((p) => ativos.has(p));
  }

  /**
   * Grava a clínica ativa da sessão, se o vínculo existir (gancho `trocarClinica`). Trocar de clínica ZERA o MFA
   * (contrato R6 do #123) e grava `session_tenant_selected` na trilha da clínica nova (R12 do parecer do desenho).
   */
  async definirClinica(sessaoId: string, userId: string, tenantId: string): Promise<boolean> {
    if (!(await this.clinicasDoUsuario(userId)).includes(tenantId)) return false;
    // R4 do desenho do PR 3: o TOTP feito sem clínica vale só para ESTA escolha e é zerado nela, valendo ou não.
    // R1 do parecer do código do 3a: leitura do valor anterior e troca na MESMA instrução, com a linha travada; duas
    // escolhas em paralelo não convertem as duas (a segunda espera e já vê o valor zerado).
    const linhas = await this.d.dbAuth.execute<{ clinica_antes: string | null; sem_clinica_antes: Date | string | null }>(sql`
      with antes as (
        select id, clinica_ativa, mfa_sem_clinica_em from identidade.sessao
        where id = ${sessaoId} and usuario_id = ${userId}
        for update
      )
      update identidade.sessao s
         set clinica_ativa = ${tenantId}, mfa_em = null, perfis_no_mfa = null, mfa_sem_clinica_em = null
        from antes
       where s.id = antes.id
      returning antes.clinica_ativa as clinica_antes, antes.mfa_sem_clinica_em as sem_clinica_antes`);
    const antesDaTroca = [...linhas][0];
    if (!antesDaTroca) return false;
    const antes = {
      clinicaAtiva: antesDaTroca.clinica_antes,
      semClinica: antesDaTroca.sem_clinica_antes === null ? null : new Date(antesDaTroca.sem_clinica_antes),
    };
    await withTenant(
      this.d.dbClinica,
      tenantId as TenantId,
      (tx) =>
        recordAudit(tx, { tenantId: tenantId as TenantId, userId: userId as UserId, roles: [] }, {
          action: AuditAction.Update,
          scope: 'session',
          metadata: { op: 'session_tenant_selected' },
        }),
      userId,
    );
    const aproveita =
      antes.clinicaAtiva === null && antes.semClinica !== null && this.agora().getTime() - antes.semClinica.getTime() <= PRAZO_MFA_SEM_CLINICA_MS;
    if (aproveita && (await this.marcarMfa(sessaoId))) await this.trilhaDoFator(tenantId, userId, ['mfa_verified'], AuditAction.Login);
    return true;
  }

  /**
   * Marca o MFA da sessão como feito AGORA, com a impressão dos perfis atuais (gancho `stepUp`). No PR 2, só a
   * verificação do TOTP pela biblioteca chama esta função; nada do cliente chega aqui (R6 do #123).
   */
  async marcarMfa(sessaoId: string): Promise<boolean> {
    const [s] = await this.d.dbAuth.select({ userId: sessao.userId, clinicaAtiva: sessao.clinicaAtiva }).from(sessao).where(eq(sessao.id, sessaoId));
    if (!s?.clinicaAtiva) return false;
    const perfis = await this.perfisNoBanco(s.clinicaAtiva, s.userId);
    if (perfis.length === 0) return false;
    await this.d.dbAuth.update(sessao).set({ mfaEm: this.agora(), perfisNoMfa: impressaoDosPerfis(perfis) }).where(eq(sessao.id, sessaoId));
    return true;
  }

  /**
   * Código do TOTP aceito pela biblioteca (gancho `after` da proteção). Com uma clínica só, a escolha é feita ANTES
   * (trocar de clínica zera o MFA); então `mfa_em` e a trilha da clínica (R5 do #123: cadastro e verificação). Com
   * várias clínicas e nenhuma escolhida, o MFA não é marcado: a escolha (PR 3) vem antes da reverificação.
   */
  async aposMfaVerificado(sessaoId: string, userId: string, motivo: 'login_em_duas_etapas' | 'reverificacao' | 'cadastro_do_fator'): Promise<ResultadoDoMfa> {
    const [s] = await this.d.dbAuth.select({ clinicaAtiva: sessao.clinicaAtiva }).from(sessao).where(and(eq(sessao.id, sessaoId), eq(sessao.userId, userId)));
    if (!s) return 'nada';
    await this.d.dbAuth.update(sessao).set({ cadastroPendenteAte: null }).where(eq(sessao.id, sessaoId));
    let tenantId = s.clinicaAtiva;
    if (!tenantId) {
      const clinicas = await this.clinicasDoUsuario(userId);
      if (clinicas.length > 1) {
        // Várias clínicas e nenhuma escolhida: guarda para a primeira escolha em até 5 min (nunca vira mfa_em aqui).
        await this.d.dbAuth.update(sessao).set({ mfaSemClinicaEm: this.agora() }).where(eq(sessao.id, sessaoId));
        return 'sem_clinica';
      }
      if (clinicas.length !== 1 || !clinicas[0]) return 'nada';
      tenantId = clinicas[0];
      await this.definirClinica(sessaoId, userId, tenantId);
    }
    if (!(await this.marcarMfa(sessaoId))) return 'nada';
    const ops = motivo === 'cadastro_do_fator' ? ['mfa_enrolled', 'mfa_verified'] : ['mfa_verified'];
    await this.trilhaDoFator(tenantId, userId, ops, AuditAction.Login);
    return 'marcado';
  }

  /** Código ou senha do cadastro recusados com sessão aberta: trilha da clínica ativa (falha e, se for o caso, bloqueio). */
  async aposMfaRecusado(sessaoId: string, userId: string, bloqueou: boolean): Promise<void> {
    const [s] = await this.d.dbAuth.select({ clinicaAtiva: sessao.clinicaAtiva }).from(sessao).where(and(eq(sessao.id, sessaoId), eq(sessao.userId, userId)));
    if (!s?.clinicaAtiva) return;
    await this.trilhaDoFator(s.clinicaAtiva, userId, bloqueou ? ['mfa_failed', 'mfa_locked'] : ['mfa_failed'], AuditAction.LoginFailed);
  }

  private async trilhaDoFator(tenantId: string, userId: string, ops: readonly string[], action: AuditAction): Promise<void> {
    await withTenant(
      this.d.dbClinica,
      tenantId as TenantId,
      async (tx) => {
        for (const op of ops) {
          await recordAudit(tx, { tenantId: tenantId as TenantId, userId: userId as UserId, roles: [] }, { action, scope: 'mfa', metadata: { op } });
        }
      },
      userId,
    );
  }

  /** Apaga a sessão no servidor (logout, prazo absoluto, conta desligada). */
  async encerrar(sessaoId: string, motivo: 'logout' | 'prazo_absoluto' | 'conta_inativa' = 'logout', userId?: string): Promise<void> {
    await this.d.dbAuth.delete(sessao).where(eq(sessao.id, sessaoId));
    registrarEventoDeSeguranca('LOGOUT', { motivo, ...(userId ? { userId } : {}) });
  }
}
