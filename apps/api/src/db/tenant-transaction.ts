import type { TenantId } from '@plataforma/shared';
import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { PoolExhaustedError, TransactionTimeoutError } from './db-errors';
import { DEFAULT_DATABASE_TUNING, type DatabaseTuning } from './pool-config';
import { schema } from './schema';

export type Database = PostgresJsDatabase<typeof schema>;
export type TenantTx = Parameters<Parameters<Database['transaction']>[0]>[0];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isTenantId(value: unknown): value is TenantId {
  return typeof value === 'string' && UUID_RE.test(value);
}

export interface DatabaseHandle {
  readonly db: Database;
  readonly tuning: DatabaseTuning;
  close(): Promise<void>;
}

/**
 * Cria o cliente do banco. Deve receber a URL do papel de RUNTIME (app_user: sem BYPASSRLS,
 * não dono das tabelas). A URL vem do ambiente/Secrets Manager — nunca do código.
 *
 * Robustez (ver docs/04-arquitetura/testes-de-producao.md):
 * - `statement_timeout` e `idle_in_transaction_session_timeout` vão no pacote de startup de
 *   CADA conexão: o próprio Postgres cancela query lenta / encerra transação esquecida.
 * - `connect_timeout` evita espera indefinida quando o banco não responde.
 * - Transações esperam no máximo `acquireTimeoutMs` por vaga no pool; depois falham com
 *   PoolExhaustedError (503) em vez de enfileirar para sempre.
 * - postgres.js reconecta sozinho na próxima query depois que o banco volta (sem reiniciar a API).
 */
export function createDatabase(url: string, options: Partial<DatabaseTuning> = {}): DatabaseHandle {
  const tuning: DatabaseTuning = { ...DEFAULT_DATABASE_TUNING, ...options };
  const client = postgres(url, {
    max: tuning.max,
    connect_timeout: tuning.connectTimeoutSeconds,
    idle_timeout: tuning.idleTimeoutSeconds,
    max_lifetime: tuning.maxLifetimeSeconds,
    // O padrão do postgres.js cresce 3^n/100 s até 20 s por falha acumulada: depois de uma queda
    // longa, a API levava até 20 s para voltar a usar o banco já recuperado (achado do teste de
    // resiliência). Teto de 1 s: reconecta rápido; a pressão no banco é limitada pelo SlotLimiter.
    backoff: (retries: number) => Math.min(0.05 * 2 ** retries, 1),
    onnotice: () => undefined,
    connection: {
      statement_timeout: tuning.statementTimeoutMs,
      idle_in_transaction_session_timeout: tuning.idleInTransactionTimeoutMs,
      application_name: 'plataforma-api',
    },
  });
  const db = drizzle(client, { schema });
  const slots = new SlotLimiter(tuning.max, tuning.acquireTimeoutMs);
  // Toda transação (inclusive withTenant) passa pelo limitador de vagas e pelo prazo do cliente.
  const rawTransaction = db.transaction.bind(db);
  const guardedTransaction: Database['transaction'] = (fn, config) =>
    slots.run(tuning.transactionTimeoutMs, (expired) =>
      rawTransaction(async (tx) => {
        const result = await fn(tx);
        // Terminou depois do prazo (a resposta 503 já saiu): força ROLLBACK em vez de COMMIT,
        // para o cliente nunca receber "falhou" de algo que foi gravado.
        if (expired()) throw new TransactionTimeoutError();
        return result;
      }, config),
    );
  db.transaction = guardedTransaction;
  return {
    db,
    tuning,
    close: async () => {
      slots.close();
      await client.end({ timeout: 5 });
    },
  };
}

/**
 * Semáforo com tempo máximo de espera e prazo de execução:
 * - sem vaga em `acquireTimeoutMs` => PoolExhaustedError (nunca requisição pendurada);
 * - operação além de `deadlineMs` => TransactionTimeoutError para o chamador, mas a vaga só é
 *   devolvida quando a operação de fato termina (a contagem reflete conexões realmente ocupadas).
 */
export class SlotLimiter {
  private active = 0;
  private closed = false;
  private readonly waiting: Array<{ grant: () => void; timer: NodeJS.Timeout }> = [];

  constructor(
    private readonly capacity: number,
    private readonly acquireTimeoutMs: number,
  ) {}

  async run<T>(deadlineMs: number, op: (expired: () => boolean) => Promise<T>): Promise<T> {
    await this.acquire();
    let expired = false;
    let running: Promise<T>;
    try {
      running = op(() => expired);
    } catch (err) {
      this.release();
      throw err;
    }
    void running.then(
      () => this.release(),
      () => this.release(),
    );
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(new TransactionTimeoutError());
      }, deadlineMs);
    });
    try {
      return await Promise.race([running, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  close(): void {
    this.closed = true;
  }

  private acquire(): Promise<void> {
    if (this.closed) return Promise.reject(new PoolExhaustedError());
    if (this.active < this.capacity) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const entry = {
        grant: () => {
          clearTimeout(entry.timer);
          this.active++;
          resolve();
        },
        timer: setTimeout(() => {
          const i = this.waiting.indexOf(entry);
          if (i >= 0) this.waiting.splice(i, 1);
          reject(new PoolExhaustedError());
        }, this.acquireTimeoutMs),
      };
      this.waiting.push(entry);
    });
  }

  private release(): void {
    this.active--;
    const next = this.waiting.shift();
    if (next) next.grant();
  }
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
