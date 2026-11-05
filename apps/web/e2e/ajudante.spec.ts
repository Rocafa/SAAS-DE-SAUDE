import { expect, test, type Page } from '@playwright/test';

function proximaQuinta(): string {
  const d = new Date();
  const delta = ((4 - d.getDay() + 7) % 7) || 7;
  d.setDate(d.getDate() + delta);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function abrirAjudante(page: Page) {
  await page.getByTestId('abrir-ajudante').click();
  const caixa = page.getByRole('combobox', { name: 'O que você precisa?' });
  await expect(caixa).toBeFocused();
  return caixa;
}

test.describe('Ajudante', () => {
  test('acha a paciente pelo nome sem acento e com erro de digitação e leva até a ficha', async ({ page }) => {
    await page.goto('/inicio');
    const caixa = await abrirAjudante(page);
    await caixa.fill('mraia silva');
    await expect(page.getByRole('option', { name: /Maria Silva/ }).first()).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/pacientes\/p01$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Maria Silva' })).toBeVisible();
  });

  test('acha pelo telefone e mostra o CPF mascarado', async ({ page }) => {
    await page.goto('/inicio');
    const caixa = await abrirAjudante(page);
    await caixa.fill('90000-0004');
    const opcao = page.getByRole('option', { name: /Pedro Santos \(11\)/ });
    await expect(opcao).toContainText('***.***.');
  });

  test('marca consulta pelo Ajudante e PARA no botão de confirmar, sem gravar', async ({ page }) => {
    await page.goto('/inicio');
    const caixa = await abrirAjudante(page);
    await caixa.fill('marcar consulta para João quinta às 14h');
    await expect(page.getByRole('option').first()).toContainText('Marcar consulta para João Pereira');
    await page.keyboard.press('Enter');
    await page.getByTestId('fazer-por-mim').click();

    await expect(page).toHaveURL(/\/agenda\/marcar/);
    await expect(page.getByTestId('paciente-escolhido')).toHaveText('João Pereira');
    await expect(page.getByLabel('2. Dia')).toHaveValue(proximaQuinta());
    await expect(page.getByLabel('3. Horário')).toHaveValue('14:00');

    const confirmar = page.getByTestId('confirmar-consulta');
    await expect(confirmar).toHaveAttribute('data-ajudante-destaque', 'true', { timeout: 15_000 });
    await expect(confirmar).toBeFocused();
    await expect(page.getByTestId('narracao-ajudante')).toContainText('Nada foi gravado', { timeout: 15_000 });
    await expect(page.getByText(/Consulta marcada/)).toHaveCount(0);

    // Quem confirma é a pessoa; e dá para desfazer.
    await confirmar.click();
    await expect(page.getByText(/Consulta marcada: João Pereira/)).toBeVisible();
    await page.getByRole('button', { name: 'Desfazer' }).click();
    await expect(page.getByText('Pronto, desfeito.')).toBeVisible();
  });

  test('"Desfazer o que o Ajudante preencheu" volta para onde estava', async ({ page }) => {
    await page.goto('/pacientes');
    const caixa = await abrirAjudante(page);
    await caixa.fill('marcar consulta para Ana Souza amanhã às 9h');
    await page.keyboard.press('Enter');
    await page.getByTestId('fazer-por-mim').click();
    await expect(page.getByTestId('narracao-ajudante')).toContainText('Nada foi gravado', { timeout: 15_000 });
    await page.getByRole('button', { name: 'Desfazer o que o Ajudante preencheu' }).click();
    await expect(page).toHaveURL(/\/pacientes$/);
  });

  test('"Me mostra como" destaca onde clicar, passo a passo', async ({ page }) => {
    await page.goto('/inicio');
    const caixa = await abrirAjudante(page);
    await caixa.fill('agenda de amanhã');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Me mostra como' }).click();
    await expect(page.locator('[data-ajudante-destaque="true"]')).toHaveCount(1);
    await expect(page.locator('[data-ajudante-destaque="true"]')).toContainText('Agenda');
    await page.getByRole('button', { name: 'Próximo passo' }).click();
    await expect(page).toHaveURL(/\/agenda\?dia=/);
  });

  test('"como cancelo uma consulta" mostra o passo a passo', async ({ page }) => {
    await page.goto('/inicio');
    const caixa = await abrirAjudante(page);
    await caixa.fill('como cancelo uma consulta');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Como cancelar uma consulta' })).toBeVisible();
    await expect(page.getByRole('listitem')).toHaveCount(4);
  });

  test('abre com Ctrl/Cmd+K e com a tecla /, e em menos de 100 ms', async ({ page }) => {
    await page.goto('/inicio');
    await page.locator('main').click({ position: { x: 5, y: 5 } });
    const caixa = page.getByRole('combobox', { name: 'O que você precisa?' });
    const t0 = Date.now();
    await page.keyboard.press('/');
    await expect(caixa).toBeVisible();
    const ms = await page.evaluate(() => {
      const t = performance.now();
      return new Promise<number>((r) => requestAnimationFrame(() => r(performance.now() - t)));
    });
    expect(ms).toBeLessThan(100);
    expect(Date.now() - t0).toBeLessThan(1000);
    await page.keyboard.press('Escape');
    await expect(caixa).toBeHidden();
    await page.keyboard.press('ControlOrMeta+k');
    await expect(caixa).toBeVisible();
  });

  test('não escreve o texto digitado no console', async ({ page }) => {
    const mensagens: string[] = [];
    page.on('console', (m) => mensagens.push(m.text()));
    await page.goto('/inicio');
    const caixa = await abrirAjudante(page);
    await caixa.fill('maria silva telefone');
    await page.waitForTimeout(200);
    expect(mensagens.join('\n')).not.toMatch(/maria/i);
  });
});
