/**
 * SUÍTE OFENSIVA — HTTP. Sobe a API NestJS em processo com applyHttpSecurity e ataca a borda:
 * headers, CORS, corpo gigante, rajada, rotas/métodos inesperados e vazamento de stack trace.
 * Não exige banco (roda também em `pnpm test`). Ver docs/04-arquitetura/testes-de-seguranca.md.
 */
import 'reflect-metadata';
import { Body, Controller, Get, type INestApplication, Post } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HealthModule } from '../../src/health/health.module';
import { applyHttpSecurity } from '../../src/security/http-security';
import {
  HTTP_SECURITY_DEFAULTS,
  loadHttpSecurityConfig,
  type HttpSecurityConfig,
} from '../../src/security/http-security.config';

const ORIGEM_OK = 'https://app.plataforma-saude.test';
const ORIGEM_MA = 'https://atacante.example';

/** Rotas só de teste: uma que vaza detalhe interno ao falhar e outra que recebe corpo. */
@Controller('teste-seguranca')
class AlvoController {
  @Get('falha')
  falha(): never {
    throw new Error('detalhe interno: senha=xyz em C:\\srv\\api\\dist\\db.js:42');
  }

  @Post('eco')
  eco(@Body() body: unknown): { recebido: boolean; tipo: string } {
    return { recebido: true, tipo: typeof body };
  }
}

async function criarApp(config: Partial<HttpSecurityConfig> = {}): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [HealthModule],
    controllers: [AlvoController],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
  applyHttpSecurity(app, {
    ...HTTP_SECURITY_DEFAULTS,
    corsAllowedOrigins: [ORIGEM_OK],
    rateLimitMax: 1_000,
    ...config,
  });
  await app.init();
  return app;
}

function semVazamento(texto: string): void {
  expect(texto).not.toMatch(/\bat\s+\S+\s+\(|stack|node_modules|\.js:\d+|\.ts:\d+|C:\\|senha|detalhe interno/i);
}

describe('borda HTTP endurecida', () => {
  let app: INestApplication;
  let http: Server;

  beforeAll(async () => {
    app = await criarApp();
    http = app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await app.close();
  });

  it('headers seguros presentes e X-Powered-By ausente', async () => {
    const res = await request(http).get('/health').expect(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
    expect(res.headers['content-security-policy']).toMatch(/default-src 'none'/);
    expect(res.headers['strict-transport-security']).toMatch(/max-age=31536000/);
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('CORS: origem da allowlist recebe Access-Control-Allow-Origin exato (nunca *)', async () => {
    const res = await request(http).get('/health').set('Origin', ORIGEM_OK).expect(200);
    expect(res.headers['access-control-allow-origin']).toBe(ORIGEM_OK);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it.each([ORIGEM_MA, 'null', `${ORIGEM_OK}.atacante.example`, 'https://app.plataforma-saude.test:8443'])(
    'CORS: origem %s não recebe Access-Control-Allow-*',
    async (origem) => {
      const simples = await request(http).get('/health').set('Origin', origem);
      expect(simples.headers['access-control-allow-origin']).toBeUndefined();
      const preflight = await request(http)
        .options('/teste-seguranca/eco')
        .set('Origin', origem)
        .set('Access-Control-Request-Method', 'POST');
      expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
      expect(preflight.headers['access-control-allow-methods']).toBeUndefined();
      expect(preflight.headers['access-control-allow-credentials']).toBeUndefined();
    },
  );

  it('corpo acima do limite → 413 sem stack', async () => {
    const grande = JSON.stringify({ nome: 'x'.repeat(200 * 1024) });
    const res = await request(http)
      .post('/teste-seguranca/eco')
      .set('Content-Type', 'application/json')
      .send(grande)
      .expect(413);
    expect(res.body).toEqual({ statusCode: 413, message: 'Payload Too Large' });
    semVazamento(res.text);
  });

  it('corpo dentro do limite é aceito', async () => {
    const res = await request(http).post('/teste-seguranca/eco').send({ nome: 'Paciente Ficticio' }).expect(201);
    expect(res.body).toEqual({ recebido: true, tipo: 'object' });
  });

  it('JSON malformado → 400 sem stack nem trecho do parser', async () => {
    const res = await request(http)
      .post('/teste-seguranca/eco')
      .set('Content-Type', 'application/json')
      .send('{"nome": "x",,,}')
      .expect(400);
    expect(res.body).toEqual({ statusCode: 400, message: 'Bad Request' });
    semVazamento(res.text);
    expect(res.text).not.toMatch(/Unexpected|JSON\.parse|position/i);
  });

  it('charset desconhecido → 415 sem stack', async () => {
    const res = await request(http)
      .post('/teste-seguranca/eco')
      .set('Content-Type', 'application/json; charset=utf-1337')
      .send('{}');
    expect(res.status).toBe(415);
    semVazamento(res.text);
  });

  it('rota inexistente → 404 JSON sem stack', async () => {
    const res = await request(http).get('/admin/../../etc/passwd').expect(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    semVazamento(res.text);
  });

  it('erro interno → 500 genérico, sem mensagem nem caminho internos', async () => {
    const res = await request(http).get('/teste-seguranca/falha').expect(500);
    expect(res.body).toEqual({ statusCode: 500, message: 'Internal server error' });
    semVazamento(res.text);
  });

  it.each(['put', 'delete', 'patch', 'post'] as const)('método %s inesperado em /health → 404', async (m) => {
    const res = await request(http)[m]('/health').expect(404);
    semVazamento(res.text);
  });

  it('TRACE não ecoa a requisição (XST)', async () => {
    const res = await request(http).trace('/health').set('X-Segredo-Ficticio', 'cookie-de-teste');
    expect([404, 405]).toContain(res.status);
    expect(res.text).not.toContain('cookie-de-teste');
  });
});

describe('rate limit global', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await criarApp({ rateLimitMax: 5, rateLimitWindowMs: 60_000 });
  });

  afterAll(async () => {
    await app.close();
  });

  it('rajada acima do limite → 429 com Retry-After', async () => {
    const http = app.getHttpServer() as Server;
    const status: number[] = [];
    for (let i = 0; i < 8; i += 1) status.push((await request(http).get('/health')).status);
    expect(status.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(status.slice(5)).toEqual([429, 429, 429]);
    const bloqueada = await request(http).get('/health').expect(429);
    expect(Number(bloqueada.headers['retry-after'])).toBeGreaterThan(0);
    expect(bloqueada.body).toEqual({ statusCode: 429, message: 'Too Many Requests' });
  });
});

describe('configuração da borda', () => {
  it.each(['*', 'null', 'https://*.example.com', 'http://app.example.com', 'https://app.example.com/path'])(
    'CORS_ALLOWED_ORIGINS=%s é recusada na subida',
    (origem) => {
      expect(() => loadHttpSecurityConfig({ CORS_ALLOWED_ORIGINS: origem })).toThrow(/CORS_ALLOWED_ORIGINS/);
    },
  );

  it('padrões seguros sem variáveis: nenhuma origem cruzada, 100kb, rate limit ligado', () => {
    expect(loadHttpSecurityConfig({})).toEqual(HTTP_SECURITY_DEFAULTS);
  });

  it('allowlist válida é normalizada', () => {
    expect(
      loadHttpSecurityConfig({ CORS_ALLOWED_ORIGINS: ' https://App.Exemplo.test , http://localhost:3000' })
        .corsAllowedOrigins,
    ).toEqual(['https://app.exemplo.test', 'http://localhost:3000']);
  });
});
