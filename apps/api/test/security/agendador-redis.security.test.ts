/**
 * Agendador com Redis REAL (rodada 20; api-dominio.md §14): o BullMQ dispara o job agendado, a trava impede
 * duas execuções do mesmo job entre "instâncias" e o último sucesso sobrevive no Redis (sinal de vida).
 *
 * R5 b do parecer dos jobs — o teste NUNCA toca um Redis de verdade:
 * - só roda com Redis LOCAL (localhost, 127.0.0.1 ou ::1) E com a variável explícita `JOBS_REDIS_TESTE=1`;
 *   fora disso, recusa (não conecta). No CI a recusa é erro: teste pulado é verde falso;
 * - fila com PREFIXO e NOME aleatórios (o `agendar` remove agendamentos fora do registro: na fila padrão,
 *   apagaria os agendamentos reais), e chaves de trava/sucesso com prefixo aleatório;
 * - a limpeza apaga só o que este teste criou (a fila aleatória e as chaves com o prefixo aleatório).
 */
import Redis from 'ioredis';
import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { AgendadorBullMQ, fabricasReais, FILA_DE_JOBS, PREFIXO_DAS_CHAVES, RegistroRedis, TravaRedis } from '../../src/modules/jobs/agendador-bullmq';
import type { DefinicaoDeJob } from '../../src/modules/jobs/agendador.port';

const HOSTS_LOCAIS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Motivo da recusa, ou `null` se o Redis informado é local e o teste foi pedido explicitamente. */
function recusaDoRedisDeTeste(env: NodeJS.ProcessEnv): string | null {
  const url = env.REDIS_URL?.trim();
  if (!url) return 'REDIS_URL ausente';
  if (env.JOBS_REDIS_TESTE !== '1') return 'JOBS_REDIS_TESTE=1 ausente (pedido explícito)';
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== 'redis:' && u.protocol !== 'rediss:') return 'REDIS_URL não é redis:// nem rediss://';
    host = u.hostname;
  } catch {
    return 'REDIS_URL inválida';
  }
  return HOSTS_LOCAIS.has(host) ? null : 'Redis não é local';
}

const recusa = recusaDoRedisDeTeste(process.env);
// Teste que pula é verde falso: no CI, recusar é erro, não "skipped".
if (process.env.CI && recusa) throw new Error(`teste do agendador com Redis real recusado no CI: ${recusa}`);
const REDIS_URL = recusa ? '' : (process.env.REDIS_URL as string);

const sufixo = randomBytes(6).toString('hex');
const PREFIXO_FILA = `teste-jobs-${sufixo}`;
const NOME_FILA = `fila-teste-${sufixo}`;
const PREFIXO_CHAVES = `teste:jobs:${sufixo}`;
const NOME = `teste-redis-${sufixo}`;
const conexoes: Redis[] = [];

function redis(): Redis {
  const r = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });
  conexoes.push(r);
  return r;
}

afterAll(async () => {
  if (recusa) return;
  // Só o que este teste criou: a fila aleatória inteira (prefixo próprio) e as chaves do prefixo aleatório.
  const limpeza = fabricasReais(REDIS_URL, { nome: NOME_FILA, prefixo: PREFIXO_FILA });
  const fila = limpeza.fila() as unknown as { obliterate(o: { force: boolean }): Promise<void>; close(): Promise<void> };
  await fila.obliterate({ force: true });
  await fila.close();
  await limpeza.fechar();
  const r = redis();
  await r.del(`${PREFIXO_CHAVES}:trava:${NOME}`, `${PREFIXO_CHAVES}:sucesso:${NOME}`);
  await Promise.all(conexoes.map((c) => c.quit()));
});

describe('guarda do teste com Redis real (R5 b)', () => {
  it('recusa Redis remoto, sem a variável explícita, ou URL estranha; aceita só local com JOBS_REDIS_TESTE=1', () => {
    expect(recusaDoRedisDeTeste({})).toBe('REDIS_URL ausente');
    expect(recusaDoRedisDeTeste({ REDIS_URL: 'redis://localhost:6379' })).toMatch(/JOBS_REDIS_TESTE/);
    expect(recusaDoRedisDeTeste({ REDIS_URL: 'redis://localhost:6379', JOBS_REDIS_TESTE: 'true' })).toMatch(/JOBS_REDIS_TESTE/);
    expect(recusaDoRedisDeTeste({ REDIS_URL: 'rediss://staging.exemplo.invalid:6379', JOBS_REDIS_TESTE: '1' })).toBe('Redis não é local');
    expect(recusaDoRedisDeTeste({ REDIS_URL: 'redis://10.0.0.5:6379', JOBS_REDIS_TESTE: '1' })).toBe('Redis não é local');
    expect(recusaDoRedisDeTeste({ REDIS_URL: 'redis://localhost.exemplo.invalid', JOBS_REDIS_TESTE: '1' })).toBe('Redis não é local');
    expect(recusaDoRedisDeTeste({ REDIS_URL: 'http://localhost:6379', JOBS_REDIS_TESTE: '1' })).toMatch(/não é redis/);
    expect(recusaDoRedisDeTeste({ REDIS_URL: 'nada', JOBS_REDIS_TESTE: '1' })).toBe('REDIS_URL inválida');
    for (const url of ['redis://localhost:6379', 'redis://127.0.0.1:6380/2', 'redis://[::1]:6379']) {
      expect(recusaDoRedisDeTeste({ REDIS_URL: url, JOBS_REDIS_TESTE: '1' }), url).toBeNull();
    }
  });

  it('a fila e as chaves do teste nunca são as de produção', () => {
    expect(NOME_FILA).not.toBe(FILA_DE_JOBS);
    expect(PREFIXO_FILA).not.toBe('bull');
    expect(PREFIXO_CHAVES.startsWith(PREFIXO_DAS_CHAVES)).toBe(false);
  });
});

describe.skipIf(recusa !== null)('agendador com Redis real', () => {
  it('trava: só uma "instância" pega o mesmo job; quem não é dono não solta', async () => {
    const a = new TravaRedis(redis(), PREFIXO_CHAVES);
    const b = new TravaRedis(redis(), PREFIXO_CHAVES);
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
    await new RegistroRedis(redis(), PREFIXO_CHAVES).marcarSucesso(NOME, 1_234);
    expect(await new RegistroRedis(redis(), PREFIXO_CHAVES).ultimoSucesso(NOME)).toBe(1_234);
    expect(await new RegistroRedis(redis(), PREFIXO_CHAVES).ultimoSucesso(`${NOME}-nunca`)).toBeNull();
    // A chave real (prefixo de produção) não foi tocada.
    expect(await redis().exists(`${PREFIXO_DAS_CHAVES}:sucesso:${NOME}`)).toBe(0);
  });

  it('o BullMQ dispara o job agendado e entrega o nome ao executor (fila aleatória)', async () => {
    const fabricas = fabricasReais(REDIS_URL, { nome: NOME_FILA, prefixo: PREFIXO_FILA });
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
      // O agendamento ficou na fila aleatória (prefixo próprio).
      const conferencia = fabricasReais(REDIS_URL, { nome: NOME_FILA, prefixo: PREFIXO_FILA });
      const fila = conferencia.fila();
      try {
        expect((await fila.getJobSchedulers(0, -1)).map((s) => s.id ?? s.key)).toEqual([NOME]);
      } finally {
        await fila.close();
        await conferencia.fechar();
      }
    } finally {
      await agendador.parar();
    }
  }, 30_000);
});
