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
import { and, eq, isNull } from 'drizzle-orm';

import { fromNodeHeaders } from 'better-auth/node';
import { clinicMembers } from '../../../db/schema';
import { sessao, usuario, vinculo } from '../../../db/identidade';
import { withTenant, type Database } from '../../../db/tenant-transaction';
import { registrarEventoDeSeguranca } from '../../../security/log-de-seguranca';
import { recordAudit } from '../../audit/audit-log';
import type { AuthContext, AuthProvider, RequisicaoParaSessao } from '../auth-context';
import { PERFIS, type Perfil } from '../perfis';
import { PRAZO_ABSOLUTO_MS, type Autenticacao } from './instancia';

/** Impressão dos perfis no momento do MFA (16 hex): se os perfis mudam no banco, o MFA deixa de valer (R13). */
export function impressaoDosPerfis(perfis: readonly Perfil[]): string {
  return createHash('sha256').update([...perfis].sort().join(',')).digest('hex').slice(0, 16);
}

export interface DependenciasDoProvedor {
  readonly auth: Autenticacao;
  /** Pool do papel `app_auth` (schema identidade e a função de clínicas). */
  readonly dbAuth: Database;
  /** Pool do papel `app_user` (RLS por clínica) para ler os perfis e gravar a trilha. */
  readonly dbClinica: Database;
  readonly agora?: () => Date;
}

export class BetterAuthProvider implements AuthProvider {
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
    await this.d.dbAuth.update(sessao).set({ clinicaAtiva: tenantId, mfaEm: null, perfisNoMfa: null }).where(and(eq(sessao.id, sessaoId), eq(sessao.userId, userId)));
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
