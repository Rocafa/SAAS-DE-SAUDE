import { describe, expect, it } from 'vitest';
import { indexarPorId } from './indexar';

describe('indexarPorId', () => {
  it('acha pelo id e não perde ninguém', () => {
    const itens = [{ id: 'a', nome: 'Ana' }, { id: 'b', nome: 'Bruno' }];
    const mapa = indexarPorId(itens);
    expect(mapa.get('b')?.nome).toBe('Bruno');
    expect(mapa.size).toBe(2);
    expect(mapa.get('nao-existe')).toBeUndefined();
  });

  it('lista vazia dá índice vazio', () => {
    expect(indexarPorId([]).size).toBe(0);
  });
});
