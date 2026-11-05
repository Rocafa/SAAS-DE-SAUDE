import { Inject, Injectable } from '@nestjs/common';
import { AuditAction, type RequestContext } from '@plataforma/shared';
import { and, asc, eq } from 'drizzle-orm';
import { ConflitoError, NaoEncontradoError } from '../../common/erros-dominio';
import { escreverNaClinica, lerNaClinica } from '../../common/transacao-clinica';
import { cashSessions, type CashShift } from '../../db/schema';
import { recordAudit } from '../audit/audit-log';
import { hojeNaClinica } from '../insurance/guias-regras';
import { TenantDatabase } from '../tenancy/tenancy.module';
import { SCOPE_CAIXA, totaisDosCaixas } from './financeiro-comum';
import { dinheiroEsperado, totaisZerados, type TotaisPorForma } from './financeiro-regras';

export interface CaixaDto {
  readonly id: string;
  readonly data: string;
  readonly turno: CashShift;
  readonly situacao: 'aberto' | 'fechado';
  readonly abertoEm: string;
  readonly fechadoEm: string | null;
  readonly trocoInicialCentavos: number;
  /** Recebido NESTE caixa por forma (inclusive o que depois foi estornado). */
  readonly recebidoPorForma: TotaisPorForma;
  /** Estornos registrados NESTE caixa por forma (dinheiro que saiu desta gaveta). */
  readonly estornadoPorForma: TotaisPorForma;
  readonly lancamentos: number;
  /** Dinheiro que deveria estar na gaveta: troco + dinheiro recebido − dinheiro estornado. */
  readonly dinheiroEsperadoCentavos: number;
  readonly dinheiroContadoCentavos: number | null;
  /** Contado − esperado (negativo = falta). Só no caixa fechado. */
  readonly diferencaCentavos: number | null;
}

type LinhaCaixa = typeof cashSessions.$inferSelect;

function caixaDto(c: LinhaCaixa, t: { recebidos: TotaisPorForma; estornados: TotaisPorForma; lancamentos: number } | undefined): CaixaDto {
  const recebidos = t?.recebidos ?? totaisZerados();
  const estornados = t?.estornados ?? totaisZerados();
  const esperado = c.status === 'closed' && c.expectedCashCents !== null ? c.expectedCashCents : dinheiroEsperado(c.openingFloatCents, recebidos, estornados);
  return {
    id: c.id,
    data: c.businessDate,
    turno: c.shift,
    situacao: c.status === 'open' ? 'aberto' : 'fechado',
    abertoEm: c.openedAt.toISOString(),
    fechadoEm: c.closedAt?.toISOString() ?? null,
    trocoInicialCentavos: c.openingFloatCents,
    recebidoPorForma: recebidos,
    estornadoPorForma: estornados,
    lancamentos: t?.lancamentos ?? 0,
    dinheiroEsperadoCentavos: esperado,
    dinheiroContadoCentavos: c.countedCashCents,
    diferencaCentavos: c.countedCashCents === null ? null : c.countedCashCents - esperado,
  };
}

/**
 * Caixa diário (FIN-01.2): abre por dia (sempre HOJE, fuso da clínica) e turno, recebe lançamentos
 * enquanto aberto e fecha com a conferência do dinheiro (diferença destacada). Fechado é terminal: o
 * banco recusa mudar a linha e recusa recebimento/estorno nele (trigger com FOR SHARE, que espera o
 * fechamento em curso). Estorno posterior entra no caixa aberto do dia do estorno.
 */
@Injectable()
export class CaixaService {
  constructor(@Inject(TenantDatabase) private readonly db: TenantDatabase) {}

  abrir(ctx: RequestContext, dados: { turno: CashShift; trocoInicialCentavos: number }): Promise<CaixaDto> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      const hoje = hojeNaClinica();
      const [existente] = await tx
        .select({ id: cashSessions.id })
        .from(cashSessions)
        .where(and(eq(cashSessions.tenantId, ctx.tenantId), eq(cashSessions.businessDate, hoje), eq(cashSessions.shift, dados.turno)));
      if (existente) throw new ConflitoError('caixa_ja_aberto');
      const [c] = await tx
        .insert(cashSessions)
        .values({ tenantId: ctx.tenantId, businessDate: hoje, shift: dados.turno, openingFloatCents: dados.trocoInicialCentavos, openedBy: ctx.userId })
        .onConflictDoNothing()
        .returning();
      // Duas aberturas simultâneas do mesmo turno: a segunda cai aqui (UNIQUE dia + turno).
      if (!c) throw new ConflitoError('caixa_ja_aberto');
      await recordAudit(tx, ctx, { action: AuditAction.Create, scope: SCOPE_CAIXA, metadata: { cash_session_id: c.id, shift: c.shift, op: 'open' } });
      return caixaDto(c, undefined);
    });
  }

  /** Fecha com o dinheiro contado; guarda o esperado e a diferença. Trava o caixa (FOR UPDATE). */
  fechar(ctx: RequestContext, id: string, dados: { dinheiroContadoCentavos: number }): Promise<CaixaDto> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      const [atual] = await tx
        .select()
        .from(cashSessions)
        .where(and(eq(cashSessions.tenantId, ctx.tenantId), eq(cashSessions.id, id)))
        .for('update');
      if (!atual) throw new NaoEncontradoError();
      if (atual.status === 'closed') throw new ConflitoError('caixa_fechado');
      const totais = (await totaisDosCaixas(tx, ctx, [id])).get(id);
      const esperado = dinheiroEsperado(atual.openingFloatCents, totais?.recebidos ?? totaisZerados(), totais?.estornados ?? totaisZerados());
      const [c] = await tx
        .update(cashSessions)
        .set({ status: 'closed', closedAt: new Date(), closedBy: ctx.userId, expectedCashCents: esperado, countedCashCents: dados.dinheiroContadoCentavos })
        .where(and(eq(cashSessions.tenantId, ctx.tenantId), eq(cashSessions.id, id)))
        .returning();
      if (!c) throw new NaoEncontradoError();
      await recordAudit(tx, ctx, {
        action: AuditAction.Update,
        scope: SCOPE_CAIXA,
        metadata: { cash_session_id: id, op: 'close', entries: totais?.lancamentos ?? 0, balanced: dados.dinheiroContadoCentavos === esperado },
      });
      return caixaDto(c, totais);
    });
  }

  /** Caixa do dia: todos os turnos de `data` (padrão: hoje) com totais por forma e totais do dia. */
  doDia(ctx: RequestContext, data?: string): Promise<{ data: string; caixas: CaixaDto[]; totalRecebidoPorForma: TotaisPorForma; totalEstornadoPorForma: TotaisPorForma }> {
    return lerNaClinica(this.db, ctx, async (tx) => {
      const dia = data ?? hojeNaClinica();
      const linhas = await tx
        .select()
        .from(cashSessions)
        .where(and(eq(cashSessions.tenantId, ctx.tenantId), eq(cashSessions.businessDate, dia)))
        .orderBy(asc(cashSessions.openedAt), asc(cashSessions.id));
      const totais = await totaisDosCaixas(tx, ctx, linhas.map((l) => l.id));
      const caixas = linhas.map((l) => caixaDto(l, totais.get(l.id)));
      const recebido = totaisZerados();
      const estornado = totaisZerados();
      for (const c of caixas) {
        for (const forma of Object.keys(recebido) as (keyof TotaisPorForma)[]) {
          recebido[forma] += c.recebidoPorForma[forma];
          estornado[forma] += c.estornadoPorForma[forma];
        }
      }
      await recordAudit(tx, ctx, { action: AuditAction.Read, scope: SCOPE_CAIXA, metadata: { op: 'day', count: caixas.length } });
      return { data: dia, caixas, totalRecebidoPorForma: recebido, totalEstornadoPorForma: estornado };
    });
  }

  obter(ctx: RequestContext, id: string): Promise<CaixaDto> {
    return lerNaClinica(this.db, ctx, async (tx) => {
      const [c] = await tx.select().from(cashSessions).where(and(eq(cashSessions.tenantId, ctx.tenantId), eq(cashSessions.id, id)));
      if (!c) throw new NaoEncontradoError();
      const totais = await totaisDosCaixas(tx, ctx, [id]);
      await recordAudit(tx, ctx, { action: AuditAction.Read, scope: SCOPE_CAIXA, metadata: { cash_session_id: id } });
      return caixaDto(c, totais.get(id));
    });
  }
}
