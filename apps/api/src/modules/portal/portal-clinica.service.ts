import { Inject, Injectable } from '@nestjs/common';
import { AuditAction, type RequestContext } from '@plataforma/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { ConflitoError, NaoEncontradoError } from '../../common/erros-dominio';
import { EntradaInvalidaError } from '../../common/validacao';
import { escreverNaClinica, lerNaClinica } from '../../common/transacao-clinica';
import {
  patientGuardians,
  patients,
  portalConsents,
  portalInvites,
  portalLinks,
  portalRightsRequests,
  type AiConsentState,
  type PortalActingAs,
  type PortalConsentPurpose,
  type PortalLinkRevokeReason,
  type RightsRequestKind,
  type RightsRequestStatus,
} from '../../db/schema';
import type { TenantTx } from '../../db/tenant-transaction';
import { recordAudit } from '../audit/audit-log';
import { FIELD_CIPHER } from '../crypto/crypto.module';
import type { FieldCipher } from '../crypto/field-cipher';
import { IDADE_MAIORIDADE } from '../finance/financeiro-regras';
import { hojeNaClinica } from '../insurance/guias-regras';
import { patientFieldRef } from '../patients/patient-fields';
import { aniversarioDe, idadeEm, menorEm, vigenteEm } from '../patients/responsaveis-regras';
import { TenantDatabase } from '../tenancy/tenancy.module';
import { cifrarCampoPortal, decifrarCampoPortal } from './portal-fields';
import {
  CONSENTIMENTOS,
  consentimentoIa,
  estadoDoConsentimento,
  eventoVale,
  exigeResposta,
  fimDaRepresentacao,
  IDADE_MINIMA_TITULAR,
  MODELO_RESPOSTA_ELIMINACAO,
  novoTokenDeConvite,
  type RespostaConsentimento,
} from './portal-regras';

export interface PedidoDoTitularDto {
  readonly id: string;
  readonly protocolo: string;
  readonly pacienteId: string;
  readonly tipo: RightsRequestKind;
  readonly agindoComo: PortalActingAs;
  readonly situacao: RightsRequestStatus;
  readonly abertoEm: string;
  readonly prazo: string;
  readonly atrasado: boolean;
  readonly atendidoEm: string | null;
}

export interface PedidoDoTitularDetalheDto extends PedidoDoTitularDto {
  readonly detalhe: string | null;
  readonly resposta: string | null;
  /** Texto-modelo para a clínica adaptar (só em `eliminacao`: retenção legal do prontuário; A3d do #68). */
  readonly modeloDeResposta: string | null;
}

/**
 * Lado da CLÍNICA do portal: convites (token de uso único mostrado uma vez), vínculos (listar/revogar),
 * pedidos do titular (ler e registrar o atendimento; quem responde é a clínica, controladora) e o estado
 * dos consentimentos do paciente. Tudo na clínica da sessão, com auditoria na mesma transação.
 */
@Injectable()
export class PortalClinicaService {
  constructor(
    @Inject(TenantDatabase) private readonly db: TenantDatabase,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher<TenantTx>,
  ) {}

  /**
   * Convite (V1 do #68): `titular` só de 18 anos, com data de nascimento no cadastro (R3); `responsavel_legal` só com
   * `responsavelId` = vínculo VIGENTE da 0028 do mesmo paciente e, fora a curatela, paciente menor não
   * emancipado, com o fim da representação calculado aqui (o banco confere o mesmo, sem ver a data de
   * nascimento, que é cifrada).
   */
  emitirConvite(
    ctx: RequestContext,
    dados: { pacienteId: string; agindoComo: PortalActingAs; validadeHoras: number; responsavelId?: string },
  ): Promise<{ id: string; token: string; expiraEm: string }> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      const [p] = await tx
        .select({ ativo: patients.active, nascEnc: patients.birthDateEnc, emancipadoEm: patients.emancipatedOn })
        .from(patients)
        .where(and(eq(patients.tenantId, ctx.tenantId), eq(patients.id, dados.pacienteId)));
      if (!p) throw new NaoEncontradoError();
      if (!p.ativo) throw new ConflitoError('paciente_inativo');
      const nasc = p.nascEnc ? await this.cipher.decryptString(tx, patientFieldRef(ctx.tenantId, dados.pacienteId, 'birth_date'), p.nascEnc) : null;
      const hoje = hojeNaClinica();
      const menor = menorEm(nasc, hoje, p.emancipadoEm);
      let representacao: { guardianLinkId: string; guardianId: string; representUntil: string | null } | null = null;
      if (dados.agindoComo === 'titular') {
        if (dados.responsavelId !== undefined) throw new EntradaInvalidaError(['responsavelId']);
        // R3 do #68 (re-revisão): sem data de nascimento não se sabe se o titular é menor; falha fechada.
        if (menor === null) throw new ConflitoError('nascimento_nao_informado');
        if (menor === true) {
          throw new ConflitoError((idadeEm(nasc, hoje) ?? 0) < IDADE_MINIMA_TITULAR ? 'titular_menor_de_12' : 'titular_adolescente_requer_decisao');
        }
      } else {
        if (dados.responsavelId === undefined) throw new EntradaInvalidaError(['responsavelId']);
        const [g] = await tx
          .select()
          .from(patientGuardians)
          .where(and(eq(patientGuardians.tenantId, ctx.tenantId), eq(patientGuardians.id, dados.responsavelId), eq(patientGuardians.patientId, dados.pacienteId)));
        if (!g) throw new NaoEncontradoError();
        if (g.endedAt !== null || !vigenteEm({ desde: g.validFrom, ate: g.validUntil }, hoje)) throw new ConflitoError('responsavel_nao_vigente');
        if (g.kind === 'curador') {
          representacao = { guardianLinkId: g.id, guardianId: g.guardianId, representUntil: null };
        } else {
          if (menor === null) throw new ConflitoError('nascimento_nao_informado');
          if (!menor) throw new ConflitoError('responsavel_so_para_menor');
          const ate = fimDaRepresentacao(aniversarioDe(nasc as string, IDADE_MAIORIDADE), g.validUntil);
          representacao = { guardianLinkId: g.id, guardianId: g.guardianId, representUntil: ate };
        }
      }
      const { token, hash } = novoTokenDeConvite();
      const [c] = await tx
        .insert(portalInvites)
        .values({
          tenantId: ctx.tenantId,
          patientId: dados.pacienteId,
          tokenHash: hash,
          actingAs: dados.agindoComo,
          expiresAt: sql`now() + make_interval(hours => ${dados.validadeHoras}::int)`,
          createdBy: ctx.userId,
          ...(representacao ?? {}),
        })
        .returning({ id: portalInvites.id, expiresAt: portalInvites.expiresAt });
      if (!c) throw new Error('convite não gravado');
      await recordAudit(tx, ctx, {
        action: AuditAction.Create,
        scope: 'portal_invites',
        metadata: {
          invite_id: c.id,
          patient_id: dados.pacienteId,
          acting_as: dados.agindoComo,
          ttl_h: dados.validadeHoras,
          guardian_id: representacao?.guardianId ?? null,
          guardian_link_id: representacao?.guardianLinkId ?? null,
        },
      });
      return { id: c.id, token, expiraEm: c.expiresAt.toISOString() };
    });
  }

  revogarConvite(ctx: RequestContext, id: string): Promise<{ revogado: true }> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      const [c] = await tx
        .select()
        .from(portalInvites)
        .where(and(eq(portalInvites.tenantId, ctx.tenantId), eq(portalInvites.id, id)))
        .for('update');
      if (!c) throw new NaoEncontradoError();
      if (c.redeemedAt || c.revokedAt) throw new ConflitoError('convite_encerrado');
      await tx
        .update(portalInvites)
        .set({ revokedAt: sql`now()`, revokedBy: ctx.userId })
        .where(and(eq(portalInvites.tenantId, ctx.tenantId), eq(portalInvites.id, id)));
      await recordAudit(tx, ctx, { action: AuditAction.Update, scope: 'portal_invites', metadata: { invite_id: id, op: 'revoke', patient_id: c.patientId } });
      return { revogado: true };
    });
  }

  vinculosDoPaciente(
    ctx: RequestContext,
    pacienteId: string,
  ): Promise<
    {
      id: string;
      contaId: string;
      agindoComo: PortalActingAs;
      responsavelId: string | null;
      representaAte: string | null;
      criadoEm: string;
      revogadoEm: string | null;
      motivo: string | null;
    }[]
  > {
    return lerNaClinica(this.db, ctx, async (tx) => {
      const linhas = await tx
        .select()
        .from(portalLinks)
        .where(and(eq(portalLinks.tenantId, ctx.tenantId), eq(portalLinks.patientId, pacienteId)))
        .orderBy(asc(portalLinks.createdAt));
      await recordAudit(tx, ctx, { action: AuditAction.Read, scope: 'portal_links', metadata: { patient_id: pacienteId, count: linhas.length } });
      return linhas.map((l) => ({
        id: l.id,
        contaId: l.accountId,
        agindoComo: l.actingAs,
        responsavelId: l.guardianLinkId,
        representaAte: l.representUntil,
        criadoEm: l.createdAt.toISOString(),
        revogadoEm: l.revokedAt?.toISOString() ?? null,
        motivo: l.revokeReason,
      }));
    });
  }

  /**
   * JOB do sistema (V1 do #68): em cada clínica com vínculo de portal ativo, registra a revogação dos vínculos
   * de responsável cuja representação acabou (18 anos, emancipação, fim do vínculo da 0028). O acesso já cai
   * no dia pela sessão; isto deixa o fato na lista da clínica e na trilha. Uma transação por clínica.
   */
  async encerrarRepresentacoesVencidas(): Promise<number> {
    const clinicas = await this.db.semContextoDoPortal(async (tx) =>
      (await tx.execute<{ t: string }>(sql`select t from app_portal_tenants_with_links() as t`)).map((r) => r.t),
    );
    let total = 0;
    for (const t of clinicas) {
      total += await this.db.semContextoDoPortal(async (tx) => {
        const [r] = await tx.execute<{ n: number }>(sql`select app_portal_close_ended_representations(${t}::uuid) as n`);
        return r?.n ?? 0;
      });
    }
    return total;
  }

  revogarVinculo(ctx: RequestContext, id: string, motivo: PortalLinkRevokeReason): Promise<{ revogado: true }> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      const [l] = await tx
        .select()
        .from(portalLinks)
        .where(and(eq(portalLinks.tenantId, ctx.tenantId), eq(portalLinks.id, id)))
        .for('update');
      if (!l) throw new NaoEncontradoError();
      if (l.revokedAt) throw new ConflitoError('vinculo_ja_revogado');
      await tx
        .update(portalLinks)
        .set({ revokedAt: sql`now()`, revokedBy: ctx.userId, revokeReason: motivo })
        .where(and(eq(portalLinks.tenantId, ctx.tenantId), eq(portalLinks.id, id)));
      await recordAudit(tx, ctx, {
        action: AuditAction.Update,
        scope: 'portal_links',
        metadata: { link_id: id, op: 'revoke', reason: motivo, patient_id: l.patientId },
      });
      return { revogado: true };
    });
  }

  pedidos(ctx: RequestContext, filtro: { situacao: 'abertos' | 'todos' }): Promise<PedidoDoTitularDto[]> {
    return lerNaClinica(this.db, ctx, async (tx) => {
      const condicoes = [eq(portalRightsRequests.tenantId, ctx.tenantId)];
      if (filtro.situacao === 'abertos') condicoes.push(inArray(portalRightsRequests.status, ['aberta', 'em_andamento']));
      const linhas = await tx
        .select()
        .from(portalRightsRequests)
        .where(and(...condicoes))
        .orderBy(asc(portalRightsRequests.dueAt))
        .limit(500);
      await recordAudit(tx, ctx, { action: AuditAction.Read, scope: 'portal_rights_requests', metadata: { op: 'list', count: linhas.length } });
      return linhas.map((r) => this.dto(r));
    });
  }

  pedido(ctx: RequestContext, id: string): Promise<PedidoDoTitularDetalheDto> {
    return lerNaClinica(this.db, ctx, async (tx) => {
      const r = await this.carregar(tx, ctx, id, false);
      await recordAudit(tx, ctx, { action: AuditAction.Read, scope: 'portal_rights_requests', metadata: { request_id: id, patient_id: r.patientId } });
      return {
        ...this.dto(r),
        detalhe: await decifrarCampoPortal(this.cipher, tx, ctx.tenantId, id, 'detail', r.detailEnc),
        resposta: await decifrarCampoPortal(this.cipher, tx, ctx.tenantId, id, 'answer', r.answerEnc),
        modeloDeResposta: r.kind === 'eliminacao' ? MODELO_RESPOSTA_ELIMINACAO : null,
      };
    });
  }

  /** Registra o andamento/atendimento. A execução (correção, cópia, eliminação) é ato da clínica. */
  atualizarPedido(
    ctx: RequestContext,
    id: string,
    dados: { situacao: Exclude<RightsRequestStatus, 'aberta'>; resposta?: string },
  ): Promise<PedidoDoTitularDto> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      const r = await this.carregar(tx, ctx, id, true);
      if (r.status === 'atendida' || r.status === 'recusada') throw new ConflitoError('pedido_encerrado');
      if (r.status === dados.situacao) throw new ConflitoError('transicao_invalida');
      // A3a do #68: recusa e atendimento comunicam as razões ou o resultado ao titular (o banco confere).
      if (exigeResposta(dados.situacao) && !dados.resposta?.trim() && r.answerEnc === null) throw new EntradaInvalidaError(['resposta']);
      const answerEnc = dados.resposta ? await cifrarCampoPortal(this.cipher, tx, ctx.tenantId, ctx.userId, id, 'answer', dados.resposta) : r.answerEnc;
      const [novo] = await tx
        .update(portalRightsRequests)
        .set({ status: dados.situacao, handledBy: ctx.userId, handledAt: sql`now()`, answerEnc })
        .where(and(eq(portalRightsRequests.tenantId, ctx.tenantId), eq(portalRightsRequests.id, id)))
        .returning();
      if (!novo) throw new NaoEncontradoError();
      await recordAudit(tx, ctx, {
        action: AuditAction.Update,
        scope: 'portal_rights_requests',
        metadata: { request_id: id, from: r.status, to: dados.situacao, has_answer: dados.resposta !== undefined, patient_id: r.patientId },
      });
      return this.dto(novo);
    });
  }

  /** Estado atual de cada consentimento do paciente (para a recepção e o escriba). */
  consentimentosDoPaciente(
    ctx: RequestContext,
    pacienteId: string,
  ): Promise<{ finalidade: PortalConsentPurpose; resposta: RespostaConsentimento; estadoIa?: AiConsentState; atualizadoEm: string | null }[]> {
    return lerNaClinica(this.db, ctx, async (tx) => {
      const eventos = await tx
        .select()
        .from(portalConsents)
        .where(and(eq(portalConsents.tenantId, ctx.tenantId), eq(portalConsents.patientId, pacienteId)))
        .orderBy(asc(portalConsents.createdAt), asc(portalConsents.id));
      await recordAudit(tx, ctx, { action: AuditAction.Read, scope: 'portal_consents', metadata: { patient_id: pacienteId, count: eventos.length } });
      const hoje = hojeNaClinica();
      return (Object.keys(CONSENTIMENTOS) as PortalConsentPurpose[]).map((f) => {
        // V1 do #68: o evento do responsável só vale enquanto a representação valia.
        const ultimo = eventos.filter((e) => e.purpose === f && eventoVale(e, hoje)).at(-1);
        const resposta = estadoDoConsentimento(ultimo?.response);
        return { finalidade: f, resposta, ...(f === 'escriba_ia' ? { estadoIa: consentimentoIa(resposta) } : {}), atualizadoEm: ultimo?.createdAt.toISOString() ?? null };
      });
    });
  }

  private async carregar(tx: TenantTx, ctx: RequestContext, id: string, travar: boolean) {
    const q = tx
      .select()
      .from(portalRightsRequests)
      .where(and(eq(portalRightsRequests.tenantId, ctx.tenantId), eq(portalRightsRequests.id, id)));
    const [r] = travar ? await q.for('update') : await q;
    if (!r) throw new NaoEncontradoError();
    return r;
  }

  private dto(r: typeof portalRightsRequests.$inferSelect): PedidoDoTitularDto {
    return {
      id: r.id,
      protocolo: r.protocol,
      pacienteId: r.patientId,
      tipo: r.kind,
      agindoComo: r.actingAs,
      situacao: r.status,
      abertoEm: r.createdAt.toISOString(),
      prazo: r.dueAt.toISOString(),
      atrasado: (r.status === 'aberta' || r.status === 'em_andamento') && r.dueAt.getTime() < Date.now(),
      atendidoEm: r.handledAt?.toISOString() ?? null,
    };
  }
}

