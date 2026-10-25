import { bigint, boolean, customType, date, foreignKey, integer, jsonb, pgTable, primaryKey, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

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
  /** Migração 0022 (R15 do #63): quem fundou a clínica (registrado na criação; imutável para o runtime). */
  founderUserId: uuid('founder_user_id'),
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
  /** Migração 0031 (A3 do #67): emancipação (CC art. 5º, par. único) — data, documento cifrado, autor; imutável. */
  emancipatedOn: date('emancipated_on'),
  emancipationRefEnc: text('emancipation_ref_enc'),
  emancipationRecordedBy: uuid('emancipation_recorded_by'),
  emancipationRecordedAt: timestamp('emancipation_recorded_at', { withTimezone: true }),
  /** Migração 0026 (V1 do importador): lote que criou o paciente; gravado só no INSERT, imutável. */
  importBatchId: uuid('import_batch_id'),
  /** Migração 0046 (R9 do importador): índice cego do CPF (HMAC com a chave de índice da clínica) e a versão da chave. */
  cpfBidx: text('cpf_bidx'),
  cpfBidxVersion: smallint('cpf_bidx_version'),
});

/**
 * Chave de índice cego do CPF por clínica (0046, R9): 32 bytes aleatórios SÓ cifrados pela chave da clínica
 * (FieldCipher/KMS). Uma ativa; a trocada fica `retired` até a reindexação e então `destroyed` (key_enc nula).
 */
export const PATIENT_CPF_INDEX_KEY_STATUSES = ['active', 'retired', 'destroyed'] as const;
export const patientCpfIndexKeys = pgTable(
  'patient_cpf_index_keys',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    version: smallint('version').notNull(),
    keyEnc: text('key_enc'),
    status: text('status', { enum: PATIENT_CPF_INDEX_KEY_STATUSES }).notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
    destroyedAt: timestamp('destroyed_at', { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.version] })],
);

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
  /** 0033 (R2 do #68): área sensível (psicologia, psiquiatria, saúde mental) marcada pela clínica; a especialidade só reforça. */
  sensitiveArea: boolean('sensitive_area').notNull().default(false),
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
  /** Migração 0026 (V1 do importador): lote que criou o agendamento; gravado só no INSERT, imutável. */
  importBatchId: uuid('import_batch_id'),
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
  /** 0023 (R13 do #65): profissional fixado na venda; consumo e cobrança seguem ele. Troca só registrada. */
  professionalId: uuid('professional_id'),
});

/** Motivos da troca do profissional do pacote (0023). */
export const PACKAGE_PROFESSIONAL_CHANGE_REASONS = ['profissional_desligado', 'pedido_do_paciente', 'lancamento_errado', 'fixar_pacote_antigo'] as const;
export type PackageProfessionalChangeReason = (typeof PACKAGE_PROFESSIONAL_CHANGE_REASONS)[number];

/** Registro explícito (append-only) de cada troca do profissional do pacote (0023, R13 do #65). */
export const packageProfessionalChanges = pgTable('package_professional_changes', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  packageId: uuid('package_id').notNull(),
  fromProfessionalId: uuid('from_professional_id'),
  toProfessionalId: uuid('to_professional_id').notNull(),
  reason: text('reason', { enum: PACKAGE_PROFESSIONAL_CHANGE_REASONS }).notNull(),
  changedBy: uuid('changed_by').notNull(),
  changedAt: timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
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
/** 0022 (R13/R15 do #63): avisos aos demais admins (perfil alterado, retirada de retenção pedida/aprovada). */
export const CLINICAL_NOTICE_KINDS = [
  'sigilo_psicologia_alterado',
  'perfil_alterado',
  'retencao_retirada_pedida',
  'retencao_retirada_aprovada',
  // 0033 (A3b do #68): pedido do titular aberto no portal; leva só o id do pedido.
  'pedido_titular_aberto',
  // 0039 (N1 do #73): o recálculo desligou o sigilo do adolescente ou estendeu a representação além dos 18;
  // 0050 (R3 do #68): o titular passou a constar menor e perdeu o acesso (`titular_menor_revogado`).
  'portal_sigilo_transicao',
] as const;
export type ClinicalNoticeKind = (typeof CLINICAL_NOTICE_KINDS)[number];
export const PORTAL_SIGILO_TRANSICOES = ['sigilo_desligado', 'representacao_estendida', 'titular_menor_revogado'] as const;
export type PortalSigiloTransicao = (typeof PORTAL_SIGILO_TRANSICOES)[number];
export const clinicalNotices = pgTable('clinical_notices', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  recipientUserId: uuid('recipient_user_id').notNull(),
  kind: text('kind', { enum: CLINICAL_NOTICE_KINDS }).notNull(),
  fromMode: text('from_mode', { enum: PSYCH_COMPARTMENT_MODES }),
  toMode: text('to_mode', { enum: PSYCH_COMPARTMENT_MODES }),
  subjectUserId: uuid('subject_user_id'),
  subjectRole: text('subject_role', { enum: CLINIC_MEMBER_ROLES }),
  change: text('change', { enum: ['concedido', 'revogado'] as const }),
  legalHoldId: uuid('legal_hold_id'),
  rightsRequestId: uuid('rights_request_id'),
  patientId: uuid('patient_id'),
  portalTransition: text('portal_transition', { enum: PORTAL_SIGILO_TRANSICOES }),
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
  /**
   * Migração 0031 (V1 do #67): pagador do cadastro CONGELADO no recebimento — o vínculo e o retrato
   * cifrado (nome + CPF). Recibo tardio e Receita Saúde usam só isto; o retrato sai na retenção fiscal.
   */
  guardianPayerLinkId: uuid('guardian_payer_link_id'),
  guardianPayerEnc: text('guardian_payer_enc'),
  guardianPayerPurgedAt: timestamp('guardian_payer_purged_at', { withTimezone: true }),
  /** 0034 (R2 do 2º parecer do #67): saneamento único do pagador pelo financeiro (quem e quando, pelo banco). */
  guardianPayerResolvedBy: uuid('guardian_payer_resolved_by'),
  guardianPayerResolvedAt: timestamp('guardian_payer_resolved_at', { withTimezone: true }),
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

// ---------------------------------------------------------------- importador (migração 0024)

export const IMPORT_KINDS = ['pacientes', 'agenda'] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];
export const IMPORT_STATUSES = ['recebido', 'validado', 'simulado', 'aplicado', 'desfeito', 'expirado'] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];
export const IMPORT_ISSUE_SEVERITIES = ['erro', 'aviso'] as const;
export const IMPORT_ENTITIES = ['patient', 'appointment'] as const;

/** Lote de importação com o aceite do termo de migração (0024). Sem DELETE para o runtime. */
export const importBatches = pgTable('import_batches', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  kind: text('kind', { enum: IMPORT_KINDS }).notNull(),
  status: text('status', { enum: IMPORT_STATUSES }).notNull().default('recebido'),
  termVersion: text('term_version').notNull(),
  termAcceptedBy: uuid('term_accepted_by').notNull(),
  termAcceptedAt: timestamp('term_accepted_at', { withTimezone: true }).notNull().defaultNow(),
  /** 0026 (R4): SHA-256 do TEXTO do termo aceito (docs/03-seguranca-lgpd/termo-migracao.md); imutável. */
  termSha256: text('term_sha256'),
  fileFormat: text('file_format', { enum: ['csv'] }).notNull().default('csv'),
  byteSize: integer('byte_size').notNull(),
  rowCount: integer('row_count').notNull(),
  columnCount: smallint('column_count').notNull(),
  /** {campo: índice da coluna}; nunca o texto do cabeçalho. */
  columnMapping: jsonb('column_mapping').$type<Record<string, number>>(),
  currentRun: smallint('current_run').notNull().default(0),
  validRows: integer('valid_rows'),
  errorRows: integer('error_rows'),
  warningCount: integer('warning_count'),
  plannedCreates: integer('planned_creates'),
  plannedSkips: integer('planned_skips'),
  simulationHash: text('simulation_hash'),
  createdRecords: integer('created_records'),
  rawExpiresAt: timestamp('raw_expires_at', { withTimezone: true }).notNull(),
  rawDiscardedAt: timestamp('raw_discarded_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  validatedAt: timestamp('validated_at', { withTimezone: true }),
  simulatedAt: timestamp('simulated_at', { withTimezone: true }),
  appliedAt: timestamp('applied_at', { withTimezone: true }),
  appliedBy: uuid('applied_by'),
  undoneAt: timestamp('undone_at', { withTimezone: true }),
  undoneBy: uuid('undone_by'),
  expiredAt: timestamp('expired_at', { withTimezone: true }),
  /** 0026 (R6): confirmação da clínica de origem no aplicar (quem e quando); imutável. */
  originConfirmedAt: timestamp('origin_confirmed_at', { withTimezone: true }),
  originConfirmedBy: uuid('origin_confirmed_by'),
});

/** Arquivo bruto SÓ cifrado, expira em ≤ 7 dias; runtime só SELECT/INSERT; descarte pela função (0024). */
export const importRawFiles = pgTable('import_raw_files', {
  batchId: uuid('batch_id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  contentEnc: text('content_enc').notNull(),
  sha256: text('sha256').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * R3 do importador (0046): chave PRÓPRIA do lote (chave mestra no provedor + DEK embrulhada). O descarte
 * apaga a DEK embrulhada e destrói a chave mestra: o bruto fica ilegível em qualquer cópia, inclusive backup.
 * Runtime: só SELECT/INSERT; o ciclo de vida anda pelas funções do expurgo.
 */
export const IMPORT_BATCH_KEY_STATUSES = ['active', 'destroying', 'destroyed'] as const;
export const importBatchKeys = pgTable('import_batch_keys', {
  batchId: uuid('batch_id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  masterKeyId: text('master_key_id').notNull(),
  wrappedKey: bytea('wrapped_key'),
  status: text('status', { enum: IMPORT_BATCH_KEY_STATUSES }).notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  discardedAt: timestamp('discarded_at', { withTimezone: true }),
  destroyedAt: timestamp('destroyed_at', { withTimezone: true }),
});

/**
 * Intenção da chave de lote (0049, observação 1 da conferência R3-a/R3-b): registrada ANTES de o KMS criar a
 * chave, com o ARN logo depois, para nenhuma chave ficar órfã se o `receber` falhar. Runtime: só
 * SELECT/INSERT; anda pelas funções `app_record_import_batch_key_intent`/`app_close_import_batch_key_intent`.
 */
export const IMPORT_BATCH_KEY_INTENT_STATUSES = ['pending', 'committed', 'destroyed', 'abandoned'] as const;
export const importBatchKeyIntents = pgTable('import_batch_key_intents', {
  batchId: uuid('batch_id').primaryKey(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  masterKeyId: text('master_key_id'),
  status: text('status', { enum: IMPORT_BATCH_KEY_INTENT_STATUSES }).notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
});

/** Divergências por linha: só códigos, nunca o valor (0024). */
export const importIssues = pgTable(
  'import_issues',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    batchId: uuid('batch_id').notNull(),
    run: smallint('run').notNull(),
    lineNumber: integer('line_number').notNull(),
    field: text('field').notNull(),
    code: text('code').notNull(),
    severity: text('severity', { enum: IMPORT_ISSUE_SEVERITIES }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.batchId, t.run, t.lineNumber, t.field, t.code] })],
);

/** Livro do lote: o que cada importação criou (desfazer e proveniência), append-only (0024). */
export const importBatchRecords = pgTable(
  'import_batch_records',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    batchId: uuid('batch_id').notNull(),
    entity: text('entity', { enum: IMPORT_ENTITIES }).notNull(),
    recordId: uuid('record_id').notNull(),
    lineNumber: integer('line_number').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.entity, t.recordId] })],
);

/** Metadados de auditoria: só escalares (contagens, versões, formatos). Nunca conteúdo clínico. */
export type AuditMetadata = Record<string, string | number | boolean | null>;

/** Tipo de ator na trilha (migração 0008; `paciente_portal` desde a 0027). Mesmos valores do CHECK no banco. */
export const ACTOR_KINDS = ['usuario_clinica', 'suporte_plataforma', 'sistema', 'paciente_portal'] as const;
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

/** Portal do paciente (migração 0027). `acting_as`: a conta age como o titular ou como responsável legal. */
export const PORTAL_ACTING_AS = ['titular', 'responsavel_legal'] as const;
export type PortalActingAs = (typeof PORTAL_ACTING_AS)[number];
/** Motivos que a CLÍNICA usa ao revogar. */
export const PORTAL_LINK_REVOKE_REASONS = ['pedido_do_paciente', 'acesso_indevido', 'fim_do_vinculo', 'erro_de_cadastro'] as const;
export type PortalLinkRevokeReason = (typeof PORTAL_LINK_REVOKE_REASONS)[number];
/** Motivos que só o banco grava: 0033 (V1 do #68, fim da representação do responsável, job) e 0050 (R3 do #68, titular que passa a constar menor: correção do nascimento ou job). */
export const PORTAL_LINK_SYSTEM_REVOKE_REASONS = ['maioridade_do_titular', 'fim_da_representacao', 'titular_menor_de_idade'] as const;
export const PORTAL_CONSENT_PURPOSES = ['lembretes_whatsapp', 'escriba_ia', 'pesquisa'] as const;
export type PortalConsentPurpose = (typeof PORTAL_CONSENT_PURPOSES)[number];
export const PORTAL_CONSENT_RESPONSES = ['sim', 'nao', 'desfeito'] as const;
export type PortalConsentResponse = (typeof PORTAL_CONSENT_RESPONSES)[number];
/** LGPD art. 18: II acesso, III correção, V portabilidade, VI eliminação, VII compartilhamento. */
export const RIGHTS_REQUEST_KINDS = ['acesso', 'correcao', 'portabilidade', 'eliminacao', 'compartilhamento'] as const;
export type RightsRequestKind = (typeof RIGHTS_REQUEST_KINDS)[number];
export const RIGHTS_REQUEST_STATUSES = ['aberta', 'em_andamento', 'atendida', 'recusada'] as const;
export type RightsRequestStatus = (typeof RIGHTS_REQUEST_STATUSES)[number];

/** Convite da clínica para o portal (0027): só o SHA-256 do token de uso único; validade ≤ 7 dias. */
export const portalInvites = pgTable('portal_invites', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  patientId: uuid('patient_id').notNull(),
  tokenHash: text('token_hash').notNull(),
  actingAs: text('acting_as', { enum: PORTAL_ACTING_AS }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  redeemedAt: timestamp('redeemed_at', { withTimezone: true }),
  redeemedAccountId: uuid('redeemed_account_id'),
  linkId: uuid('link_id'),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedBy: uuid('revoked_by'),
  /** 0033 (V1): vínculo de responsável da 0028, a pessoa e o fim da representação (null na curatela). */
  guardianLinkId: uuid('guardian_link_id'),
  guardianId: uuid('guardian_id'),
  representUntil: date('represent_until'),
  /** 0033: a partir de quando vale o sigilo do adolescente (em claro; dia dos 12 anos; curatela = dia do convite). */
  confidentialFrom: date('confidential_from'),
});

/** Vínculo conta do portal ↔ paciente ↔ clínica (0027): nasce só do resgate; a clínica revoga. */
export const portalLinks = pgTable('portal_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  accountId: uuid('account_id').notNull(),
  patientId: uuid('patient_id').notNull(),
  inviteId: uuid('invite_id').notNull(),
  actingAs: text('acting_as', { enum: PORTAL_ACTING_AS }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedBy: uuid('revoked_by'),
  revokeReason: text('revoke_reason', { enum: [...PORTAL_LINK_REVOKE_REASONS, ...PORTAL_LINK_SYSTEM_REVOKE_REASONS] }),
  guardianLinkId: uuid('guardian_link_id'),
  guardianId: uuid('guardian_id'),
  representUntil: date('represent_until'),
  confidentialFrom: date('confidential_from'),
});

/** Consentimento como histórico (0027, R15 do front-r8): append-only; o estado é o último evento. */
export const portalConsents = pgTable('portal_consents', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  patientId: uuid('patient_id').notNull(),
  linkId: uuid('link_id').notNull(),
  accountId: uuid('account_id').notNull(),
  purpose: text('purpose', { enum: PORTAL_CONSENT_PURPOSES }).notNull(),
  response: text('response', { enum: PORTAL_CONSENT_RESPONSES }).notNull(),
  actingAs: text('acting_as', { enum: PORTAL_ACTING_AS }).notNull(),
  textVersion: text('text_version').notNull(),
  textHash: text('text_hash').notNull(),
  channel: text('channel', { enum: ['portal'] }).notNull().default('portal'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /** 0033 (V1): qual responsável agiu e até quando a representação valia (gatilho, a partir do vínculo). */
  guardianId: uuid('guardian_id'),
  representUntil: date('represent_until'),
  /** 0033 (R4): o vínculo da 0028 que representava (o evento vale só enquanto ele estiver vigente). */
  guardianLinkId: uuid('guardian_link_id'),
  /** 0033 (R4): quando o job encerrou o evento porque o vínculo do responsável acabou. */
  representationEndedAt: timestamp('representation_ended_at', { withTimezone: true }),
});

/** Pedido do titular (0027, LGPD art. 18): registrado para a clínica atender; detalhe e resposta cifrados. */
export const portalRightsRequests = pgTable('portal_rights_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  patientId: uuid('patient_id').notNull(),
  linkId: uuid('link_id').notNull(),
  accountId: uuid('account_id').notNull(),
  kind: text('kind', { enum: RIGHTS_REQUEST_KINDS }).notNull(),
  actingAs: text('acting_as', { enum: PORTAL_ACTING_AS }).notNull(),
  protocol: text('protocol').notNull(),
  detailEnc: text('detail_enc'),
  status: text('status', { enum: RIGHTS_REQUEST_STATUSES }).notNull().default('aberta'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  /** Prazo de resposta: criação + 15 dias, posto pelo banco. */
  dueAt: timestamp('due_at', { withTimezone: true }).notNull().default(sql`now() + interval '15 days'`),
  handledBy: uuid('handled_by'),
  handledAt: timestamp('handled_at', { withTimezone: true }),
  answerEnc: text('answer_enc'),
  /** 0033 (V1): qual responsável abriu (gatilho, a partir do vínculo). */
  guardianId: uuid('guardian_id'),
  /** 0051 (C1 de 24/10): data de nascimento proposta no pedido de correção (cifrada; só em `correcao`). */
  birthDateProposedEnc: text('birth_date_proposed_enc'),
  /** 0051: quem da clínica conferiu o documento da data proposta, e quando (uma vez; imutável). */
  documentCheckedBy: uuid('document_checked_by'),
  documentCheckedAt: timestamp('document_checked_at', { withTimezone: true }),
  /**
   * 0052 (C1-b′): a correção de nascimento exige documento conferido? Decidido NA ABERTURA, contra a data
   * vigente naquele momento; imutável. Omitido na gravação: o gatilho preenche (falha fechada).
   */
  documentRequired: boolean('document_required').notNull().default(sql`null`),
});

/** Responsáveis do paciente (migração 0028). Valores no mesmo CHECK do banco. */
export const GUARDIAN_KINDS = ['pai_mae', 'tutor', 'curador', 'representante'] as const;
export type GuardianKind = (typeof GUARDIAN_KINDS)[number];
export const GUARDIAN_END_REASONS = [
  'maioridade',
  'fim_da_representacao',
  'decisao_judicial',
  'substituido',
  'cadastro_errado',
  'pedido_do_titular',
  'emancipacao',
] as const;
export type GuardianEndReason = (typeof GUARDIAN_END_REASONS)[number];
export const GUARDIAN_HISTORY_EVENTS = [
  'responsavel_criado',
  'responsavel_alterado',
  'responsavel_descartado',
  'vinculo_criado',
  'vinculo_alterado',
  'vinculo_encerrado',
] as const;

/** A pessoa responsável (0028): nome, CPF e telefone SÓ cifrados (chave da clínica). */
export const guardians = pgTable('guardians', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  /** NULL só depois do descarte (0031: cadastro errado com o prazo vencido). */
  nameEnc: text('name_enc'),
  cpfEnc: text('cpf_enc'),
  phoneEnc: text('phone_enc'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by').notNull(),
  discardedAt: timestamp('discarded_at', { withTimezone: true }),
  /** 0048: marca imutável do lote de importação que CRIOU a pessoa (pessoa que já existia não a tem). */
  importBatchId: uuid('import_batch_id'),
});

/** Vínculo responsável ↔ paciente (0028). Vigência [validFrom, validUntil), validUntil exclusivo. */
export const patientGuardians = pgTable('patient_guardians', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  patientId: uuid('patient_id').notNull(),
  guardianId: uuid('guardian_id').notNull(),
  kind: text('kind', { enum: GUARDIAN_KINDS }).notNull(),
  isPayer: boolean('is_payer').notNull().default(false),
  receivesClinicalInfo: boolean('receives_clinical_info').notNull().default(false),
  validFrom: date('valid_from').notNull(),
  validUntil: date('valid_until'),
  endReason: text('end_reason', { enum: GUARDIAN_END_REASONS }),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  endedBy: uuid('ended_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by').notNull(),
  // 0031 (parecer do #67): decisão do PROFISSIONAL sobre a informação clínica (autor/data pelo banco).
  clinicalInfoDecidedBy: uuid('clinical_info_decided_by'),
  clinicalInfoDecidedAt: timestamp('clinical_info_decided_at', { withTimezone: true }),
  clinicalInfoBasisEnc: text('clinical_info_basis_enc'),
  /** Curatela: referência da decisão judicial e escopo, cifrados e imutáveis. */
  courtDecisionRefEnc: text('court_decision_ref_enc'),
  curatorshipScopeEnc: text('curatorship_scope_enc'),
  /** Paciente adulto ciente de que um terceiro é o pagador (autor/data pelo banco). */
  payerPatientAwareBy: uuid('payer_patient_aware_by'),
  payerPatientAwareAt: timestamp('payer_patient_aware_at', { withTimezone: true }),
  /** Anulação (cadastro errado): motivo cifrado e prazo para o descarte da pessoa. */
  annulReasonEnc: text('annul_reason_enc'),
  discardAfter: date('discard_after'),
  /** 0034 (A4 do #67): eliminado com o prontuário do paciente, vencida a guarda de 20 anos. */
  eliminatedAt: timestamp('eliminated_at', { withTimezone: true }),
  /** 0048: marca imutável do lote de importação que criou o vínculo (só INSERT, só pelo lote em aplicação). */
  importBatchId: uuid('import_batch_id'),
});

/** Histórico append-only dos responsáveis (0028), gravado só pelos triggers. */
export const patientGuardianHistory = pgTable('patient_guardian_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Identidade gerada pelo banco: ordem dos eventos (mesma transação = mesmo now()). */
  seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  guardianId: uuid('guardian_id').notNull(),
  linkId: uuid('link_id'),
  event: text('event', { enum: GUARDIAN_HISTORY_EVENTS }).notNull(),
  changedFields: text('changed_fields').notNull().default(''),
  prevNameEnc: text('prev_name_enc'),
  prevCpfEnc: text('prev_cpf_enc'),
  prevPhoneEnc: text('prev_phone_enc'),
  kind: text('kind', { enum: GUARDIAN_KINDS }),
  isPayer: boolean('is_payer'),
  receivesClinicalInfo: boolean('receives_clinical_info'),
  validFrom: date('valid_from'),
  validUntil: date('valid_until'),
  endReason: text('end_reason', { enum: GUARDIAN_END_REASONS }),
  actorId: uuid('actor_id').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
});

/** WhatsApp (migração 0032, rodada 18.3): canal da clínica, desligado por padrão, remetente neutro. */
export const whatsappSettings = pgTable('whatsapp_settings', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id),
  enabled: boolean('enabled').notNull().default(false),
  senderName: text('sender_name'),
  businessNumberId: text('business_number_id'),
  reminderHoursBefore: smallint('reminder_hours_before').notNull().default(24),
  sendFromHour: smallint('send_from_hour').notNull().default(8),
  sendUntilHour: smallint('send_until_hour').notNull().default(20),
  replyWindowHours: smallint('reply_window_hours').notNull().default(48),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by').notNull(),
});

export const WHATSAPP_RECIPIENT_KINDS = ['paciente', 'responsavel'] as const;
export const WHATSAPP_OPT_IN_METHODS = ['verbal_na_recepcao', 'formulario_assinado', 'portal_do_paciente'] as const;
export const WHATSAPP_REVOKE_METHODS = [
  'pedido_na_recepcao',
  'resposta_sair',
  'portal_do_paciente',
  'troca_de_destinatario',
  'numero_mudou',
  'eliminacao_do_titular',
] as const;
export const WHATSAPP_OUTBOX_STATUSES = ['agendado', 'enviando', 'enviado', 'entregue', 'lido', 'falhou', 'cancelado'] as const;
export type WhatsappOutboxStatus = (typeof WHATSAPP_OUTBOX_STATUSES)[number];
export const WHATSAPP_INTERPRETATIONS = ['confirmar', 'cancelar', 'sair', 'outro'] as const;
export const WHATSAPP_OUTCOMES = [
  'confirmado',
  'cancelado',
  'ja_estava',
  'fora_da_janela',
  'consulta_alterada',
  'status_nao_permite',
  'sem_envio',
  'opt_out',
  'sem_acao',
] as const;
export type WhatsappOutcome = (typeof WHATSAPP_OUTCOMES)[number];

/** Chave da clínica (cifrada) para o HMAC de comparação de número (0032, V1 do parecer #69). Só INSERT. */
export const whatsappPhoneKeys = pgTable('whatsapp_phone_keys', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id),
  keyEnc: text('key_enc').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Opt-in com prova (0032): quem registrou, como, quando, o NÚMERO que consentiu; revogação única. */
export const whatsappOptIns = pgTable('whatsapp_opt_ins', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  patientId: uuid('patient_id').notNull(),
  recipientKind: text('recipient_kind', { enum: WHATSAPP_RECIPIENT_KINDS }).notNull(),
  guardianId: uuid('guardian_id'),
  purpose: text('purpose', { enum: ['lembrete_consulta'] }).notNull().default('lembrete_consulta'),
  method: text('method', { enum: WHATSAPP_OPT_IN_METHODS }).notNull(),
  /** Comprovante (obrigatório, R7 do #69), cifrado. */
  evidenceEnc: text('evidence_enc').notNull(),
  /** Número que consentiu (V1): cifrado e com o HMAC da clínica para comparar. */
  /** Nulos só depois da eliminação do paciente (0037, N3 do 2º parecer do #69), com `phonePurgedAt`. */
  recipientPhoneEnc: text('recipient_phone_enc'),
  recipientPhoneHash: text('recipient_phone_hash'),
  phonePurgedAt: timestamp('phone_purged_at', { withTimezone: true }),
  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  grantedBy: uuid('granted_by').notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedBy: uuid('revoked_by'),
  revokeMethod: text('revoke_method', { enum: WHATSAPP_REVOKE_METHODS }),
});

/** Fila de envios (0032). Conteúdo cifrado e com retenção de 30 dias. */
export const whatsappOutbox = pgTable('whatsapp_outbox', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  appointmentId: uuid('appointment_id').notNull(),
  appointmentStartsAt: timestamp('appointment_starts_at', { withTimezone: true }).notNull(),
  patientId: uuid('patient_id').notNull(),
  optInId: uuid('opt_in_id').notNull(),
  /** Modelo da plataforma (nome na Meta), da lista fechada (V3 do parecer #69). */
  templateName: text('template_name').notNull(),
  kind: text('kind', { enum: ['lembrete_consulta'] }).notNull().default('lembrete_consulta'),
  recipientKind: text('recipient_kind', { enum: WHATSAPP_RECIPIENT_KINDS }).notNull(),
  guardianId: uuid('guardian_id'),
  recipientPhoneEnc: text('recipient_phone_enc'),
  /** HMAC do número de destino; o banco exige que seja o do opt-in (V1). */
  recipientPhoneHash: text('recipient_phone_hash').notNull(),
  bodyEnc: text('body_enc'),
  status: text('status', { enum: WHATSAPP_OUTBOX_STATUSES }).notNull().default('agendado'),
  attempts: smallint('attempts').notNull().default(0),
  providerMessageId: text('provider_message_id'),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  readAt: timestamp('read_at', { withTimezone: true }),
  failedAt: timestamp('failed_at', { withTimezone: true }),
  /** Reserva para envio (agendado -> enviando); presa > 24 h, a retenção encerra como falhou (R2). */
  dispatchStartedAt: timestamp('dispatch_started_at', { withTimezone: true }),
  failureCode: text('failure_code'),
  needsFallback: boolean('needs_fallback').notNull().default(false),
  contentPurgedAt: timestamp('content_purged_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy: uuid('created_by'),
});

/** Respostas recebidas (0032): só o webhook (sistema) grava; só metadado, sem texto nem número (R1 do #69). */
export const whatsappInbound = pgTable('whatsapp_inbound', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  providerMessageId: text('provider_message_id').notNull(),
  outboxId: uuid('outbox_id'),
  interpretation: text('interpretation', { enum: WHATSAPP_INTERPRETATIONS }).notNull(),
  outcome: text('outcome', { enum: WHATSAPP_OUTCOMES }).notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
});

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
  guardians,
  patientGuardians,
  patientGuardianHistory,
  importBatches,
  importRawFiles,
  importBatchKeys,
  importBatchKeyIntents,
  patientCpfIndexKeys,
  importIssues,
  importBatchRecords,
  whatsappSettings,
  whatsappPhoneKeys,
  whatsappOptIns,
  whatsappOutbox,
  whatsappInbound,
};
