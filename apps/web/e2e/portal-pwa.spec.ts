import { expect, test } from '@playwright/test';

test.describe('Portal do paciente (celular primeiro)', () => {
  test('confirmar presença, com desfazer', async ({ page }) => {
    await page.goto('/portal');
    await expect(page.getByRole('heading', { level: 1, name: 'Olá, Maria' })).toBeVisible();
    await page.getByRole('button', { name: 'Confirmar presença' }).first().click();
    await expect(page.getByText('Presença confirmada. Até lá!')).toBeVisible();
    await page.getByRole('button', { name: 'Desfazer' }).click();
    await expect(page.getByText('Pronto, desfeito.')).toBeVisible();
  });

  test('"Não vou conseguir ir" pede confirmação e avisa a clínica', async ({ page }) => {
    await page.goto('/portal');
    await page.getByRole('button', { name: 'Não vou conseguir ir' }).first().click();
    await expect(page.getByText('Avisar a clínica que você não vai?')).toBeVisible();
    await page.getByRole('button', { name: 'Sim, não vou' }).click();
    await expect(page.getByText('Pronto, a clínica foi avisada.')).toBeVisible();
    // O servidor não "descancela": sem Desfazer, e a tela manda falar com a clínica (P5).
    await expect(page.getByRole('button', { name: 'Desfazer' })).toHaveCount(0);
    await expect(page.getByText('Para remarcar, fale com a clínica.').first()).toBeVisible();
  });

  test('"de quem": trocar para o dependente mostra o aviso de responsável e "Dados de <nome>"', async ({ page }) => {
    await page.goto('/portal');
    await page.getByRole('button', { name: 'Trocar de pessoa' }).click();
    await expect(page.getByRole('heading', { name: 'De quem são os dados que você quer ver?' })).toBeVisible();
    await page.getByRole('button', { name: /Sofia/ }).click();
    await expect(page.getByText('Você está agindo como responsável de Sofia.')).toBeVisible();
    await page.getByRole('link', { name: 'Dados do paciente' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Dados de Sofia' })).toBeVisible();
    await expect(page.getByText('10/05/2018')).toBeVisible();
  });

  test('convite: token lido do #fragmento e apagado da barra; código pedido em seguida', async ({ page }) => {
    await page.goto('/portal/convite#convite-de-demonstracao');
    await expect(page.getByText('O código do link já foi preenchido.')).toBeVisible();
    expect(new URL(page.url()).hash).toBe('');
    await page.getByRole('button', { name: 'Mandar código para o celular' }).click();
    await expect(page.getByRole('heading', { name: 'Digite o código' })).toBeVisible();
    await page.getByLabel('Código', { exact: true }).fill('123456');
    await page.getByRole('button', { name: 'Confirmar' }).click();
    await expect(page).toHaveURL(/\/portal$/);
  });

  test('convite: qualquer falha mostra a mesma mensagem', async ({ page }) => {
    await page.goto('/portal/convite');
    await page.getByLabel('Código do convite').fill('convite-errado');
    await page.getByRole('button', { name: 'Mandar código para o celular' }).click();
    await expect(page.getByText(/Não deu para usar este convite/)).toBeVisible();
  });

  test('direitos: consentimento em 3 estados e pedido com protocolo', async ({ page }) => {
    await page.goto('/portal/direitos');
    const escriba = page.getByTestId('consentimento-escriba_ia');
    await expect(escriba).toHaveText('Ainda não respondido (vale como não)');
    await page.getByRole('group', { name: /inteligência artificial/ }).getByRole('button', { name: 'Autorizo', exact: true }).click();
    await expect(escriba).toHaveText('Você aceitou');
    await page.getByRole('button', { name: 'Desfazer' }).click();
    await expect(escriba).toHaveText('Ainda não respondido (vale como não)');

    await page.getByRole('listitem').filter({ hasText: 'Baixar uma cópia dos meus dados' }).getByRole('button', { name: 'Pedir' }).click();
    await page.getByRole('button', { name: 'Sim, enviar' }).click();
    await expect(page.getByText(/Pedido enviado\. Protocolo \d{8}-[0-9A-Z]{8}/)).toBeVisible();
    await expect(page.locator('section[aria-labelledby="t-meus"]')).toContainText('Protocolo');
  });

  test('meus dados: corrigir exige dizer o que está errado', async ({ page }) => {
    await page.goto('/portal/dados');
    await page.getByRole('button', { name: 'Corrigir um dado' }).click();
    await page.getByRole('button', { name: 'Enviar pedido de correção' }).click();
    await expect(page.getByText('⚠ Escreva o que está errado e como deve ficar.')).toBeVisible();
    await page.getByLabel('O que está errado e como deve ficar?').fill('Meu telefone mudou para (11) 90000-1234 (fictício).');
    await page.getByRole('button', { name: 'Enviar pedido de correção' }).click();
    await expect(page.getByText(/Pedido enviado à clínica\. Protocolo/)).toBeVisible();
  });

  test('entrada do portal por celular e código', async ({ page }) => {
    await page.goto('/portal/entrar');
    await page.getByLabel('Seu celular com DDD').fill('91234');
    await page.getByRole('button', { name: 'Mandar código' }).click();
    await expect(page.getByText(/Digite com DDD/)).toBeVisible();
    await page.getByLabel('Seu celular com DDD').fill('11912345678');
    await page.getByRole('button', { name: 'Mandar código' }).click();
    await page.getByLabel('Código').fill('123456');
    await page.getByRole('button', { name: 'Entrar' }).click();
    await expect(page).toHaveURL(/\/portal$/);
  });
});

test.describe('PWA e páginas de erro', () => {
  test('manifesto instalável com ícones PNG', async ({ request }) => {
    const r = await request.get('/manifest.webmanifest');
    expect(r.ok()).toBe(true);
    const m = await r.json();
    expect(m).toMatchObject({ name: 'Plataforma Saúde', display: 'standalone', start_url: '/inicio', lang: 'pt-BR' });
    const tamanhos = m.icons.map((i: { sizes: string }) => i.sizes);
    expect(tamanhos).toEqual(expect.arrayContaining(['192x192', '512x512']));
    for (const i of m.icons) {
      const ic = await request.get(i.src);
      expect(ic.ok(), i.src).toBe(true);
      expect(ic.headers()['content-type']).toBe('image/png');
    }
  });

  test('sem internet, o app mostra a tela de sem conexão (sem dado guardado)', async ({ page, context }) => {
    await page.goto('/inicio');
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await page.reload();
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
    await context.setOffline(true);
    await page.goto('/pacientes').catch(() => undefined);
    await expect(page.getByRole('heading', { name: 'Sem conexão com a internet' })).toBeVisible();
    // O cache só tem a tela offline e arquivos estáticos: nenhuma página com dados.
    // O nome do cache carrega a versão do build (`plataforma-saude-<build>`), então acha pelo prefixo:
    // `caches.open` com nome fixo CRIARIA um cache vazio e o teste passaria sem ver nada.
    const guardados = await page.evaluate(async () => {
      const nomes = (await caches.keys()).filter((n) => n.startsWith('plataforma-saude-'));
      if (nomes.length !== 1) throw new Error(`esperava um cache do app, achei: ${nomes.join(', ') || 'nenhum'}`);
      const c = await caches.open(nomes[0]!);
      return (await c.keys()).map((r) => new URL(r.url).pathname);
    });
    expect(guardados.filter((p) => !p.startsWith('/_next/static/') && !p.startsWith('/icones/'))).toEqual(['/offline']);
    await context.setOffline(false);
  });

  test('404 explica e oferece o caminho de volta', async ({ page }) => {
    const r = await page.goto('/isso-nao-existe');
    expect(r?.status()).toBe(404);
    await expect(page.getByRole('heading', { name: 'Não achamos esta página' })).toBeVisible();
    await page.getByRole('link', { name: 'Voltar para Hoje' }).click();
    await expect(page).toHaveURL(/\/inicio$/);
  });

  test('sessão expirada leva de volta para entrar', async ({ page }) => {
    await page.goto('/sessao-expirada');
    await expect(page.getByText(/15 minutos sem uso/)).toBeVisible();
    await page.getByRole('link', { name: 'Entrar de novo' }).click();
    await expect(page).toHaveURL(/\/entrar$/);
  });
});
