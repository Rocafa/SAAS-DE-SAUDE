import type { TenantId, UserId } from './ids.js';

/** Contexto de requisição propagado da borda até o repositório (e para SET LOCAL no Postgres). */
export interface RequestContext {
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly roles: readonly string[];
  /** Finalidade declarada do acesso — registrada na auditoria. */
  readonly purpose?: string;
}
