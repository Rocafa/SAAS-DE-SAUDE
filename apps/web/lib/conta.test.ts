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
  it('exportação exige código e aprovação do responsável técnico; tudo vai para a auditoria', async () => {
    const api = criarApiFake({ agora: hoje });
    await expect(api.pedirExportacao('000000')).rejects.toThrow(/não confere/);
    const p = await api.pedirExportacao('123456');
    expect(p.status).toBe('aguardando_rt');
    const ok = await api.aprovarExportacao(p.id);
    expect(ok).toMatchObject({ status: 'pronto', downloadsRestantes: 3, expiraEm: '2026-10-13' });
    const acoes = (await api.listarAuditoria()).map((e) => e.acao);
    expect(acoes).toEqual(expect.arrayContaining(['Pediu a exportação total dos dados', 'Responsável técnico aprovou a exportação']));
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
