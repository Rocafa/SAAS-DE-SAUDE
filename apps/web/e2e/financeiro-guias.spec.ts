import { expect, test } from '@playwright/test';

test.describe('Financeiro', () => {
  test('receber um atendimento pendente soma no dia e pode ser desfeito', async ({ page }) => {
    await page.goto('/financeiro');
    const total = page.getByTestId('total-hoje');
    const antes = await total.textContent();
    await page.getByRole('button', { name: 'Receber' }).first().click();
    await page.getByRole('group', { name: /Como .* pagou/ }).getByRole('button', { name: 'Pix' }).click();
    await expect(page.getByText(/^Recebido R\$/)).toBeVisible();
    await expect(total).not.toHaveText(antes ?? '');
    await page.getByRole('button', { name: 'Desfazer' }).click();
    await expect(total).toHaveText(antes ?? '');
  });

  test('Pix automático aparece como "em breve"', async ({ page }) => {
    await page.goto('/financeiro');
    await expect(page.getByText(/Pix com QR Code e baixa automática: em breve/)).toBeVisible();
  });

  test('recibos levam ao documento para imprimir', async ({ page }) => {
    await page.goto('/financeiro/recibos');
    await page.getByRole('link', { name: 'Imprimir' }).first().click();
    await expect(page.getByTestId('texto-documento')).toContainText('Recebi de');
  });
});

test.describe('Guias de convênio', () => {
  test('avisa guia vencendo e sessões acabando', async ({ page }) => {
    await page.goto('/guias');
    await expect(page.getByText('Vence em 5 dias. Peça a renovação.')).toBeVisible();
    await expect(page.getByText('Só resta 1 sessão. Peça mais ao convênio.')).toBeVisible();
  });

  test('cadastrar guia: erro diz o que fazer; desfazer remove', async ({ page }) => {
    await page.goto('/guias');
    await page.getByRole('button', { name: 'Cadastrar guia' }).click();
    await page.getByRole('button', { name: 'Salvar guia' }).click();
    await expect(page.getByText('⚠ Falta a validade. Ela está no papel da guia.')).toBeVisible();
    await page.getByLabel('Paciente').selectOption({ label: 'Helena Moura' });
    await page.getByLabel('Convênio').fill('Convênio Teste (fictício)');
    await page.getByLabel('Número da guia').fill('424242');
    await page.getByLabel('Válida até').fill('2099-12-31');
    await page.getByRole('button', { name: 'Salvar guia' }).click();
    await expect(page.getByText('guia nº 424242', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Desfazer' }).click();
    await expect(page.getByText('guia nº 424242', { exact: false })).toHaveCount(0);
  });
});

test.describe('Mensagens e relatórios', () => {
  test('mensagens é prévia: lê a conversa, não envia', async ({ page }) => {
    await page.goto('/mensagens');
    await expect(page.getByText(/Prévia: o WhatsApp entra numa próxima etapa/)).toBeVisible();
    await page.getByRole('button', { name: /Rafael Carvalho/ }).click();
    await expect(page.getByRole('region', { name: /Conversa com Rafael Carvalho/ }).getByText('Pode ser à tarde.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Enviar' })).toBeDisabled();
  });

  test('relatórios mostram números, gráfico e tabela', async ({ page }) => {
    await page.goto('/relatorios');
    await expect(page.getByTestId('kpi-Atendimentos')).not.toHaveText('0');
    await expect(page.getByRole('img', { name: /Gráfico: \d+ atendimentos/ })).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible();
    await page.getByRole('button', { name: 'Últimos 7 dias' }).click();
    await expect(page.getByRole('button', { name: 'Últimos 7 dias' })).toHaveAttribute('aria-pressed', 'true');
  });
});
