import { describe, expect, it, vi } from 'vitest';
import {
  createRateLimitStore,
  FallbackRateLimitStore,
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
});

describe('rateLimitKey', () => {
  it('nunca leva o IP em claro para o Redis', () => {
    const chave = rateLimitKey('203.0.113.7');
    expect(chave).toMatch(/^rl:v1:[0-9a-f]{32}$/);
    expect(chave).not.toContain('203.0.113.7');
    expect(rateLimitKey('203.0.113.7')).toBe(chave);
    expect(rateLimitKey('203.0.113.8')).not.toBe(chave);
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
    expect(createRateLimitStore({})).toBeInstanceOf(MemoryRateLimitStore);
  });

  it('com REDIS_URL usa Redis com fallback em memória', async () => {
    const s = createRateLimitStore({ REDIS_URL: 'redis://127.0.0.1:1' });
    expect(s).toBeInstanceOf(FallbackRateLimitStore);
    await s.close();
  });
});
