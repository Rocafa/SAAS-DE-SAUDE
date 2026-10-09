import { defineConfig } from 'vitest/config';

// Testes unitários e de HTTP: não exigem banco.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['test/**/*.rls.test.ts', 'test/**/*.security.test.ts'],
    environment: 'node',
  },
});
