/**
 * Adaptadores EM MEMÓRIA do agendador (dev/test): nada dispara sozinho; `disparar(nome)` roda o job na hora,
 * pelo mesmo executor (trava, clínicas, withTenant, trilha) que o BullMQ usa em produção.
 */
import { randomUUID } from 'node:crypto';
import type { AgendadorPort, DefinicaoDeJob, RegistroDeExecucoes, TravaDeJob } from './agendador.port';

export class AgendadorEmMemoria implements AgendadorPort {
  readonly modo = 'memoria' as const;
  private executar: ((nome: string) => Promise<void>) | null = null;
  private nomes = new Set<string>();

  agendar(jobs: readonly DefinicaoDeJob[], executar: (nome: string) => Promise<void>): Promise<void> {
    this.nomes = new Set(jobs.map((j) => j.nome));
    this.executar = executar;
    return Promise.resolve();
  }

  /** Disparo manual (testes e desenvolvimento). Propaga o erro do job. */
  async disparar(nome: string): Promise<void> {
    if (!this.executar) throw new Error('agendador em memória: nenhum job registrado');
    if (!this.nomes.has(nome)) throw new Error(`job desconhecido: ${nome}`);
    await this.executar(nome);
  }

  get registrados(): readonly string[] {
    return [...this.nomes];
  }

  parar(): Promise<void> {
    this.executar = null;
    return Promise.resolve();
  }
}

export class TravaEmMemoria implements TravaDeJob {
  private readonly donos = new Map<string, { token: string; ate: number }>();

  constructor(private readonly agora: () => number = Date.now) {}

  adquirir(nome: string, validadeMs: number): Promise<string | null> {
    const atual = this.donos.get(nome);
    if (atual && atual.ate > this.agora()) return Promise.resolve(null);
    const token = randomUUID();
    this.donos.set(nome, { token, ate: this.agora() + validadeMs });
    return Promise.resolve(token);
  }

  liberar(nome: string, token: string): Promise<void> {
    if (this.donos.get(nome)?.token === token) this.donos.delete(nome);
    return Promise.resolve();
  }
}

export class RegistroEmMemoria implements RegistroDeExecucoes {
  private readonly sucessos = new Map<string, number>();

  marcarSucesso(nome: string, quandoMs: number): Promise<void> {
    this.sucessos.set(nome, quandoMs);
    return Promise.resolve();
  }

  ultimoSucesso(nome: string): Promise<number | null> {
    return Promise.resolve(this.sucessos.get(nome) ?? null);
  }
}
