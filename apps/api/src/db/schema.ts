import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Espelho tipado das tabelas criadas em db/migrations/*.sql.
 * A fonte da verdade do DDL (RLS, policies, grants) são as migrações SQL revisáveis.
 */
export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  displayName: text('display_name').notNull(),
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

export const schema = { tenants, patients };
