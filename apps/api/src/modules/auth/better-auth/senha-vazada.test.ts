/**
 * Senha vazada por k-anonimato (R15 do parecer do desenho da D4): só o prefixo de 5 hex do SHA-1 sai; o resto é
 * comparado aqui; enchimento ligado; prazo curto. Sem rede: a busca é um dublê.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { conferidorPorKAnonimato, URL_DA_BASE } from './senha-vazada';

const SENHA = 'Senha-Ficticia-de-Teste-1';
const HASH = createHash('sha1').update(SENHA).digest('hex').toUpperCase();

function resposta(corpo: string, status = 200): Response {
  return new Response(corpo, { status });
}

describe('conferência de senha vazada (k-anonimato)', () => {
  it('manda só o prefixo de 5 caracteres, com enchimento, e nunca a senha nem o hash completo', async () => {
    const buscar = vi.fn<typeof fetch>(() => Promise.resolve(resposta('0000000000000000000000000000000000A:0\n')));
    await conferidorPorKAnonimato({ buscar })(SENHA);
    const [alvo, init] = buscar.mock.calls[0] ?? [];
    const url = typeof alvo === 'string' ? alvo : '';
    expect(url).toBe(`${URL_DA_BASE}${HASH.slice(0, 5)}`);
    expect(url).not.toContain(HASH.slice(5));
    expect(url).not.toContain(SENHA);
    expect(JSON.stringify(init)).not.toContain(SENHA);
    expect((init?.headers as Record<string, string>)['Add-Padding']).toBe('true');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('acha o sufixo com contagem > 0 (vazou); sufixo de enchimento com contagem 0 não conta', async () => {
    const vazou = conferidorPorKAnonimato({ buscar: (() => Promise.resolve(resposta(`AAAA:3\r\n${HASH.slice(5)}:42\r\n`))) });
    expect(await vazou(SENHA)).toBe(true);
    const enchimento = conferidorPorKAnonimato({ buscar: (() => Promise.resolve(resposta(`${HASH.slice(5)}:0\r\n`))) });
    expect(await enchimento(SENHA)).toBe(false);
    const limpa = conferidorPorKAnonimato({ buscar: (() => Promise.resolve(resposta('BBBB:9\r\n'))) });
    expect(await limpa(SENHA)).toBe(false);
  });

  it('resposta de erro ou falha de rede lança (a proteção decide seguir e alarmar)', async () => {
    await expect(conferidorPorKAnonimato({ buscar: (() => Promise.resolve(resposta('', 503))) })(SENHA)).rejects.toThrow(/503/);
    await expect(conferidorPorKAnonimato({ buscar: (() => Promise.reject(new Error('rede'))) })(SENHA)).rejects.toThrow();
  });
});
