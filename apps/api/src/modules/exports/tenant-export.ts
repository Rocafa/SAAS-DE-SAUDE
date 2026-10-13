/**
 * GARANTIA DE SAÍDA — exportação total do tenant (G2) com auditoria na mesma transação (G3).
 * Ver docs/04-arquitetura/garantia-de-saida.md.
 */
import { AuditAction, type RequestContext } from '@plataforma/shared';
import { asc, eq } from 'drizzle-orm';
import { appointments, appointmentTypes, patients, professionals, type SubscriptionStatus } from '../../db/schema';
import { withTenant, type Database, type TenantTx } from '../../db/tenant-transaction';
import { recordAudit } from '../audit/audit-log';
import type { FieldCipher } from '../crypto/field-cipher';
import { patientFieldRef, type PatientEncryptedColumn } from '../patients/patient-fields';
import { canExport, ExitWindowClosedError, exitWindowEndsAt, EXIT_WINDOW_DAYS } from './access-policy';
import { toCsv } from './csv';
import { loadTenantSubscription } from './tenant-subscription';

export const EXPORT_FORMAT = 'plataforma-saude/tenant-export';
/**
 * Versão do contrato do pacote. Mudança incompatível => major; campo novo => minor.
 * 1.1.0: cadastro do paciente (campos decifrados), profissionais, tipos de atendimento e agendamentos.
 */
export const EXPORT_SCHEMA_VERSION = '1.1.0';
export const EXPORT_AUDIT_SCOPE = 'tenant.full_export';
export const EXPORT_FILES = { json: 'export.json', patientsCsv: 'pacientes.csv' } as const;

/**
 * Cobertura da exportação, conferida contra o catálogo do banco por test/exportacao-cobertura.rls.test.ts:
 * toda tabela de `public` com `tenant_id` precisa estar em EXPORTED_TABLES ou em EXPORT_EXCLUDED_TABLES
 * (com o motivo). Tabela nova sem decisão reprova o test:rls.
 */
export const EXPORTED_TABLES = ['tenants', 'patients', 'professionals', 'appointment_types', 'appointments'] as const;
export const EXPORT_EXCLUDED_TABLES: Readonly<Record<string, string>> = {
  tenant_master_keys: 'referência de chave mestra (KMS): segredo operacional do operador, nunca sai',
  tenant_data_keys: 'chave de dados cifrada: os campos já saem decifrados para a clínica',
  tenant_context: 'tabela interna do RLS (contexto da transação), sem dado da clínica',
  audit_log: 'trilha de acesso: guardada pelo operador (G3, Marco Civil art. 15); entregue sob pedido, não no pacote',
};

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
  readonly counts: {
    readonly tenants: number;
    readonly patients: number;
    readonly professionals: number;
    readonly appointmentTypes: number;
    readonly appointments: number;
  };
  readonly files: typeof EXPORT_FILES;
  readonly encoding: 'utf-8';
}

export interface ExportedPatient {
  readonly id: string;
  readonly displayName: string;
  readonly socialName: string | null;
  /** Campos cifrados no banco saem DECIFRADOS: o pacote é da própria clínica (controladora). */
  readonly cpf: string | null;
  readonly phone: string | null;
  readonly birthDate: string | null;
  readonly active: boolean;
  readonly inactivatedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ExportedProfessional {
  readonly id: string;
  readonly userId: string | null;
  readonly displayName: string;
  readonly specialty: string;
  readonly capacity: number;
  readonly active: boolean;
  readonly createdAt: string;
}

export interface ExportedAppointmentType {
  readonly id: string;
  readonly name: string;
  readonly durationMinutes: number;
  readonly capacity: number;
  readonly active: boolean;
  readonly createdAt: string;
}

export interface ExportedAppointment {
  readonly id: string;
  readonly patientId: string;
  readonly professionalId: string;
  readonly appointmentTypeId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  /** Valores de AppointmentStatus (packages/shared). */
  readonly status: string;
  readonly isWalkIn: boolean;
  readonly checkedInAt: string | null;
  readonly cancelledAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TenantExportDocument {
  readonly manifest: ExportManifest;
  readonly data: {
    readonly tenant: { readonly id: string; readonly displayName: string; readonly createdAt: string };
    readonly patients: readonly ExportedPatient[];
    readonly professionals: readonly ExportedProfessional[];
    readonly appointmentTypes: readonly ExportedAppointmentType[];
    readonly appointments: readonly ExportedAppointment[];
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
  /** Cifra de campo da aplicação. Obrigatória se algum paciente tiver campo cifrado (falha fechada). */
  readonly cipher?: FieldCipher<TenantTx>;
}

/** Sem cifra disponível não há como entregar o dado: falha em vez de exportar texto cifrado ou faltando. */
export class ExportCipherMissingError extends Error {
  constructor() {
    super('exportação com campos cifrados exige a cifra de campo');
    this.name = 'ExportCipherMissingError';
  }
}

const iso = (d: Date | null): string | null => d?.toISOString() ?? null;

/** Defesa em profundidade além do filtro explícito e do RLS. */
function soDaClinica<T extends { tenantId: string }>(rows: readonly T[], tenantId: string): readonly T[] {
  if (rows.some((r) => r.tenantId !== tenantId)) throw new Error('linha de outro tenant no export');
  return rows;
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

  const patientRows = soDaClinica(
    await tx.select().from(patients).where(eq(patients.tenantId, ctx.tenantId)).orderBy(asc(patients.createdAt), asc(patients.id)),
    ctx.tenantId,
  );
  const professionalRows = soDaClinica(
    await tx
      .select()
      .from(professionals)
      .where(eq(professionals.tenantId, ctx.tenantId))
      .orderBy(asc(professionals.createdAt), asc(professionals.id)),
    ctx.tenantId,
  );
  const typeRows = soDaClinica(
    await tx
      .select()
      .from(appointmentTypes)
      .where(eq(appointmentTypes.tenantId, ctx.tenantId))
      .orderBy(asc(appointmentTypes.createdAt), asc(appointmentTypes.id)),
    ctx.tenantId,
  );
  const appointmentRows = soDaClinica(
    await tx
      .select()
      .from(appointments)
      .where(eq(appointments.tenantId, ctx.tenantId))
      .orderBy(asc(appointments.startsAt), asc(appointments.id)),
    ctx.tenantId,
  );

  const decrypt = async (rowId: string, column: PatientEncryptedColumn, value: string | null): Promise<string | null> => {
    if (value === null) return null;
    if (!options.cipher) throw new ExportCipherMissingError();
    return options.cipher.decryptString(tx, patientFieldRef(ctx.tenantId, rowId, column), value);
  };

  const exportedPatients: ExportedPatient[] = [];
  for (const r of patientRows) {
    exportedPatients.push({
      id: r.id,
      displayName: r.displayName,
      socialName: r.socialName,
      cpf: await decrypt(r.id, 'cpf', r.cpfEnc),
      phone: await decrypt(r.id, 'phone', r.phoneEnc),
      birthDate: await decrypt(r.id, 'birth_date', r.birthDateEnc),
      active: r.active,
      inactivatedAt: iso(r.inactivatedAt),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    });
  }
  const exportedProfessionals: ExportedProfessional[] = professionalRows.map((p) => ({
    id: p.id,
    userId: p.userId,
    displayName: p.displayName,
    specialty: p.specialty,
    capacity: p.capacity,
    active: p.active,
    createdAt: p.createdAt.toISOString(),
  }));
  const exportedTypes: ExportedAppointmentType[] = typeRows.map((t) => ({
    id: t.id,
    name: t.name,
    durationMinutes: t.durationMinutes,
    capacity: t.capacity,
    active: t.active,
    createdAt: t.createdAt.toISOString(),
  }));
  const exportedAppointments: ExportedAppointment[] = appointmentRows.map((a) => ({
    id: a.id,
    patientId: a.patientId,
    professionalId: a.professionalId,
    appointmentTypeId: a.appointmentTypeId,
    startsAt: a.startsAt.toISOString(),
    endsAt: a.endsAt.toISOString(),
    status: a.status,
    isWalkIn: a.isWalkIn,
    checkedInAt: iso(a.checkedInAt),
    cancelledAt: iso(a.cancelledAt),
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
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
    counts: {
      tenants: 1,
      patients: exportedPatients.length,
      professionals: exportedProfessionals.length,
      appointmentTypes: exportedTypes.length,
      appointments: exportedAppointments.length,
    },
    files: EXPORT_FILES,
    encoding: 'utf-8',
  };

  // toCsv neutraliza injeção de fórmula (CWE-1236) em todas as colunas, inclusive as novas.
  const patientsCsv = toCsv(
    ['id', 'display_name', 'social_name', 'cpf', 'phone', 'birth_date', 'active', 'inactivated_at', 'created_at', 'updated_at'],
    exportedPatients.map((p) => [
      p.id,
      p.displayName,
      p.socialName,
      p.cpf,
      p.phone,
      p.birthDate,
      p.active ? 'true' : 'false',
      p.inactivatedAt,
      p.createdAt,
      p.updatedAt,
    ]),
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
      professionals: manifest.counts.professionals,
      appointmentTypes: manifest.counts.appointmentTypes,
      appointments: manifest.counts.appointments,
    },
  });

  return {
    json: {
      manifest,
      data: {
        tenant: { id: tenant.id, displayName: tenant.displayName, createdAt: tenant.createdAt.toISOString() },
        patients: exportedPatients,
        professionals: exportedProfessionals,
        appointmentTypes: exportedTypes,
        appointments: exportedAppointments,
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
