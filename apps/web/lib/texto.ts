/**
 * Utilitários de texto para a busca do Ajudante: ignorar acento e maiúscula/minúscula e
 * tolerar erro de digitação ("joao", "joão", "joaõ", "jaoo").
 */

/** Minúsculas, sem acento, sem pontuação (mantém `:` e `/` por causa de hora e data). */
export function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s:/]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokens(texto: string): string[] {
  const n = normalizar(texto);
  return n ? n.split(' ') : [];
}

export function somenteDigitos(texto: string): string {
  return texto.replace(/\D/g, '');
}

/** Distância de edição com transposição de vizinhos (Damerau, versão OSA). */
export function distancia(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const custo = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + custo);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, d[i - 2]![j - 2]! + 1);
      }
      d[i]![j] = v;
    }
  }
  return d[a.length]![b.length]!;
}

/** Quantos erros aceitamos numa palavra digitada, conforme o tamanho dela. */
export function tolerancia(palavra: string): number {
  if (palavra.length >= 7) return 2;
  if (palavra.length >= 4) return 1;
  return 0;
}

/**
 * Nota de uma palavra digitada contra uma palavra do alvo:
 * 4 igual, 3 começo, 2 contém, 1 parecida (erro de digitação), 0 não bate.
 */
export function notaPalavra(digitada: string, alvo: string): number {
  if (!digitada || !alvo) return 0;
  if (digitada === alvo) return 4;
  if (alvo.startsWith(digitada)) return 3;
  if (digitada.length >= 3 && alvo.includes(digitada)) return 2;
  const tol = tolerancia(digitada);
  if (tol === 0) return 0;
  if (distancia(digitada, alvo) <= tol) return 1;
  // Palavra ainda sendo digitada: compara com o começo do alvo do mesmo tamanho.
  if (alvo.length > digitada.length && distancia(digitada, alvo.slice(0, digitada.length)) <= tol) return 1;
  return 0;
}

/**
 * Nota do texto digitado contra um texto alvo. Toda palavra digitada precisa bater com alguma
 * palavra do alvo; senão a nota é 0.
 */
export function notaTexto(consulta: string, alvo: string): number {
  const q = tokens(consulta);
  const t = tokens(alvo);
  if (!q.length || !t.length) return 0;
  let total = 0;
  for (const palavra of q) {
    let melhor = 0;
    for (const a of t) {
      const n = notaPalavra(palavra, a);
      if (n > melhor) melhor = n;
      if (melhor === 4) break;
    }
    if (melhor === 0) return 0;
    total += melhor;
  }
  return total / q.length;
}
