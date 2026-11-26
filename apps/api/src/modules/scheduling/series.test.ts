import { describe, expect, it } from 'vitest';
import { EntradaInvalidaError } from '../../common/validacao';
import { datasDaSerie, diaDaSemanaDe, MAXIMO_SESSOES_DA_SERIE, resumirStatus } from './series-regras';
import { SerieComConflitoError } from './series.service';
import { validarCancelamentoDeSerie, validarFiltroSeries, validarNovaSerie } from './series.validation';

const PAC = '11111111-1111-4111-8111-111111111111';
const PROF = '22222222-2222-4222-8222-222222222222';
const TIPO = '33333333-3333-4333-8333-333333333333';
const PACOTE = '44444444-4444-4444-8444-444444444444';

function campos(fn: () => unknown): readonly string[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof EntradaInvalidaError) return e.campos;
    throw e;
  }
  throw new Error('era esperado erro de validação');
}

describe('datasDaSerie (regra de recorrência)', () => {
  it('semanal às quintas: N sessões a partir da data inicial', () => {
    // 2030-05-02 é quinta-feira.
    expect(diaDaSemanaDe('2030-05-02')).toBe(4);
    expect(datasDaSerie({ dias: [4], intervaloSemanas: 1, dataInicial: '2030-05-02', sessoes: 4 })).toEqual([
      '2030-05-02',
      '2030-05-09',
      '2030-05-16',
      '2030-05-23',
    ]);
  });

  it('data inicial no meio da semana: só dias a partir dela; dois dias por semana', () => {
    // 2030-05-01 é quarta: a terça da mesma semana (2030-04-30) não entra.
    expect(datasDaSerie({ dias: [2, 4], intervaloSemanas: 1, dataInicial: '2030-05-01', sessoes: 3 })).toEqual(['2030-05-02', '2030-05-07', '2030-05-09']);
  });

  it('quinzenal: a semana da data inicial é a primeira, depois de duas em duas', () => {
    expect(datasDaSerie({ dias: [1], intervaloSemanas: 2, dataInicial: '2030-05-06', sessoes: 3 })).toEqual(['2030-05-06', '2030-05-20', '2030-06-03']);
  });

  it('data final inclusiva no lugar do número de sessões', () => {
    expect(datasDaSerie({ dias: [1, 3], intervaloSemanas: 1, dataInicial: '2030-05-06', dataFinal: '2030-05-15' })).toEqual([
      '2030-05-06',
      '2030-05-08',
      '2030-05-13',
      '2030-05-15',
    ]);
  });

  it('sem nenhuma data no intervalo: vazio; longa demais: para no teto + 1 (quem chama recusa)', () => {
    expect(datasDaSerie({ dias: [0], intervaloSemanas: 1, dataInicial: '2030-05-06', dataFinal: '2030-05-10' })).toEqual([]);
    const todas = datasDaSerie({ dias: [0, 1, 2, 3, 4, 5, 6], intervaloSemanas: 1, dataInicial: '2030-01-01', dataFinal: '2030-12-31' });
    expect(todas).toHaveLength(MAXIMO_SESSOES_DA_SERIE + 1);
  });

  it('atravessa a virada de mês e de ano sem pular nem repetir', () => {
    expect(datasDaSerie({ dias: [2], intervaloSemanas: 1, dataInicial: '2030-12-24', sessoes: 3 })).toEqual(['2030-12-24', '2030-12-31', '2031-01-07']);
  });
});

describe('resumirStatus', () => {
  it('agrupa por situação da sessão', () => {
    expect(
      resumirStatus([
        { status: 'scheduled', n: 2 },
        { status: 'confirmed', n: 1 },
        { status: 'completed', n: 3 },
        { status: 'checked_in', n: 1 },
        { status: 'no_show', n: 1 },
        { status: 'cancelled', n: 4 },
      ]),
    ).toEqual({ agendadas: 3, realizadas: 4, faltas: 1, canceladas: 4 });
  });
});

describe('validarNovaSerie', () => {
  const base = { pacienteId: PAC, profissionalId: PROF, tipoId: TIPO, dias: [4, 2], hora: '18:00', dataInicial: '2030-05-02', sessoes: 20 };

  it('aceita o corpo mínimo, ordena os dias e põe intervalo semanal', () => {
    expect(validarNovaSerie(base)).toEqual({ ...base, dias: [2, 4], intervaloSemanas: 1 });
  });

  it('aceita pacote, duração própria, quinzenal e data final', () => {
    const { sessoes: _s, ...semSessoes } = base;
    void _s;
    expect(validarNovaSerie({ ...semSessoes, pacoteId: PACOTE, minutos: 45, intervaloSemanas: 2, dataFinal: '2030-08-01' })).toMatchObject({
      pacoteId: PACOTE,
      minutos: 45,
      intervaloSemanas: 2,
      dataFinal: '2030-08-01',
    });
  });

  it('exatamente um de sessões e data final', () => {
    expect(campos(() => validarNovaSerie({ ...base, dataFinal: '2030-06-01' }))).toContain('dataFinal');
    const { sessoes: _s, ...semSessoes } = base;
    void _s;
    expect(campos(() => validarNovaSerie(semSessoes))).toContain('sessoes');
  });

  it('recusa dias inválidos, repetidos ou vazios, hora e datas inválidas, limites e campo extra', () => {
    expect(campos(() => validarNovaSerie({ ...base, dias: [] }))).toContain('dias');
    expect(campos(() => validarNovaSerie({ ...base, dias: [1, 1] }))).toContain('dias');
    expect(campos(() => validarNovaSerie({ ...base, dias: [7] }))).toContain('dias');
    expect(campos(() => validarNovaSerie({ ...base, dias: '1' }))).toContain('dias');
    expect(campos(() => validarNovaSerie({ ...base, hora: '24:00' }))).toContain('hora');
    expect(campos(() => validarNovaSerie({ ...base, dataInicial: '2030-02-30' }))).toContain('dataInicial');
    expect(campos(() => validarNovaSerie({ ...base, sessoes: MAXIMO_SESSOES_DA_SERIE + 1 }))).toContain('sessoes');
    expect(campos(() => validarNovaSerie({ ...base, intervaloSemanas: 5 }))).toContain('intervaloSemanas');
    expect(campos(() => validarNovaSerie({ ...base, minutos: 4 }))).toContain('minutos');
    const { sessoes: _s, ...semSessoes } = base;
    void _s;
    expect(campos(() => validarNovaSerie({ ...semSessoes, dataFinal: '2030-05-01' }))).toContain('dataFinal');
    expect(campos(() => validarNovaSerie({ ...semSessoes, dataFinal: '2031-05-04' }))).toContain('dataFinal');
    expect(() => validarNovaSerie({ ...base, observacao: 'x' })).toThrow();
  });
});

describe('cancelamento e filtro', () => {
  it('cancelar exige a data', () => {
    expect(validarCancelamentoDeSerie({ aPartirDe: '2030-05-09' })).toEqual({ aPartirDe: '2030-05-09' });
    expect(campos(() => validarCancelamentoDeSerie({}))).toContain('aPartirDe');
    expect(campos(() => validarCancelamentoDeSerie({ aPartirDe: 'amanha' }))).toContain('aPartirDe');
  });

  it('filtro só com uuids conhecidos', () => {
    expect(validarFiltroSeries({ pacienteId: PAC })).toEqual({ pacienteId: PAC });
    expect(validarFiltroSeries(undefined)).toEqual({});
    expect(campos(() => validarFiltroSeries({ pacienteId: 'x' }))).toContain('pacienteId');
  });
});

describe('SerieComConflitoError', () => {
  it('409 com código estável e só as datas', () => {
    const e = new SerieComConflitoError(['2030-05-09']);
    expect(e.getStatus()).toBe(409);
    expect(e.getResponse()).toEqual({ statusCode: 409, message: 'Conflito', codigo: 'serie_com_conflito', datas: ['2030-05-09'] });
  });
});
