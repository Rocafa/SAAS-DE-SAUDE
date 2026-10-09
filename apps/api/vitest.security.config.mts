import { defineConfig } from 'vitest/config';

// Suíte ofensiva de segurança (banco + HTTP). Os testes de banco exigem Postgres real com as
// migrações aplicadas e DATABASE_URL do papel de runtime (app_user) — mesmo esquema do test:rls.
export default defineConfig({
  test: {
    include: ['test/security/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
