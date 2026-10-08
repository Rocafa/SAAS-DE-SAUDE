/**
 * CSV RFC 4180 (vírgula, CRLF, todos os campos entre aspas) com BOM UTF-8 para abrir
 * acentuação corretamente em planilhas. Campos que começam com = + - @ TAB CR — também após
 * espaços/quebras de linha iniciais e nas formas fullwidth (U+FF1D, U+FF0B, U+FF0D, U+FF20), que algumas planilhas
 * normalizam — recebem um apóstrofo à frente para neutralizar injeção de fórmula (CWE-1236).
 */
const FORMULA_PREFIX = /^(?:[\t\r]|\s*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20])/;
export const UTF8_BOM = String.fromCharCode(0xfeff);

export function csvField(value: string | number | null): string {
  let text = value === null ? '' : String(value);
  if (FORMULA_PREFIX.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function toCsv(header: readonly string[], rows: readonly (readonly (string | number | null)[])[]): string {
  const lines = [header, ...rows].map((cols) => cols.map(csvField).join(','));
  return `${UTF8_BOM}${lines.join('\r\n')}\r\n`;
}
