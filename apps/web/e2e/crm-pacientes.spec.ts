import AxeBuilder from '@axe-core/playwright';
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
    await expect(page.getByText('Ninguém encontrado com essa busca.')).toBeVisible();
    await expect(page.getByText(/Confira a escrita ou procure pelo telefone/)).toBeVisible();
    await page.getByRole('button', { name: 'Limpar busca e filtros' }).click();
    await expect(page.getByLabel('Procurar paciente')).toHaveValue('');
    await expect(registrosVisiveis(page)).toHaveCount(10);
  });

  test('busca válida fora do status ativo oferece mostrar todos sem apagar o termo', async ({ page }) => {
    await page.goto('/pacientes');
    await page.getByLabel('Procurar paciente').fill('Miguel Freitas');
    await expect(page.getByText('Nenhum registro neste filtro')).toBeVisible();
    await expect(page.getByText('A busca encontrou registros em outro status. Mostre todos sem apagar a busca.')).toBeVisible();
    await page.getByRole('button', { name: 'Mostrar todos' }).click();
    await expect(page.getByLabel('Procurar paciente')).toHaveValue('Miguel Freitas');
    await expect(page.getByRole('combobox', { name: 'Status', exact: true })).toHaveValue('todos');
    await expect(nomesVisiveis(page)).toHaveText(['Miguel Freitas']);
  });

  test('filtro de status mostra inativos sem mudar a regra de acesso', async ({ page }) => {
    await page.goto('/pacientes');
    await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('inativo');
    await expect(nomesVisiveis(page)).toHaveText(['Miguel Freitas']);
    await expect(page.getByText('Inativo', { exact: true }).filter({ visible: true })).toBeVisible();
    await page.getByRole('combobox', { name: 'Status', exact: true }).selectOption('todos');
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
    await expect(page.getByRole('button', { name: 'Ordenar por Nome, decrescente' })).toBeVisible();
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
    await expect(page.getByRole('group', { name: 'Ordenar registros' })).toBeVisible();
    const acessibilidade = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    expect(acessibilidade.violations.map((violacao) => `${violacao.id} (${violacao.impact ?? 'sem impacto'})`)).toEqual([]);
    await page.getByLabel('Procurar paciente').fill('Maria Silva');
    await expect(page.getByRole('link', { name: 'Maria Silva', exact: true })).toBeVisible();
  });
});

test.describe('CRM — ficha de paciente', () => {
  test('abas mudam URL e conteúdo sem perder a Visão geral', async ({ page }) => {
    await page.goto('/pacientes/p01');
    const abas = page.getByRole('navigation', { name: 'Seções da ficha' });
    await expect(page.getByRole('heading', { name: 'Linha do tempo' })).toBeVisible();
    await expect(page.getByText('Autor: Histórico da agenda (demonstração)').first()).toBeVisible();

    await abas.getByRole('link', { name: 'Agenda', exact: true }).click();
    await expect(page).toHaveURL(/\/pacientes\/p01\?aba=agenda$/);
    await expect(page.getByRole('heading', { name: 'Próximas consultas' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Recibos' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Linha do tempo' })).toHaveCount(0);

    await abas.getByRole('link', { name: 'Financeiro', exact: true }).click();
    await expect(page).toHaveURL(/\/pacientes\/p01\?aba=financeiro$/);
    await expect(page.getByRole('heading', { name: 'Recibos' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Próximas consultas' })).toHaveCount(0);

    await abas.getByRole('link', { name: 'Documentos', exact: true }).click();
    await expect(page).toHaveURL(/\/pacientes\/p01\?aba=documentos$/);
    await expect(page.getByRole('heading', { name: 'Anexos' })).toBeVisible();
    await expect(page.getByText(/Carteirinha do convênio/).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Recibos' })).toHaveCount(0);

    await abas.getByRole('link', { name: 'Visão geral', exact: true }).click();
    await expect(page).toHaveURL(/\/pacientes\/p01$/);
    await expect(page.getByRole('heading', { name: 'Linha do tempo' })).toBeVisible();
  });

  test('voltar usa o link para a lista', async ({ page }) => {
    await page.goto('/pacientes/p02?aba=agenda');
    await page.getByRole('link', { name: 'Voltar para Pacientes' }).click();
    await expect(page).toHaveURL(/\/pacientes$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Pacientes' })).toBeVisible();
    await expect(registrosVisiveis(page)).toHaveCount(10);
  });

  test('Tab e Enter abrem uma ficha sem mouse nem foco programado', async ({ page }) => {
    await page.goto('/pacientes');
    let naBusca = false;
    for (let i = 0; i < 25 && !naBusca; i++) {
      await page.keyboard.press('Tab');
      naBusca = await page.evaluate(() => document.activeElement?.id.endsWith('-busca') ?? false);
    }
    expect(naBusca).toBe(true);
    await page.keyboard.type('Maria Silva');
    await expect(nomesVisiveis(page)).toHaveCount(1);

    let noRegistro = false;
    for (let i = 0; i < 25 && !noRegistro; i++) {
      await page.keyboard.press('Tab');
      noRegistro = (await page.locator(':focus').getAttribute('data-registro-nome')) !== null;
    }
    expect(noRegistro).toBe(true);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/pacientes\/p01$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Maria Silva' })).toBeVisible();
  });

  test('aba desconhecida cai na Visão geral sem esconder o registro', async ({ page }) => {
    await page.goto('/pacientes/p01?aba=inexistente');
    await expect(page.getByRole('heading', { level: 1, name: 'Maria Silva' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Visão geral', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { name: 'Linha do tempo' })).toBeVisible();
  });

  test('paciente inexistente oferece retorno sem mostrar erro genérico', async ({ page }) => {
    await page.goto('/pacientes/nao-existe');
    await expect(page.getByText('Paciente não encontrado')).toBeVisible();
    await page.getByRole('link', { name: 'Ir para Pacientes' }).click();
    await expect(page).toHaveURL(/\/pacientes$/);
  });
});
