import type { TenantId } from '@plataforma/shared';
import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { schema } from './schema';

export type Database = PostgresJsDatabase<typeof schema>;
export type TenantTx = Parameters<Parameters<Database['transaction']>[0]>[0];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isTenantId(value: unknown): value is TenantId {
  return typeof value === 'string' && UUID_RE.test(value);
}

export interface DatabaseHandle {
  readonly db: Database;
  close(): Promise<void>;
}

/**
 * Cria o cliente do banco. Deve receber a URL do papel de RUNTIME (app_user: sem BYPASSRLS,
 * não dono das tabelas). A URL vem do ambiente/Secrets Manager — nunca do código.
 */
export function createDatabase(url: string, options: { max?: number } = {}): DatabaseHandle {
  const client = postgres(url, { max: options.max ?? 10, onnotice: () => undefined });
  return {
    db: drizzle(client, { schema }),
    close: () => client.end({ timeout: 5 }),
  };
}

/**
 * Executa `fn` dentro de uma transação com o contexto do tenant definido.
 *
 * Usa `set_config('app.tenant_id', $1, true)`, que é o equivalente parametrizado de
 * `SET LOCAL app.tenant_id = ...` (SET não aceita bind parameter). O `true` (is_local)
 * garante escopo de transação: o valor some no COMMIT/ROLLBACK e não vaza para a próxima
 * requisição que reutilizar a conexão do pool.
 *
 * Isto é a segunda camada (RLS). Repositórios continuam filtrando por tenant_id explicitamente.
 */
export async function withTenant<T>(
  db: Database,
  tenantId: TenantId,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  if (!isTenantId(tenantId)) {
    // Falha fechada: nunca abre transação com contexto inválido.
    throw new Error('tenant_id inválido: esperado UUID');
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}
