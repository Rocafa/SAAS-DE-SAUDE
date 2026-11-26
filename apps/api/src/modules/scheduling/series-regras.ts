import type { AppointmentStatusDb } from '../../db/schema';

/** Teto de sessões de uma série (o CHECK da 0103 e o pacote, que vai até 200, ficam acima). */
export const MAXIMO_SESSOES_DA_SERIE = 100;
/** Data final até um ano (366 dias) depois da inicial (CHECK da 0103). */
export const MAXIMO_DIAS_DA_SERIE = 366;
/** Teto de séries por listagem. */
export const MAXIMO_SERIES = 200;

const DIA_MS = 86_400_000;

export interface RegraDaSerie {
  /** 0 = domingo … 6 = sábado. */
  readonly dias: readonly number[];
  /** 1 = semanal, 2 = quinzenal, … */
  readonly intervaloSemanas: number;
  /** AAAA-MM-DD. */
  readonly dataInicial: string;
  readonly sessoes?: number;
  /** AAAA-MM-DD (inclusive). */
  readonly dataFinal?: string;
}

function emMs(data: string): number {
  return Date.parse(`${data}T00:00:00Z`);
}

function paraData(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Dia da semana (0 = domingo) de uma data AAAA-MM-DD (calendário, sem fuso). */
export function diaDaSemanaDe(data: string): number {
  return new Date(emMs(data)).getUTCDay();
}

export function somarDias(data: string, dias: number): string {
  return paraData(emMs(data) + dias * DIA_MS);
}

/**
 * Datas (AAAA-MM-DD, no calendário da clínica) da série: a partir da data inicial, nos dias da semana escolhidos, de
 * `intervaloSemanas` em `intervaloSemanas` semanas (a semana da data inicial é a primeira; semana começa no domingo),
 * até completar `sessoes` ou passar de `dataFinal`. Devolve no máximo `MAXIMO_SESSOES_DA_SERIE + 1` datas: quem chama
 * recusa a série longa demais. Puro, sem relógio.
 */
export function datasDaSerie(regra: RegraDaSerie): string[] {
  const dias = new Set(regra.dias);
  const inicio = emMs(regra.dataInicial);
  const domingo = inicio - diaDaSemanaDe(regra.dataInicial) * DIA_MS;
  const fim = regra.dataFinal !== undefined ? emMs(regra.dataFinal) : inicio + MAXIMO_DIAS_DA_SERIE * 7 * DIA_MS;
  const alvo = Math.min(regra.sessoes ?? MAXIMO_SESSOES_DA_SERIE + 1, MAXIMO_SESSOES_DA_SERIE + 1);
  const datas: string[] = [];
  if (dias.size === 0 || regra.intervaloSemanas < 1) return datas;
  for (let t = inicio; t <= fim && datas.length < alvo; t += DIA_MS) {
    const semana = Math.floor((t - domingo) / (7 * DIA_MS));
    if (semana % regra.intervaloSemanas !== 0) continue;
    if (dias.has(new Date(t).getUTCDay())) datas.push(paraData(t));
  }
  return datas;
}

/**
 * "Cancelar a partir de": só o que ainda não aconteceu — status agendado ou confirmado (check-in, atendimento, falta
 * e cancelado ficam como estão).
 */
export const STATUS_CANCELAVEIS_DA_SERIE: readonly AppointmentStatusDb[] = ['scheduled', 'confirmed'];

/** Resumo da série por status (o que a listagem mostra). */
export interface ResumoDaSerie {
  readonly agendadas: number;
  readonly realizadas: number;
  readonly faltas: number;
  readonly canceladas: number;
}

export function resumirStatus(linhas: readonly { status: AppointmentStatusDb; n: number }[]): ResumoDaSerie {
  const r = { agendadas: 0, realizadas: 0, faltas: 0, canceladas: 0 };
  for (const { status, n } of linhas) {
    if (status === 'scheduled' || status === 'confirmed') r.agendadas += n;
    else if (status === 'cancelled') r.canceladas += n;
    else if (status === 'no_show') r.faltas += n;
    else r.realizadas += n;
  }
  return r;
}
