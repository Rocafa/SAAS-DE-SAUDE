/**
 * Adaptadores de PRODUÇÃO do agendador: BullMQ (job schedulers = repeatable jobs) e Redis (trava e último
 * sucesso). Uma fila só (`plataforma-jobs`); cada job do registro vira um agendamento com id = nome, upsert
 * na subida (N instâncias registram o mesmo agendamento uma vez só) e o BullMQ entrega cada disparo a UM
 * trabalhador. A trava do executor cobre o resto (disparo manual, execução mais longa que o intervalo).
 *
 * Retry: 3 tentativas com backoff exponencial (1 min, 2 min, 4 min) no nível do job; cada clínica ainda tem
 * as tentativas do executor. Log de falha só com nome do job, tentativa e código do erro (sem mensagem).
 */
import { Logger } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { codigoDoErro, type AgendadorPort, type DefinicaoDeJob, type RegistroDeExecucoes, type TravaDeJob } from './agendador.port';

export const FILA_DE_JOBS = 'plataforma-jobs';
export const FUSO_DOS_JOBS = 'America/Sao_Paulo';
export const TENTATIVAS_DO_JOB = 3;
export const BACKOFF_DO_JOB_MS = 60_000;

/** O que o adaptador usa da fila do BullMQ (os testes injetam um dublê). */
export interface FilaDeJobs {
  upsertJobScheduler(
    id: string,
    repeat: { pattern?: string; every?: number; tz?: string },
    template: { name: string; data: Record<string, never>; opts: Record<string, unknown> },
  ): Promise<unknown>;
  getJobSchedulers(start?: number, end?: number): Promise<ReadonlyArray<{ key: string; id?: string | null; name: string }>>;
  removeJobScheduler(id: string): Promise<boolean>;
  close(): Promise<void>;
}

export interface TrabalhadorDeJobs {
  on(evento: 'failed', fn: (job: { name: string; attemptsMade: number } | undefined, err: Error) => void): unknown;
  on(evento: 'error', fn: (err: Error) => void): unknown;
  close(): Promise<void>;
}

export interface FabricasBullMQ {
  fila(): FilaDeJobs;
  trabalhador(processar: (job: { name: string }) => Promise<void>): TrabalhadorDeJobs;
}

/** Fábricas reais: conexão ioredis com `maxRetriesPerRequest: null` (exigência do BullMQ para o trabalhador). */
export function fabricasReais(redisUrl: string): FabricasBullMQ & { fechar(): Promise<void> } {
  const logger = new Logger('jobs');
  const conexoes: Redis[] = [];
  const conectar = (): Redis => {
    const r = new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true });
    r.on('error', (err: Error) => logger.warn(`Redis do agendador indisponível (${codigoDoErro(err)})`));
    conexoes.push(r);
    return r;
  };
  return {
    fila: () => new Queue(FILA_DE_JOBS, { connection: conectar() }),
    trabalhador: (processar) =>
      new Worker(FILA_DE_JOBS, async (job) => processar({ name: job.name }), { connection: conectar(), concurrency: 1 }),
    async fechar() {
      await Promise.all(conexoes.map((c) => c.quit().catch(() => c.disconnect())));
    },
  };
}

export class AgendadorBullMQ implements AgendadorPort {
  readonly modo = 'bullmq' as const;
  private readonly logger = new Logger('jobs');
  private fila: FilaDeJobs | null = null;
  private trabalhador: TrabalhadorDeJobs | null = null;

  constructor(
    private readonly fabricas: FabricasBullMQ,
    private readonly aoFechar: () => Promise<void> = () => Promise.resolve(),
  ) {}

  async agendar(jobs: readonly DefinicaoDeJob[], executar: (nome: string) => Promise<void>): Promise<void> {
    const fila = this.fabricas.fila();
    this.fila = fila;
    for (const j of jobs) {
      const repeat = j.periodicidade.cron !== undefined ? { pattern: j.periodicidade.cron, tz: FUSO_DOS_JOBS } : { every: j.periodicidade.aCadaMs as number };
      await fila.upsertJobScheduler(j.nome, repeat, {
        name: j.nome,
        data: {},
        opts: {
          attempts: TENTATIVAS_DO_JOB,
          backoff: { type: 'exponential', delay: BACKOFF_DO_JOB_MS },
          // Histórico curto: o job não carrega dado pessoal, mas a fila não é lugar de guardar execução.
          removeOnComplete: { count: 50 },
          removeOnFail: { count: 200 },
        },
      });
    }
    // Agendamento que saiu do registro (job removido/renomeado) não pode continuar disparando.
    const ativos = new Set(jobs.map((j) => j.nome));
    for (const s of await fila.getJobSchedulers(0, -1)) {
      const id = s.id ?? s.key;
      if (!ativos.has(id)) {
        await fila.removeJobScheduler(id);
        this.logger.warn(`JOB_REMOVIDO job=${id}: agendamento fora do registro`);
      }
    }
    const trabalhador = this.fabricas.trabalhador((job) => executar(job.name));
    trabalhador.on('failed', (job, err) => {
      this.logger.error(`JOB_FALHOU job=${job?.name ?? 'desconhecido'} tentativa=${job?.attemptsMade ?? 0}/${TENTATIVAS_DO_JOB} erro=${codigoDoErro(err)}`);
    });
    trabalhador.on('error', (err) => this.logger.error(`JOB_TRABALHADOR_ERRO erro=${codigoDoErro(err)}`));
    this.trabalhador = trabalhador;
    this.logger.log(`agendador BullMQ: ${jobs.length} job(s) agendado(s)`);
  }

  async parar(): Promise<void> {
    await this.trabalhador?.close();
    await this.fila?.close();
    this.trabalhador = null;
    this.fila = null;
    await this.aoFechar();
  }
}

const PREFIXO = 'plataforma:jobs';

/** Trava distribuída: SET NX PX; solta só se o token ainda for o dono (Lua, atômico). */
export class TravaRedis implements TravaDeJob {
  constructor(private readonly redis: Redis) {}

  async adquirir(nome: string, validadeMs: number): Promise<string | null> {
    const token = randomUUID();
    const ok = await this.redis.set(`${PREFIXO}:trava:${nome}`, token, 'PX', validadeMs, 'NX');
    return ok === 'OK' ? token : null;
  }

  async liberar(nome: string, token: string): Promise<void> {
    await this.redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      `${PREFIXO}:trava:${nome}`,
      token,
    );
  }
}

/** Último sucesso de cada job no Redis: sobrevive a reinício e é o mesmo para todas as instâncias. */
export class RegistroRedis implements RegistroDeExecucoes {
  constructor(private readonly redis: Redis) {}

  async marcarSucesso(nome: string, quandoMs: number): Promise<void> {
    await this.redis.set(`${PREFIXO}:sucesso:${nome}`, String(quandoMs));
  }

  async ultimoSucesso(nome: string): Promise<number | null> {
    const v = await this.redis.get(`${PREFIXO}:sucesso:${nome}`);
    const n = v === null ? NaN : Number(v);
    return Number.isFinite(n) ? n : null;
  }
}
