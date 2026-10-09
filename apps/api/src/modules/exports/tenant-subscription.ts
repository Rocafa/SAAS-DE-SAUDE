import type { TenantId } from '@plataforma/shared';
import { eq } from 'drizzle-orm';
import { tenants, type SubscriptionStatus } from '../../db/schema';
import type { TenantTx } from '../../db/tenant-transaction';

export interface TenantSubscription {
  readonly id: TenantId;
  readonly displayName: string;
  readonly status: SubscriptionStatus;
  readonly cancelledAt: Date | null;
  readonly createdAt: Date;
}

/** Lê o tenant do contexto atual (filtro explícito + RLS). Falha fechada se não houver linha. */
export async function loadTenantSubscription(tx: TenantTx, tenantId: TenantId): Promise<TenantSubscription> {
  const [row] = await tx.select().from(tenants).where(eq(tenants.id, tenantId));
  if (!row) throw new Error('tenant não encontrado no contexto atual');
  return {
    id: row.id as TenantId,
    displayName: row.displayName,
    status: row.subscriptionStatus,
    cancelledAt: row.cancelledAt,
    createdAt: row.createdAt,
  };
}
