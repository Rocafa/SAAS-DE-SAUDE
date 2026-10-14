import { Inject, Injectable } from '@nestjs/common';
import { AuditAction, type RequestContext } from '@plataforma/shared';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { NaoEncontradoError } from '../../common/erros-dominio';
import { escreverNaClinica, lerNaClinica } from '../../common/transacao-clinica';
import { encounters, patients, privateNotes } from '../../db/schema';
import type { TenantTx } from '../../db/tenant-transaction';
import { recordAudit } from '../audit/audit-log';
import { exigirConteudoClinico } from '../auth/vinculo-de-cuidado';
import { FIELD_CIPHER } from '../crypto/crypto.module';
import type { FieldCipher } from '../crypto/field-cipher';
import { TenantDatabase } from '../tenancy/tenancy.module';
import { comNegacaoAuditada, NotaDeOutroAutorError } from './acesso-clinico';
import type { AlteracaoNota, NovaNota } from './prontuario.validation';
import { CAMPO_NOTA, cifrarCampoClinico, decifrarCampoClinico } from './record-fields';

export interface NotaPrivadaDto {
  readonly id: string;
  readonly pacienteId: string;
  readonly atendimentoId: string | null;
  readonly texto: string;
  readonly incluirNaExportacao: boolean;
  readonly criadaEm: string;
  readonly atualizadaEm: string;
}

const SCOPE_NOTAS = 'private_notes';
type LinhaNota = typeof privateNotes.$inferSelect;

/**
 * Anotações privadas do profissional (HU-PRO-009, PRO-02.6). NÃO são prontuário: ficam em tabela
 * própria e SÓ o autor lê, altera ou descarta — nem o admin, nem outro profissional com vínculo,
 * nem o compartimento de psicologia em modo "prontuário único". Toda consulta filtra
 * `author_user_id = usuário da sessão`; nota de outro autor responde 404 (não revela que existe) e
 * a tentativa vai para a trilha. Nunca entram em relatório, IA ou exportação padrão: só no pacote
 * G2 se o autor marcar `incluirNaExportacao` (decisão expressa). Descartar não apaga a linha (sem
 * DELETE para o runtime): ela some da API e segue a retenção do RIPD (pendente do Guardião).
 * Toda operação passa pelo porteiro `exigirConteudoClinico` (perfil clínico + vínculo).
 */
@Injectable()
export class NotasPrivadasService {
  constructor(
    @Inject(TenantDatabase) private readonly db: TenantDatabase,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher<TenantTx>,
  ) {}

  listar(ctx: RequestContext, pacienteId: string): Promise<NotaPrivadaDto[]> {
    return comNegacaoAuditada(this.db, ctx, { op: 'nota_listar', patientId: pacienteId }, () =>
      lerNaClinica(this.db, ctx, async (tx) => {
        await this.pacienteExiste(tx, ctx, pacienteId);
        const vinculo = await exigirConteudoClinico(tx, ctx, pacienteId);
        const linhas = await tx
          .select()
          .from(privateNotes)
          .where(
            and(
              eq(privateNotes.tenantId, ctx.tenantId),
              eq(privateNotes.authorUserId, ctx.userId),
              eq(privateNotes.patientId, pacienteId),
              isNull(privateNotes.discardedAt),
            ),
          )
          .orderBy(desc(privateNotes.createdAt), desc(privateNotes.id))
          .limit(200);
        const out: NotaPrivadaDto[] = [];
        for (const n of linhas) out.push(await this.dto(tx, ctx, n));
        await recordAudit(tx, ctx, {
          action: AuditAction.Read,
          scope: SCOPE_NOTAS,
          metadata: { patient_id: pacienteId, count: out.length, care_basis: vinculo.base },
        });
        return out;
      }),
    );
  }

  criar(ctx: RequestContext, pacienteId: string, dados: NovaNota): Promise<NotaPrivadaDto> {
    return comNegacaoAuditada(this.db, ctx, { op: 'nota_criar', patientId: pacienteId }, () =>
      escreverNaClinica(this.db, ctx, async (tx) => {
        await this.pacienteExiste(tx, ctx, pacienteId);
        const vinculo = await exigirConteudoClinico(tx, ctx, pacienteId);
        if (dados.atendimentoId) {
          // Só um atendimento do mesmo paciente e do próprio autor.
          const [e] = await tx
            .select({ id: encounters.id })
            .from(encounters)
            .where(
              and(
                eq(encounters.tenantId, ctx.tenantId),
                eq(encounters.id, dados.atendimentoId),
                eq(encounters.patientId, pacienteId),
                eq(encounters.authorUserId, ctx.userId),
              ),
            );
          if (!e) throw new NaoEncontradoError();
        }
        const id = randomUUID();
        const contentEnc = await cifrarCampoClinico(this.cipher, tx, ctx, id, CAMPO_NOTA, dados.texto);
        const [n] = await tx
          .insert(privateNotes)
          .values({
            id,
            tenantId: ctx.tenantId,
            patientId: pacienteId,
            authorUserId: ctx.userId,
            encounterId: dados.atendimentoId ?? null,
            contentEnc,
            exportConsent: dados.incluirNaExportacao,
          })
          .returning();
        if (!n) throw new Error('falha ao criar nota privada');
        await recordAudit(tx, ctx, {
          action: AuditAction.Create,
          scope: SCOPE_NOTAS,
          metadata: { note_id: id, patient_id: pacienteId, export_consent: n.exportConsent, care_basis: vinculo.base },
        });
        return this.dto(tx, ctx, n);
      }),
    );
  }

  obter(ctx: RequestContext, id: string): Promise<NotaPrivadaDto> {
    return comNegacaoAuditada(this.db, ctx, { op: 'nota_ler', targetId: id }, () =>
      lerNaClinica(this.db, ctx, async (tx) => {
        const n = await this.doAutor(tx, ctx, id, false);
        const vinculo = await exigirConteudoClinico(tx, ctx, n.patientId);
        await recordAudit(tx, ctx, {
          action: AuditAction.Read,
          scope: SCOPE_NOTAS,
          metadata: { note_id: id, patient_id: n.patientId, care_basis: vinculo.base },
        });
        return this.dto(tx, ctx, n);
      }),
    );
  }

  atualizar(ctx: RequestContext, id: string, dados: AlteracaoNota): Promise<NotaPrivadaDto> {
    return comNegacaoAuditada(this.db, ctx, { op: 'nota_alterar', targetId: id }, () =>
      escreverNaClinica(this.db, ctx, async (tx) => {
        const n = await this.doAutor(tx, ctx, id, true);
        const vinculo = await exigirConteudoClinico(tx, ctx, n.patientId);
        const contentEnc = dados.texto !== undefined ? await cifrarCampoClinico(this.cipher, tx, ctx, id, CAMPO_NOTA, dados.texto) : undefined;
        const [atual] = await tx
          .update(privateNotes)
          .set({
            updatedAt: new Date(),
            ...(contentEnc ? { contentEnc } : {}),
            ...(dados.incluirNaExportacao !== undefined ? { exportConsent: dados.incluirNaExportacao } : {}),
          })
          .where(and(eq(privateNotes.tenantId, ctx.tenantId), eq(privateNotes.id, id)))
          .returning();
        await recordAudit(tx, ctx, {
          action: AuditAction.Update,
          scope: SCOPE_NOTAS,
          metadata: {
            note_id: id,
            patient_id: n.patientId,
            text_changed: contentEnc !== undefined,
            export_consent: atual?.exportConsent ?? n.exportConsent,
            care_basis: vinculo.base,
          },
        });
        return this.dto(tx, ctx, atual ?? n);
      }),
    );
  }

  descartar(ctx: RequestContext, id: string): Promise<{ id: string; descartadaEm: string }> {
    return comNegacaoAuditada(this.db, ctx, { op: 'nota_descartar', targetId: id }, () =>
      escreverNaClinica(this.db, ctx, async (tx) => {
        const n = await this.doAutor(tx, ctx, id, true);
        const vinculo = await exigirConteudoClinico(tx, ctx, n.patientId);
        const agora = new Date();
        await tx
          .update(privateNotes)
          .set({ discardedAt: agora, updatedAt: agora, exportConsent: false })
          .where(and(eq(privateNotes.tenantId, ctx.tenantId), eq(privateNotes.id, id)));
        await recordAudit(tx, ctx, {
          action: AuditAction.Update,
          scope: SCOPE_NOTAS,
          metadata: { note_id: id, patient_id: n.patientId, op: 'discard', care_basis: vinculo.base },
        });
        return { id, descartadaEm: agora.toISOString() };
      }),
    );
  }

  // ---------------------------------------------------------------- apoio

  private async pacienteExiste(tx: TenantTx, ctx: RequestContext, pacienteId: string): Promise<void> {
    const [p] = await tx
      .select({ id: patients.id })
      .from(patients)
      .where(and(eq(patients.tenantId, ctx.tenantId), eq(patients.id, pacienteId)));
    if (!p) throw new NaoEncontradoError();
  }

  /** Nota viva do PRÓPRIO autor. De outro autor: 404 para quem pede e tentativa na trilha. */
  private async doAutor(tx: TenantTx, ctx: RequestContext, id: string, travar: boolean): Promise<LinhaNota> {
    const q = tx
      .select()
      .from(privateNotes)
      .where(and(eq(privateNotes.tenantId, ctx.tenantId), eq(privateNotes.id, id), isNull(privateNotes.discardedAt)));
    const [n] = travar ? await q.for('update') : await q;
    if (!n) throw new NaoEncontradoError();
    if (n.authorUserId !== ctx.userId) throw new NotaDeOutroAutorError(id);
    return n;
  }

  private async dto(tx: TenantTx, ctx: RequestContext, n: LinhaNota): Promise<NotaPrivadaDto> {
    return {
      id: n.id,
      pacienteId: n.patientId,
      atendimentoId: n.encounterId,
      texto: await decifrarCampoClinico(this.cipher, tx, ctx.tenantId, n.id, CAMPO_NOTA, n.contentEnc),
      incluirNaExportacao: n.exportConsent,
      criadaEm: n.createdAt.toISOString(),
      atualizadaEm: n.updatedAt.toISOString(),
    };
  }
}
