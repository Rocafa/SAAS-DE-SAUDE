/**
 * Retenção legal do paciente (D1.4, R10 e R12 do parecer do Guardião sobre o PR #63; migração 0017).
 *
 * - Marcar: o admin informa a REFERÊNCIA do processo ou ofício (requisição judicial, da ANPD ou processo
 *   ético). Ela é gravada cifrada (chave da clínica, AAD por linha) e nunca vai para a trilha.
 * - Enquanto houver retenção ativa, nada do paciente é eliminado: nem o expurgo (0015), nem a lápide
 *   do descarte, nem a troca do conteúdo da nota, pelo autor, pelo ciclo automático ou pela custódia
 *   (R10). A API responde 409 `retencao_legal`; o banco recusa também (trigger da 0017).
 * - Retirar (R12) é em DUAS ETAPAS e por DUAS PESSOAS: um admin pede, com MOTIVO (cifrado); OUTRO admin
 *   aprova. O banco confere que cada etapa é do usuário da sessão e que quem aprova não é quem pediu.
 *   Tudo auditado, só com ids e a etapa (sem referência nem motivo).
 */
import { Inject, Injectable } from '@nestjs/common';
import { AuditAction, type RequestContext } from '@plataforma/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { ConflitoError, NaoEncontradoError } from '../../common/erros-dominio';
import { escreverNaClinica } from '../../common/transacao-clinica';
import { legalHolds, patients } from '../../db/schema';
import type { TenantTx } from '../../db/tenant-transaction';
import { recordAudit } from '../audit/audit-log';
import { FIELD_CIPHER } from '../crypto/crypto.module';
import type { FieldCipher } from '../crypto/field-cipher';
import { TenantDatabase } from '../tenancy/tenancy.module';
import { CAMPO_RETENCAO_MOTIVO, CAMPO_RETENCAO_REFERENCIA, cifrarCampoClinico } from './record-fields';

export interface EstadoDaRetencao {
  readonly retencaoLegalDesde: string | null;
  /** Pedido de retirada pendente de aprovação por outra pessoa. */
  readonly retiradaPendente: boolean;
}

/** R10: o paciente está sob retenção legal? (na transação do chamador, clínica da sessão) */
export async function pacienteSobRetencao(tx: TenantTx, ctx: RequestContext, pacienteId: string): Promise<boolean> {
  const [p] = await tx
    .select({ desde: patients.legalHoldSince })
    .from(patients)
    .where(and(eq(patients.tenantId, ctx.tenantId), eq(patients.id, pacienteId)));
  return p?.desde != null;
}

/** R10: recusa (409 `retencao_legal`) eliminar ou alterar conteúdo de paciente sob retenção. */
export async function exigirSemRetencao(tx: TenantTx, ctx: RequestContext, pacienteId: string): Promise<void> {
  if (await pacienteSobRetencao(tx, ctx, pacienteId)) throw new ConflitoError('retencao_legal');
}

@Injectable()
export class RetencaoLegalService {
  constructor(
    @Inject(TenantDatabase) private readonly db: TenantDatabase,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher<TenantTx>,
  ) {}

  /** Marca a retenção com a referência do processo/ofício. Já marcada: devolve o estado (idempotente). */
  marcar(ctx: RequestContext, pacienteId: string, referencia: string): Promise<EstadoDaRetencao> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      await this.travarPaciente(tx, ctx, pacienteId);
      const ativa = await this.ativa(tx, ctx, pacienteId);
      if (!ativa) {
        const id = randomUUID();
        await tx.insert(legalHolds).values({
          id,
          tenantId: ctx.tenantId,
          patientId: pacienteId,
          referenceEnc: await cifrarCampoClinico(this.cipher, tx, ctx, id, CAMPO_RETENCAO_REFERENCIA, referencia),
          placedBy: ctx.userId,
        });
        await recordAudit(tx, ctx, {
          action: AuditAction.Update,
          scope: 'patients',
          metadata: { patient_id: pacienteId, op: 'legal_hold', active: true, hold_id: id },
        });
      }
      return this.estado(tx, ctx, pacienteId);
    });
  }

  /** 1ª etapa da retirada: pedido com motivo (cifrado). Já existe pedido pendente: 409. */
  pedirRetirada(ctx: RequestContext, pacienteId: string, motivo: string): Promise<EstadoDaRetencao> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      await this.travarPaciente(tx, ctx, pacienteId);
      const ativa = await this.ativa(tx, ctx, pacienteId);
      if (!ativa) throw new ConflitoError('sem_retencao_legal');
      if (ativa.releaseRequestedBy) throw new ConflitoError('retirada_ja_pedida');
      await tx
        .update(legalHolds)
        .set({
          releaseRequestedBy: ctx.userId,
          releaseRequestedAt: new Date(),
          releaseReasonEnc: await cifrarCampoClinico(this.cipher, tx, ctx, ativa.id, CAMPO_RETENCAO_MOTIVO, motivo),
        })
        .where(and(eq(legalHolds.tenantId, ctx.tenantId), eq(legalHolds.id, ativa.id)));
      await recordAudit(tx, ctx, {
        action: AuditAction.Update,
        scope: 'patients',
        metadata: { patient_id: pacienteId, op: 'legal_hold_release_request', hold_id: ativa.id },
      });
      return this.estado(tx, ctx, pacienteId);
    });
  }

  /** 2ª etapa: aprovação por OUTRO admin. O mesmo que pediu: 409 `mesma_pessoa`. */
  aprovarRetirada(ctx: RequestContext, pacienteId: string): Promise<EstadoDaRetencao> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      await this.travarPaciente(tx, ctx, pacienteId);
      const ativa = await this.ativa(tx, ctx, pacienteId);
      if (!ativa) throw new ConflitoError('sem_retencao_legal');
      if (!ativa.releaseRequestedBy) throw new ConflitoError('retirada_nao_pedida');
      if (ativa.releaseRequestedBy === ctx.userId) throw new ConflitoError('mesma_pessoa');
      await tx
        .update(legalHolds)
        .set({ releasedBy: ctx.userId, releasedAt: new Date() })
        .where(and(eq(legalHolds.tenantId, ctx.tenantId), eq(legalHolds.id, ativa.id)));
      await recordAudit(tx, ctx, {
        action: AuditAction.Update,
        scope: 'patients',
        metadata: { patient_id: pacienteId, op: 'legal_hold', active: false, hold_id: ativa.id },
      });
      return this.estado(tx, ctx, pacienteId);
    });
  }

  private async travarPaciente(tx: TenantTx, ctx: RequestContext, pacienteId: string): Promise<void> {
    const [p] = await tx
      .select({ id: patients.id })
      .from(patients)
      .where(and(eq(patients.tenantId, ctx.tenantId), eq(patients.id, pacienteId)))
      .for('update');
    if (!p) throw new NaoEncontradoError();
  }

  private async ativa(tx: TenantTx, ctx: RequestContext, pacienteId: string) {
    const [h] = await tx
      .select()
      .from(legalHolds)
      .where(and(eq(legalHolds.tenantId, ctx.tenantId), eq(legalHolds.patientId, pacienteId), isNull(legalHolds.releasedAt)));
    return h;
  }

  private async estado(tx: TenantTx, ctx: RequestContext, pacienteId: string): Promise<EstadoDaRetencao> {
    const [p] = await tx
      .select({ desde: patients.legalHoldSince })
      .from(patients)
      .where(and(eq(patients.tenantId, ctx.tenantId), eq(patients.id, pacienteId)));
    const ativa = await this.ativa(tx, ctx, pacienteId);
    return { retencaoLegalDesde: p?.desde?.toISOString() ?? null, retiradaPendente: !!ativa?.releaseRequestedBy };
  }
}
