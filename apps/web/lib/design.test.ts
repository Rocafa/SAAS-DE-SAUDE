/**
 * Design system em cinza: nenhuma cor com matiz nos tokens nem nas classes do código, e contraste
 * de texto >= 7:1 (AAA) no claro e no escuro. O CSS final do build é conferido por
 * scripts/checar-cinza.mjs (roda no "pnpm build") e as telas renderizadas pelo Playwright.
 */
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contraste, coresNaoCinza } from './cores.mjs';

const raiz = fileURLToPath(new URL('..', import.meta.url));
const css = readFileSync(join(raiz, 'app/globals.css'), 'utf8');

function tokens(bloco: string): Record<string, string> {
  return Object.fromEntries([...bloco.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1]!, m[2]!]));
}
const claro = tokens(css.slice(css.indexOf(':root {'), css.indexOf('@media (prefers-color-scheme: dark) {')));
const escuro = tokens(css.slice(css.indexOf('@media (prefers-color-scheme: dark) {')));

function fontes(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (['node_modules', '.next', 'e2e'].includes(n)) return [];
    if (statSync(p).isDirectory()) return fontes(p);
    return /\.(tsx|ts|css)$/.test(n) && !n.endsWith('.test.ts') ? [p] : [];
  });
}

describe('cores: só preto, branco e cinza', () => {
  it('o detector pega azul em qualquer formato', () => {
    for (const azul of ['#00f', '#2563eb', 'rgb(37, 99, 235)', 'rgb(37 99 235 / 50%)', 'hsl(220 90% 50%)', 'oklch(0.55 0.2 260)', 'oklab(0.5 -0.03 -0.2)', 'a{color:blue}']) {
      expect(coresNaoCinza(azul), azul).not.toHaveLength(0);
    }
    for (const cinza of ['#000', '#fff', '#767676', '#0000', 'rgb(10, 10, 10)', 'oklch(0.5 0 0)', 'hsl(0 0% 40%)', 'a{color:transparent}']) {
      expect(coresNaoCinza(cinza), cinza).toHaveLength(0);
    }
  });

  it('globals.css não tem cor com matiz', () => {
    expect(coresNaoCinza(css)).toEqual([]);
  });

  it('a paleta padrão do Tailwind foi apagada (bg-blue-500 não existe)', () => {
    expect(css).toMatch(/--color-\*:\s*initial/);
  });

  it('nenhum arquivo do app usa cor fora dos tokens', () => {
    const paleta = /\b(?:bg|text|border|ring|outline|fill|stroke|from|to|via|shadow|decoration|accent|caret|placeholder)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/;
    for (const arquivo of fontes(raiz)) {
      const codigo = readFileSync(arquivo, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      expect(paleta.test(codigo), `${arquivo} usa classe de paleta`).toBe(false);
      expect(coresNaoCinza(codigo), arquivo).toEqual([]);
    }
  });
});

describe('contraste AAA (>= 7:1)', () => {
  const pares: [string, string][] = [
    ['texto', 'fundo'],
    ['texto', 'superficie'],
    ['texto', 'superficie-2'],
    ['texto-suave', 'fundo'],
    ['texto-suave', 'superficie'],
    ['texto-suave', 'superficie-2'],
    ['principal-texto', 'principal'],
  ];
  for (const [tema, t] of [
    ['claro', claro],
    ['escuro', { ...claro, ...escuro }],
  ] as const) {
    it.each(pares)(`${tema}: %s sobre %s`, (frente, fundo) => {
      expect(contraste(t[frente]!, t[fundo]!)).toBeGreaterThanOrEqual(7);
    });
  }

  it('borda de campo tem contraste >= 3:1 (componente de interface)', () => {
    expect(contraste(claro['borda']!, claro['fundo']!)).toBeGreaterThanOrEqual(3);
    expect(contraste(escuro['borda']!, escuro['fundo']!)).toBeGreaterThanOrEqual(3);
  });
});
