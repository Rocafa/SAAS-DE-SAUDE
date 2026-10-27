import { AuditAction, type RequestContext } from '@plataforma/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { NaoEncontradoError } from '../../common/erros-dominio';
import { appointments, guideSessions, insuranceGuides, packageSessions, sessionPackages } from '../../db/schema';
import type { TenantTx } from '../../db/tenant-transaction';
import { recordAudit } from '../audit/audit-log';

/**
 * Peças do consumo de sessão compartilhadas por guias, pacotes e agenda.
 *
 * ORDEM DAS TRAVAS (evita deadlock): agendamento (FOR UPDATE) -> guia ou pacote (FOR UPDATE) ->
 * audit_chain (o INSERT da auditoria). Todo caminho que consome ou estorna segue essa ordem,
 * inclusive a mudança de status da agenda (que já trava o agendamento antes).
 */

export const SCOPE_CONSUMO_GUIA = 'guide_sessions';
export const SCOPE_CONSUMO_PACOTE = 'package_sessions';

export async function travarAgendamento(tx: TenantTx, ctx: RequestContext, id: string) {
  const [a] = await tx
    .select()
    .from(appointments)
    .where(and(eq(appointments.tenantId, ctx.tenantId), eq(appointments.id, id)))
    .for('update');
  if (!a) throw new NaoEncontradoError();
  return a;
}

/** Consumo ativo (não estornado) do agendamento, em guia ou pacote. Chamar com o agendamento travado. */
export async function consumoAtivoDoAgendamento(
  tx: TenantTx,
  ctx: RequestContext,
  agendamentoId: string,
): Promise<{ guia: string | null; pacote: string | null }> {
  const [g] = await tx
    .select({ id: guideSessions.id })
    .from(guideSessions)
    .where(
      and(eq(guideSessions.tenantId, ctx.tenantId), eq(guideSessions.appointmentId, agendamentoId), isNull(guideSessions.reversedAt)),
    );
  const [p] = await tx
    .select({ id: packageSessions.id })
    .from(packageSessions)
    .where(
      and(
        eq(packageSessions.tenantId, ctx.tenantId),
        eq(packageSessions.appointmentId, agendamentoId),
        isNull(packageSessions.reversedAt),
      ),
    );
  return { guia: g?.id ?? null, pacote: p?.id ?? null };
}

/**
 * Estorno automático quando o status do agendamento deixa de ser "sessão realizada" (ex.: atendido
 * corrigido para faltou ou cancelado — HU-CNV-003 "Estorno ao desfazer"). Roda na transação da agenda,
 * com o agendamento JÁ travado; devolve quantos consumos foram estornados.
 */
export async function estornarConsumosDoAgendamento(tx: TenantTx, ctx: RequestContext, agendamentoId: string): Promise<number> {
  const ativo = await consumoAtivoDoAgendamento(tx, ctx, agendamentoId);
  let estornados = 0;
  const agora = new Date();
  if (ativo.guia) {
    const [consumo] = await tx.select().from(guideSessions).where(eq(guideSessions.id, ativo.guia));
    if (consumo) {
      await tx
        .select({ id: insuranceGuides.id })
        .from(insuranceGuides)
        .where(and(eq(insuranceGuides.tenantId, ctx.tenantId), eq(insuranceGuides.id, consumo.guideId)))
        .for('update');
      await tx
        .update(guideSessions)
        .set({ reversedAt: agora, reversedBy: ctx.userId, reversalReason: 'status_corrigido' })
        .where(and(eq(guideSessions.tenantId, ctx.tenantId), eq(guideSessions.id, consumo.id)));
      await tx
        .update(insuranceGuides)
        .set({ usedSessions: sql`${insuranceGuides.usedSessions} - 1`, updatedAt: agora })
        .where(and(eq(insuranceGuides.tenantId, ctx.tenantId), eq(insuranceGuides.id, consumo.guideId)));
      await recordAudit(tx, ctx, {
        action: AuditAction.Update,
        scope: SCOPE_CONSUMO_GUIA,
        metadata: { guide_session_id: consumo.id, guide_id: consumo.guideId, appointment_id: agendamentoId, op: 'reverse', reason: 'status_corrigido' },
      });
      estornados++;
    }
  }
  if (ativo.pacote) {
    const [consumo] = await tx.select().from(packageSessions).where(eq(packageSessions.id, ativo.pacote));
    if (consumo) {
      await tx
        .select({ id: sessionPackages.id })
        .from(sessionPackages)
        .where(and(eq(sessionPackages.tenantId, ctx.tenantId), eq(sessionPackages.id, consumo.packageId)))
        .for('update');
      await tx
        .update(packageSessions)
        .set({ reversedAt: agora, reversedBy: ctx.userId, reversalReason: 'status_corrigido' })
        .where(and(eq(packageSessions.tenantId, ctx.tenantId), eq(packageSessions.id, consumo.id)));
      await tx
        .update(sessionPackages)
        .set({ usedSessions: sql`${sessionPackages.usedSessions} - 1`, updatedAt: agora })
        .where(and(eq(sessionPackages.tenantId, ctx.tenantId), eq(sessionPackages.id, consumo.packageId)));
      await recordAudit(tx, ctx, {
        action: AuditAction.Update,
        scope: SCOPE_CONSUMO_PACOTE,
        metadata: { package_session_id: consumo.id, package_id: consumo.packageId, appointment_id: agendamentoId, op: 'reverse', reason: 'status_corrigido' },
      });
      estornados++;
    }
  }
  return estornados;
}
