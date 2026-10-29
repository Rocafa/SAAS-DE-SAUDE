import type { ModoDoAgendador } from './agendador.port';

/** Rótulo fixo do agendador para o /health/ready (como o modo do rate limit): sem detalhe de erro nem host. */
export type ModoDosJobs = ModoDoAgendador | 'nao_iniciado';

let modoAtual: ModoDosJobs = 'nao_iniciado';

export function registrarModoDosJobs(modo: ModoDosJobs): void {
  modoAtual = modo;
}

export function modoDosJobs(): ModoDosJobs {
  return modoAtual;
}
