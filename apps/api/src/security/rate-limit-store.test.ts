import { describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { rateLimitFailOpenCount, rateLimiter } from './http-security';
import {
  createRateLimitStore,
  FallbackRateLimitStore,
  loadRateLimitHashKey,
  MemoryRateLimitStore,
  rateLimitKey,
  RedisRateLimitStore,
  type RateLimitStore,
} from './rate-limit-store';

const silencioso = { warn: vi.fn(), log: vi.fn() };

/** Primário controlável: falha enquanto `fora` for true. */
function primarioFalso(): RateLimitStore & { fora: boolean; chamadas: number } {
  const memoria = new MemoryRateLimitStore();
  const p = {
    fora: false,
    chamadas: 0,
    hit(key: string, windowMs: number) {
      p.chamadas++;
      return p.fora ? Promise.reject(new Error('redis fora')) : memoria.hit(key, windowMs);
    },
    mode: () => 'compartilhado' as const,
    close: () => Promise.resolve(),
  };
  return p;
}

describe('MemoryRateLimitStore', () => {
  it('conta por chave dentro da janela e informa quanto falta para virar', async () => {
    const s = new MemoryRateLimitStore();
    expect((await s.hit('a', 60_000)).count).toBe(1);
    expect((await s.hit('a', 60_000)).count).toBe(2);
    expect((await s.hit('b', 60_000)).count).toBe(1);
    const { resetMs } = await s.hit('a', 60_000);
    expect(resetMs).toBeGreaterThan(0);
    expect(resetMs).toBeLessThanOrEqual(60_000);
  });

  it('janelas de tamanhos diferentes não zeram uma à outra (limite por IP e por usuário no mesmo store)', async () => {
    vi.useFakeTimers();
    try {
      const s = new MemoryRateLimitStore();
      await s.hit('longa', 600_000);
      await s.hit('curta', 1_000);
      vi.advanceTimersByTime(1_500);
      expect((await s.hit('curta', 1_000)).count).toBe(1); // a curta virou
      expect((await s.hit('longa', 600_000)).count).toBe(2); // a longa continua
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('rateLimitKey (R1: HMAC com segredo)', () => {
  const segredo = randomBytes(32);

  it('nunca leva o IP em claro e é estável para o mesmo segredo', () => {
    const chave = rateLimitKey('203.0.113.7', segredo);
    expect(chave).toMatch(/^rl:v2:[0-9a-f]{32}$/);
    expect(chave).not.toContain('203.0.113.7');
    expect(rateLimitKey('203.0.113.7', segredo)).toBe(chave);
    expect(rateLimitKey('203.0.113.8', segredo)).not.toBe(chave);
  });

  it('sem o segredo não se reconstrói: outro segredo gera outra chave para o mesmo IP', () => {
    expect(rateLimitKey('203.0.113.7', randomBytes(32))).not.toBe(rateLimitKey('203.0.113.7', segredo));
  });
});

describe('loadRateLimitHashKey', () => {
  it('em produção, sem RATE_LIMIT_HASH_KEY, o boot falha', () => {
    expect(() => loadRateLimitHashKey({ NODE_ENV: 'production' })).toThrow(/RATE_LIMIT_HASH_KEY/);
  });

  it('segredo curto é recusado; segredo válido é usado como veio', () => {
    expect(() => loadRateLimitHashKey({ RATE_LIMIT_HASH_KEY: 'curto' })).toThrow(/32 bytes/);
    const valor = 'x'.repeat(40);
    expect(loadRateLimitHashKey({ NODE_ENV: 'production', RATE_LIMIT_HASH_KEY: valor }).toString()).toBe(valor);
  });

  it('fora de produção, sem a variável, usa um segredo aleatório estável no processo', () => {
    const a = loadRateLimitHashKey({});
    expect(a).toHaveLength(32);
    expect(loadRateLimitHashKey({})).toBe(a);
  });
});

/** Executa o middleware uma vez e devolve se seguiu adiante. */
async function passar(mw: ReturnType<typeof rateLimiter>, ip: string): Promise<{ seguiu: boolean; status?: number }> {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      setHeader: () => undefined,
      end: () => resolve({ seguiu: false, status: res.statusCode }),
      writeHead: (code: number) => {
        res.statusCode = code;
        return res;
      },
    };
    const req = { url: '/x', ip, socket: { remoteAddress: ip } } as unknown as IncomingMessage;
    mw(req, res as unknown as ServerResponse, () => resolve({ seguiu: true }));
  });
}

describe('rateLimiter', () => {
  it('R2: nenhum store recebe o IP em claro (a chave é derivada na borda)', async () => {
    const vistas: string[] = [];
    const memoria = new MemoryRateLimitStore();
    const espiao: RateLimitStore = {
      hit: (key, windowMs) => {
        vistas.push(key);
        return memoria.hit(key, windowMs);
      },
      mode: () => 'memoria',
      close: () => Promise.resolve(),
    };
    const mw = rateLimiter(10, 60_000, espiao, new Set(), randomBytes(32));
    await passar(mw, '198.51.100.23');
    await passar(mw, '2001:db8::1');
    expect(vistas).toHaveLength(2);
    for (const k of vistas) {
      expect(k).toMatch(/^rl:v2:[0-9a-f]{32}$/);
      expect(k).not.toMatch(/198\.51|2001:db8/);
    }
  });

  it('R4: store quebrado deixa passar, mas conta e registra erro com marcador fixo', async () => {
    const quebrado: RateLimitStore = {
      hit: () => Promise.reject(new Error('caiu')),
      mode: () => 'compartilhado',
      close: () => Promise.resolve(),
    };
    const { Logger } = await import('@nestjs/common');
    const erro = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const antes = rateLimitFailOpenCount();
    expect(await passar(rateLimiter(1, 60_000, quebrado, new Set(), randomBytes(32)), '198.51.100.9')).toEqual({
      seguiu: true,
    });
    expect(rateLimitFailOpenCount()).toBe(antes + 1);
    expect(erro.mock.calls.flat().join(' ')).toMatch(/RATE_LIMIT_FAIL_OPEN/);
    expect(erro.mock.calls.flat().join(' ')).not.toContain('198.51.100.9');
    erro.mockRestore();
  });
});

describe('FallbackRateLimitStore', () => {
  it('com o primário fora, conta em memória, avisa uma vez e fica em quarentena', async () => {
    const primario = primarioFalso();
    primario.fora = true;
    const s = new FallbackRateLimitStore(primario, new MemoryRateLimitStore(), { cooldownMs: 60_000, logger: silencioso });
    expect((await s.hit('ip', 60_000)).count).toBe(1);
    expect((await s.hit('ip', 60_000)).count).toBe(2);
    expect(s.usingFallback).toBe(true);
    expect(s.mode()).toBe('fallback');
    expect(primario.chamadas).toBe(1); // em quarentena, não paga o timeout de novo
    expect(silencioso.warn).toHaveBeenCalledTimes(1);
  });

  it('volta para o primário depois da quarentena', async () => {
    const primario = primarioFalso();
    primario.fora = true;
    const s = new FallbackRateLimitStore(primario, new MemoryRateLimitStore(), { cooldownMs: 1, logger: silencioso });
    await s.hit('ip', 60_000);
    primario.fora = false;
    await new Promise((r) => setTimeout(r, 5));
    await s.hit('ip', 60_000);
    expect(s.usingFallback).toBe(false);
    expect(primario.chamadas).toBe(2);
  });

  it('Redis inalcançável: a requisição é atendida rápido pela memória, sem erro', async () => {
    const redis = new RedisRateLimitStore('redis://127.0.0.1:1', { connectTimeoutMs: 200, commandTimeoutMs: 100 });
    const s = new FallbackRateLimitStore(redis, new MemoryRateLimitStore(), { logger: silencioso });
    try {
      const inicio = Date.now();
      const { count } = await s.hit('ip', 60_000);
      expect(count).toBe(1);
      expect(Date.now() - inicio).toBeLessThan(500);
      expect(s.usingFallback).toBe(true);
    } finally {
      await s.close();
    }
  });
});

describe('createRateLimitStore', () => {
  it('sem REDIS_URL usa só memória', () => {
    const s = createRateLimitStore({});
    expect(s).toBeInstanceOf(MemoryRateLimitStore);
    expect(s.mode()).toBe('memoria');
  });

  it('R3: produção sem REDIS_URL falha no boot', () => {
    expect(() => createRateLimitStore({ NODE_ENV: 'production' })).toThrow(/REDIS_URL/);
  });

  it('R3: produção sem Redis só com opt-in explícito, e o modo diz isso', () => {
    const s = createRateLimitStore({ NODE_ENV: 'production', RATE_LIMIT_ALLOW_SINGLE_INSTANCE: '1' });
    expect(s.mode()).toBe('instancia-unica');
  });

  it('com REDIS_URL usa Redis com fallback em memória', async () => {
    const s = createRateLimitStore({ REDIS_URL: 'redis://127.0.0.1:1' });
    expect(s).toBeInstanceOf(FallbackRateLimitStore);
    await s.close();
  });
});
