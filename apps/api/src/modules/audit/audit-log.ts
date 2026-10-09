import type { AuditAction, RequestContext } from '@plataforma/shared';
import { auditLog, type AuditMetadata } from '../../db/schema';
import type { TenantTx } from '../../db/tenant-transaction';

export interface AuditEntry {
  readonly action: AuditAction;
  /** Escopo da ação (ex.: `tenant.full_export`, `patients`). Minúsculas, sem dado pessoal. */
  readonly scope: string;
  /** Somente metadados escalares (contagens, versões). NUNCA conteúdo clínico ou PII de paciente. */
  readonly metadata?: AuditMetadata;
}

/**
 * Grava um evento na trilha append-only, dentro da transação do chamador (mesmo contexto de
 * tenant). Se a gravação falhar, a operação auditada falha junto: não há ação sem registro.
 */
export async function recordAudit(tx: TenantTx, ctx: RequestContext, entry: AuditEntry): Promise<void> {
  await tx.insert(auditLog).values({
    tenantId: ctx.tenantId,
    actorId: ctx.userId,
    action: entry.action,
    scope: entry.scope,
    metadata: entry.metadata ?? {},
  });
}
