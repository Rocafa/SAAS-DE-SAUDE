/**
 * GARANTIA DE SAÍDA — exportação total do tenant (G2) com auditoria na mesma transação (G3).
 * Ver docs/04-arquitetura/garantia-de-saida.md.
 */
import { AuditAction, type RequestContext } from '@plataforma/shared';
import { asc, eq, sql } from 'drizzle-orm';
import {
  appointmentReschedules,
  appointments,
  appointmentTypes,
  clinicMembers,
  clinicalAddenda,
  clinicalRecordVersions,
  clinicalSettings,
  encounters,
  guideSessions,
  guideSessionSignatures,
  insuranceGuides,
  insurers,
  legalHolds,
  noteCustodies,
  packageProfessionalChanges,
  packageSessions,
  patients,
  privateNotes,
  professionals,
  sessionPackages,
  tenants,
  type SubscriptionStatus,
} from '../../db/schema';
import { withTenant, type Database, type TenantTx } from '../../db/tenant-transaction';
import { auditChainHead, type ChainAnchor, type ExportedAuditEvent } from '../audit/audit-chain';
import { recordAudit } from '../audit/audit-log';
import type { FieldCipher } from '../crypto/field-cipher';
import { exportarFinanceiro, type ExportedFinance, type FinanceCounts } from '../finance/finance-export';
import { exportarWhatsapp, type ExportedWhatsapp, type WhatsappCounts } from '../messaging/whatsapp-export';
import { guideFieldRef, type GuideEncryptedColumn } from '../insurance/guide-fields';
import { patientFieldRef, type PatientEncryptedColumn } from '../patients/patient-fields';
import {
  CAMPO_ADENDO,
  CAMPO_NOTA,
  CAMPO_RETENCAO_MOTIVO,
  CAMPO_RETENCAO_REFERENCIA,
  CAMPO_VERSAO,
  campoClinicoRef,
  type CampoClinico,
} from '../records/record-fields';
import { canExport, ExitWindowClosedError, exitWindowEndsAt, EXIT_WINDOW_DAYS } from './access-policy';
import { toCsv } from './csv';
import { loadTenantSubscription } from './tenant-subscription';

export const EXPORT_FORMAT = 'plataforma-saude/tenant-export';
/**
 * Versão do contrato do pacote. Mudança incompatível => major; campo novo => minor.
 * 1.1.0: cadastro do paciente (campos decifrados), profissionais, tipos de atendimento e agendamentos.
 * 1.2.0: trilha de auditoria da clínica (`auditoria.jsonl`) com os campos da cadeia de hash e o JSON
 *        canônico, para a clínica verificar (Decisão 1 do Guardião, parecer PR #57); manifesto com a
 *        contagem e o último elo (`auditChain.head`).
 * 1.3.0: `tenant.careLinkDays` (janela de continuidade do vínculo de cuidado) e
 *        `appointments[].createdBy` (quem criou o agendamento), da migração 0013 (PR #61).
 * 1.4.0: convênios, guias (número/senha/carteirinha decifrados), consumos de guia, confirmações do
 *        paciente por sessão, pacotes de sessões e seus consumos (migração 0011).
 * 1.5.0: `appointments[].rescheduledBy`/`rescheduleLocked` e o histórico de remarcações
 *        (`appointmentReschedules`, contagem própria), da migração 0014.
 * 1.6.0: prontuário (migração 0012): configuração de sigilo, atendimentos, TODAS as versões da evolução
 *        (conteúdo decifrado), adendos e as notas privadas que o AUTOR marcou para exportar; as demais
 *        notas privadas ficam fora, só contadas no manifesto (`privateNotesWithheld`).
 * 1.7.0: `encounters[].confidentiality` (sigilo gravado na abertura), `patients[].legalHoldSince` e
 *        `privateNotes[].custodyState`/`custodyDeadline`, da migração 0015 (B1, D1 e D2 do parecer #63).
 * 1.8.0: retenções legais (`legalHolds`, referência e motivo da retirada decifrados) e custódias das
 *        notas lacradas (`noteCustodies`), da migração 0017 (R2 e R12 do parecer #63).
 * 1.9.0: financeiro (migração 0018): configuração, perfil fiscal do profissional PF (CPF decifrado),
 *        caixas, cobranças (CPF do pagador decifrado), recebimentos, estornos, contador e recibos (retrato
 *        decifrado) e cancelamentos de recibo, em `data.finance` e `manifest.counts.finance`.
 * 1.10.0: `charges[].fiscalPurgedAt` e `receipts[].fiscalPurgedAt` (retenção fiscal, migração 0021, R7 do
 *        parecer #65); recibo eliminado sai com `content: null`.
 * 1.11.0: perfis da clínica (`clinicMembers`: usuário, perfil, concessão e revogação; 0020) e
 *        `tenant.founderUserId` (0022), pela R16 da re-revisão 3 do parecer #63 (no ramo do prontuário saiu
 *        como 1.9.0, renumerada no merge com o financeiro): dado pessoal da equipe da controladora e prova do
 *        controle de acesso (LGPD arts. 37 e 46).
 * 1.12.0: `sessionPackages[].professionalId` (profissional fixado na venda) e as trocas registradas
 *        (`packageProfessionalChanges`), da migração 0023 (R13 da re-revisão do parecer #65).
 * 1.13.0: WhatsApp (migração 0032): configuração do canal, opt-ins com a prova (referência decifrada),
 *        modelos, fila de envios e respostas (números e textos decifrados enquanto não passam os 30 dias da
 *        retenção; depois `null` com `contentPurgedAt`), em `data.whatsapp` e `manifest.counts.whatsapp`.
 */
export const EXPORT_SCHEMA_VERSION = '1.13.0';
export const EXPORT_AUDIT_SCOPE = 'tenant.full_export';
export const EXPORT_FILES = { json: 'export.json', patientsCsv: 'pacientes.csv', auditJsonl: 'auditoria.jsonl' } as const;

/**
 * Cobertura da exportação, conferida contra o catálogo do banco por test/exportacao-cobertura.rls.test.ts:
 * toda tabela de `public` com `tenant_id` precisa estar em EXPORTED_TABLES ou em EXPORT_EXCLUDED_TABLES
 * (com o motivo). Tabela nova sem decisão reprova o test:rls.
 */
export const EXPORTED_TABLES = [
  'tenants',
  'patients',
  'professionals',
  'appointment_types',
  'appointments',
  'appointment_reschedules',
  'insurers',
  'insurance_guides',
  'guide_sessions',
  'guide_session_signatures',
  'session_packages',
  'package_sessions',
  'package_professional_changes',
  'clinical_settings',
  'encounters',
  'clinical_record_versions',
  'clinical_addenda',
  // Parcial POR DECISÃO EXPRESSA DO AUTOR (HU-PRO-009): só as notas com export_consent = true e não
  // descartadas entram; as demais são contadas em manifest.counts.privateNotesWithheld (nunca o
  // conteúdo). A clínica é a controladora e o pacote é dela, mas a anotação pessoal do profissional
  // não é prontuário e o produto promete que ela não sai sem a decisão dele. Ver api-dominio.md §8.
  'private_notes',
  'legal_holds',
  'note_custodies',
  // Financeiro (0018): em data.finance.
  'finance_settings',
  'professional_fiscal_profiles',
  'cash_sessions',
  'charges',
  'payments',
  'payment_reversals',
  'receipt_counters',
  'receipts',
  'receipt_cancellations',
  'clinic_members',
  // WhatsApp (0032): em data.whatsapp. Histórico de mensagens é dado do paciente: sai inteiro.
  'whatsapp_settings',
  'whatsapp_opt_ins',
  'whatsapp_templates',
  'whatsapp_outbox',
  'whatsapp_inbound',
  'audit_log',
] as const;
export const EXPORT_EXCLUDED_TABLES: Readonly<Record<string, string>> = {
  tenant_master_keys: 'referência de chave mestra (KMS): segredo operacional do operador, nunca sai',
  tenant_data_keys: 'chave de dados cifrada: os campos já saem decifrados para a clínica',
  tenant_context: 'tabela interna do RLS (contexto da transação), sem dado da clínica',
  whatsapp_routes: 'tabela interna da rota do webhook (número de negócio -> clínica); o número sai em whatsappSettings',
  clinical_notices:
    'caixa de avisos interna ao usuário (troca de sigilo, perfil alterado, retirada de retenção), sem dado de paciente; o fato está em audit_log e em clinic_members/legal_holds, que saem no pacote',
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
    readonly insurers: number;
    readonly insuranceGuides: number;
    readonly guideSessions: number;
    readonly guideSessionSignatures: number;
    readonly sessionPackages: number;
    readonly packageSessions: number;
    readonly packageProfessionalChanges: number;
    readonly clinicalSettings: number;
    readonly encounters: number;
    readonly clinicalRecordVersions: number;
    readonly clinicalAddenda: number;
    /** Notas privadas exportadas (o autor marcou incluirNaExportacao). */
    readonly privateNotes: number;
    /** Notas privadas que existem mas ficaram FORA (sem decisão do autor ou descartadas). Só a contagem. */
    readonly privateNotesWithheld: number;
    readonly appointmentReschedules: number;
    readonly legalHolds: number;
    readonly noteCustodies: number;
    /** Financeiro (0018), por tabela. */
    readonly finance: FinanceCounts;
    /** WhatsApp (0032), por tabela. */
    readonly whatsapp: WhatsappCounts;
    readonly clinicMembers: number;
    /** Eventos em `auditoria.jsonl` (encadeados + anteriores à 0005). */
    readonly auditEvents: number;
  };
  /**
   * Cadeia da trilha no momento da exportação: último elo (para conferir com a âncora publicada) e
   * quantas linhas são anteriores à 0005 (sem hash). O evento desta própria exportação entra na
   * trilha DEPOIS e aparece no próximo pacote.
   */
  readonly auditChain: { readonly head: ChainAnchor | null; readonly legacy: number };
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
  /** Retenção legal desde (0015); null se não houver. */
  readonly legalHoldSince: string | null;
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
  /** Usuário que criou (0013); null em agendamentos anteriores à migração. */
  readonly createdBy: string | null;
  /** Último usuário que remarcou (0014); null se nunca remarcado. */
  readonly rescheduledBy: string | null;
  /** Horário travado depois de atendimento ou falta (0014). */
  readonly rescheduleLocked: boolean;
}

/** Histórico append-only de remarcações (0014): de -> para, quem e quando. */
export interface ExportedAppointmentReschedule {
  readonly id: string;
  readonly appointmentId: string;
  readonly fromStartsAt: string;
  readonly fromEndsAt: string;
  readonly toStartsAt: string;
  readonly toEndsAt: string;
  readonly rescheduledBy: string;
  readonly createdAt: string;
}

export interface ExportedInsurer {
  readonly id: string;
  readonly name: string;
  readonly ansCode: string | null;
  readonly sessionValueCents: number | null;
  readonly requiresPassword: boolean;
  readonly requiresSignature: boolean;
  readonly defaultValidityDays: number | null;
  readonly active: boolean;
  readonly inactivatedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ExportedInsuranceGuide {
  readonly id: string;
  readonly patientId: string;
  readonly insurerId: string;
  /** Cifrados no banco, saem DECIFRADOS para a própria clínica. */
  readonly number: string;
  readonly authorizationCode: string | null;
  readonly cardNumber: string | null;
  readonly authorizedSessions: number;
  readonly usedSessions: number;
  readonly issuedOn: string | null;
  readonly validUntil: string;
  readonly status: string;
  readonly cancelledAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ExportedGuideSession {
  readonly id: string;
  readonly guideId: string;
  readonly appointmentId: string;
  readonly consumedAt: string;
  readonly consumedBy: string;
  readonly overrideReason: string | null;
  readonly reversedAt: string | null;
  readonly reversedBy: string | null;
  readonly reversalReason: string | null;
}

export interface ExportedGuideSessionSignature {
  readonly id: string;
  readonly guideSessionId: string;
  readonly method: string;
  readonly deviceLabel: string | null;
  readonly signedAt: string;
  readonly recordedBy: string;
  readonly recordHash: string;
}

export interface ExportedSessionPackage {
  readonly id: string;
  readonly patientId: string;
  readonly appointmentTypeId: string | null;
  readonly name: string;
  readonly totalSessions: number;
  readonly usedSessions: number;
  readonly validUntil: string | null;
  readonly status: string;
  readonly cancelledAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly professionalId: string | null;
}

/** Troca registrada do profissional do pacote (0023). */
export interface ExportedPackageProfessionalChange {
  readonly id: string;
  readonly packageId: string;
  readonly fromProfessionalId: string | null;
  readonly toProfessionalId: string;
  readonly reason: string;
  readonly changedBy: string;
  readonly changedAt: string;
}

export interface ExportedPackageSession {
  readonly id: string;
  readonly packageId: string;
  readonly appointmentId: string;
  readonly consumedAt: string;
  readonly consumedBy: string;
  readonly reversedAt: string | null;
  readonly reversedBy: string | null;
  readonly reversalReason: string | null;
}

export interface ExportedClinicalSettings {
  readonly psychCompartment: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface ExportedEncounter {
  readonly id: string;
  readonly patientId: string;
  readonly professionalId: string;
  readonly appointmentId: string;
  readonly authorUserId: string;
  readonly template: string;
  readonly compartment: string;
  readonly aiConsent: string;
  readonly status: string;
  readonly currentVersion: number;
  readonly openedAt: string;
  readonly updatedAt: string;
  readonly signedAt: string | null;
  readonly signedBy: string | null;
  readonly signedVersion: number | null;
  readonly signedHash: string | null;
  /** Sigilo da psicologia gravado na abertura (0015, B1 do #63). */
  readonly confidentiality: string;
}

export interface ExportedClinicalRecordVersion {
  readonly id: string;
  readonly encounterId: string;
  readonly version: number;
  readonly template: string;
  readonly templateVersion: number;
  /** Cifrado no banco; sai DECIFRADO (objeto JSON do modelo) para a própria clínica. */
  readonly content: unknown;
  readonly createdAt: string;
  readonly createdBy: string;
}

export interface ExportedClinicalAddendum {
  readonly id: string;
  readonly encounterId: string;
  readonly text: string;
  readonly createdAt: string;
  readonly createdBy: string;
}

export interface ExportedPrivateNote {
  readonly id: string;
  readonly patientId: string;
  readonly authorUserId: string;
  readonly encounterId: string | null;
  readonly content: string;
  readonly exportConsent: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly discardedAt: string | null;
  /** Custódia (0015, D2 do #63). */
  readonly custodyState: string;
  readonly custodyDeadline: string | null;
}

/** Retenção legal (0017): referência e motivo da retirada saem decifrados para a clínica. */
export interface ExportedLegalHold {
  readonly id: string;
  readonly patientId: string;
  readonly reference: string;
  readonly placedBy: string;
  readonly placedAt: string;
  readonly releaseReason: string | null;
  readonly releaseRequestedBy: string | null;
  readonly releaseRequestedAt: string | null;
  readonly releasedBy: string | null;
  readonly releasedAt: string | null;
}

/** Perfil de um usuário da equipe na clínica (0020); revogado fica com quem e quando. */
export interface ExportedClinicMember {
  readonly id: string;
  readonly userId: string;
  readonly role: string;
  readonly grantedBy: string;
  readonly grantedAt: string;
  readonly revokedBy: string | null;
  readonly revokedAt: string | null;
}

/** Custódia das notas lacradas (0017). */
export interface ExportedNoteCustody {
  readonly id: string;
  readonly authorUserId: string;
  readonly substituteUserId: string;
  readonly designatedBy: string;
  readonly designatedAt: string;
  readonly acceptedAt: string | null;
}

export interface TenantExportDocument {
  readonly manifest: ExportManifest;
  readonly data: {
    readonly tenant: { readonly id: string; readonly displayName: string; readonly createdAt: string; readonly careLinkDays: number; readonly founderUserId: string | null };
    readonly patients: readonly ExportedPatient[];
    readonly professionals: readonly ExportedProfessional[];
    readonly appointmentTypes: readonly ExportedAppointmentType[];
    readonly appointments: readonly ExportedAppointment[];
    readonly insurers: readonly ExportedInsurer[];
    readonly insuranceGuides: readonly ExportedInsuranceGuide[];
    readonly guideSessions: readonly ExportedGuideSession[];
    readonly guideSessionSignatures: readonly ExportedGuideSessionSignature[];
    readonly sessionPackages: readonly ExportedSessionPackage[];
    readonly packageSessions: readonly ExportedPackageSession[];
    readonly packageProfessionalChanges: readonly ExportedPackageProfessionalChange[];
    /** Sem linha = padrão da plataforma (`restrito_ao_autor`). */
    readonly clinicalSettings: readonly ExportedClinicalSettings[];
    readonly encounters: readonly ExportedEncounter[];
    readonly clinicalRecordVersions: readonly ExportedClinicalRecordVersion[];
    readonly clinicalAddenda: readonly ExportedClinicalAddendum[];
    readonly privateNotes: readonly ExportedPrivateNote[];
    readonly appointmentReschedules: readonly ExportedAppointmentReschedule[];
    readonly legalHolds: readonly ExportedLegalHold[];
    readonly noteCustodies: readonly ExportedNoteCustody[];
    /** Financeiro (0018). */
    readonly finance: ExportedFinance;
    /** WhatsApp (0032). */
    readonly whatsapp: ExportedWhatsapp;
    readonly clinicMembers: readonly ExportedClinicMember[];
  };
}

export interface TenantExportPackage {
  /** Conteúdo de `export.json` (serialize com JSON.stringify). */
  readonly json: TenantExportDocument;
  /** Conteúdo de `pacientes.csv`. */
  readonly patientsCsv: string;
  /** Conteúdo de `auditoria.jsonl`: um ExportedAuditEvent por linha, em ordem de `seq`. */
  readonly auditJsonl: string;
  /** Os mesmos eventos já como objetos (para quem monta o arquivo e para o verificador). */
  readonly auditEvents: readonly ExportedAuditEvent[];
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
  const [config] = await tx.select({ careLinkDays: tenants.careLinkDays, founderUserId: tenants.founderUserId }).from(tenants).where(eq(tenants.id, ctx.tenantId));
  if (!config) throw new Error('tenant não encontrado no contexto atual');

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
  const doTenant = <T extends { tenantId: string }>(rows: readonly T[]) => soDaClinica(rows, ctx.tenantId);
  const insurerRows = doTenant(
    await tx.select().from(insurers).where(eq(insurers.tenantId, ctx.tenantId)).orderBy(asc(insurers.createdAt), asc(insurers.id)),
  );
  const guideRows = doTenant(
    await tx
      .select()
      .from(insuranceGuides)
      .where(eq(insuranceGuides.tenantId, ctx.tenantId))
      .orderBy(asc(insuranceGuides.createdAt), asc(insuranceGuides.id)),
  );
  const guideSessionRows = doTenant(
    await tx
      .select()
      .from(guideSessions)
      .where(eq(guideSessions.tenantId, ctx.tenantId))
      .orderBy(asc(guideSessions.consumedAt), asc(guideSessions.id)),
  );
  const signatureRows = doTenant(
    await tx
      .select()
      .from(guideSessionSignatures)
      .where(eq(guideSessionSignatures.tenantId, ctx.tenantId))
      .orderBy(asc(guideSessionSignatures.signedAt), asc(guideSessionSignatures.id)),
  );
  const packageRows = doTenant(
    await tx
      .select()
      .from(sessionPackages)
      .where(eq(sessionPackages.tenantId, ctx.tenantId))
      .orderBy(asc(sessionPackages.createdAt), asc(sessionPackages.id)),
  );
  const packageSessionRows = doTenant(
    await tx
      .select()
      .from(packageSessions)
      .where(eq(packageSessions.tenantId, ctx.tenantId))
      .orderBy(asc(packageSessions.consumedAt), asc(packageSessions.id)),
  );
  const packageChangeRows = doTenant(
    await tx
      .select()
      .from(packageProfessionalChanges)
      .where(eq(packageProfessionalChanges.tenantId, ctx.tenantId))
      .orderBy(asc(packageProfessionalChanges.changedAt), asc(packageProfessionalChanges.id)),
  );
  const settingsRows = doTenant(await tx.select().from(clinicalSettings).where(eq(clinicalSettings.tenantId, ctx.tenantId)));
  const encounterRows = doTenant(
    await tx
      .select()
      .from(encounters)
      .where(eq(encounters.tenantId, ctx.tenantId))
      .orderBy(asc(encounters.openedAt), asc(encounters.id)),
  );
  const versionRows = doTenant(
    await tx
      .select()
      .from(clinicalRecordVersions)
      .where(eq(clinicalRecordVersions.tenantId, ctx.tenantId))
      .orderBy(asc(clinicalRecordVersions.encounterId), asc(clinicalRecordVersions.version)),
  );
  const addendumRows = doTenant(
    await tx
      .select()
      .from(clinicalAddenda)
      .where(eq(clinicalAddenda.tenantId, ctx.tenantId))
      .orderBy(asc(clinicalAddenda.createdAt), asc(clinicalAddenda.id)),
  );
  const noteRows = doTenant(
    await tx
      .select()
      .from(privateNotes)
      .where(eq(privateNotes.tenantId, ctx.tenantId))
      .orderBy(asc(privateNotes.createdAt), asc(privateNotes.id)),
  );
  // Decisão do autor: só a nota viva marcada para exportar sai; as outras só contam.
  const notasExportaveis = noteRows.filter((n) => n.exportConsent && n.discardedAt === null);

  const rescheduleRows = soDaClinica(
    await tx
      .select()
      .from(appointmentReschedules)
      .where(eq(appointmentReschedules.tenantId, ctx.tenantId))
      .orderBy(asc(appointmentReschedules.createdAt), asc(appointmentReschedules.id)),
    ctx.tenantId,
  );

  const holdRows = soDaClinica(
    await tx.select().from(legalHolds).where(eq(legalHolds.tenantId, ctx.tenantId)).orderBy(asc(legalHolds.placedAt), asc(legalHolds.id)),
    ctx.tenantId,
  );
  const custodyRows = soDaClinica(
    await tx
      .select()
      .from(noteCustodies)
      .where(eq(noteCustodies.tenantId, ctx.tenantId))
      .orderBy(asc(noteCustodies.designatedAt), asc(noteCustodies.id)),
    ctx.tenantId,
  );

  const memberRows = soDaClinica(
    await tx
      .select()
      .from(clinicMembers)
      .where(eq(clinicMembers.tenantId, ctx.tenantId))
      .orderBy(asc(clinicMembers.grantedAt), asc(clinicMembers.id)),
    ctx.tenantId,
  );

  // Trilha da clínica, inteira e sem reescrita: os campos da cadeia e o JSON canônico vêm do banco
  // (data com microssegundos, como no hash). O ator interno já está pseudonimizado desde o INSERT (0008).
  const auditRows = await tx.execute<{
    tenant_id: string;
    id: string;
    actor_id: string;
    actor_kind: string | null;
    action: string;
    scope: string;
    metadata: Record<string, unknown>;
    created_at: string;
    seq: string | null;
    prev_hash: string | null;
    hash: string | null;
    canonical: string | null;
  }>(sql`
    select a.tenant_id, a.id, a.actor_id, a.actor_kind, a.action, a.scope, a.metadata,
           to_char(a.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
           a.seq::text as seq, a.prev_hash, a.hash,
           case when a.seq is null then null else audit_log_canonical(a) end as canonical
    from audit_log a
    where a.tenant_id = ${ctx.tenantId}
    order by a.seq asc nulls first, a.created_at asc, a.id asc`);
  const auditEvents: ExportedAuditEvent[] = soDaClinica(
    auditRows.map((r) => ({ ...r, tenantId: r.tenant_id })),
    ctx.tenantId,
  ).map((r) => ({
    id: r.id,
    actorId: r.actor_id,
    actorKind: r.actor_kind,
    action: r.action,
    scope: r.scope,
    metadata: r.metadata,
    createdAt: r.created_at,
    seq: r.seq === null ? null : Number(r.seq),
    prevHash: r.prev_hash,
    hash: r.hash,
    canonical: r.canonical,
  }));
  const auditHead = await auditChainHead(tx, ctx.tenantId);
  const financeiro = await exportarFinanceiro(tx, ctx.tenantId, () => {
    if (!options.cipher) throw new ExportCipherMissingError();
    return options.cipher;
  });
  const whatsapp = await exportarWhatsapp(tx, ctx.tenantId, () => {
    if (!options.cipher) throw new ExportCipherMissingError();
    return options.cipher;
  });

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
      legalHoldSince: iso(r.legalHoldSince),
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
    createdBy: a.createdBy,
    rescheduledBy: a.rescheduledBy,
    rescheduleLocked: a.rescheduleLocked,
  }));
  const exportedReschedules: ExportedAppointmentReschedule[] = rescheduleRows.map((r) => ({
    id: r.id,
    appointmentId: r.appointmentId,
    fromStartsAt: r.fromStartsAt.toISOString(),
    fromEndsAt: r.fromEndsAt.toISOString(),
    toStartsAt: r.toStartsAt.toISOString(),
    toEndsAt: r.toEndsAt.toISOString(),
    rescheduledBy: r.rescheduledBy,
    createdAt: r.createdAt.toISOString(),
  }));

  const decryptGuide = async (rowId: string, column: GuideEncryptedColumn, value: string | null): Promise<string | null> => {
    if (value === null) return null;
    if (!options.cipher) throw new ExportCipherMissingError();
    return options.cipher.decryptString(tx, guideFieldRef(ctx.tenantId, rowId, column), value);
  };
  const exportedInsurers: ExportedInsurer[] = insurerRows.map((c) => ({
    id: c.id,
    name: c.name,
    ansCode: c.ansCode,
    sessionValueCents: c.sessionValueCents,
    requiresPassword: c.requiresPassword,
    requiresSignature: c.requiresSignature,
    defaultValidityDays: c.defaultValidityDays,
    active: c.active,
    inactivatedAt: iso(c.inactivatedAt),
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  }));
  const exportedGuides: ExportedInsuranceGuide[] = [];
  for (const g of guideRows) {
    exportedGuides.push({
      id: g.id,
      patientId: g.patientId,
      insurerId: g.insurerId,
      number: (await decryptGuide(g.id, 'number', g.numberEnc)) ?? '',
      authorizationCode: await decryptGuide(g.id, 'authorization_code', g.authorizationCodeEnc),
      cardNumber: await decryptGuide(g.id, 'card_number', g.cardNumberEnc),
      authorizedSessions: g.authorizedSessions,
      usedSessions: g.usedSessions,
      issuedOn: g.issuedOn,
      validUntil: g.validUntil,
      status: g.status,
      cancelledAt: iso(g.cancelledAt),
      createdAt: g.createdAt.toISOString(),
      updatedAt: g.updatedAt.toISOString(),
    });
  }
  const exportedGuideSessions: ExportedGuideSession[] = guideSessionRows.map((s) => ({
    id: s.id,
    guideId: s.guideId,
    appointmentId: s.appointmentId,
    consumedAt: s.consumedAt.toISOString(),
    consumedBy: s.consumedBy,
    overrideReason: s.overrideReason,
    reversedAt: iso(s.reversedAt),
    reversedBy: s.reversedBy,
    reversalReason: s.reversalReason,
  }));
  const exportedSignatures: ExportedGuideSessionSignature[] = signatureRows.map((s) => ({
    id: s.id,
    guideSessionId: s.guideSessionId,
    method: s.method,
    deviceLabel: s.deviceLabel,
    signedAt: s.signedAt.toISOString(),
    recordedBy: s.recordedBy,
    recordHash: s.recordHash,
  }));
  const exportedPackages: ExportedSessionPackage[] = packageRows.map((p) => ({
    id: p.id,
    patientId: p.patientId,
    appointmentTypeId: p.appointmentTypeId,
    name: p.name,
    totalSessions: p.totalSessions,
    usedSessions: p.usedSessions,
    validUntil: p.validUntil,
    status: p.status,
    cancelledAt: iso(p.cancelledAt),
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    professionalId: p.professionalId,
  }));
  const exportedPackageChanges: ExportedPackageProfessionalChange[] = packageChangeRows.map((c) => ({
    id: c.id,
    packageId: c.packageId,
    fromProfessionalId: c.fromProfessionalId,
    toProfessionalId: c.toProfessionalId,
    reason: c.reason,
    changedBy: c.changedBy,
    changedAt: c.changedAt.toISOString(),
  }));
  const exportedPackageSessions: ExportedPackageSession[] = packageSessionRows.map((s) => ({
    id: s.id,
    packageId: s.packageId,
    appointmentId: s.appointmentId,
    consumedAt: s.consumedAt.toISOString(),
    consumedBy: s.consumedBy,
    reversedAt: iso(s.reversedAt),
    reversedBy: s.reversedBy,
    reversalReason: s.reversalReason,
  }));

  const decryptClinical = async (rowId: string, campo: CampoClinico, value: string): Promise<string> => {
    if (!options.cipher) throw new ExportCipherMissingError();
    return options.cipher.decryptString(tx, campoClinicoRef(ctx.tenantId, rowId, campo), value);
  };
  const exportedSettings: ExportedClinicalSettings[] = settingsRows.map((c) => ({
    psychCompartment: c.psychCompartment,
    updatedAt: c.updatedAt.toISOString(),
    updatedBy: c.updatedBy,
  }));
  const exportedEncounters: ExportedEncounter[] = encounterRows.map((e) => ({
    id: e.id,
    patientId: e.patientId,
    professionalId: e.professionalId,
    appointmentId: e.appointmentId,
    authorUserId: e.authorUserId,
    template: e.template,
    compartment: e.compartment,
    aiConsent: e.aiConsent,
    status: e.status,
    currentVersion: e.currentVersion,
    openedAt: e.openedAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
    signedAt: iso(e.signedAt),
    signedBy: e.signedBy,
    signedVersion: e.signedVersion,
    signedHash: e.signedHash,
    confidentiality: e.confidentiality,
  }));
  const exportedVersions: ExportedClinicalRecordVersion[] = [];
  for (const v of versionRows) {
    exportedVersions.push({
      id: v.id,
      encounterId: v.encounterId,
      version: v.version,
      template: v.template,
      templateVersion: v.templateVersion,
      content: JSON.parse(await decryptClinical(v.id, CAMPO_VERSAO, v.contentEnc)) as unknown,
      createdAt: v.createdAt.toISOString(),
      createdBy: v.createdBy,
    });
  }
  const exportedAddenda: ExportedClinicalAddendum[] = [];
  for (const a of addendumRows) {
    exportedAddenda.push({
      id: a.id,
      encounterId: a.encounterId,
      text: await decryptClinical(a.id, CAMPO_ADENDO, a.textEnc),
      createdAt: a.createdAt.toISOString(),
      createdBy: a.createdBy,
    });
  }
  const exportedNotes: ExportedPrivateNote[] = [];
  for (const n of notasExportaveis) {
    exportedNotes.push({
      id: n.id,
      patientId: n.patientId,
      authorUserId: n.authorUserId,
      encounterId: n.encounterId,
      content: await decryptClinical(n.id, CAMPO_NOTA, n.contentEnc),
      exportConsent: n.exportConsent,
      createdAt: n.createdAt.toISOString(),
      updatedAt: n.updatedAt.toISOString(),
      discardedAt: iso(n.discardedAt),
      custodyState: n.custodyState,
      custodyDeadline: iso(n.custodyDeadline),
    });
  }

  const exportedHolds: ExportedLegalHold[] = [];
  for (const h of holdRows) {
    exportedHolds.push({
      id: h.id,
      patientId: h.patientId,
      reference: await decryptClinical(h.id, CAMPO_RETENCAO_REFERENCIA, h.referenceEnc),
      placedBy: h.placedBy,
      placedAt: h.placedAt.toISOString(),
      releaseReason: h.releaseReasonEnc ? await decryptClinical(h.id, CAMPO_RETENCAO_MOTIVO, h.releaseReasonEnc) : null,
      releaseRequestedBy: h.releaseRequestedBy,
      releaseRequestedAt: iso(h.releaseRequestedAt),
      releasedBy: h.releasedBy,
      releasedAt: iso(h.releasedAt),
    });
  }
  const exportedCustodies: ExportedNoteCustody[] = custodyRows.map((c) => ({
    id: c.id,
    authorUserId: c.authorUserId,
    substituteUserId: c.substituteUserId,
    designatedBy: c.designatedBy,
    designatedAt: c.designatedAt.toISOString(),
    acceptedAt: iso(c.acceptedAt),
  }));

  const exportedMembers: ExportedClinicMember[] = memberRows.map((m) => ({
    id: m.id,
    userId: m.userId,
    role: m.role,
    grantedBy: m.grantedBy,
    grantedAt: m.grantedAt.toISOString(),
    revokedBy: m.revokedBy,
    revokedAt: iso(m.revokedAt),
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
      insurers: exportedInsurers.length,
      insuranceGuides: exportedGuides.length,
      guideSessions: exportedGuideSessions.length,
      guideSessionSignatures: exportedSignatures.length,
      sessionPackages: exportedPackages.length,
      packageProfessionalChanges: exportedPackageChanges.length,
      packageSessions: exportedPackageSessions.length,
      clinicalSettings: exportedSettings.length,
      encounters: exportedEncounters.length,
      clinicalRecordVersions: exportedVersions.length,
      clinicalAddenda: exportedAddenda.length,
      privateNotes: exportedNotes.length,
      privateNotesWithheld: noteRows.length - exportedNotes.length,
      appointmentReschedules: exportedReschedules.length,
      legalHolds: exportedHolds.length,
      noteCustodies: exportedCustodies.length,
      finance: financeiro.counts,
      whatsapp: whatsapp.counts,
      clinicMembers: exportedMembers.length,
      auditEvents: auditEvents.length,
    },
    auditChain: { head: auditHead, legacy: auditEvents.filter((e) => e.seq === null).length },
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
      formats: 'json+csv+jsonl',
      subscriptionStatus: tenant.status,
      tenants: manifest.counts.tenants,
      patients: manifest.counts.patients,
      professionals: manifest.counts.professionals,
      appointmentTypes: manifest.counts.appointmentTypes,
      appointments: manifest.counts.appointments,
      // Resumo de guias e pacotes (o metadata tem teto de 16 chaves; o detalhe está no manifesto).
      guides: manifest.counts.insuranceGuides,
      packages: manifest.counts.sessionPackages,
      // Prontuário (0012): só contagens; o conteúdo vai no pacote, nunca na trilha.
      encounters: manifest.counts.encounters,
      recordVersions: manifest.counts.clinicalRecordVersions,
      privateNotes: manifest.counts.privateNotes,
      privateNotesWithheld: manifest.counts.privateNotesWithheld,
      appointmentReschedules: manifest.counts.appointmentReschedules,
      auditEvents: manifest.counts.auditEvents,
    },
  });

  return {
    json: {
      manifest,
      data: {
        tenant: {
          id: tenant.id,
          displayName: tenant.displayName,
          createdAt: tenant.createdAt.toISOString(),
          careLinkDays: config.careLinkDays,
          founderUserId: config.founderUserId,
        },
        patients: exportedPatients,
        professionals: exportedProfessionals,
        appointmentTypes: exportedTypes,
        appointments: exportedAppointments,
        insurers: exportedInsurers,
        insuranceGuides: exportedGuides,
        guideSessions: exportedGuideSessions,
        guideSessionSignatures: exportedSignatures,
        sessionPackages: exportedPackages,
        packageProfessionalChanges: exportedPackageChanges,
        packageSessions: exportedPackageSessions,
        clinicalSettings: exportedSettings,
        encounters: exportedEncounters,
        clinicalRecordVersions: exportedVersions,
        clinicalAddenda: exportedAddenda,
        privateNotes: exportedNotes,
        appointmentReschedules: exportedReschedules,
        legalHolds: exportedHolds,
        noteCustodies: exportedCustodies,
        finance: financeiro.data,
        whatsapp: whatsapp.data,
        clinicMembers: exportedMembers,
      },
    },
    patientsCsv,
    auditJsonl: auditEvents.map((e) => `${JSON.stringify(e)}\n`).join(''),
    auditEvents,
  };
}

/** G2: exportação total, sem custo; inadimplente sempre, cancelado só dentro da janela de saída. */
export function exportTenantData(
  db: Database,
  ctx: RequestContext,
  options: ExportOptions = {},
): Promise<TenantExportPackage> {
  return withTenant(db, ctx.tenantId, (tx) => exportInTransaction(tx, ctx, options), ctx.userId);
}
