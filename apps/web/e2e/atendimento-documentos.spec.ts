import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const PASTA = fileURLToPath(new URL('../../../docs/02-produto/telas/', import.meta.url));

/** Troca o usuário da demonstração e segue navegando sem recarregar (os dados vivem na memória da aba). */
async function entrarComo(page: Page, nome: RegExp) {
  await page.goto('/mais');
  await page.getByRole('button', { name: nome }).click();
  await expect(page.getByRole('button', { name: nome })).toHaveAttribute('aria-pressed', 'true');
}

async function irPeloMenu(page: Page, item: string) {
  await page.locator('nav[aria-label="Menu principal"]:visible').getByRole('link', { name: item }).click();
}

async function semViolacaoSeria(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);
}

test.describe('Atendimento e prontuário', () => {
  test('fisioterapeuta escreve, o rascunho salva sozinho, assina e adiciona adendo', async ({ page }, info) => {
    await entrarComo(page, /Dra\. Beatriz/);
    await irPeloMenu(page, 'Atendimento');
    await expect(page.getByRole('heading', { level: 1, name: 'Atendimento' })).toBeVisible();
    await page.screenshot({ path: `${PASTA}${info.project.name}-atendimento.png`, fullPage: true });
    await page.getByRole('link', { name: 'Atender' }).first().click();

    await expect(page.getByRole('button', { name: 'Escriba de IA (em breve)' })).toBeDisabled();
    await page.getByLabel('Como o paciente chegou hoje').fill('Relata menos dor ao subir escada (fictício).');
    await page.getByLabel('Dor hoje (0 a 10)').selectOption('4');
    await expect(page.getByText(/Rascunho salvo às/)).toBeVisible({ timeout: 5000 });

    await page.getByRole('button', { name: 'Assinar' }).click();
    await page.getByTestId('confirmar-assinatura').click();
    await expect(page.getByText('⚠ Falta preencher “O que foi feito na sessão”.')).toBeVisible();

    await page.getByLabel('O que foi feito na sessão').fill('Fortalecimento e alongamento, 40 minutos (fictício).');
    await semViolacaoSeria(page);
    await page.screenshot({ path: `${PASTA}${info.project.name}-tela-atendimento.png`, fullPage: true });
    await page.getByRole('button', { name: 'Assinar' }).click();
    await expect(page.getByText(/Depois de assinada ela não muda mais/)).toBeVisible();
    await page.getByTestId('confirmar-assinatura').click();
    await expect(page.getByRole('heading', { name: /^Assinado/ })).toBeVisible();

    await page.getByLabel(/vira adendo/).fill('Orientei gelo em casa (fictício).');
    await page.getByRole('button', { name: 'Adicionar adendo' }).click();
    await expect(page.getByText(/Adendo de hoje:/)).toBeVisible();
  });

  test('recepção não escreve evolução', async ({ page }) => {
    await page.goto('/atendimento');
    await expect(page.getByText(/Você entrou como/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Atender' })).toHaveCount(0);
  });

  test('psicologia fica em compartimento sigiloso; só o autor lê', async ({ page }, info) => {
    await page.goto('/pacientes/p04/prontuario');
    await expect(page.getByRole('heading', { name: 'Psicologia — compartimento sigiloso' })).toBeVisible();
    await expect(page.getByText(/Seu perfil não tem acesso ao conteúdo clínico/)).toBeVisible();
    await expect(page.getByText(/Conteúdo fictício de demonstração/)).toHaveCount(0);
    await semViolacaoSeria(page);
    await page.screenshot({ path: `${PASTA}${info.project.name}-prontuario.png`, fullPage: true });

    await entrarComo(page, /Dr\. Henrique/);
    await irPeloMenu(page, 'Pacientes');
    await page.getByRole('link', { name: /Pedro Santos/ }).click();
    await page.getByRole('link', { name: 'Abrir prontuário' }).click();
    await expect(page.getByText(/Conteúdo fictício de demonstração/).first()).toBeVisible();
  });
});

test.describe('B1: conteúdo clínico só para quem cuida do paciente', () => {
  const TEXTO_CLINICO = /Relata melhora|Fortalecimento de quadríceps/;

  test('administradora não clínica abre o prontuário e vê só data e profissional', async ({ page }) => {
    await page.goto('/pacientes/p01/prontuario');
    await expect(page.getByText(/Seu perfil não tem acesso ao conteúdo clínico/)).toBeVisible();
    await expect(page.getByText(TEXTO_CLINICO)).toHaveCount(0);
  });

  test('administradora abrindo a tela de atendimento não vê histórico clínico', async ({ page }) => {
    await page.goto('/atendimento/a02');
    await expect(page.getByRole('heading', { level: 1, name: 'Maria Silva' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Histórico' })).toHaveCount(0);
    await expect(page.getByText(TEXTO_CLINICO)).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Ver prontuário completo' })).toHaveCount(0);
  });

  test('recepção: ficha sem "Abrir prontuário" e anexo clínico sem nome; prontuário fechado', async ({ page }) => {
    await entrarComo(page, /Recepcionista/);
    await irPeloMenu(page, 'Pacientes');
    await page.getByRole('link', { name: /^Maria Silva\b/ }).click();
    await expect(page.getByText('O conteúdo clínico é só para os profissionais que atendem este paciente.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Abrir prontuário' })).toHaveCount(0);
    await expect(page.getByText(/Raio-x/)).toHaveCount(0);
    await expect(page.getByText(/Carteirinha do convênio/).first()).toBeVisible();
  });

  test('fisioterapeuta com vínculo lê a evolução', async ({ page }) => {
    await entrarComo(page, /Dra\. Beatriz/);
    await irPeloMenu(page, 'Pacientes');
    await page.getByRole('link', { name: /^Maria Silva\b/ }).click();
    await page.getByRole('link', { name: 'Abrir prontuário' }).click();
    await expect(page.getByText(TEXTO_CLINICO).first()).toBeVisible();
  });
});

test.describe('Documentos', () => {
  test('atestado (profissional que atendeu): CID só com autorização; imprimir liberado', async ({ page }, info) => {
    await entrarComo(page, /Dra\. Beatriz/);
    await page.getByRole('link', { name: 'Documentos' }).click();
    await page.getByLabel('Atestado').check();
    await page.getByLabel('2. Paciente').selectOption('p01');
    await expect(page.locator('p').filter({ hasText: 'Assinado por:' })).toContainText('Dra. Beatriz Nogueira');
    await expect(page.locator('#doc-prof')).toHaveCount(0);
    await expect(page.getByTestId('texto-documento')).toContainText('Maria Silva');
    await expect(page.getByTestId('texto-documento')).toContainText('1 (um) dia');
    await page.getByLabel('CID (opcional)').fill('M54.5');
    await expect(page.getByText(/O CID só entra com a autorização do paciente/)).toBeVisible();
    await expect(page.getByTestId('imprimir-documento')).toBeDisabled();
    await page.getByLabel('O paciente autorizou incluir o CID').check();
    await expect(page.getByTestId('texto-documento')).toContainText('CID: M54.5');
    await expect(page.getByTestId('imprimir-documento')).toBeEnabled();
    await expect(page.getByText(/ICP-Brasil: em breve/)).toBeVisible();
    await semViolacaoSeria(page);
    await page.screenshot({ path: `${PASTA}${info.project.name}-documentos.png`, fullPage: true });
  });

  test('declaração de comparecimento e recibo', async ({ page }) => {
    await page.goto('/documentos?tipo=declaracao&paciente=p02');
    await expect(page.getByTestId('texto-documento')).toContainText('João Pereira compareceu a atendimento');
    await page.getByLabel('Saiu às').fill('08:00');
    await expect(page.getByText(/O horário de saída tem que ser depois da chegada/)).toBeVisible();
    await page.getByLabel('Recibo').check();
    await page.getByLabel('2. Paciente').selectOption('p01');
    await expect(page.getByTestId('texto-documento')).toContainText('Recebi de Maria Silva');
  });

  test('Ajudante leva o profissional ao atestado já com o paciente', async ({ page }) => {
    await entrarComo(page, /Dra\. Beatriz/);
    await page.getByTestId('abrir-ajudante').click();
    await page.getByRole('combobox', { name: 'O que você precisa?' }).fill('atestado para Maria Silva');
    await page.keyboard.press('Enter');
    await page.getByTestId('fazer-por-mim').click();
    await expect(page.getByTestId('texto-documento')).toContainText('Maria Silva', { timeout: 10_000 });
  });

  test('B2: recepção não vê "Atestado"; fica com declaração e recibo', async ({ page }) => {
    await entrarComo(page, /Recepcionista/);
    await page.getByRole('link', { name: 'Documentos' }).click();
    await expect(page.getByLabel('Declaração de comparecimento')).toBeVisible();
    await expect(page.getByLabel('Recibo')).toBeVisible();
    await expect(page.getByLabel('Atestado')).toHaveCount(0);
  });

  test('B2: pedido de atestado por perfil não clínico explica o motivo', async ({ page }) => {
    await page.goto('/documentos?tipo=atestado&paciente=p01');
    await expect(page.getByText(/O atestado é emitido pelo profissional que atendeu/)).toBeVisible();
    await expect(page.getByLabel('Atestado')).toHaveCount(0);
  });
});
