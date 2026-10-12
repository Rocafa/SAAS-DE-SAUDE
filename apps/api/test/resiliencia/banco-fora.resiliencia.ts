/**
 * Banco PARADO / VOLTANDO / PARTICIONADO com a API real (AppModule) no meio.
 * A falha é injetada por um proxy TCP entre a API e o Postgres real.
 */
import type { INestApplication } from '@nestjs/common';
import type { TenantId } from '@plataforma/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GENERIC_500, GENERIC_503 } from '../../src/lifecycle/all-exceptions.filter';
import { baseUrl, criarApp, esperarAte, semearTenant, semVazamento, urlDoAmbiente } from './apoio';
import { alvoDe, criarProxyFalha, type ProxyFalha } from './proxy-falha';

let proxy: ProxyFalha;
let app: INestApplication;
let base: string;
let tenant: TenantId;

async function get(path: string): Promise<{ status: number; body: string; ms: number; headers: Headers }> {
  const inicio = Date.now();
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.text(), ms: Date.now() - inicio, headers: res.headers };
}

beforeAll(async () => {
  const url = urlDoAmbiente();
  tenant = await semearTenant(3);
  proxy = await criarProxyFalha(alvoDe(url));
  app = await criarApp(proxy.urlVia(url), {
    max: 2,
    connectTimeoutSeconds: 1,
    statementTimeoutMs: 2_000,
    acquireTimeoutMs: 300,
    transactionTimeoutMs: 3_000,
  });
  base = baseUrl(app);
});

afterAll(async () => {
  await proxy?.voltar();
  await app?.close();
  await proxy?.fechar();
});


/** Corpo do /health/ready: só `status` e o rótulo do modo do rate limit — nada de detalhe de erro. */
function expectReadiness(body: string, status: 'ok' | 'indisponivel'): void {
  const parsed = JSON.parse(body) as Record<string, unknown>;
  expect(Object.keys(parsed).sort()).toEqual(['rateLimit', 'status']);
  expect(parsed.status).toBe(status);
  expect(parsed.rateLimit).toMatch(/^(compartilhado|fallback|memoria|instancia-unica|desligado)$/);
}

describe('estado normal', () => {
  it('liveness, readiness e rota de domínio respondem 200', async () => {
    expect((await get('/health')).status).toBe(200);
    const ready = await get('/health/ready');
    expect(ready.status).toBe(200);
    expectReadiness(ready.body, 'ok');
    const pac = await get(`/__teste/pacientes/${tenant}`);
    expect(pac.status).toBe(200);
    expect(JSON.parse(pac.body)).toEqual({ total: 3 });
  });
});

describe('banco PARADO (conexões derrubadas e porta recusando)', () => {
  beforeAll(async () => {
    await proxy.parar();
  });

  it('/health continua 200 (liveness não toca o banco: orquestrador NÃO reinicia a API)', async () => {
    const res = await get('/health');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
  });

  it('/health/ready responde 503 rápido e sem detalhes', async () => {
    const res = await get('/health/ready');
    expect(res.status).toBe(503);
    expectReadiness(res.body, 'indisponivel');
    expect(res.ms).toBeLessThan(2_500);
    semVazamento(res.body);
  });

  it('rota que usa o banco devolve 503 genérico com Retry-After (sem stack/SQL/código)', async () => {
    const res = await get(`/__teste/pacientes/${tenant}`);
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body)).toEqual(GENERIC_503);
    expect(res.headers.get('retry-after')).toBe('5');
    semVazamento(res.body);
  });

  it('processo segue vivo e servindo depois de várias falhas seguidas', async () => {
    const respostas = await Promise.all(
      Array.from({ length: 10 }, () => get(`/__teste/pacientes/${tenant}`)),
    );
    expect(respostas.every((r) => r.status === 503)).toBe(true);
    expect((await get('/health')).status).toBe(200);
  });
});

describe('banco VOLTA', () => {
  it('readiness volta a 200 e o domínio volta a funcionar SEM reiniciar a API', async () => {
    await proxy.voltar();
    const ms = await esperarAte(async () => (await get('/health/ready')).status === 200, 10_000);
    expect(ms).toBeLessThan(10_000);
    // Antes do ajuste de backoff do postgres.js, isto levava até 20 s após uma queda longa.
    await esperarAte(async () => (await get(`/__teste/pacientes/${tenant}`)).status === 200, 3_000);
    expect(JSON.parse((await get(`/__teste/pacientes/${tenant}`)).body)).toEqual({ total: 3 });
  });
});

describe('rede particionada (TCP aceita, nada responde)', () => {
  it('readiness e domínio falham por TIMEOUT (não ficam pendurados) e recuperam depois', async () => {
    proxy.buracoNegro();
    const ready = await get('/health/ready');
    expect(ready.status).toBe(503);
    expect(ready.ms).toBeLessThan(2_500);
    const dom = await get(`/__teste/pacientes/${tenant}`);
    expect(dom.status).toBe(503);
    // Prazo do cliente (3 s): sem ele o postgres.js re-enfileira a query a cada CONNECT_TIMEOUT
    // e a requisição fica pendurada (achado deste teste — antes levava ~16 s).
    expect(dom.ms).toBeLessThan(4_500);
    semVazamento(dom.body);

    await proxy.voltar();
    await esperarAte(async () => (await get('/health/ready')).status === 200, 10_000);
    await esperarAte(async () => (await get(`/__teste/pacientes/${tenant}`)).status === 200, 5_000);
  });
});

describe('consulta lenta e pool esgotado via HTTP', () => {
  it('query acima do statement_timeout é cancelada pelo Postgres => 503 em ~2 s', async () => {
    const res = await get(`/__teste/sono/${tenant}?ms=8000`);
    expect(res.status).toBe(503);
    expect(res.ms).toBeLessThan(5_000);
    semVazamento(res.body);
  });

  it('pool esgotado: requisição extra recebe 503 em ~acquireTimeout, não trava; depois normaliza', async () => {
    const ocupando = [get(`/__teste/sono/${tenant}?ms=1200`), get(`/__teste/sono/${tenant}?ms=1200`)];
    await new Promise((r) => setTimeout(r, 150));
    const extra = await get(`/__teste/pacientes/${tenant}`);
    expect(extra.status).toBe(503);
    expect(extra.ms).toBeLessThan(1_500);
    expect(JSON.parse(extra.body)).toEqual(GENERIC_503);
    // readiness usa conexão própria: carga no pool não tira a instância do balanceador
    expect((await get('/health/ready')).status).toBe(200);
    const fim = await Promise.all(ocupando);
    expect(fim.map((r) => r.status)).toEqual([200, 200]);
    expect((await get(`/__teste/pacientes/${tenant}`)).status).toBe(200);
  });
});

describe('exceções não tratadas não vazam detalhes', () => {
  it('erro de programação => 500 genérico, sem stack nem mensagem interna', async () => {
    const res = await get('/__teste/explode');
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body)).toEqual(GENERIC_500);
    semVazamento(res.body);
  });

  it('erro NÃO transitório do Postgres => 500 genérico, sem SQL nem SQLSTATE', async () => {
    const res = await get(`/__teste/sql-invalido/${tenant}`);
    expect(res.status).toBe(500);
    expect(JSON.parse(res.body)).toEqual(GENERIC_500);
    semVazamento(res.body);
  });

  it('HttpException intencional mantém o status (404) e o app segue de pé', async () => {
    expect((await get('/__teste/nao-encontrado')).status).toBe(404);
    expect((await get('/health')).status).toBe(200);
  });
});
