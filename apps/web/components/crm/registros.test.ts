import { describe, expect, it } from 'vitest';
import { filtrarPorStatus, filtrarPorTexto, ordenarRegistros, paginarRegistros } from './registros';

interface Registro {
  id: string;
  nome: string;
  status: string;
  posicao: number;
}

const registros: Registro[] = [
  { id: '1', nome: 'João Pereira', status: 'ativo', posicao: 2 },
  { id: '2', nome: 'Maria Silva', status: 'inativo', posicao: 1 },
  { id: '3', nome: 'Ana Souza', status: 'ativo', posicao: 3 },
  { id: '4', nome: 'Maria Silva', status: 'ativo', posicao: 4 },
];

describe('filtrarPorTexto', () => {
  it('ignora acentos e maiúsculas sem alterar os registros', () => {
    const antes = structuredClone(registros);
    expect(filtrarPorTexto(registros, '  JOAO ', (r) => r.nome).map((r) => r.id)).toEqual(['1']);
    expect(registros).toEqual(antes);
  });

  it('usa todas as palavras da busca e devolve tudo quando ela está vazia', () => {
    expect(filtrarPorTexto(registros, 'silva maria', (r) => r.nome).map((r) => r.id)).toEqual(['2', '4']);
    expect(filtrarPorTexto(registros, '', (r) => r.nome).map((r) => r.id)).toEqual(['1', '2', '3', '4']);
  });
});

describe('filtrarPorStatus', () => {
  it('separa ativos e inativos, mantendo “todos” sem filtro', () => {
    expect(filtrarPorStatus(registros, 'ativo', (r) => r.status).map((r) => r.id)).toEqual(['1', '3', '4']);
    expect(filtrarPorStatus(registros, 'inativo', (r) => r.status).map((r) => r.id)).toEqual(['2']);
    expect(filtrarPorStatus(registros, 'todos', (r) => r.status).map((r) => r.id)).toEqual(['1', '2', '3', '4']);
  });
});

describe('ordenarRegistros', () => {
  it('ordena texto nas duas direções sem mutar a entrada', () => {
    const antes = structuredClone(registros);
    expect(ordenarRegistros(registros, (r) => r.nome, 'ascendente').map((r) => r.id)).toEqual(['3', '1', '2', '4']);
    expect(ordenarRegistros(registros, (r) => r.nome, 'descendente').map((r) => r.id)).toEqual(['2', '4', '1', '3']);
    expect(registros).toEqual(antes);
  });

  it('ordena números por valor e mantém empates na ordem original', () => {
    expect(ordenarRegistros(registros, (r) => r.posicao, 'ascendente').map((r) => r.id)).toEqual(['2', '1', '3', '4']);
    expect(ordenarRegistros(registros, (r) => r.nome, 'ascendente').map((r) => r.id)).toEqual(['3', '1', '2', '4']);
  });
});

describe('paginarRegistros', () => {
  const itens = Array.from({ length: 25 }, (_, i) => i + 1);

  it('divide em páginas de dez e informa o total real', () => {
    expect(paginarRegistros(itens, 1, 10)).toEqual({ itens: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], pagina: 1, totalPaginas: 3, total: 25 });
    expect(paginarRegistros(itens, 3, 10)).toEqual({ itens: [21, 22, 23, 24, 25], pagina: 3, totalPaginas: 3, total: 25 });
  });

  it('limita páginas inválidas e mantém uma página vazia utilizável', () => {
    expect(paginarRegistros(itens, 99, 10).pagina).toBe(3);
    expect(paginarRegistros(itens, 0, 10).pagina).toBe(1);
    expect(paginarRegistros([], 4, 10)).toEqual({ itens: [], pagina: 1, totalPaginas: 1, total: 0 });
  });
});
