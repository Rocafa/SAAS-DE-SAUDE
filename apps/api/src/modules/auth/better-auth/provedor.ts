/**
 * Provedor de sessão real (D4: Better Auth) atrás da porta `AuthProvider`. Desenho: autenticacao-better-auth.md §§5–6
 * e §12. Passa no contrato do #128 com os 6 ganchos (bancada em test/contrato-provedor-better-auth.rls.test.ts).
 *
 * A cada requisição: sessão da biblioteca → prazo absoluto de 12 h (R3) → conta ativa → campos NOSSOS da sessão
 * (clínica ativa, MFA e impressão dos perfis) → perfis SÓ de `clinic_members` (R6) → `mfaEm` só vale se os perfis não
 * mudaram desde o MFA (`perfis_no_mfa`, R13). A clínica nunca vem do cliente (regra 1).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { TenantId, UserId } from '@plataforma/shared';
import { AuditAction } from '@plataforma/shared';
import { and, desc, eq, gt, inArray, isNull, lt, sql } from 'drizzle-orm';

import { fromNodeHeaders } from 'better-auth/node';
import { clinicMembers, tenants } from '../../../db/schema';
import { conta, doisFatores, recuperacao, sessao, usuario, verificacao, vinculo } from '../../../db/identidade';
import { withTenant, type Database } from '../../../db/tenant-transaction';
import { registrarEventoDeSeguranca } from '../../../security/log-de-seguranca';
import { recordAudit } from '../../audit/audit-log';
import { avisarAdminsDeAnomalia } from '../../records/avisos';
import type { ResultadoDaRecuperacao, TipoDeRecuperacao, ProvedorDeRecuperacao } from '../auth-context';
import type { AuthContext, AuthProvider, ClinicaDaPessoa, ProvedorDeConvite, ProvedorDeCredencial, ProvedorDePessoa, RequisicaoParaSessao, SessaoDePessoa, SessaoListada } from '../auth-context';
import { PERFIS, type Perfil } from '../perfis';
import { PRAZO_ABSOLUTO_MS, type Autenticacao } from './instancia';
import { gerarHashDeSenha } from './senha';
import type { ConferirSenhaVazada } from './senha-vazada';
import type { RateLimitStore } from '../../../security/rate-limit-store';
import { chaveDoBloqueio } from './chaves-do-bloqueio';
import { symmetricDecrypt } from 'better-auth/crypto';
import { totpConfere } from './totp';
import { conferirSenha } from './senha';
import { CABECALHO_ORIGEM, JANELA_DE_REUSO_MS, TETO_DE_FALHAS, TETO_DE_FALHAS_POR_ORIGEM } from './protecao';
import { JANELA_DE_BLOQUEIO_MS } from './protecao';

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
  /** Store e segredo dos contadores de bloqueio (para o desbloqueio pelo admin zerar as MESMAS chaves). */
  readonly bloqueio?: { readonly store: RateLimitStore; readonly chaveHmac: Uint8Array };
  /** BETTER_AUTH_SECRET: decifra o segredo do TOTP na recuperação de senha (a pessoa tem o código, não a senha). */
  readonly segredoDaInstancia?: string;
}

/** R8: a sessão aberta no aceite só serve ao cadastro do TOTP, por no máximo 15 min. */
export const PRAZO_DO_CADASTRO_PENDENTE_MS = 15 * 60 * 1000;

export class BetterAuthProvider implements AuthProvider, ProvedorDePessoa, ProvedorDeConvite, ProvedorDeCredencial, ProvedorDeRecuperacao {
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
  async expurgarComoSistema(): Promise<{ sessoes: number; verificacoes: number; cadastrosNaoConcluidos: number; recuperacoes: number }> {
    const agora = this.agora();
    const umDia = new Date(agora.getTime() - 24 * 60 * 60 * 1000);
    const sessoes = await this.d.dbAuth.delete(sessao).where(lt(sessao.expiresAt, agora)).returning({ id: sessao.id });
    const verificacoes = await this.d.dbAuth.delete(verificacao).where(lt(verificacao.expiresAt, umDia)).returning({ id: verificacao.id });
    const cadastros = await this.d.dbAuth
      .delete(doisFatores)
      .where(and(eq(doisFatores.verified, false), lt(doisFatores.criadoEm, umDia)))
      .returning({ id: doisFatores.id });
    // R7 do código do 3b-2: token de recuperação vencido há mais de 30 dias.
    const trintaDias = new Date(agora.getTime() - 30 * 24 * 60 * 60 * 1000);
    const recuperacoes = await this.d.dbAuth.delete(recuperacao).where(lt(recuperacao.expiraEm, trintaDias)).returning({ id: recuperacao.id });
    return { sessoes: sessoes.length, verificacoes: verificacoes.length, cadastrosNaoConcluidos: cadastros.length, recuperacoes: recuperacoes.length };
  }

  async trocarSenhaDaPessoa(e: {
    headers: RequisicaoParaSessao['headers'];
    userId: string;
    atual: string;
    nova: string;
  }): Promise<string[] | 'senha_atual_errada' | 'senha_vazada'> {
    let r: Response;
    try {
      r = await this.d.auth.api.changePassword({
        body: { currentPassword: e.atual, newPassword: e.nova, revokeOtherSessions: true },
        headers: fromNodeHeaders(e.headers),
        asResponse: true,
      });
    } catch (err) {
      // O gancho da senha vazada lança antes do endpoint (R15).
      if ((err as { body?: { code?: string } }).body?.code === 'PASSWORD_COMPROMISED') return 'senha_vazada';
      throw err;
    }
    if (r.status !== 200) {
      const corpo = (await r.json().catch(() => ({}))) as { code?: string };
      return corpo.code === 'PASSWORD_COMPROMISED' ? 'senha_vazada' : 'senha_atual_errada';
    }
    registrarEventoDeSeguranca('SENHA_TROCADA', { motivo: 'pela_pessoa', userId: e.userId });
    await this.trilhaDeSessaoNasClinicas(e.userId, 'password_changed');
    return r.headers.getSetCookie().filter((c) => COOKIE_DE_SESSAO.test(c));
  }

  async desbloquear(userId: string): Promise<void> {
    const [u] = await this.d.dbAuth.select({ email: usuario.email }).from(usuario).where(eq(usuario.id, userId));
    if (this.d.bloqueio && u) {
      const { store, chaveHmac } = this.d.bloqueio;
      for (const chave of [chaveDoBloqueio(chaveHmac, 'login', u.email.trim().toLowerCase()), chaveDoBloqueio(chaveHmac, 'fator', userId)]) {
        const n = await store.peek(chave, JANELA_DE_BLOQUEIO_MS);
        for (let i = 0; i < n; i++) await store.release(chave, JANELA_DE_BLOQUEIO_MS);
      }
    }
    // A trava da própria biblioteca no login em duas etapas.
    await this.d.dbAuth.update(doisFatores).set({ failedVerificationCount: 0, lockedUntil: null }).where(eq(doisFatores.userId, userId));
    registrarEventoDeSeguranca('BLOQUEIO_ZERADO', { motivo: 'desbloqueio_pelo_admin', userId });
  }

  async emitirRecuperacao(e: { userId: string; tipo: TipoDeRecuperacao; clinicaId: string; criadoPor: string }): Promise<{ token: string; expiraEm: string }> {
    const token = randomBytes(32).toString('base64url');
    const [r] = await this.d.dbAuth
      .insert(recuperacao)
      .values({
        id: randomUUID(),
        usuarioId: e.userId,
        tipo: e.tipo,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        clinicaId: e.clinicaId,
        criadoPor: e.criadoPor,
        expiraEm: sql`now() + interval '15 minutes'`,
      })
      .returning({ expiraEm: recuperacao.expiraEm });
    if (!r) throw new Error('falha ao emitir recuperação');
    return { token, expiraEm: r.expiraEm.toISOString() };
  }

  async invalidarRecuperacao(token: string): Promise<void> {
    await this.d.dbAuth
      .update(recuperacao)
      .set({ usadoEm: new Date() })
      .where(and(eq(recuperacao.tokenHash, createHash('sha256').update(token).digest('hex')), isNull(recuperacao.usadoEm)));
  }

  /**
   * Usa o token (R17; R1 do desenho do PR 3; R15). Senha: exige o código TOTP atual, pelo bloqueio do fator e pela
   * marca de reuso. Fator: exige a senha atual, pelo bloqueio de login. O token é consumido de forma atômica DEPOIS de
   * a credencial conferir. Usar o token apaga TODAS as sessões da pessoa.
   */
  async usarRecuperacao(e: { token: string; senhaNova?: string; senhaAtual?: string; codigo?: string; cabecalhos: Headers }): Promise<ResultadoDaRecuperacao> {
    const hash = createHash('sha256').update(e.token).digest('hex');
    const agora = this.agora();
    const [r] = await this.d.dbAuth
      .select()
      .from(recuperacao)
      .where(and(eq(recuperacao.tokenHash, hash), isNull(recuperacao.usadoEm), gt(recuperacao.expiraEm, agora)));
    if (!r) return 'invalido';
    const [u] = await this.d.dbAuth.select({ email: usuario.email, ativo: usuario.ativo }).from(usuario).where(eq(usuario.id, r.usuarioId));
    if (!u?.ativo) return 'invalido';
    // R5 do código do 3b-2: no USO, a pessoa ainda tem vínculo ativo na clínica do token e quem emitiu ainda é admin.
    if (!(await this.vinculoEAdminSeguemAtivos(r.clinicaId, r.usuarioId, r.criadoPor))) return 'invalido';

    const b = this.d.bloqueio;
    const origemBruta = e.cabecalhos.get(CABECALHO_ORIGEM) ?? '';
    const origem = /^[0-9a-f]{16}$/.test(origemBruta) ? origemBruta : undefined;
    // R3: além da pessoa, o contador por origem (teto maior: a clínica sai por um IP).
    const contadores =
      r.tipo === 'senha'
        ? [
            { chave: b ? chaveDoBloqueio(b.chaveHmac, 'fator', r.usuarioId) : '', teto: TETO_DE_FALHAS },
            ...(origem && b ? [{ chave: chaveDoBloqueio(b.chaveHmac, 'fator-origem', origem), teto: TETO_DE_FALHAS_POR_ORIGEM }] : []),
          ]
        : [
            { chave: b ? chaveDoBloqueio(b.chaveHmac, 'login', u.email.trim().toLowerCase()) : '', teto: TETO_DE_FALHAS },
            ...(origem && b ? [{ chave: chaveDoBloqueio(b.chaveHmac, 'login-origem', origem), teto: TETO_DE_FALHAS_POR_ORIGEM }] : []),
          ];
    const reserva = await this.reservarVarias(contadores);
    if (reserva !== 'ok') return reserva;

    let confere: boolean;
    if (r.tipo === 'senha') {
      confere = !!e.codigo && !!e.senhaNova && e.senhaNova.length >= 12 && e.senhaNova.length <= 128 && (await this.totpDaPessoaConfere(r.usuarioId, e.codigo)) === true;
    } else {
      confere = !!e.senhaAtual && (await this.senhaConfere(r.usuarioId, e.senhaAtual));
    }
    if (!confere) return 'credencial_errada';
    await this.devolverVarias(contadores);

    if (r.tipo === 'senha' && e.senhaNova && this.d.conferirSenhaVazada) {
      const vazou = await this.d.conferirSenhaVazada(e.senhaNova).catch(() => {
        registrarEventoDeSeguranca('CONFERENCIA_DE_SENHA_INDISPONIVEL', { motivo: 'conferencia_indisponivel' });
        return false;
      });
      if (vazou) return 'senha_vazada';
    }
    const hashNovo = r.tipo === 'senha' && e.senhaNova ? await gerarHashDeSenha(e.senhaNova) : null;

    // R6: consumir o token, trocar a credencial e derrubar as sessões numa ÚNICA transação; evento antes da trilha.
    const consumiu = await this.d.dbAuth.transaction(async (tx) => {
      const usado = await tx
        .update(recuperacao)
        .set({ usadoEm: new Date() })
        .where(and(eq(recuperacao.id, r.id), isNull(recuperacao.usadoEm), gt(recuperacao.expiraEm, this.agora())))
        .returning({ id: recuperacao.id });
      if (usado.length === 0) return false;
      if (hashNovo) {
        await tx.update(conta).set({ password: hashNovo }).where(and(eq(conta.userId, r.usuarioId), eq(conta.providerId, 'credential')));
      } else {
        // O fator antigo sai; o cadastro de um novo é obrigatório (a sessão aberta só serve a isso, 15 min, R8).
        await tx.delete(doisFatores).where(eq(doisFatores.userId, r.usuarioId));
        await tx.update(usuario).set({ twoFactorEnabled: false }).where(eq(usuario.id, r.usuarioId));
      }
      await tx.delete(sessao).where(eq(sessao.userId, r.usuarioId));
      return true;
    });
    if (!consumiu) return 'invalido';
    registrarEventoDeSeguranca('RECUPERACAO_USADA', { motivo: 'recuperacao_pelo_admin', userId: r.usuarioId });
    await this.trilhaDaRecuperacao(r.clinicaId, r.usuarioId, r.tipo);
    if (r.tipo === 'senha') return { tipo: 'senha', cookies: [] };
    const cookies = await this.abrirSessaoDeCadastro({ email: u.email, senha: e.senhaAtual ?? '', cabecalhos: e.cabecalhos });
    return { tipo: 'fator', cookies };
  }

  /** R5 do código do 3b-2: pessoa com vínculo ativo na clínica do token e quem emitiu ainda admin ativo nela. */
  private async vinculoEAdminSeguemAtivos(clinicaId: string, userId: string, criadoPor: string): Promise<boolean> {
    const linhas = await withTenant(
      this.d.dbClinica,
      clinicaId as TenantId,
      (tx) =>
        tx
          .select({ userId: clinicMembers.userId, role: clinicMembers.role })
          .from(clinicMembers)
          .where(and(eq(clinicMembers.tenantId, clinicaId), isNull(clinicMembers.revokedAt), inArray(clinicMembers.userId, [userId, criadoPor]))),
      userId,
    );
    return linhas.some((l) => l.userId === userId) && linhas.some((l) => l.userId === criadoPor && l.role === 'admin');
  }

  /**
   * Reserva atômica em vários contadores (R15). R4 do código do 3b-2: na recuperação, o store fora FALHA FECHADO
   * (indisponível), com o alarme do rate limit; barrada, devolve as reservas de todos (R13 do #152).
   */
  private async reservarVarias(contadores: { chave: string; teto: number }[]): Promise<'ok' | 'bloqueado' | 'indisponivel'> {
    const b = this.d.bloqueio;
    if (!b) return 'ok';
    const feitas: string[] = [];
    try {
      for (const c of contadores) {
        const n = (await b.store.hit(c.chave, JANELA_DE_BLOQUEIO_MS)).count;
        feitas.push(c.chave);
        if (n > c.teto) {
          for (const f of feitas) await b.store.release(f, JANELA_DE_BLOQUEIO_MS).catch(() => undefined);
          return 'bloqueado';
        }
      }
      return 'ok';
    } catch {
      registrarEventoDeSeguranca('RATE_LIMIT_FAIL_OPEN', { motivo: 'bloqueio_do_fator' });
      for (const f of feitas) await b.store.release(f, JANELA_DE_BLOQUEIO_MS).catch(() => undefined);
      return 'indisponivel';
    }
  }

  private async devolverVarias(contadores: { chave: string }[]): Promise<void> {
    const b = this.d.bloqueio;
    if (b) for (const c of contadores) await b.store.release(c.chave, JANELA_DE_BLOQUEIO_MS).catch(() => undefined);
  }

  /** Consome o token de forma atômica (requisições em paralelo: só uma passa). */
  private async consumirRecuperacao(id: string): Promise<boolean> {
    const r = await this.d.dbAuth
      .update(recuperacao)
      .set({ usadoEm: new Date() })
      .where(and(eq(recuperacao.id, id), isNull(recuperacao.usadoEm), gt(recuperacao.expiraEm, this.agora())))
      .returning({ id: recuperacao.id });
    return r.length > 0;
  }

  /**
   * Trilha da recuperação: com o tipo na clínica que emitiu; nas DEMAIS clínicas da pessoa, só que a credencial mudou
   * (R1 do código do 3b-2; R2 da reconferência da 3b: a credencial é da pessoa, sem detalhe da outra clínica).
   */
  private async trilhaDaRecuperacao(clinicaId: string, userId: string, tipo: TipoDeRecuperacao): Promise<void> {
    for (const outra of (await this.clinicasDoUsuario(userId)).filter((t) => t !== clinicaId)) {
      await withTenant(
        this.d.dbClinica,
        outra as TenantId,
        (tx) =>
          recordAudit(tx, { tenantId: outra as TenantId, userId: userId as UserId, roles: [] }, { action: AuditAction.Update, scope: 'session', metadata: { op: 'credential_changed' } }),
        userId,
      );
    }
    await withTenant(
      this.d.dbClinica,
      clinicaId as TenantId,
      (tx) =>
        recordAudit(tx, { tenantId: clinicaId as TenantId, userId: userId as UserId, roles: [] }, {
          action: AuditAction.PermissionChange,
          scope: 'clinic_members',
          metadata: { op: 'credential_recovery_used', kind: tipo },
        }),
      userId,
    );
  }

  /** R8: o `enable` do TOTP só é aceito numa sessão de cadastro pendente dentro do prazo. */
  async cadastroLiberado(sessaoId: string): Promise<boolean> {
    const [s] = await this.d.dbAuth.select({ ate: sessao.cadastroPendenteAte }).from(sessao).where(eq(sessao.id, sessaoId));
    return s?.ate != null && s.ate.getTime() > this.agora().getTime();
  }

  /** Conta nova do convite: senha conferida contra vazadas, e-mail único (corrida = conta existente). */
  async idParaContaDoConvite(email: string): Promise<{ userId: string; reaproveita: boolean } | 'conta_existente'> {
    const [ja] = await this.d.dbAuth
      .select({ id: usuario.id, ativo: usuario.ativo, inativaPor: usuario.inativaPor, senha: conta.password })
      .from(usuario)
      .leftJoin(conta, and(eq(conta.userId, usuario.id), eq(conta.providerId, 'credential')))
      .where(sql`lower(${usuario.email}) = ${email.trim().toLowerCase()}`);
    if (!ja) return { userId: randomUUID(), reaproveita: false };
    const abandonada = !ja.ativo && ja.inativaPor === 'convite_desfeito' && ja.senha === null && (await this.clinicasDoUsuario(ja.id)).length === 0;
    return abandonada ? { userId: ja.id, reaproveita: true } : 'conta_existente';
  }

  async desfazerContaDoConvite(userId: string): Promise<void> {
    await this.d.dbAuth.update(usuario).set({ ativo: false, inativaPor: 'convite_desfeito' }).where(eq(usuario.id, userId));
    await this.d.dbAuth.update(conta).set({ password: null }).where(eq(conta.userId, userId));
    await this.d.dbAuth.delete(sessao).where(eq(sessao.userId, userId));
  }

  async criarContaDoConvite(e: {
    userId: string;
    reaproveita: boolean;
    email: string;
    nome: string;
    senha: string;
    clinicaDeOrigem: string;
    conviteDeOrigem: string;
  }): Promise<{ userId: string } | 'conta_existente' | 'senha_vazada'> {
    const email = e.email.trim().toLowerCase();
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
    if (e.reaproveita) {
      // Conta abandonada por um aceite que falhou: volta a valer com a senha nova (só se continuar abandonada).
      const hash = await gerarHashDeSenha(e.senha);
      // A concessão já reativou a conta (trigger da 0069); a marca da conta abandonada é a senha ausente.
      const r = await this.d.dbAuth
        .update(conta)
        .set({ password: hash })
        .where(and(eq(conta.userId, userId), eq(conta.providerId, 'credential'), isNull(conta.password)))
        .returning({ id: conta.id });
      if (r.length === 0) return 'conta_existente';
      // Nome e origem vão DEPOIS do commit da clínica (completarContaReaproveitada): a linha de usuario está travada
      // pelo trigger da concessão nesta transação, e tocá-la por outra conexão travaria as duas.
      return { userId };
    }
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

  /** Reserva atômica no contador de bloqueio (R15, mesma regra do #152); devolvida se a credencial conferir. */
  private async reservarTentativa(chave: string): Promise<boolean> {
    const b = this.d.bloqueio;
    if (!b) return true;
    const n = (await b.store.hit(chave, JANELA_DE_BLOQUEIO_MS).catch(() => ({ count: 0 }))).count;
    if (n > TETO_DE_FALHAS) {
      await b.store.release(chave, JANELA_DE_BLOQUEIO_MS).catch(() => undefined);
      return false;
    }
    return true;
  }

  private async devolverTentativa(chave: string): Promise<void> {
    if (this.d.bloqueio) await this.d.bloqueio.store.release(chave, JANELA_DE_BLOQUEIO_MS).catch(() => undefined);
  }

  /** Senha conferida contra o hash, com o mesmo custo quando não há credencial. */
  private async senhaConfere(userId: string, senha: string): Promise<boolean> {
    const [c] = await this.d.dbAuth.select({ hash: conta.password }).from(conta).where(and(eq(conta.userId, userId), eq(conta.providerId, 'credential')));
    if (!c?.hash) {
      await gerarHashDeSenha(senha);
      return false;
    }
    return conferirSenha({ hash: c.hash, password: senha }).catch(() => false);
  }

  /** Código TOTP conferido com o segredo decifrado pela biblioteca, com a marca de reuso. */
  private async totpDaPessoaConfere(userId: string, codigo: string): Promise<boolean | 'sem_fator'> {
    const [f] = await this.d.dbAuth.select({ segredo: doisFatores.secret, verificado: doisFatores.verified }).from(doisFatores).where(eq(doisFatores.userId, userId));
    if (!f?.verificado) return 'sem_fator';
    const b = this.d.bloqueio;
    if (b) {
      const usado = await b.store.hit(chaveDoBloqueio(b.chaveHmac, 'totp-usado', `${userId}:${codigo}`), JANELA_DE_REUSO_MS).catch(() => ({ count: 1 }));
      if (usado.count > 1) return false;
    }
    if (!this.d.segredoDaInstancia) return false;
    const claro = await symmetricDecrypt({ key: this.d.segredoDaInstancia, data: f.segredo }).catch(() => null);
    return claro !== null && totpConfere(claro, codigo, this.agora().getTime());
  }

  /**
   * Senha e código TOTP de uma conta existente, SEM abrir sessão (aceite de convite, R1 e R2 do desenho do PR 3; R15:
   * pelos bloqueios de login e de fator). Funciona também para a conta desligada que está sendo recontratada.
   */
  async conferirCredenciais(e: {
    email: string;
    senha: string;
    codigo: string;
    cabecalhos?: Headers;
  }): Promise<{ userId: string } | 'falhou' | 'sem_fator' | 'bloqueado' | 'indisponivel'> {
    const email = e.email.trim().toLowerCase();
    const [u] = await this.d.dbAuth.select({ id: usuario.id }).from(usuario).where(sql`lower(${usuario.email}) = ${email}`);
    const b = this.d.bloqueio;
    const origemBruta = e.cabecalhos?.get(CABECALHO_ORIGEM) ?? '';
    const origem = /^[0-9a-f]{16}$/.test(origemBruta) ? origemBruta : undefined;
    const idsDoEvento = { ...(u ? { userId: u.id } : {}), ...(origem ? { origem } : {}) };
    // R2 do código do 3b-3: os mesmos contadores do login (e-mail e origem), com falha fechada e eventos.
    const doLogin = [
      { chave: b ? chaveDoBloqueio(b.chaveHmac, 'login', email) : '', teto: TETO_DE_FALHAS },
      ...(origem && b ? [{ chave: chaveDoBloqueio(b.chaveHmac, 'login-origem', origem), teto: TETO_DE_FALHAS_POR_ORIGEM }] : []),
    ];
    const r1 = await this.reservarVarias(doLogin);
    if (r1 !== 'ok') {
      if (r1 === 'bloqueado') registrarEventoDeSeguranca('LOGIN_BLOQUEADO', { motivo: 'bloqueio_de_login', ...(origem ? { origem } : {}) });
      return r1;
    }
    // R6 do código do 3b-3: e-mail inexistente gasta o mesmo hash (o tempo não revela se a conta existe).
    if (!u) {
      await gerarHashDeSenha(e.senha);
      registrarEventoDeSeguranca('LOGIN_FALHOU', { motivo: 'senha_errada', ...(origem ? { origem } : {}) });
      return 'falhou';
    }
    if (!(await this.senhaConfere(u.id, e.senha))) {
      registrarEventoDeSeguranca('LOGIN_FALHOU', { motivo: 'senha_errada', ...(origem ? { origem } : {}) });
      return 'falhou';
    }
    await this.devolverVarias(doLogin);
    const doFator = [
      { chave: b ? chaveDoBloqueio(b.chaveHmac, 'fator', u.id) : '', teto: TETO_DE_FALHAS },
      ...(origem && b ? [{ chave: chaveDoBloqueio(b.chaveHmac, 'fator-origem', origem), teto: TETO_DE_FALHAS_POR_ORIGEM }] : []),
    ];
    const r2 = await this.reservarVarias(doFator);
    if (r2 !== 'ok') {
      if (r2 === 'bloqueado') registrarEventoDeSeguranca('MFA_BLOQUEADO', { motivo: 'bloqueio_do_fator', ...idsDoEvento });
      return r2;
    }
    const totp = await this.totpDaPessoaConfere(u.id, e.codigo);
    if (totp === 'sem_fator') {
      await this.devolverVarias(doFator);
      return 'sem_fator';
    }
    if (!totp) {
      registrarEventoDeSeguranca('MFA_FALHOU', { motivo: 'codigo_errado', ...idsDoEvento });
      return 'falhou';
    }
    await this.devolverVarias(doFator);
    return { userId: u.id };
  }

  /** R6 do #152: aviso de fator bloqueado aos admins de cada clínica da pessoa (o auxiliar limita a 1 por dia). */
  async avisarFatorBloqueado(userId: string): Promise<void> {
    for (const tenantId of await this.clinicasDoUsuario(userId)) {
      const ctx = { tenantId: tenantId as TenantId, userId: userId as UserId, roles: [] };
      await withTenant(
        this.d.dbClinica,
        tenantId as TenantId,
        async (tx) => {
          await recordAudit(tx, ctx, { action: AuditAction.AnomalyAlert, scope: 'mfa', metadata: { rule: 'fator_bloqueado' } });
          await avisarAdminsDeAnomalia(tx, ctx, 'fator_bloqueado');
        },
        userId,
      );
    }
  }

  /**
   * Anonimização a pedido do titular (R18; R11 do desenho do PR 3): o id fica (o prontuário identifica o autor pela
   * tabela da clínica); e-mail e nome saem; senha, TOTP, sessões e tokens são apagados; a conta fica inativa.
   */
  async anonimizarConta(userId: string): Promise<void> {
    const clinicasAntes = await this.clinicasDoUsuario(userId);
    await this.d.dbAuth.transaction(async (tx) => {
      await tx
        .update(usuario)
        .set({ name: 'Conta anonimizada', email: `anonimizada-${userId}@anonimizada.invalid`, ativo: false, inativaPor: 'anonimizada', image: null })
        .where(eq(usuario.id, userId));
      await tx.update(conta).set({ password: null }).where(eq(conta.userId, userId));
      await tx.delete(doisFatores).where(eq(doisFatores.userId, userId));
      await tx.delete(sessao).where(eq(sessao.userId, userId));
      await tx.update(recuperacao).set({ usadoEm: new Date() }).where(and(eq(recuperacao.usuarioId, userId), isNull(recuperacao.usadoEm)));
    });
    // R3 do código do 3b-3: prova do atendimento ao titular (LGPD art. 18 IV e art. 37): evento e trilha.
    registrarEventoDeSeguranca('CONTA_ANONIMIZADA', { motivo: 'pedido_do_titular', userId });
    for (const tenantId of clinicasAntes) {
      await withTenant(
        this.d.dbClinica,
        tenantId as TenantId,
        (tx) => recordAudit(tx, { tenantId: tenantId as TenantId, userId: userId as UserId, roles: [] }, { action: AuditAction.Update, scope: 'session', metadata: { op: 'account_anonymized' } }),
        userId,
      );
    }
  }

  async completarContaReaproveitada(e: { userId: string; nome: string; clinicaDeOrigem: string; conviteDeOrigem: string }): Promise<void> {
    await this.d.dbAuth
      .update(usuario)
      .set({ ativo: true, inativaPor: null, name: e.nome.trim().slice(0, 200), clinicaDeOrigem: e.clinicaDeOrigem, conviteDeOrigem: e.conviteDeOrigem })
      .where(eq(usuario.id, e.userId));
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
