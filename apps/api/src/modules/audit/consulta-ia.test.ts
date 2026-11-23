import { describe, expect, it } from 'vitest';
import { codificarCursor } from './consulta-trilha';
import { LIMITE_PADRAO_IA, paraCsvAuditoriaIa, validarFiltroIa, type LinhaAuditoriaIaDto } from './consulta-ia';

const ID = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const ID3 = '33333333-3333-4333-8333-333333333333';

describe('filtro da auditoria de IA', () => {
  it('aceita período, profissional, finalidade, limite e cursor', () => {
    const cursor = codificarCursor(ID);
    expect(
      validarFiltroIa({ de: '2026-11-01', ate: '2026-11-23', profissionalId: ID2, finalidade: 'escriba', limite: '20', cursor }),
    ).toEqual({ de: '2026-11-01', ate: '2026-11-23', profissionalId: ID2, finalidade: 'escriba', limite: 20, cursor: ID });
    expect(validarFiltroIa({})).toEqual({ limite: LIMITE_PADRAO_IA });
  });

  it.each([
    { nome: 'Paciente Ficticio' },
    { profissionalId: '123' },
    { finalidade: 'drop_table' },
    { de: '2026-13-01' },
    { de: '2026-11-23', ate: '2026-11-01' },
    { de: '2024-01-01', ate: '2026-01-01' },
    { limite: '0' },
    { limite: '101' },
    { cursor: 'lixo' },
  ])('recusa filtro inválido: %p', (query) => {
    expect(() => validarFiltroIa(query)).toThrow();
  });
});

describe('CSV da auditoria de IA', () => {
  it('exporta os metadados e neutraliza fórmula sem incluir conteúdo clínico', () => {
    const item: LinhaAuditoriaIaDto = {
      id: ID,
      usoId: ID2,
      em: '2026-11-23T12:00:00.000Z',
      finalidade: 'escriba',
      usuarioId: ID2,
      pacienteId: ID3,
      profissionalId: ID3,
      modelo: '=modelo-ficticio',
      versaoModelo: '1.2.3',
      promptHash: 'a'.repeat(64),
      saidaHash: 'b'.repeat(64),
      tokensEntrada: 10,
      tokensCache: 5,
      tokensSaida: 7,
      latenciaMs: 25,
      revisaoHumana: true,
      decisao: 'editada',
      revisadoEm: '2026-11-23T12:01:00.000Z',
      revisorId: ID2,
      saidaFinalHash: 'c'.repeat(64),
      chaveHash: 'local-v1',
    };
    const csv = paraCsvAuditoriaIa([item]);
    expect(csv.startsWith('﻿"em","finalidade","usuarioId","pacienteId"')).toBe(true);
    expect(csv).toContain('"\'=modelo-ficticio"');
    expect(csv).toContain('"editada"');
    expect(csv).toContain(`"${'c'.repeat(64)}"`);
    expect(csv).toContain('"saidaFinalHash","chaveHash","id"');
    expect(csv).toContain('"local-v1"');
    expect(csv).not.toContain('Paciente Ficticio');
    expect(csv).not.toContain('000.000.000-00');
    expect(csv).not.toContain('transcrição');
  });
});
