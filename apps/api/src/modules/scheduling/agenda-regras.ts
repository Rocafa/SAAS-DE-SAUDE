import type { AppointmentStatusDb } from '../../db/schema';

/**
 * Regras puras da agenda (sem banco): fuso, vocabulário de status do front e transições.
 *
 * Fuso: horário de Brasília fixo (UTC-03:00; o Brasil não tem horário de verão desde 2019). Fuso
 * por clínica (Manaus, Cuiabá, Noronha...) fica para quando houver configuração da clínica.
 */
export const FUSO_DA_CLINICA = '-03:00';
const OFFSET_MS = -3 * 60 * 60 * 1000;

/** Data AAAA-MM-DD + hora HH:MM no fuso da clínica -> instante. Entradas já validadas. */
export function paraInstante(data: string, hora: string): Date {
  return new Date(`${data}T${hora}:00${FUSO_DA_CLINICA}`);
}

/** Instante -> data e hora no fuso da clínica. */
export function noFusoDaClinica(instante: Date): { data: string; hora: string } {
  const local = new Date(instante.getTime() + OFFSET_MS).toISOString();
  return { data: local.slice(0, 10), hora: local.slice(11, 16) };
}

/** Janela [de 00:00, ate+1 00:00) no fuso da clínica. */
export function janelaDeDias(de: string, ate: string): { inicio: Date; fim: Date } {
  const inicio = paraInstante(de, '00:00');
  const fim = new Date(paraInstante(ate, '00:00').getTime() + 24 * 60 * 60 * 1000);
  return { inicio, fim };
}

/** Status no vocabulário do front (apps/web/lib/api/tipos.ts). */
export const STATUS_FRONT = [
  'agendado',
  'confirmado',
  'chegou',
  'em_atendimento',
  'atendido',
  'faltou',
  'cancelado',
] as const;
export type StatusFront = (typeof STATUS_FRONT)[number];

const FRONT_PARA_DB: Readonly<Record<StatusFront, AppointmentStatusDb>> = {
  agendado: 'scheduled',
  confirmado: 'confirmed',
  chegou: 'checked_in',
  em_atendimento: 'in_progress',
  atendido: 'completed',
  faltou: 'no_show',
  cancelado: 'cancelled',
};

export function statusParaDb(s: StatusFront): AppointmentStatusDb {
  return FRONT_PARA_DB[s];
}

export function statusParaFront(s: AppointmentStatusDb): StatusFront {
  const par = Object.entries(FRONT_PARA_DB).find(([, db]) => db === s);
  if (!par) throw new Error('status desconhecido');
  return par[0] as StatusFront;
}

/**
 * Transições permitidas. Inclui as voltas usadas pelo "Desfazer" do front (ex.: chegou -> confirmado,
 * faltou -> agendado). Cancelado é final: "desfazer" um cancelamento exigiria checar a capacidade
 * de novo; nesse caso marca-se outro horário.
 */
const TRANSICOES: Readonly<Record<AppointmentStatusDb, readonly AppointmentStatusDb[]>> = {
  scheduled: ['confirmed', 'checked_in', 'cancelled', 'no_show'],
  confirmed: ['scheduled', 'checked_in', 'cancelled', 'no_show'],
  checked_in: ['scheduled', 'confirmed', 'in_progress', 'completed', 'cancelled'],
  in_progress: ['checked_in', 'completed'],
  completed: ['in_progress'],
  no_show: ['scheduled', 'confirmed'],
  cancelled: [],
};

export function transicaoPermitida(de: AppointmentStatusDb, para: AppointmentStatusDb): boolean {
  return TRANSICOES[de].includes(para);
}

/** Entrar ou sair de "em atendimento"/"atendido" é ato do profissional (permissão agenda:atender). */
export function exigeAtendimento(de: AppointmentStatusDb, para: AppointmentStatusDb): boolean {
  const clinicos: readonly AppointmentStatusDb[] = ['in_progress', 'completed'];
  return clinicos.includes(para) || clinicos.includes(de);
}

/** Status que ocupam vaga no horário (contam para a capacidade). */
export const STATUS_QUE_OCUPAM: readonly AppointmentStatusDb[] = ['scheduled', 'confirmed', 'checked_in', 'in_progress', 'completed'];

/** Só se remarca o que ainda não aconteceu. */
export const STATUS_REMARCAVEIS: readonly AppointmentStatusDb[] = ['scheduled', 'confirmed'];

/** Capacidade do horário: a menor entre a do profissional e a do tipo (AGD-01.5). */
export function capacidadeDoHorario(profissional: number, tipo: number): number {
  return Math.min(profissional, tipo);
}
