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
 *
 * 0040 (O1 do #73): a RLS também filtra pelo destinatário (`recipient_user_id = app_current_user()`):
 * ler e marcar como lido só o próprio aviso. Criar continua por tenant (INSERT sem RETURNING).
 */
import { Inject, Injectable } from '@nestjs/common';
import { AuditAction, type RequestContext } from '@plataforma/shared';
import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import { NaoEncontradoError } from '../../common/erros-dominio';
import { escreverNaClinica, lerNaClinica } from '../../common/transacao-clinica';
import { auditLog, clinicalNotices, clinicMembers, professionals, type ClinicMemberRole, type ClinicalNoticeKind, type PortalSigiloTransicao, type PsychCompartmentMode } from '../../db/schema';
import type { TenantTx } from '../../db/tenant-transaction';
import { recordAudit } from '../audit/audit-log';
import { registrarEventoDeSeguranca } from '../../security/log-de-seguranca';
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
    })
  | (AvisoBase & {
      /** 0060 (E8 de 04/11): a área sensível do profissional foi desmarcada; `criadoPor` = admin que desmarcou. */
      readonly tipo: 'area_sensivel_desmarcada';
      readonly profissionalId: string;
      readonly criadoPor: string;
    })
  | (AvisoBase & {
      /** 0063 (resto do E10 de 04/11): alerta de anomalia; `usuarioId` = quem disparou (o detalhe está na trilha). */
      readonly tipo: 'alerta_anomalia';
      readonly regra: string;
      readonly usuarioId: string;
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
  if (tipo === 'area_sensivel_desmarcada') return { ...base, tipo, profissionalId: n.professionalId as string, criadoPor: n.createdBy };
  if (tipo === 'alerta_anomalia') return { ...base, tipo, regra: n.anomalyRule as string, usuarioId: n.subjectUserId as string };
  return { ...base, tipo, retencaoId: n.legalHoldId as string, criadoPor: n.createdBy };
}

/**
 * E8 de 04/11 (0060): a área sensível de um profissional foi desmarcada. Avisa o próprio profissional (se tiver
 * usuário) e os DEMAIS admins ativos; nunca quem desmarcou. Só o id do profissional. Devolve quantos foram avisados.
 */
export async function avisarAreaSensivelDesmarcada(tx: TenantTx, ctx: RequestContext, profissionalId: string, usuarioDoProfissional: string | null): Promise<number> {
  const admins = await tx
    .select({ userId: clinicMembers.userId })
    .from(clinicMembers)
    .where(and(eq(clinicMembers.tenantId, ctx.tenantId), eq(clinicMembers.role, 'admin'), isNull(clinicMembers.revokedAt)));
  // R3 do parecer do #133: o profissional só recebe se ainda tiver perfil ativo na clínica (desligado não recebe).
  const profissionalAtivo = usuarioDoProfissional
    ? (await tx
        .select({ userId: clinicMembers.userId })
        .from(clinicMembers)
        .where(and(eq(clinicMembers.tenantId, ctx.tenantId), eq(clinicMembers.userId, usuarioDoProfissional), isNull(clinicMembers.revokedAt)))
        .limit(1)).length > 0
    : false;
  const destinatarios = [...new Set([...admins.map((a) => a.userId), ...(profissionalAtivo && usuarioDoProfissional ? [usuarioDoProfissional] : [])])].filter((u) => u !== ctx.userId);
  if (destinatarios.length === 0) return 0;
  await tx.insert(clinicalNotices).values(
    destinatarios.map((u) => ({
      tenantId: ctx.tenantId,
      recipientUserId: u,
      kind: 'area_sensivel_desmarcada' as const,
      professionalId: profissionalId,
      createdBy: ctx.userId,
    })),
  );
  return destinatarios.length;
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

/** Regras de anomalia que viram aviso (as mesmas do CHECK da 0063). */
export type RegraDeAnomaliaAvisada = 'paginas_de_pacientes' | 'fichas_distintas' | 'limite_por_usuario' | 'vinculo_autoagendado' | 'vinculo_cruzado' | 'mfa_recusas_por_usuario';

/**
 * Resto do E10 de 04/11 (0063): o alerta de anomalia de uma sessão da EQUIPE também avisa os DEMAIS admins ativos (quem
 * disparou não recebe). Só a regra e o id de quem disparou. Devolve quantos foram avisados.
 * - R2 e R7 do parecer do #137: no máximo um aviso por pessoa e regra por DIA no fuso da clínica (a trilha continua com
 *   TODOS os alertas):
 *   se já há outro `anomaly_alert` da mesma regra e do mesmo ator hoje, não avisa de novo.
 * - R1 do parecer do #137: best-effort num SAVEPOINT. Se o aviso falhar, o alerta na trilha e a operação do usuário
 *   continuam; a falha vai para o log de segurança.
 */
export async function avisarAdminsDeAnomalia(tx: TenantTx, ctx: RequestContext, regra: RegraDeAnomaliaAvisada): Promise<number> {
  try {
    return await tx.transaction(async (sp) => {
      const [anteriores] = await sp
        .select({ n: sql<number>`count(*)::int` })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, ctx.tenantId),
            eq(auditLog.actorId, ctx.userId),
            eq(auditLog.action, AuditAction.AnomalyAlert),
            sql`${auditLog.metadata}->>'rule' = ${regra}`,
            // R7 do parecer do #137: período FIXO (o dia no fuso da clínica, -03:00), não 24 h corridas a partir do
            // último alerta: um padrão que se repete todo dia gera um aviso por dia, e não um só enquanto durar.
            sql`${auditLog.createdAt} >= date_trunc('day', now() AT TIME ZONE INTERVAL '-03:00') AT TIME ZONE INTERVAL '-03:00'`,
          ),
        );
      // O alerta atual já está na trilha (mesma transação): mais de um hoje = o primeiro do dia já avisou.
      if ((anteriores?.n ?? 0) > 1) return 0;
      const admins = await sp
        .select({ userId: clinicMembers.userId })
        .from(clinicMembers)
        .where(and(eq(clinicMembers.tenantId, ctx.tenantId), eq(clinicMembers.role, 'admin'), isNull(clinicMembers.revokedAt), ne(clinicMembers.userId, ctx.userId)));
      const destinatarios = [...new Set(admins.map((a) => a.userId))];
      if (destinatarios.length === 0) return 0;
      await sp.insert(clinicalNotices).values(
        destinatarios.map((u) => ({
          tenantId: ctx.tenantId,
          recipientUserId: u,
          kind: 'alerta_anomalia' as const,
          anomalyRule: regra,
          subjectUserId: ctx.userId,
          createdBy: ctx.userId,
        })),
      );
      return destinatarios.length;
    });
  } catch {
    registrarEventoDeSeguranca('TRILHA_NAO_GRAVADA', { tenantId: ctx.tenantId, regra, motivo: 'aviso_de_anomalia' });
    return 0;
  }
}
