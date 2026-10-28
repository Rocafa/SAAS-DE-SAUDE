import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { coresNaoCinza } from '../lib/cores.mjs';

const TELAS: [string, string][] = [
  ['inicio', '/inicio'],
  ['agenda', '/agenda'],
  ['marcar-consulta', '/agenda/marcar'],
  ['pacientes', '/pacientes'],
  ['ficha-paciente', '/pacientes/p01'],
  ['mais', '/mais'],
  ['agenda-semana', '/agenda?ver=semana'],
  ['agenda-profissional', '/agenda?ver=profissional'],
  ['lista-espera', '/agenda?ver=espera'],
  ['novo-paciente', '/pacientes/novo'],
  ['atendimento-recepcao', '/atendimento'],
  ['documentos-vazio', '/documentos'],
  ['prontuario-sigiloso', '/pacientes/p04/prontuario'],
  ['financeiro', '/financeiro'],
  ['recibos', '/financeiro/recibos'],
  ['guias', '/guias'],
  ['mensagens', '/mensagens'],
  ['relatorios', '/relatorios'],
  ['configuracoes', '/configuracoes'],
  ['config-clinica', '/configuracoes/clinica'],
  ['config-usuarios', '/configuracoes/usuarios'],
  ['config-horarios', '/configuracoes/horarios'],
  ['config-tipos', '/configuracoes/tipos'],
  ['config-modelos', '/configuracoes/modelos'],
  ['config-privacidade', '/configuracoes/privacidade'],
  ['config-plano', '/configuracoes/plano'],
  ['primeiros-passos', '/primeiros-passos'],
  ['ajuda', '/ajuda'],
  ['entrar', '/entrar'],
  ['esqueci-senha', '/esqueci-senha'],
  ['convite', '/convite'],
  ['escolher-clinica', '/escolher-clinica'],
];

const PASTA = fileURLToPath(new URL('../../../docs/02-produto/telas/', import.meta.url));

/** Lê as cores CALCULADAS de todos os elementos da tela e devolve as que não são cinza. */
async function coresRenderizadas(page: Page): Promise<string[]> {
  const cores = await page.evaluate(() => {
    const props = ['color', 'background-color', 'border-top-color', 'border-bottom-color', 'border-left-color', 'border-right-color', 'outline-color', 'fill', 'stroke', 'box-shadow', 'text-decoration-color'];
    const out = new Set<string>();
    for (const el of Array.from(document.querySelectorAll('*'))) {
      const cs = getComputedStyle(el);
      for (const p of props) {
        const v = cs.getPropertyValue(p);
        if (v && v !== 'none') out.add(v);
      }
    }
    return [...out];
  });
  return cores.flatMap((c) => coresNaoCinza(`x{c:${c}}`));
}

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

test.describe('telas do PR 1', () => {
  for (const [nome, rota] of TELAS) {
    test(`${nome}: acessível, só cinza, letra de 18 px e captura`, async ({ page }, info) => {
      await page.goto(rota);
      await expect(page.locator('main h1').first()).toBeVisible();
      await page.waitForLoadState('networkidle');
      expect(await axe(page)).toEqual([]);
      expect(await coresRenderizadas(page)).toEqual([]);
      expect(await page.evaluate(() => getComputedStyle(document.body).fontSize)).toBe('18px');

      // Alvos de clique: botões, campos e itens de menu com pelo menos 48 px de altura.
      const pequenos = await page.evaluate(() =>
        Array.from(document.querySelectorAll('button, input, select, nav a'))
          .filter((el) => (el as HTMLElement).getClientRects().length > 0)
          // Caixa de marcar conta pelo rótulo inteiro, que é clicável.
          .map((el) => (el.matches('input[type=checkbox], input[type=radio]') ? (el.closest('label') ?? el) : el))
          .filter((el) => el.getBoundingClientRect().height < 48)
          .map((el) => el.outerHTML.slice(0, 80)),
      );
      expect(pequenos).toEqual([]);

      mkdirSync(PASTA, { recursive: true });
      await page.screenshot({ path: `${PASTA}${info.project.name}-${nome}.png`, fullPage: true });
    });
  }

  test('modo escuro também é cinza e acessível', async ({ page }, info) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/inicio');
    await expect(page.locator('main h1')).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(await axe(page)).toEqual([]);
    expect(await coresRenderizadas(page)).toEqual([]);
    await page.screenshot({ path: `${PASTA}${info.project.name}-inicio-escuro.png`, fullPage: true });
  });

  test('Ajudante aberto: acessível e só cinza', async ({ page }, info) => {
    await page.goto('/inicio');
    await page.getByTestId('abrir-ajudante').click();
    await page.getByRole('combobox', { name: 'O que você precisa?' }).fill('marcar consulta para João quinta às 14h');
    await expect(page.getByRole('option').first()).toBeVisible();
    expect(await axe(page)).toEqual([]);
    expect(await coresRenderizadas(page)).toEqual([]);
    await page.screenshot({ path: `${PASTA}${info.project.name}-ajudante.png` });
  });

  test('estado de erro tem "Tentar de novo"', async ({ page }) => {
    await page.goto('/inicio?demo=erro');
    await expect(page.getByRole('button', { name: 'Tentar de novo' })).toBeVisible();
  });

  test('estado vazio diz o que fazer', async ({ page }) => {
    await page.goto('/inicio?demo=vazio');
    await expect(page.getByText('Nenhuma consulta marcada para hoje')).toBeVisible();
    await expect(page.getByText(/Aperte “Marcar consulta”/)).toBeVisible();
  });

  test('estado carregando aparece', async ({ page }) => {
    await page.goto('/pacientes?demo=lento');
    await expect(page.getByRole('status').filter({ hasText: 'Carregando' })).toBeVisible();
  });

  test('sem internet mostra aviso', async ({ page, context }) => {
    await page.goto('/inicio');
    await context.setOffline(true);
    await expect(page.getByText(/Sem internet/)).toBeVisible();
    await context.setOffline(false);
    await expect(page.getByText(/Sem internet/)).toBeHidden();
  });

  test('erro de formulário diz o que fazer', async ({ page }) => {
    await page.goto('/agenda/marcar');
    await page.getByTestId('confirmar-consulta').click();
    await expect(page.getByText('Falta o paciente. Digite o nome e escolha na lista.')).toBeVisible();
    await expect(page.getByText('Falta o dia. Escolha no calendário.')).toBeVisible();
  });

  test('menu: 6 itens no computador, 4 + Mais no celular', async ({ page }, info) => {
    await page.goto('/inicio');
    const menu = page.locator('nav[aria-label="Menu principal"]:visible a');
    await expect(menu).toHaveCount(info.project.name === 'celular' ? 5 : 6);
    await expect(menu.last()).toHaveText('Mais');
  });

  test('rota desconhecida dá 404', async ({ page }) => {
    const r = await page.goto('/nao-existe-isso');
    expect(r?.status()).toBe(404);
  });
});
