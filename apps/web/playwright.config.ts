import { defineConfig, devices } from '@playwright/test';

/**
 * E2E do front em 375 px (celular) e 1280 px (computador). Usa o build de produção
 * ("pnpm build" antes) servido na porta 3005.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:3005',
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'celular', use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 812 }, hasTouch: true } },
    { name: 'computador', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
  ],
  webServer: {
    command: 'pnpm start',
    url: 'http://localhost:3005/inicio',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
