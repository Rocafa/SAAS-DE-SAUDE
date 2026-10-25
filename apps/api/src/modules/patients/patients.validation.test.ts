import { describe, expect, it } from 'vitest';
import { EntradaInvalidaError } from '../../common/validacao';
import {
  nascimentoValido,
  normalizarBusca,
  normalizarCpf,
  normalizarTelefone,
  validarAlteracaoPaciente,
  validarBuscaPacientes,
  validarFiltroPacientes,
  validarNovoPaciente,
} from './patients.validation';

/** Campos que falharam (o erro nunca carrega o valor). */
function campos(fn: () => unknown): readonly string[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof EntradaInvalidaError) return e.campos;
    throw e;
  }
  throw new Error('era esperado erro de validação');
}

describe('documentos (valores fictícios)', () => {
  it('CPF: dígitos verificadores, máscara e sequência repetida', () => {
    expect(normalizarCpf('000.000.001-91')).toBe('00000000191');
    expect(normalizarCpf('00000000192')).toBeUndefined();
    expect(normalizarCpf('111.111.111-11')).toBeUndefined();
    expect(normalizarCpf('0000000019')).toBeUndefined();
    expect(normalizarCpf('abc')).toBeUndefined();
  });

  it('telefone: DDD + fixo ou celular, aceita +55 e máscara', () => {
    expect(normalizarTelefone('(11) 90000-0001')).toBe('11900000001');
    expect(normalizarTelefone('+55 11 3333-4444')).toBe('1133334444');
    expect(normalizarTelefone('01 90000-0001')).toBeUndefined();
    expect(normalizarTelefone('11 1000-0000')).toBeUndefined();
    expect(normalizarTelefone('telefone')).toBeUndefined();
  });

  it('nascimento: data real, não futura, a partir de 1900', () => {
    const hoje = new Date('2026-10-13T12:00:00Z');
    expect(nascimentoValido('1990-02-28', hoje)).toBe(true);
    expect(nascimentoValido('1990-02-30', hoje)).toBe(false);
    expect(nascimentoValido('2027-01-01', hoje)).toBe(false);
    expect(nascimentoValido('1899-12-31', hoje)).toBe(false);
  });

  it('busca: minúsculas, sem acento, espaços simples', () => {
    expect(normalizarBusca('  ÁGATA   Conceição ')).toBe('agata conceicao');
  });
});

describe('validação estrita de pacientes', () => {
  it('cadastro mínimo: nome e telefone; CPF e nascimento opcionais', () => {
    expect(validarNovoPaciente({ nome: ' Paciente  Ficticio ', telefone: '11 90000-0001' })).toEqual({
      nome: 'Paciente Ficticio',
      telefone: '11900000001',
    });
    expect(campos(() => validarNovoPaciente({}))).toEqual(['nome', 'telefone']);
  });

  it('campo desconhecido (inclusive tenantId) é recusado sem repetir o nome dele', () => {
    expect(campos(() => validarNovoPaciente({ nome: 'X', telefone: '11900000001', tenantId: 'qualquer' }))).toEqual([
      'campo_desconhecido',
    ]);
  });

  it('tipos errados, controle e tamanho', () => {
    expect(campos(() => validarNovoPaciente({ nome: 42, telefone: '11900000001' }))).toEqual(['nome']);
    expect(campos(() => validarNovoPaciente({ nome: 'a\nb', telefone: '11900000001' }))).toEqual(['nome']);
    expect(campos(() => validarNovoPaciente({ nome: 'x'.repeat(201), telefone: '11900000001' }))).toEqual(['nome']);
    expect(campos(() => validarNovoPaciente([]))).toEqual(['corpo']);
    expect(campos(() => validarNovoPaciente(null))).toEqual(['corpo']);
  });

  it('alteração: ao menos um campo; null limpa campo opcional; telefone não pode ser null', () => {
    expect(validarAlteracaoPaciente({ cpf: null })).toEqual({ cpf: null });
    expect(campos(() => validarAlteracaoPaciente({}))).toEqual(['corpo']);
    expect(campos(() => validarAlteracaoPaciente({ telefone: null }))).toEqual(['telefone']);
  });

  it('C1-b′: documentoConferido é booleano, só acompanha a data e não basta sozinho', () => {
    expect(validarAlteracaoPaciente({ nascimento: '2010-01-02', documentoConferido: true })).toEqual({ nascimento: '2010-01-02', documentoConferido: true });
    expect(campos(() => validarAlteracaoPaciente({ nascimento: '2010-01-02', documentoConferido: 'sim' }))).toEqual(['documentoConferido']);
    expect(campos(() => validarAlteracaoPaciente({ telefone: '11987654321', documentoConferido: true }))).toEqual(['documentoConferido']);
    expect(campos(() => validarNovoPaciente({ nome: 'Fulano Ficticio', telefone: '11987654321', documentoConferido: true }))).toEqual(['campo_desconhecido']);
  });

  it('filtro: limite máximo 100, página positiva, busca de 2 a 80 caracteres', () => {
    expect(validarFiltroPacientes({})).toEqual({ situacao: 'ativos', pagina: 1, limite: 50 });
    expect(validarFiltroPacientes({ limite: '100', pagina: '3', situacao: 'todos' })).toEqual({
      limite: 100,
      pagina: 3,
      situacao: 'todos',
    });
    expect(campos(() => validarFiltroPacientes({ limite: '101' }))).toEqual(['limite']);
    expect(campos(() => validarFiltroPacientes({ limite: ['1', '2'] }))).toEqual(['limite']);
    expect(campos(() => validarFiltroPacientes({ pagina: '-1' }))).toEqual(['pagina']);
  });

  it('termo de busca (ou qualquer texto livre) na query é recusado: a URL vai para logs do ALB/WAF', () => {
    for (const chave of ['busca', 'q', 'termo', 'nome', 'cpf', 'telefone']) {
      expect(campos(() => validarFiltroPacientes({ [chave]: 'Ana' })), chave).toEqual(['busca_na_url']);
    }
  });

  it('busca no corpo: termo de 2 a 80 caracteres, paginação numérica até 100', () => {
    expect(validarBuscaPacientes({ busca: 'Ána', limite: 100, pagina: 3, situacao: 'todos' })).toEqual({
      busca: 'ana',
      limite: 100,
      pagina: 3,
      situacao: 'todos',
    });
    expect(validarBuscaPacientes({ busca: 'ana' })).toEqual({ busca: 'ana', situacao: 'ativos', pagina: 1, limite: 50 });
    expect(campos(() => validarBuscaPacientes({}))).toEqual(['busca']);
    expect(campos(() => validarBuscaPacientes({ busca: 'a' }))).toEqual(['busca']);
    expect(campos(() => validarBuscaPacientes({ busca: 'x'.repeat(81) }))).toEqual(['busca']);
    expect(campos(() => validarBuscaPacientes({ busca: 'á́' }))).toEqual(['busca']);
    expect(campos(() => validarBuscaPacientes({ busca: 'ana', limite: 101 }))).toEqual(['limite']);
    expect(campos(() => validarBuscaPacientes({ busca: 'ana', limite: '10' }))).toEqual(['limite']);
    expect(campos(() => validarBuscaPacientes({ busca: 'ana', pagina: 0 }))).toEqual(['pagina']);
    expect(campos(() => validarBuscaPacientes({ busca: 'ana', tenantId: 'x' }))).toEqual(['campo_desconhecido']);
  });
});
