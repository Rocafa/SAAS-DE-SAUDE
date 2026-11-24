import { describe, expect, it } from 'vitest';
import { codificarCursor } from './consulta-trilha';
import {
  juntarEventosIa,
  LIMITE_PADRAO_IA,
  paraCsvAuditoriaIa,
  validarFiltroIa,
  type EventoTrilhaIa,
  type LinhaAuditoriaIaDto,
} from './consulta-ia';

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
      chaveHashSaida: 'local-v1',
      chaveHashFinal: 'local-v1',
      status: 'sucesso',
      motivo: null,
      resultadoEm: '2026-11-23T12:00:01.000Z',
    };
    const csv = paraCsvAuditoriaIa([item]);
    expect(csv.startsWith('﻿"em","finalidade","usuarioId","pacienteId"')).toBe(true);
    expect(csv).toContain('"\'=modelo-ficticio"');
    expect(csv).toContain('"editada"');
    expect(csv).toContain(`"${'c'.repeat(64)}"`);
    expect(csv).toContain('"saidaFinalHash","chaveHash","chaveHashSaida","chaveHashFinal","id"');
    expect(csv).toContain('"latenciaMs","status","motivo","resultadoEm"');
    expect(csv).toContain('"local-v1"');
    expect(csv).not.toContain('Paciente Ficticio');
    expect(csv).not.toContain('000.000.000-00');
    expect(csv).not.toContain('transcrição');
  });
});

describe('junção tentativa + resultado + revisão (item 3 do veto do #227)', () => {
  const U1 = '44444444-4444-4444-8444-444444444444';
  const U2 = '55555555-5555-4555-8555-555555555555';
  const ev = (id: string, scope: string, em: string, metadata: Record<string, unknown>): EventoTrilhaIa => ({
    id,
    createdAt: new Date(em),
    actorId: ID2,
    scope,
    metadata,
  });

  it('uma linha por tentativa; a sem resultado aparece como sem_resultado; mais recente primeiro', () => {
    const linhas = juntarEventosIa([
      ev(ID, 'ai_attempt', '2026-11-23T10:00:00Z', { use_id: U1, task: 'escriba', patient_id: ID3, professional_id: ID2, model: 'fake/x', model_version: '1', prompt_hash: 'a'.repeat(64), hash_key_id: 'local-v1' }),
      ev(ID2, 'ai_result', '2026-11-23T10:00:02Z', { use_id: U1, status: 'sucesso', model: 'fake/x', model_version: '1.1', output_hash: 'b'.repeat(64), hash_key_id: 'local-v1', input_tokens: 10, cached_input_tokens: 2, output_tokens: 5, latency_ms: 2000, decision: 'pendente' }),
      ev(ID3, 'ai_review', '2026-11-23T10:05:00Z', { use_id: U1, reviewer_id: ID2, human_reviewed: true, decision: 'editada', final_output_hash: 'c'.repeat(64), hash_key_id: 'local-v1' }),
      ev('66666666-6666-4666-8666-666666666666', 'ai_attempt', '2026-11-23T11:00:00Z', { use_id: U2, task: 'escriba', prompt_hash: 'd'.repeat(64), hash_key_id: 'local-v1' }),
      ev('77777777-7777-4777-8777-777777777777', 'ai_refusal', '2026-11-23T12:00:00Z', { use_id: ID, task: 'escriba' }),
    ]);
    expect(linhas.map((l) => [l.usoId, l.status])).toEqual([
      [U2, 'sem_resultado'],
      [U1, 'sucesso'],
    ]);
    expect(linhas[0]).toMatchObject({ saidaHash: null, resultadoEm: null, decisao: null, revisaoHumana: false });
    expect(linhas[1]).toMatchObject({
      id: ID,
      em: '2026-11-23T10:00:00.000Z',
      versaoModelo: '1.1',
      promptHash: 'a'.repeat(64),
      saidaHash: 'b'.repeat(64),
      latenciaMs: 2000,
      resultadoEm: '2026-11-23T10:00:02.000Z',
      revisaoHumana: true,
      decisao: 'editada',
      revisadoEm: '2026-11-23T10:05:00.000Z',
      saidaFinalHash: 'c'.repeat(64),
      chaveHash: 'local-v1',
      chaveHashSaida: 'local-v1',
      chaveHashFinal: 'local-v1',
    });
  });

  it('resultado de erro por MAC indisponível sai com motivo e sem hash', () => {
    const [l] = juntarEventosIa([
      ev(ID, 'ai_attempt', '2026-11-23T10:00:00Z', { use_id: U1, task: 'escriba', prompt_hash: 'a'.repeat(64), hash_key_id: 'local-v1' }),
      ev(ID2, 'ai_result', '2026-11-23T10:00:01Z', { use_id: U1, status: 'erro', motivo: 'mac_indisponivel', output_hash: null, decision: 'nao_aplicavel' }),
    ]);
    expect(l).toMatchObject({ status: 'erro', motivo: 'mac_indisponivel', saidaHash: null, decisao: 'nao_aplicavel', chaveHashSaida: null });
  });
});
