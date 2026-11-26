import { describe, expect, it } from 'vitest';
import { EntradaInvalidaError } from '../../common/validacao';
import { diaDaSemana, normalizarDias, OBSERVACAO_MAX, periodoDaHora, SEM_PREFERENCIA, textoDaPreferencia } from './lista-espera-regras';
import { validarFiltroEspera, validarMarcacaoDaEspera, validarNovoItemEspera, validarRetirada } from './lista-espera.validation';

const PAC = '11111111-1111-4111-8111-111111111111';
const PROF = '22222222-2222-4222-8222-222222222222';
const TIPO = '33333333-3333-4333-8333-333333333333';

function campos(fn: () => unknown): readonly string[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof EntradaInvalidaError) return [...e.campos].sort();
    throw e;
  }
  throw new Error('era esperado erro de validação');
}

describe('lista de espera: regras puras', () => {
  it('texto da preferência: dias, período e observação; nada = "Qualquer horário" (como o fake)', () => {
    expect(textoDaPreferencia([], null, null)).toBe(SEM_PREFERENCIA);
    expect(textoDaPreferencia([4, 2], 'manha', null)).toBe('ter, qui · manhã');
    expect(textoDaPreferencia([0, 1, 2, 3, 4, 5, 6], 'noite', 'Avisar pelo WhatsApp')).toBe('noite · Avisar pelo WhatsApp');
  });

  it('período da hora: manhã até 11:59, tarde até 17:59, noite depois', () => {
    expect(['07:00', '11:59', '12:00', '17:59', '18:00'].map(periodoDaHora)).toEqual(['manha', 'manha', 'tarde', 'tarde', 'noite']);
  });

  it('dia da semana da data de calendário (domingo = 0) e dias sem repetição, em ordem', () => {
    expect(diaDaSemana('2030-05-05')).toBe(0);
    expect(diaDaSemana('2030-05-11')).toBe(6);
    expect(normalizarDias([5, 1, 5, 3])).toEqual([1, 3, 5]);
  });
});

describe('lista de espera: validação', () => {
  it('POST: paciente obrigatório; estruturado opcional; `preferencia` do fake vira a observação', () => {
    expect(validarNovoItemEspera({ pacienteId: PAC })).toEqual({ pacienteId: PAC, dias: [], periodo: null, observacao: null });
    expect(validarNovoItemEspera({ pacienteId: PAC, profissionalId: PROF, dias: [3, 1, 1], periodo: 'tarde', observacao: ' Só depois das 15h ' })).toEqual({
      pacienteId: PAC,
      profissionalId: PROF,
      dias: [1, 3],
      periodo: 'tarde',
      observacao: 'Só depois das 15h',
    });
    expect(validarNovoItemEspera({ pacienteId: PAC, preferencia: 'Manhãs, terça ou quinta' }).observacao).toBe('Manhãs, terça ou quinta');
    // O front manda '' quando nada foi digitado.
    expect(validarNovoItemEspera({ pacienteId: PAC, preferencia: '' }).observacao).toBeNull();
  });

  it('POST: observação curta (limite), sem quebra de linha, e não com `preferencia` junto; campos desconhecidos recusados', () => {
    expect(campos(() => validarNovoItemEspera({ pacienteId: PAC, observacao: 'x'.repeat(OBSERVACAO_MAX + 1) }))).toEqual(['observacao']);
    expect(campos(() => validarNovoItemEspera({ pacienteId: PAC, observacao: 'linha 1\nlinha 2' }))).toEqual(['observacao']);
    expect(campos(() => validarNovoItemEspera({ pacienteId: PAC, observacao: 'a', preferencia: 'b' }))).toEqual(['preferencia']);
    expect(campos(() => validarNovoItemEspera({ pacienteId: PAC, tenantId: PROF }))).toEqual(['campo_desconhecido']);
    expect(campos(() => validarNovoItemEspera({}))).toEqual(['pacienteId']);
  });

  it('POST: dias só inteiros 0–6 (no máximo 7) e período da lista fechada', () => {
    for (const dias of [[7], [-1], [1.5], ['1'], 'seg', [0, 1, 2, 3, 4, 5, 6, 0]]) {
      expect(campos(() => validarNovoItemEspera({ pacienteId: PAC, dias }))).toEqual(['dias']);
    }
    expect(campos(() => validarNovoItemEspera({ pacienteId: PAC, periodo: 'madrugada' }))).toEqual(['periodo']);
  });

  it('GET: vaga por data e hora vira dia da semana e período', () => {
    expect(validarFiltroEspera(undefined)).toEqual({});
    expect(validarFiltroEspera({ profissionalId: PROF, data: '2030-05-07', hora: '09:00' })).toEqual({ profissionalId: PROF, dia: 2, periodo: 'manha' });
    expect(campos(() => validarFiltroEspera({ data: '2030-02-30' }))).toEqual(['data']);
    expect(campos(() => validarFiltroEspera({ hora: '25:00' }))).toEqual(['hora']);
  });

  it('DELETE: motivo `retirado` (padrão) ou `desistencia`; `agendado` só pela rota de marcar', () => {
    expect(validarRetirada({})).toBe('retirado');
    expect(validarRetirada({ motivo: 'desistencia' })).toBe('desistencia');
    expect(campos(() => validarRetirada({ motivo: 'agendado' }))).toEqual(['motivo']);
  });

  it('marcar: corpo do POST /agendamentos sem paciente (vem do item); profissional opcional', () => {
    expect(validarMarcacaoDaEspera({ tipoId: TIPO, data: '2030-05-07', hora: '09:00' })).toEqual({ tipoId: TIPO, data: '2030-05-07', hora: '09:00', encaixe: false });
    expect(validarMarcacaoDaEspera({ profissionalId: PROF, tipoId: TIPO, data: '2030-05-07', hora: '09:00', encaixe: true })).toMatchObject({ profissionalId: PROF, encaixe: true });
    expect(campos(() => validarMarcacaoDaEspera({ pacienteId: PAC, tipoId: TIPO, data: '2030-05-07', hora: '09:00' }))).toEqual(['campo_desconhecido']);
    expect(campos(() => validarMarcacaoDaEspera({ profissionalId: 'x', tipoId: TIPO, data: '2030-05-07', hora: '9h' }))).toEqual(['hora', 'profissionalId']);
  });
});
