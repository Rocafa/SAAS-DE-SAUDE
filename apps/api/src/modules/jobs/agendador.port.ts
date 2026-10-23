/**
 * Agendador de jobs (rodada 20; api-dominio.md §14). Portas plugáveis:
 * - `AgendadorPort`: quem dispara no horário (BullMQ em produção; em memória, disparo manual, em dev/test);
 * - `TravaDeJob`: impede duas execuções do MESMO job em paralelo (entre instâncias, no Redis);
 * - `RegistroDeExecucoes`: último sucesso de cada job, para o sinal de vida (`JOB_ATRASADO`).
 *
 * Nada aqui carrega dado pessoal: nomes de job são códigos fixos, resultados são contagens e o erro é só o
 * nome/código (nunca a mensagem, que pode repetir valor de banco).
 */
import type { TenantId } from '@plataforma/shared';

/** Resultado de um job numa clínica: só contagens e marcas (vai para a trilha, contrato da 0005). */
export type ResultadoDeJob = Readonly<Record<string, number | boolean>>;

export interface Periodicidade {
  /** Cron (fuso America/Sao_Paulo). Exclusivo com `aCadaMs`. */
  readonly cron?: string;
  /** Intervalo fixo em ms. Exclusivo com `cron`. */
  readonly aCadaMs?: number;
  /** Texto para a tabela do api-dominio §14 e para o log. */
  readonly descricao: string;
}

export interface DefinicaoDeJob {
  /** Código fixo (kebab-case, até 40 caracteres): chave no BullMQ, na trava e na trilha. */
  readonly nome: string;
  readonly periodicidade: Periodicidade;
  /**
   * Sinal de vida: sem execução bem-sucedida nesse prazo, `JOB_ATRASADO`. Deve ser maior que o intervalo
   * (folga para retry e para a fila andar).
   */
  readonly prazoMaximoMs: number;
  /** Crítico = entra no sinal de vida (descarte/retenção que a LGPD ou um parecer exige). */
  readonly critico: boolean;
  /** Validade da trava; deve cobrir a execução inteira (todas as clínicas). */
  readonly travaMs: number;
  /**
   * Trilha da execução por clínica: `sempre` (rotinas diárias) ou `com_efeito` (só quando algum número > 0 ou
   * houve erro; para jobs de minutos, que já auditam o que fazem e encheriam a trilha de zeros).
   */
  readonly trilha: 'sempre' | 'com_efeito';
  /** O trabalho numa clínica. Abre a própria transação da clínica (withTenant, sem usuário: sentinela). */
  readonly porClinica: (tenantId: TenantId) => Promise<ResultadoDeJob>;
}

export type ModoDoAgendador = 'bullmq' | 'memoria' | 'desligado';

export interface AgendadorPort {
  readonly modo: Exclude<ModoDoAgendador, 'desligado'>;
  /** Registra os jobs (idempotente: o BullMQ faz upsert e remove agendamentos que saíram do registro). */
  agendar(jobs: readonly DefinicaoDeJob[], executar: (nome: string) => Promise<void>): Promise<void>;
  parar(): Promise<void>;
}

export interface TravaDeJob {
  /** Devolve um token se conseguiu a trava; `null` se outro processo já está rodando o job. */
  adquirir(nome: string, validadeMs: number): Promise<string | null>;
  /** Solta só se o token ainda for o dono (a trava pode ter vencido e sido tomada por outro). */
  liberar(nome: string, token: string): Promise<void>;
}

export interface RegistroDeExecucoes {
  marcarSucesso(nome: string, quandoMs: number): Promise<void>;
  ultimoSucesso(nome: string): Promise<number | null>;
}

/** Erro do job inteiro (alguma clínica falhou depois das tentativas): o BullMQ refaz com backoff. */
export class FalhaDeJobError extends Error {
  override readonly name = 'FalhaDeJobError';
  constructor(
    readonly job: string,
    readonly clinicasComFalha: number,
  ) {
    super(`job ${job}: ${clinicasComFalha} clínica(s) com falha`);
  }
}

const NOME_RE = /^[a-z][a-z0-9-]{0,39}$/;

/** Confere o registro na subida: nome válido e único, uma periodicidade só, prazo maior que o intervalo. */
export function validarDefinicoes(jobs: readonly DefinicaoDeJob[]): void {
  const vistos = new Set<string>();
  for (const j of jobs) {
    if (!NOME_RE.test(j.nome)) throw new Error(`job com nome inválido: ${j.nome}`);
    if (vistos.has(j.nome)) throw new Error(`job duplicado: ${j.nome}`);
    vistos.add(j.nome);
    const { cron, aCadaMs } = j.periodicidade;
    if ((cron === undefined) === (aCadaMs === undefined)) throw new Error(`job ${j.nome}: use cron OU aCadaMs`);
    if (aCadaMs !== undefined && (!Number.isInteger(aCadaMs) || aCadaMs < 60_000)) throw new Error(`job ${j.nome}: intervalo mínimo de 1 min`);
    if (aCadaMs !== undefined && j.prazoMaximoMs <= aCadaMs) throw new Error(`job ${j.nome}: prazo do sinal de vida menor que o intervalo`);
    if (!(j.travaMs > 0) || !(j.prazoMaximoMs > 0)) throw new Error(`job ${j.nome}: trava e prazo positivos`);
    // R4 do parecer dos jobs: a trava de job por intervalo não pode vencer antes do próximo disparo, senão uma
    // passada lenta roda junto com a seguinte (em outra instância). Folga de 2× o intervalo; abaixo do prazo do
    // sinal de vida, para que uma trava órfã (processo morto) apareça como JOB_ATRASADO e não esconda nada.
    if (aCadaMs !== undefined && j.travaMs < 2 * aCadaMs) throw new Error(`job ${j.nome}: trava menor que 2× o intervalo`);
    if (aCadaMs !== undefined && j.travaMs >= j.prazoMaximoMs) throw new Error(`job ${j.nome}: trava maior que o prazo do sinal de vida`);
  }
}

/**
 * Código do erro para log e trilha, SEM a mensagem: SQLSTATE do Postgres (5 caracteres) se houver; senão o
 * nome da classe (só letras). Mensagem de erro pode repetir valor de linha (dado pessoal) — nunca sai.
 */
export function codigoDoErro(err: unknown): string {
  // O drizzle embrulha o erro do driver (`cause`): procura o SQLSTATE em até 3 níveis.
  let atual: unknown = err;
  for (let i = 0; i < 3 && typeof atual === 'object' && atual !== null; i++) {
    const code = (atual as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return `pg_${code}`;
    atual = (atual as { cause?: unknown }).cause;
  }
  if (typeof err === 'object' && err !== null) {
    const nome = (err as { name?: unknown }).name;
    if (typeof nome === 'string' && /^[A-Za-z]{1,40}$/.test(nome)) return nome;
  }
  return 'erro_desconhecido';
}
