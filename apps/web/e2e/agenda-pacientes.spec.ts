import { expect, test } from '@playwright/test';

function hojeIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

test.describe('Agenda', () => {
  test('check-in no dia, com desfazer', async ({ page }) => {
    await page.goto('/agenda?ver=dia');
    const cartao = page.locator('[data-assist-id="agenda-dia"] li').filter({ hasText: 'Falta confirmar' }).first();
    await cartao.getByRole('button', { name: 'Chegou' }).first().click();
    await expect(page.getByText(/chegou\.$/)).toBeVisible();
    await page.getByRole('button', { name: 'Desfazer' }).click();
    await expect(page.getByText('Pronto, desfeito.')).toBeVisible();
  });

  test('atendimento simultâneo aparece no dia', async ({ page }) => {
    await page.goto('/agenda?ver=dia');
    await expect(page.getByText(/2 pacientes ao mesmo tempo com Dra\. Beatriz/).first()).toBeVisible();
  });

  test('remarcar pelo botão (acessível, sem arrastar)', async ({ page }) => {
    await page.goto('/agenda?ver=dia');
    await page.getByRole('link', { name: 'Remarcar' }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: 'Remarcar consulta' })).toBeVisible();
    await expect(page.getByTestId('confirmar-consulta')).toHaveText(/Confirmar nova data/);
  });

  test('remarcar arrastando na semana (computador)', async ({ page }, info) => {
    test.skip(info.project.name === 'celular', 'No celular o caminho é o botão Remarcar.');
    await page.goto('/agenda?ver=semana');
    const hoje = hojeIso();
    const cartoes = page.locator('details[draggable="true"]');
    await expect(cartoes.first()).toBeVisible();
    // Acha uma consulta com um dia livre depois dela na mesma semana.
    const dias = await page.locator('section[data-dia]').evaluateAll((els) => els.map((e) => e.getAttribute('data-dia')!));
    const n = await cartoes.count();
    let feito = false;
    for (let i = 0; i < n && !feito; i++) {
      const c = cartoes.nth(i);
      const origem = await c.evaluate((el) => el.closest('section')!.getAttribute('data-dia')!);
      const destino = dias.find((d) => d > origem && d >= hoje);
      if (!destino) continue;
      await c.dragTo(page.locator(`section[data-dia="${destino}"]`));
      feito = true;
    }
    expect(feito).toBe(true);
    await expect(page.getByText(/passou para/)).toBeVisible();
    await page.getByRole('button', { name: 'Desfazer' }).click();
    await expect(page.getByText('Pronto, desfeito.')).toBeVisible();
  });

  test('horário ocupado é recusado com instrução', async ({ page }) => {
    await page.goto('/agenda/marcar');
    await page.getByLabel('1. Paciente').fill('Bruno');
    await page.getByRole('button', { name: /Bruno Dias/ }).click();
    await page.getByLabel('2. Dia').fill(hojeIso());
    await page.getByLabel('3. Horário').fill('14:00');
    await page.getByRole('button', { name: /Mais opções/ }).click();
    await page.getByLabel('Com quem').selectOption('pr2');
    await page.getByTestId('confirmar-consulta').click();
    await expect(page.getByText(/Esse horário já está ocupado\. Escolha outro horário ou faça um encaixe\./)).toBeVisible();
  });

  test('sessões recorrentes com pacote', async ({ page }) => {
    await page.goto('/agenda/marcar?paciente=p18');
    await page.getByLabel('2. Dia').fill(hojeIso());
    await page.getByLabel('3. Horário').fill('07:15');
    await page.getByRole('button', { name: /Mais opções/ }).click();
    await page.getByLabel('Repetir').selectOption('7');
    await page.getByLabel('Quantas sessões').fill('4');
    await page.getByLabel(/Faz parte de um pacote/).check();
    await page.getByTestId('confirmar-consulta').click();
    await expect(page.getByText(/4 sessões marcadas para Bruno Dias/)).toBeVisible();
  });

  test('lista de espera: colocar e marcar', async ({ page }) => {
    await page.goto('/agenda?ver=espera');
    await page.getByLabel('Paciente').fill('Helena');
    await page.getByRole('button', { name: 'Helena Moura' }).click();
    await page.getByLabel(/Que horário serve/).fill('sexta à tarde');
    await page.getByRole('button', { name: 'Colocar na espera' }).click();
    await expect(page.getByText('sexta à tarde')).toBeVisible();
    await page.getByRole('listitem').filter({ hasText: 'Helena Moura' }).getByRole('link', { name: 'Marcar horário' }).click();
    await expect(page.getByTestId('paciente-escolhido')).toHaveText('Helena Moura');
  });
});

test.describe('Pacientes', () => {
  test('cadastro: erros dizem o que fazer; menor pede responsável', async ({ page }) => {
    await page.goto('/pacientes/novo');
    await page.getByTestId('salvar-paciente').click();
    await expect(page.getByText('Falta o nome. Digite nome e sobrenome.')).toBeVisible();
    await expect(page.getByText('Falta o telefone. Digite com DDD.')).toBeVisible();

    await page.getByLabel('Nome completo (de registro)').fill('Teste Fictício Silva');
    await page.getByLabel('Telefone (com DDD)').fill('11912345678');
    await page.getByLabel('Data de nascimento (opcional)').fill('2016-03-10');
    await expect(page.getByRole('group', { name: /Responsável/ })).toBeVisible();
    await page.getByTestId('salvar-paciente').click();
    await expect(page.getByText(/falta o nome do responsável/)).toBeVisible();

    await page.getByLabel('Nome do responsável').fill('Responsável Fictício');
    await page.getByLabel('Telefone do responsável').fill('11998765432');
    await page.getByTestId('salvar-paciente').click();
    await expect(page.getByRole('heading', { level: 1, name: 'Teste Fictício Silva' })).toBeVisible();
    await expect(page.getByText('Responsável Fictício')).toBeVisible();
  });

  test('ficha: nome social em destaque, linha do tempo, anexos e pacote', async ({ page }) => {
    await page.goto('/pacientes/p29');
    await expect(page.getByRole('heading', { level: 1, name: 'Alice Prado' })).toBeVisible();
    await page.goto('/pacientes/p01');
    await expect(page.getByRole('heading', { name: 'Linha do tempo' })).toBeVisible();
    await expect(page.getByText(/Raio-x do joelho/).first()).toBeVisible();
    await expect(page.getByText(/Saldo: 7 sessões/)).toBeVisible();
  });

  test('corrigir nascimento que deixa o paciente mais novo pede a conferência do documento', async ({ page }) => {
    await page.goto('/pacientes/p01');
    await page.getByTestId('corrigir-dados').click();
    await page.getByLabel('Data de nascimento').fill('2016-01-01');
    await page.getByRole('button', { name: 'Salvar correção' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Conferi o documento original' })).toBeVisible();
    await page.getByRole('checkbox', { name: /Conferi o documento original/ }).check();
    await page.getByRole('button', { name: 'Salvar correção' }).click();
    await expect(page.getByText('Dados do paciente corrigidos.')).toBeVisible();
  });

  test('inativar avisa que o prontuário fica guardado e pode ser desfeito', async ({ page }) => {
    await page.goto('/pacientes/p02');
    await page.getByRole('button', { name: 'Inativar paciente' }).click();
    await expect(page.getByText(/O prontuário não é apagado/)).toBeVisible();
    await page.getByRole('button', { name: 'Sim, inativar' }).click();
    await expect(page.getByText(/Inativo desde hoje/)).toBeVisible();
    await page.getByRole('button', { name: 'Desfazer' }).click();
    await expect(page.getByRole('button', { name: 'Inativar paciente' })).toBeVisible();
  });
});
