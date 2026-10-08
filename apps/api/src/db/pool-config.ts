/**
 * Limites do pool e timeouts do banco. Valores padrão conservadores; ajustáveis por variável de
 * ambiente (sem segredo algum aqui). Ver docs/04-arquitetura/testes-de-producao.md.
 */
export interface DatabaseTuning {
  /** Conexões máximas do pool por instância da API. */
  readonly max: number;
  /** Tempo máximo para abrir uma conexão TCP+auth (s). */
  readonly connectTimeoutSeconds: number;
  /** Fecha conexões ociosas após N segundos (libera slots no banco). */
  readonly idleTimeoutSeconds: number;
  /** Recicla conexões após N segundos (evita conexões "velhas" após failover). */
  readonly maxLifetimeSeconds: number;
  /** `statement_timeout` por conexão: query acima disso é cancelada pelo próprio Postgres. */
  readonly statementTimeoutMs: number;
  /** `idle_in_transaction_session_timeout`: transação esquecida aberta é encerrada pelo Postgres. */
  readonly idleInTransactionTimeoutMs: number;
  /** Tempo máximo esperando vaga no pool antes de falhar com PoolExhaustedError (não trava). */
  readonly acquireTimeoutMs: number;
  /**
   * Prazo do lado do CLIENTE para a transação inteira (inclui conectar). Necessário porque em
   * rede particionada o servidor nunca recebe o statement_timeout e o postgres.js re-enfileira a
   * query a cada CONNECT_TIMEOUT — sem este prazo a requisição ficaria pendurada.
   */
  readonly transactionTimeoutMs: number;
}

export const DEFAULT_DATABASE_TUNING: DatabaseTuning = {
  max: 10,
  connectTimeoutSeconds: 5,
  idleTimeoutSeconds: 30,
  maxLifetimeSeconds: 30 * 60,
  statementTimeoutMs: 5_000,
  idleInTransactionTimeoutMs: 10_000,
  acquireTimeoutMs: 2_000,
  transactionTimeoutMs: 15_000,
};

const ENV_KEYS: Record<keyof DatabaseTuning, string> = {
  max: 'DB_POOL_MAX',
  connectTimeoutSeconds: 'DB_CONNECT_TIMEOUT_S',
  idleTimeoutSeconds: 'DB_IDLE_TIMEOUT_S',
  maxLifetimeSeconds: 'DB_MAX_LIFETIME_S',
  statementTimeoutMs: 'DB_STATEMENT_TIMEOUT_MS',
  idleInTransactionTimeoutMs: 'DB_IDLE_IN_TX_TIMEOUT_MS',
  acquireTimeoutMs: 'DB_ACQUIRE_TIMEOUT_MS',
  transactionTimeoutMs: 'DB_TRANSACTION_TIMEOUT_MS',
};

/** Lê os ajustes do ambiente; valor inválido é erro de deploy (falha no boot, não ajuste silencioso). */
export function loadDatabaseTuning(env: NodeJS.ProcessEnv = process.env): DatabaseTuning {
  const out: Record<string, number> = { ...DEFAULT_DATABASE_TUNING };
  for (const [key, envName] of Object.entries(ENV_KEYS)) {
    const raw = env[envName];
    if (raw === undefined || raw === '') continue;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) throw new Error(`${envName} inválida: inteiro > 0`);
    out[key] = value;
  }
  return out as unknown as DatabaseTuning;
}
