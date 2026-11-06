/** Regra de qual estado fica na tela enquanto a nova resposta não chega. */
import { describe, expect, it } from 'vitest';
import { aoRecarregar, type EstadoConsulta } from './dados';

const pronto: EstadoConsulta<number> = { estado: 'pronto', dados: 1 };

describe('aoRecarregar', () => {
  it('atualização em segundo plano não pisca a tela', () => {
    expect(aoRecarregar(pronto, true)).toBe(pronto);
  });

  it('pergunta nova volta a carregando, para não mostrar a resposta da pergunta antiga', () => {
    expect(aoRecarregar(pronto, false)).toEqual({ estado: 'carregando' });
  });

  it('erro e carregando sempre recomeçam', () => {
    expect(aoRecarregar({ estado: 'erro', mensagem: 'x', tentarDeNovo: () => {} }, true)).toEqual({ estado: 'carregando' });
    expect(aoRecarregar({ estado: 'carregando' }, true)).toEqual({ estado: 'carregando' });
  });
});
