import { loadDatabaseTuning, type DatabaseTuning } from './db/pool-config';
import { EXIT_WINDOW_DAYS } from './modules/exports/access-policy';

export interface AppConfig {
  readonly port: number;
  readonly databaseUrl: string;
  /** G4: dias de leitura/exportação após cancelamento. Padrão e piso: 90. */
  readonly exitWindowDays: number;
  /** Limites do pool e timeouts do banco (DB_* no ambiente; padrões em db/pool-config.ts). */
  readonly database: DatabaseTuning;
}

/** Lê configuração do ambiente. Segredos chegam por variável (Secrets Manager em staging/prod). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL não definida (veja .env.example)');
  }
  const port = Number(env.API_PORT ?? 3333);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error('API_PORT inválida');
  }
  const exitWindowDays = Number(env.EXIT_WINDOW_DAYS ?? EXIT_WINDOW_DAYS);
  // Garantia de Saída: configurar abaixo do piso contratual é erro de deploy, não ajuste silencioso.
  if (!Number.isInteger(exitWindowDays) || exitWindowDays < EXIT_WINDOW_DAYS) {
    throw new Error(`EXIT_WINDOW_DAYS inválida: inteiro >= ${EXIT_WINDOW_DAYS}`);
  }
  return { port, databaseUrl, exitWindowDays, database: loadDatabaseTuning(env) };
}
