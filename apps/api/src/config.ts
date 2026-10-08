export interface AppConfig {
  readonly port: number;
  readonly databaseUrl: string;
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
  return { port, databaseUrl };
}
