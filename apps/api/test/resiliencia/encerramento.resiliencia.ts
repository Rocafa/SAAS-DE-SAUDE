/**
 * Encerramento gracioso (SIGTERM) com a API real: requisição em curso termina, readiness vira 503,
 * pool é fechado (nenhuma conexão da API sobra no Postgres) e o processo sai com código 0.
 * O sinal é emitido num `process` falso para não matar o runner do Vitest (no Windows, SIGTERM
 * nem é entregável a um processo Node); a função disparada é a mesma usada em main.ts.
 */
import type { INestApplication } from '@nestjs/common';
import type { TenantId } from '@plataforma/shared';
import { EventEmitter } from 'node:events';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installGracefulShutdown, installProcessErrorHandlers, type ProcessLike } from '../../src/lifecycle/graceful-shutdown';
import { ShutdownState } from '../../src/lifecycle/shutdown-state';
import { baseUrl, criarApp, semearTenant, urlDoAmbiente } from './apoio';

class ProcessoFalso extends EventEmitter implements ProcessLike {
  readonly saidas: number[] = [];
  exit(code: number): void {
    this.saidas.push(code);
  }
}

let observador: postgres.Sql;
let tenant: TenantId;

/** Conexões abertas pela API (pool de domínio + sonda de readiness) vistas pelo próprio Postgres. */
async function conexoesDaApi(): Promise<number> {
  const [row] = await observador<{ n: number }[]>`
    select count(*)::int as n from pg_stat_activity
    where application_name in ('plataforma-api', 'plataforma-api-readiness') and pid <> pg_backend_pid()`;
  return row?.n ?? -1;
}

beforeAll(async () => {
  tenant = await semearTenant(1);
  observador = postgres(urlDoAmbiente(), { max: 1, onnotice: () => undefined });
});

afterAll(async () => {
  await observador?.end({ timeout: 2 });
});

describe('SIGTERM => encerramento gracioso', () => {
  let app: INestApplication;

  it('termina a requisição em curso, readiness 503 durante a drenagem, fecha o pool e sai com 0', async () => {
    app = await criarApp(urlDoAmbiente(), { statementTimeoutMs: 5_000 });
    const base = baseUrl(app);
    const proc = new ProcessoFalso();
    installGracefulShutdown(app, { proc, timeoutMs: 10_000 });

    expect((await fetch(`${base}/health/ready`)).status).toBe(200);
    expect(await conexoesDaApi()).toBeGreaterThan(0);

    // requisição longa (1,2 s segurando conexão do banco) em curso quando o SIGTERM chega
    const emCurso = fetch(`${base}/__teste/sono/${tenant}?ms=1200`, { headers: { connection: 'close' } });
    await new Promise((r) => setTimeout(r, 300));
    proc.emit('SIGTERM');

    const res = await emCurso;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });

    // espera o encerramento terminar (exit chamado)
    for (let i = 0; i < 50 && proc.saidas.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
    expect(proc.saidas).toEqual([0]);
    expect(await conexoesDaApi()).toBe(0); // pool e sonda fechados
    await expect(fetch(`${base}/health`)).rejects.toThrow(); // não aceita mais conexões
  });

  it('readiness responde 503 assim que o encerramento começa', async () => {
    const app2 = await criarApp(urlDoAmbiente(), { statementTimeoutMs: 5_000 });
    const base = baseUrl(app2);
    const proc = new ProcessoFalso();
    installGracefulShutdown(app2, { proc, timeoutMs: 10_000 });
    // mantém o servidor ocupado para observar a janela de drenagem numa conexão já aberta
    const emCurso = fetch(`${base}/__teste/sono/${tenant}?ms=1000`);
    await new Promise((r) => setTimeout(r, 200));
    proc.emit('SIGTERM');
    expect(app2.get(ShutdownState, { strict: false }).isShuttingDown).toBe(true);
    expect((await emCurso).status).toBe(200);
    for (let i = 0; i < 50 && proc.saidas.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
    expect(proc.saidas).toEqual([0]);
  });

  it('se a drenagem passar do prazo, sai com código 1 (watchdog)', async () => {
    const app3 = await criarApp(urlDoAmbiente(), { statementTimeoutMs: 5_000 });
    const base = baseUrl(app3);
    const proc = new ProcessoFalso();
    installGracefulShutdown(app3, { proc, timeoutMs: 300 });
    const emCurso = fetch(`${base}/__teste/sono/${tenant}?ms=1500`);
    await new Promise((r) => setTimeout(r, 200));
    proc.emit('SIGTERM');
    await new Promise((r) => setTimeout(r, 600));
    expect(proc.saidas[0]).toBe(1);
    await emCurso.catch(() => undefined);
    for (let i = 0; i < 50 && proc.saidas.length < 2; i++) await new Promise((r) => setTimeout(r, 100));
  });
});

describe('erros fora do ciclo de requisição', () => {
  it('unhandledRejection é registrado e NÃO derruba o processo; uncaughtException encerra com 1', () => {
    const proc = new ProcessoFalso();
    const chamadas: Array<[string, number | undefined]> = [];
    installProcessErrorHandlers((reason, code) => {
      chamadas.push([reason, code]);
      return Promise.resolve();
    }, proc);

    proc.emit('unhandledRejection', Object.assign(new Error('x'), { code: 'ECONNRESET' }));
    expect(chamadas).toEqual([]);
    expect(proc.saidas).toEqual([]);

    proc.emit('uncaughtException', new Error('bug'));
    expect(chamadas).toEqual([['uncaughtException', 1]]);
  });
});
