import { defineConfig } from 'vitest/config';

// Testes de resiliência/falha: exigem Postgres real com migrações aplicadas e
// DATABASE_URL do papel de runtime (app_user). Falhas são injetadas via proxy TCP local.
export default defineConfig({
  test: {
    // Sufixo próprio (não *.test.ts) para não entrar no `vitest run` padrão, que não tem banco.
    include: ['test/resiliencia/**/*.resiliencia.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Arquivos em série: os testes medem tempo e esgotam pool de propósito.
    fileParallelism: false,
  },
});
