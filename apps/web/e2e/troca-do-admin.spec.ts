import { expect, test } from '@playwright/test';

/** B13: aviso fixo da troca do admin único, na demonstração (`?demo=troca-do-admin`, só no fake). Dados fictícios. */
test.describe('Aviso da troca do admin único', () => {
  test('a conta antiga vê o aviso fixo, confirma o "Não fui eu" e a troca para', async ({ page }) => {
    await page.goto('/inicio?demo=troca-do-admin');
    const aviso = page.getByTestId('aviso-troca-do-admin');
    await expect(aviso).toBeVisible();
    await expect(aviso).toContainText('Foi pedida a troca do administrador desta clínica');
    await expect(aviso).toContainText(/A janela de espera termina em \d{2}\/\d{2}\/\d{4} às \d{2}:\d{2}/);
    // Não dispensável: nenhum botão de fechar.
    await expect(aviso.getByRole('button', { name: /fechar|dispensar/i })).toHaveCount(0);

    await aviso.getByRole('button', { name: 'Não fui eu' }).click();
    await expect(aviso).toContainText('Confirma que você não pediu essa troca?');
    await aviso.getByRole('button', { name: 'Voltar' }).click();
    await aviso.getByRole('button', { name: 'Não fui eu' }).click();
    await page.getByTestId('confirmar-nao-fui-eu').click();
    await expect(aviso).toContainText('você contestou o pedido e a troca parou');
  });

  test('sem a troca simulada, nenhum aviso', async ({ page }) => {
    await page.goto('/inicio');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByTestId('aviso-troca-do-admin')).toHaveCount(0);
  });
});
