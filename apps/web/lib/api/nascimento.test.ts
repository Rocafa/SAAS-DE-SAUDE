/**
 * Conferência de documento ao mudar o nascimento (C1-b′/0053 da rodada 19+): a regra pura e o adaptador
 * falso, que precisa recusar do mesmo jeito que a API. Dados 100% fictícios.
 */
import { describe, expect, it } from 'vitest';
import { criarApiFake } from './fake';
import { MENSAGENS } from './http';
import { mudancaDeNascimentoExigeDocumento, podeConferirDocumento } from './nascimento';

const HOJE = '2026-10-25';

describe('mudancaDeNascimentoExigeDocumento', () => {
  it.each([
    ['2000-01-01', '2012-01-01', true, 'adulto fica mais novo'],
    ['2014-10-25', '2015-01-01', true, 'fez 12 hoje e fica mais novo'],
    ['2014-10-26', '2015-01-01', false, 'ainda tem 11'],
    ['2000-01-01', '1999-01-01', false, 'fica mais velho'],
    ['2018-05-10', '2019-05-10', false, 'criança'],
    ['', '2010-01-01', true, 'data atual desconhecida: falha fechada'],
    [null, '2010-01-01', true, 'data atual nula'],
    ['2000-01-01', '', false, 'apagar a data'],
    ['2000-01-01', '2000-01-01', false, 'mesma data'],
  ] as [string | null, string, boolean, string][])('%s → %s = %s (%s)', (atual, proposto, esperado) => {
    expect(mudancaDeNascimentoExigeDocumento(atual, proposto, HOJE)).toBe(esperado);
  });

  it('só admin e profissional conferem', () => {
    expect(podeConferirDocumento('admin')).toBe(true);
    expect(podeConferirDocumento('profissional')).toBe(true);
    expect(podeConferirDocumento('recepcao')).toBe(false);
  });
});

describe('adaptador falso: alterarPaciente', () => {
  const agora = new Date(2026, 9, 25, 10, 0);

  it('reduzir a idade de adulto sem conferência: recusa com a mensagem da API (422)', async () => {
    const api = criarApiFake({ agora });
    const antes = (await api.obterPaciente('p01'))!;
    await expect(api.alterarPaciente('p01', { nascimento: '2016-01-01' })).rejects.toMatchObject({
      status: 422,
      codigo: 'documento_nao_conferido',
      message: MENSAGENS.documentoNaoConferido,
    });
    expect((await api.obterPaciente('p01'))!.nascimento).toBe(antes.nascimento);
    const p = await api.alterarPaciente('p01', { nascimento: '2016-01-01', documentoConferido: true });
    expect(p.nascimento).toBe('2016-01-01');
  });

  it('recepção não declara a conferência (403); muda telefone e aumenta idade sem documento', async () => {
    const api = criarApiFake({ agora, papel: 'recepcao' });
    await expect(api.alterarPaciente('p01', { nascimento: '2016-01-01', documentoConferido: true })).rejects.toMatchObject({
      status: 403,
      codigo: 'conferencia_exige_perfil',
    });
    const p = await api.alterarPaciente('p01', { telefone: '(11) 90000-0101', nascimento: '1950-01-01' });
    expect(p).toMatchObject({ telefone: '(11) 90000-0101', nascimento: '1950-01-01' });
  });

  it('paciente inativo não muda (409)', async () => {
    const api = criarApiFake({ agora });
    await api.inativarPaciente('p02', 'Outro');
    await expect(api.alterarPaciente('p02', { telefone: '(11) 90000-0102' })).rejects.toMatchObject({ status: 409, message: MENSAGENS.inativo });
  });

  it('conferência sem data e data futura são recusadas (400), como na API', async () => {
    const api = criarApiFake({ agora });
    await expect(api.alterarPaciente('p01', { telefone: '(11) 90000-0101', documentoConferido: true })).rejects.toMatchObject({
      status: 400,
      message: 'Confira conferência do documento: algum dado não está certo.',
    });
    await expect(api.alterarPaciente('p01', { nascimento: '2026-10-26', documentoConferido: true })).rejects.toMatchObject({
      status: 400,
      message: 'Confira data de nascimento: algum dado não está certo.',
    });
    expect((await api.obterPaciente('p01'))?.telefone).not.toBe('(11) 90000-0101');
  });
});
