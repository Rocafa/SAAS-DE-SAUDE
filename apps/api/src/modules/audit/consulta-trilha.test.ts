/** E10 de 04/11: validação dos filtros e do cursor da consulta da trilha. */
import { describe, expect, it } from 'vitest';
import { codificarCursor, decodificarCursor, LIMITE_PADRAO, metadataVisivel, validarFiltro } from './consulta-trilha';

const ID = '11111111-1111-4111-8111-111111111111';

describe('validarFiltro', () => {
  it('sem filtro: limite padrão', () => {
    expect(validarFiltro({})).toEqual({ limite: LIMITE_PADRAO });
    expect(validarFiltro(undefined)).toEqual({ limite: LIMITE_PADRAO });
  });

  it('aceita paciente, usuário, período, ação e limite', () => {
    expect(validarFiltro({ pacienteId: ID, usuarioId: ID, de: '2026-11-01', ate: '2026-11-04', acao: 'read', limite: '20' })).toEqual({
      pacienteId: ID,
      usuarioId: ID,
      de: '2026-11-01',
      ate: '2026-11-04',
      acao: 'read',
      limite: 20,
    });
  });

  it('recusa campo desconhecido, id inválido, data inválida, período invertido, ação fora da lista e limite fora da faixa', () => {
    for (const q of [
      { nome: 'Maria' },
      { pacienteId: '123' },
      { de: '2026-13-01' },
      { de: '2026-11-05', ate: '2026-11-01' },
      { acao: 'drop_table' },
      { limite: '0' },
      { limite: '101' },
      { cursor: 'lixo' },
    ]) {
      expect(() => validarFiltro(q), JSON.stringify(q)).toThrow();
    }
  });
});

describe('cursor', () => {
  it('é o id da última linha; ida e volta; adulterado vira null', () => {
    const c = codificarCursor(ID);
    expect(decodificarCursor(c)).toBe(ID);
    expect(decodificarCursor(Buffer.from('2026-11-04T10:00:00.123Z|x').toString('base64url'))).toBeNull();
    expect(validarFiltro({ cursor: c }).cursor).toBe(ID);
  });
});

describe('período (fila do parecer do #135)', () => {
  it('até 366 dias passa; mais que isso, 400', () => {
    expect(validarFiltro({ de: '2025-11-05', ate: '2026-11-04' })).toMatchObject({ de: '2025-11-05', ate: '2026-11-04' });
    expect(() => validarFiltro({ de: '2025-01-01', ate: '2026-11-04' })).toThrow();
    expect(validarFiltro({ de: '2026-11-04', ate: '2026-11-04' })).toMatchObject({ de: '2026-11-04' });
  });
});

describe('metadataVisivel (R4 do parecer do #135)', () => {
  it('só ids e códigos da lista fechada; detalhes que passam do necessário ficam fora', () => {
    expect(metadataVisivel({ op: 'x', patient_id: ID, hidden: true, template: 'psicologia', export_consent: true, private_notes: 3 })).toEqual({ op: 'x', patient_id: ID });
  });
});
