/**
 * Escolha do paciente ao marcar consulta (condição F-1 do Guardião): no modo http a escolha usa a
 * busca do servidor (`buscarPacientes`), não a lista completa que pode parar no teto de 1.000.
 * Dados 100% fictícios.
 */
import { describe, expect, it, vi } from 'vitest';
import { criarApiFake } from './api/fake';
import { comTruncado, type Paciente } from './api/tipos';
import { buscarParaEscolha, LIMITE_SUGESTOES, sugestoesParaEscolha, TERMO_MINIMO } from './selecao-paciente';

const pac = (id: string, nome: string, ativo = true): Paciente => ({
  id,
  nome,
  telefone: '(11) 90000-0000',
  cpf: '',
  nascimento: '',
  responsaveis: [],
  ativo,
  ficticio: true,
});

describe('buscarParaEscolha', () => {
  it('modo http: usa buscarPacientes com o termo e não carrega a lista completa', async () => {
    const buscar = vi.fn(async () => comTruncado([pac('a', 'Ana Teste')], false));
    const listar = vi.fn(async () => comTruncado([], false));
    const r = await buscarParaEscolha({ ...criarApiFake(), buscarPacientes: buscar, listarPacientes: listar }, '  Ana ');
    expect(buscar).toHaveBeenCalledWith('Ana');
    expect(listar).not.toHaveBeenCalled();
    expect(r?.map((p) => p.id)).toEqual(['a']);
  });

  it('modo http: termo abaixo do mínimo não busca nada', async () => {
    const buscar = vi.fn(async () => comTruncado([], false));
    const api = { ...criarApiFake(), buscarPacientes: buscar };
    expect(TERMO_MINIMO).toBe(2);
    expect(await buscarParaEscolha(api, 'a')).toBeNull();
    expect(await buscarParaEscolha(api, '   ')).toBeNull();
    expect(buscar).not.toHaveBeenCalled();
  });

  it('modo http: mantém o `truncado` que veio do servidor', async () => {
    const api = { ...criarApiFake(), buscarPacientes: async () => comTruncado([pac('a', 'Ana Teste')], true) };
    expect((await buscarParaEscolha(api, 'Ana'))?.truncado).toBe(true);
  });

  it('sem buscarPacientes (fake): devolve null para a tela usar a lista local', async () => {
    const api = criarApiFake();
    expect(api.buscarPacientes).toBeUndefined();
    expect(await buscarParaEscolha(api, 'Bruno')).toBeNull();
  });
});

describe('sugestoesParaEscolha', () => {
  it('resultado do servidor: só ativos, até o limite, e avisa que há mais', () => {
    const lista = comTruncado(
      [pac('x', 'Ana Inativa', false), ...Array.from({ length: LIMITE_SUGESTOES + 2 }, (_, i) => pac(`a${i}`, `Ana ${i}`))],
      false,
    );
    const s = sugestoesParaEscolha({ termo: 'Ana', doServidor: lista, local: [] });
    expect(s.itens).toHaveLength(LIMITE_SUGESTOES);
    expect(s.itens.some((p) => p.id === 'x')).toBe(false);
    expect(s.haMais).toBe(true);
    expect(s.truncado).toBe(false);
  });

  it('resultado do servidor truncado: repassa o truncado para a tela mostrar o aviso', () => {
    const s = sugestoesParaEscolha({ termo: 'Ana', doServidor: comTruncado([pac('a', 'Ana')], true), local: [] });
    expect(s.truncado).toBe(true);
  });

  it('lista local (fake): procura por nome e repassa o truncado da lista', () => {
    const local = comTruncado([pac('a', 'Bruno Teste'), pac('b', 'Carla Teste')], true);
    const s = sugestoesParaEscolha({ termo: 'Bruno', doServidor: null, local });
    expect(s.itens.map((p) => p.id)).toEqual(['a']);
    expect(s.haMais).toBe(false);
    expect(s.truncado).toBe(true);
  });

  it('sem termo: nenhuma sugestão', () => {
    const s = sugestoesParaEscolha({ termo: '  ', doServidor: null, local: [pac('a', 'Bruno')] });
    expect(s.itens).toEqual([]);
  });
});
