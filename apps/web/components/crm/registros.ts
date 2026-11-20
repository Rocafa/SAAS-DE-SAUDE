import { normalizar } from '@/lib/texto';

export type DirecaoOrdenacao = 'ascendente' | 'descendente';

export function filtrarPorTexto<T>(registros: readonly T[], termo: string, texto: (registro: T) => string): T[] {
  const palavras = normalizar(termo).split(' ').filter(Boolean);
  if (palavras.length === 0) return [...registros];
  return registros.filter((registro) => {
    const conteudo = normalizar(texto(registro));
    return palavras.every((palavra) => conteudo.includes(palavra));
  });
}

export function filtrarPorStatus<T>(registros: readonly T[], status: string, obterStatus: (registro: T) => string): T[] {
  return status === 'todos' ? [...registros] : registros.filter((registro) => obterStatus(registro) === status);
}

export function ordenarRegistros<T>(
  registros: readonly T[],
  valor: (registro: T) => string | number,
  direcao: DirecaoOrdenacao,
): T[] {
  const fator = direcao === 'ascendente' ? 1 : -1;
  return [...registros].sort((a, b) => {
    const va = valor(a);
    const vb = valor(b);
    const comparacao = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), 'pt-BR');
    return comparacao * fator;
  });
}

function inteiroPositivo(valor: number): number {
  return Number.isFinite(valor) ? Math.max(1, Math.floor(valor)) : 1;
}

export function paginarRegistros<T>(registros: readonly T[], pagina: number, porPagina: number) {
  const tamanho = inteiroPositivo(porPagina);
  const total = registros.length;
  const totalPaginas = Math.max(1, Math.ceil(total / tamanho));
  const atual = Math.min(inteiroPositivo(pagina), totalPaginas);
  const inicio = (atual - 1) * tamanho;
  return { itens: registros.slice(inicio, inicio + tamanho), pagina: atual, totalPaginas, total };
}
