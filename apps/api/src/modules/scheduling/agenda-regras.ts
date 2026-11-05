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

/** Status clínicos: os que contam como atendimento (e, portanto, para o vínculo de cuidado). */
export const STATUS_CLINICOS: readonly AppointmentStatusDb[] = ['in_progress', 'completed'];

/** Entrar ou sair de "em atendimento"/"atendido" é ato do profissional (permissão agenda:atender). */
export function exigeAtendimento(de: AppointmentStatusDb, para: AppointmentStatusDb): boolean {
  return STATUS_CLINICOS.includes(para) || STATUS_CLINICOS.includes(de);
}

/** Status que ocupam vaga no horário (contam para a capacidade). */
export const STATUS_QUE_OCUPAM: readonly AppointmentStatusDb[] = ['scheduled', 'confirmed', 'checked_in', 'in_progress', 'completed'];

/** Só se remarca o que ainda não aconteceu (status; o horário é conferido em motivoParaNaoRemarcar). */
export const STATUS_REMARCAVEIS: readonly AppointmentStatusDb[] = ['scheduled', 'confirmed'];

/** Capacidade do horário: a menor entre a do profissional e a do tipo (AGD-01.5). */
export function capacidadeDoHorario(profissional: number, tipo: number): number {
  return Math.min(profissional, tipo);
}

/**
 * Janela em que "em atendimento"/"atendido" pode ser marcado (V1 do parecer do Guardião sobre o PR
 * #61): de `antesMin` antes do início até `depoisMin` depois do fim do agendamento. Fora dela, 409
 * `fora_do_horario`: consulta do futuro ou de muito tempo atrás não vira atendimento (nem vínculo).
 * Registro retroativo, se o produto precisar, será fluxo próprio, auditado e sem gerar vínculo.
 */
export interface JanelaDeAtendimento {
  readonly antesMin: number;
  readonly depoisMin: number;
  /** Alerta `vinculo_autoagendado` quando o profissional passa disto em pacientes distintos em 24 h. */
  readonly alertaAutoagendadosPorDia: number;
}

/** Padrão: 30 min antes do início até 60 min depois do fim; todo autoagendamento atendido alerta. */
export const JANELA_ATENDIMENTO_PADRAO: JanelaDeAtendimento = { antesMin: 30, depoisMin: 60, alertaAutoagendadosPorDia: 0 };
/** Tetos: nem o ambiente abre a janela além de 2 h antes do início e 24 h depois do fim. */
export const JANELA_ATENDIMENTO_TETO = { antesMin: 120, depoisMin: 1440, alertaAutoagendadosPorDia: 1000 } as const;

function inteiroNaFaixa(env: NodeJS.ProcessEnv, nome: string, padrao: number, max: number): number {
  const bruto = env[nome];
  if (bruto === undefined || bruto.trim() === '') return padrao;
  const n = Number(bruto);
  if (!Number.isInteger(n) || n < 0 || n > max) throw new Error(`${nome} inválida: inteiro entre 0 e ${max}`);
  return n;
}

/** ATTENDANCE_WINDOW_BEFORE_MIN, ATTENDANCE_WINDOW_AFTER_MIN e SELF_SCHEDULED_ALERT_PER_DAY (opcionais). */
export function loadJanelaDeAtendimento(env: NodeJS.ProcessEnv = process.env): JanelaDeAtendimento {
  const p = JANELA_ATENDIMENTO_PADRAO;
  const t = JANELA_ATENDIMENTO_TETO;
  return {
    antesMin: inteiroNaFaixa(env, 'ATTENDANCE_WINDOW_BEFORE_MIN', p.antesMin, t.antesMin),
    depoisMin: inteiroNaFaixa(env, 'ATTENDANCE_WINDOW_AFTER_MIN', p.depoisMin, t.depoisMin),
    alertaAutoagendadosPorDia: inteiroNaFaixa(env, 'SELF_SCHEDULED_ALERT_PER_DAY', p.alertaAutoagendadosPorDia, t.alertaAutoagendadosPorDia),
  };
}

/** Entrar em "em atendimento"/"atendido" só dentro da janela do horário do agendamento. */
export function dentroDaJanelaDeAtendimento(inicio: Date, fim: Date, agora: Date, janela: JanelaDeAtendimento): boolean {
  const de = inicio.getTime() - janela.antesMin * 60_000;
  const ate = fim.getTime() + janela.depoisMin * 60_000;
  return agora.getTime() >= de && agora.getTime() <= ate;
}

/**
 * Status que TRAVAM o agendamento (V2 da re-revisão do #61): depois de "em atendimento", "atendido"
 * ou "falta", o horário não muda mais (o banco mantém `reschedule_locked`, migração 0014) e sair
 * deles (voltas do "Desfazer") só vale dentro da janela do horário ORIGINAL.
 */
export const STATUS_QUE_TRAVAM: readonly AppointmentStatusDb[] = ['in_progress', 'completed', 'no_show'];

/**
 * A mudança de status precisa estar dentro da janela de atendimento do horário do agendamento?
 * - destino clínico ("em atendimento"/"atendido"): V1 do #61;
 * - origem clínica ou falta (em_atendimento -> chegou, atendido -> em_atendimento,
 *   faltou -> agendado/confirmado): V2 do #61. Fora da janela, a correção de registro será fluxo
 *   próprio, auditado e sem gerar vínculo; aqui, 409 `fora_do_horario`.
 */
export function exigeJanelaDeAtendimento(de: AppointmentStatusDb, para: AppointmentStatusDb): boolean {
  return STATUS_CLINICOS.includes(para) || STATUS_QUE_TRAVAM.includes(de);
}

/**
 * O horário já passou para fins de agenda: início antes de agora − `antesMin` (a mesma folga da
 * janela de atendimento, para o encaixe de quem chegou há pouco).
 */
export function horarioJaPassou(inicio: Date, agora: Date, janela: JanelaDeAtendimento): boolean {
  return inicio.getTime() < agora.getTime() - janela.antesMin * 60_000;
}

/**
 * Remarcação (V2-a do #61): o que já passou, ou já teve atendimento ou falta, não se remarca
 * (marca-se outro horário), e não se remarca para o passado. Devolve o código do 409, ou null.
 */
export function motivoParaNaoRemarcar(
  atual: { readonly startsAt: Date; readonly status: AppointmentStatusDb; readonly rescheduleLocked: boolean },
  novoInicio: Date,
  agora: Date,
  janela: JanelaDeAtendimento,
): 'status_nao_permite' | 'horario_no_passado' | null {
  if (!STATUS_REMARCAVEIS.includes(atual.status) || atual.rescheduleLocked) return 'status_nao_permite';
  if (horarioJaPassou(atual.startsAt, agora, janela)) return 'status_nao_permite';
  if (horarioJaPassou(novoInicio, agora, janela)) return 'horario_no_passado';
  return null;
}

/** Resposta do paciente pelo canal (rodada 18.3, HU-COM-011): "1" confirma, "2" cancela. */
export type AcaoDoPaciente = 'confirmar' | 'cancelar';
export type ResultadoDaAcaoDoPaciente =
  | { readonly tipo: 'mudar'; readonly para: AppointmentStatusDb }
  | { readonly tipo: 'ja_estava' }
  | { readonly tipo: 'status_nao_permite' };

/**
 * Regra da AGENDA para o que o paciente pode fazer sozinho (não é a transição genérica da recepção):
 * - confirmar: só "agendado" vira "confirmado"; "confirmado" já estava;
 * - cancelar: "agendado" ou "confirmado" viram "cancelado"; "cancelado" já estava;
 * - nada depois do início da consulta, e nada sobre chegou/em atendimento/atendido/falta (a recepção e
 *   o profissional decidem esses).
 * O resultado ainda passa por `transicaoPermitida` no serviço.
 */
export function transicaoPeloPaciente(atual: AppointmentStatusDb, acao: AcaoDoPaciente, inicio: Date, agora: Date): ResultadoDaAcaoDoPaciente {
  if (inicio.getTime() <= agora.getTime()) return { tipo: 'status_nao_permite' };
  if (acao === 'confirmar') {
    if (atual === 'confirmed') return { tipo: 'ja_estava' };
    return atual === 'scheduled' ? { tipo: 'mudar', para: 'confirmed' } : { tipo: 'status_nao_permite' };
  }
  if (atual === 'cancelled') return { tipo: 'ja_estava' };
  return atual === 'scheduled' || atual === 'confirmed' ? { tipo: 'mudar', para: 'cancelled' } : { tipo: 'status_nao_permite' };
}
