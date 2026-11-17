import type { TenantId, UserId } from './ids.js';

/** Contexto de requisição propagado da borda até o repositório (e para SET LOCAL no Postgres). */
export interface RequestContext {
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly roles: readonly string[];
  /** Finalidade declarada do acesso — registrada na auditoria. */
  readonly purpose?: string;
  /**
   * Quando o usuário passou pelo segundo fator nesta sessão (null = não passou; ausente = contexto sem sessão, como
   * os jobs). Usado onde o MFA recente depende do REGISTRO, e não da rota (R3 do parecer do #123: psicologia).
   */
  readonly mfaEm?: Date | null;
}
