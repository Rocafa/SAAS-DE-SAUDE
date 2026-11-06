import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, type Page, type TestInfo } from '@playwright/test';

/**
 * Capturas de tela que entram no repositório (`docs/02-produto/telas/`). Fotografar um build ligado à API real
 * gravaria prontuário, CPF e nome de paciente REAL no git, que é o que a regra do projeto proíbe acima de tudo, e
 * `.env*` é ignorado pelo git, então o modo não aparece na revisão.
 *
 * Por isso todo spec grava PNG só por `capturar` (R1 do parecer do #103; o teste `lib/captura-unica.test.ts`
 * recusa `page.screenshot` direto nos specs). Antes da primeira captura do worker, `exigirModoFake` confere o ambiente do
 * processo E a página servida (o servidor pode ter sido reaproveitado com outro ambiente: `reuseExistingServer`).
 */
export const PASTA_CAPTURAS = fileURLToPath(new URL('../../../docs/02-produto/telas/', import.meta.url));

const ESPERA_FAIXA_MS = 15_000;

/** Ambiente e página servida em modo de demonstração, na clínica e no portal. Falha antes de gravar qualquer PNG. */
export async function exigirModoFake(page: Page): Promise<void> {
  for (const chave of ['NEXT_PUBLIC_API_MODO', 'NEXT_PUBLIC_PORTAL_MODO'] as const) {
    const valor = process.env[chave]?.trim() || 'fake';
    if (valor !== 'fake') throw new Error(`${chave}=${valor}: captura de tela só com dado fictício (${chave}=fake)`);
  }
  // A faixa aparece depois da hidratação: espera visível (R3), em vez de contar na hora.
  await page.goto('/inicio');
  await expect(
    page.getByText('Demonstração com pacientes fictícios', { exact: false }),
    'o build servido da clínica não está em modo de demonstração: captura abortada antes de gravar PNG no repositório',
  ).toBeVisible({ timeout: ESPERA_FAIXA_MS });
  await page.goto('/portal');
  await expect(
    page.getByText('demonstração com dados fictícios', { exact: false }),
    'o build servido do portal não está em modo de demonstração: captura abortada antes de gravar PNG no repositório',
  ).toBeVisible({ timeout: ESPERA_FAIXA_MS });
}

let conferido: Promise<void> | undefined;

/**
 * Grava `docs/02-produto/telas/<projeto>-<nome>.png`. A conferência do modo roda uma vez por worker, numa aba
 * separada (não mexe na navegação nem nos dados em memória da aba do teste); se falhar, nenhuma captura do worker
 * acontece.
 */
export async function capturar(page: Page, info: TestInfo, nome: string, opcoes: { fullPage?: boolean } = {}): Promise<void> {
  conferido ??= (async () => {
    const aba = await page.context().newPage();
    try {
      await exigirModoFake(aba);
    } finally {
      await aba.close();
    }
  })();
  await conferido;
  mkdirSync(PASTA_CAPTURAS, { recursive: true });
  await page.screenshot({ path: `${PASTA_CAPTURAS}${info.project.name}-${nome}.png`, fullPage: opcoes.fullPage ?? true });
}
