/**
 * Ciclo de vida das notas privadas (decisões D1 e D2 do parecer do Guardião sobre o PR #63).
 * Ver docs/04-arquitetura/api-dominio.md §8 "Notas privadas: descarte, expurgo e desligamento".
 *
 * - D1: a nota descartada já virou lápide no ato (notas-privadas.service.ts); a LINHA é expurgada
 *   depois de 30 dias por `app_purge_discarded_private_notes()` (migração 0015), salvo retenção legal
 *   do paciente (`patients.legal_hold_since`). Idempotente: rodar de novo apaga 0.
 * - D2: profissional que sai → as notas vivas dele ficam `aguardando_decisao` por 30 dias (o admin vê
 *   SÓ a contagem; o autor decide nota a nota: incorporar por adendo, marcar para exportar ou
 *   descartar). Sem decisão no prazo: marcada para exportar → `guarda_clinica` (acompanha o prontuário,
 *   ilegível no aplicativo, só no G2); psicologia → `lacrada` por 90 dias para o psicólogo substituto
 *   (custódia, R2 do #63, antes do piloto com psicologia); demais (fisio/TO) → eliminação (lápide e
 *   expurgo da D1). Lacrada sem decisão da custódia em 90 dias → eliminação.
 *
 * - R10 (0017): paciente sob retenção legal → nenhuma nota dele é eliminada nem muda de estado; os
 *   prazos vencidos ficam suspensos até a retenção ser retirada (retencao-legal.ts).
 *
 * As funções rodam na transação da clínica do contexto (RLS) e auditam só contagens. O agendador
 * (job diário) chama `executarCicloDasNotas` para cada clínica; a rota do admin faz o mesmo sob demanda.
 */
import { Inject, Injectable } from '@nestjs/common';
import { AuditAction, type RequestContext, type TenantId } from '@plataforma/shared';
import { and, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { NaoEncontradoError } from '../../common/erros-dominio';
import { escreverNaClinica } from '../../common/transacao-clinica';
import { patients, privateNotes, professionals } from '../../db/schema';
import type { TenantTx } from '../../db/tenant-transaction';
import { recordAudit, SYSTEM_ACTOR_ID } from '../audit/audit-log';
import { FIELD_CIPHER } from '../crypto/crypto.module';
import type { FieldCipher } from '../crypto/field-cipher';
import { TenantDatabase } from '../tenancy/tenancy.module';
import { modeloPelaEspecialidade } from './modelos';
import { descartarComLapide } from './notas-privadas.service';

const SCOPE_NOTAS = 'private_notes';
const DIA_MS = 86_400_000;
/** D2: prazo do autor desligado para decidir as próprias notas. */
export const DIAS_PARA_DECIDIR = 30;
/** D2: prazo da custódia (psicólogo substituto) para decidir uma nota lacrada. */
export const DIAS_DE_LACRE = 90;

export interface ResultadoDoCiclo {
  readonly guardaClinica: number;
  readonly lacradas: number;
  readonly eliminadas: number;
  /** R10: vencidas mas suspensas porque o paciente está sob retenção legal. */
  readonly suspensasPorRetencao: number;
  readonly expurgadas: number;
}

/** D2: inicia o desligamento do autor. Devolve SÓ a contagem de notas vivas (o admin não vê mais nada). */
export async function iniciarDesligamentoDoAutor(
  tx: TenantTx,
  ctx: RequestContext,
  autorUserId: string,
  agora: Date,
): Promise<{ notas: number; prazo: string }> {
  const prazo = new Date(agora.getTime() + DIAS_PARA_DECIDIR * DIA_MS);
  const linhas = await tx
    .update(privateNotes)
    .set({ custodyState: 'aguardando_decisao', custodyDeadline: prazo, updatedAt: agora })
    .where(
      and(
        eq(privateNotes.tenantId, ctx.tenantId),
        eq(privateNotes.authorUserId, autorUserId),
        eq(privateNotes.custodyState, 'ativa'),
        isNull(privateNotes.discardedAt),
      ),
    )
    .returning({ id: privateNotes.id });
  await recordAudit(tx, ctx, {
    action: AuditAction.Update,
    scope: SCOPE_NOTAS,
    metadata: { op: 'author_offboarding', count: linhas.length, deadline_days: DIAS_PARA_DECIDIR },
  });
  return { notas: linhas.length, prazo: prazo.toISOString() };
}

/** D2: aplica os prazos vencidos. A especialidade do AUTOR (profissional da clínica) decide psicologia. */
export async function aplicarPrazosDeCustodia(
  cipher: FieldCipher<TenantTx>,
  tx: TenantTx,
  ctx: RequestContext,
  agora: Date,
): Promise<Omit<ResultadoDoCiclo, 'expurgadas'>> {
  const vencidas = await tx
    .select({
      id: privateNotes.id,
      estado: privateNotes.custodyState,
      exportar: privateNotes.exportConsent,
      especialidade: professionals.specialty,
      retida: sql<number>`(${patients.legalHoldSince} IS NOT NULL)::int`,
    })
    .from(privateNotes)
    .innerJoin(patients, and(eq(patients.tenantId, privateNotes.tenantId), eq(patients.id, privateNotes.patientId)))
    .leftJoin(
      professionals,
      and(eq(professionals.tenantId, privateNotes.tenantId), eq(professionals.userId, privateNotes.authorUserId)),
    )
    .where(
      and(
        eq(privateNotes.tenantId, ctx.tenantId),
        inArray(privateNotes.custodyState, ['aguardando_decisao', 'lacrada']),
        lte(privateNotes.custodyDeadline, agora),
        isNull(privateNotes.discardedAt),
      ),
    )
    .for('update', { of: privateNotes });
  let guardaClinica = 0;
  let lacradas = 0;
  let eliminadas = 0;
  let retidas = 0;
  for (const n of vencidas) {
    // R10: paciente sob retenção legal: nada é eliminado nem muda de estado; o prazo fica suspenso.
    if (Number(n.retida) === 1) {
      retidas++;
      continue;
    }
    const onde = and(eq(privateNotes.tenantId, ctx.tenantId), eq(privateNotes.id, n.id));
    if (n.estado === 'aguardando_decisao' && n.exportar) {
      await tx.update(privateNotes).set({ custodyState: 'guarda_clinica', custodyDeadline: null, updatedAt: agora }).where(onde);
      guardaClinica++;
    } else if (n.estado === 'aguardando_decisao' && modeloPelaEspecialidade(n.especialidade ?? '') === 'psicologia') {
      // Código de Ética do Psicólogo, art. 15: lacrar para o psicólogo substituto.
      await tx
        .update(privateNotes)
        .set({ custodyState: 'lacrada', custodyDeadline: new Date(agora.getTime() + DIAS_DE_LACRE * DIA_MS), updatedAt: agora })
        .where(onde);
      lacradas++;
    } else {
      await descartarComLapide(cipher, tx, ctx, n.id, agora);
      eliminadas++;
    }
  }
  if (vencidas.length > 0) {
    await recordAudit(tx, ctx, {
      action: AuditAction.Update,
      scope: SCOPE_NOTAS,
      metadata: { op: 'custody_deadline', guarda_clinica: guardaClinica, sealed: lacradas, discarded: eliminadas, legal_hold: retidas },
    });
  }
  return { guardaClinica, lacradas, eliminadas, suspensasPorRetencao: retidas };
}

/** D1.2: expurgo idempotente das linhas descartadas há mais de 30 dias (salvo retenção legal). */
export async function expurgarNotasDescartadas(tx: TenantTx, ctx: RequestContext): Promise<number> {
  const [r] = await tx.execute<{ n: number }>(sql`select app_purge_discarded_private_notes() as n`);
  const n = Number(r?.n ?? 0);
  if (n > 0) {
    await recordAudit(tx, ctx, { action: AuditAction.Update, scope: SCOPE_NOTAS, metadata: { op: 'purge', count: n } });
  }
  return n;
}

@Injectable()
export class CicloNotasPrivadasService {
  constructor(
    @Inject(TenantDatabase) private readonly db: TenantDatabase,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher<TenantTx>,
  ) {}

  /** Job (e rota do admin): prazos da custódia e depois o expurgo, numa transação da clínica. */
  executarCicloDasNotas(ctx: RequestContext, agora: Date = new Date()): Promise<ResultadoDoCiclo> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      const prazos = await aplicarPrazosDeCustodia(this.cipher, tx, ctx, agora);
      const expurgadas = await expurgarNotasDescartadas(tx, ctx);
      return { ...prazos, expurgadas };
    });
  }

  /**
   * Job do sistema (agendador, api-dominio §14): o mesmo ciclo, sem usuário (slot travado com o sentinela da
   * 0019; ator `sistema` na trilha). Sem a política de assinatura: prazo e expurgo valem para clínica cancelada.
   */
  executarCicloComoSistema(tenantId: TenantId, agora: Date = new Date()): Promise<ResultadoDoCiclo> {
    const ctx: RequestContext = { tenantId, userId: SYSTEM_ACTOR_ID, roles: [] };
    return this.db.run(tenantId, async (tx) => {
      const prazos = await aplicarPrazosDeCustodia(this.cipher, tx, ctx, agora);
      const expurgadas = await expurgarNotasDescartadas(tx, ctx);
      return { ...prazos, expurgadas };
    });
  }

  /** Admin: desliga o profissional (por id) para as notas privadas; devolve só a contagem. */
  iniciarDesligamento(ctx: RequestContext, profissionalId: string, agora: Date = new Date()): Promise<{ notas: number; prazo: string }> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      const [p] = await tx
        .select({ userId: professionals.userId })
        .from(professionals)
        .where(and(eq(professionals.tenantId, ctx.tenantId), eq(professionals.id, profissionalId)));
      if (!p) throw new NaoEncontradoError();
      if (!p.userId) return { notas: 0, prazo: new Date(agora.getTime() + DIAS_PARA_DECIDIR * DIA_MS).toISOString() };
      return iniciarDesligamentoDoAutor(tx, ctx, p.userId, agora);
    });
  }
}
