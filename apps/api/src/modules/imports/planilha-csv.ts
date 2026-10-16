/**
 * Leitura de planilha CSV para o importador (MIG-01.1). Sem dependência externa: RFC 4180 com as variações
 * que as planilhas brasileiras produzem (separador `;` do Excel pt-BR, `,` ou TAB; CRLF ou LF; BOM).
 *
 * XLSX NÃO é aceito no MVP (decisão registrada em api-dominio.md §10): a única biblioteca madura de leitura
 * (SheetJS) não recebe correção no registro npm desde 0.18.5 (CVE-2023-30533 e CVE-2024-22363 abertas lá),
 * e as alternativas descompactam ZIP e interpretam XML do arquivo enviado (bomba de descompressão, entidades
 * XML) com uma árvore grande de dependências. A clínica salva a planilha como "CSV UTF-8" — todo editor
 * de planilha oferece — e o resto do fluxo é igual.
 *
 * Limites (falha fechada): arquivo ≤ 5 MiB, ≤ 10.000 linhas de dados, ≤ 60 colunas, célula ≤ 1.000
 * caracteres; texto tem de ser UTF-8 válido. O conteúdo NUNCA vai para log nem para mensagem de erro.
 */

export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const IMPORT_MAX_LINHAS = 10_000;
export const IMPORT_MAX_COLUNAS = 60;
export const IMPORT_MAX_CELULA = 1_000;

/** Motivo de recusa do arquivo inteiro: só um código (o conteúdo não volta na resposta). */
export class PlanilhaInvalidaError extends Error {
  override readonly name = 'PlanilhaInvalidaError';
  constructor(readonly codigo: 'arquivo_vazio' | 'codificacao_invalida' | 'arquivo_malformado' | 'linhas_demais' | 'colunas_demais' | 'celula_longa' | 'sem_cabecalho') {
    super(`planilha inválida: ${codigo}`);
  }
}

export interface Planilha {
  readonly separador: ',' | ';' | '\t';
  /** Cabeçalho (primeira linha não vazia). */
  readonly cabecalho: readonly string[];
  /** Linhas de dados com o número da linha FÍSICA na planilha (cabeçalho = 1). */
  readonly linhas: readonly { readonly numero: number; readonly celulas: readonly string[] }[];
}

/** Assinatura de ZIP (XLSX, ODS): `PK\x03\x04`. */
export function pareceZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** Decodifica UTF-8 estrito (byte inválido = erro) e tira o BOM. */
export function decodificarUtf8(bytes: Uint8Array): string {
  let texto: string;
  try {
    texto = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new PlanilhaInvalidaError('codificacao_invalida');
  }
  // NUL no meio do texto é sinal de arquivo binário ou UTF-16.
  if (texto.includes('\u0000')) throw new PlanilhaInvalidaError('codificacao_invalida');
  return texto;
}

/** Separador mais frequente FORA de aspas na primeira linha. Empate: `;` (Excel pt-BR) > `,` > TAB. */
function detectarSeparador(texto: string): ',' | ';' | '\t' {
  const contagem = { ';': 0, ',': 0, '\t': 0 };
  let emAspas = false;
  for (const c of texto) {
    if (c === '"') emAspas = !emAspas;
    else if (!emAspas && (c === '\n' || c === '\r')) break;
    else if (!emAspas && (c === ';' || c === ',' || c === '\t')) contagem[c]++;
  }
  if (contagem[';'] >= contagem[','] && contagem[';'] >= contagem['\t'] && contagem[';'] > 0) return ';';
  if (contagem[','] >= contagem['\t'] && contagem[','] > 0) return ',';
  return contagem['\t'] > 0 ? '\t' : ';';
}

/** Lê o CSV (texto já decodificado). Linhas totalmente vazias são ignoradas. */
export function lerCsv(texto: string): Planilha {
  if (texto.trim().length === 0) throw new PlanilhaInvalidaError('arquivo_vazio');
  const separador = detectarSeparador(texto);
  const registros: { numero: number; celulas: string[] }[] = [];
  let celulas: string[] = [];
  let celula = '';
  let emAspas = false;
  let fechouAspas = false;
  let linhaFisica = 1;
  let inicioDoRegistro = 1;

  const fecharCelula = () => {
    if (celula.length > IMPORT_MAX_CELULA) throw new PlanilhaInvalidaError('celula_longa');
    celulas.push(celula);
    if (celulas.length > IMPORT_MAX_COLUNAS) throw new PlanilhaInvalidaError('colunas_demais');
    celula = '';
    fechouAspas = false;
  };
  const fecharRegistro = () => {
    fecharCelula();
    if (!(celulas.length === 1 && celulas[0]?.trim() === '')) {
      registros.push({ numero: inicioDoRegistro, celulas });
      // Cabeçalho + 10.000 linhas de dados.
      if (registros.length > IMPORT_MAX_LINHAS + 1) throw new PlanilhaInvalidaError('linhas_demais');
    }
    celulas = [];
  };

  for (let i = 0; i < texto.length; i++) {
    const c = texto[i] as string;
    if (emAspas) {
      if (c === '"') {
        if (texto[i + 1] === '"') {
          celula += '"';
          i++;
        } else {
          emAspas = false;
          fechouAspas = true;
        }
      } else {
        if (c === '\n') linhaFisica++;
        celula += c;
        if (celula.length > IMPORT_MAX_CELULA) throw new PlanilhaInvalidaError('celula_longa');
      }
      continue;
    }
    if (c === '"') {
      // Aspas só abrem no início da célula (RFC 4180); no meio é texto malformado.
      if (celula.trim().length > 0 || fechouAspas) throw new PlanilhaInvalidaError('arquivo_malformado');
      celula = '';
      emAspas = true;
    } else if (c === separador) {
      fecharCelula();
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && texto[i + 1] === '\n') i++;
      fecharRegistro();
      linhaFisica++;
      inicioDoRegistro = linhaFisica;
    } else {
      if (fechouAspas && c.trim().length > 0) throw new PlanilhaInvalidaError('arquivo_malformado');
      celula += c;
      if (celula.length > IMPORT_MAX_CELULA) throw new PlanilhaInvalidaError('celula_longa');
    }
  }
  if (emAspas) throw new PlanilhaInvalidaError('arquivo_malformado');
  if (celula.length > 0 || celulas.length > 0) fecharRegistro();

  const [cabecalho, ...linhas] = registros;
  if (!cabecalho) throw new PlanilhaInvalidaError('sem_cabecalho');
  return {
    separador,
    cabecalho: cabecalho.celulas.map((h) => h.trim()),
    linhas: linhas.map((l) => ({ numero: l.numero, celulas: l.celulas })),
  };
}

/**
 * Injeção de fórmula (CWE-1236): célula que começa com = + - @ TAB ou CR — também após espaços e nas formas
 * fullwidth. Mesma regra do CSV da exportação (exports/csv.ts).
 */
const FORMULA = /^(?:[\t\r]|\s*[=+\-@＝＋－＠])/;

export function pareceFormula(valor: string): boolean {
  return FORMULA.test(valor);
}

/** Valor para o relatório de divergências: fórmula ganha um apóstrofo à frente (neutralizada). */
export function neutralizarFormula(valor: string): string {
  return pareceFormula(valor) ? `'${valor}` : valor;
}
