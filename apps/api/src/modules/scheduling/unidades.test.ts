import { describe, expect, it } from 'vitest';
import { ConflitoError } from '../../common/erros-dominio';
import { EntradaInvalidaError } from '../../common/validacao';
import { validarNovoAgendamento, validarRemarcacao } from './scheduling.validation';
import { constraintDoErro, traduzirErroDeSala } from './sala-erros';
import {
  validarAlteracaoSala,
  validarAlteracaoUnidade,
  validarFiltroSalas,
  validarNovaSala,
  validarNovaUnidade,
} from './unidades.validation';

const UUID = '6f1c2b1e-8a1d-4c7e-9b1a-2f3e4d5c6b7a';

/** Erro como o postgres.js entrega, embrulhado em `cause` (como o drizzle faz). */
function erroDoBanco(constraint: string, code: string): Error {
  const pg = Object.assign(new Error('falha'), { code, constraint_name: constraint });
  return new Error('consulta falhou', { cause: pg });
}

function codigoDoConflito(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof ConflitoError ? e.codigo : undefined;
  }
  return undefined;
}

describe('sala-erros: gatilho da 0101 vira 409 com código', () => {
  it('sala ocupada, sala inativa e nome repetido', () => {
    expect(codigoDoConflito(() => traduzirErroDeSala(erroDoBanco('appointments_room_conflict', '23P01')))).toBe('sala_ocupada');
    expect(codigoDoConflito(() => traduzirErroDeSala(erroDoBanco('appointments_room_active', '23514')))).toBe('sala_inativa');
    expect(codigoDoConflito(() => traduzirErroDeSala(erroDoBanco('units_tenant_name_idx', '23505')))).toBe('nome_em_uso');
    expect(codigoDoConflito(() => traduzirErroDeSala(erroDoBanco('rooms_unit_name_idx', '23505')))).toBe('nome_em_uso');
  });

  it('outro erro passa intacto (nem toda violação vira conflito de sala)', () => {
    const original = erroDoBanco('appointments_patient_fk', '23503');
    expect(() => traduzirErroDeSala(original)).toThrow(original);
    const semCodigo = new Error('qualquer');
    expect(() => traduzirErroDeSala(semCodigo)).toThrow(semCodigo);
    expect(constraintDoErro('texto')).toBeUndefined();
  });
});

describe('validação de unidades e salas', () => {
  it('unidade: nome obrigatório, normalizado e sem chave desconhecida', () => {
    expect(validarNovaUnidade({ nome: '  Centro  ' })).toEqual({ nome: 'Centro' });
    expect(() => validarNovaUnidade({})).toThrow(EntradaInvalidaError);
    expect(() => validarNovaUnidade({ nome: '   ' })).toThrow(EntradaInvalidaError);
    expect(() => validarNovaUnidade({ nome: 'x'.repeat(101) })).toThrow(EntradaInvalidaError);
    expect(() => validarNovaUnidade({ nome: 'Centro', clinicaId: UUID })).toThrow(EntradaInvalidaError);
  });

  it('alteração exige ao menos um campo', () => {
    expect(validarAlteracaoUnidade({ ativa: false })).toEqual({ ativa: false });
    expect(() => validarAlteracaoUnidade({})).toThrow(EntradaInvalidaError);
    expect(validarAlteracaoSala({ capacidade: 4 })).toEqual({ capacidade: 4 });
    expect(() => validarAlteracaoSala({})).toThrow(EntradaInvalidaError);
    expect(() => validarAlteracaoSala({ ativa: 'nao' })).toThrow(EntradaInvalidaError);
  });

  it('sala: unidade obrigatória, capacidade 1..20 (padrão 1)', () => {
    expect(validarNovaSala({ unidadeId: UUID, nome: 'Sala 2' })).toEqual({ unidadeId: UUID, nome: 'Sala 2', capacidade: 1 });
    expect(validarNovaSala({ unidadeId: UUID, nome: 'Ginasio', capacidade: 4 })).toMatchObject({ capacidade: 4 });
    expect(() => validarNovaSala({ nome: 'Sala 2' })).toThrow(EntradaInvalidaError);
    expect(() => validarNovaSala({ unidadeId: UUID, nome: 'Sala 2', capacidade: 0 })).toThrow(EntradaInvalidaError);
    expect(() => validarNovaSala({ unidadeId: UUID, nome: 'Sala 2', capacidade: 21 })).toThrow(EntradaInvalidaError);
    expect(validarFiltroSalas({})).toEqual({});
    expect(validarFiltroSalas({ unidadeId: UUID })).toEqual({ unidadeId: UUID });
    expect(() => validarFiltroSalas({ unidadeId: 'x' })).toThrow(EntradaInvalidaError);
  });

  it('agendamento: sala opcional na criação; na remarcação, ausente mantém e null tira', () => {
    const ids = { pacienteId: UUID, profissionalId: UUID, tipoId: UUID, data: '2030-03-04', hora: '09:00' };
    expect(validarNovoAgendamento(ids)).not.toHaveProperty('salaId');
    expect(validarNovoAgendamento({ ...ids, salaId: UUID })).toMatchObject({ salaId: UUID });
    expect(() => validarNovoAgendamento({ ...ids, salaId: 'sala-2' })).toThrow(EntradaInvalidaError);
    expect(validarRemarcacao({ data: '2030-03-04', hora: '10:00' })).toEqual({ data: '2030-03-04', hora: '10:00' });
    expect(validarRemarcacao({ data: '2030-03-04', hora: '10:00', salaId: null })).toEqual({ data: '2030-03-04', hora: '10:00', salaId: null });
    expect(validarRemarcacao({ data: '2030-03-04', hora: '10:00', salaId: UUID })).toMatchObject({ salaId: UUID });
    expect(() => validarRemarcacao({ data: '2030-03-04', hora: '10:00', salaId: 7 })).toThrow(EntradaInvalidaError);
  });
});
