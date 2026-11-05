import { describe, expect, it } from 'vitest';
import {
  alertasDe,
  diasEntre,
  hashDaConfirmacao,
  hojeNaClinica,
  LIMIARES_GUIA,
  LIMIARES_PACOTE,
  normalizarIdentificador,
  situacaoDe,
  somarDias,
  statusConsome,
} from './guias-regras';

const HOJE = '2026-10-14';
const guia = (usadas: number, validade: string | null, total = 10, cancelada = false) => ({ cancelada, total, usadas, validade });

describe('datas no fuso da clínica', () => {
  it('hoje vira o dia de Brasília (UTC-03:00)', () => {
    expect(hojeNaClinica(new Date('2026-10-15T02:59:00Z'))).toBe('2026-10-14');
    expect(hojeNaClinica(new Date('2026-10-15T03:00:00Z'))).toBe('2026-10-15');
  });

  it('dias entre datas e soma de dias', () => {
    expect(diasEntre('2026-10-14', '2026-10-21')).toBe(7);
    expect(diasEntre('2026-10-14', '2026-10-13')).toBe(-1);
    expect(diasEntre('2026-02-28', '2026-03-01')).toBe(1);
    expect(somarDias('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('situação calculada', () => {
  it('ativa, esgotada, vencida (precede esgotada) e cancelada', () => {
    expect(situacaoDe(guia(3, '2026-11-01'), HOJE)).toBe('ativa');
    expect(situacaoDe(guia(10, '2026-11-01'), HOJE)).toBe('esgotada');
    expect(situacaoDe(guia(3, '2026-10-13'), HOJE)).toBe('vencida');
    expect(situacaoDe(guia(10, '2026-10-13'), HOJE)).toBe('vencida');
    expect(situacaoDe(guia(3, '2026-11-01', 10, true), HOJE)).toBe('cancelada');
  });

  it('validade vale até o fim do dia: vence hoje ainda é ativa', () => {
    expect(situacaoDe(guia(0, HOJE), HOJE)).toBe('ativa');
  });

  it('pacote sem validade nunca vence', () => {
    expect(situacaoDe(guia(1, null), '2099-01-01')).toBe('ativa');
  });
});

describe('alertas (CNV-04.5)', () => {
  it('"vence em X dias" dentro do limiar, com os dias', () => {
    expect(alertasDe(guia(0, '2026-10-21'), HOJE, LIMIARES_GUIA)).toEqual([{ tipo: 'vence_em_breve', dias: 7 }]);
    expect(alertasDe(guia(0, '2026-10-22'), HOJE, LIMIARES_GUIA)).toEqual([]);
    expect(alertasDe(guia(0, HOJE), HOJE, LIMIARES_GUIA)).toEqual([{ tipo: 'vence_em_breve', dias: 0 }]);
  });

  it('"só resta 1 sessão" e esgotada', () => {
    expect(alertasDe(guia(9, '2027-01-01'), HOJE, LIMIARES_GUIA)).toEqual([{ tipo: 'ultimas_sessoes', restantes: 1 }]);
    expect(alertasDe(guia(8, '2027-01-01'), HOJE, LIMIARES_GUIA)).toEqual([]);
    expect(alertasDe(guia(8, '2027-01-01'), HOJE, LIMIARES_PACOTE)).toEqual([{ tipo: 'ultimas_sessoes', restantes: 2 }]);
    expect(alertasDe(guia(10, '2027-01-01'), HOJE, LIMIARES_GUIA)).toEqual([{ tipo: 'esgotada' }]);
  });

  it('guia vencida com saldo alerta; vencida e esgotada, não; cancelada nunca', () => {
    expect(alertasDe(guia(2, '2026-10-01'), HOJE, LIMIARES_GUIA)).toEqual([{ tipo: 'vencida' }]);
    expect(alertasDe(guia(10, '2026-10-01'), HOJE, LIMIARES_GUIA)).toEqual([]);
    expect(alertasDe(guia(9, '2026-10-15', 10, true), HOJE, LIMIARES_GUIA)).toEqual([]);
  });

  it('acumula última sessão e vencimento próximo', () => {
    expect(alertasDe(guia(9, '2026-10-16'), HOJE, LIMIARES_GUIA)).toEqual([
      { tipo: 'ultimas_sessoes', restantes: 1 },
      { tipo: 'vence_em_breve', dias: 2 },
    ]);
  });
});

describe('consumo e identificadores', () => {
  it('só check-in, em atendimento e atendido consomem', () => {
    expect(['checked_in', 'in_progress', 'completed'].every((s) => statusConsome(s as never))).toBe(true);
    expect(['scheduled', 'confirmed', 'no_show', 'cancelled'].some((s) => statusConsome(s as never))).toBe(false);
  });

  it('número da guia comparado sem pontuação e sem caixa', () => {
    expect(normalizarIdentificador(' 12.345-6/a ')).toBe('123456A');
  });

  it('hash da confirmação é determinístico e muda com qualquer campo', () => {
    const base = {
      tenantId: '11111111-1111-4111-8111-111111111111',
      consumoId: '22222222-2222-4222-8222-222222222222',
      agendamentoId: '33333333-3333-4333-8333-333333333333',
      guiaId: '44444444-4444-4444-8444-444444444444',
      meio: 'tela' as const,
      dispositivo: 'tablet-1',
      assinadaEm: new Date('2026-10-14T12:00:00.000Z'),
      registradoPor: '55555555-5555-4555-8555-555555555555',
    };
    const h = hashDaConfirmacao(base);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashDaConfirmacao({ ...base })).toBe(h);
    expect(hashDaConfirmacao({ ...base, meio: 'papel' })).not.toBe(h);
    expect(hashDaConfirmacao({ ...base, assinadaEm: new Date('2026-10-14T12:00:00.001Z') })).not.toBe(h);
  });
});
