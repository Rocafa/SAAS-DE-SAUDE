import { bigint, boolean, customType, foreignKey, integer, jsonb, pgTable, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core';

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
};
