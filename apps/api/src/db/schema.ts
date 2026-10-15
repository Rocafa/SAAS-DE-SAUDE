import { bigint, boolean, customType, date, foreignKey, integer, jsonb, pgTable, primaryKey, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Espelho tipado das tabelas criadas em db/migrations/*.sql.
 * A fonte da verdade do DDL (RLS, policies, grants, checks) são as migrações SQL revisáveis.
 */

/** Status de assinatura do tenant (migração 0002). Mesmos valores do CHECK no banco. */
export const SUBSCRIPTION_STATUSES = ['trialing', 'active', 'past_due', 'read_only', 'cancelled'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  displayName: text('display_name').notNull(),
  subscriptionStatus: text('subscription_status', { enum: SUBSCRIPTION_STATUSES }).notNull().default('active'),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /** Migração 0013: janela de continuidade do vínculo de cuidado, em dias (1..180, padrão 90). */
  careLinkDays: smallint('care_link_days').notNull().default(90),
});

export const patients = pgTable('patients', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  displayName: text('display_name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // Migração 0007: cadastro mínimo. Os `*Enc` guardam SÓ o formato cifrado v1 (FieldCipher).
  socialName: text('social_name'),
  /** Nome normalizado (minúsculas, sem acento) para a busca; derivado de nome + nome social. */
  searchName: text('search_name').notNull().default(''),
  cpfEnc: text('cpf_enc'),
  phoneEnc: text('phone_enc'),
  birthDateEnc: text('birth_date_enc'),
  active: boolean('active').notNull().default(true),
  inactivatedAt: timestamp('inactivated_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  /** Migração 0015 (D1.4 do #63): retenção legal; enquanto marcada, nada do paciente é expurgado. */
  legalHoldSince: timestamp('legal_hold_since', { withTimezone: true }),
});

/** Profissionais (migração 0007). `capacity` = atendimentos simultâneos (AGD-01.5). */
export const professionals = pgTable('professionals', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  /** Usuário da sessão vinculado: liga o perfil "profissional" à própria agenda. */
  userId: uuid('user_id'),
  displayName: text('display_name').notNull(),
  specialty: text('specialty').notNull(),
  capacity: integer('capacity').notNull().default(1),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Tipos de atendimento (migração 0007): duração e capacidade do horário (atendimento em grupo). */
export const appointmentTypes = pgTable('appointment_types', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  name: text('name').notNull(),
  durationMinutes: integer('duration_minutes').notNull(),
  capacity: integer('capacity').notNull().default(1),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Mesmos valores do CHECK de appointments.status e de AppointmentStatus (packages/shared). */
export const APPOINTMENT_STATUSES = [
  'scheduled',
  'confirmed',
  'checked_in',
  'in_progress',
  'completed',
  'cancelled',
  'no_show',
] as const;
export type AppointmentStatusDb = (typeof APPOINTMENT_STATUSES)[number];

/** Agendamentos (migração 0007): um paciente por linha; FK compostas amarram tudo à mesma clínica. */
export const appointments = pgTable('appointments', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  patientId: uuid('patient_id').notNull(),
  professionalId: uuid('professional_id').notNull(),
  appointmentTypeId: uuid('appointment_type_id').notNull(),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
  status: text('status', { enum: APPOINTMENT_STATUSES }).notNull().default('scheduled'),
  isWalkIn: boolean('is_walk_in').notNull().default(false),
  checkedInAt: timestamp('checked_in_at', { withTimezone: true }),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  /** Migração 0013: usuário da sessão que criou (imutável). NULL em linhas anteriores à 0013. */
  createdBy: uuid('created_by'),
  /** Migração 0014: último usuário que remarcou (só muda junto com o horário; nunca volta a NULL). */
  rescheduledBy: uuid('rescheduled_by'),
  /** Migração 0014: trava permanente do horário depois de atendimento ou falta (o banco mantém). */
  rescheduleLocked: boolean('reschedule_locked').notNull().default(false),
});

/**
 * Histórico de remarcações (migração 0014): append-only, gravado SÓ pelo trigger de appointments a
 * cada mudança de horário. O runtime lê; não insere, não altera, não apaga.
 */
export const appointmentReschedules = pgTable('appointment_reschedules', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  appointmentId: uuid('appointment_id').notNull(),
  fromStartsAt: timestamp('from_starts_at', { withTimezone: true }).notNull(),
  fromEndsAt: timestamp('from_ends_at', { withTimezone: true }).notNull(),
  toStartsAt: timestamp('to_starts_at', { withTimezone: true }).notNull(),
  toEndsAt: timestamp('to_ends_at', { withTimezone: true }).notNull(),
  rescheduledBy: uuid('rescheduled_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Convênios da clínica (migração 0011, CNV-04.1). Sem regras TISS. */
export const insurers = pgTable('insurers', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  name: text('name').notNull(),
  ansCode: text('ans_code'),
  sessionValueCents: integer('session_value_cents'),
  requiresPassword: boolean('requires_password').notNull().default(false),
  requiresSignature: boolean('requires_signature').notNull().default(false),
  defaultValidityDays: integer('default_validity_days'),
  active: boolean('active').notNull().default(true),
  inactivatedAt: timestamp('inactivated_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Situação gravada de guia e pacote (CHECK da 0011). "Vencida"/"esgotada" são calculadas. */
export const GUIDE_STATUSES = ['active', 'cancelled'] as const;

/**
 * Guias de convênio (migração 0011, CNV-04.2/04.3). Número, senha e carteirinha SÓ cifrados (v1).
 * `usedSessions` é o contador do saldo (CHECK 0 <= usadas <= autorizadas no banco).
 */
export const insuranceGuides = pgTable('insurance_guides', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  patientId: uuid('patient_id').notNull(),
  insurerId: uuid('insurer_id').notNull(),
  numberEnc: text('number_enc').notNull(),
  authorizationCodeEnc: text('authorization_code_enc'),
  cardNumberEnc: text('card_number_enc'),
  authorizedSessions: integer('authorized_sessions').notNull(),
  usedSessions: integer('used_sessions').notNull().default(0),
  issuedOn: date('issued_on', { mode: 'string' }),
  validUntil: date('valid_until', { mode: 'string' }).notNull(),
  status: text('status', { enum: GUIDE_STATUSES }).notNull().default('active'),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Mesmos valores dos CHECK da 0011 (códigos; nunca texto livre). */
export const GUIDE_OVERRIDE_REASONS = ['prorrogacao_da_operadora', 'renovacao_em_andamento', 'decisao_da_clinica'] as const;
export type GuideOverrideReason = (typeof GUIDE_OVERRIDE_REASONS)[number];
export const GUIDE_REVERSAL_REASONS = ['status_corrigido', 'lancamento_errado', 'guia_errada'] as const;
export type GuideReversalReason = (typeof GUIDE_REVERSAL_REASONS)[number];
export const PACKAGE_REVERSAL_REASONS = ['status_corrigido', 'lancamento_errado', 'pacote_errado'] as const;
export type PackageReversalReason = (typeof PACKAGE_REVERSAL_REASONS)[number];

/** Consumo de 1 sessão da guia por agendamento (0011). Estorno marca `reversedAt`, nunca apaga. */
export const guideSessions = pgTable('guide_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  guideId: uuid('guide_id').notNull(),
  appointmentId: uuid('appointment_id').notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }).notNull().defaultNow(),
  consumedBy: uuid('consumed_by').notNull(),
  overrideReason: text('override_reason', { enum: GUIDE_OVERRIDE_REASONS }),
  reversedAt: timestamp('reversed_at', { withTimezone: true }),
  reversedBy: uuid('reversed_by'),
  reversalReason: text('reversal_reason', { enum: GUIDE_REVERSAL_REASONS }),
});

export const SIGNATURE_METHODS = ['tela', 'papel'] as const;
export type SignatureMethod = (typeof SIGNATURE_METHODS)[number];

/** Confirmação do paciente por sessão (0011, CNV-04.4). Append-only: runtime só SELECT/INSERT. */
export const guideSessionSignatures = pgTable('guide_session_signatures', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  guideSessionId: uuid('guide_session_id').notNull(),
  method: text('method', { enum: SIGNATURE_METHODS }).notNull(),
  deviceLabel: text('device_label'),
  signedAt: timestamp('signed_at', { withTimezone: true }).notNull().defaultNow(),
  recordedBy: uuid('recorded_by').notNull(),
  recordHash: text('record_hash').notNull(),
});

/** Pacote particular de sessões com saldo (0011, FIN-01.5). CHECK 0 <= usadas <= total. */
export const sessionPackages = pgTable('session_packages', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  patientId: uuid('patient_id').notNull(),
  appointmentTypeId: uuid('appointment_type_id'),
  name: text('name').notNull(),
  totalSessions: integer('total_sessions').notNull(),
  usedSessions: integer('used_sessions').notNull().default(0),
  validUntil: date('valid_until', { mode: 'string' }),
  status: text('status', { enum: GUIDE_STATUSES }).notNull().default('active'),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Consumo de 1 sessão do pacote por agendamento (0011): o histórico do pacote. */
export const packageSessions = pgTable('package_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  packageId: uuid('package_id').notNull(),
  appointmentId: uuid('appointment_id').notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }).notNull().defaultNow(),
  consumedBy: uuid('consumed_by').notNull(),
  reversedAt: timestamp('reversed_at', { withTimezone: true }),
  reversedBy: uuid('reversed_by'),
  reversalReason: text('reversal_reason', { enum: PACKAGE_REVERSAL_REASONS }),
});

/** Modelos de prontuário (CHECK da 0012). O compartimento deriva do modelo. */
export const RECORD_TEMPLATES = ['fisio', 'to', 'psicologia'] as const;
export type RecordTemplate = (typeof RECORD_TEMPLATES)[number];
export const RECORD_COMPARTMENTS = ['geral', 'psicologia'] as const;
export type RecordCompartment = (typeof RECORD_COMPARTMENTS)[number];
/** Consentimento de IA em 3 estados (RIPD do escriba, R12): `nao_informado` nega. */
export const AI_CONSENT_STATES = ['nao_informado', 'informado_nao_recusou', 'recusou'] as const;
export type AiConsentState = (typeof AI_CONSENT_STATES)[number];
export const ENCOUNTER_STATUSES = ['open', 'signed'] as const;
export type EncounterStatus = (typeof ENCOUNTER_STATUSES)[number];
/** Sigilo do registro de psicologia (pergunta 1.11 do advogado em aberto: configurável). */
export const PSYCH_COMPARTMENT_MODES = ['restrito_ao_autor', 'prontuario_unico'] as const;
export type PsychCompartmentMode = (typeof PSYCH_COMPARTMENT_MODES)[number];

/** Configuração de sigilo do prontuário por clínica (0012). Sem linha = padrão `restrito_ao_autor`. */
export const clinicalSettings = pgTable('clinical_settings', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id),
  psychCompartment: text('psych_compartment', { enum: PSYCH_COMPARTMENT_MODES }).notNull().default('restrito_ao_autor'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by').notNull(),
});

/** Atendimento aberto a partir do agendamento (0012). Finalizado é terminal (trigger). */
export const encounters = pgTable('encounters', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  patientId: uuid('patient_id').notNull(),
  professionalId: uuid('professional_id').notNull(),
  appointmentId: uuid('appointment_id').notNull(),
  authorUserId: uuid('author_user_id').notNull(),
  template: text('template', { enum: RECORD_TEMPLATES }).notNull(),
  compartment: text('compartment', { enum: RECORD_COMPARTMENTS }).notNull(),
  aiConsent: text('ai_consent', { enum: AI_CONSENT_STATES }).notNull().default('nao_informado'),
  status: text('status', { enum: ENCOUNTER_STATUSES }).notNull().default('open'),
  currentVersion: integer('current_version').notNull().default(0),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  signedAt: timestamp('signed_at', { withTimezone: true }),
  signedBy: uuid('signed_by'),
  signedVersion: integer('signed_version'),
  signedHash: text('signed_hash'),
  /**
   * Migração 0015 (B1 do #63): modo de sigilo da psicologia vigente na ABERTURA. A leitura decide por
   * ele, nunca pela configuração atual. Só pode ficar mais restrito (trigger).
   */
  confidentiality: text('confidentiality', { enum: PSYCH_COMPARTMENT_MODES }).notNull().default('restrito_ao_autor'),
});

/** Versões da evolução (0012): append-only; conteúdo JSON SÓ cifrado (v1). */
export const clinicalRecordVersions = pgTable('clinical_record_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  encounterId: uuid('encounter_id').notNull(),
  version: integer('version').notNull(),
  template: text('template', { enum: RECORD_TEMPLATES }).notNull(),
  templateVersion: integer('template_version').notNull(),
  contentEnc: text('content_enc').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by').notNull(),
});

/** Adendos depois da finalização (0012): append-only, texto SÓ cifrado. */
export const clinicalAddenda = pgTable('clinical_addenda', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  encounterId: uuid('encounter_id').notNull(),
  textEnc: text('text_enc').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by').notNull(),
});

/**
 * Custódia da nota privada (0015, D2 do parecer #63): 'ativa'; 'aguardando_decisao' (autor desligado,
 * 30 dias); 'lacrada' (psicologia sem decisão: para o psicólogo substituto, 90 dias); 'guarda_clinica'
 * (o autor marcou para exportar: acompanha o prontuário, ilegível no aplicativo, só no G2).
 */
export const PRIVATE_NOTE_CUSTODY_STATES = ['ativa', 'aguardando_decisao', 'lacrada', 'guarda_clinica'] as const;
export type PrivateNoteCustodyState = (typeof PRIVATE_NOTE_CUSTODY_STATES)[number];

/** Anotações privadas do profissional (0012, HU-PRO-009): fora do prontuário; só o autor lê. */
export const privateNotes = pgTable('private_notes', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  patientId: uuid('patient_id').notNull(),
  authorUserId: uuid('author_user_id').notNull(),
  encounterId: uuid('encounter_id'),
  contentEnc: text('content_enc').notNull(),
  exportConsent: boolean('export_consent').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  discardedAt: timestamp('discarded_at', { withTimezone: true }),
  /** Migração 0015 (D2 do #63): ciclo de vida quando o autor sai da clínica. */
  custodyState: text('custody_state', { enum: PRIVATE_NOTE_CUSTODY_STATES }).notNull().default('ativa'),
  custodyDeadline: timestamp('custody_deadline', { withTimezone: true }),
});

/**
 * Retenção legal do paciente (0017, R12 do #63): referência do processo/ofício cifrada; retirar exige
 * pedido com motivo cifrado e aprovação de OUTRA pessoa (trigger). Espelhada em patients.legal_hold_since.
 */
export const legalHolds = pgTable('legal_holds', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  patientId: uuid('patient_id').notNull(),
  referenceEnc: text('reference_enc').notNull(),
  placedBy: uuid('placed_by').notNull(),
  placedAt: timestamp('placed_at', { withTimezone: true }).notNull().defaultNow(),
  releaseReasonEnc: text('release_reason_enc'),
  releaseRequestedBy: uuid('release_requested_by'),
  releaseRequestedAt: timestamp('release_requested_at', { withTimezone: true }),
  releasedBy: uuid('released_by'),
  releasedAt: timestamp('released_at', { withTimezone: true }),
});

/**
 * Perfis da clínica no banco (0020, R13 do #63): usuário × clínica × perfil. Só admin ativo concede e
 * revoga (fundação: o primeiro admin de uma clínica vazia); nunca se apaga. Os triggers de retenção legal
 * e custódia conferem o perfil aqui. `psicologo` é a qualificação clínica exigida pela custódia.
 */
export const CLINIC_MEMBER_ROLES = ['admin', 'profissional', 'recepcao', 'financeiro', 'psicologo'] as const;
export type ClinicMemberRole = (typeof CLINIC_MEMBER_ROLES)[number];
export const clinicMembers = pgTable('clinic_members', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  userId: uuid('user_id').notNull(),
  role: text('role', { enum: CLINIC_MEMBER_ROLES }).notNull(),
  grantedBy: uuid('granted_by').notNull(),
  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  revokedBy: uuid('revoked_by'),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

/** Custódia das notas lacradas de um psicólogo desligado (0017, R2 do #63): designa o admin, aceita o substituto. */
export const noteCustodies = pgTable('note_custodies', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  authorUserId: uuid('author_user_id').notNull(),
  substituteUserId: uuid('substitute_user_id').notNull(),
  designatedBy: uuid('designated_by').notNull(),
  designatedAt: timestamp('designated_at', { withTimezone: true }).notNull().defaultNow(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
});

/** Caixa de avisos interna (0017, R9 do #63): sem dado de paciente; só o destinatário lê e marca lido. */
export const CLINICAL_NOTICE_KINDS = ['sigilo_psicologia_alterado'] as const;
export const clinicalNotices = pgTable('clinical_notices', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  recipientUserId: uuid('recipient_user_id').notNull(),
  kind: text('kind', { enum: CLINICAL_NOTICE_KINDS }).notNull(),
  fromMode: text('from_mode', { enum: PSYCH_COMPARTMENT_MODES }).notNull(),
  toMode: text('to_mode', { enum: PSYCH_COMPARTMENT_MODES }).notNull(),
  restrictedExisting: integer('restricted_existing').notNull().default(0),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  readAt: timestamp('read_at', { withTimezone: true }),
});

// ---------------------------------------------------------------- financeiro (migração 0018)

/** pf: profissional pessoa física (Receita Saúde); pj: clínica/CNPJ (NFS-e). */
export const ATTENDANCE_KINDS = ['pf', 'pj'] as const;
export type AttendanceKind = (typeof ATTENDANCE_KINDS)[number];
export const CASH_SHIFTS = ['manha', 'tarde', 'noite', 'unico'] as const;
export type CashShift = (typeof CASH_SHIFTS)[number];
export const CASH_SESSION_STATUSES = ['open', 'closed'] as const;
export const CHARGE_STATUSES = ['open', 'cancelled'] as const;
export const CHARGE_CANCEL_REASONS = ['lancamento_errado', 'cortesia', 'atendimento_nao_realizado', 'cobranca_duplicada'] as const;
export type ChargeCancelReason = (typeof CHARGE_CANCEL_REASONS)[number];
/** Formas de pagamento (FIN-01.3). Pix é registrado à mão até o PSP (D5). */
export const PAYMENT_METHODS = ['dinheiro', 'cartao_credito', 'cartao_debito', 'pix_manual', 'transferencia', 'convenio'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const PAYMENT_REVERSAL_REASONS = ['lancamento_errado', 'devolucao_ao_pagador', 'pagamento_nao_compensado', 'forma_errada'] as const;
export type PaymentReversalReason = (typeof PAYMENT_REVERSAL_REASONS)[number];
export const RECEIPT_CANCEL_REASONS = ['dados_incorretos', 'emitido_por_engano', 'recebimento_estornado'] as const;
export type ReceiptCancelReason = (typeof RECEIPT_CANCEL_REASONS)[number];

/** Configuração do financeiro por clínica (0018). Sem linha = padrões (texto "Atendimento", pj). */
export const financeSettings = pgTable('finance_settings', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id),
  receiptDescription: text('receipt_description').notNull().default('Atendimento'),
  defaultAttendanceKind: text('default_attendance_kind', { enum: ATTENDANCE_KINDS }).notNull().default('pj'),
  issuerName: text('issuer_name'),
  issuerCnpj: text('issuer_cnpj'),
  showCouncilOnReceipt: boolean('show_council_on_receipt').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by').notNull(),
});

/** Perfil fiscal do profissional PF (0018): CPF SÓ cifrado e registro no conselho. */
export const professionalFiscalProfiles = pgTable(
  'professional_fiscal_profiles',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    professionalId: uuid('professional_id').notNull(),
    cpfEnc: text('cpf_enc'),
    councilRegistration: text('council_registration'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid('updated_by').notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.professionalId] })],
);

/** Caixa por dia e turno (0018). Fechado é terminal (trigger). */
export const cashSessions = pgTable('cash_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  businessDate: date('business_date', { mode: 'string' }).notNull(),
  shift: text('shift', { enum: CASH_SHIFTS }).notNull(),
  openingFloatCents: integer('opening_float_cents').notNull().default(0),
  status: text('status', { enum: CASH_SESSION_STATUSES }).notNull().default('open'),
  openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  openedBy: uuid('opened_by').notNull(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  closedBy: uuid('closed_by'),
  expectedCashCents: bigint('expected_cash_cents', { mode: 'number' }),
  countedCashCents: bigint('counted_cash_cents', { mode: 'number' }),
});

/** Conta a receber (0018): de UM agendamento OU de UM pacote. CHECK 0 <= pago <= valor. */
export const charges = pgTable('charges', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  patientId: uuid('patient_id').notNull(),
  appointmentId: uuid('appointment_id'),
  packageId: uuid('package_id'),
  professionalId: uuid('professional_id'),
  attendanceKind: text('attendance_kind', { enum: ATTENDANCE_KINDS }).notNull(),
  amountCents: integer('amount_cents').notNull(),
  paidCents: integer('paid_cents').notNull().default(0),
  dueDate: date('due_date', { mode: 'string' }).notNull(),
  payerName: text('payer_name'),
  payerCpfEnc: text('payer_cpf_enc'),
  status: text('status', { enum: CHARGE_STATUSES }).notNull().default('open'),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  cancelledBy: uuid('cancelled_by'),
  cancelReason: text('cancel_reason', { enum: CHARGE_CANCEL_REASONS }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  /** R7 (0021): pagador eliminado pela retenção fiscal (prazo vencido, sem retenção legal). */
  fiscalPurgedAt: timestamp('fiscal_purged_at', { withTimezone: true }),
});

/** Recebimento (0018): append-only, sempre num caixa aberto. */
export const payments = pgTable('payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  chargeId: uuid('charge_id').notNull(),
  cashSessionId: uuid('cash_session_id').notNull(),
  method: text('method', { enum: PAYMENT_METHODS }).notNull(),
  amountCents: integer('amount_cents').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  receivedBy: uuid('received_by').notNull(),
});

/** Estorno total de um recebimento (0018): append-only, no caixa aberto do momento. */
export const paymentReversals = pgTable('payment_reversals', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  paymentId: uuid('payment_id').notNull(),
  cashSessionId: uuid('cash_session_id').notNull(),
  reason: text('reason', { enum: PAYMENT_REVERSAL_REASONS }).notNull(),
  reversedAt: timestamp('reversed_at', { withTimezone: true }).notNull().defaultNow(),
  reversedBy: uuid('reversed_by').notNull(),
});

/** Contador de recibos por clínica (0018): só avança de 1 em 1 (trigger). */
export const receiptCounters = pgTable('receipt_counters', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id),
  lastNumber: bigint('last_number', { mode: 'number' }).notNull(),
});

/** Recibo emitido (0018): append-only; conteúdo = retrato cifrado do momento da emissão. */
export const receipts = pgTable('receipts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  number: bigint('number', { mode: 'number' }).notNull(),
  paymentId: uuid('payment_id').notNull(),
  /** Retrato cifrado; NULL só depois da eliminação pela retenção fiscal (R7, 0021). */
  contentEnc: text('content_enc'),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  issuedBy: uuid('issued_by').notNull(),
  fiscalPurgedAt: timestamp('fiscal_purged_at', { withTimezone: true }),
});

/** Cancelamento de recibo (0018): append-only; um por recibo. */
export const receiptCancellations = pgTable('receipt_cancellations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  receiptId: uuid('receipt_id').notNull(),
  reason: text('reason', { enum: RECEIPT_CANCEL_REASONS }).notNull(),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }).notNull().defaultNow(),
  cancelledBy: uuid('cancelled_by').notNull(),
});

/** Metadados de auditoria: só escalares (contagens, versões, formatos). Nunca conteúdo clínico. */
export type AuditMetadata = Record<string, string | number | boolean | null>;

/** Tipo de ator na trilha (migração 0008). Mesmos valores do CHECK no banco. */
export const ACTOR_KINDS = ['usuario_clinica', 'suporte_plataforma', 'sistema'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

/** Append-only: o runtime só tem SELECT/INSERT; trigger rejeita UPDATE/DELETE/TRUNCATE. */
export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  actorId: uuid('actor_id').notNull(),
  /** NULO só nas linhas anteriores à 0008; toda linha nova tem (CHECK NOT VALID + trigger). */
  actorKind: text('actor_kind', { enum: ACTOR_KINDS }),
  action: text('action').notNull(),
  scope: text('scope').notNull(),
  metadata: jsonb('metadata').$type<AuditMetadata>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Ciclo de vida das chaves (migração 0004). Mesmos valores do CHECK no banco. */
export const KEY_STATUSES = ['active', 'retired', 'destroying', 'destroyed'] as const;
export type KeyStatus = (typeof KEY_STATUSES)[number];

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

/**
 * Chave mestra (KEK) de cada clínica: só a referência (ARN no KMS), nunca material de chave.
 * Sem DELETE para o runtime; UPDATE só em status/destroyed_at (migração 0004).
 */
export const tenantMasterKeys = pgTable('tenant_master_keys', {
  id: text('id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  status: text('status', { enum: KEY_STATUSES }).notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  destroyedAt: timestamp('destroyed_at', { withTimezone: true }),
});

/**
 * Chaves de dados (DEK) cifradas pela KEK da clínica. `wrappedKey` é NULL só quando `destroyed`.
 * O acesso real passa por PgDataKeyStore (src/modules/crypto/data-key-store.ts).
 */
export const tenantDataKeys = pgTable(
  'tenant_data_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    masterKeyId: text('master_key_id').notNull(),
    wrappedKey: bytea('wrapped_key'),
    status: text('status', { enum: KEY_STATUSES }).notNull().default('active'),
    encryptCount: bigint('encrypt_count', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    destroyedAt: timestamp('destroyed_at', { withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: 'tenant_data_keys_master_fk',
      columns: [t.masterKeyId, t.tenantId],
      foreignColumns: [tenantMasterKeys.id, tenantMasterKeys.tenantId],
    }),
  ],
);

export const schema = {
  tenants,
  patients,
  auditLog,
  tenantMasterKeys,
  tenantDataKeys,
  professionals,
  appointmentTypes,
  appointments,
  insurers,
  insuranceGuides,
  guideSessions,
  guideSessionSignatures,
  sessionPackages,
  packageSessions,
  clinicalSettings,
  encounters,
  clinicalRecordVersions,
  clinicalAddenda,
  privateNotes,
  appointmentReschedules,
  legalHolds,
  noteCustodies,
  clinicalNotices,
  financeSettings,
  professionalFiscalProfiles,
  cashSessions,
  charges,
  payments,
  paymentReversals,
  receiptCounters,
  receipts,
  receiptCancellations,
};
