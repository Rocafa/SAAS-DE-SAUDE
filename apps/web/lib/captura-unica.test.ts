/**
 * R1 do parecer do #103: captura de tela que entra no repositorio so sai por e2e/captura.ts (`capturar`),
 * que confere o modo de demonstracao antes de gravar. Um spec que chame `page.screenshot` direto, ou que
 * escreva em `docs/` por outro caminho, falha aqui (sem navegador).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PASTA_E2E = fileURLToPath(new URL('../e2e/', import.meta.url));
// Busca recursiva: specs em subpastas nao escapam da varredura.
// readdirSync com recursive: true retorna string[] | Buffer[], mas so usamos strings.
const specs = readdirSync(PASTA_E2E, { recursive: true })
  .filter((f): f is string => typeof f === 'string' && f.endsWith('.ts') && f !== 'captura.ts');

describe('capturas de tela so por e2e/captura.ts', () => {
  it('ha specs para conferir (sanidade)', () => {
    expect(specs.length).toBeGreaterThan(3);
  });

  it.each(specs)('%s nao fotografa nem grava em docs/ por conta propria', (arquivo) => {
    const texto = readFileSync(`${PASTA_E2E}${arquivo}`, 'utf8');
    expect(texto, 'use capturar(page, info, nome) de ./captura').not.toMatch(/\.screenshot\s*\(/);
    expect(texto, 'caminho de docs/ fora de ./captura').not.toMatch(/docs\/02-produto|['"`]\.\.\/\.\.\/\.\.\/docs/);
  });
});
