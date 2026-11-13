import { describe, expect, it } from 'vitest';
import { EntradaInvalidaError } from '../../common/validacao';
import { CONSELHOS } from '../../db/schema';
import { validarRegistroNoConselho } from './scheduling.validation';

function campos(fn: () => unknown): string[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof EntradaInvalidaError) return [...e.campos];
    throw e;
  }
  return [];
}

describe('validarRegistroNoConselho (0074)', () => {
  it('aceita os conselhos da lista e o número como o conselho escreve', () => {
    for (const conselho of CONSELHOS) expect(validarRegistroNoConselho({ conselho, registro: '3/123456-F' })).toEqual({ conselho, registro: '3/123456-F' });
    expect(validarRegistroNoConselho({ conselho: 'CRP', registro: '06.12345' })).toEqual({ conselho: 'CRP', registro: '06.12345' });
  });

  it('recusa conselho fora da lista, número com espaço, @ ou longo demais, e campo a mais (sem ecoar o valor)', () => {
    expect(campos(() => validarRegistroNoConselho({ conselho: 'XYZ', registro: '1' }))).toContain('conselho');
    expect(campos(() => validarRegistroNoConselho({ conselho: 'CREFITO', registro: 'Fulano de Tal' }))).toContain('registro');
    // R2 do parecer: sem dígito é nome, não número.
    expect(campos(() => validarRegistroNoConselho({ conselho: 'CREFITO', registro: 'FulanoDeTal' }))).toContain('registro');
    expect(campos(() => validarRegistroNoConselho({ conselho: 'CREFITO', registro: 'nome@exemplo' }))).toContain('registro');
    expect(campos(() => validarRegistroNoConselho({ conselho: 'CREFITO', registro: '1'.repeat(31) }))).toContain('registro');
    expect(campos(() => validarRegistroNoConselho({ conselho: 'CREFITO' }))).toContain('registro');
    expect(campos(() => validarRegistroNoConselho({ conselho: 'CREFITO', registro: '1', nome: 'x' })).length).toBeGreaterThan(0);
  });
});
