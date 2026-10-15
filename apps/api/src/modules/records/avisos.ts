/**
 * Caixa de avisos interna (R9 do parecer do Guardião sobre o PR #63, item d do B1; migração 0017).
 *
 * Ainda não há módulo de notificações. Quando o admin troca o sigilo da psicologia, cada psicólogo
 * ATIVO da clínica recebe um aviso aqui: só o tipo, o modo anterior e o novo e a contagem de atendimentos
 * restringidos. Nenhum dado de paciente, nenhum conteúdo clínico. Só o destinatário lista e marca como
 * lido (o banco confere o destinatário com o usuário da sessão).
 */
import { Inject, Injectable } from '@nestjs/common';
import { AuditAction, type RequestContext } from '@plataforma/shared';
import { and, desc, eq } from 'drizzle-orm';
import { NaoEncontradoError } from '../../common/erros-dominio';
import { escreverNaClinica, lerNaClinica } from '../../common/transacao-clinica';
import { clinicalNotices, professionals, type PsychCompartmentMode } from '../../db/schema';
import type { TenantTx } from '../../db/tenant-transaction';
import { recordAudit } from '../audit/audit-log';
import { TenantDatabase } from '../tenancy/tenancy.module';
import { modeloPelaEspecialidade } from './modelos';

export interface AvisoDto {
  readonly id: string;
  readonly tipo: 'sigilo_psicologia_alterado';
  readonly de: PsychCompartmentMode;
  readonly para: PsychCompartmentMode;
  readonly anterioresRestringidos: number;
  readonly criadoEm: string;
  readonly lidoEm: string | null;
}

/** Avisa cada psicólogo ativo (com usuário) da clínica da sessão. Devolve quantos foram avisados. */
export async function avisarPsicologosDoSigilo(
  tx: TenantTx,
  ctx: RequestContext,
  de: PsychCompartmentMode,
  para: PsychCompartmentMode,
  restringidos: number,
): Promise<number> {
  const ativos = await tx
    .select({ userId: professionals.userId, especialidade: professionals.specialty })
    .from(professionals)
    .where(and(eq(professionals.tenantId, ctx.tenantId), eq(professionals.active, true)));
  const destinatarios = [
    ...new Set(ativos.filter((p) => p.userId && modeloPelaEspecialidade(p.especialidade) === 'psicologia').map((p) => p.userId as string)),
  ];
  if (destinatarios.length === 0) return 0;
  await tx.insert(clinicalNotices).values(
    destinatarios.map((u) => ({
      tenantId: ctx.tenantId,
      recipientUserId: u,
      kind: 'sigilo_psicologia_alterado' as const,
      fromMode: de,
      toMode: para,
      restrictedExisting: restringidos,
      createdBy: ctx.userId,
    })),
  );
  return destinatarios.length;
}

@Injectable()
export class AvisosService {
  constructor(@Inject(TenantDatabase) private readonly db: TenantDatabase) {}

  listar(ctx: RequestContext): Promise<AvisoDto[]> {
    return lerNaClinica(this.db, ctx, async (tx) => {
      const linhas = await tx
        .select()
        .from(clinicalNotices)
        .where(and(eq(clinicalNotices.tenantId, ctx.tenantId), eq(clinicalNotices.recipientUserId, ctx.userId)))
        .orderBy(desc(clinicalNotices.createdAt), desc(clinicalNotices.id))
        .limit(100);
      return linhas.map((n) => ({
        id: n.id,
        tipo: n.kind,
        de: n.fromMode,
        para: n.toMode,
        anterioresRestringidos: n.restrictedExisting,
        criadoEm: n.createdAt.toISOString(),
        lidoEm: n.readAt?.toISOString() ?? null,
      }));
    });
  }

  /** Marca como lido (idempotente). Aviso de outro destinatário: 404. */
  marcarLido(ctx: RequestContext, id: string): Promise<{ id: string; lidoEm: string }> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      const [n] = await tx
        .select()
        .from(clinicalNotices)
        .where(and(eq(clinicalNotices.tenantId, ctx.tenantId), eq(clinicalNotices.id, id), eq(clinicalNotices.recipientUserId, ctx.userId)))
        .for('update');
      if (!n) throw new NaoEncontradoError();
      if (n.readAt) return { id, lidoEm: n.readAt.toISOString() };
      const agora = new Date();
      await tx.update(clinicalNotices).set({ readAt: agora }).where(and(eq(clinicalNotices.tenantId, ctx.tenantId), eq(clinicalNotices.id, id)));
      await recordAudit(tx, ctx, { action: AuditAction.Update, scope: 'clinical_notices', metadata: { op: 'notice_read', notice_id: id } });
      return { id, lidoEm: agora.toISOString() };
    });
  }
}
