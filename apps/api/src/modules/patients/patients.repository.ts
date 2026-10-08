import { AuditAction, type RequestContext } from '@plataforma/shared';
import { asc, eq } from 'drizzle-orm';
import { patients } from '../../db/schema';
import type { TenantTx } from '../../db/tenant-transaction';
import { recordAudit } from '../audit/audit-log';
import { assertCanWrite, canRead, EXIT_WINDOW_DAYS, ExitWindowClosedError } from '../exports/access-policy';
import { loadTenantSubscription } from '../exports/tenant-subscription';

/**
 * Acesso mínimo a pacientes, sempre dentro de uma transação com contexto de tenant.
 * Escrita passa pela política de assinatura (G1); leitura só é negada a tenant cancelado fora da janela de saída (G4).
 */
export async function createPatient(
  tx: TenantTx,
  ctx: RequestContext,
  input: { readonly displayName: string },
): Promise<{ id: string }> {
  const tenant = await loadTenantSubscription(tx, ctx.tenantId);
  assertCanWrite(tenant.status);
  const [row] = await tx
    .insert(patients)
    .values({ tenantId: ctx.tenantId, displayName: input.displayName })
    .returning({ id: patients.id });
  if (!row) throw new Error('falha ao criar paciente');
  await recordAudit(tx, ctx, { action: AuditAction.Create, scope: 'patients', metadata: { count: 1 } });
  return row;
}

export async function listPatients(
  tx: TenantTx,
  ctx: RequestContext,
  options: { readonly now?: Date; readonly exitWindowDays?: number } = {},
): Promise<{ id: string; displayName: string }[]> {
  const tenant = await loadTenantSubscription(tx, ctx.tenantId);
  const now = options.now ?? new Date();
  if (!canRead(tenant.status, tenant.cancelledAt, now, options.exitWindowDays ?? EXIT_WINDOW_DAYS)) {
    throw new ExitWindowClosedError();
  }
  const rows = await tx
    .select({ id: patients.id, displayName: patients.displayName })
    .from(patients)
    .where(eq(patients.tenantId, ctx.tenantId))
    .orderBy(asc(patients.createdAt), asc(patients.id));
  await recordAudit(tx, ctx, { action: AuditAction.Read, scope: 'patients', metadata: { count: rows.length } });
  return rows;
}
