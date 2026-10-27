/**
 * Executor dos jobs (api-dominio.md §14): o MESMO caminho para o BullMQ e para o disparo manual em memória.
 *
 * 1. Trava do job (um por vez entre instâncias); sem trava = outra execução em andamento, pula (`JOB_EM_ANDAMENTO`).
 * 2. Lista as clínicas (`app_job_tenants()`, só ids) e roda o job em CADA uma, separadamente: o trabalho abre a
 *    transação da clínica (withTenant, sentinela de sistema no slot do usuário), então uma clínica nunca vê a
 *    outra e a falha de uma não para as demais.
 * 3. Cada clínica tem `tentativas` com backoff exponencial; esgotadas, o erro vai para o log e para a trilha
 *    DAQUELA clínica só como código (`pg_42501`, `TypeError`...), sem mensagem.
 * 4. Trilha por clínica (scope `jobs`, ator `sistema`): job, situação e as contagens devolvidas.
 * 5. Todas as clínicas ok = último sucesso registrado (sinal de vida). Alguma falhou = `FalhaDeJobError`, e o
 *    BullMQ refaz o job inteiro com backoff (os jobs são idempotentes).
 */
import type { TenantId } from '@plataforma/shared';
import {
  codigoDoErro,
  FalhaDeJobError,
  type DefinicaoDeJob,
  type RegistroDeExecucoes,
  type ResultadoDeJob,
  type TravaDeJob,
} from './agendador.port';

/** Máximo de contagens que vão para a trilha (o contrato da 0005 aceita 16 chaves; 3 são do executor). */
const MAX_CONTAGENS_NA_TRILHA = 12;

export interface LinhaDeTrilhaDoJob {
  readonly job: string;
  readonly situacao: 'ok' | 'erro';
  readonly tentativas: number;
  readonly erro?: string;
  readonly resultado: ResultadoDeJob;
}

export interface LogDoJob {
  log(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface DependenciasDoExecutor {
  readonly jobs: readonly DefinicaoDeJob[];
  readonly trava: TravaDeJob;
  readonly registro: RegistroDeExecucoes;
  readonly listarClinicas: () => Promise<readonly TenantId[]>;
  /** Grava a linha na trilha DA clínica (withTenant + sentinela; ator `sistema`). */
  readonly registrarTrilha: (tenantId: TenantId, linha: LinhaDeTrilhaDoJob) => Promise<void>;
  readonly logger: LogDoJob;
  readonly tentativas?: number;
  readonly backoffMs?: number;
  readonly dormir?: (ms: number) => Promise<void>;
  readonly agora?: () => number;
}

export interface ResumoDaExecucao {
  readonly job: string;
  readonly situacao: 'ok' | 'falhou' | 'em_andamento';
  readonly clinicas: number;
  readonly clinicasComFalha: number;
}

/** Só números finitos e booleanos, chaves válidas para a trilha, no máximo 12. */
export function contagensParaTrilha(resultado: ResultadoDeJob): ResultadoDeJob {
  const saida: Record<string, number | boolean> = {};
  for (const [k, v] of Object.entries(resultado)) {
    if (Object.keys(saida).length >= MAX_CONTAGENS_NA_TRILHA) break;
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(k) || ['job', 'status', 'op', 'erro', 'tentativas'].includes(k)) continue;
    if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 10_000_000)) saida[k] = v;
  }
  return saida;
}

function teveEfeito(resultado: ResultadoDeJob): boolean {
  return Object.values(resultado).some((v) => (typeof v === 'number' && v > 0) || v === true);
}

export class ExecutorDeJobs {
  private readonly porNome: ReadonlyMap<string, DefinicaoDeJob>;
  private readonly tentativas: number;
  private readonly backoffMs: number;
  private readonly dormir: (ms: number) => Promise<void>;
  private readonly agora: () => number;

  constructor(private readonly deps: DependenciasDoExecutor) {
    this.porNome = new Map(deps.jobs.map((j) => [j.nome, j]));
    this.tentativas = deps.tentativas ?? 3;
    this.backoffMs = deps.backoffMs ?? 2_000;
    this.dormir = deps.dormir ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.agora = deps.agora ?? Date.now;
  }

  get jobs(): readonly DefinicaoDeJob[] {
    return this.deps.jobs;
  }

  /** Roda o job em todas as clínicas. Lança `FalhaDeJobError` se alguma clínica falhou (o BullMQ refaz). */
  async executar(nome: string): Promise<ResumoDaExecucao> {
    const job = this.porNome.get(nome);
    if (!job) throw new Error(`job desconhecido: ${nome}`);
    const token = await this.deps.trava.adquirir(nome, job.travaMs);
    if (!token) {
      this.deps.logger.warn(`JOB_EM_ANDAMENTO job=${nome}: outra execução tem a trava; esta foi pulada`);
      return { job: nome, situacao: 'em_andamento', clinicas: 0, clinicasComFalha: 0 };
    }
    try {
      const clinicas = await this.deps.listarClinicas();
      let falhas = 0;
      for (const [posicao, tenantId] of clinicas.entries()) {
        const ok = await this.naClinica(job, tenantId, posicao);
        if (!ok) falhas++;
      }
      if (falhas > 0) throw new FalhaDeJobError(nome, falhas);
      await this.deps.registro.marcarSucesso(nome, this.agora());
      this.deps.logger.log(`JOB_OK job=${nome} clinicas=${clinicas.length}`);
      return { job: nome, situacao: 'ok', clinicas: clinicas.length, clinicasComFalha: 0 };
    } finally {
      await this.deps.trava.liberar(nome, token).catch((err: unknown) => {
        this.deps.logger.warn(`JOB_TRAVA_NAO_LIBERADA job=${nome} erro=${codigoDoErro(err)} (vence sozinha)`);
      });
    }
  }

  private async naClinica(job: DefinicaoDeJob, tenantId: TenantId, posicao: number): Promise<boolean> {
    let ultimoErro: unknown;
    for (let tentativa = 1; tentativa <= this.tentativas; tentativa++) {
      try {
        const resultado = contagensParaTrilha(await job.porClinica(tenantId));
        if (resultado.alarme === true) {
          this.deps.logger.error(`JOB_ALARME job=${job.nome} clinica=${tenantId}: o job sinalizou atraso (ver contagens na trilha)`);
        }
        if (job.trilha === 'sempre' || teveEfeito(resultado) || tentativa > 1) {
          await this.deps.registrarTrilha(tenantId, { job: job.nome, situacao: 'ok', tentativas: tentativa, resultado });
        }
        return true;
      } catch (err) {
        ultimoErro = err;
        if (tentativa < this.tentativas) await this.dormir(this.backoffMs * 2 ** (tentativa - 1));
      }
    }
    const erro = codigoDoErro(ultimoErro);
    // Id da clínica é identificador da plataforma, não dado pessoal; a posição ajuda a achar no lote.
    this.deps.logger.error(`JOB_CLINICA_FALHOU job=${job.nome} clinica=${tenantId} posicao=${posicao} tentativas=${this.tentativas} erro=${erro}`);
    try {
      await this.deps.registrarTrilha(tenantId, { job: job.nome, situacao: 'erro', tentativas: this.tentativas, erro, resultado: {} });
    } catch (err) {
      this.deps.logger.error(`JOB_TRILHA_FALHOU job=${job.nome} clinica=${tenantId} erro=${codigoDoErro(err)}`);
    }
    return false;
  }
}
