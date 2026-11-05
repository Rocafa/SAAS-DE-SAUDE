import type { RequestContext } from '@plataforma/shared';
import type { TenantTx } from '../db/tenant-transaction';
import { assertCanWrite, canRead, EXIT_WINDOW_DAYS, ExitWindowClosedError } from '../modules/exports/access-policy';
import { loadTenantSubscription } from '../modules/exports/tenant-subscription';
import type { TenantDatabase } from '../modules/tenancy/tenancy.module';
import { comPoliticaDeAssinatura } from './erros-dominio';

/**
 * Transação da clínica DA SESSÃO (withTenant + RLS) com a política de assinatura:
 * leitura negada só fora da janela de saída (G4); escrita negada se a assinatura bloqueia (G1).
 */
export function lerNaClinica<T>(db: TenantDatabase, ctx: RequestContext, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return comPoliticaDeAssinatura(
    db.run(ctx.tenantId, async (tx) => {
      const t = await loadTenantSubscription(tx, ctx.tenantId);
      if (!canRead(t.status, t.cancelledAt, new Date(), EXIT_WINDOW_DAYS)) throw new ExitWindowClosedError();
      return fn(tx);
    }, ctx.userId),
  );
}

export function escreverNaClinica<T>(db: TenantDatabase, ctx: RequestContext, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return comPoliticaDeAssinatura(
    db.run(ctx.tenantId, async (tx) => {
      assertCanWrite((await loadTenantSubscription(tx, ctx.tenantId)).status);
      return fn(tx);
    }, ctx.userId),
  );
}
