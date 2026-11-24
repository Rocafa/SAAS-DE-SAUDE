/**
 * Código de demonstração só em modo fake (issues #145 e #146). A varredura falha se a sequência do código
 * aparecer em qualquer arquivo de apps/web fora da lista fechada abaixo, para o valor não voltar ao cliente.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CODIGO_DE_DEMONSTRACAO, codigoDeDemonstracaoAceito } from './acesso-demonstracao';

const RAIZ_WEB = fileURLToPath(new URL('..', import.meta.url));
const SEQUENCIA = '123456';
/** Lista fechada: caminhos relativos a apps/web (com /) onde a sequência pode aparecer. */
const ARQUIVOS_PERMITIDOS = ['lib/acesso-demonstracao.ts'];
const PASTAS_IGNORADAS = new Set(['node_modules', '.next', 'test-results', 'playwright-report', 'coverage']);
const ARQUIVO_DE_TESTE = /\.(test|spec)\.[cm]?[jt]sx?$/;

function arquivosDe(pasta: string): string[] {
  return readdirSync(pasta, { withFileTypes: true }).flatMap((entrada) => {
    const caminho = join(pasta, entrada.name);
    if (entrada.isDirectory()) return PASTAS_IGNORADAS.has(entrada.name) ? [] : arquivosDe(caminho);
    return [caminho];
  });
}

describe('código de demonstração das telas de acesso', () => {
  it('é aceito em modo fake', () => {
    expect(codigoDeDemonstracaoAceito(CODIGO_DE_DEMONSTRACAO, 'fake')).toBe(true);
  });

  it('é recusado em modo http', () => {
    expect(codigoDeDemonstracaoAceito(CODIGO_DE_DEMONSTRACAO, 'http')).toBe(false);
  });

  it('código errado é recusado em modo fake', () => {
    expect(codigoDeDemonstracaoAceito('000000', 'fake')).toBe(false);
  });

  it('a sequência do código não aparece em nenhum arquivo de apps/web fora da lista permitida', () => {
    const achados = arquivosDe(RAIZ_WEB)
      .filter((caminho) => !ARQUIVO_DE_TESTE.test(caminho))
      .map((caminho) => relative(RAIZ_WEB, caminho).split(sep).join('/'))
      .filter((relativo) => !ARQUIVOS_PERMITIDOS.includes(relativo))
      .filter((relativo) => readFileSync(join(RAIZ_WEB, relativo), 'utf8').includes(SEQUENCIA));
    expect(achados, 'use codigoDeDemonstracaoAceito de lib/acesso-demonstracao.ts').toEqual([]);
  });

  it('a lista de permitidos só tem arquivos que existem e que contêm a sequência', () => {
    for (const relativo of ARQUIVOS_PERMITIDOS) {
      expect(readFileSync(join(RAIZ_WEB, relativo), 'utf8')).toContain(SEQUENCIA);
    }
  });
});
