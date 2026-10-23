/**
 * Agendador com Redis REAL (rodada 20; api-dominio.md §14): o BullMQ dispara o job agendado, a trava impede
 * duas execuções do mesmo job entre "instâncias" e o último sucesso sobrevive no Redis (sinal de vida).
 * Exige REDIS_URL (serviço Redis no job de segurança do CI). Localmente, sem Redis, pula — a verificação
 * do agendador fica com o adaptador em memória (test/jobs.rls.test.ts e os unitários).
 */
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { AgendadorBullMQ, fabricasReais, RegistroRedis, TravaRedis } from '../../src/modules/jobs/agendador-bullmq';
import type { DefinicaoDeJob } from '../../src/modules/jobs/agendador.port';

const REDIS_URL = process.env.REDIS_URL;
// Teste que pula é verde falso: no CI, a falta do Redis é erro, não "skipped".
if (process.env.CI && !REDIS_URL) throw new Error('REDIS_URL obrigatória no CI para o teste do agendador com Redis');

const NOME = `teste-redis-${randomUUID().slice(0, 8)}`;
const conexoes: Redis[] = [];

function redis(): Redis {
  const r = new Redis(REDIS_URL as string, { maxRetriesPerRequest: 3 });
  conexoes.push(r);
  return r;
}

afterAll(async () => {
  if (!REDIS_URL) return;
  const limpeza = fabricasReais(REDIS_URL);
  const fila = limpeza.fila();
  await fila.removeJobScheduler(NOME);
  await fila.close();
  await limpeza.fechar();
  await Promise.all(conexoes.map((c) => c.quit()));
});

describe.skipIf(!REDIS_URL)('agendador com Redis real', () => {
  it('trava: só uma "instância" pega o mesmo job; quem não é dono não solta', async () => {
    const a = new TravaRedis(redis());
    const b = new TravaRedis(redis());
    const token = await a.adquirir(NOME, 10_000);
    expect(token).not.toBeNull();
    expect(await b.adquirir(NOME, 10_000)).toBeNull();
    await b.liberar(NOME, 'token-de-outro');
    expect(await b.adquirir(NOME, 10_000)).toBeNull();
    await a.liberar(NOME, token as string);
    const depois = await b.adquirir(NOME, 10_000);
    expect(depois).not.toBeNull();
    await b.liberar(NOME, depois as string);
  });

  it('último sucesso fica no Redis e é o mesmo para outra conexão (sinal de vida entre instâncias)', async () => {
    await new RegistroRedis(redis()).marcarSucesso(NOME, 1_234);
    expect(await new RegistroRedis(redis()).ultimoSucesso(NOME)).toBe(1_234);
    expect(await new RegistroRedis(redis()).ultimoSucesso(`${NOME}-nunca`)).toBeNull();
  });

  it('o BullMQ dispara o job agendado e entrega o nome ao executor', async () => {
    const fabricas = fabricasReais(REDIS_URL as string);
    const agendador = new AgendadorBullMQ(fabricas, () => fabricas.fechar());
    const rodados: string[] = [];
    // Intervalo curto só no teste (o registro exige >= 1 min; o adaptador não valida).
    const job: DefinicaoDeJob = {
      nome: NOME,
      periodicidade: { aCadaMs: 500, descricao: 'teste' },
      prazoMaximoMs: 60_000,
      travaMs: 5_000,
      critico: false,
      trilha: 'sempre',
      porClinica: () => Promise.resolve({}),
    };
    try {
      await agendador.agendar([job], (nome) => (rodados.push(nome), Promise.resolve()));
      const limite = Date.now() + 15_000;
      while (rodados.length === 0 && Date.now() < limite) await new Promise((r) => setTimeout(r, 100));
      expect(rodados[0]).toBe(NOME);
    } finally {
      await agendador.parar();
    }
  }, 30_000);
});
