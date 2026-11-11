/**
 * Montagem HTTP do Better Auth (D4): lista fechada de endpoints (R4 do parecer do desenho), 403 para escrita sem
 * Origin (R1 do #132), cabeçalho de origem trocado pelo nosso HMAC (R10) e o resto passando adiante. Sem banco: a
 * biblioteca é substituída por um dublê.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { origemDaRequisicao } from '../../../security/log-de-seguranca';
import { CABECALHO_ORIGEM } from './instancia';
import { ENDPOINTS_PERMITIDOS, montarAutenticacao } from './montagem';

type Fake = { statusCode: number; corpo: string; ouvintes: Record<string, () => void> };

function resposta(): ServerResponse & Fake {
  const r: Fake & Record<string, unknown> = { statusCode: 200, corpo: '', ouvintes: {} };
  r['setHeader'] = () => undefined;
  r['end'] = (c: string) => {
    r.corpo = c;
  };
  r['on'] = (ev: string, fn: () => void) => {
    r.ouvintes[ev] = fn;
  };
  return r as unknown as ServerResponse & Fake;
}

function montar() {
  const handlerDaBiblioteca = vi.fn(() => Promise.resolve());
  const auth = { handler: handlerDaBiblioteca, api: { getSession: () => Promise.resolve(null) }, options: {} } as never;
  const mw = montarAutenticacao(auth, { encerrar: vi.fn() } as never);
  return { mw, handlerDaBiblioteca };
}

const req = (method: string, url: string, headers: Record<string, string> = {}): IncomingMessage =>
  ({ method, url, headers: { ...headers }, ip: '203.0.113.50', socket: {} }) as never;

afterEach(() => vi.restoreAllMocks());

describe('montagem do Better Auth', () => {
  it('fora do prefixo /api/auth: passa adiante sem tocar em nada', () => {
    const { mw } = montar();
    const next = vi.fn();
    mw(req('GET', '/pacientes'), resposta(), next);
    expect(next).toHaveBeenCalled();
  });

  it('R4: endpoint fora da lista fechada dá 404 (cadastro, troca de e-mail, exclusão, atualização de usuário)', () => {
    const { mw, handlerDaBiblioteca } = montar();
    for (const [m, u] of [
      ['POST', '/api/auth/sign-up/email'],
      ['POST', '/api/auth/change-email'],
      ['POST', '/api/auth/delete-user'],
      ['POST', '/api/auth/update-user'],
      ['POST', '/api/auth/request-password-reset'],
      ['GET', '/api/auth/list-sessions'],
    ] as const) {
      const r = resposta();
      mw(req(m, u, { origin: 'https://app.exemplo.test' }), r, vi.fn());
      expect(r.statusCode, `${m} ${u}`).toBe(404);
    }
    expect(handlerDaBiblioteca).not.toHaveBeenCalled();
    expect([...ENDPOINTS_PERMITIDOS].sort()).toEqual(['GET /get-session', 'POST /sign-in/email', 'POST /sign-out']);
  });

  it('R1 do #132: escrita sem Origin dá 403 e não chega à biblioteca', () => {
    const { mw, handlerDaBiblioteca } = montar();
    const r = resposta();
    mw(req('POST', '/api/auth/sign-in/email'), r, vi.fn());
    expect(r.statusCode).toBe(403);
    expect(handlerDaBiblioteca).not.toHaveBeenCalled();
  });

  it('R10: o cabeçalho de origem do cliente é trocado pelo nosso HMAC do IP antes da biblioteca', async () => {
    const { mw, handlerDaBiblioteca } = montar();
    const r = req('POST', '/api/auth/sign-in/email', { origin: 'https://app.exemplo.test', [CABECALHO_ORIGEM]: 'ffffffffffffffff' });
    mw(r, resposta(), vi.fn());
    await vi.waitFor(() => expect(handlerDaBiblioteca).toHaveBeenCalled());
    expect(r.headers[CABECALHO_ORIGEM]).toBe(origemDaRequisicao('203.0.113.50'));
    expect(r.headers[CABECALHO_ORIGEM]).not.toBe('ffffffffffffffff');
  });

  it('corpo acima de 4 KiB ou chunked dá 413 sem chegar à biblioteca', () => {
    const { mw, handlerDaBiblioteca } = montar();
    for (const h of [{ 'content-length': '5000' }, { 'transfer-encoding': 'chunked' }]) {
      const r = resposta();
      mw(req('POST', '/api/auth/sign-in/email', { origin: 'https://app.exemplo.test', ...h }), r, vi.fn());
      expect(r.statusCode).toBe(413);
    }
    expect(handlerDaBiblioteca).not.toHaveBeenCalled();
  });

  it('R3: sessão com mais de 12 h é encerrada e recusada também nos endpoints da biblioteca', async () => {
    const handlerDaBiblioteca = vi.fn(() => Promise.resolve());
    const encerrar = vi.fn(() => Promise.resolve());
    const velha = { session: { id: 's1', createdAt: new Date(Date.now() - 13 * 3600_000) }, user: { id: 'u1' } };
    const auth = { handler: handlerDaBiblioteca, api: { getSession: () => Promise.resolve(velha) }, options: {} } as never;
    const mw = montarAutenticacao(auth, { encerrar } as never);
    const r = resposta();
    mw(req('GET', '/api/auth/get-session'), r, vi.fn());
    await vi.waitFor(() => expect(r.statusCode).toBe(401));
    expect(encerrar).toHaveBeenCalledWith('s1', 'prazo_absoluto', 'u1');
    expect(handlerDaBiblioteca).not.toHaveBeenCalled();
  });

  it('R6(a) do #117: o botão "sair" passa pelo provedor (trilha da clínica) ANTES da biblioteca apagar a sessão', async () => {
    const ordem: string[] = [];
    const handlerDaBiblioteca = vi.fn(() => {
      ordem.push('biblioteca');
      return Promise.resolve();
    });
    const encerrar = vi.fn(() => {
      ordem.push('encerrar');
      return Promise.resolve();
    });
    const valida = { session: { id: 's1', createdAt: new Date() }, user: { id: 'u1' } };
    const auth = { handler: handlerDaBiblioteca, api: { getSession: () => Promise.resolve(valida) }, options: {} } as never;
    const mw = montarAutenticacao(auth, { encerrar } as never);
    mw(req('POST', '/api/auth/sign-out', { origin: 'https://app.exemplo.test' }), resposta(), vi.fn());
    await vi.waitFor(() => expect(handlerDaBiblioteca).toHaveBeenCalled());
    expect(encerrar).toHaveBeenCalledWith('s1', 'logout', 'u1');
    // A biblioteca ainda roda: é ela que apaga o cookie no navegador.
    expect(ordem).toEqual(['encerrar', 'biblioteca']);
  });

  it('"sair" com o provedor falhando: a biblioteca roda mesmo assim (apaga sessão e cookie), sem 500', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const handlerDaBiblioteca = vi.fn(() => Promise.resolve());
    const encerrar = vi.fn(() => Promise.reject(new Error('banco app_auth fora')));
    const valida = { session: { id: 's1', createdAt: new Date() }, user: { id: 'u1' } };
    const auth = { handler: handlerDaBiblioteca, api: { getSession: () => Promise.resolve(valida) }, options: {} } as never;
    const mw = montarAutenticacao(auth, { encerrar } as never);
    const next = vi.fn();
    mw(req('POST', '/api/auth/sign-out', { origin: 'https://app.exemplo.test' }), resposta(), next);
    await vi.waitFor(() => expect(handlerDaBiblioteca).toHaveBeenCalled());
    // O erro do provedor não escapa para o `next` (que daria 500 sem apagar o cookie).
    expect(next.mock.calls.flat()).not.toContainEqual(expect.objectContaining({ message: 'banco app_auth fora' }));
  });

  it('"sair" sem sessão válida: não chama o provedor, a biblioteca responde como sempre', async () => {
    const handlerDaBiblioteca = vi.fn(() => Promise.resolve());
    const encerrar = vi.fn(() => Promise.resolve());
    const auth = { handler: handlerDaBiblioteca, api: { getSession: () => Promise.resolve(null) }, options: {} } as never;
    const mw = montarAutenticacao(auth, { encerrar } as never);
    mw(req('POST', '/api/auth/sign-out', { origin: 'https://app.exemplo.test' }), resposta(), vi.fn());
    await vi.waitFor(() => expect(handlerDaBiblioteca).toHaveBeenCalled());
    expect(encerrar).not.toHaveBeenCalled();
  });
});
