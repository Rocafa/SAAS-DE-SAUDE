import type { RequestContext } from '@plataforma/shared';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { ConflitoError, NaoEncontradoError } from '../../common/erros-dominio';
import { cashSessions, charges, financeSettings, paymentReversals, payments, receiptCancellations, receipts, type AttendanceKind } from '../../db/schema';
import type { TenantTx } from '../../db/tenant-transaction';
import { hojeNaClinica } from '../insurance/guias-regras';
import { DESCRICAO_NEUTRA_PADRAO, totaisZerados, type TotaisPorForma } from './financeiro-regras';

/**
 * Peças compartilhadas do financeiro.
 *
 * ORDEM DAS TRAVAS (evita deadlock): agendamento/pacote (só no lançamento) -> cobrança (FOR UPDATE)
 * -> caixa (FOR SHARE; o fechamento usa FOR UPDATE e não trava cobrança) -> contador de recibos
 * (UPDATE) -> audit_chain (INSERT da auditoria). Recebimento, estorno, emissão e cancelamento de
 * recibo travam SEMPRE a cobrança primeiro: é ela que serializa tudo o que mexe nos recebimentos dela
 * (recebimento e recibo são append-only, então não há linha deles para travar).
 */

export const SCOPE_CONFIG = 'finance_settings';
export const SCOPE_PERFIL_FISCAL = 'professional_fiscal_profiles';
export const SCOPE_COBRANCAS = 'charges';
export const SCOPE_RECEBIMENTOS = 'payments';
export const SCOPE_ESTORNOS = 'payment_reversals';
export const SCOPE_CAIXA = 'cash_sessions';
export const SCOPE_RECIBOS = 'receipts';
export const SCOPE_CANCELAMENTO_RECIBO = 'receipt_cancellations';
export const SCOPE_RECEITA_SAUDE = 'receita_saude.batch';

export interface ConfigFinanceira {
  readonly descricao: string;
  readonly atendimentoPadrao: AttendanceKind;
  readonly emitenteNome: string | null;
  readonly emitenteCnpj: string | null;
  readonly mostrarRegistroConselho: boolean;
}

/** Sem linha = padrões da plataforma: texto neutro "Atendimento", atendimento pj, conselho oculto. */
export async function carregarConfig(tx: TenantTx, ctx: RequestContext): Promise<ConfigFinanceira> {
  const [c] = await tx.select().from(financeSettings).where(eq(financeSettings.tenantId, ctx.tenantId));
  return {
    descricao: c?.receiptDescription ?? DESCRICAO_NEUTRA_PADRAO,
    atendimentoPadrao: c?.defaultAttendanceKind ?? 'pj',
    emitenteNome: c?.issuerName ?? null,
    emitenteCnpj: c?.issuerCnpj ?? null,
    mostrarRegistroConselho: c?.showCouncilOnReceipt ?? false,
  };
}

export type LinhaCobranca = typeof charges.$inferSelect;

export async function travarCobranca(tx: TenantTx, ctx: RequestContext, id: string): Promise<LinhaCobranca> {
  const [c] = await tx
    .select()
    .from(charges)
    .where(and(eq(charges.tenantId, ctx.tenantId), eq(charges.id, id)))
    .for('update');
  if (!c) throw new NaoEncontradoError();
  return c;
}

/**
 * Caixa ABERTO que recebe o lançamento: o informado (`caixaId`) ou, sem ele, o único caixa aberto de
 * HOJE. Trava FOR SHARE (o fechamento em curso espera ou é esperado). Sem caixa aberto: 409
 * `caixa_fechado`; mais de um aberto hoje sem `caixaId`: 409 `caixa_ambiguo`.
 */
export async function caixaAbertoPara(tx: TenantTx, ctx: RequestContext, caixaId?: string): Promise<string> {
  if (caixaId) {
    const [c] = await tx
      .select({ id: cashSessions.id, status: cashSessions.status })
      .from(cashSessions)
      .where(and(eq(cashSessions.tenantId, ctx.tenantId), eq(cashSessions.id, caixaId)))
      .for('share');
    if (!c) throw new NaoEncontradoError();
    if (c.status !== 'open') throw new ConflitoError('caixa_fechado');
    return c.id;
  }
  const abertos = await tx
    .select({ id: cashSessions.id })
    .from(cashSessions)
    .where(
      and(eq(cashSessions.tenantId, ctx.tenantId), eq(cashSessions.status, 'open'), eq(cashSessions.businessDate, hojeNaClinica())),
    )
    .for('share');
  if (abertos.length === 0) throw new ConflitoError('caixa_fechado');
  if (abertos.length > 1) throw new ConflitoError('caixa_ambiguo');
  return (abertos[0] as { id: string }).id;
}

/** Recibo vivo (não cancelado) do recebimento, se houver. Chamar com a cobrança travada. */
export async function reciboVivoDoRecebimento(tx: TenantTx, ctx: RequestContext, recebimentoId: string) {
  const [r] = await tx
    .select({ id: receipts.id, number: receipts.number })
    .from(receipts)
    .leftJoin(
      receiptCancellations,
      and(eq(receiptCancellations.tenantId, receipts.tenantId), eq(receiptCancellations.receiptId, receipts.id)),
    )
    .where(and(eq(receipts.tenantId, ctx.tenantId), eq(receipts.paymentId, recebimentoId), isNull(receiptCancellations.id)));
  return r ?? null;
}

/** Totais por forma de pagamento: recebidos NO caixa e estornos registrados NO caixa. */
export async function totaisDosCaixas(
  tx: TenantTx,
  ctx: RequestContext,
  caixaIds: readonly string[],
): Promise<Map<string, { recebidos: TotaisPorForma; estornados: TotaisPorForma; lancamentos: number }>> {
  const mapa = new Map<string, { recebidos: TotaisPorForma; estornados: TotaisPorForma; lancamentos: number }>();
  for (const id of caixaIds) mapa.set(id, { recebidos: totaisZerados(), estornados: totaisZerados(), lancamentos: 0 });
  if (caixaIds.length === 0) return mapa;
  const recebidos = await tx
    .select({
      caixa: payments.cashSessionId,
      forma: payments.method,
      total: sql<string>`sum(${payments.amountCents})`,
      n: sql<string>`count(*)`,
    })
    .from(payments)
    .where(and(eq(payments.tenantId, ctx.tenantId), inArray(payments.cashSessionId, [...caixaIds])))
    .groupBy(payments.cashSessionId, payments.method);
  for (const r of recebidos) {
    const m = mapa.get(r.caixa);
    if (!m) continue;
    m.recebidos[r.forma] += Number(r.total);
    m.lancamentos += Number(r.n);
  }
  const estornados = await tx
    .select({
      caixa: paymentReversals.cashSessionId,
      forma: payments.method,
      total: sql<string>`sum(${payments.amountCents})`,
      n: sql<string>`count(*)`,
    })
    .from(paymentReversals)
    .innerJoin(payments, and(eq(payments.tenantId, paymentReversals.tenantId), eq(payments.id, paymentReversals.paymentId)))
    .where(and(eq(paymentReversals.tenantId, ctx.tenantId), inArray(paymentReversals.cashSessionId, [...caixaIds])))
    .groupBy(paymentReversals.cashSessionId, payments.method);
  for (const r of estornados) {
    const m = mapa.get(r.caixa);
    if (!m) continue;
    m.estornados[r.forma] += Number(r.total);
    m.lancamentos += Number(r.n);
  }
  return mapa;
}
