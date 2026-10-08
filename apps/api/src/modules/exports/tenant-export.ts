/**
 * GARANTIA DE SAÍDA — exportação total do tenant (G2) com auditoria na mesma transação (G3).
 * Ver docs/04-arquitetura/garantia-de-saida.md.
 */
import { AuditAction, type RequestContext } from '@plataforma/shared';
import { asc, eq } from 'drizzle-orm';
import { patients, type SubscriptionStatus } from '../../db/schema';
import { withTenant, type Database, type TenantTx } from '../../db/tenant-transaction';
import { recordAudit } from '../audit/audit-log';
import { canExport, ExitWindowClosedError, exitWindowEndsAt, EXIT_WINDOW_DAYS } from './access-policy';
import { toCsv } from './csv';
import { loadTenantSubscription } from './tenant-subscription';

export const EXPORT_FORMAT = 'plataforma-saude/tenant-export';
/** Versão do contrato do pacote. Mudança incompatível => major; campo novo => minor. */
export const EXPORT_SCHEMA_VERSION = '1.0.0';
export const EXPORT_AUDIT_SCOPE = 'tenant.full_export';
export const EXPORT_FILES = { json: 'export.json', patientsCsv: 'pacientes.csv' } as const;

export interface ExportManifest {
  readonly format: typeof EXPORT_FORMAT;
  readonly schemaVersion: typeof EXPORT_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly tenant: { readonly id: string; readonly displayName: string };
  readonly subscription: {
    readonly status: SubscriptionStatus;
    readonly cancelledAt: string | null;
    /** G4: fim (exclusivo) da janela de saída após cancelamento (null se não cancelado). */
    readonly exitWindowEndsAt: string | null;
  };
  readonly counts: { readonly tenants: number; readonly patients: number };
  readonly files: typeof EXPORT_FILES;
  readonly encoding: 'utf-8';
}

export interface ExportedPatient {
  readonly id: string;
  readonly displayName: string;
  readonly createdAt: string;
}

export interface TenantExportDocument {
  readonly manifest: ExportManifest;
  readonly data: {
    readonly tenant: { readonly id: string; readonly displayName: string; readonly createdAt: string };
    readonly patients: readonly ExportedPatient[];
  };
}

export interface TenantExportPackage {
  /** Conteúdo de `export.json` (serialize com JSON.stringify). */
  readonly json: TenantExportDocument;
  /** Conteúdo de `pacientes.csv`. */
  readonly patientsCsv: string;
}

export interface ExportOptions {
  readonly now?: Date;
  /** Janela de saída em dias (config EXIT_WINDOW_DAYS; piso de 90 garantido pela política). */
  readonly exitWindowDays?: number;
}

/**
 * Monta o pacote dentro de uma transação JÁ com contexto de tenant (withTenant/TenantDatabase.run)
 * e grava a auditoria nessa mesma transação: sem registro de auditoria, não há exportação.
 */
export async function exportInTransaction(
  tx: TenantTx,
  ctx: RequestContext,
  options: ExportOptions = {},
): Promise<TenantExportPackage> {
  const now = options.now ?? new Date();
  const windowDays = options.exitWindowDays ?? EXIT_WINDOW_DAYS;
  const tenant = await loadTenantSubscription(tx, ctx.tenantId);
  // G1/G4: inadimplência nunca bloqueia; cancelado só fora da janela de saída.
  if (!canExport(tenant.status, tenant.cancelledAt, now, windowDays)) throw new ExitWindowClosedError();

  const rows = await tx
    .select()
    .from(patients)
    .where(eq(patients.tenantId, ctx.tenantId))
    .orderBy(asc(patients.createdAt), asc(patients.id));
  // Defesa em profundidade além do filtro explícito e do RLS.
  if (rows.some((r) => r.tenantId !== ctx.tenantId)) throw new Error('linha de outro tenant no export');

  const exported: ExportedPatient[] = rows.map((r) => ({
    id: r.id,
    displayName: r.displayName,
    createdAt: r.createdAt.toISOString(),
  }));

  const manifest: ExportManifest = {
    format: EXPORT_FORMAT,
    schemaVersion: EXPORT_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    tenant: { id: tenant.id, displayName: tenant.displayName },
    subscription: {
      status: tenant.status,
      cancelledAt: tenant.cancelledAt?.toISOString() ?? null,
      exitWindowEndsAt:
        tenant.status === 'cancelled' && tenant.cancelledAt
          ? exitWindowEndsAt(tenant.cancelledAt, windowDays).toISOString()
          : null,
    },
    counts: { tenants: 1, patients: exported.length },
    files: EXPORT_FILES,
    encoding: 'utf-8',
  };

  const patientsCsv = toCsv(
    ['id', 'display_name', 'created_at'],
    exported.map((p) => [p.id, p.displayName, p.createdAt]),
  );

  // G3: quem/quando (actor_id/created_at), escopo e contagens. Nenhum conteúdo do pacote.
  await recordAudit(tx, ctx, {
    action: AuditAction.Export,
    scope: EXPORT_AUDIT_SCOPE,
    metadata: {
      schemaVersion: EXPORT_SCHEMA_VERSION,
      formats: 'json+csv',
      subscriptionStatus: tenant.status,
      tenants: manifest.counts.tenants,
      patients: manifest.counts.patients,
    },
  });

  return {
    json: {
      manifest,
      data: {
        tenant: { id: tenant.id, displayName: tenant.displayName, createdAt: tenant.createdAt.toISOString() },
        patients: exported,
      },
    },
    patientsCsv,
  };
}

/** G2: exportação total, sem custo; inadimplente sempre, cancelado só dentro da janela de saída. */
export function exportTenantData(
  db: Database,
  ctx: RequestContext,
  options: ExportOptions = {},
): Promise<TenantExportPackage> {
  return withTenant(db, ctx.tenantId, (tx) => exportInTransaction(tx, ctx, options));
}
