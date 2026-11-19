import { describe, expectTypeOf, it } from 'vitest';
import type { PaginaPorCursor } from '../src/paginacao.js';

describe('PaginaPorCursor: contrato de tipos', () => {
  it('proximoCursor aceita string ou null', () => {
    expectTypeOf<PaginaPorCursor<number>['proximoCursor']>().toEqualTypeOf<string | null>();
  });

  it('proximoCursor é obrigatório e não aceita undefined', () => {
    const semCursor = {
      itens: [1],
      pagina: 1,
      limite: 1,
      temMais: false,
    } as const;

    // @ts-expect-error: null representa o fim da paginação no JSON; undefined é recusado
    const comUndefined: PaginaPorCursor<number> = { ...semCursor, proximoCursor: undefined };
    // @ts-expect-error: proximoCursor é obrigatório
    const omitido: PaginaPorCursor<number> = semCursor;

    void comUndefined;
    void omitido;
  });

  it('campos não podem ser reatribuídos', () => {
    const pagina: PaginaPorCursor<number> = {
      itens: [1],
      pagina: 1,
      limite: 1,
      temMais: false,
      proximoCursor: null,
    };

    // @ts-expect-error: pagina é readonly
    pagina.pagina = 2;
  });

  it('itens não permite mutação da lista', () => {
    const pagina: PaginaPorCursor<number> = {
      itens: [1],
      pagina: 1,
      limite: 1,
      temMais: false,
      proximoCursor: null,
    };

    // @ts-expect-error: itens é readonly
    pagina.itens.push(2);
  });
});
