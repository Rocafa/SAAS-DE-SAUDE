import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuditAction, type RequestContext, type TenantId } from '@plataforma/shared';
import { and, asc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
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
import { documentoNaoConferido, exigirPerfilQueConfere, nascimentoVigente, recalcularSigiloDoPortal } from '../patients/nascimento-do-cadastro';
import { patientFieldRef } from '../patients/patient-fields';
import { aniversarioDe, idadeEm, menorEm, REGRA_INFORMACAO_CLINICA, vigenteEm } from '../patients/responsaveis-regras';
import { TenantDatabase } from '../tenancy/tenancy.module';
import { cifrarCampoPortal, decifrarCampoPortal } from './portal-fields';
import {
  CONSENTIMENTOS,
  correcaoDeNascimentoExigeDocumento,
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
  /** Data de nascimento (AAAA-MM-DD) que o titular/responsável pede na correção; null sem data. */
  readonly nascimentoProposto: string | null;
  /** C1: a data proposta reduz a idade de paciente com 12+ (ou a atual é desconhecida): atender exige documento. */
  readonly exigeConferenciaDeDocumento: boolean;
  readonly documentoConferidoEm: string | null;
}

/**
 * Lado da CLÍNICA do portal: convites (token de uso único mostrado uma vez), vínculos (listar/revogar),
 * pedidos do titular (ler e registrar o atendimento; quem responde é a clínica, controladora) e o estado
 * dos consentimentos do paciente. Tudo na clínica da sessão, com auditoria na mesma transação.
 */
@Injectable()
export class PortalClinicaService {
  private readonly logger = new Logger('PortalClinicaService');

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
      let representacao: { guardianLinkId: string; guardianId: string; representUntil: string | null; confidentialFrom: string } | null = null;
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
          // Curatelado é adulto: o sigilo da área sensível vale desde já.
          representacao = { guardianLinkId: g.id, guardianId: g.guardianId, representUntil: null, confidentialFrom: hoje };
        } else {
          if (menor === null) throw new ConflitoError('nascimento_nao_informado');
          if (!menor) throw new ConflitoError('responsavel_so_para_menor');
          const ate = fimDaRepresentacao(aniversarioDe(nasc as string, IDADE_MAIORIDADE), g.validUntil);
          // Sigilo do adolescente (C3 do #67; R2): vale no banco a partir do dia dos 12 anos (em claro, como o dos 18).
          const sigilo = aniversarioDe(nasc as string, REGRA_INFORMACAO_CLINICA.idadeInicioAdolescencia);
          representacao = { guardianLinkId: g.id, guardianId: g.guardianId, representUntil: ate, confidentialFrom: sigilo };
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
    await this.expirarConsentimentosDeResponsavel();
    return total;
  }

  /**
   * JOB do sistema (R4 do #68): encerra (`representation_ended_at`) os consentimentos dados por responsável
   * cujo vínculo da 0028 acabou (curatela levantada, fim da vigência, anulação). O uso já confere a vigência
   * na hora; isto deixa o fato no evento e na trilha. Uma transação por clínica. Devolve quantos encerrou.
   */
  async expirarConsentimentosDeResponsavel(): Promise<number> {
    const clinicas = await this.db.semContextoDoPortal(async (tx) =>
      (await tx.execute<{ t: string }>(sql`select t from app_portal_tenants_with_any_link() as t`)).map((r) => r.t),
    );
    let total = 0;
    for (const t of clinicas) {
      total += await this.db.semContextoDoPortal(async (tx) => {
        const [r] = await tx.execute<{ n: number }>(sql`select app_portal_expire_guardian_consents(${t}::uuid) as n`);
        return r?.n ?? 0;
      });
    }
    return total;
  }

  /**
   * Agendador (api-dominio §14): os dois jobs acima para UMA clínica. As funções da 0033 abrem o próprio
   * contexto (`app_set_tenant` + sentinela de sistema) e exigem transação própria, por isso cada uma roda numa
   * transação sem contexto prévio, travada na clínica pela própria função. Idempotente.
   */
  async encerrarRepresentacoesDaClinica(tenantId: TenantId): Promise<{ vinculosRevogados: number; consentimentosEncerrados: number }> {
    const vinculosRevogados = await this.db.semContextoDoPortal(async (tx) => {
      const [r] = await tx.execute<{ n: number }>(sql`select app_portal_close_ended_representations(${tenantId}::uuid) as n`);
      return Number(r?.n ?? 0);
    });
    const consentimentosEncerrados = await this.db.semContextoDoPortal(async (tx) => {
      const [r] = await tx.execute<{ n: number }>(sql`select app_portal_expire_guardian_consents(${tenantId}::uuid) as n`);
      return Number(r?.n ?? 0);
    });
    return { vinculosRevogados, consentimentosEncerrados };
  }

  /**
   * JOB do sistema `portal-titular-menor` (R3 do #68; api-dominio §10g/§14), rede de segurança da correção do
   * nascimento: na clínica (transação própria, sentinela de sistema), acha os pacientes com acesso de TITULAR
   * ativo (vínculo ou convite pendente) e não emancipados, decifra a data de nascimento e, para quem consta
   * menor hoje, chama `app_portal_revoke_minor_titular` (0050: revoga, encerra convites, trilha `sistema`,
   * aviso e alerta ao DPO). Sem data de nascimento, ou com cifra ilegível, não decide (o convite titular já
   * exige a data, R3; a ilegível conta em `ilegiveis` e acende o `alarme`).
   * Idempotente. Devolve só contagens (a trilha `jobs` do executor as registra, inclusive quantos foram conferidos).
   */
  async revogarTitularesMenoresDaClinica(tenantId: TenantId): Promise<{ verificados: number; titularesRevogados: number; convitesEncerrados: number; pacientes: number; ilegiveis: number; alarme: boolean }> {
    return this.db.run(tenantId, async (tx) => {
      const candidatos = await tx.execute<{ id: string; nasc: string | null; emancipado: string | null }>(sql`
        select p.id, p.birth_date_enc as nasc, p.emancipated_on::text as emancipado
          from patients p
         where p.tenant_id = ${tenantId}::uuid
           and (exists (select 1 from portal_links l
                         where l.tenant_id = p.tenant_id and l.patient_id = p.id and l.acting_as = 'titular' and l.revoked_at is null)
             or exists (select 1 from portal_invites i
                         where i.tenant_id = p.tenant_id and i.patient_id = p.id and i.acting_as = 'titular'
                           and i.redeemed_at is null and i.revoked_at is null and i.expires_at > now()))
         order by p.id`);
      const hoje = hojeNaClinica();
      let titularesRevogados = 0;
      let convitesEncerrados = 0;
      let pacientes = 0;
      let ilegiveis = 0;
      for (const c of candidatos) {
        let nasc: string | null = null;
        if (c.nasc) {
          try {
            // Savepoint: uma cifra ilegível (chave) não derruba a passada da clínica inteira.
            nasc = await tx.transaction((sp) => this.cipher.decryptString(sp, patientFieldRef(tenantId, c.id, 'birth_date'), c.nasc as string));
          } catch {
            ilegiveis += 1;
            continue;
          }
        }
        if (menorEm(nasc, hoje, c.emancipado) !== true) continue;
        const [r] = await tx.execute<{ vinculos: number; convites: number }>(sql`select * from app_portal_revoke_minor_titular(${c.id}::uuid)`);
        const v = Number(r?.vinculos ?? 0);
        const i = Number(r?.convites ?? 0);
        titularesRevogados += v;
        convitesEncerrados += i;
        if (v + i > 0) pacientes += 1;
      }
      if (pacientes > 0) this.logger.warn(`ALERTA_ANOMALIA regra=portal_sigilo_transicao transicao=titular_menor_revogado pacientes=${pacientes}`);
      // Data que não se decifra não decide nada: fica visível como `alarme` (JOB_ALARME) e na contagem.
      return { verificados: candidatos.length, titularesRevogados, convitesEncerrados, pacientes, ilegiveis, alarme: ilegiveis > 0 };
    });
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
      const nasc = await this.nascimentoDoPedido(tx, ctx, r);
      await recordAudit(tx, ctx, {
        action: AuditAction.Read,
        scope: 'portal_rights_requests',
        metadata: { request_id: id, patient_id: r.patientId, has_birth_date: nasc !== null },
      });
      return {
        ...this.dto(r),
        detalhe: await decifrarCampoPortal(this.cipher, tx, ctx.tenantId, id, 'detail', r.detailEnc),
        resposta: await decifrarCampoPortal(this.cipher, tx, ctx.tenantId, id, 'answer', r.answerEnc),
        modeloDeResposta: r.kind === 'eliminacao' ? MODELO_RESPOSTA_ELIMINACAO : null,
        nascimentoProposto: nasc?.proposto ?? null,
        exigeConferenciaDeDocumento: nasc?.exigeDocumento ?? false,
        documentoConferidoEm: r.documentCheckedAt?.toISOString() ?? null,
      };
    });
  }

  /**
   * Registra o andamento/atendimento. A execução (correção, cópia, eliminação) é ato da clínica.
   * C1 (conferência de 24/10): a correção de nascimento que REDUZ a idade de paciente com 12 anos ou mais só
   * é ATENDIDA com `documentoConferido: true` (quem conferiu e quando ficam no pedido, 0051). C1-b′ (0052): a
   * exigência é a gravada na abertura do pedido; o banco recusa atender sem a conferência gravada.
   * Conferência 0052: sem a conferência, 422 `documento_nao_conferido` (o mesmo do PATCH); só admin ou
   * profissional confere (0053, o banco grava o perfil); ATENDER a correção grava a data no cadastro nesta
   * transação, com o recálculo da 0038/0039 (e a marca de conferência da 0052).
   */
  atualizarPedido(
    ctx: RequestContext,
    id: string,
    dados: { situacao: Exclude<RightsRequestStatus, 'aberta'>; resposta?: string; documentoConferido?: boolean },
  ): Promise<PedidoDoTitularDto> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      const r = await this.carregar(tx, ctx, id, true);
      if (r.status === 'atendida' || r.status === 'recusada') throw new ConflitoError('pedido_encerrado');
      if (r.status === dados.situacao) throw new ConflitoError('transicao_invalida');
      // A3a do #68: recusa e atendimento comunicam as razões ou o resultado ao titular (o banco confere).
      if (exigeResposta(dados.situacao) && !dados.resposta?.trim() && r.answerEnc === null) throw new EntradaInvalidaError(['resposta']);
      const nasc = await this.nascimentoDoPedido(tx, ctx, r);
      // Conferência de documento só existe em pedido com data proposta.
      if (dados.documentoConferido === true && nasc === null) throw new EntradaInvalidaError(['documentoConferido']);
      const conferirAgora = dados.documentoConferido === true && r.documentCheckedAt === null;
      // 0053: só admin ou profissional declara a conferência (o gatilho grava o perfil e recusa os demais).
      if (conferirAgora) exigirPerfilQueConfere(ctx);
      const conferido = conferirAgora || r.documentCheckedAt !== null;
      // Ressalva 5 (Conferência 0052): ATENDER a correção grava a data proposta no cadastro nesta transação.
      const aplicar = dados.situacao === 'atendida' && nasc !== null ? await this.prepararNascimento(tx, ctx, r.patientId, nasc.proposto) : null;
      // A exigência é a gravada na abertura OU, se o cadastro mudou desde então, a regra contra a data de agora
      // (falha fechada). Mesmo 422 do PATCH (ressalva 3).
      if (dados.situacao === 'atendida' && (nasc?.exigeDocumento || aplicar?.exigeDocumento) && !conferido) throw documentoNaoConferido();
      const answerEnc = dados.resposta ? await cifrarCampoPortal(this.cipher, tx, ctx.tenantId, ctx.userId, id, 'answer', dados.resposta) : r.answerEnc;
      const [novo] = await tx
        .update(portalRightsRequests)
        .set({
          status: dados.situacao,
          handledBy: ctx.userId,
          handledAt: sql`now()`,
          answerEnc,
          ...(conferirAgora ? { documentCheckedBy: ctx.userId, documentCheckedAt: sql`now()` } : {}),
        })
        .where(and(eq(portalRightsRequests.tenantId, ctx.tenantId), eq(portalRightsRequests.id, id)))
        .returning();
      if (!novo) throw new NaoEncontradoError();
      if (aplicar?.mudou) {
        await tx
          .update(patients)
          .set({ birthDateEnc: aplicar.enc, updatedAt: new Date() })
          .where(and(eq(patients.tenantId, ctx.tenantId), eq(patients.id, r.patientId)));
        // Mesma trilha do PATCH (só nomes e flags, nunca a data), com o pedido que originou a mudança.
        await recordAudit(tx, ctx, {
          action: AuditAction.Update,
          scope: 'patients',
          metadata: {
            patient_id: r.patientId,
            changed: 'birth_date',
            request_id: id,
            document_required: Boolean(nasc?.exigeDocumento || aplicar.exigeDocumento),
            document_checked: conferido,
            ...(aplicar.ilegivel ? { birth_date_unreadable: true } : {}),
          },
        });
        // Recálculo da 0038/0039 (e revogação do titular menor, 0050) na mesma transação, com a marca de conferência.
        await recalcularSigiloDoPortal(tx, this.logger, {
          pacienteId: r.patientId,
          nascimento: nasc?.proposto ?? null,
          emancipadoEm: aplicar.emancipadoEm,
          documentoConferido: conferido,
        });
      }
      await recordAudit(tx, ctx, {
        action: AuditAction.Update,
        scope: 'portal_rights_requests',
        metadata: {
          request_id: id,
          from: r.status,
          to: dados.situacao,
          has_answer: dados.resposta !== undefined,
          patient_id: r.patientId,
          ...(nasc ? { document_required: nasc.exigeDocumento, document_checked: conferido } : {}),
          ...(aplicar ? { birth_date_applied: aplicar.mudou } : {}),
        },
      });
      return this.dto(novo);
    });
  }

  /**
   * Ressalva 5 (Conferência 0052): o que o atendimento faz no cadastro. Trava a linha do paciente, decifra a
   * data vigente (ilegível = desconhecida, falha fechada) e, se a proposta é diferente, cifra a nova e diz se a
   * regra de agora exige documento. Paciente inativo: 409 `paciente_inativo` (como no PATCH; reative antes).
   */
  private async prepararNascimento(
    tx: TenantTx,
    ctx: RequestContext,
    pacienteId: string,
    proposto: string,
  ): Promise<{ mudou: boolean; enc: string; exigeDocumento: boolean; ilegivel: boolean; emancipadoEm: string | null }> {
    const [p] = await tx
      .select({ ativo: patients.active, nascEnc: patients.birthDateEnc, emancipadoEm: patients.emancipatedOn })
      .from(patients)
      .where(and(eq(patients.tenantId, ctx.tenantId), eq(patients.id, pacienteId)))
      .for('update');
    if (!p) throw new NaoEncontradoError();
    const vigente = await nascimentoVigente(this.cipher, tx, ctx.tenantId, pacienteId, p.nascEnc);
    const mudou = vigente.ilegivel || vigente.valor !== proposto;
    if (!mudou) return { mudou, enc: p.nascEnc ?? '', exigeDocumento: false, ilegivel: false, emancipadoEm: p.emancipadoEm };
    if (!p.ativo) throw new ConflitoError('paciente_inativo');
    return {
      mudou,
      enc: await this.cipher.encrypt(tx, patientFieldRef(ctx.tenantId, pacienteId, 'birth_date'), proposto),
      exigeDocumento: correcaoDeNascimentoExigeDocumento(vigente.valor, proposto, hojeNaClinica()),
      ilegivel: vigente.ilegivel,
      emancipadoEm: p.emancipadoEm,
    };
  }

  /**
   * Data proposta no pedido de correção (decifrada) e se exige conferência de documento. C1-b′ (0052): a
   * exigência é a GRAVADA na abertura (`document_required`, contra a data vigente naquele momento), nunca
   * recalculada contra o cadastro de agora (corrigir o cadastro antes de atender não a tira).
   * null = pedido sem data proposta.
   */
  private async nascimentoDoPedido(
    tx: TenantTx,
    ctx: RequestContext,
    r: typeof portalRightsRequests.$inferSelect,
  ): Promise<{ proposto: string; exigeDocumento: boolean } | null> {
    const proposto = await decifrarCampoPortal(this.cipher, tx, ctx.tenantId, r.id, 'birth_date_proposed', r.birthDateProposedEnc);
    if (proposto === null) return null;
    return { proposto, exigeDocumento: r.documentRequired };
  }

  /** Estado atual de cada consentimento do paciente (para a recepção e o escriba). */
  consentimentosDoPaciente(
    ctx: RequestContext,
    pacienteId: string,
  ): Promise<{ finalidade: PortalConsentPurpose; resposta: RespostaConsentimento; estadoIa?: AiConsentState; atualizadoEm: string | null }[]> {
    return lerNaClinica(this.db, ctx, async (tx) => {
      const eventos = await tx
        .select({ ...getTableColumns(portalConsents), guardianLinkOk: sql<boolean | null>`app_portal_guardian_link_ok(${portalConsents.tenantId}, ${portalConsents.guardianLinkId})` })
        .from(portalConsents)
        .where(and(eq(portalConsents.tenantId, ctx.tenantId), eq(portalConsents.patientId, pacienteId)))
        .orderBy(asc(portalConsents.createdAt), asc(portalConsents.id));
      await recordAudit(tx, ctx, { action: AuditAction.Read, scope: 'portal_consents', metadata: { patient_id: pacienteId, count: eventos.length } });
      const hoje = hojeNaClinica();
      return (Object.keys(CONSENTIMENTOS) as PortalConsentPurpose[]).map((f) => {
        // V1 e R4 do #68: o evento do responsável só vale enquanto a representação vale (vínculo da 0028 vigente).
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

