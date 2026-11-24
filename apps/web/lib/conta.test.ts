import { describe, expect, it } from 'vitest';
import { criarApiFake } from './api/fake';
import { JANELA_SAIDA_DIAS, avisoDeSaida, errosSenha, fimDaJanela, validarCodigo, validarEmail } from './conta';

const hoje = new Date(2026, 9, 12, 10);

describe('saída da clínica (garantia G3)', () => {
  it('janela de 90 dias depois do cancelamento', () => {
    expect(JANELA_SAIDA_DIAS).toBeGreaterThanOrEqual(90);
    expect(fimDaJanela('2026-10-12')).toBe('2027-01-10');
  });
  it('avisos D-30, D-7 e D-1', () => {
    expect(avisoDeSaida('2026-10-12', hoje)).toBeNull();
    expect(avisoDeSaida('2026-07-24', hoje)).toMatch(/Faltam 1[0-9] dias|Faltam 2[0-9] dias|Faltam 30 dias/);
    expect(avisoDeSaida('2026-07-21', hoje)).toBe('Faltam 7 dias para o fim do prazo. Baixe os dados da clínica.');
    expect(avisoDeSaida('2026-07-15', hoje)).toMatch(/Último dia/);
    expect(avisoDeSaida('2026-01-01', hoje)).toBeNull();
  });
});

describe('acesso: erros dizem o que fazer', () => {
  it('e-mail', () => {
    expect(validarEmail('')).toBe('Falta o e-mail.');
    expect(validarEmail('maria@')).toMatch(/incompleto/);
    expect(validarEmail('maria@exemplo.com.br')).toBeNull();
  });
  it('senha com regras visíveis', () => {
    expect(errosSenha('abc')).toEqual(['Falta: pelo menos 12 letras ou números.', 'Falta: pelo menos um número.']);
    expect(errosSenha('senhaboa12345', 'senhaboa12345')).toEqual([]);
    expect(errosSenha('senhaboa12345', 'outra')).toEqual(['As duas senhas estão diferentes. Digite de novo.']);
  });
  it('código do autenticador', () => {
    expect(validarCodigo('')).toMatch(/aplicativo autenticador/);
    expect(validarCodigo('12a456')).toBe('O código tem 6 números.');
    expect(validarCodigo('123 456')).toBeNull();
  });
});

describe('fake: assinatura, exportação e equipe', () => {
  it('cancelar deixa 90 dias de leitura; reativar volta', async () => {
    const api = criarApiFake({ agora: hoje });
    const a = await api.cancelarAssinatura();
    expect(a).toMatchObject({ status: 'cancelada', canceladaEm: '2026-10-12', disponivelAte: '2027-01-10' });
    expect(a.proximaCobranca).toBeUndefined();
    expect((await api.reativarAssinatura()).status).toBe('ativa');
  });
  it('exportação: admin não-RT que pediu não aprova; o RT aprova com o próprio MFA, com auditoria', async () => {
    const api = criarApiFake({ agora: hoje });
    await expect(api.pedirExportacao('000000')).rejects.toThrow(/não confere/);
    const p = await api.pedirExportacao('123456');
    expect(p.status).toBe('aguardando_rt');

    // u1 é admin, pediu e não é o RT: recusa, mesmo com o código certo.
    await expect(api.aprovarExportacao(p.id, '123456')).rejects.toMatchObject({ status: 403, codigo: 'autoaprovacao_proibida' });
    expect(p.pedidoPor).toBe('u1');
    expect(await api.obterExportacaoPendente()).toMatchObject({ id: p.id, pedidoPor: 'u1', status: 'aguardando_rt' });
    expect((await api.listarAuditoria()).some((e) => /aprovou a/.test(e.acao))).toBe(false);

    await api.entrarComo('u5');
    expect((await api.usuarioAtual()).responsavelTecnico).toBe(true);
    expect(await api.obterExportacaoPendente()).toMatchObject({ id: p.id, pedidoPor: 'u1', status: 'aguardando_rt' });
    // O RT precisa do próprio MFA: sem código válido não aprova.
    await expect(api.aprovarExportacao(p.id, '')).rejects.toThrow(/6 números/);
    await expect(api.aprovarExportacao(p.id, '000000')).rejects.toThrow(/não confere/);
    expect(await api.obterExportacaoPendente()).toMatchObject({ id: p.id, status: 'aguardando_rt' });
    const ok = await api.aprovarExportacao(p.id, '123456');
    expect(ok).toMatchObject({ pedidoPor: 'u1', aprovadoPor: 'u5', aprovacaoAutonoma: false, status: 'pronto', downloadsRestantes: 3, expiraEm: '2026-10-13' });
    expect(await api.obterExportacaoPendente()).toBeNull();
    const auditoria = await api.listarAuditoria();
    expect(auditoria.map((e) => e.acao)).toContain('Pediu a exportação total dos dados');
    const aprovacoes = auditoria.filter((e) => e.acao === 'Responsável técnico aprovou a exportação');
    expect(aprovacoes).toHaveLength(1);
    expect(aprovacoes[0]?.quem).toBe('Dra. Lúcia Prates (administradora e terapeuta ocupacional)');
    expect(auditoria.some((e) => /autoaprovação/.test(e.acao))).toBe(false);
  });
  it('exportação: o RT autônomo (sem outro admin ativo) autoaprova, com janela de segurança e registro', async () => {
    // Autônomo: a outra administradora (u1) está sem acesso; a Dra. Lúcia é RT e única admin ativa.
    const api = criarApiFake({ agora: hoje, semAcesso: ['u1'] });
    await api.entrarComo('u5');
    const p = await api.pedirExportacao('123456');
    expect(p).toMatchObject({ pedidoPor: 'u5', confirmacao: 'autoaprovacao' });
    await expect(api.aprovarExportacao(p.id, '000000')).rejects.toThrow(/não confere/);
    const ok = await api.aprovarExportacao(p.id, '123456');
    expect(ok).toMatchObject({
      pedidoPor: 'u5',
      aprovadoPor: 'u5',
      aprovacaoAutonoma: true,
      status: 'pronto',
      downloadsRestantes: 3,
      // R10: link liberado 24 h depois; o prazo de 24 h do link conta da liberação.
      liberadoEm: '2026-10-13 10:00',
      expiraEm: '2026-10-14',
    });
    const auto = (await api.listarAuditoria()).filter((e) => /autoaprovação/.test(e.acao));
    expect(auto).toHaveLength(1);
    expect(auto[0]).toMatchObject({
      quem: 'Dra. Lúcia Prates (administradora e terapeuta ocupacional)',
      acao: 'Responsável técnico autônomo aprovou a própria exportação (autoaprovação; link liberado em 2026-10-13 10:00)',
    });
  });
  it('exportação: o RT com outro admin ativo não autoaprova; o outro admin confirma com o próprio MFA', async () => {
    const api = criarApiFake({ agora: hoje });
    await api.entrarComo('u5');
    const p = await api.pedirExportacao('123456');
    expect(p).toMatchObject({ pedidoPor: 'u5', confirmacao: 'admin' });
    await expect(api.aprovarExportacao(p.id, '123456')).rejects.toMatchObject({ status: 403, codigo: 'autoaprovacao_proibida' });
    // Profissional que não é admin também não confirma.
    await api.entrarComo('u2');
    await expect(api.aprovarExportacao(p.id, '123456')).rejects.toMatchObject({ status: 403 });
    await api.entrarComo('u1');
    expect(await api.obterExportacaoPendente()).toMatchObject({ id: p.id, confirmacao: 'admin', status: 'aguardando_rt' });
    await expect(api.aprovarExportacao(p.id, '000000')).rejects.toThrow(/não confere/);
    const ok = await api.aprovarExportacao(p.id, '123456');
    expect(ok).toMatchObject({ aprovadoPor: 'u1', aprovacaoAutonoma: false, status: 'pronto', downloadsRestantes: 3, expiraEm: '2026-10-13' });
    expect(ok.liberadoEm).toBeUndefined();
    const confirmacoes = (await api.listarAuditoria()).filter((e) => e.acao === 'Administrador confirmou a exportação pedida pelo responsável técnico');
    expect(confirmacoes).toHaveLength(1);
    expect(confirmacoes[0]?.quem).toBe('Administradora (demonstração)');
  });
  it('exportação: 409 ao aprovar pedido já pronto (sem devolver downloads) ou cancelado pelo "Não fui eu"', async () => {
    const api = criarApiFake({ agora: hoje });
    const pronto = await api.pedirExportacao('123456');
    await api.entrarComo('u5');
    await api.aprovarExportacao(pronto.id, '123456');
    await expect(api.aprovarExportacao(pronto.id, '123456')).rejects.toMatchObject({ status: 409, codigo: 'pedido_encerrado' });

    await api.entrarComo('u1');
    const outro = await api.pedirExportacao('123456');
    expect(await api.cancelarExportacao(outro.id)).toMatchObject({ status: 'cancelado' });
    expect(await api.obterExportacaoPendente()).toBeNull();
    await api.entrarComo('u5');
    await expect(api.aprovarExportacao(outro.id, '123456')).rejects.toMatchObject({ status: 409, codigo: 'pedido_encerrado' });
    const acoes = (await api.listarAuditoria()).map((e) => e.acao);
    expect(acoes).toContain('Cancelou o pedido de exportação ("Não fui eu")');
    expect(acoes.filter((a) => a === 'Responsável técnico aprovou a exportação')).toHaveLength(1);
  });
  it('exportação: outro admin que não é o RT também não aprova; o RT que não é admin aprova', async () => {
    // RT é a Dra. Beatriz (profissional, não admin). u1 pede; u5 é admin, não pediu e não é o RT.
    const api = criarApiFake({ agora: hoje, responsavelTecnicoId: 'u2' });
    const p = await api.pedirExportacao('123456');
    await api.entrarComo('u5');
    expect((await api.usuarioAtual()).responsavelTecnico).toBe(false);
    await expect(api.aprovarExportacao(p.id, '123456')).rejects.toMatchObject({ status: 403, codigo: 'responsavel_tecnico_obrigatorio' });
    expect(await api.obterExportacaoPendente()).toMatchObject({ id: p.id, status: 'aguardando_rt' });
    await api.entrarComo('u2');
    expect(await api.obterExportacaoPendente()).toMatchObject({ id: p.id, status: 'aguardando_rt' });
    expect(await api.aprovarExportacao(p.id, '123456')).toMatchObject({ aprovadoPor: 'u2', aprovacaoAutonoma: false, status: 'pronto' });
  });
  it('não deixa a clínica sem administrador; tirar acesso tem desfazer', async () => {
    const api = criarApiFake({ agora: hoje });
    await expect(api.removerAcesso('m1')).rejects.toThrow(/pelo menos um administrador/);
    const m = await api.removerAcesso('m5');
    expect((await api.listarEquipe()).some((x) => x.id === 'm5')).toBe(false);
    await api.devolverAcesso(m!);
    expect((await api.listarEquipe()).some((x) => x.id === 'm5')).toBe(true);
  });
});
