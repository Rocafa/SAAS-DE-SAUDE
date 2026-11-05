import { createHash } from 'node:crypto';
import type { AppointmentStatusDb, SignatureMethod } from '../../db/schema';
import { noFusoDaClinica } from '../scheduling/agenda-regras';

/**
 * Regras puras de guias e pacotes (sem banco): datas no fuso da clínica, situação calculada, alertas
 * e hash da confirmação do paciente. Tudo calculado NO SERVIDOR: o front só exibe.
 */

/** Status do agendamento em que a sessão aconteceu (check-in, em atendimento, atendido): pode consumir. */
export const STATUS_QUE_CONSOMEM: readonly AppointmentStatusDb[] = ['checked_in', 'in_progress', 'completed'];

export function statusConsome(status: AppointmentStatusDb): boolean {
  return STATUS_QUE_CONSOMEM.includes(status);
}

/** Hoje (AAAA-MM-DD) no fuso da clínica. */
export function hojeNaClinica(agora: Date = new Date()): string {
  return noFusoDaClinica(agora).data;
}

/** Dias de calendário de `de` até `ate` (negativo se `ate` é anterior). Datas AAAA-MM-DD válidas. */
export function diasEntre(de: string, ate: string): number {
  return Math.round((Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / 86_400_000);
}

/** AAAA-MM-DD + n dias. */
export function somarDias(data: string, dias: number): string {
  return new Date(Date.parse(`${data}T00:00:00Z`) + dias * 86_400_000).toISOString().slice(0, 10);
}

export type Situacao = 'ativa' | 'vencida' | 'esgotada' | 'cancelada';

export interface SaldoBase {
  readonly cancelada: boolean;
  readonly total: number;
  readonly usadas: number;
  /** AAAA-MM-DD; null = sem validade (pacote). Vale até o fim do dia. */
  readonly validade: string | null;
}

export function saldoDe(b: Pick<SaldoBase, 'total' | 'usadas'>): number {
  return Math.max(0, b.total - b.usadas);
}

export function estaVencida(validade: string | null, hoje: string): boolean {
  return validade !== null && diasEntre(hoje, validade) < 0;
}

/** Vencida tem precedência sobre esgotada: é o que bloqueia o consumo e pede renovação. */
export function situacaoDe(b: SaldoBase, hoje: string): Situacao {
  if (b.cancelada) return 'cancelada';
  if (estaVencida(b.validade, hoje)) return 'vencida';
  if (saldoDe(b) === 0) return 'esgotada';
  return 'ativa';
}

export type TipoAlerta = 'vencida' | 'vence_em_breve' | 'ultimas_sessoes' | 'esgotada';

export interface Alerta {
  readonly tipo: TipoAlerta;
  /** vence_em_breve: dias até a validade (0 = vence hoje). */
  readonly dias?: number;
  /** ultimas_sessoes: sessões restantes. */
  readonly restantes?: number;
}

export interface Limiares {
  /** "Vence em X dias": alerta quando faltam X dias ou menos. */
  readonly diasVencimento: number;
  /** "Só resta N sessão": alerta quando o saldo é N ou menos (e maior que zero). */
  readonly sessoesRestantes: number;
}

export const LIMIARES_GUIA: Limiares = { diasVencimento: 7, sessoesRestantes: 1 };
/** HU-FIN-004: "pacote com 2 sessões restantes" já mostra o aviso de saldo baixo. */
export const LIMIARES_PACOTE: Limiares = { diasVencimento: 7, sessoesRestantes: 2 };

/**
 * Alertas de renovação (CNV-04.5). Guia cancelada não alerta. Vencida só alerta se ainda tinha saldo
 * (as sessões autorizadas se perderiam); esgotada pede renovação para continuar o tratamento.
 */
export function alertasDe(b: SaldoBase, hoje: string, limiares: Limiares): Alerta[] {
  if (b.cancelada) return [];
  const saldo = saldoDe(b);
  if (estaVencida(b.validade, hoje)) return saldo > 0 ? [{ tipo: 'vencida' }] : [];
  const alertas: Alerta[] = [];
  if (saldo === 0) alertas.push({ tipo: 'esgotada' });
  else if (saldo <= limiares.sessoesRestantes) alertas.push({ tipo: 'ultimas_sessoes', restantes: saldo });
  if (b.validade !== null && saldo > 0) {
    const dias = diasEntre(hoje, b.validade);
    if (dias <= limiares.diasVencimento) alertas.push({ tipo: 'vence_em_breve', dias });
  }
  return alertas;
}

/** Número da guia/carteirinha para comparar duplicidade: sem espaço, ponto, hífen e barra; maiúsculas. */
export function normalizarIdentificador(valor: string): string {
  return valor.replace(/[\s./-]/g, '').toUpperCase();
}

export interface RegistroDeConfirmacao {
  readonly tenantId: string;
  readonly consumoId: string;
  readonly agendamentoId: string;
  readonly guiaId: string;
  readonly meio: SignatureMethod;
  readonly dispositivo: string | null;
  readonly assinadaEm: Date;
  readonly registradoPor: string;
}

/**
 * Hash (SHA-256, hex) do registro canônico da confirmação do paciente (CNV-04.4). Sem biometria e
 * sem dado pessoal: só ids, meio, rótulo do dispositivo e instante. Recalculável por quem audita.
 */
export function hashDaConfirmacao(r: RegistroDeConfirmacao): string {
  const canonico = JSON.stringify([
    'v1',
    r.tenantId,
    r.consumoId,
    r.agendamentoId,
    r.guiaId,
    r.meio,
    r.dispositivo,
    r.assinadaEm.toISOString(),
    r.registradoPor,
  ]);
  return createHash('sha256').update(canonico, 'utf8').digest('hex');
}
