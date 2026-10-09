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
 * Usa `app_set_tenant($1)` (migração 0003): grava o tenant numa tabela inacessível ao runtime,
 * chaveada pelo ID da transação, e as policies leem dali. O contexto vale só para esta transação
 * (não vaza para a próxima requisição na mesma conexão do pool) e fica TRAVADO: trocar para outro
 * tenant no meio dela (set_config/SET LOCAL/nova chamada) não tem efeito ou é recusado.
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
    await tx.execute(sql`select app_set_tenant(${tenantId}::uuid)`);
    return fn(tx);
  });
}
