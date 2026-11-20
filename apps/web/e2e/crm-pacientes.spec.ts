import { expect, test, type Page } from '@playwright/test';

function nomesVisiveis(page: Page) {
  return page.locator('[data-registro-nome]:visible');
}

function registrosVisiveis(page: Page) {
  return page.locator('[data-registro-id]:visible');
}

test.describe('CRM — lista de pacientes', () => {
  test('busca filtra pelos dados reais do adaptador fake', async ({ page }) => {
    await page.goto('/pacientes');
    await page.getByLabel('Procurar paciente').fill('Maria');
    await expect(nomesVisiveis(page)).toHaveCount(2);
    expect(await nomesVisiveis(page).allTextContents()).toEqual(expect.arrayContaining(['Maria Silva', 'Maria Eduarda Santos']));
    await expect(page.locator('[data-registro-id="p02"]:visible')).toHaveCount(0);
  });

  test('busca sem resultado explica e limpa busca e filtros', async ({ page }) => {
    await page.goto('/pacientes');
    await page.getByLabel('Procurar paciente').fill('Ninguém Com Esse Nome');
    await expect(page.getByText('Ninguém encontrado com “Ninguém Com Esse Nome”')).toBeVisible();
    await expect(page.getByText(/Confira a escrita ou procure pelo telefone/)).toBeVisible();
    await page.getByRole('button', { name: 'Limpar busca e filtros' }).click();
    await expect(page.getByLabel('Procurar paciente')).toHaveValue('');
    await expect(registrosVisiveis(page)).toHaveCount(10);
  });

  test('filtro de status mostra inativos sem mudar a regra de acesso', async ({ page }) => {
    await page.goto('/pacientes');
    await page.getByLabel('Filtrar por status').selectOption('inativo');
    await expect(nomesVisiveis(page)).toHaveText(['Miguel Freitas']);
    await expect(page.getByText('Inativo', { exact: true }).filter({ visible: true })).toBeVisible();
    await page.getByLabel('Filtrar por status').selectOption('todos');
    await expect(page.getByRole('status').filter({ hasText: /Página 1 de 3/ })).toContainText('30 pacientes');
  });

  test('ordenação por nome muda a ordem e informa aria-sort', async ({ page }) => {
    await page.goto('/pacientes');
    await expect(nomesVisiveis(page).first()).toHaveText('Alice Prado');
    const ordenar = page.getByRole('button', { name: 'Ordenar por Nome' });
    await ordenar.click();
    await expect(page.locator('th[scope="col"]').filter({ hasText: 'Nome' })).toHaveAttribute('aria-sort', 'ascending');
    await ordenar.click();
    await expect(page.locator('th[scope="col"]').filter({ hasText: 'Nome' })).toHaveAttribute('aria-sort', 'descending');
    await expect(nomesVisiveis(page).first()).toHaveText('Thiago Barbosa');
    await expect(nomesVisiveis(page)).toHaveCount(10);
  });

  test('paginação navega, informa totais e respeita os limites', async ({ page }) => {
    await page.goto('/pacientes');
    await expect(registrosVisiveis(page)).toHaveCount(10);
    await page.getByRole('button', { name: 'Próxima página' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Página 2 de 3' })).toContainText('29 pacientes');
    await expect(registrosVisiveis(page)).toHaveCount(10);
    await page.getByRole('button', { name: 'Próxima página' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Página 3 de 3' })).toBeVisible();
    await expect(registrosVisiveis(page)).toHaveCount(9);
    await expect(page.getByRole('button', { name: 'Próxima página' })).toBeDisabled();
    await page.getByRole('button', { name: 'Página anterior' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Página 2 de 3' })).toBeVisible();
  });

  test('abrir a ficha usa o link real do registro', async ({ page }) => {
    await page.goto('/pacientes');
    await page.getByLabel('Procurar paciente').fill('Maria Silva');
    await page.getByRole('link', { name: 'Maria Silva', exact: true }).click();
    await expect(page).toHaveURL(/\/pacientes\/p01$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Maria Silva' })).toBeVisible();
  });

  test('erro de rede do adaptador aparece com Tentar de novo, sem duplicar alerta', async ({ page }) => {
    await page.goto('/pacientes?demo=erro');
    await expect(page.locator('main').getByRole('alert')).toContainText('Não conseguimos falar com o servidor.');
    const tentar = page.getByRole('button', { name: 'Tentar de novo' });
    await tentar.dblclick();
    await expect(page.locator('main').getByRole('alert')).toHaveCount(1);
    await expect(tentar).toBeVisible();
  });

  test('viewport de celular mostra cartões e esconde a tabela', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/pacientes');
    await expect(page.getByTestId('cartoes-registros')).toBeVisible();
    await expect(page.getByRole('table', { name: 'Lista de pacientes' })).toBeHidden();
    await expect(registrosVisiveis(page)).toHaveCount(10);
    await page.getByLabel('Procurar paciente').fill('Maria Silva');
    await expect(page.getByRole('link', { name: 'Maria Silva', exact: true })).toBeVisible();
  });
});
