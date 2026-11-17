/**
 * PWA: a equipe e o paciente instalam apps diferentes, e o service worker não pode servir arquivo de
 * um build antigo depois de um deploy.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import manifestDaEquipe from './manifest';
import { GET as manifestoDoPortal } from './portal.webmanifest/route';

const sw = readFileSync(fileURLToPath(new URL('../public/sw.js', import.meta.url)), 'utf8');

describe('manifestos', () => {
  it('a equipe abre na área da equipe', () => {
    const m = manifestDaEquipe();
    expect(m.start_url).toBe('/inicio');
  });

  it('o portal tem manifesto próprio, com escopo e início dentro do portal', async () => {
    const corpo = (await (await manifestoDoPortal()).json()) as { start_url: string; scope: string; icons: unknown[] };
    expect(corpo.start_url).toBe('/portal');
    expect(corpo.scope).toBe('/portal');
    expect(corpo.icons.length).toBeGreaterThan(0);
  });
});

describe('service worker', () => {
  it('o nome do cache sai da versão do build, não de um número escrito à mão', () => {
    expect(sw).not.toMatch(/plataforma-saude-v\d/);
    expect(sw).toMatch(/searchParams\.get\('v'\)/);
  });

  it('só guarda resposta boa (404 não entra no cache)', () => {
    expect(sw).toMatch(/res\.ok/);
  });
});
