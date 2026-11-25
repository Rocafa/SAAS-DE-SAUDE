/**
 * Regras puras da lista de espera (HU-AGD-009, migração 0102): texto da preferência para a tela, período de um
 * horário e compatibilidade de um item com uma vaga liberada. Sem banco, sem relógio.
 */
import type { TenantId } from '@plataforma/shared';
import type { FieldRef } from '../crypto/field-format';
import type { WaitlistPeriod } from '../../db/schema';

/** Limite da observação (curta e administrativa: nunca dado clínico). A doc da rota avisa. */
export const OBSERVACAO_MAX = 120;
/** Teto de itens por listagem (a espera de uma clínica é curta; acima disso, filtre por profissional). */
export const MAXIMO_ITENS_ESPERA = 500;
/** Dias depois da saída da lista até o item ser apagado (o banco fixa o mesmo prazo em app_waitlist_purge_run). */
export const RETENCAO_ESPERA_DIAS = 30;

const DIAS_CURTOS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'] as const;
const PERIODOS: Readonly<Record<WaitlistPeriod, string>> = { manha: 'manhã', tarde: 'tarde', noite: 'noite' };
/** Igual ao fake do front quando não há preferência. */
export const SEM_PREFERENCIA = 'Qualquer horário';

/** Referência do campo cifrado da observação: AAD = clínica + tabela + coluna + id da linha (não renomear sem recifrar). */
export function observacaoRef(tenantId: TenantId, rowId: string): FieldRef {
  return { tenantId, table: 'waitlist_entries', column: 'note', rowId };
}

/** Dias sem repetição e em ordem (domingo primeiro). */
export function normalizarDias(dias: readonly number[]): number[] {
  return [...new Set(dias)].sort((a, b) => a - b);
}

/**
 * Texto que a tela mostra em `preferencia` (contrato do fake: string livre). Monta a partir do estruturado e
 * acrescenta a observação; nada informado = "Qualquer horário".
 */
export function textoDaPreferencia(dias: readonly number[], periodo: WaitlistPeriod | null, observacao: string | null): string {
  const partes: string[] = [];
  if (dias.length > 0 && dias.length < 7) partes.push(normalizarDias(dias).map((d) => DIAS_CURTOS[d] ?? '?').join(', '));
  if (periodo) partes.push(PERIODOS[periodo]);
  if (observacao) partes.push(observacao);
  return partes.length > 0 ? partes.join(' · ') : SEM_PREFERENCIA;
}

/** Período de um horário HH:MM no fuso da clínica: manhã até 11:59, tarde até 17:59, noite depois. */
export function periodoDaHora(hora: string): WaitlistPeriod {
  const h = Number(hora.slice(0, 2));
  if (h < 12) return 'manha';
  if (h < 18) return 'tarde';
  return 'noite';
}

/** Dia da semana (0 = domingo) de uma data AAAA-MM-DD de calendário. */
export function diaDaSemana(data: string): number {
  return new Date(`${data}T12:00:00Z`).getUTCDay();
}
