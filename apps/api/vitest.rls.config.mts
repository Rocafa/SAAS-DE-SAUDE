import { defineConfig } from 'vitest/config';

// Testes de isolamento entre tenants: exigem Postgres real com a migração aplicada e
// DATABASE_URL apontando para o papel de runtime (app_user, sem BYPASSRLS, não dono das tabelas).
export default defineConfig({
  test: {
    include: ['test/**/*.rls.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
