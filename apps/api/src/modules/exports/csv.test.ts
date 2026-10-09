import { describe, expect, it } from 'vitest';
import { csvField, toCsv, UTF8_BOM } from './csv';

describe('CSV aberto (RFC 4180)', () => {
  it('escapa aspas, vírgulas e quebras de linha', () => {
    expect(csvField('Ana "Ficticia", Souza\nlinha 2')).toBe('"Ana ""Ficticia"", Souza\nlinha 2"');
    expect(csvField(null)).toBe('""');
  });

  it('neutraliza injeção de fórmula', () => {
    expect(csvField('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvField('+1')).toBe(`"'+1"`);
    expect(csvField('@cmd')).toBe(`"'@cmd"`);
  });

  it('BOM UTF-8, cabeçalho e CRLF', () => {
    expect(UTF8_BOM.charCodeAt(0)).toBe(0xfeff);
    expect(toCsv(['id', 'nome'], [['1', 'Paciente Ficticio']])).toBe(
      `${UTF8_BOM}"id","nome"\r\n"1","Paciente Ficticio"\r\n`,
    );
  });
});
