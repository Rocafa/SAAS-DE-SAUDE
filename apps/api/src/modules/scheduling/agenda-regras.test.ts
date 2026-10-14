import { AppointmentStatus } from '@plataforma/shared';
import { describe, expect, it } from 'vitest';
import { APPOINTMENT_STATUSES } from '../../db/schema';
import { EntradaInvalidaError } from '../../common/validacao';
import {
  capacidadeDoHorario,
  dentroDaJanelaDeAtendimento,
  JANELA_ATENDIMENTO_PADRAO,
  loadJanelaDeAtendimento,
  exigeAtendimento,
  janelaDeDias,
  noFusoDaClinica,
  paraInstante,
  STATUS_FRONT,
  statusParaDb,
  statusParaFront,
  transicaoPermitida,
} from './agenda-regras';
import { validarFiltroAgenda, validarNovoAgendamento } from './scheduling.validation';

describe('fuso da clínica (UTC-03:00)', () => {
  it('converte data/hora local em instante e volta', () => {
    const t = paraInstante('2030-03-04', '09:30');
    expect(t.toISOString()).toBe('2030-03-04T12:30:00.000Z');
    expect(noFusoDaClinica(t)).toEqual({ data: '2030-03-04', hora: '09:30' });
    expect(noFusoDaClinica(new Date('2030-03-05T01:00:00Z'))).toEqual({ data: '2030-03-04', hora: '22:00' });
  });

  it('janela de dias cobre do início do primeiro ao fim do último dia', () => {
    const { inicio, fim } = janelaDeDias('2030-03-04', '2030-03-04');
    expect(inicio.toISOString()).toBe('2030-03-04T03:00:00.000Z');
    expect(fim.toISOString()).toBe('2030-03-05T03:00:00.000Z');
  });
});

describe('status e transições', () => {
  it('vocabulário do front cobre exatamente os status do banco e do enum compartilhado', () => {
    expect(STATUS_FRONT.map(statusParaDb).sort()).toEqual([...APPOINTMENT_STATUSES].sort());
    expect([...APPOINTMENT_STATUSES].sort()).toEqual(Object.values(AppointmentStatus).sort());
    for (const s of STATUS_FRONT) expect(statusParaFront(statusParaDb(s))).toBe(s);
  });

  it('cancelado é final; desfazer check-in e falta é permitido', () => {
    for (const s of APPOINTMENT_STATUSES) expect(transicaoPermitida('cancelled', s)).toBe(false);
    expect(transicaoPermitida('checked_in', 'confirmed')).toBe(true);
    expect(transicaoPermitida('no_show', 'scheduled')).toBe(true);
    expect(transicaoPermitida('scheduled', 'completed')).toBe(false);
  });

  it('entrar/sair de atendimento exige o profissional', () => {
    expect(exigeAtendimento('checked_in', 'in_progress')).toBe(true);
    expect(exigeAtendimento('in_progress', 'checked_in')).toBe(true);
    expect(exigeAtendimento('scheduled', 'checked_in')).toBe(false);
  });

  it('capacidade do horário é a menor entre profissional e tipo', () => {
    expect(capacidadeDoHorario(4, 1)).toBe(1);
    expect(capacidadeDoHorario(2, 4)).toBe(2);
  });
});

describe('validação da agenda', () => {
  const ids = {
    pacienteId: '00000000-0000-4000-8000-000000000001',
    profissionalId: '00000000-0000-4000-8000-000000000002',
    tipoId: '00000000-0000-4000-8000-000000000003',
  };

  it('janela obrigatória de no máximo 31 dias, em ordem', () => {
    expect(validarFiltroAgenda({ de: '2030-03-01', ate: '2030-03-31' })).toEqual({ de: '2030-03-01', ate: '2030-03-31' });
    expect(() => validarFiltroAgenda({ de: '2030-03-01', ate: '2030-04-01' })).toThrow(EntradaInvalidaError);
    expect(() => validarFiltroAgenda({ de: '2030-03-02', ate: '2030-03-01' })).toThrow(EntradaInvalidaError);
    expect(() => validarFiltroAgenda({})).toThrow(EntradaInvalidaError);
    expect(() => validarFiltroAgenda({ de: '2030-03-01', ate: '2030-03-02', tenantId: ids.tipoId })).toThrow(EntradaInvalidaError);
  });

  it('novo agendamento: ids UUID, data e hora válidas, encaixe booleano', () => {
    expect(validarNovoAgendamento({ ...ids, data: '2030-03-04', hora: '09:00' })).toMatchObject({ encaixe: false });
    expect(() => validarNovoAgendamento({ ...ids, data: '2030-02-30', hora: '09:00' })).toThrow(EntradaInvalidaError);
    expect(() => validarNovoAgendamento({ ...ids, data: '2030-03-04', hora: '24:00' })).toThrow(EntradaInvalidaError);
    expect(() => validarNovoAgendamento({ ...ids, data: '2030-03-04', hora: '09:00', encaixe: 'sim' })).toThrow(EntradaInvalidaError);
    expect(() => validarNovoAgendamento({ ...ids, pacienteId: 'p1', data: '2030-03-04', hora: '09:00' })).toThrow(EntradaInvalidaError);
  });
});

describe('janela de atendimento (V1 do parecer #61)', () => {
  const inicio = new Date('2030-03-04T12:00:00Z');
  const fim = new Date('2030-03-04T12:50:00Z');
  const min = 60_000;
  const j = JANELA_ATENDIMENTO_PADRAO;

  it('de 30 min antes do início até 60 min depois do fim, bordas incluídas', () => {
    expect(dentroDaJanelaDeAtendimento(inicio, fim, new Date(inicio.getTime() - 30 * min), j)).toBe(true);
    expect(dentroDaJanelaDeAtendimento(inicio, fim, new Date(inicio.getTime() - 31 * min), j)).toBe(false);
    expect(dentroDaJanelaDeAtendimento(inicio, fim, new Date(fim.getTime() + 60 * min), j)).toBe(true);
    expect(dentroDaJanelaDeAtendimento(inicio, fim, new Date(fim.getTime() + 61 * min), j)).toBe(false);
  });

  it('nunca para o dia seguinte nem para 100 dias atrás', () => {
    expect(dentroDaJanelaDeAtendimento(inicio, fim, new Date(inicio.getTime() - 86_400_000), j)).toBe(false);
    expect(dentroDaJanelaDeAtendimento(inicio, fim, new Date(inicio.getTime() + 100 * 86_400_000), j)).toBe(false);
  });

  it('configurável pelo ambiente, com teto (2 h antes, 24 h depois); valor inválido derruba o boot', () => {
    expect(loadJanelaDeAtendimento({})).toEqual(JANELA_ATENDIMENTO_PADRAO);
    expect(
      loadJanelaDeAtendimento({ ATTENDANCE_WINDOW_BEFORE_MIN: '60', ATTENDANCE_WINDOW_AFTER_MIN: '120', SELF_SCHEDULED_ALERT_PER_DAY: '3' }),
    ).toEqual({ antesMin: 60, depoisMin: 120, alertaAutoagendadosPorDia: 3 });
    for (const env of [
      { ATTENDANCE_WINDOW_BEFORE_MIN: '121' },
      { ATTENDANCE_WINDOW_AFTER_MIN: '1441' },
      { ATTENDANCE_WINDOW_BEFORE_MIN: '-1' },
      { ATTENDANCE_WINDOW_AFTER_MIN: 'abc' },
    ]) {
      expect(() => loadJanelaDeAtendimento(env)).toThrow();
    }
  });
});
