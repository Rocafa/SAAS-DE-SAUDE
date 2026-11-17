import { describe, expect, it } from 'vitest';
import { f, conferirForma, chavesDaForma, ehDataAAAAMMDD } from '../src/forma.js';

describe('forma: validação de forma em runtime', () => {
  const Usuario = f.obj({
    id: f.texto,
    nome: f.texto,
    idade: f.inteiro,
    ativo: f.bool,
  });

  it('conferirForma aceita objeto válido', () => {
    const erros = conferirForma(Usuario, { id: '1', nome: 'Ana', idade: 30, ativo: true });
    expect(erros).toEqual([]);
  });

  it('conferirForma rejeita campo faltando', () => {
    const erros = conferirForma(Usuario, { id: '1', nome: 'Ana' });
    expect(erros).toContain('$.idade: campo obrigatório ausente');
    expect(erros).toContain('$.ativo: campo obrigatório ausente');
  });

  it('conferirForma rejeita tipo errado', () => {
    const erros = conferirForma(Usuario, { id: '1', nome: 'Ana', idade: 'trinta', ativo: true });
    expect(erros.some((e) => e.includes('$.idade') && e.includes('inteiro'))).toBe(true);
  });

  it('conferirForma rejeita campo extra', () => {
    const erros = conferirForma(Usuario, { id: '1', nome: 'Ana', idade: 30, ativo: true, extra: 'x' });
    expect(erros.some((e) => e.includes('extra') && e.includes('fora do contrato'))).toBe(true);
  });

  it('conferirForma com campo opcional aceita ausência', () => {
    const ComOpcional = f.obj({ id: f.texto, nome: f.opcional(f.texto) });
    const erros = conferirForma(ComOpcional, { id: '1' });
    expect(erros).toEqual([]);
  });

  it('chavesDaForma retorna todas as chaves incluindo aninhadas', () => {
    const chaves = chavesDaForma(Usuario);
    expect(chaves.sort()).toEqual(['ativo', 'id', 'idade', 'nome']);
  });

  it('ehDataAAAAMMDD aceita formato válido', () => {
    expect(ehDataAAAAMMDD('2026-01-15')).toBe(true);
    expect(ehDataAAAAMMDD('2026-12-31')).toBe(true);
  });

  it('ehDataAAAAMMDD rejeita formato inválido', () => {
    expect(ehDataAAAAMMDD('15/01/2026')).toBe(false);
    expect(ehDataAAAAMMDD('2026-1-1')).toBe(false);
    expect(ehDataAAAAMMDD('not-a-date')).toBe(false);
    expect(ehDataAAAAMMDD('')).toBe(false);
  });

  it('ehDataAAAAMMDD rejeita datas impossíveis', () => {
    expect(ehDataAAAAMMDD('2026-02-30')).toBe(false);
    expect(ehDataAAAAMMDD('2026-13-01')).toBe(false);
  });
});