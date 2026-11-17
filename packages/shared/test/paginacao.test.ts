import { describe, expect, it } from 'vitest';
import { CURSOR_INVALIDO, type PaginaPorCursor } from '../src/paginacao.js';

describe('paginacao: interface e constantes', () => {
  it('CURSOR_INVALIDO tem valor correto', () => {
    expect(CURSOR_INVALIDO).toBe('cursor_invalido');
  });

  it('PaginaPorCursor aceita estrutura válida', () => {
    const pagina: PaginaPorCursor<string> = {
      itens: ['a', 'b', 'c'],
      pagina: 1,
      limite: 10,
      temMais: true,
      proximoCursor: 'cursor-base64-encoded',
    };
    expect(pagina.itens).toHaveLength(3);
    expect(pagina.pagina).toBe(1);
    expect(pagina.limite).toBe(10);
    expect(pagina.temMais).toBe(true);
    expect(pagina.proximoCursor).toBe('cursor-base64-encoded');
  });

  it('PaginaPorCursor aceita proximoCursor null quando não tem mais', () => {
    const pagina: PaginaPorCursor<number> = {
      itens: [1, 2],
      pagina: 2,
      limite: 2,
      temMais: false,
      proximoCursor: null,
    };
    expect(pagina.temMais).toBe(false);
    expect(pagina.proximoCursor).toBeNull();
  });

  it('PaginaPorCursor é readonly', () => {
    const pagina: PaginaPorCursor<string> = {
      itens: ['x'],
      pagina: 1,
      limite: 1,
      temMais: false,
      proximoCursor: null,
    };
    // @ts-expect-error: itens é readonly
    pagina.itens.push('y');
    // @ts-expect-error: pagina é readonly
    pagina.pagina = 2;
  });
});