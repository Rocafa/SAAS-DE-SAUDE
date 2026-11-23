import { expect, test, type Page } from '@playwright/test';

/** Troca de usuário por navegação client-side: o pedido fictício vive só na memória da aba. */
async function entrarComo(page: Page, nome: RegExp) {
  await page.getByRole('link', { name: 'Mais', exact: true }).click();
  const usuario = page.getByRole('button', { name: nome });
  await usuario.click();
  await expect(usuario).toHaveAttribute('aria-pressed', 'true');
}

async function pedirExportacao(page: Page) {
  await page.getByRole('button', { name: 'Baixar todos os dados da clínica' }).click();
  await page.getByLabel(/Código do aplicativo autenticador/).fill('123456');
  await page.getByLabel(/Estou ciente/).check();
  await page.getByRole('button', { name: 'Confirmar pedido' }).click();
  await expect(page.getByText(/Falta a aprovação do responsável técnico/)).toBeVisible();
}

test.describe('Garantias na tela', () => {
  test('G4: cancelar a assinatura em até 3 cliques a partir de "Mais", sem ligação', async ({ page }) => {
    await page.goto('/mais');
    let cliques = 0;
    await page.getByRole('link', { name: 'Plano e assinatura' }).click();
    cliques++;
    await page.getByRole('button', { name: 'Cancelar assinatura' }).click();
    cliques++;
    await expect(page.getByText(/Sem multa e sem ligação/)).toBeVisible();
    await page.getByTestId('confirmar-cancelamento').click();
    cliques++;
    await expect(page.getByTestId('situacao-assinatura')).toContainText('Cancelada. Até');
    expect(cliques).toBeLessThanOrEqual(3);
    await page.getByRole('button', { name: 'Desfazer' }).click();
    await expect(page.getByText(/Próxima cobrança/)).toBeVisible();
  });

  test('G2: pedido não oferece aprovação a admin sem RT; RT aprova com MFA próprio', async ({ page }) => {
    await page.goto('/configuracoes/privacidade');
    await page.getByRole('button', { name: 'Baixar todos os dados da clínica' }).click();
    await page.getByLabel(/Código do aplicativo autenticador/).fill('000000');
    await page.getByRole('button', { name: 'Confirmar pedido' }).click();
    await expect(page.getByText('⚠ Marque que você está ciente do sigilo profissional.')).toBeVisible();
    await page.getByLabel(/Estou ciente/).check();
    await page.getByRole('button', { name: 'Confirmar pedido' }).click();
    await expect(page.getByText(/Código não confere/)).toBeVisible();
    await page.getByLabel(/Código do aplicativo autenticador/).fill('123456');
    await page.getByRole('button', { name: 'Confirmar pedido' }).click();
    await expect(page.getByText(/Falta a aprovação do responsável técnico/)).toBeVisible();
    await expect(page.getByText('Somente o responsável técnico pode aprovar, com um novo código MFA.')).toBeVisible();
    await expect(page.getByRole('button', { name: /Aprovar como responsável técnico/ })).toHaveCount(0);
    await expect(page.getByText(/O link foi para o seu e-mail/)).toHaveCount(0);

    await entrarComo(page, /Dra\. Lúcia Prates \(administradora/);
    await page.getByRole('link', { name: 'Privacidade e LGPD' }).click();
    await expect(page.getByText(/Falta a aprovação do responsável técnico/)).toBeVisible();
    await page.getByLabel('Código do responsável técnico (6 números)').fill('000000');
    await page.getByRole('button', { name: /Aprovar como responsável técnico/ }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Código não confere' })).toBeVisible();
    await expect(page.getByText(/Falta a aprovação do responsável técnico/)).toBeVisible();
    await expect(page.getByText(/O link foi para o seu e-mail/)).toHaveCount(0);

    await page.getByLabel('Código do responsável técnico (6 números)').fill('123456');
    await page.getByRole('button', { name: /Aprovar como responsável técnico/ }).dblclick();
    await expect(page.getByText(/O link foi para o seu e-mail/)).toBeVisible();
    await expect(page.getByText(/pode ser baixado 3 vezes/)).toBeVisible();
    await expect(page.getByText(/Falta a aprovação do responsável técnico/)).toHaveCount(0);
    const aprovacoes = page.getByRole('region', { name: 'Registro de acessos' }).getByRole('row').filter({ hasText: 'Responsável técnico aprovou a exportação' });
    await expect(aprovacoes).toHaveCount(1);
    await expect(aprovacoes.first()).toContainText('Dra. Lúcia Prates');
  });

  test('G2: admin RT autônomo aprova o próprio pedido e registra a exceção', async ({ page }) => {
    await page.goto('/mais');
    await entrarComo(page, /Dra\. Lúcia Prates \(administradora/);
    await page.getByRole('link', { name: 'Privacidade e LGPD' }).click();
    await pedirExportacao(page);

    await entrarComo(page, /Administradora \(demonstração\)/);
    await page.getByRole('link', { name: 'Privacidade e LGPD' }).click();
    await expect(page.getByText('Somente o responsável técnico pode aprovar, com um novo código MFA.')).toBeVisible();
    await expect(page.getByRole('button', { name: /Aprovar como responsável técnico/ })).toHaveCount(0);

    await entrarComo(page, /Dra\. Lúcia Prates \(administradora/);
    await page.getByRole('link', { name: 'Privacidade e LGPD' }).click();
    await expect(page.getByText(/Você também é o responsável técnico; esta aprovação autônoma ficará registrada/)).toBeVisible();
    await page.getByLabel('Código do responsável técnico (6 números)').fill('123456');
    await page.getByRole('button', { name: /Aprovar como responsável técnico/ }).click();
    await expect(page.getByText(/O link foi para o seu e-mail/)).toBeVisible();
    const aprovacoes = page
      .getByRole('region', { name: 'Registro de acessos' })
      .getByRole('row')
      .filter({ hasText: 'Responsável técnico autônomo aprovou a própria exportação' });
    await expect(aprovacoes).toHaveCount(1);
    await expect(aprovacoes.first()).toContainText('Dra. Lúcia Prates');
  });

  test('auditoria mostra quem acessou o quê e filtra por pessoa', async ({ page }) => {
    await page.goto('/configuracoes/privacidade');
    await page.getByLabel('Filtrar por pessoa').fill('Beatriz');
    const linhas = page.getByRole('region', { name: 'Registro de acessos' }).getByRole('row');
    await expect(linhas).toHaveCount(3);
    await expect(page.getByText('Abriu o prontuário de Maria Silva')).toBeVisible();
  });

  test('recepção não pode baixar todos os dados', async ({ page }) => {
    await page.goto('/mais');
    await page.getByRole('button', { name: /Recepcionista/ }).click();
    await page.getByRole('link', { name: 'Privacidade e LGPD' }).click();
    await expect(page.getByText('Só um administrador da clínica pode pedir. Peça ao responsável.')).toBeVisible();
  });
});

test.describe('Configurações, primeiros passos e ajuda', () => {
  test('B1: tabela de permissões não dá prontuário ao administrador', async ({ page }) => {
    await page.goto('/configuracoes/usuarios');
    const linha = page.getByRole('row', { name: /Ler prontuário dos pacientes que atende/ });
    await expect(linha.getByRole('cell').nth(1)).toHaveText('Não');
    await expect(linha.getByRole('cell').nth(2)).toHaveText('Sim');
    await expect(page.getByText(/Administrador que também é profissional de saúde segue a coluna/)).toBeVisible();
  });

  test('R11: recepção não cancela o plano, não convida e não vê a auditoria', async ({ page }) => {
    await page.goto('/mais');
    await page.getByRole('button', { name: /Recepcionista/ }).click();
    await page.getByRole('link', { name: 'Plano e assinatura' }).click();
    await expect(page.getByText('Só o administrador da clínica cancela ou muda o plano.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancelar assinatura' })).toHaveCount(0);
    await page.getByRole('link', { name: 'Configurações' }).first().click();
    await page.getByRole('link', { name: /Privacidade e LGPD/ }).click();
    await expect(page.getByText('Só o administrador da clínica vê quem acessou o quê.')).toBeVisible();
  });

  test('convidar pessoa: e-mail errado diz o que fazer', async ({ page }) => {
    await page.goto('/configuracoes/usuarios');
    await page.getByLabel('E-mail').fill('ana@');
    await page.getByRole('button', { name: 'Enviar convite' }).click();
    await expect(page.getByText(/E-mail incompleto/)).toBeVisible();
    await page.getByLabel('E-mail').fill('ana@exemplo.test');
    await page.getByRole('button', { name: 'Enviar convite' }).click();
    await expect(page.getByText(/Convite enviado para ana@exemplo.test/)).toBeVisible();
  });

  test('primeiros passos: 5 passos até o fim', async ({ page }) => {
    await page.goto('/primeiros-passos');
    await page.getByTestId('continuar-passo').click();
    await expect(page.getByText(/Falta o nome da clínica/)).toBeVisible();
    await page.getByLabel('Nome da clínica').fill('Clínica Teste (fictícia)');
    for (let i = 0; i < 4; i++) await page.getByTestId('continuar-passo').click();
    await expect(page.getByRole('heading', { name: /Passo 5 de 5/ })).toBeVisible();
    await page.getByTestId('continuar-passo').click();
    await expect(page).toHaveURL(/\/inicio$/);
  });

  test('ajuda: procurar e abrir o passo a passo', async ({ page }) => {
    await page.goto('/ajuda');
    await page.getByLabel('Procurar na ajuda').fill('cancelar');
    await page.getByRole('button', { name: 'Como cancelar uma consulta' }).click();
    await expect(page.getByText(/aperte "Cancelar" na consulta certa/)).toBeVisible();
  });
});

test.describe('Acesso (aguarda D4)', () => {
  test('entrar com senha e código do autenticador, escolher clínica', async ({ page }) => {
    await page.goto('/entrar');
    await page.getByRole('button', { name: 'Entrar' }).click();
    await expect(page.getByText('⚠ Falta o e-mail.')).toBeVisible();
    await page.getByLabel('E-mail').fill('ana@exemplo.test');
    await page.getByLabel('Senha').fill('qualquer');
    await page.getByRole('button', { name: 'Entrar' }).click();
    await page.getByLabel('Código').fill('111111');
    await page.getByRole('button', { name: 'Confirmar' }).click();
    await expect(page.getByText(/Código não confere/)).toBeVisible();
    await page.getByLabel('Código').fill('123456');
    await page.getByRole('button', { name: 'Confirmar' }).click();
    await page.getByRole('button', { name: /Clínica Demonstração/ }).click();
    await expect(page).toHaveURL(/\/inicio$/);
  });

  test('esqueci a senha não revela se o e-mail existe', async ({ page }) => {
    await page.goto('/esqueci-senha');
    await page.getByLabel('Seu e-mail').fill('ninguem@exemplo.test');
    await page.getByRole('button', { name: /Mandar link/ }).click();
    await expect(page.getByText(/Se esse e-mail estiver cadastrado/)).toBeVisible();
  });

  test('convite: regras de senha visíveis, senhas diferentes avisam, depois MFA', async ({ page }) => {
    await page.goto('/convite');
    await page.getByLabel('Seu nome').fill('Pessoa Fictícia');
    await page.getByLabel('Crie uma senha').fill('senhaboa12345');
    await expect(page.getByRole('listitem').filter({ hasText: 'Pelo menos 12 letras ou números' })).toContainText('(feito)');
    await page.getByLabel('Digite a senha de novo').fill('outra');
    await page.getByRole('button', { name: 'Criar senha' }).click();
    await expect(page.getByText(/As duas senhas estão diferentes/)).toBeVisible();
    await page.getByLabel('Digite a senha de novo').fill('senhaboa12345');
    await page.getByRole('button', { name: 'Criar senha' }).click();
    await page.getByLabel('Código').fill('123456');
    await page.getByRole('button', { name: 'Ativar e entrar' }).click();
    await expect(page).toHaveURL(/\/primeiros-passos$/);
  });
});
