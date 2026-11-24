/**
 * Provedor de sessão real (D4: Better Auth) atrás da porta `AuthProvider`. Desenho: autenticacao-better-auth.md §§5–6
 * e §12. Passa no contrato do #128 com os 6 ganchos (bancada em test/contrato-provedor-better-auth.rls.test.ts).
 *
 * A cada requisição: sessão da biblioteca → prazo absoluto de 12 h (R3) → conta ativa → campos NOSSOS da sessão
 * (clínica ativa, MFA e impressão dos perfis) → perfis SÓ de `clinic_members` (R6) → `mfaEm` só vale se os perfis não
 * mudaram desde o MFA (`perfis_no_mfa`, R13). A clínica nunca vem do cliente (regra 1).
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { TenantId, UserId } from '@plataforma/shared';
import { AuditAction } from '@plataforma/shared';
import { and, desc, eq, gt, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';

import { fromNodeHeaders } from 'better-auth/node';
import { clinicMembers, tenants } from '../../../db/schema';
import { canRead, EXIT_WINDOW_DAYS } from '../../exports/access-policy';
import { ativacaoDoFundador, conta, doisFatores, recuperacao, sessao, trocaDoAdmin, usuario, verificacao, vinculo } from '../../../db/identidade';
import { aoLoginCompletoDaConta, concluirTrocaDoAdmin, concluirTrocasPendentes, contestarTrocaDoAdmin, expurgarTrocasAntigas } from './troca-do-admin-na-api';
import { withTenant, type Database } from '../../../db/tenant-transaction';
import { registrarEventoDeSeguranca, registrarNoMaximoUmaVez } from '../../../security/log-de-seguranca';
import { recordAudit, SYSTEM_ACTOR_ID } from '../../audit/audit-log';
import { avisarAdminsDeAnomalia } from '../../records/avisos';
import type { ProvedorDeAtivacao, ProvedorDeTrocaDoAdmin, ResultadoDaAtivacao, ResultadoDaRecuperacao, TipoDeRecuperacao, ProvedorDeRecuperacao } from '../auth-context';
import { hmacDoEmail } from '../convites';
import { EMAIL_DESCARTADO } from '../convites-retencao';
import { chaveDeHmac } from '../../../security/rate-limit-store';
import type { AuthContext, AuthProvider, ClinicaDaPessoa, ProvedorDeConvite, ProvedorDeCredencial, ProvedorDePessoa, RequisicaoParaSessao, SessaoDePessoa, SessaoListada } from '../auth-context';
import { PERFIS, type Perfil } from '../perfis';
import { PRAZO_ABSOLUTO_MS, type Autenticacao } from './instancia';
import { gerarHashDeSenha } from './senha';
import type { ConferirSenhaVazada } from './senha-vazada';
import type { RateLimitStore } from '../../../security/rate-limit-store';
import { chaveDoBloqueio } from './chaves-do-bloqueio';
import { fundadorAtivadoNaTrilha } from './provisionamento';
import { anonimizarContaDoTitular, type PedidoDeAnonimizacao, type ResultadoDaAnonimizacao } from './anonimizacao';
import { symmetricDecrypt, type SecretConfig } from 'better-auth/crypto';
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
  readonly segredoDaInstancia?: string | SecretConfig;
  /** Chave do HMAC do e-mail da ativação do fundador (A1 do #195); padrão: `chaveDeHmac('ativacao-email')`. */
  readonly chaveDoEmailDaAtivacao?: Uint8Array;
}

/** R4 do parecer de 16/11/2026 (B11): na 5ª conferência de e-mail errada, o token de ativação deixa de valer. */
export const TETO_DE_FALHAS_DA_ATIVACAO = 5;
const TOKEN_DE_ATIVACAO = /^[A-Za-z0-9_-]{43}$/;
const EMAIL_DA_ATIVACAO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A conta da ativação não é o fundador admin ativo da clínica do token: desfaz tudo e responde o mesmo 404. */
class FundadorNaoConfere extends Error {}

function ehViolacaoDeUnicidade(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && i < 5; e = (e as { cause?: unknown }).cause, i++) {
    if ((e as { code?: unknown }).code === '23505') return true;
  }
  return false;
}

/** R10 do código do 3b-2: recuperações emitidas por admin por dia. */
export const TETO_DIARIO_DE_RECUPERACOES = 10;

/** R8: a sessão aberta no aceite só serve ao cadastro do TOTP, por no máximo 15 min. */
export const PRAZO_DO_CADASTRO_PENDENTE_MS = 15 * 60 * 1000;

export class BetterAuthProvider implements AuthProvider, ProvedorDePessoa, ProvedorDeConvite, ProvedorDeCredencial, ProvedorDeRecuperacao, ProvedorDeAtivacao, ProvedorDeTrocaDoAdmin {
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
      // Sem a linha na trilha, a escolha não vale: sem contexto, sem acesso.
      if (!(await this.definirClinica(sessaoId, userId, tenantId))) return null;
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
      const t = await this.clinicaLiberada(id, userId);
      if (t) saida.push({ id, nome: t.nome });
    }
    return saida;
  }

  escolherClinica(s: SessaoDePessoa, clinicaId: string): Promise<boolean> {
    return this.definirClinica(s.sessaoId, s.userId, clinicaId);
  }

  /**
   * R3 do código do 3a: a mesma regra de leitura das rotas da clínica (`canRead`). A clínica cancelada aparece e pode
   * ser escolhida só dentro da janela de saída (portabilidade); fora dela some da lista e da escolha.
   */
  private async clinicaLiberada(id: string, userId: string): Promise<{ nome: string } | null> {
    // C1 do parecer do #195: o fundador com conta existente já é admin desde o provisionamento, mas só entra na clínica
    // DEPOIS de ativar (token + conferência do e-mail). Ativação ainda não usada = clínica fora da lista e da escolha.
    const [pendente] = await this.d.dbAuth
      .select({ id: ativacaoDoFundador.id })
      .from(ativacaoDoFundador)
      .where(and(eq(ativacaoDoFundador.clinicaId, id), eq(ativacaoDoFundador.usuarioId, userId), isNull(ativacaoDoFundador.usadoEm)));
    if (pendente) return null;
    const [t] = await withTenant(
      this.d.dbClinica,
      id as TenantId,
      (tx) => tx.select({ nome: tenants.displayName, status: tenants.subscriptionStatus, canceladaEm: tenants.cancelledAt }).from(tenants).where(eq(tenants.id, id)),
      userId,
    );
    if (!t || !canRead(t.status, t.canceladaEm, this.agora(), EXIT_WINDOW_DAYS)) return null;
    return { nome: t.nome };
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
    await this.trilhaDeSessaoNasClinicas(s.userId, 'session_revoked', 'logout');
    return true;
  }

  cookieDeEncerramento(): string {
    return this.d.cookieDeEncerramento ?? 'sessao=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict';
  }

  /** Logout global: todas as sessões da pessoa, inclusive a atual. Trilha nas clínicas do vínculo. */
  async encerrarTodasDaPessoa(s: SessaoDePessoa): Promise<number> {
    const apagadas = await this.d.dbAuth.delete(sessao).where(eq(sessao.userId, s.userId)).returning({ id: sessao.id });
    registrarEventoDeSeguranca('LOGOUT', { motivo: 'logout_global', userId: s.userId, contagem: apagadas.length });
    await this.trilhaDeSessaoNasClinicas(s.userId, 'session_logout_global', 'logout_global');
    return apagadas.length;
  }

  /**
   * Trilha do fim de sessão nas clínicas do vínculo. As sessões JÁ foram apagadas quando esta função roda, e sair é a
   * ação que reduz acesso: nenhuma falha de trilha pode desfazer o logout nem virar 500 (sem o 204, o navegador não
   * recebe o cookie expirado e continua com o cookie de uma sessão que não existe mais).
   *
   * Por isso: cada clínica na própria transação, uma falha NÃO para as outras, e nada é lançado. Cada falha gera
   * `TRILHA_NAO_GRAVADA` (crítico, alarme imediato) com a clínica, e no fim um evento com a contagem.
   */
  private async trilhaDeSessaoNasClinicas(userId: string, op: string, motivo: 'logout' | 'logout_global' | 'pela_pessoa'): Promise<void> {
    let falhas = 0;
    // R1 do parecer de 16/11 sobre o #181: a leitura das clínicas também pode falhar, e nem ela pode virar 500 depois
    // de as sessões terem sido apagadas.
    let clinicas: string[];
    try {
      clinicas = await this.clinicasDoUsuario(userId);
    } catch {
      registrarEventoDeSeguranca('TRILHA_NAO_GRAVADA', { motivo, userId });
      return;
    }
    for (const tenantId of clinicas) {
      try {
        await withTenant(
          this.d.dbClinica,
          tenantId as TenantId,
          (tx) => recordAudit(tx, { tenantId: tenantId as TenantId, userId: userId as UserId, roles: [] }, { action: AuditAction.Update, scope: 'session', metadata: { op } }),
          userId,
        );
      } catch {
        falhas += 1;
        registrarNoMaximoUmaVez(`trilha-sessao:${userId}:${tenantId}`, 60_000, 'TRILHA_NAO_GRAVADA', { tenantId, userId, motivo });
      }
    }
    if (falhas > 0) registrarEventoDeSeguranca('TRILHA_NAO_GRAVADA', { motivo, userId, contagem: falhas });
  }

  /**
   * Expurgo diário do schema identidade (job `identidade-expurgo`): sessões vencidas, tokens de uso único vencidos há
   * mais de 24 h e cadastros de TOTP não concluídos há mais de 24 h. Devolve só contagens.
   */
  async expurgarComoSistema(): Promise<{
    sessoes: number;
    verificacoes: number;
    cadastrosNaoConcluidos: number;
    recuperacoes: number;
    credenciaisDeInativas: number;
    expurgosSemTrilha: number;
    contasSemVinculo: number;
    contasReativadas: number;
    ativacoesExpurgadas: number;
    ativacoesRetidas: number;
    ativacoesSemLeituraDaTrilha: number;
    trocasConcluidas: number;
    trocasExpurgadas: number;
  }> {
    const agora = this.agora();
    const umDia = new Date(agora.getTime() - 24 * 60 * 60 * 1000);
    const sessoes = await this.d.dbAuth.delete(sessao).where(lt(sessao.expiresAt, agora)).returning({ id: sessao.id });
    const verificacoes = await this.d.dbAuth.delete(verificacao).where(lt(verificacao.expiresAt, umDia)).returning({ id: verificacao.id });
    const cadastros = await this.d.dbAuth
      .delete(doisFatores)
      .where(and(eq(doisFatores.verified, false), lt(doisFatores.criadoEm, umDia)))
      .returning({ id: doisFatores.id });
    // R7 do código do 3b-2: token de recuperação vencido há mais de 30 dias. B12 (0077): o do suporte fica 13 meses, porque
    // o teto por pessoa (2 em 12 meses) conta essas linhas.
    const trintaDias = new Date(agora.getTime() - 30 * 24 * 60 * 60 * 1000);
    const trezeMeses = new Date(agora.getTime() - 395 * 24 * 60 * 60 * 1000);
    const recuperacoes = await this.d.dbAuth
      .delete(recuperacao)
      .where(and(lt(recuperacao.expiraEm, trintaDias), or(eq(recuperacao.origem, 'admin'), lt(recuperacao.expiraEm, trezeMeses))))
      .returning({ id: recuperacao.id });
    // Ressalva 4 do parecer do 3c (RIPD-identidade §3): conta desligada há mais de 90 dias perde senha e TOTP e LIBERA o
    // e-mail; o id fica, preso ao histórico clínico (R18). B2 do veto do #173: a conta antiga nunca é reaproveitada; quem
    // volta recebe conta nova pelo convite. B1: tudo numa transação por conta, com o fator desmarcado.
    // R5 do código do 3b-3: duas revogações simultâneas em clínicas diferentes podem deixar a conta ativa sem vínculo.
    // O expurgo a desliga (o trigger da 0071 grava inativa_desde). Só conta com mais de 1 dia, para não pegar um aceite
    // de convite em andamento.
    // G4 do parecer do #176: uma transação por conta (desliga e derruba as sessões juntas) e evento de cada uma.
    const candidatas = await this.d.dbAuth
      .select({ id: usuario.id })
      .from(usuario)
      .where(and(eq(usuario.ativo, true), lt(usuario.createdAt, umDia), sql`not exists (select 1 from identidade.vinculo v where v.usuario_id = ${usuario.id})`));
    const semVinculo: string[] = [];
    for (const { id } of candidatas) {
      const desligou = await this.d.dbAuth.transaction(async (tx) => {
        const r = await tx
          .update(usuario)
          // B13 (R5): a conta com troca concluída vira `substituida`, nunca `sem_vinculo` (que a concessão reativaria).
          .set({
            ativo: false,
            inativaPor: sql`case when exists (select 1 from identidade.troca_do_admin t where t.usuario_antigo = ${id}::uuid and t.estado = 'concluida') then 'substituida' else 'sem_vinculo' end`,
          })
          .where(and(eq(usuario.id, id), eq(usuario.ativo, true), sql`not exists (select 1 from identidade.vinculo v where v.usuario_id = ${usuario.id})`))
          .returning({ id: usuario.id });
        if (r.length === 0) return false;
        await tx.delete(sessao).where(eq(sessao.userId, id));
        return true;
      });
      if (desligou) {
        semVinculo.push(id);
        registrarEventoDeSeguranca('CONTA_DESLIGADA_SEM_VINCULO', { motivo: 'conta_sem_vinculo', userId: id });
      }
    }
    // G1 do parecer do #176: uma concessão que corre junto com o passo acima (o vínculo ainda sem commit) deixa a conta
    // inativa COM vínculo. O job a reativa no dia seguinte (o trigger da 0071 limpa inativa_desde), antes que os 90 dias
    // apaguem a credencial de quem está trabalhando.
    const reativadas = await this.d.dbAuth
      .update(usuario)
      .set({ ativo: true, inativaPor: null })
      .where(
        and(
          eq(usuario.ativo, false),
          eq(usuario.inativaPor, 'sem_vinculo'),
          sql`exists (select 1 from identidade.vinculo v where v.usuario_id = ${usuario.id})`,
        ),
      )
      .returning({ id: usuario.id });
    for (const { id } of reativadas) registrarEventoDeSeguranca('CONTA_REATIVADA_COM_VINCULO', { motivo: 'conta_com_vinculo', userId: id });
    const noventaDias = new Date(agora.getTime() - 90 * 24 * 60 * 60 * 1000);
    const inativas = await this.d.dbAuth
      .select({ id: usuario.id, clinicaDeOrigem: usuario.clinicaDeOrigem })
      .from(usuario)
      .where(
        and(
          eq(usuario.ativo, false),
          // B13 (R5): a substituída também passa pelo expurgo em 90 dias (senha, TOTP, e-mail e nome).
          inArray(usuario.inativaPor, ['sem_vinculo', 'substituida']),
          lt(usuario.inativaDesde, noventaDias),
        ),
      );
    let credenciaisDeInativas = 0;
    let expurgosSemTrilha = 0;
    for (const { id, clinicaDeOrigem } of inativas) {
      const expurgou = await this.d.dbAuth.transaction(async (tx) => {
        // Ressalvas 7 e 8 da reconferência do #173: a marca 'expurgada' recusa nova concessão (0072) e o nome sai junto com
        // o e-mail (art. 16); a autoria clínica está em `professionals` da clínica. F1 do #175: a marca vai PRIMEIRO, com a
        // condição repetida; se a pessoa foi recontratada entre a seleção e aqui, a conta fica como está.
        const marcada = await tx
          .update(usuario)
          .set({ twoFactorEnabled: false, email: `desligada-${id}@desligada.invalid`, name: 'Conta desligada', image: null, inativaPor: 'expurgada' })
          // G1 do #176: nunca expurgar quem tem vínculo (conta inativa por corrida com uma concessão).
          .where(and(eq(usuario.id, id), eq(usuario.ativo, false), inArray(usuario.inativaPor, ['sem_vinculo', 'substituida']), sql`not exists (select 1 from identidade.vinculo v where v.usuario_id = ${usuario.id})`))
          .returning({ id: usuario.id });
        if (marcada.length === 0) return false;
        await tx.update(conta).set({ password: null }).where(and(eq(conta.userId, id), eq(conta.providerId, 'credential')));
        await tx.delete(doisFatores).where(eq(doisFatores.userId, id));
        await tx.delete(sessao).where(eq(sessao.userId, id));
        await tx.update(recuperacao).set({ usadoEm: new Date() }).where(and(eq(recuperacao.usuarioId, id), isNull(recuperacao.usadoEm)));
        return true;
      });
      if (!expurgou) continue;
      credenciaisDeInativas += 1;
      // Parecer do #173: este passo apaga dado pessoal (senha, TOTP, nome e e-mail) e devolvia só a contagem — nada na
      // trilha, e o art. 37 da LGPD pede a prova. A linha vai na clínica de ORIGEM da conta (0067): é a clínica que a
      // cadastrou, e a essa altura a conta não tem vínculo nenhum para onde apontar. Conta anterior à 0067 não tem
      // clínica de origem; aí não existe trilha de clínica possível e sobra o evento de segurança.
      //
      // De propósito NÃO é fail-closed: segurar o expurgo guardaria dado pessoal além do prazo, que é a violação maior.
      // A falha vira `TRILHA_NAO_GRAVADA` (crítico, alarme imediato), como no `anonimizarConta`, e sai contada.
      const trilhado = clinicaDeOrigem
        ? await withTenant(this.d.dbClinica, clinicaDeOrigem as TenantId, (tx) =>
            recordAudit(tx, { tenantId: clinicaDeOrigem as TenantId, userId: SYSTEM_ACTOR_ID, roles: [] }, {
              action: AuditAction.Update,
              scope: 'identidade.conta',
              metadata: { op: 'account_credentials_purged', user_id: id },
            }),
          )
            .then(() => true)
            .catch(() => false)
        : false;
      if (!trilhado) {
        expurgosSemTrilha += 1;
        registrarNoMaximoUmaVez(`expurgo-credencial:${id}`, 60_000, 'TRILHA_NAO_GRAVADA', { userId: id, motivo: 'expurgo_de_credencial' });
      }
    }
    if (expurgosSemTrilha > 0) registrarEventoDeSeguranca('TRILHA_NAO_GRAVADA', { motivo: 'expurgo_de_credencial', contagem: expurgosSemTrilha });
    const ativacoes = await this.expurgarAtivacoesDoFundador(agora, trintaDias);
    return {
      sessoes: sessoes.length,
      verificacoes: verificacoes.length,
      cadastrosNaoConcluidos: cadastros.length,
      recuperacoes: recuperacoes.length,
      credenciaisDeInativas,
      expurgosSemTrilha,
      contasSemVinculo: semVinculo.length,
      contasReativadas: reativadas.length,
      ...ativacoes,
      // B13 (R1): a conclusão que falhou na confirmação do TOTP é refeita aqui; a troca encerrada sai em 13 meses.
      trocasConcluidas: await concluirTrocasPendentes({ dbAuth: this.d.dbAuth, dbClinica: this.d.dbClinica }),
      trocasExpurgadas: await expurgarTrocasAntigas({ dbAuth: this.d.dbAuth, dbClinica: this.d.dbClinica }),
    };
  }

  /**
   * Linhas de ativação do fundador (B11, PR 3; R6 do desenho; A2 do parecer de 17/11 sobre o #203; 0079).
   *
   * - Vencida e não usada: o HMAC do e-mail é zerado já no vencimento (R6); o token não serve mais para nada.
   * - Usada há mais de 30 dias: apagada.
   * - Não usada, vencida ou bloqueada há mais de 30 dias: apagada SÓ se a clínica tem `founder_activated` na trilha.
   *   Sem essa prova a linha fica: é a pendência (`usado_em IS NULL`) que mantém a clínica fora da lista e da escolha
   *   do fundador com conta existente (C1 do #195); apagá-la daria a clínica a quem nunca ativou. A bloqueada não tem
   *   data própria; vence no máximo 72 h depois de emitida, então `expira_em` serve de marco para as duas.
   * - Leitura da trilha que falha: a linha fica (falha fechada), sai `TRILHA_NAO_LIDA` e a próxima rodada tenta de novo.
   */
  private async expurgarAtivacoesDoFundador(
    agora: Date,
    trintaDias: Date,
  ): Promise<{ ativacoesExpurgadas: number; ativacoesRetidas: number; ativacoesSemLeituraDaTrilha: number }> {
    const vencidas = await this.d.dbAuth
      .update(ativacaoDoFundador)
      .set({ emailHmac: EMAIL_DESCARTADO })
      // B13: o token vencido da troca guarda o HMAC até a única reemissão ou o encerramento da troca, que o zeram.
      .where(
        and(
          isNull(ativacaoDoFundador.usadoEm),
          lt(ativacaoDoFundador.expiraEm, agora),
          ne(ativacaoDoFundador.emailHmac, EMAIL_DESCARTADO),
          eq(ativacaoDoFundador.origem, 'provisionamento'),
        ),
      )
      .returning({ id: ativacaoDoFundador.id, clinicaId: ativacaoDoFundador.clinicaId });
    // Uma vez por linha (o filtro do HMAC não repete); a bloqueada já saiu como ATIVACAO_BLOQUEADA com o HMAC zerado.
    for (const v of vencidas) registrarEventoDeSeguranca('ATIVACAO_VENCIDA', { tenantId: v.clinicaId, pedido: v.id });
    const usadas = await this.d.dbAuth
      .delete(ativacaoDoFundador)
      .where(lt(ativacaoDoFundador.usadoEm, trintaDias))
      .returning({ id: ativacaoDoFundador.id });
    const pendentes = await this.d.dbAuth
      .select({ id: ativacaoDoFundador.id, clinicaId: ativacaoDoFundador.clinicaId, origem: ativacaoDoFundador.origem })
      .from(ativacaoDoFundador)
      .where(and(isNull(ativacaoDoFundador.usadoEm), lt(ativacaoDoFundador.expiraEm, trintaDias)));
    let expurgadas = usadas.length;
    let retidas = 0;
    let semLeitura = 0;
    for (const { id, clinicaId, origem } of pendentes) {
      // B13 (seção 12): a exceção A2 não vale para o token da troca; ele sai em 30 dias como qualquer outro.
      const ativada = origem === 'troca' ? true : await fundadorAtivadoNaTrilha(this.d.dbClinica, clinicaId as TenantId).catch(() => null);
      if (ativada === null) {
        // R2 do parecer do #205: a retenção por falha de leitura não pode se confundir com a da clínica nunca ativada.
        semLeitura += 1;
        registrarEventoDeSeguranca('TRILHA_NAO_LIDA', { motivo: 'expurgo_da_ativacao', tenantId: clinicaId, pedido: id });
      }
      if (!ativada) {
        retidas += 1;
        continue;
      }
      const apagada = await this.d.dbAuth
        .delete(ativacaoDoFundador)
        .where(and(eq(ativacaoDoFundador.id, id), isNull(ativacaoDoFundador.usadoEm), lt(ativacaoDoFundador.expiraEm, trintaDias)))
        .returning({ id: ativacaoDoFundador.id });
      expurgadas += apagada.length;
    }
    return { ativacoesExpurgadas: expurgadas, ativacoesRetidas: retidas, ativacoesSemLeituraDaTrilha: semLeitura };
  }

  async trocarSenhaDaPessoa(e: {
    headers: RequisicaoParaSessao['headers'];
    userId: string;
    atual: string;
    nova: string;
  }): Promise<string[] | 'senha_atual_errada' | 'senha_vazada' | 'senha_nova_invalida' | 'recusada' | 'bloqueado' | 'indisponivel'> {
    // R9 do código do 3b-2: a senha atual conferida aqui conta no bloqueio de login (quem tem a sessão não testa senhas).
    const [u] = await this.d.dbAuth.select({ email: usuario.email }).from(usuario).where(eq(usuario.id, e.userId));
    const b = this.d.bloqueio;
    const doLogin = b && u ? [{ chave: chaveDoBloqueio(b.chaveHmac, 'login', u.email.trim().toLowerCase()), teto: TETO_DE_FALHAS }] : [];
    const reserva = await this.reservarVarias(doLogin, 'bloqueio_de_login');
    if (reserva !== 'ok') return reserva;
    let r: Response;
    try {
      r = await this.d.auth.api.changePassword({
        body: { currentPassword: e.atual, newPassword: e.nova, revokeOtherSessions: true },
        headers: fromNodeHeaders(e.headers),
        asResponse: true,
      });
    } catch (err) {
      // O gancho da senha vazada lança antes do endpoint (R15).
      if ((err as { body?: { code?: string } }).body?.code === 'PASSWORD_COMPROMISED') {
        await this.devolverVarias(doLogin);
        return 'senha_vazada';
      }
      await this.devolverVarias(doLogin);
      throw err;
    }
    if (r.status !== 200) {
      const corpo = (await r.json().catch(() => ({}))) as { code?: string };
      if (corpo.code === 'PASSWORD_COMPROMISED') {
        await this.devolverVarias(doLogin);
        return 'senha_vazada';
      }
      // Ressalva 4 da reconferência do #173: só a senha atual errada gasta tentativa; outro erro devolve a reserva.
      if (corpo.code !== 'INVALID_PASSWORD') {
        await this.devolverVarias(doLogin);
        // F4 do #175: senha nova fora do tamanho aponta o campo; o resto (sessão vencida, reautenticação) não.
        return corpo.code === 'PASSWORD_TOO_SHORT' || corpo.code === 'PASSWORD_TOO_LONG' ? 'senha_nova_invalida' : 'recusada';
      }
      registrarEventoDeSeguranca('LOGIN_FALHOU', { motivo: 'senha_errada', userId: e.userId });
      return 'senha_atual_errada';
    }
    await this.devolverVarias(doLogin);
    registrarEventoDeSeguranca('SENHA_TROCADA', { motivo: 'pela_pessoa', userId: e.userId });
    // A troca de senha encerra as outras sessões: a trilha segue a regra do #181 (nunca derruba a operação).
    await this.trilhaDeSessaoNasClinicas(e.userId, 'password_changed', 'pela_pessoa');
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

  async emitirRecuperacao(e: { userId: string; tipo: TipoDeRecuperacao; clinicaId: string; criadoPor: string }): Promise<{ token: string; expiraEm: string } | 'teto'> {
    // R10 do código do 3b-2: teto de emissões por admin por dia, e o token novo invalida os pendentes da mesma pessoa.
    // Ressalva 2 da reconferência do #173: contagem, invalidação e inserção numa transação, serializadas por admin
    // (trava consultiva), para uma rajada não passar do teto. Ressalva 5: só os pendentes emitidos nesta clínica.
    const token = randomBytes(32).toString('base64url');
    return this.d.dbAuth.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'recuperacao:' + e.criadoPor}, 0))`);
      const [emitidas] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(recuperacao)
        .where(and(eq(recuperacao.criadoPor, e.criadoPor), gt(recuperacao.criadoEm, sql`now() - interval '24 hours'`)));
      if ((emitidas?.n ?? 0) >= TETO_DIARIO_DE_RECUPERACOES) return 'teto' as const;
      await tx
        .update(recuperacao)
        .set({ usadoEm: new Date() })
        .where(and(eq(recuperacao.usuarioId, e.userId), eq(recuperacao.clinicaId, e.clinicaId), isNull(recuperacao.usadoEm)));
      const [r] = await tx
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
    });
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
    // B12: o suporte só emite recuperação de FATOR (o CHECK da 0077 já recusa outra); defesa em profundidade.
    if (!r || (r.origem === 'suporte' && r.tipo !== 'fator')) return 'invalido';
    const [u] = await this.d.dbAuth.select({ email: usuario.email, ativo: usuario.ativo }).from(usuario).where(eq(usuario.id, r.usuarioId));
    if (!u?.ativo) return 'invalido';
    // R5 do código do 3b-2: no USO, a pessoa ainda tem vínculo ativo na clínica do token e quem emitiu ainda é admin.
    // B12 (R2 do parecer de 16/11): o token do suporte não tem admin emissor; no lugar, a PESSOA segue admin ativo.
    if (!(await this.vinculoEAdminSeguemAtivos(r.clinicaId, r.usuarioId, r.origem === 'suporte' ? null : r.criadoPor))) return 'invalido';

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
    // R3 do parecer do endurecimento: entrada mal formada não gasta tentativa.
    if (r.tipo === 'senha' && (!e.codigo || !e.senhaNova || e.senhaNova.length < 12 || e.senhaNova.length > 128)) return 'credencial_errada';
    if (r.tipo === 'fator' && !e.senhaAtual) return 'credencial_errada';
    const motivoDoContador = r.tipo === 'senha' ? 'bloqueio_do_fator' : 'bloqueio_de_login';
    const reserva = await this.reservarVarias(contadores, motivoDoContador);
    if (reserva === 'bloqueado') {
      // R1: a tentativa barrada pelo token também entra na vigilância.
      registrarEventoDeSeguranca(r.tipo === 'senha' ? 'MFA_BLOQUEADO' : 'LOGIN_BLOQUEADO', { motivo: motivoDoContador, userId: r.usuarioId, ...(origem ? { origem } : {}) });
      if (r.tipo === 'senha') await this.avisarFatorBloqueado(r.usuarioId).catch(() => undefined);
    }
    if (reserva !== 'ok') return reserva;

    let confere: boolean;
    if (r.tipo === 'senha') {
      confere = !!e.codigo && !!e.senhaNova && e.senhaNova.length >= 12 && e.senhaNova.length <= 128 && (await this.totpDaPessoaConfere(r.usuarioId, e.codigo)) === true;
    } else {
      confere = !!e.senhaAtual && (await this.senhaConfere(r.usuarioId, e.senhaAtual));
    }
    if (!confere) {
      registrarEventoDeSeguranca(r.tipo === 'senha' ? 'MFA_FALHOU' : 'LOGIN_FALHOU', {
        motivo: r.tipo === 'senha' ? 'codigo_errado' : 'senha_errada',
        userId: r.usuarioId,
        ...(origem ? { origem } : {}),
      });
      return 'credencial_errada';
    }
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
      // F2 do #175: credencial trocada, os outros pendentes da pessoa (de qualquer clínica) perdem o sentido.
      await tx.update(recuperacao).set({ usadoEm: new Date() }).where(and(eq(recuperacao.usuarioId, r.usuarioId), isNull(recuperacao.usadoEm)));
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
    if (r.origem === 'suporte') {
      registrarEventoDeSeguranca('RECUPERACAO_USADA', { motivo: 'recuperacao_pelo_suporte', userId: r.usuarioId, chamado: r.chamado ?? undefined });
    } else {
      registrarEventoDeSeguranca('RECUPERACAO_USADA', { motivo: 'recuperacao_pelo_admin', userId: r.usuarioId });
    }
    await this.trilhaDaRecuperacao(r.clinicaId, r.usuarioId, r.tipo);
    if (r.tipo === 'senha') return { tipo: 'senha', cookies: [] };
    const cookies = await this.abrirSessaoDeCadastro({ email: u.email, senha: e.senhaAtual ?? '', cabecalhos: e.cabecalhos });
    return { tipo: 'fator', cookies };
  }

  /**
   * R5 do código do 3b-2: pessoa com vínculo ativo na clínica do token e quem emitiu ainda admin ativo nela. Sem emissor
   * (`criadoPor = null`, token do suporte, B12): a própria pessoa precisa seguir admin ativo na clínica.
   */
  private async vinculoEAdminSeguemAtivos(clinicaId: string, userId: string, criadoPor: string | null): Promise<boolean> {
    const linhas = await withTenant(
      this.d.dbClinica,
      clinicaId as TenantId,
      (tx) =>
        tx
          .select({ userId: clinicMembers.userId, role: clinicMembers.role })
          .from(clinicMembers)
          .where(and(eq(clinicMembers.tenantId, clinicaId), isNull(clinicMembers.revokedAt), inArray(clinicMembers.userId, criadoPor ? [userId, criadoPor] : [userId]))),
      userId,
    );
    if (criadoPor === null) return linhas.some((l) => l.userId === userId && l.role === 'admin');
    return linhas.some((l) => l.userId === userId) && linhas.some((l) => l.userId === criadoPor && l.role === 'admin');
  }

  /**
   * Reserva atômica em vários contadores (R15). R4 do código do 3b-2: na recuperação, o store fora FALHA FECHADO
   * (indisponível), com o alarme do rate limit; barrada, devolve as reservas de todos (R13 do #152).
   */
  private async reservarVarias(
    contadores: { chave: string; teto: number }[],
    motivo: 'bloqueio_de_login' | 'bloqueio_do_fator' | 'bloqueio_da_ativacao',
  ): Promise<'ok' | 'bloqueado' | 'indisponivel'> {
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
      // R2 do parecer do endurecimento: aqui o caminho FALHA FECHADO, então o alarme não é o de "seguiu sem bloqueio".
      registrarEventoDeSeguranca('BLOQUEIO_INDISPONIVEL', { motivo });
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

  /**
   * Ativação do fundador da clínica provisionada (B11, PR 2; R2, R4, R5 e R8 do parecer de 16/11/2026). Ordem:
   * 1. entrada mal formada sai sem gastar tentativa;
   * 2. contador por origem (store fora = `indisponivel`, falha fechada);
   * 3. token (só o SHA-256) e e-mail digitado contra o HMAC (`ativacao-email`). E-mail errado soma `falhas`; a 5ª
   *    invalida o token (ATIVACAO_BLOQUEADA). Token inválido, vencido, usado ou bloqueado: o MESMO `invalido`;
   * 4. conta EXISTENTE: login completo (senha e TOTP), sem senha nova e sem sessão de cadastro. Conta NOVA: nome e
   *    senha nova conferida contra vazadas (vazada não consome o token);
   * 5. numa transação do `app_auth`: consumo atômico, conta nova com o uuid reservado e, na clínica do token, a
   *    conferência de que a conta é o fundador e segue admin ativo, com `founder_activated` (ator: o fundador);
   * 6. conta nova: sessão de cadastro pendente de 15 min (a mesma do convite, R8).
   */
  async usarAtivacao(e: { token: string; email: string; senha: string; nome?: string; codigo?: string; cabecalhos: Headers }): Promise<ResultadoDaAtivacao> {
    const email = e.email.trim().toLowerCase();
    if (!TOKEN_DE_ATIVACAO.test(e.token)) return 'invalido';
    if (email.length > 320 || !EMAIL_DA_ATIVACAO.test(email) || e.senha.length < 12 || e.senha.length > 128) return 'entrada_invalida';

    const b = this.d.bloqueio;
    const origemBruta = e.cabecalhos.get(CABECALHO_ORIGEM) ?? '';
    const origem = /^[0-9a-f]{16}$/.test(origemBruta) ? origemBruta : undefined;
    const comOrigem = origem ? { origem } : {};
    // Sem origem (não acontece atrás do balanceador), as tentativas dividem um contador só: falha fechada, nunca sem conta.
    const porOrigem = b ? [{ chave: chaveDoBloqueio(b.chaveHmac, 'ativacao-origem', origem ?? 'sem-origem'), teto: TETO_DE_FALHAS_POR_ORIGEM }] : [];
    const reserva = await this.reservarVarias(porOrigem, 'bloqueio_da_ativacao');
    if (reserva === 'indisponivel') return 'indisponivel';
    if (reserva === 'bloqueado') {
      registrarEventoDeSeguranca('ATIVACAO_FALHOU', { motivo: 'bloqueio_da_ativacao', ...comOrigem });
      return 'invalido';
    }

    const pendente = and(
      isNull(ativacaoDoFundador.usadoEm),
      gt(ativacaoDoFundador.expiraEm, sql`now()`),
      lt(ativacaoDoFundador.falhas, TETO_DE_FALHAS_DA_ATIVACAO),
    );
    const [a] = await this.d.dbAuth
      .select()
      .from(ativacaoDoFundador)
      .where(and(eq(ativacaoDoFundador.tokenHash, createHash('sha256').update(e.token).digest('hex')), pendente));
    if (!a) {
      registrarEventoDeSeguranca('ATIVACAO_FALHOU', { motivo: 'token_invalido', ...comOrigem });
      return 'invalido';
    }
    const ids = { tenantId: a.clinicaId, pedido: a.id, ...comOrigem };
    const digitado = Buffer.from(hmacDoEmail(email, this.d.chaveDoEmailDaAtivacao ?? chaveDeHmac('ativacao-email')), 'hex');
    const guardado = Buffer.from(a.emailHmac, 'hex');
    if (digitado.length !== guardado.length || !timingSafeEqual(digitado, guardado)) {
      // Contador por ativação, atômico; na 5ª o HMAC do e-mail também sai (o token não volta a valer).
      const [r] = await this.d.dbAuth
        .update(ativacaoDoFundador)
        .set({
          falhas: sql`${ativacaoDoFundador.falhas} + 1`,
          emailHmac: sql`case when ${ativacaoDoFundador.falhas} + 1 >= ${TETO_DE_FALHAS_DA_ATIVACAO} then ${EMAIL_DESCARTADO} else ${ativacaoDoFundador.emailHmac} end`,
        })
        .where(and(eq(ativacaoDoFundador.id, a.id), pendente))
        .returning({ falhas: ativacaoDoFundador.falhas });
      registrarEventoDeSeguranca('ATIVACAO_FALHOU', { motivo: 'email_diferente', ...ids });
      if (r && r.falhas >= TETO_DE_FALHAS_DA_ATIVACAO) registrarEventoDeSeguranca('ATIVACAO_BLOQUEADA', { motivo: 'email_diferente', ...ids });
      return 'invalido';
    }
    // O e-mail confere: a tentativa não conta contra a origem.
    await this.devolverVarias(porOrigem);

    const [u] = await this.d.dbAuth.select({ id: usuario.id, ativo: usuario.ativo }).from(usuario).where(eq(usuario.id, a.usuarioId));
    let contaNova: { nome: string; hash: string } | null = null;
    if (a.contaExistente || u) {
      // R2: conta existente (ou já criada) = login COMPLETO. Desligada, anonimizada ou expurgada nunca é reaproveitada.
      if (!u?.ativo) {
        registrarEventoDeSeguranca('ATIVACAO_FALHOU', { motivo: 'fundador_nao_confere', ...ids });
        return 'invalido';
      }
      if (!e.codigo || !/^[0-9]{6}$/.test(e.codigo)) return 'codigo_obrigatorio';
      const login = await this.conferirCredenciais({ email, senha: e.senha, codigo: e.codigo, cabecalhos: e.cabecalhos });
      if (login === 'indisponivel') return 'indisponivel';
      if (login === 'sem_fator') return 'conta_sem_fator';
      if (login === 'falhou' || login === 'bloqueado') return 'credencial_errada';
      if (login.userId !== a.usuarioId) {
        registrarEventoDeSeguranca('ATIVACAO_FALHOU', { motivo: 'fundador_nao_confere', ...ids });
        return 'invalido';
      }
    } else {
      const nome = e.nome?.trim() ?? '';
      if (nome.length === 0) return 'nome_obrigatorio';
      // R5: a mesma conferência dos outros caminhos que definem senha; vazada não consome o token.
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
      contaNova = { nome: nome.slice(0, 200), hash: await gerarHashDeSenha(e.senha) };
    }

    const consumiu = await this.consumirAtivacao(a, email, contaNova);
    if (consumiu !== true) {
      registrarEventoDeSeguranca('ATIVACAO_FALHOU', { motivo: consumiu, ...ids });
      return 'invalido';
    }
    if (a.origem === 'troca') {
      // B13: a conta nova nasceu; a troca só conclui na confirmação do TOTP (R1).
      registrarEventoDeSeguranca('TROCA_DO_ADMIN_ATIVADA', { motivo: 'troca_do_admin', userId: a.usuarioId, chamado: a.chamado ?? undefined, ...ids });
    } else {
      registrarEventoDeSeguranca('FUNDADOR_ATIVADO', { motivo: contaNova ? 'conta_nova' : 'conta_existente', userId: a.usuarioId, contrato: a.contrato, ...ids });
    }
    if (!contaNova) return { cookies: [], contaExistente: true };
    const cookies = await this.abrirSessaoDeCadastro({ email, senha: e.senha, cabecalhos: e.cabecalhos });
    return { cookies, contaExistente: false };
  }

  /**
   * Consumo atômico do token, conta nova (se houver) e, na clínica do token, conferência do fundador admin ativo e a
   * trilha `founder_activated`, tudo antes do COMMIT do `app_auth`: se a clínica recusar, nada fica (R8).
   */
  private async consumirAtivacao(
    a: { id: string; clinicaId: string; usuarioId: string; contrato: string; origem: 'provisionamento' | 'troca'; trocaId: string | null },
    email: string,
    contaNova: { nome: string; hash: string } | null,
  ): Promise<true | 'token_invalido' | 'fundador_nao_confere' | 'email_em_uso'> {
    if (a.origem === 'troca') return this.consumirAtivacaoDaTroca(a, email, contaNova);
    try {
      return await this.d.dbAuth.transaction(async (tx) => {
        const usado = await tx
          .update(ativacaoDoFundador)
          .set({ usadoEm: sql`now()`, emailHmac: EMAIL_DESCARTADO })
          .where(
            and(
              eq(ativacaoDoFundador.id, a.id),
              isNull(ativacaoDoFundador.usadoEm),
              gt(ativacaoDoFundador.expiraEm, sql`now()`),
              lt(ativacaoDoFundador.falhas, TETO_DE_FALHAS_DA_ATIVACAO),
            ),
          )
          .returning({ id: ativacaoDoFundador.id });
        if (usado.length === 0) return 'token_invalido' as const;
        if (contaNova) {
          // A conta nasce aqui, com o uuid reservado no provisionamento (R2). `clinica_de_origem` marca a ativação (C3).
          await tx.insert(usuario).values({ id: a.usuarioId, name: contaNova.nome, email, emailVerified: false, clinicaDeOrigem: a.clinicaId });
          await tx.insert(conta).values({ id: randomUUID(), accountId: a.usuarioId, providerId: 'credential', userId: a.usuarioId, password: contaNova.hash });
        }
        await withTenant(
          this.d.dbClinica,
          a.clinicaId as TenantId,
          async (ct) => {
            const [t] = await ct.select({ fundador: tenants.founderUserId }).from(tenants).where(eq(tenants.id, a.clinicaId));
            const [m] = await ct
              .select({ id: clinicMembers.id })
              .from(clinicMembers)
              .where(and(eq(clinicMembers.tenantId, a.clinicaId), eq(clinicMembers.userId, a.usuarioId), eq(clinicMembers.role, 'admin'), isNull(clinicMembers.revokedAt)));
            if (t?.fundador !== a.usuarioId || !m) throw new FundadorNaoConfere();
            await recordAudit(ct, { tenantId: a.clinicaId as TenantId, userId: a.usuarioId as UserId, roles: [] }, {
              action: AuditAction.PermissionChange,
              scope: 'tenants.founder',
              metadata: { op: 'founder_activated', user_id: a.usuarioId, contract: a.contrato, account: contaNova ? 'new' : 'existing' },
            });
          },
          a.usuarioId,
        );
        return true as const;
      });
    } catch (err) {
      if (err instanceof FundadorNaoConfere) return 'fundador_nao_confere';
      // Índice único do e-mail: outra conta ficou com ele no meio do caminho. Nada foi consumido.
      // A4 do parecer de 17/11: motivo próprio no log (a resposta continua o mesmo 404); runbook pede reemissão.
      if (contaNova && ehViolacaoDeUnicidade(err)) return 'email_em_uso';
      throw err;
    }
  }

  /**
   * B13 (troca do admin único), seção 4 do desenho: o alvo não é o fundador. Confere que a troca está `emitida` e que o
   * uuid reservado tem o vínculo admin ativo da emissão; a troca vai a `ativada` e a conta NOVA nasce aqui (o trigger
   * da 0082 recusa esse uuid em qualquer outro caminho; R3). `founder_user_id` não muda e NADA da conta antiga muda
   * neste passo (R1): a conclusão é na confirmação do TOTP.
   */
  private async consumirAtivacaoDaTroca(
    a: { id: string; clinicaId: string; usuarioId: string; trocaId: string | null },
    email: string,
    contaNova: { nome: string; hash: string } | null,
  ): Promise<true | 'token_invalido' | 'fundador_nao_confere' | 'email_em_uso'> {
    if (!a.trocaId || !contaNova) return 'fundador_nao_confere';
    const trocaId = a.trocaId;
    try {
      return await this.d.dbAuth.transaction(async (tx) => {
        const usado = await tx
          .update(ativacaoDoFundador)
          .set({ usadoEm: sql`now()`, emailHmac: EMAIL_DESCARTADO })
          .where(
            and(
              eq(ativacaoDoFundador.id, a.id),
              eq(ativacaoDoFundador.origem, 'troca'),
              isNull(ativacaoDoFundador.usadoEm),
              gt(ativacaoDoFundador.expiraEm, sql`now()`),
              lt(ativacaoDoFundador.falhas, TETO_DE_FALHAS_DA_ATIVACAO),
            ),
          )
          .returning({ id: ativacaoDoFundador.id });
        if (usado.length === 0) return 'token_invalido' as const;
        const ativada = await tx
          .update(trocaDoAdmin)
          .set({ estado: 'ativada' })
          .where(and(eq(trocaDoAdmin.id, trocaId), eq(trocaDoAdmin.estado, 'emitida'), eq(trocaDoAdmin.usuarioNovo, a.usuarioId), eq(trocaDoAdmin.clinicaId, a.clinicaId)))
          .returning({ id: trocaDoAdmin.id });
        if (ativada.length === 0) throw new FundadorNaoConfere();
        await tx.insert(usuario).values({ id: a.usuarioId, name: contaNova.nome, email, emailVerified: false, clinicaDeOrigem: a.clinicaId });
        await tx.insert(conta).values({ id: randomUUID(), accountId: a.usuarioId, providerId: 'credential', userId: a.usuarioId, password: contaNova.hash });
        await withTenant(
          this.d.dbClinica,
          a.clinicaId as TenantId,
          async (ct) => {
            const [m] = await ct
              .select({ id: clinicMembers.id })
              .from(clinicMembers)
              .where(and(eq(clinicMembers.tenantId, a.clinicaId), eq(clinicMembers.userId, a.usuarioId), eq(clinicMembers.role, 'admin'), isNull(clinicMembers.revokedAt)));
            if (!m) throw new FundadorNaoConfere();
          },
          a.usuarioId,
        );
        return true as const;
      });
    } catch (err) {
      if (err instanceof FundadorNaoConfere) return 'fundador_nao_confere';
      if (ehViolacaoDeUnicidade(err)) return 'email_em_uso';
      throw err;
    }
  }

  /** B13, seção 5: "não fui eu" pela conta antiga (a rota exige MFA recente). */
  contestarTrocaDoAdmin(userId: string): Promise<boolean> {
    return contestarTrocaDoAdmin({ dbAuth: this.d.dbAuth, dbClinica: this.d.dbClinica }, userId);
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
    // Só a conta de convite desfeito (R1 do 3b-1). A desligada NUNCA é reaproveitada (B2 do veto do #173): depois de 90
    // dias o expurgo libera o e-mail e a recontratação cria conta nova.
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
      // O trigger da 0069 só reativa conta 'sem_vinculo'; esta ('convite_desfeito') volta a valer no
      // completarContaReaproveitada, depois do commit da clínica. A marca da conta abandonada é a senha ausente.
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
    if (!this.d.segredoDaInstancia) return false;
    const claro = await symmetricDecrypt({ key: this.d.segredoDaInstancia, data: f.segredo }).catch(() => null);
    if (claro === null || !totpConfere(claro, codigo, this.agora().getTime())) return false;
    // R12 do código do 3b-2 (R7 do 3b-3): a marca de reuso só depois de o código conferir; um código errado não queima
    // o valor. G5 do parecer do #176: contador fora do ar conta como reuso (falha fechada).
    const b = this.d.bloqueio;
    if (b) {
      const usado = await b.store.hit(chaveDoBloqueio(b.chaveHmac, 'totp-usado', `${userId}:${codigo}`), JANELA_DE_REUSO_MS).catch(() => {
        // H1 da reconferência do #176: a recusa por contador fora do ar avisa a operação.
        registrarEventoDeSeguranca('BLOQUEIO_INDISPONIVEL', { motivo: 'codigo_reutilizado', userId });
        return { count: 2 };
      });
      if (usado.count > 1) return false;
    }
    return true;
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
    const r1 = await this.reservarVarias(doLogin, 'bloqueio_de_login');
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
    const r2 = await this.reservarVarias(doFator, 'bloqueio_do_fator');
    if (r2 !== 'ok') {
      if (r2 === 'bloqueado') {
        registrarEventoDeSeguranca('MFA_BLOQUEADO', { motivo: 'bloqueio_do_fator', ...idsDoEvento });
        // R1 do parecer do endurecimento: o aceite que tranca o fator também avisa os admins.
        await this.avisarFatorBloqueado(u.id).catch(() => undefined);
      }
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
   * Anonimização a pedido do titular (R18; R11 do desenho do PR 3; B10). A lógica fica em `anonimizacao.ts`, que
   * recebe só os bancos, para a tarefa operacional não carregar o segredo da instância (R5 do parecer de 12/11).
   */
  anonimizarConta(pedido: PedidoDeAnonimizacao): Promise<ResultadoDaAnonimizacao> {
    return anonimizarContaDoTitular({ dbAuth: this.d.dbAuth, dbClinica: this.d.dbClinica }, pedido);
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
    // R7 do código do 3b-1: se a marca não gravar, a sessão (que nunca chegou ao cliente) some na hora.
    try {
      await this.d.dbAuth
        .update(sessao)
        .set({ cadastroPendenteAte: new Date(this.agora().getTime() + PRAZO_DO_CADASTRO_PENDENTE_MS) })
        .where(eq(sessao.id, lida.session.id));
    } catch (err) {
      await this.d.dbAuth.delete(sessao).where(eq(sessao.id, lida.session.id)).catch(() => undefined);
      throw err;
    }
    return cookies;
  }

  /** Clínicas com vínculo ativo, pelo espelho `identidade.vinculo` (0064, só ids). */
  async clinicasDoUsuario(userId: string): Promise<string[]> {
    const linhas = await this.d.dbAuth.selectDistinct({ clinicaId: vinculo.clinicaId }).from(vinculo).where(eq(vinculo.usuarioId, userId)).orderBy(vinculo.clinicaId);
    // Sobra da C1 do parecer do #195 (reconferência de 17/11): a clínica com ativação do fundador ainda pendente não conta,
    // senão quem já tinha uma clínica perdia a escolha automática até ativar a nova.
    const fora = await this.clinicasComAtivacaoPendente(userId);
    return linhas.map((l) => l.clinicaId).filter((c) => !fora.has(c));
  }

  /** Clínicas em que a pessoa é fundadora com ativação ainda não usada (C1 do parecer do #195). */
  private async clinicasComAtivacaoPendente(userId: string): Promise<Set<string>> {
    const pendentes = await this.d.dbAuth
      .select({ clinicaId: ativacaoDoFundador.clinicaId })
      .from(ativacaoDoFundador)
      .where(and(eq(ativacaoDoFundador.usuarioId, userId), isNull(ativacaoDoFundador.usadoEm)));
    return new Set(pendentes.map((p) => p.clinicaId));
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
   *
   * Ordem (ALTA do parecer do #149): a trilha grava ANTES da clínica ativa. Os dois ficam em bancos diferentes; se
   * a trilha falhar, a sessão continua sem clínica (sem acesso) e o log alarma. Nunca acesso sem linha na trilha.
   * O inverso (trilha gravada e update falhou) só deixa uma linha a mais, e a pessoa tenta de novo.
   */
  async definirClinica(sessaoId: string, userId: string, tenantId: string): Promise<boolean> {
    if (!(await this.clinicasDoUsuario(userId)).includes(tenantId)) return false;
    // H3 da reconferência do #176: clínica cancelada fora da janela de saída não vira a clínica ativa (nem na escolha
    // automática do resolver); a leitura vem depois da conferência do vínculo.
    if (!(await this.clinicaLiberada(tenantId, userId))) return false;
    // ALTA do parecer do #149: a trilha grava ANTES de a sessão ganhar a clínica. Sem a linha, a escolha não vale e o
    // TOTP feito sem clínica continua guardado (a escolha não aconteceu; o prazo de 5 min segue correndo).
    try {
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
    } catch {
      // Com a trilha fora, cada requisição tenta de novo: um alarme por sessão a cada minuto, não um por requisição.
      registrarNoMaximoUmaVez(`trilha-clinica:${sessaoId}`, 60_000, 'TRILHA_NAO_GRAVADA', { tenantId, userId, motivo: 'escolha_de_clinica' });
      return false;
    }
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
    // Sessão apagada entre a trilha e a troca: sobra uma linha a mais na trilha, nunca acesso sem linha.
    if (!antesDaTroca) return false;
    const antes = {
      clinicaAtiva: antesDaTroca.clinica_antes,
      semClinica: antesDaTroca.sem_clinica_antes === null ? null : new Date(antesDaTroca.sem_clinica_antes),
    };
    const aproveita =
      antes.clinicaAtiva === null && antes.semClinica !== null && this.agora().getTime() - antes.semClinica.getTime() <= PRAZO_MFA_SEM_CLINICA_MS;
    if (aproveita) await this.marcarMfaComTrilha(sessaoId, tenantId, userId, ['mfa_verified'], AuditAction.Login);
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
    // B13 (troca do admin único). Falha aqui nunca derruba o TOTP aceito: o job refaz a conclusão e o log alarma.
    const bancos = { dbAuth: this.d.dbAuth, dbClinica: this.d.dbClinica };
    if (motivo === 'cadastro_do_fator') {
      // R1: a troca só conclui (e o vínculo antigo só cai) quando a conta nova confirma o TOTP.
      await concluirTrocaDoAdmin(bancos, userId).catch(() =>
        registrarNoMaximoUmaVez(`troca-conclusao:${userId}`, 60_000, 'TRILHA_NAO_GRAVADA', { motivo: 'conclusao_da_troca', userId }),
      );
    } else if (motivo === 'login_em_duas_etapas') {
      // Login completo da conta antiga: suspende a troca em andamento ou alarma depois da conclusão (R5).
      await aoLoginCompletoDaConta(bancos, userId).catch(() =>
        registrarNoMaximoUmaVez(`troca-login:${userId}`, 60_000, 'TRILHA_NAO_GRAVADA', { motivo: 'login_da_conta_antiga', userId }),
      );
    }
    const [s]= await this.d.dbAuth.select({ clinicaAtiva: sessao.clinicaAtiva }).from(sessao).where(and(eq(sessao.id, sessaoId), eq(sessao.userId, userId)));
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
      // Sem a linha da escolha na trilha, a sessão fica sem clínica: nada de MFA marcado.
      if (!(await this.definirClinica(sessaoId, userId, tenantId))) return 'nada';
    }
    const ops = motivo === 'cadastro_do_fator' ? ['mfa_enrolled', 'mfa_verified'] : ['mfa_verified'];
    if (!(await this.marcarMfaComTrilha(sessaoId, tenantId, userId, ops, AuditAction.Login))) return 'nada';
    return 'marcado';
  }

  /** Código ou senha do cadastro recusados com sessão aberta: trilha da clínica ativa (falha e, se for o caso, bloqueio). */
  async aposMfaRecusado(sessaoId: string, userId: string, bloqueou: boolean): Promise<void> {
    const [s] = await this.d.dbAuth.select({ clinicaAtiva: sessao.clinicaAtiva }).from(sessao).where(and(eq(sessao.id, sessaoId), eq(sessao.userId, userId)));
    if (!s?.clinicaAtiva) return;
    await this.trilhaDoFator(s.clinicaAtiva, userId, bloqueou ? ['mfa_failed', 'mfa_locked'] : ['mfa_failed'], AuditAction.LoginFailed);
  }

  /**
   * Marca o MFA e grava a trilha do fator. `mfa_em` e a trilha ficam em bancos diferentes, então a ordem importa:
   * marcar primeiro e gravar depois deixaria, se a trilha falhasse, uma sessão com MFA válido abrindo prontuário
   * sensível SEM a linha do fator na trilha da clínica. Aqui, se a trilha falha, o MFA é DESFEITO (a pessoa
   * reverifica) e o log alarma. Devolve se a sessão terminou com MFA marcado.
   */
  private async marcarMfaComTrilha(
    sessaoId: string,
    tenantId: string,
    userId: string,
    ops: readonly string[],
    action: AuditAction,
  ): Promise<boolean> {
    if (!(await this.marcarMfa(sessaoId))) return false;
    try {
      await this.trilhaDoFator(tenantId, userId, ops, action);
      return true;
    } catch {
      let desfeito = true;
      try {
        await this.d.dbAuth.update(sessao).set({ mfaEm: null, perfisNoMfa: null }).where(eq(sessao.id, sessaoId));
      } catch {
        desfeito = false;
      }
      // R2 e R3 do parecer de 16/11 sobre o #181: o motivo diz qual linha se perdeu (a do cadastro não se refaz na
      // reverificação) e se o desfazer falhou (sessão com MFA e sem linha: o pior caso).
      const motivo = !desfeito ? 'mfa_sem_trilha' : ops.includes('mfa_enrolled') ? 'trilha_do_cadastro_do_fator' : 'trilha_do_fator';
      registrarNoMaximoUmaVez(`trilha-fator:${sessaoId}`, 60_000, 'TRILHA_NAO_GRAVADA', { tenantId, userId, motivo });
      return false;
    }
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

  /**
   * Apaga a sessão no servidor (logout, prazo absoluto, conta desligada) e grava o fim na TRILHA da clínica, não só no
   * log de segurança — o log serve para alarmar, a trilha é a prova (R6(a) do parecer do #117).
   *
   * Só o fim da sessão tem clínica para gravar: o login e a falha de login acontecem ANTES de a clínica ser escolhida
   * (`definirClinica`), e a trilha é por clínica. Por isso login continua só no log de segurança, e o vestígio dele na
   * trilha é o `session_tenant_selected`.
   *
   * A trilha vai DEPOIS do delete, com rede: a sessão já foi apagada, e logout não pode falhar porque a trilha falhou.
   * Falha de gravação emite `TRILHA_NAO_GRAVADA`, que é crítico com alarme imediato.
   */
  async encerrar(sessaoId: string, motivo: 'logout' | 'prazo_absoluto' | 'conta_inativa' = 'logout', userId?: string): Promise<void> {
    const [antes] = await this.d.dbAuth
      .select({ userId: sessao.userId, clinicaAtiva: sessao.clinicaAtiva })
      .from(sessao)
      .where(eq(sessao.id, sessaoId));
    await this.d.dbAuth.delete(sessao).where(eq(sessao.id, sessaoId));
    const ator = antes?.userId ?? userId;
    registrarEventoDeSeguranca('LOGOUT', { motivo, ...(ator ? { userId: ator } : {}) });
    const tenantId = antes?.clinicaAtiva;
    if (!tenantId || !ator) return;
    try {
      await withTenant(
        this.d.dbClinica,
        tenantId as TenantId,
        (tx) =>
          recordAudit(tx, { tenantId: tenantId as TenantId, userId: ator as UserId, roles: [] }, {
            action: AuditAction.Update,
            scope: 'session',
            metadata: { op: 'session_ended', reason: motivo },
          }),
        ator,
      );
    } catch {
      registrarEventoDeSeguranca('TRILHA_NAO_GRAVADA', { tenantId, userId: ator, motivo: 'fim_de_sessao' });
    }
  }
}
