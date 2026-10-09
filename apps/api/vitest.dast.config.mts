import { defineConfig } from 'vitest/config';

// Só para o job DAST (seguranca.yml): sobe a API real para o OWASP ZAP. Não é teste.
export default defineConfig({
  test: {
    include: ['test/security/dast/*.dast.ts'],
    environment: 'node',
  },
});
