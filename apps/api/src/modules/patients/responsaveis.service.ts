import { Inject, Injectable } from '@nestjs/common';
import { AuditAction, type RequestContext, type TenantId } from '@plataforma/shared';
import { and, asc, eq, isNull, ne, or, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { ConflitoError, NaoEncontradoError } from '../../common/erros-dominio';
import { EntradaInvalidaError } from '../../common/validacao';
import { escreverNaClinica, lerNaClinica } from '../../common/transacao-clinica';
import {
  guardians,
  patientGuardianHistory,
  patientGuardians,
  patients,
  payments,
  type GuardianEndReason,
  type GuardianKind,
} from '../../db/schema';
import type { TenantTx } from '../../db/tenant-transaction';
import { recordAudit } from '../audit/audit-log';
import { FIELD_CIPHER } from '../crypto/crypto.module';
import type { FieldCipher } from '../crypto/field-cipher';
import { noFusoDaClinica } from '../scheduling/agenda-regras';
import { TenantDatabase } from '../tenancy/tenancy.module';
import { exigirConteudoClinico } from '../auth/vinculo-de-cuidado';
import { cifrarCampoResponsavel, cifrarCampoVinculo, decifrarCampoResponsavel } from './guardian-fields';
import { patientFieldRef } from './patient-fields';
import {
  faixaEtariaEm,
  informacaoClinica,
  menorEm,
  pendenciasDoCadastro,
  ROTULO_DO_TIPO,
  vigenteEm,
  type FaixaEtaria,
  type MotivoInformacaoClinica,
  type VinculoParaInformacaoClinica,
} from './responsaveis-regras';
import type { AlteracaoVinculo, Encerramento, NovoVinculo } from './responsaveis.validation';

/** Vínculo responsável ↔ paciente, com os dados da pessoa decifrados. */
export interface ResponsavelDto {
  /** Id do VÍNCULO (é o que as rotas usam). */
  readonly id: string;
  /** Id da PESSOA (para vincular a outro paciente, ex.: irmãos). */
  readonly responsavelId: string;
  readonly pacienteId: string;
  readonly nome: string;
  readonly cpf: string | null;
  readonly telefone: string | null;
  readonly tipo: GuardianKind;
  /** Rótulo do tipo para a tela (contrato do front: `Responsavel.parentesco`). */
  readonly parentesco: string;
  readonly pagador: boolean;
  /** A MARCA no vínculo; se a informação chega de fato ao responsável hoje está em `informacaoClinica`. */
  readonly recebeInformacaoClinica: boolean;
  readonly informacaoClinica: { readonly permitida: boolean; readonly motivo: MotivoInformacaoClinica };
  /** Faixa do PACIENTE hoje (regra configurável em responsaveis-regras.ts); null sem data de nascimento. */
  readonly faixaEtaria: FaixaEtaria | null;
  readonly vigencia: { readonly desde: string; readonly ate: string | null; readonly vigente: boolean };
  readonly encerramento: { readonly motivo: GuardianEndReason; readonly em: string } | null;
}

export interface ListaDeResponsaveis {
  readonly itens: readonly ResponsavelDto[];
  /** Menor de idade hoje? null = sem data de nascimento (não se presume). */
  readonly menorDeIdade: boolean | null;
  readonly pendencias: readonly string[];
}

export interface EventoDoHistoricoDto {
  readonly evento: string;
  readonly campos: readonly string[];
  readonly em: string;
  readonly autorId: string;
  /** Estado do vínculo depois do evento (só nos eventos de vínculo). Valores da pessoa não saem aqui. */
  readonly estado: {
    readonly tipo: string | null;
    readonly pagador: boolean | null;
    readonly recebeInformacaoClinica: boolean | null;
    readonly desde: string | null;
    readonly ate: string | null;
    readonly motivoEncerramento: string | null;
  } | null;
}

/** Quem pagou, para o recibo e o Receita Saúde. */
export interface PagadorResponsavel {
  readonly nome: string;
  readonly cpf: string | null;
}

export const SCOPE_RESPONSAVEIS = 'patient_guardians';

const hojeNaClinica = (): string => noFusoDaClinica(new Date()).data;

type LinhaVinculo = typeof patientGuardians.$inferSelect;
type LinhaPessoa = typeof guardians.$inferSelect;
interface QuadroDoPaciente {
  readonly nascimento: string | null;
  readonly emancipadoEm: string | null;
}

/** O vínculo no formato da regra pura (decisão do profissional como data no fuso da clínica). */
function paraRegra(v: LinhaVinculo): VinculoParaInformacaoClinica {
  return {
    desde: v.validFrom,
    ate: v.validUntil,
    tipo: v.kind,
    recebeInformacaoClinica: v.receivesClinicalInfo,
    decididaEm: v.clinicalInfoDecidedAt ? noFusoDaClinica(v.clinicalInfoDecidedAt).data : null,
  };
}

/**
 * Responsável pagador VIVO do paciente AGORA (marca de pagador, vínculo não encerrado, início não futuro),
 * com nome e CPF decifrados; null se não houver. Uso ÚNICO (V1 do parecer #67): o recebimento congela este
 * resultado em `payments` (vínculo + retrato cifrado) na mesma transação; recibo tardio e Receita Saúde leem
 * SÓ o congelado. Trocar, encerrar ou anular o pagador depois não muda pagamento já registrado.
 * Roda na transação do chamador (clínica da sessão, RLS); a auditoria é a do chamador.
 */
export async function pagadorVivoDoCadastro(
  tx: TenantTx,
  cipher: FieldCipher<TenantTx>,
  tenantId: TenantId,
  pacienteId: string,
): Promise<(PagadorResponsavel & { readonly vinculoId: string }) | null> {
  const [l] = await tx
    .select({ v: patientGuardians, g: guardians })
    .from(patientGuardians)
    .innerJoin(guardians, and(eq(guardians.tenantId, patientGuardians.tenantId), eq(guardians.id, patientGuardians.guardianId)))
    .where(
      and(
        eq(patientGuardians.tenantId, tenantId),
        eq(patientGuardians.patientId, pacienteId),
        eq(patientGuardians.isPayer, true),
        isNull(patientGuardians.endedAt),
        sql`${patientGuardians.validFrom} <= ${hojeNaClinica()}::date`,
      ),
    )
    .limit(1);
  if (!l || l.g.nameEnc === null) return null;
  return {
    vinculoId: l.v.id,
    nome: (await decifrarCampoResponsavel(cipher, tx, tenantId, l.g.id, 'name', l.g.nameEnc)) ?? '',
    cpf: await decifrarCampoResponsavel(cipher, tx, tenantId, l.g.id, 'cpf', l.g.cpfEnc),
  };
}

/**
 * Responsáveis do paciente (PAC-01.2). Cada operação roda na transação da clínica DA SESSÃO (RLS), com a
 * política de assinatura, e grava auditoria (só ids, nomes de campo e contagens) na mesma transação. Nada se
 * apaga: encerrar grava o fim da vigência; o histórico é escrito pelos triggers da 0028.
 */
@Injectable()
export class ResponsaveisService {
  constructor(
    @Inject(TenantDatabase) private readonly db: TenantDatabase,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher<TenantTx>,
  ) {}

  listar(ctx: RequestContext, pacienteId: string, filtro: { situacao: 'vigentes' | 'todos' }): Promise<ListaDeResponsaveis> {
    return lerNaClinica(this.db, ctx, async (tx) => {
      const pac = await this.paciente(tx, ctx, pacienteId);
      const hoje = hojeNaClinica();
      const quadro = await this.quadro(tx, ctx.tenantId, pac);
      const linhas = await tx
        .select({ v: patientGuardians, g: guardians })
        .from(patientGuardians)
        .innerJoin(guardians, and(eq(guardians.tenantId, patientGuardians.tenantId), eq(guardians.id, patientGuardians.guardianId)))
        .where(and(eq(patientGuardians.tenantId, ctx.tenantId), eq(patientGuardians.patientId, pacienteId)))
        .orderBy(asc(patientGuardians.validFrom), asc(patientGuardians.createdAt), asc(patientGuardians.id));
      const todos: ResponsavelDto[] = [];
      for (const l of linhas) todos.push(await this.paraDto(tx, ctx.tenantId, l.v, l.g, quadro, hoje));
      const itens = filtro.situacao === 'todos' ? todos : todos.filter((r) => r.vigencia.vigente);
      const menor = menorEm(quadro.nascimento, hoje, quadro.emancipadoEm);
      await recordAudit(tx, ctx, {
        action: AuditAction.Read,
        scope: SCOPE_RESPONSAVEIS,
        metadata: { patient_id: pacienteId, count: itens.length },
      });
      return {
        itens,
        menorDeIdade: menor,
        pendencias: pendenciasDoCadastro(menor, todos.map((r) => ({ ...r.vigencia, pagador: r.pagador, motivoInformacaoClinica: r.informacaoClinica.motivo })), hoje),
      };
    });
  }

  criar(ctx: RequestContext, pacienteId: string, dados: NovoVinculo): Promise<ResponsavelDto> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      const pac = await this.paciente(tx, ctx, pacienteId, true);
      if (!pac.active) throw new ConflitoError('paciente_inativo');
      const hoje = hojeNaClinica();
      let pessoa: LinhaPessoa;
      if (dados.responsavelId) {
        const [g] = await tx
          .select()
          .from(guardians)
          .where(and(eq(guardians.tenantId, ctx.tenantId), eq(guardians.id, dados.responsavelId)));
        if (!g) throw new NaoEncontradoError();
        pessoa = g;
      } else {
        const p = dados.pessoa as NonNullable<NovoVinculo['pessoa']>;
        const id = randomUUID();
        const [g] = await tx
          .insert(guardians)
          .values({
            id,
            tenantId: ctx.tenantId,
            nameEnc: await cifrarCampoResponsavel(this.cipher, tx, ctx, id, 'name', p.nome),
            cpfEnc: p.cpf ? await cifrarCampoResponsavel(this.cipher, tx, ctx, id, 'cpf', p.cpf) : null,
            phoneEnc: p.telefone ? await cifrarCampoResponsavel(this.cipher, tx, ctx, id, 'phone', p.telefone) : null,
            createdBy: ctx.userId,
            updatedBy: ctx.userId,
          })
          .returning();
        pessoa = g as LinhaPessoa;
      }
      const vivos = await tx
        .select({ guardianId: patientGuardians.guardianId, isPayer: patientGuardians.isPayer })
        .from(patientGuardians)
        .where(and(eq(patientGuardians.tenantId, ctx.tenantId), eq(patientGuardians.patientId, pacienteId), isNull(patientGuardians.endedAt)));
      if (vivos.some((v) => v.guardianId === pessoa.id)) throw new ConflitoError('responsavel_ja_vinculado');
      if (dados.pagador && vivos.some((v) => v.isPayer)) throw new ConflitoError('pagador_ja_definido');
      const vinculoId = randomUUID();
      const decisao = dados.recebeInformacaoClinica ? await this.decisaoClinica(tx, ctx, pacienteId, vinculoId, dados.justificativa) : {};
      const [v] = await tx
        .insert(patientGuardians)
        .values({
          id: vinculoId,
          ...decisao,
          tenantId: ctx.tenantId,
          patientId: pacienteId,
          guardianId: pessoa.id,
          kind: dados.tipo,
          isPayer: dados.pagador,
          receivesClinicalInfo: dados.recebeInformacaoClinica,
          validFrom: dados.desde ?? hoje,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        })
        .returning();
      const vinculo = v as LinhaVinculo;
      await recordAudit(tx, ctx, {
        action: AuditAction.Create,
        scope: SCOPE_RESPONSAVEIS,
        metadata: {
          patient_id: pacienteId,
          link_id: vinculo.id,
          guardian_id: pessoa.id,
          kind: dados.tipo,
          payer: dados.pagador,
          clinical_info: dados.recebeInformacaoClinica,
          existing_guardian: dados.responsavelId !== undefined,
        },
      });
      return this.paraDto(tx, ctx.tenantId, vinculo, pessoa, await this.quadro(tx, ctx.tenantId, pac), hoje);
    });
  }

  /** Dados da pessoa (valem para todos os vínculos dela) e a marca de informação clínica do vínculo. */
  alterar(ctx: RequestContext, pacienteId: string, vinculoId: string, dados: AlteracaoVinculo): Promise<ResponsavelDto> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      const pac = await this.paciente(tx, ctx, pacienteId);
      const { v, g } = await this.travarVinculo(tx, ctx, pacienteId, vinculoId);
      if (v.endedAt) throw new ConflitoError('vinculo_encerrado');
      const campos: string[] = [];
      let pessoa = g;
      if (dados.nome !== undefined || dados.cpf !== undefined || dados.telefone !== undefined) {
        const mud: Partial<typeof guardians.$inferInsert> = { updatedBy: ctx.userId };
        if (dados.nome !== undefined) {
          mud.nameEnc = await cifrarCampoResponsavel(this.cipher, tx, ctx, g.id, 'name', dados.nome);
          campos.push('name');
        }
        if (dados.cpf !== undefined) {
          mud.cpfEnc = dados.cpf === null ? null : await cifrarCampoResponsavel(this.cipher, tx, ctx, g.id, 'cpf', dados.cpf);
          campos.push('cpf');
        }
        if (dados.telefone !== undefined) {
          mud.phoneEnc = dados.telefone === null ? null : await cifrarCampoResponsavel(this.cipher, tx, ctx, g.id, 'phone', dados.telefone);
          campos.push('phone');
        }
        const [ng] = await tx
          .update(guardians)
          .set(mud)
          .where(and(eq(guardians.tenantId, ctx.tenantId), eq(guardians.id, g.id)))
          .returning();
        pessoa = ng as LinhaPessoa;
      }
      let vinculo = v;
      // Ligar (ou renovar a decisão com nova justificativa, ex.: o paciente fez 12 anos) é decisão do
      // profissional; desligar é livre (fail-safe).
      if (dados.recebeInformacaoClinica === true || (dados.recebeInformacaoClinica === false && v.receivesClinicalInfo)) {
        const decisao = dados.recebeInformacaoClinica ? await this.decisaoClinica(tx, ctx, pacienteId, v.id, dados.justificativa) : {};
        const [nv] = await tx
          .update(patientGuardians)
          .set({ receivesClinicalInfo: dados.recebeInformacaoClinica, ...decisao, updatedBy: ctx.userId })
          .where(and(eq(patientGuardians.tenantId, ctx.tenantId), eq(patientGuardians.id, v.id)))
          .returning();
        vinculo = nv as LinhaVinculo;
        campos.push('receives_clinical_info');
      }
      // Só os NOMES das colunas alteradas, nunca os valores.
      await recordAudit(tx, ctx, {
        action: AuditAction.Update,
        scope: SCOPE_RESPONSAVEIS,
        metadata: { patient_id: pacienteId, link_id: v.id, guardian_id: g.id, changed: campos.join(',') },
      });
      return this.paraDto(tx, ctx.tenantId, vinculo, pessoa, await this.quadro(tx, ctx.tenantId, pac), hojeNaClinica());
    });
  }

  /** Marca (ou desmarca) o pagador. Marcar desmarca o pagador vivo anterior do paciente na mesma transação. */
  marcarPagador(ctx: RequestContext, pacienteId: string, vinculoId: string, pagador: boolean): Promise<ResponsavelDto> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      // Trava o paciente: duas marcações simultâneas se enfileiram (e o índice único é a última barreira).
      const pac = await this.paciente(tx, ctx, pacienteId, true);
      const { v, g } = await this.travarVinculo(tx, ctx, pacienteId, vinculoId);
      if (v.endedAt) throw new ConflitoError('vinculo_encerrado');
      let anterior: string | null = null;
      if (pagador && !v.isPayer) {
        const [ant] = await tx
          .update(patientGuardians)
          .set({ isPayer: false, updatedBy: ctx.userId })
          .where(
            and(
              eq(patientGuardians.tenantId, ctx.tenantId),
              eq(patientGuardians.patientId, pacienteId),
              eq(patientGuardians.isPayer, true),
              isNull(patientGuardians.endedAt),
              ne(patientGuardians.id, v.id),
            ),
          )
          .returning({ id: patientGuardians.id });
        anterior = ant?.id ?? null;
      }
      let vinculo = v;
      if (pagador !== v.isPayer) {
        const [nv] = await tx
          .update(patientGuardians)
          .set({ isPayer: pagador, updatedBy: ctx.userId })
          .where(and(eq(patientGuardians.tenantId, ctx.tenantId), eq(patientGuardians.id, v.id)))
          .returning();
        vinculo = nv as LinhaVinculo;
        await recordAudit(tx, ctx, {
          action: AuditAction.Update,
          scope: SCOPE_RESPONSAVEIS,
          metadata: {
            patient_id: pacienteId,
            link_id: v.id,
            changed: 'is_payer',
            payer: pagador,
            ...(anterior ? { previous_payer_link_id: anterior } : {}),
          },
        });
      }
      return this.paraDto(tx, ctx.tenantId, vinculo, g, await this.quadro(tx, ctx.tenantId, pac), hojeNaClinica());
    });
  }

  /** Encerra a vigência (fim EXCLUSIVO; não futuro). Terminal: para retomar, crie outro vínculo. */
  encerrar(ctx: RequestContext, pacienteId: string, vinculoId: string, dados: Encerramento): Promise<ResponsavelDto> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      const pac = await this.paciente(tx, ctx, pacienteId);
      const { v, g } = await this.travarVinculo(tx, ctx, pacienteId, vinculoId);
      if (v.endedAt) throw new ConflitoError('vinculo_encerrado');
      const hoje = hojeNaClinica();
      const ate = dados.ate ?? hoje;
      if (ate < v.validFrom) throw new ConflitoError('fim_antes_do_inicio');
      // V1 do #67: o fim não pode cair antes de recebimento já atribuído a este vínculo (o congelado não
      // muda de qualquer forma; aqui só se evita um cadastro incoerente com o financeiro).
      // Encerrar HOJE é sempre aceito (o pagamento de hoje já está congelado).
      const [atribuido] = ate >= hoje ? [] : await tx
        .select({ id: payments.id })
        .from(payments)
        .where(
          and(
            eq(payments.tenantId, ctx.tenantId),
            eq(payments.guardianPayerLinkId, v.id),
            sql`(${payments.receivedAt} AT TIME ZONE 'America/Sao_Paulo')::date >= ${ate}::date`,
          ),
        )
        .limit(1);
      if (atribuido) throw new ConflitoError('encerramento_antes_de_pagamento_atribuido');
      const [nv] = await tx
        .update(patientGuardians)
        .set({ validUntil: ate, endReason: dados.motivo, endedAt: new Date(), endedBy: ctx.userId, updatedBy: ctx.userId })
        .where(and(eq(patientGuardians.tenantId, ctx.tenantId), eq(patientGuardians.id, v.id)))
        .returning();
      await recordAudit(tx, ctx, {
        action: AuditAction.Update,
        scope: SCOPE_RESPONSAVEIS,
        metadata: { patient_id: pacienteId, link_id: v.id, changed: 'valid_until', reason: dados.motivo },
      });
      return this.paraDto(tx, ctx.tenantId, nv as LinhaVinculo, g, await this.quadro(tx, ctx.tenantId, pac), hoje);
    });
  }

  /** Histórico do vínculo e da pessoa: eventos, campos e estado — nunca os valores da pessoa. */
  historico(ctx: RequestContext, pacienteId: string, vinculoId: string): Promise<readonly EventoDoHistoricoDto[]> {
    return lerNaClinica(this.db, ctx, async (tx) => {
      const [v] = await tx
        .select()
        .from(patientGuardians)
        .where(and(eq(patientGuardians.tenantId, ctx.tenantId), eq(patientGuardians.id, vinculoId), eq(patientGuardians.patientId, pacienteId)));
      if (!v) throw new NaoEncontradoError();
      const linhas = await tx
        .select()
        .from(patientGuardianHistory)
        .where(
          and(
            eq(patientGuardianHistory.tenantId, ctx.tenantId),
            or(
              eq(patientGuardianHistory.linkId, v.id),
              and(isNull(patientGuardianHistory.linkId), eq(patientGuardianHistory.guardianId, v.guardianId)),
            ),
          ),
        )
        .orderBy(asc(patientGuardianHistory.seq));
      await recordAudit(tx, ctx, {
        action: AuditAction.Read,
        scope: SCOPE_RESPONSAVEIS,
        metadata: { patient_id: pacienteId, link_id: v.id, count: linhas.length, history: true },
      });
      return linhas.map((h) => ({
        evento: h.event,
        campos: h.changedFields ? h.changedFields.split(',') : [],
        em: h.occurredAt.toISOString(),
        autorId: h.actorId,
        estado:
          h.linkId === null
            ? null
            : {
                tipo: h.kind,
                pagador: h.isPayer,
                recebeInformacaoClinica: h.receivesClinicalInfo,
                desde: h.validFrom,
                ate: h.validUntil,
                motivoEncerramento: h.endReason,
              },
      }));
    });
  }

  /**
   * Para o portal/comunicações (POR-01.2, COM): o responsável pode receber informação clínica do paciente
   * HOJE? Marca por decisão do profissional + vínculo vigente + menor não emancipado (adolescente: decisão
   * tomada já na adolescência) — salvo curatela. Auditado (decisão sobre dado de saúde). Sem consumidor
   * nesta rodada: o consumidor (portal/COM) passa por novo parecer (O1 do #67).
   */
  podeReceberInformacaoClinica(ctx: RequestContext, pacienteId: string, vinculoId: string): Promise<boolean> {
    return lerNaClinica(this.db, ctx, async (tx) => {
      const pac = await this.paciente(tx, ctx, pacienteId);
      const [v] = await tx
        .select()
        .from(patientGuardians)
        .where(and(eq(patientGuardians.tenantId, ctx.tenantId), eq(patientGuardians.id, vinculoId), eq(patientGuardians.patientId, pacienteId)));
      if (!v) throw new NaoEncontradoError();
      const quadro = await this.quadro(tx, ctx.tenantId, pac);
      const r = informacaoClinica(paraRegra(v), quadro.nascimento, hojeNaClinica(), quadro.emancipadoEm);
      await recordAudit(tx, ctx, {
        action: AuditAction.Read,
        scope: SCOPE_RESPONSAVEIS,
        metadata: { patient_id: pacienteId, link_id: v.id, clinical_info: r.permitida, reason: r.motivo },
      });
      return r.permitida;
    });
  }

  /**
   * Decisão do profissional de ligar a informação clínica (A1/A2 do #67): perfil clínico E vínculo de
   * cuidado com o paciente (403 `sem_vinculo_de_cuidado`), justificativa cifrada; o banco confere o perfil
   * `profissional` da clínica e grava autor e data.
   */
  private async decisaoClinica(
    tx: TenantTx,
    ctx: RequestContext,
    pacienteId: string,
    vinculoId: string,
    justificativa: string | undefined,
  ): Promise<Pick<typeof patientGuardians.$inferInsert, 'clinicalInfoDecidedBy' | 'clinicalInfoDecidedAt' | 'clinicalInfoBasisEnc'>> {
    await exigirConteudoClinico(tx, ctx, pacienteId);
    if (!justificativa) throw new EntradaInvalidaError(['justificativa']);
    return {
      clinicalInfoDecidedBy: ctx.userId,
      clinicalInfoDecidedAt: new Date(),
      clinicalInfoBasisEnc: await cifrarCampoVinculo(this.cipher, tx, ctx, vinculoId, 'clinical_info_basis', justificativa),
    };
  }

  private async paciente(tx: TenantTx, ctx: RequestContext, id: string, travar = false): Promise<typeof patients.$inferSelect> {
    const q = tx
      .select()
      .from(patients)
      .where(and(eq(patients.tenantId, ctx.tenantId), eq(patients.id, id)));
    const [p] = travar ? await q.for('update') : await q;
    if (!p) throw new NaoEncontradoError();
    return p;
  }

  private async travarVinculo(tx: TenantTx, ctx: RequestContext, pacienteId: string, vinculoId: string): Promise<{ v: LinhaVinculo; g: LinhaPessoa }> {
    const [l] = await tx
      .select({ v: patientGuardians, g: guardians })
      .from(patientGuardians)
      .innerJoin(guardians, and(eq(guardians.tenantId, patientGuardians.tenantId), eq(guardians.id, patientGuardians.guardianId)))
      .where(and(eq(patientGuardians.tenantId, ctx.tenantId), eq(patientGuardians.id, vinculoId), eq(patientGuardians.patientId, pacienteId)))
      .for('update', { of: patientGuardians });
    if (!l) throw new NaoEncontradoError();
    return l;
  }

  /** Data de nascimento decifrada e emancipação do paciente (base das regras de idade). */
  private async quadro(tx: TenantTx, tenantId: TenantId, pac: typeof patients.$inferSelect): Promise<QuadroDoPaciente> {
    return {
      nascimento: pac.birthDateEnc ? await this.cipher.decryptString(tx, patientFieldRef(tenantId, pac.id, 'birth_date'), pac.birthDateEnc) : null,
      emancipadoEm: pac.emancipatedOn,
    };
  }

  private async paraDto(tx: TenantTx, tenantId: TenantId, v: LinhaVinculo, g: LinhaPessoa, quadro: QuadroDoPaciente, hoje: string): Promise<ResponsavelDto> {
    const vig = { desde: v.validFrom, ate: v.validUntil };
    return {
      id: v.id,
      responsavelId: g.id,
      pacienteId: v.patientId,
      nome: (await decifrarCampoResponsavel(this.cipher, tx, tenantId, g.id, 'name', g.nameEnc)) ?? '',
      cpf: await decifrarCampoResponsavel(this.cipher, tx, tenantId, g.id, 'cpf', g.cpfEnc),
      telefone: await decifrarCampoResponsavel(this.cipher, tx, tenantId, g.id, 'phone', g.phoneEnc),
      tipo: v.kind,
      parentesco: ROTULO_DO_TIPO[v.kind],
      pagador: v.isPayer,
      recebeInformacaoClinica: v.receivesClinicalInfo,
      informacaoClinica: informacaoClinica(paraRegra(v), quadro.nascimento, hoje, quadro.emancipadoEm),
      faixaEtaria: faixaEtariaEm(quadro.nascimento, hoje, quadro.emancipadoEm),
      vigencia: { ...vig, vigente: vigenteEm(vig, hoje) },
      encerramento: v.endReason && v.endedAt ? { motivo: v.endReason, em: v.endedAt.toISOString() } : null,
    };
  }
}
