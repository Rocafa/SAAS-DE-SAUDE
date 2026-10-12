import { bigint, customType, foreignKey, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

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
});

export const patients = pgTable('patients', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  displayName: text('display_name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Metadados de auditoria: só escalares (contagens, versões, formatos). Nunca conteúdo clínico. */
export type AuditMetadata = Record<string, string | number | boolean | null>;

/** Append-only: o runtime só tem SELECT/INSERT; trigger rejeita UPDATE/DELETE/TRUNCATE. */
export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id')
    .notNull()
    .references(() => tenants.id),
  actorId: uuid('actor_id').notNull(),
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

export const schema = { tenants, patients, auditLog, tenantMasterKeys, tenantDataKeys };
