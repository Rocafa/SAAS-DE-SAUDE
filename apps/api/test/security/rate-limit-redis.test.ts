/**
 * SUÍTE OFENSIVA — rate limit distribuído. Duas instâncias da API apontando para o MESMO Redis:
 * o atacante que reparte a rajada entre instâncias (o balanceador faz isso sozinho) não ganha
 * limite dobrado. Exige REDIS_URL (serviço Redis no job de segurança do CI).
 */
import 'reflect-metadata';
import { Controller, Get, type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyHttpSecurity } from '../../src/security/http-security';
import { HTTP_SECURITY_DEFAULTS } from '../../src/security/http-security.config';
import { createRateLimitStore, type RateLimitStore } from '../../src/security/rate-limit-store';

const REDIS_URL = process.env.REDIS_URL;
// Teste que pula é verde falso: no CI, a falta do Redis é erro, não "skipped".
if (process.env.CI && !REDIS_URL) throw new Error('REDIS_URL obrigatória no CI para o teste de rate limit distribuído');

@Controller('alvo')
class AlvoController {
  @Get()
  ok(): { ok: true } {
    return { ok: true };
  }
}

async function instancia(store: RateLimitStore, max: number): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ controllers: [AlvoController] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  applyHttpSecurity(app, { ...HTTP_SECURITY_DEFAULTS, rateLimitMax: max, rateLimitWindowMs: 60_000 }, store);
  await app.init();
  return app;
}

describe.runIf(REDIS_URL)('rate limit compartilhado no Redis', () => {
  const MAX = 6;
  let redis: Redis;
  let storeA: RateLimitStore;
  let storeB: RateLimitStore;
  let a: INestApplication;
  let b: INestApplication;

  beforeAll(async () => {
    redis = new Redis(REDIS_URL as string);
    await redis.flushdb();
    storeA = createRateLimitStore({ REDIS_URL });
    storeB = createRateLimitStore({ REDIS_URL });
    expect(await storeA.ready?.()).toBe(true);
    expect(await storeB.ready?.()).toBe(true);
    a = await instancia(storeA, MAX);
    b = await instancia(storeB, MAX);
  });

  afterAll(async () => {
    await a?.close();
    await b?.close();
    await storeA?.close();
    await storeB?.close();
    await redis?.quit();
  });

  it('rajada repartida entre duas instâncias respeita o limite total, não o dobro', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < MAX * 2; i++) {
      const alvo = (i % 2 === 0 ? a : b).getHttpServer() as Server;
      statuses.push((await request(alvo).get('/alvo')).status);
    }
    expect(statuses.filter((s) => s === 200)).toHaveLength(MAX);
    expect(statuses.slice(MAX).every((s) => s === 429)).toBe(true);
  });

  it('a chave no Redis não guarda o IP em claro e expira com a janela', async () => {
    const chaves = await redis.keys('rl:v1:*');
    expect(chaves.length).toBeGreaterThan(0);
    for (const chave of chaves) {
      expect(chave).not.toMatch(/\d+\.\d+\.\d+\.\d+|::/);
      const ttl = await redis.pttl(chave);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60_000);
    }
  });
});
