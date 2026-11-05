/**
 * Provedor de sessão real (D4: Better Auth) atrás da porta `AuthProvider`. Desenho: autenticacao-better-auth.md §§5–6
 * e §12. Passa no contrato do #128 com os 6 ganchos (bancada em test/contrato-provedor-better-auth.rls.test.ts).
 *
 * A cada requisição: sessão da biblioteca → prazo absoluto de 12 h (R3) → conta ativa → campos NOSSOS da sessão
 * (clínica ativa, MFA e impressão dos perfis) → perfis SÓ de `clinic_members` (R6) → `mfaEm` só vale se os perfis não
 * mudaram desde o MFA (`perfis_no_mfa`, R13). A clínica nunca vem do cliente (regra 1).
 */
import { createHash } from 'node:crypto';
import type { TenantId, UserId } from '@plataforma/shared';
import { AuditAction } from '@plataforma/shared';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';

import { fromNodeHeaders } from 'better-auth/node';
import { clinicMembers, tenants } from '../../../db/schema';
import { sessao, usuario, vinculo } from '../../../db/identidade';
import { withTenant, type Database } from '../../../db/tenant-transaction';
import { registrarEventoDeSeguranca } from '../../../security/log-de-seguranca';
import { recordAudit } from '../../audit/audit-log';
import type { AuthContext, AuthProvider, ClinicaDaPessoa, ProvedorDePessoa, RequisicaoParaSessao, SessaoDePessoa, SessaoListada } from '../auth-context';
import { PERFIS, type Perfil } from '../perfis';
import { PRAZO_ABSOLUTO_MS, type Autenticacao } from './instancia';

/** Impressão dos perfis no momento do MFA (16 hex): se os perfis mudam no banco, o MFA deixa de valer (R13). */
export function impressaoDosPerfis(perfis: readonly Perfil[]): string {
  return createHash('sha256').update([...perfis].sort().join(',')).digest('hex').slice(0, 16);
}

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
}

export class BetterAuthProvider implements AuthProvider, ProvedorDePessoa {
  readonly tipo = 'better-auth';
  private readonly agora: () => Date;

  constructor(private readonly d: DependenciasDoProvedor) {
    this.agora = d.agora ?? (() => new Date());
  }

  async resolver(req: RequisicaoParaSessao): Promise<AuthContext | null> {
    const lida = await this.d.auth.api.getSession({ headers: fromNodeHeaders(req.headers) }).catch(() => null);
    if (!lida) return null;
    const sessaoId = lida.session.id;
    const [linha] = await this.d.dbAuth
      .select({
        criadaEm: sessao.createdAt,
        clinicaAtiva: sessao.clinicaAtiva,
        mfaEm: sessao.mfaEm,
        perfisNoMfa: sessao.perfisNoMfa,
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
    const lida = await this.d.auth.api.getSession({ headers: fromNodeHeaders(req.headers) }).catch(() => null);
    if (!lida) return null;
    const [linha] = await this.d.dbAuth
      .select({ criadaEm: sessao.createdAt, usuarioId: sessao.userId, ativo: usuario.ativo })
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
    const [antes] = await this.d.dbAuth
      .select({ semClinica: sessao.mfaSemClinicaEm, clinicaAtiva: sessao.clinicaAtiva })
      .from(sessao)
      .where(and(eq(sessao.id, sessaoId), eq(sessao.userId, userId)));
    if (!antes) return false;
    await this.d.dbAuth
      .update(sessao)
      .set({ clinicaAtiva: tenantId, mfaEm: null, perfisNoMfa: null, mfaSemClinicaEm: null })
      .where(and(eq(sessao.id, sessaoId), eq(sessao.userId, userId)));
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
