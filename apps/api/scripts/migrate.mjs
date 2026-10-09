// Aplica db/migrations/*.sql em ordem, cada arquivo numa transação, registrando em schema_migrations.
// Deve rodar com o papel de MIGRAÇÃO: DATABASE_MIGRATOR_URL (app_migrator), nunca com app_user.
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const url = process.env.DATABASE_MIGRATOR_URL;
if (!url) {
  console.error('DATABASE_MIGRATOR_URL não definida (veja .env.example).');
  process.exit(1);
}

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const sql = postgres(url, { max: 1, onnotice: () => undefined });

try {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`;
  // Tabela interna de controle: o runtime não lê nem escreve aqui.
  await sql`REVOKE ALL ON schema_migrations FROM PUBLIC`;
  const [{ exists }] = await sql`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') AS exists`;
  if (exists) await sql`REVOKE ALL ON schema_migrations FROM app_user`;

  const applied = new Set((await sql`SELECT name FROM schema_migrations`).map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const body = await readFile(join(dir, file), 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`INSERT INTO schema_migrations (name) VALUES (${file})`;
    });
    console.log(`migração aplicada: ${file}`);
  }
  console.log('migrações em dia.');
} finally {
  await sql.end({ timeout: 5 });
}
