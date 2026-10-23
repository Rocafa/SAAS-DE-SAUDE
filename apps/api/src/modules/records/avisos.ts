/**
 * Caixa de avisos interna (R9 do parecer do Guardião sobre o PR #63, item d do B1; migração 0017).
 *
 * Ainda não há módulo de notificações. Quando o admin troca o sigilo da psicologia, cada psicólogo
 * ATIVO da clínica recebe um aviso aqui: só o tipo, o modo anterior e o novo e a contagem de atendimentos
 * restringidos. Nenhum dado de paciente, nenhum conteúdo clínico. Só o destinatário lista e marca como
 * lido (o banco confere o destinatário com o usuário da sessão).
 *
 * 0022 (R13/R15 do #63): os DEMAIS admins ativos da clínica também são avisados quando um perfil é
 * concedido ou revogado e quando a retirada de uma retenção legal é pedida ou aprovada. O aviso leva só
 * ids da equipe, o perfil e o id da retenção (nada de paciente); o fato completo está na trilha.
 */
import { Inject, Injectable } from '@nestjs/common';
import { AuditAction, type RequestContext } from '@plataforma/shared';
import { and, desc, eq, isNull, ne } from 'drizzle-orm';
import { NaoEncontradoError } from '../../common/erros-dominio';
import { escreverNaClinica, lerNaClinica } from '../../common/transacao-clinica';
import { clinicalNotices, clinicMembers, professionals, type ClinicMemberRole, type ClinicalNoticeKind, type PortalSigiloTransicao, type PsychCompartmentMode } from '../../db/schema';
import type { TenantTx } from '../../db/tenant-transaction';
import { recordAudit } from '../audit/audit-log';
import { TenantDatabase } from '../tenancy/tenancy.module';
import { modeloPelaEspecialidade } from './modelos';

interface AvisoBase {
  readonly id: string;
  readonly criadoEm: string;
  readonly lidoEm: string | null;
}
/** Cada tipo devolve SÓ os seus campos (minimização: nada sobra para virar dado a mais). */
export type AvisoDto =
  | (AvisoBase & {
      readonly tipo: 'sigilo_psicologia_alterado';
      readonly de: PsychCompartmentMode;
      readonly para: PsychCompartmentMode;
      readonly anterioresRestringidos: number;
    })
  | (AvisoBase & {
      readonly tipo: 'perfil_alterado';
      /** Usuário da equipe afetado, o perfil e o que mudou; `criadoPor` = admin que mudou. */
      readonly usuarioId: string;
      readonly perfil: ClinicMemberRole;
      readonly mudanca: 'concedido' | 'revogado';
      readonly criadoPor: string;
    })
  | (AvisoBase & {
      readonly tipo: 'retencao_retirada_pedida' | 'retencao_retirada_aprovada';
      /** Id da retenção legal (sem dado do paciente). */
      readonly retencaoId: string;
      readonly criadoPor: string;
    })
  | (AvisoBase & {
      /** 0033 (A3b do #68): pedido do titular aberto no portal. Só o id do pedido; criado pelo sistema. */
      readonly tipo: 'pedido_titular_aberto';
      readonly pedidoId: string;
    })
  | (AvisoBase & {
      /** 0039 (N1 do #73): o recálculo desligou o sigilo do adolescente ou estendeu a representação além dos 18. */
      readonly tipo: 'portal_sigilo_transicao';
      readonly pacienteId: string;
      readonly transicao: PortalSigiloTransicao;
      readonly criadoPor: string;
    });

function paraAvisoDto(n: typeof clinicalNotices.$inferSelect): AvisoDto {
  const base = { id: n.id, criadoEm: n.createdAt.toISOString(), lidoEm: n.readAt?.toISOString() ?? null };
  const tipo: ClinicalNoticeKind = n.kind;
  if (tipo === 'sigilo_psicologia_alterado') {
    return { ...base, tipo, de: n.fromMode as PsychCompartmentMode, para: n.toMode as PsychCompartmentMode, anterioresRestringidos: n.restrictedExisting };
  }
  if (tipo === 'perfil_alterado') {
    return {
      ...base,
      tipo,
      usuarioId: n.subjectUserId as string,
      perfil: n.subjectRole as ClinicMemberRole,
      mudanca: n.change as 'concedido' | 'revogado',
      criadoPor: n.createdBy,
    };
  }
  if (tipo === 'pedido_titular_aberto') return { ...base, tipo, pedidoId: n.rightsRequestId as string };
  if (tipo === 'portal_sigilo_transicao') {
    return { ...base, tipo, pacienteId: n.patientId as string, transicao: n.portalTransition as PortalSigiloTransicao, criadoPor: n.createdBy };
  }
  return { ...base, tipo, retencaoId: n.legalHoldId as string, criadoPor: n.createdBy };
}

const USUARIO_SISTEMA_AVISO = '00000000-0000-0000-0000-000000000000';

/**
 * Avisa os admins ativos da clínica de um pedido do titular aberto no portal (A3b do #68). Roda numa
 * transação de SISTEMA da clínica (sem usuário; o banco só aceita o sentinela para este tipo). Devolve
 * quantos foram avisados.
 */
export async function avisarAdminsDoPedidoDoTitular(tx: TenantTx, tenantId: string, pedidoId: string): Promise<number> {
  const admins = await tx
    .select({ userId: clinicMembers.userId })
    .from(clinicMembers)
    .where(and(eq(clinicMembers.tenantId, tenantId), eq(clinicMembers.role, 'admin'), isNull(clinicMembers.revokedAt)));
  const destinatarios = [...new Set(admins.map((a) => a.userId))];
  if (destinatarios.length === 0) return 0;
  await tx.insert(clinicalNotices).values(
    destinatarios.map((u) => ({
      tenantId,
      recipientUserId: u,
      kind: 'pedido_titular_aberto' as const,
      rightsRequestId: pedidoId,
      createdBy: USUARIO_SISTEMA_AVISO,
    })),
  );
  return destinatarios.length;
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

export type AvisoAosAdmins =
  | { readonly tipo: 'perfil_alterado'; readonly usuarioId: string; readonly perfil: ClinicMemberRole; readonly mudanca: 'concedido' | 'revogado' }
  | { readonly tipo: 'retencao_retirada_pedida' | 'retencao_retirada_aprovada'; readonly retencaoId: string };

/**
 * Avisa os DEMAIS admins ativos (no banco) da clínica da sessão: todos menos quem fez a mudança.
 * Mitiga o conluio/conta dupla (R13 do #63): a mudança nunca passa despercebida pelos outros admins.
 * Devolve quantos foram avisados.
 */
export async function avisarDemaisAdmins(tx: TenantTx, ctx: RequestContext, aviso: AvisoAosAdmins): Promise<number> {
  const admins = await tx
    .select({ userId: clinicMembers.userId })
    .from(clinicMembers)
    .where(
      and(
        eq(clinicMembers.tenantId, ctx.tenantId),
        eq(clinicMembers.role, 'admin'),
        isNull(clinicMembers.revokedAt),
        ne(clinicMembers.userId, ctx.userId),
      ),
    );
  const destinatarios = [...new Set(admins.map((a) => a.userId))];
  if (destinatarios.length === 0) return 0;
  await tx.insert(clinicalNotices).values(
    destinatarios.map((u) => ({
      tenantId: ctx.tenantId,
      recipientUserId: u,
      kind: aviso.tipo,
      ...(aviso.tipo === 'perfil_alterado'
        ? { subjectUserId: aviso.usuarioId, subjectRole: aviso.perfil, change: aviso.mudanca }
        : { legalHoldId: aviso.retencaoId }),
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
      return linhas.map(paraAvisoDto);
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
