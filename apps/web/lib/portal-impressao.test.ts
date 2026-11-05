import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { ATRASO_IMPRESSAO_MS, imprimirELimpar, LIMITE_FOLHA_MS, type JanelaDeImpressao } from './portal-impressao';

/** Janela falsa: guarda ouvintes e timers para o teste disparar à mão. */
function janelaFalsa(comMidia = true) {
  const afterprint = new Set<() => void>();
  const midia = new Set<(e: { matches: boolean }) => void>();
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let id = 0;
  const janela: JanelaDeImpressao = {
    print: vi.fn(),
    addEventListener: (_t, fn) => afterprint.add(fn),
    removeEventListener: (_t, fn) => afterprint.delete(fn),
    setTimeout: (fn, ms) => {
      timers.set(++id, { fn, ms });
      return id;
    },
    clearTimeout: (i) => timers.delete(i as number),
    ...(comMidia
      ? {
          matchMedia: (q: string) => {
            expect(q).toBe('print');
            return { matches: false, addEventListener: (_t: 'change', fn: (e: { matches: boolean }) => void) => midia.add(fn), removeEventListener: (_t: 'change', fn: (e: { matches: boolean }) => void) => midia.delete(fn) };
          },
        }
      : {}),
  };
  const disparar = (ms: number) => [...timers.values()].filter((t) => t.ms === ms).forEach((t) => t.fn());
  return { janela, afterprint, midia, timers, disparar };
}

describe('recibo do portal: a folha sai da página (R2 do #75)', () => {
  it('abre a impressão depois de montar a folha', () => {
    const f = janelaFalsa();
    imprimirELimpar(f.janela, vi.fn());
    expect(f.janela.print).not.toHaveBeenCalled();
    f.disparar(ATRASO_IMPRESSAO_MS);
    expect(f.janela.print).toHaveBeenCalledOnce();
  });

  it('limpa no afterprint, uma vez só, e tira ouvintes e timers', () => {
    const f = janelaFalsa();
    const limpar = vi.fn();
    imprimirELimpar(f.janela, limpar);
    [...f.afterprint][0]!();
    f.disparar(LIMITE_FOLHA_MS);
    expect(limpar).toHaveBeenCalledOnce();
    expect(f.afterprint.size).toBe(0);
    expect(f.midia.size).toBe(0);
    expect(f.timers.size).toBe(0);
  });

  it('limpa quando matchMedia("print") deixa de valer, mesmo sem afterprint', () => {
    const f = janelaFalsa();
    const limpar = vi.fn();
    imprimirELimpar(f.janela, limpar);
    [...f.midia][0]!({ matches: true });
    expect(limpar).not.toHaveBeenCalled();
    [...f.midia][0]!({ matches: false });
    expect(limpar).toHaveBeenCalledOnce();
    expect(f.afterprint.size).toBe(0);
  });

  it('limpa pelo limite de tempo se o navegador não avisar nada (e sem matchMedia)', () => {
    const f = janelaFalsa(false);
    const limpar = vi.fn();
    imprimirELimpar(f.janela, limpar);
    f.disparar(LIMITE_FOLHA_MS);
    expect(limpar).toHaveBeenCalledOnce();
    expect(LIMITE_FOLHA_MS).toBeLessThanOrEqual(60_000);
  });

  it('desmontar (sair da tela) tira tudo sem chamar limpar de novo', () => {
    const f = janelaFalsa();
    const limpar = vi.fn();
    const desmontar = imprimirELimpar(f.janela, limpar);
    desmontar();
    expect(f.afterprint.size + f.midia.size + f.timers.size).toBe(0);
    expect(limpar).not.toHaveBeenCalled();
  });

  it('a folha fica fora da tela e do leitor de tela (hidden print:block + aria-hidden), sem sr-only', () => {
    const src = readFileSync(fileURLToPath(new URL('../app/(portal)/portal/documentos/page.tsx', import.meta.url)), 'utf8');
    const folha = src.slice(src.indexOf('function FolhaDoRecibo'));
    expect(folha).toMatch(/<div data-imprimir aria-hidden="true" className="hidden print:block">/);
    expect(folha).not.toMatch(/sr-only/);
    expect(src).toMatch(/imprimirELimpar\(window/);
  });
});
