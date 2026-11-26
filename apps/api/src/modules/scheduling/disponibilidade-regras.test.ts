import { describe, expect, it } from 'vitest';
import { paraInstante } from './agenda-regras';
import {
  datasDoHorario,
  dentroDaGrade,
  diaDaSemana,
  domingoDePascoa,
  feriadosNacionais,
  motivoIndisponivel,
  problemaNasJanelas,
  type JanelaDaGrade,
} from './disponibilidade-regras';
import { validarAno, validarGrade, validarNovoBloqueio, validarNovoFeriado } from './disponibilidade.validation';

const SEG_MANHA: JanelaDaGrade = { diaSemana: 1, inicio: '08:00', fim: '12:00', minutos: 50 };
const SEG_TARDE: JanelaDaGrade = { diaSemana: 1, inicio: '14:00', fim: '18:00', minutos: 50 };
// 2030-05-06 é segunda-feira.
const h = (data: string, hora: string, minutos = 50) => {
  const inicio = paraInstante(data, hora);
  return { inicio, fim: new Date(inicio.getTime() + minutos * 60_000) };
};

describe('grade semanal', () => {
  it('dia da semana da data de calendário (0 = domingo)', () => {
    expect(diaDaSemana('2030-05-05')).toBe(0);
    expect(diaDaSemana('2030-05-06')).toBe(1);
    expect(diaDaSemana('2030-05-11')).toBe(6);
  });

  it('horário inteiro dentro de uma janela do dia passa; fora, encostando no intervalo ou noutro dia, não', () => {
    const g = [SEG_MANHA, SEG_TARDE];
    let x = h('2030-05-06', '08:00');
    expect(dentroDaGrade(g, x.inicio, x.fim)).toBe(true);
    x = h('2030-05-06', '11:10');
    expect(dentroDaGrade(g, x.inicio, x.fim)).toBe(true); // termina 12:00 exatas
    x = h('2030-05-06', '11:30');
    expect(dentroDaGrade(g, x.inicio, x.fim)).toBe(false); // invade o almoço
    x = h('2030-05-06', '07:30');
    expect(dentroDaGrade(g, x.inicio, x.fim)).toBe(false);
    x = h('2030-05-06', '12:30');
    expect(dentroDaGrade(g, x.inicio, x.fim)).toBe(false);
    x = h('2030-05-07', '08:00'); // terça
    expect(dentroDaGrade(g, x.inicio, x.fim)).toBe(false);
  });

  it('usa o fuso da clínica, não o UTC (08:00 de Brasília é 11:00 UTC)', () => {
    const x = h('2030-05-06', '08:00');
    expect(x.inicio.toISOString()).toBe('2030-05-06T11:00:00.000Z');
    expect(dentroDaGrade([SEG_MANHA], x.inicio, x.fim)).toBe(true);
  });

  it('janelas: fim depois do início e sem sobreposição no mesmo dia (encostadas valem)', () => {
    expect(problemaNasJanelas([SEG_MANHA, SEG_TARDE])).toBeNull();
    expect(problemaNasJanelas([SEG_MANHA, { ...SEG_TARDE, inicio: '12:00' }])).toBeNull();
    expect(problemaNasJanelas([SEG_MANHA, { ...SEG_TARDE, inicio: '11:00' }])).toBe('janelas_sobrepostas');
    expect(problemaNasJanelas([SEG_MANHA, { ...SEG_MANHA, diaSemana: 2 }])).toBeNull();
    expect(problemaNasJanelas([{ ...SEG_MANHA, fim: '08:00' }])).toBe('janela_invalida');
  });
});

describe('motivo de indisponibilidade', () => {
  const fora = h('2030-05-06', '19:00');
  const base = { feriado: false, bloqueado: false, janelas: [SEG_MANHA], encaixe: false, ...fora };

  it('fora da grade recusa; sem grade configurada não restringe', () => {
    expect(motivoIndisponivel(base)).toBe('fora_da_grade');
    expect(motivoIndisponivel({ ...base, janelas: [] })).toBeNull();
  });

  it('encaixe ignora a grade, mas não o bloqueio nem o feriado', () => {
    expect(motivoIndisponivel({ ...base, encaixe: true })).toBeNull();
    expect(motivoIndisponivel({ ...base, encaixe: true, bloqueado: true })).toBe('horario_bloqueado');
    expect(motivoIndisponivel({ ...base, encaixe: true, feriado: true })).toBe('feriado');
  });

  it('ordem: feriado, bloqueio, grade', () => {
    expect(motivoIndisponivel({ ...base, feriado: true, bloqueado: true })).toBe('feriado');
    expect(motivoIndisponivel({ ...base, bloqueado: true })).toBe('horario_bloqueado');
  });

  it('datas tocadas pelo horário (atravessar a meia-noite conta as duas)', () => {
    let x = h('2030-05-06', '08:00');
    expect(datasDoHorario(x.inicio, x.fim)).toEqual(['2030-05-06']);
    x = h('2030-05-06', '23:30', 60);
    expect(datasDoHorario(x.inicio, x.fim)).toEqual(['2030-05-06', '2030-05-07']);
    x = h('2030-05-06', '23:00', 60); // termina 00:00 exatas: só o dia do início
    expect(datasDoHorario(x.inicio, x.fim)).toEqual(['2030-05-06']);
  });
});

describe('feriados nacionais', () => {
  it('Páscoa pelo algoritmo gregoriano', () => {
    expect(domingoDePascoa(2025)).toBe('2025-04-20');
    expect(domingoDePascoa(2026)).toBe('2026-04-05');
    expect(domingoDePascoa(2030)).toBe('2030-04-21');
  });

  it('lista do ano: fixos, Paixão de Cristo e Consciência Negra; ordenada; nomes curtos', () => {
    const l = feriadosNacionais(2026);
    expect(l).toHaveLength(10);
    expect(l.map((f) => f.data)).toEqual([...l.map((f) => f.data)].sort());
    expect(l).toContainEqual({ data: '2026-09-07', nome: 'Independência do Brasil' });
    expect(l).toContainEqual({ data: '2026-04-03', nome: 'Paixão de Cristo' });
    expect(l.some((f) => f.data === '2026-11-20')).toBe(true);
    for (const f of l) expect(f.nome.length).toBeLessThanOrEqual(60);
  });
});

describe('validação da configuração', () => {
  it('grade: lista de janelas com dia 0–6, HH:MM e duração 5–480; nada além disso', () => {
    expect(validarGrade({ janelas: [{ diaSemana: 1, inicio: '08:00', fim: '12:00', minutos: 50 }] })).toEqual([SEG_MANHA]);
    expect(validarGrade({ janelas: [] })).toEqual([]);
    expect(() => validarGrade({ janelas: [{ diaSemana: 7, inicio: '08:00', fim: '12:00', minutos: 50 }] })).toThrow();
    expect(() => validarGrade({ janelas: [{ diaSemana: 1, inicio: '8h', fim: '12:00', minutos: 50 }] })).toThrow();
    expect(() => validarGrade({ janelas: [{ ...SEG_MANHA, extra: 1 }] })).toThrow();
    expect(() => validarGrade({ janelas: 'seg' })).toThrow();
    expect(() => validarGrade({ janelas: Array.from({ length: 43 }, () => SEG_MANHA) })).toThrow();
  });

  it('bloqueio: motivo só da lista fechada (texto livre poderia levar dado de paciente)', () => {
    expect(validarNovoBloqueio({ dataInicio: '2030-07-01', dataFim: '2030-07-15', motivo: 'ferias' })).toEqual({
      dataInicio: '2030-07-01',
      horaInicio: '00:00',
      dataFim: '2030-07-15',
      motivo: 'ferias',
    });
    expect(() => validarNovoBloqueio({ dataInicio: '2030-07-01', dataFim: '2030-07-15', motivo: 'consulta da Maria' })).toThrow();
    expect(() => validarNovoBloqueio({ dataInicio: '2030-07-01', dataFim: '2030-07-15', motivo: 'ferias', descricao: 'x' })).toThrow();
    expect(() => validarNovoBloqueio({ dataInicio: '2030-02-30', dataFim: '2030-07-15', motivo: 'ferias' })).toThrow();
  });

  it('feriado: data válida e nome até 60; ano entre 2024 e 2100 (número no corpo, texto na query)', () => {
    expect(validarNovoFeriado({ data: '2030-01-20', nome: 'Padroeiro' })).toEqual({ data: '2030-01-20', nome: 'Padroeiro' });
    // Caracteres de controle no nome (recomendação do Guardião no #244): recusados.
    for (const nome of ['Padro\u0007eiro', 'Padro\neiro', 'Padro\teiro', 'Padro\u0085eiro', 'Padro eiro']) {
      expect(() => validarNovoFeriado({ data: '2030-01-20', nome })).toThrow();
    }
    expect(() => validarNovoFeriado({ data: '2030-01-20', nome: 'x'.repeat(61) })).toThrow();
    expect(validarAno({ ano: 2030 })).toBe(2030);
    expect(validarAno({ ano: '2030' })).toBe(2030);
    expect(() => validarAno({ ano: 2023 })).toThrow();
    expect(() => validarAno({})).toThrow();
  });
});
