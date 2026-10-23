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
import { codigoDoErro, nomeParaLog, type AgendadorPort, type DefinicaoDeJob, type JobAposentado, type RegistroDeExecucoes, type TravaDeJob } from './agendador.port';

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

/**
 * Onde a fila mora no Redis. Produção usa o padrão (`bull:plataforma-jobs:*`). O teste com Redis real usa
 * prefixo e nome ALEATÓRIOS, para nunca tocar (nem apagar, na remoção de agendamentos aposentados) a
 * fila de um ambiente de verdade (R5 b do parecer dos jobs).
 */
export interface LocalDaFila {
  readonly nome?: string;
  /** Prefixo das chaves do BullMQ (padrão do BullMQ: `bull`). */
  readonly prefixo?: string;
}

/**
 * N1 do parecer dos jobs: o BullMQ grava `failedReason` (a mensagem) e o `stacktrace` da falha no Redis. O
 * processador relança só um erro novo com o CÓDIGO (`codigoDoErro`), nunca a mensagem original, que poderia
 * repetir valor de banco. O retry com backoff continua (qualquer exceção conta como falha).
 */
export function processadorSeguro(processar: (job: { name: string }) => Promise<void>): (job: { name: string }) => Promise<void> {
  return async (job) => {
    try {
      await processar({ name: job.name });
    } catch (err) {
      // Sem `cause` DE PROPÓSITO (N1): a causa carregaria a mensagem original junto com o erro.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(codigoDoErro(err));
    }
  };
}

/** Fábricas reais: conexão ioredis com `maxRetriesPerRequest: null` (exigência do BullMQ para o trabalhador). */
export function fabricasReais(redisUrl: string, local: LocalDaFila = {}): FabricasBullMQ & { fechar(): Promise<void> } {
  const nome = local.nome ?? FILA_DE_JOBS;
  const prefixo = local.prefixo !== undefined ? { prefix: local.prefixo } : {};
  const logger = new Logger('jobs');
  const conexoes: Redis[] = [];
  const conectar = (): Redis => {
    const r = new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true });
    r.on('error', (err: Error) => logger.warn(`Redis do agendador indisponível (${codigoDoErro(err)})`));
    conexoes.push(r);
    return r;
  };
  return {
    fila: () => new Queue(nome, { connection: conectar(), ...prefixo }),
    trabalhador: (processar) => new Worker(nome, processadorSeguro(processar), { connection: conectar(), concurrency: 1, ...prefixo }),
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

  async agendar(jobs: readonly DefinicaoDeJob[], executar: (nome: string) => Promise<void>, aposentados: readonly JobAposentado[] = []): Promise<void> {
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
    // R5 do parecer dos jobs: só sai o agendamento de job APOSENTADO (lista versionada do registro). Fora do
    // registro e fora da lista = provavelmente de uma versão mais nova (deploy gradual): fica, com aviso.
    const ativos = new Set(jobs.map((j) => j.nome));
    const aposentadosPorNome = new Set(aposentados.map((a) => a.nome));
    for (const s of await fila.getJobSchedulers(0, -1)) {
      const id = s.id ?? s.key;
      if (ativos.has(id)) continue;
      if (aposentadosPorNome.has(id)) {
        await fila.removeJobScheduler(id);
        this.logger.warn(`JOB_REMOVIDO job=${id}: aposentado no registro`);
      } else {
        this.logger.warn(`JOB_DESCONHECIDO job=${nomeParaLog(id)}: fora do registro desta versão; mantido (só sai se aposentado)`);
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

export const PREFIXO_DAS_CHAVES = 'plataforma:jobs';

/** Trava distribuída: SET NX PX; solta só se o token ainda for o dono (Lua, atômico). */
export class TravaRedis implements TravaDeJob {
  /** `prefixo`: só o teste com Redis real troca (aleatório), para não tocar chaves de um ambiente real. */
  constructor(
    private readonly redis: Redis,
    private readonly prefixo: string = PREFIXO_DAS_CHAVES,
  ) {}

  async adquirir(nome: string, validadeMs: number): Promise<string | null> {
    const token = randomUUID();
    const ok = await this.redis.set(`${this.prefixo}:trava:${nome}`, token, 'PX', validadeMs, 'NX');
    return ok === 'OK' ? token : null;
  }

  async liberar(nome: string, token: string): Promise<void> {
    await this.redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      `${this.prefixo}:trava:${nome}`,
      token,
    );
  }
}

/** Último sucesso de cada job no Redis: sobrevive a reinício e é o mesmo para todas as instâncias. */
export class RegistroRedis implements RegistroDeExecucoes {
  constructor(
    private readonly redis: Redis,
    private readonly prefixo: string = PREFIXO_DAS_CHAVES,
  ) {}

  async marcarSucesso(nome: string, quandoMs: number): Promise<void> {
    await this.redis.set(`${this.prefixo}:sucesso:${nome}`, String(quandoMs));
  }

  async ultimoSucesso(nome: string): Promise<number | null> {
    const v = await this.redis.get(`${this.prefixo}:sucesso:${nome}`);
    const n = v === null ? NaN : Number(v);
    return Number.isFinite(n) ? n : null;
  }
}
