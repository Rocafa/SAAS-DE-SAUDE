/**
 * Custódia das notas lacradas de psicologia (R2 do parecer do Guardião sobre o PR #63; Código de Ética
 * do Psicólogo, art. 15; migração 0017).
 *
 * Quando um psicólogo é desligado e não decide as próprias notas em 30 dias, elas ficam LACRADAS por
 * 90 dias (D2). Nesse prazo:
 * 1. o admin DESIGNA um psicólogo substituto ativo da clínica (outra pessoa que não o admin nem o autor);
 * 2. o substituto ACEITA explicitamente (só ele; o banco confere com o usuário da sessão);
 * 3. aceito, SÓ o substituto lê as lacradas desse autor (leitura auditada; nem o admin, nem o autor) e
 *    decide nota a nota: `guarda_clinica` (o que for prontuário passa a acompanhá-lo, com a guarda de
 *    20 anos do último registro e eliminação só com a clínica no G3) ou `descartar` (lápide da D1).
 * Sem substituto (ou sem decisão) no prazo, o lacre segue a regra: eliminação pelo ciclo. Retenção legal
 * do paciente suspende a eliminação (R10). O substituto lê, não edita; acrescentar ao prontuário é por
 * adendo, na rota própria do atendimento.
 */
import { Inject, Injectable } from '@nestjs/common';
import { AuditAction, type RequestContext } from '@plataforma/shared';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { ConflitoError, NaoEncontradoError, ProibidoError } from '../../common/erros-dominio';
import { escreverNaClinica, lerNaClinica } from '../../common/transacao-clinica';
import { noteCustodies, privateNotes, professionals } from '../../db/schema';
import type { TenantTx } from '../../db/tenant-transaction';
import { recordAudit } from '../audit/audit-log';
import { FIELD_CIPHER } from '../crypto/crypto.module';
import type { FieldCipher } from '../crypto/field-cipher';
import { TenantDatabase } from '../tenancy/tenancy.module';
import { modeloPelaEspecialidade } from './modelos';
import { descartarComLapide } from './notas-privadas.service';
import { CAMPO_NOTA, decifrarCampoClinico } from './record-fields';
import { exigirSemRetencao } from './retencao-legal';

const SCOPE = 'private_notes';

export interface CustodiaDto {
  readonly id: string;
  readonly aceita: boolean;
  readonly designadaEm: string;
  readonly aceitaEm: string | null;
  /** Só a contagem de lacradas vivas do autor (o admin não vê mais nada). */
  readonly notasLacradas: number;
}

export interface NotaLacradaDto {
  readonly id: string;
  readonly pacienteId: string;
  readonly texto: string;
  readonly criadaEm: string;
  readonly prazo: string | null;
}

export type DecisaoDaCustodia = 'guarda_clinica' | 'descartar';

@Injectable()
export class CustodiaService {
  constructor(
    @Inject(TenantDatabase) private readonly db: TenantDatabase,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher<TenantTx>,
  ) {}

  /** Admin: designa o substituto para as lacradas do autor (profissionais por id). */
  designar(ctx: RequestContext, autorProfissionalId: string, substitutoProfissionalId: string): Promise<CustodiaDto> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      const autor = await this.profissional(tx, ctx, autorProfissionalId);
      const subst = await this.profissional(tx, ctx, substitutoProfissionalId);
      if (!autor.userId || !subst.userId) throw new ConflitoError('profissional_sem_usuario');
      if (modeloPelaEspecialidade(autor.specialty) !== 'psicologia') throw new ConflitoError('autor_nao_psicologo');
      if (modeloPelaEspecialidade(subst.specialty) !== 'psicologia' || !subst.active) throw new ConflitoError('substituto_nao_psicologo_ativo');
      // Duas pessoas: quem designa não é o substituto; o substituto não é o autor (CHECK no banco também).
      if (subst.userId === ctx.userId) throw new ConflitoError('mesma_pessoa');
      if (subst.userId === autor.userId) throw new ConflitoError('substituto_igual_autor');
      const [existente] = await tx
        .select({ id: noteCustodies.id })
        .from(noteCustodies)
        .where(and(eq(noteCustodies.tenantId, ctx.tenantId), eq(noteCustodies.authorUserId, autor.userId)));
      if (existente) throw new ConflitoError('custodia_ja_designada');
      const [c] = await tx
        .insert(noteCustodies)
        .values({ tenantId: ctx.tenantId, authorUserId: autor.userId, substituteUserId: subst.userId, designatedBy: ctx.userId })
        .returning();
      if (!c) throw new Error('falha ao designar custódia');
      await recordAudit(tx, ctx, {
        action: AuditAction.PermissionChange,
        scope: SCOPE,
        metadata: { op: 'custody_designate', custody_id: c.id, author_professional_id: autor.id, substitute_professional_id: subst.id },
      });
      return this.dto(tx, ctx, c);
    });
  }

  /** Substituto: aceite explícito (só ele, uma vez). */
  aceitar(ctx: RequestContext, custodiaId: string): Promise<CustodiaDto> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      const c = await this.doSubstituto(tx, ctx, custodiaId, false);
      if (c.acceptedAt) return this.dto(tx, ctx, c);
      await this.exigirSubstitutoAtivo(tx, ctx);
      const [aceita] = await tx
        .update(noteCustodies)
        .set({ acceptedAt: new Date() })
        .where(and(eq(noteCustodies.tenantId, ctx.tenantId), eq(noteCustodies.id, c.id)))
        .returning();
      await recordAudit(tx, ctx, { action: AuditAction.PermissionChange, scope: SCOPE, metadata: { op: 'custody_accept', custody_id: c.id } });
      return this.dto(tx, ctx, aceita ?? c);
    });
  }

  /** Substituto com custódia aceita: lê as lacradas vivas do autor. Leitura auditada (só contagem). */
  notas(ctx: RequestContext, custodiaId: string): Promise<NotaLacradaDto[]> {
    return lerNaClinica(this.db, ctx, async (tx) => {
      const c = await this.doSubstituto(tx, ctx, custodiaId, true);
      await this.exigirSubstitutoAtivo(tx, ctx);
      const linhas = await tx
        .select()
        .from(privateNotes)
        .where(
          and(
            eq(privateNotes.tenantId, ctx.tenantId),
            eq(privateNotes.authorUserId, c.authorUserId),
            eq(privateNotes.custodyState, 'lacrada'),
            isNull(privateNotes.discardedAt),
          ),
        )
        .orderBy(asc(privateNotes.createdAt), asc(privateNotes.id))
        .limit(500);
      const out: NotaLacradaDto[] = [];
      for (const n of linhas) {
        out.push({
          id: n.id,
          pacienteId: n.patientId,
          texto: await decifrarCampoClinico(this.cipher, tx, ctx.tenantId, n.id, CAMPO_NOTA, n.contentEnc),
          criadaEm: n.createdAt.toISOString(),
          prazo: n.custodyDeadline?.toISOString() ?? null,
        });
      }
      await recordAudit(tx, ctx, { action: AuditAction.Read, scope: SCOPE, metadata: { op: 'custody_read', custody_id: c.id, count: out.length } });
      return out;
    });
  }

  /** Substituto com custódia aceita: decide uma lacrada (guarda da clínica ou descarte). */
  decidir(ctx: RequestContext, custodiaId: string, notaId: string, decisao: DecisaoDaCustodia): Promise<{ id: string; decisao: DecisaoDaCustodia }> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      const c = await this.doSubstituto(tx, ctx, custodiaId, true);
      await this.exigirSubstitutoAtivo(tx, ctx);
      const [n] = await tx
        .select()
        .from(privateNotes)
        .where(
          and(
            eq(privateNotes.tenantId, ctx.tenantId),
            eq(privateNotes.id, notaId),
            eq(privateNotes.authorUserId, c.authorUserId),
            eq(privateNotes.custodyState, 'lacrada'),
            isNull(privateNotes.discardedAt),
          ),
        )
        .for('update');
      if (!n) throw new NaoEncontradoError();
      const agora = new Date();
      if (decisao === 'descartar') {
        await exigirSemRetencao(tx, ctx, n.patientId);
        await descartarComLapide(this.cipher, tx, ctx, n.id, agora);
      } else {
        await tx
          .update(privateNotes)
          .set({ custodyState: 'guarda_clinica', custodyDeadline: null, updatedAt: agora })
          .where(and(eq(privateNotes.tenantId, ctx.tenantId), eq(privateNotes.id, n.id)));
      }
      await recordAudit(tx, ctx, {
        action: AuditAction.Update,
        scope: SCOPE,
        metadata: { op: 'custody_decide', custody_id: c.id, note_id: n.id, patient_id: n.patientId, decision: decisao },
      });
      return { id: n.id, decisao };
    });
  }

  // ---------------------------------------------------------------- apoio

  private async profissional(tx: TenantTx, ctx: RequestContext, id: string) {
    const [p] = await tx
      .select()
      .from(professionals)
      .where(and(eq(professionals.tenantId, ctx.tenantId), eq(professionals.id, id)));
    if (!p) throw new NaoEncontradoError();
    return p;
  }

  /** Custódia da qual o usuário da sessão é o substituto. De outro: 404 (não revela que existe). */
  private async doSubstituto(tx: TenantTx, ctx: RequestContext, id: string, exigirAceite: boolean) {
    if (!ctx.roles.includes('profissional')) throw new ProibidoError();
    const [c] = await tx
      .select()
      .from(noteCustodies)
      .where(and(eq(noteCustodies.tenantId, ctx.tenantId), eq(noteCustodies.id, id), eq(noteCustodies.substituteUserId, ctx.userId)));
    if (!c) throw new NaoEncontradoError();
    if (exigirAceite && !c.acceptedAt) throw new ConflitoError('custodia_nao_aceita');
    return c;
  }

  /** O substituto continua psicólogo ativo da clínica. */
  private async exigirSubstitutoAtivo(tx: TenantTx, ctx: RequestContext): Promise<void> {
    const ps = await tx
      .select({ specialty: professionals.specialty })
      .from(professionals)
      .where(and(eq(professionals.tenantId, ctx.tenantId), eq(professionals.userId, ctx.userId), eq(professionals.active, true)));
    if (!ps.some((p) => modeloPelaEspecialidade(p.specialty) === 'psicologia')) throw new ProibidoError();
  }

  private async dto(tx: TenantTx, ctx: RequestContext, c: typeof noteCustodies.$inferSelect): Promise<CustodiaDto> {
    const lacradas = await tx
      .select({ id: privateNotes.id })
      .from(privateNotes)
      .where(
        and(
          eq(privateNotes.tenantId, ctx.tenantId),
          eq(privateNotes.authorUserId, c.authorUserId),
          eq(privateNotes.custodyState, 'lacrada'),
          isNull(privateNotes.discardedAt),
        ),
      );
    return {
      id: c.id,
      aceita: c.acceptedAt !== null,
      designadaEm: c.designatedAt.toISOString(),
      aceitaEm: c.acceptedAt?.toISOString() ?? null,
      notasLacradas: lacradas.length,
    };
  }
}
