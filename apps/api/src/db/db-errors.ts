/**
 * Classificação de erros de banco para respostas HTTP genéricas (503 x 500), sem vazar detalhe.
 * drizzle/postgres.js embrulham o erro original em `cause`, então percorremos a cadeia.
 */

/** Pool sem vaga dentro de `acquireTimeoutMs`: falha rápida em vez de fila infinita. */
export class PoolExhaustedError extends Error {
  readonly code = 'POOL_EXHAUSTED';
  constructor() {
    super('pool de conexões esgotado');
    this.name = 'PoolExhaustedError';
  }
}

/** Transação passou do prazo do cliente (banco não respondeu: rede particionada, travamento). */
export class TransactionTimeoutError extends Error {
  readonly code = 'TRANSACTION_TIMEOUT';
  constructor() {
    super('transação excedeu o prazo do cliente');
    this.name = 'TransactionTimeoutError';
  }
}

/** Códigos do cliente postgres.js (e nossos) para falha de conexão/prazo. */
const CONNECTION_CODES = new Set([
  'TRANSACTION_TIMEOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'CONNECT_TIMEOUT',
  'CONNECTION_CLOSED',
  'CONNECTION_DESTROYED',
  'CONNECTION_ENDED',
  'POOL_EXHAUSTED',
]);

/**
 * SQLSTATE transitórios: classe 08 (conexão), 53 (recursos), 57 (intervenção do operador:
 * 57014 statement_timeout/cancel, 57P01 admin_shutdown, 57P03 cannot_connect_now),
 * 25P03 (idle_in_transaction_session_timeout), 40001/40P01 (serialização/deadlock) e
 * 25006 (read_only_sql_transaction): escrita caiu num banco somente leitura, o que acontece
 * durante o failover (conexão antiga ainda no nó que virou réplica) ou em manutenção.
 */
const TRANSIENT_SQLSTATES = new Set(['25P03', '25006', '40001', '40P01']);

function isTransientSqlState(code: string): boolean {
  return /^(08|53|57)/.test(code) || TRANSIENT_SQLSTATES.has(code);
}

function codeOf(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** Percorre `cause` (limitado) e devolve o primeiro código encontrado. */
export function dbErrorCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 8 && current; depth++) {
    const code = codeOf(current);
    if (code) return code;
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

/** Erro que indica banco indisponível/sobrecarregado: deve virar 503 (tente de novo). */
export function isTransientDatabaseError(err: unknown): boolean {
  const code = dbErrorCode(err);
  if (!code) return false;
  return CONNECTION_CODES.has(code) || isTransientSqlState(code);
}
