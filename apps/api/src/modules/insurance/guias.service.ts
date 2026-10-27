import { Inject, Injectable } from '@nestjs/common';
import { AuditAction, type RequestContext, type TenantId } from '@plataforma/shared';
import { and, asc, eq, gte, isNull, lt, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { ConflitoError, NaoEncontradoError, ProibidoError } from '../../common/erros-dominio';
import { escreverNaClinica, lerNaClinica } from '../../common/transacao-clinica';
import { EntradaInvalidaError } from '../../common/validacao';
import {
  appointments,
  guideSessions,
  guideSessionSignatures,
  insuranceGuides,
  insurers,
  patients,
  type GuideOverrideReason,
  type GuideReversalReason,
  type SignatureMethod,
} from '../../db/schema';
import { dbErrorCode } from '../../db/db-errors';
import type { TenantTx } from '../../db/tenant-transaction';
import { recordAudit } from '../audit/audit-log';
import { FIELD_CIPHER } from '../crypto/crypto.module';
import type { FieldCipher } from '../crypto/field-cipher';
import { janelaDeDias, noFusoDaClinica } from '../scheduling/agenda-regras';
import { TenantDatabase } from '../tenancy/tenancy.module';
import { consumoAtivoDoAgendamento, SCOPE_CONSUMO_GUIA, travarAgendamento } from './consumos';
import { cifrarCampoDaGuia, decifrarCampoDaGuia } from './guide-fields';
import {
  alertasDe,
  diasEntre,
  estaVencida,
  hashDaConfirmacao,
  hojeNaClinica,
  LIMIARES_GUIA,
  normalizarIdentificador,
  saldoDe,
  situacaoDe,
  somarDias,
  statusConsome,
  type Alerta,
  type Limiares,
  type Situacao,
} from './guias-regras';
import {
  MAXIMO_LINHAS_RELATORIO,
  type AlteracaoConvenio,
  type AlteracaoGuia,
  type FiltroGuias,
  type FiltroRelatorio,
  type NovaGuia,
  type NovoConvenio,
} from './guias.validation';

export interface ConvenioDto {
  readonly id: string;
  readonly nome: string;
  readonly registroAns: string | null;
  readonly valorSessaoCentavos: number | null;
  readonly exigeSenha: boolean;
  readonly exigeAssinatura: boolean;
  readonly validadePadraoDias: number | null;
  readonly ativo: boolean;
}

/** Contrato `Guia` do front (apps/web/lib/api/tipos.ts) + saldo, situação e alertas calculados aqui. */
export interface GuiaDto {
  readonly id: string;
  readonly pacienteId: string;
  readonly convenioId: string;
  /** Nome do convênio (o front mostra o nome). */
  readonly convenio: string;
  readonly numero: string;
  readonly sessoesAutorizadas: number;
  readonly sessoesUsadas: number;
  readonly saldo: number;
  /** AAAA-MM-DD */
  readonly emissao: string | null;
  readonly validade: string;
  readonly situacao: Situacao;
  readonly alertas: readonly Alerta[];
}

/** Detalhe: inclui senha e carteirinha (para faturar no portal da operadora). */
export interface GuiaDetalheDto extends GuiaDto {
  readonly senha: string | null;
  readonly carteirinha: string | null;
  readonly exigeAssinatura: boolean;
}

export interface PaginaDeGuias {
  readonly itens: readonly GuiaDto[];
  readonly pagina: number;
  readonly limite: number;
  readonly temMais: boolean;
}

export interface AlertaDeGuiaDto {
  readonly guiaId: string;
  readonly pacienteId: string;
  readonly convenioId: string;
  readonly convenio: string;
  readonly validade: string;
  readonly saldo: number;
  readonly alertas: readonly Alerta[];
}

export interface ConsumoGuiaDto {
  readonly id: string;
  readonly guiaId: string;
  readonly agendamentoId: string;
  readonly consumidoEm: string;
  readonly override: GuideOverrideReason | null;
  readonly estornadoEm: string | null;
  readonly motivoEstorno: GuideReversalReason | null;
  readonly assinatura: { readonly meio: SignatureMethod; readonly dispositivo: string | null; readonly assinadaEm: string; readonly hash: string } | null;
  /** Convênio exige assinatura por sessão e esta (não estornada) ainda não tem. */
  readonly assinaturaPendente: boolean;
}

export interface ResultadoConsumoDto {
  readonly consumoId: string;
  readonly guiaId: string;
  readonly sessoesUsadas: number;
  readonly saldo: number;
  readonly situacao: Situacao;
}

export interface RelatorioConvenioDto {
  readonly convenio: { readonly id: string; readonly nome: string; readonly valorSessaoCentavos: number | null; readonly exigeAssinatura: boolean };
  readonly de: string;
  readonly ate: string;
  readonly sessoes: readonly {
    readonly consumoId: string;
    readonly guiaId: string;
    readonly numeroGuia: string;
    readonly pacienteId: string;
    readonly profissionalId: string;
    readonly agendamentoId: string;
    readonly data: string;
    readonly hora: string;
    readonly assinada: boolean;
    readonly override: boolean;
  }[];
  readonly totais: {
    readonly sessoes: number;
    readonly assinadas: number;
    readonly assinaturasPendentes: number;
    readonly valorCentavos: number | null;
  };
  readonly truncado: boolean;
}

const SCOPE_CONVENIOS = 'insurers';
const SCOPE_GUIAS = 'insurance_guides';
const SCOPE_ASSINATURAS = 'guide_session_signatures';
const MAXIMO_ALERTAS = 1000;

type LinhaGuia = typeof insuranceGuides.$inferSelect;
type LinhaConvenio = typeof insurers.$inferSelect;

function convenioDto(c: LinhaConvenio): ConvenioDto {
  return {
    id: c.id,
    nome: c.name,
    registroAns: c.ansCode,
    valorSessaoCentavos: c.sessionValueCents,
    exigeSenha: c.requiresPassword,
    exigeAssinatura: c.requiresSignature,
    validadePadraoDias: c.defaultValidityDays,
    ativo: c.active,
  };
}

function baseDeSaldo(g: LinhaGuia) {
  return { cancelada: g.status === 'cancelled', total: g.authorizedSessions, usadas: g.usedSessions, validade: g.validUntil };
}

/**
 * Convênios e guias (CNV-04.1 a 04.6, sem XML TISS). Cada operação: transação da clínica DA SESSÃO
 * (RLS), política de assinatura (G1/G4) e auditoria na mesma transação, só com ids, contagens e
 * códigos — nunca número da guia, senha, carteirinha ou nome. Número/senha/carteirinha ficam
 * cifrados com a chave da clínica e só são decifrados para quem tem `guias:ler`.
 */
@Injectable()
export class GuiasService {
  constructor(
    @Inject(TenantDatabase) private readonly db: TenantDatabase,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher<TenantTx>,
  ) {}

  // ---------------------------------------------------------------- convênios

  listarConvenios(ctx: RequestContext): Promise<ConvenioDto[]> {
    return lerNaClinica(this.db, ctx, async (tx) => {
      const linhas = await tx
        .select()
        .from(insurers)
        .where(eq(insurers.tenantId, ctx.tenantId))
        .orderBy(asc(insurers.name), asc(insurers.id));
      await recordAudit(tx, ctx, { action: AuditAction.Read, scope: SCOPE_CONVENIOS, metadata: { count: linhas.length } });
      return linhas.map(convenioDto);
    });
  }

  criarConvenio(ctx: RequestContext, dados: NovoConvenio): Promise<ConvenioDto> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      await this.nomeLivre(tx, ctx, dados.nome);
      const [c] = await tx
        .insert(insurers)
        .values({
          tenantId: ctx.tenantId,
          name: dados.nome,
          ansCode: dados.registroAns ?? null,
          sessionValueCents: dados.valorSessaoCentavos ?? null,
          requiresPassword: dados.exigeSenha,
          requiresSignature: dados.exigeAssinatura,
          defaultValidityDays: dados.validadePadraoDias ?? null,
        })
        .returning();
      if (!c) throw new Error('falha ao criar convênio');
      await recordAudit(tx, ctx, { action: AuditAction.Create, scope: SCOPE_CONVENIOS, metadata: { insurer_id: c.id } });
      return convenioDto(c);
    });
  }

  atualizarConvenio(ctx: RequestContext, id: string, dados: AlteracaoConvenio): Promise<ConvenioDto> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      const atual = await this.travarConvenio(tx, ctx, id);
      if (dados.nome !== undefined && dados.nome.toLowerCase() !== atual.name.toLowerCase()) await this.nomeLivre(tx, ctx, dados.nome);
      const mudancas: Partial<typeof insurers.$inferInsert> = {
        updatedAt: new Date(),
        ...(dados.nome !== undefined ? { name: dados.nome } : {}),
        ...(dados.registroAns !== undefined ? { ansCode: dados.registroAns } : {}),
        ...(dados.valorSessaoCentavos !== undefined ? { sessionValueCents: dados.valorSessaoCentavos } : {}),
        ...(dados.exigeSenha !== undefined ? { requiresPassword: dados.exigeSenha } : {}),
        ...(dados.exigeAssinatura !== undefined ? { requiresSignature: dados.exigeAssinatura } : {}),
        ...(dados.validadePadraoDias !== undefined ? { defaultValidityDays: dados.validadePadraoDias } : {}),
      };
      // Códigos curtos das colunas alteradas (o metadata limita o texto a 64 caracteres).
      const curto: Record<string, string> = {
        name: 'name',
        ansCode: 'ans',
        sessionValueCents: 'value',
        requiresPassword: 'pwd_rule',
        requiresSignature: 'sig_rule',
        defaultValidityDays: 'validity',
      };
      const campos = Object.keys(mudancas).flatMap((k) => (curto[k] ? [curto[k]] : []));
      const [c] = await tx
        .update(insurers)
        .set(mudancas)
        .where(and(eq(insurers.tenantId, ctx.tenantId), eq(insurers.id, id)))
        .returning();
      if (!c) throw new NaoEncontradoError();
      await recordAudit(tx, ctx, {
        action: AuditAction.Update,
        scope: SCOPE_CONVENIOS,
        metadata: { insurer_id: id, changed: campos.join(',') },
      });
      return convenioDto(c);
    });
  }

  /** HU-CNV-001: inativado, bloqueia guias NOVAS; as ativas continuam até o fim do saldo. Idempotente. */
  inativarConvenio(ctx: RequestContext, id: string): Promise<ConvenioDto> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      const atual = await this.travarConvenio(tx, ctx, id);
      if (!atual.active) return convenioDto(atual);
      const agora = new Date();
      const [c] = await tx
        .update(insurers)
        .set({ active: false, inactivatedAt: agora, updatedAt: agora })
        .where(and(eq(insurers.tenantId, ctx.tenantId), eq(insurers.id, id)))
        .returning();
      if (!c) throw new NaoEncontradoError();
      await recordAudit(tx, ctx, { action: AuditAction.Update, scope: SCOPE_CONVENIOS, metadata: { insurer_id: id, changed: 'active' } });
      return convenioDto(c);
    });
  }

  // ---------------------------------------------------------------- guias

  listarGuias(ctx: RequestContext, filtro: FiltroGuias): Promise<PaginaDeGuias> {
    return lerNaClinica(this.db, ctx, async (tx) => {
      const condicoes: SQL[] = [eq(insuranceGuides.tenantId, ctx.tenantId)];
      if (filtro.pacienteId) condicoes.push(eq(insuranceGuides.patientId, filtro.pacienteId));
      if (filtro.convenioId) condicoes.push(eq(insuranceGuides.insurerId, filtro.convenioId));
      if (filtro.situacao === 'ativas') condicoes.push(eq(insuranceGuides.status, 'active'));
      const linhas = await tx
        .select({ guia: insuranceGuides, convenio: insurers.name })
        .from(insuranceGuides)
        .innerJoin(insurers, and(eq(insurers.id, insuranceGuides.insurerId), eq(insurers.tenantId, insuranceGuides.tenantId)))
        .where(and(...condicoes))
        .orderBy(asc(insuranceGuides.validUntil), asc(insuranceGuides.id))
        .limit(filtro.limite + 1)
        .offset((filtro.pagina - 1) * filtro.limite);
      const temMais = linhas.length > filtro.limite;
      const hoje = hojeNaClinica();
      const itens: GuiaDto[] = [];
      for (const l of linhas.slice(0, filtro.limite)) itens.push(await this.guiaDto(tx, ctx.tenantId, l.guia, l.convenio, hoje));
      await recordAudit(tx, ctx, {
        action: AuditAction.Read,
        scope: SCOPE_GUIAS,
        metadata: { count: itens.length, page: filtro.pagina, ...(filtro.pacienteId ? { patient_id: filtro.pacienteId } : {}) },
      });
      return { itens, pagina: filtro.pagina, limite: filtro.limite, temMais };
    });
  }

  obterGuia(ctx: RequestContext, id: string): Promise<GuiaDetalheDto> {
    return lerNaClinica(this.db, ctx, async (tx) => {
      const [l] = await tx
        .select({ guia: insuranceGuides, convenio: insurers })
        .from(insuranceGuides)
        .innerJoin(insurers, and(eq(insurers.id, insuranceGuides.insurerId), eq(insurers.tenantId, insuranceGuides.tenantId)))
        .where(and(eq(insuranceGuides.tenantId, ctx.tenantId), eq(insuranceGuides.id, id)));
      if (!l) throw new NaoEncontradoError();
      const dto = await this.detalheDto(tx, ctx.tenantId, l.guia, l.convenio);
      await recordAudit(tx, ctx, {
        action: AuditAction.Read,
        scope: SCOPE_GUIAS,
        metadata: { guide_id: id, patient_id: l.guia.patientId },
      });
      return dto;
    });
  }

  criarGuia(ctx: RequestContext, dados: NovaGuia): Promise<GuiaDetalheDto> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      const [paciente] = await tx
        .select({ ativo: patients.active })
        .from(patients)
        .where(and(eq(patients.tenantId, ctx.tenantId), eq(patients.id, dados.pacienteId)));
      if (!paciente) throw new NaoEncontradoError();
      if (!paciente.ativo) throw new ConflitoError('paciente_inativo');
      const convenio = await this.travarConvenio(tx, ctx, dados.convenioId);
      if (!convenio.active) throw new ConflitoError('convenio_inativo');
      if (convenio.requiresPassword && !dados.senha) throw new EntradaInvalidaError(['senha']);
      const validade = dados.validade ?? this.validadePadrao(convenio, dados.emissao);
      if (dados.emissao && diasEntre(dados.emissao, validade) < 0) throw new EntradaInvalidaError(['validade']);
      // A trava do convênio (acima) serializa os registros do mesmo convênio: duas recepções não
      // gravam o mesmo número ao mesmo tempo.
      await this.numeroLivre(tx, ctx, convenio.id, dados.numero);

      const id = randomUUID();
      const [g] = await tx
        .insert(insuranceGuides)
        .values({
          id,
          tenantId: ctx.tenantId,
          patientId: dados.pacienteId,
          insurerId: convenio.id,
          numberEnc: await cifrarCampoDaGuia(this.cipher, tx, ctx, id, 'number', dados.numero),
          authorizationCodeEnc: dados.senha ? await cifrarCampoDaGuia(this.cipher, tx, ctx, id, 'authorization_code', dados.senha) : null,
          cardNumberEnc: dados.carteirinha ? await cifrarCampoDaGuia(this.cipher, tx, ctx, id, 'card_number', dados.carteirinha) : null,
          authorizedSessions: dados.sessoesAutorizadas,
          issuedOn: dados.emissao ?? null,
          validUntil: validade,
        })
        .returning();
      if (!g) throw new Error('falha ao criar guia');
      await recordAudit(tx, ctx, {
        action: AuditAction.Create,
        scope: SCOPE_GUIAS,
        metadata: { guide_id: id, patient_id: dados.pacienteId, insurer_id: convenio.id, sessions: dados.sessoesAutorizadas },
      });
      return this.detalheDto(tx, ctx.tenantId, g, convenio);
    });
  }

  atualizarGuia(ctx: RequestContext, id: string, dados: AlteracaoGuia): Promise<GuiaDetalheDto> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      const atual = await this.travarGuia(tx, ctx, id);
      if (atual.status === 'cancelled') throw new ConflitoError('guia_cancelada');
      const [convenio] = await tx
        .select()
        .from(insurers)
        .where(and(eq(insurers.tenantId, ctx.tenantId), eq(insurers.id, atual.insurerId)));
      if (!convenio) throw new NaoEncontradoError();
      if (dados.sessoesAutorizadas !== undefined && dados.sessoesAutorizadas < atual.usedSessions) {
        throw new ConflitoError('autorizadas_abaixo_das_usadas');
      }
      if (dados.validade !== undefined && atual.issuedOn && diasEntre(atual.issuedOn, dados.validade) < 0) {
        throw new EntradaInvalidaError(['validade']);
      }
      if (dados.senha === null && convenio.requiresPassword) throw new EntradaInvalidaError(['senha']);
      const mudancas: Partial<typeof insuranceGuides.$inferInsert> = { updatedAt: new Date() };
      const campos: string[] = [];
      if (dados.sessoesAutorizadas !== undefined) {
        mudancas.authorizedSessions = dados.sessoesAutorizadas;
        campos.push('authorized_sessions');
      }
      if (dados.validade !== undefined) {
        mudancas.validUntil = dados.validade;
        campos.push('valid_until');
      }
      if (dados.senha !== undefined) {
        mudancas.authorizationCodeEnc = dados.senha === null ? null : await cifrarCampoDaGuia(this.cipher, tx, ctx, id, 'authorization_code', dados.senha);
        campos.push('authorization_code');
      }
      if (dados.carteirinha !== undefined) {
        mudancas.cardNumberEnc =
          dados.carteirinha === null ? null : await cifrarCampoDaGuia(this.cipher, tx, ctx, id, 'card_number', dados.carteirinha);
        campos.push('card_number');
      }
      const [g] = await tx
        .update(insuranceGuides)
        .set(mudancas)
        .where(and(eq(insuranceGuides.tenantId, ctx.tenantId), eq(insuranceGuides.id, id)))
        .returning();
      if (!g) throw new NaoEncontradoError();
      // Só os NOMES das colunas alteradas, nunca os valores.
      await recordAudit(tx, ctx, { action: AuditAction.Update, scope: SCOPE_GUIAS, metadata: { guide_id: id, changed: campos.join(',') } });
      return this.detalheDto(tx, ctx.tenantId, g, convenio);
    });
  }

  /** `removerGuia` do front: cancela (nunca apaga); o histórico de consumos fica. Idempotente. */
  cancelarGuia(ctx: RequestContext, id: string): Promise<{ id: string; situacao: 'cancelada' }> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      const atual = await this.travarGuia(tx, ctx, id);
      if (atual.status !== 'cancelled') {
        const agora = new Date();
        await tx
          .update(insuranceGuides)
          .set({ status: 'cancelled', cancelledAt: agora, updatedAt: agora })
          .where(and(eq(insuranceGuides.tenantId, ctx.tenantId), eq(insuranceGuides.id, id)));
        await recordAudit(tx, ctx, { action: AuditAction.Update, scope: SCOPE_GUIAS, metadata: { guide_id: id, changed: 'status' } });
      }
      return { id, situacao: 'cancelada' as const };
    });
  }

  /** Alertas calculados no servidor (CNV-04.5): "vence em X dias", "só resta N", "vencida", "esgotada". */
  alertas(ctx: RequestContext, limiares: Limiares): Promise<{ itens: AlertaDeGuiaDto[]; truncado: boolean }> {
    return lerNaClinica(this.db, ctx, async (tx) => {
      const hoje = hojeNaClinica();
      const limite = somarDias(hoje, limiares.diasVencimento);
      const linhas = await tx
        .select({ guia: insuranceGuides, convenio: insurers.name })
        .from(insuranceGuides)
        .innerJoin(insurers, and(eq(insurers.id, insuranceGuides.insurerId), eq(insurers.tenantId, insuranceGuides.tenantId)))
        .where(
          and(
            eq(insuranceGuides.tenantId, ctx.tenantId),
            eq(insuranceGuides.status, 'active'),
            or(
              lte(insuranceGuides.validUntil, limite),
              lte(sql`${insuranceGuides.authorizedSessions} - ${insuranceGuides.usedSessions}`, limiares.sessoesRestantes),
            ),
          ),
        )
        .orderBy(asc(insuranceGuides.validUntil), asc(insuranceGuides.id))
        .limit(MAXIMO_ALERTAS + 1);
      const itens: AlertaDeGuiaDto[] = [];
      for (const l of linhas.slice(0, MAXIMO_ALERTAS)) {
        const alertas = alertasDe(baseDeSaldo(l.guia), hoje, limiares);
        if (alertas.length === 0) continue;
        itens.push({
          guiaId: l.guia.id,
          pacienteId: l.guia.patientId,
          convenioId: l.guia.insurerId,
          convenio: l.convenio,
          validade: l.guia.validUntil,
          saldo: saldoDe({ total: l.guia.authorizedSessions, usadas: l.guia.usedSessions }),
          alertas,
        });
      }
      await recordAudit(tx, ctx, { action: AuditAction.Read, scope: `${SCOPE_GUIAS}.alerts`, metadata: { count: itens.length } });
      return { itens, truncado: linhas.length > MAXIMO_ALERTAS };
    });
  }

  // ---------------------------------------------------------------- consumo, estorno e assinatura

  /**
   * Consome 1 sessão da guia pelo agendamento (check-in/em atendimento/atendido). Travas: agendamento
   * -> guia (ver consumos.ts). Guia vencida só com override (código do motivo, auditado); saldo
   * nunca negativo (checagem sob trava + CHECK no banco).
   */
  consumir(ctx: RequestContext, guiaId: string, dados: { agendamentoId: string; override?: GuideOverrideReason }): Promise<ResultadoConsumoDto> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      const agendamento = await travarAgendamento(tx, ctx, dados.agendamentoId);
      const guia = await this.travarGuia(tx, ctx, guiaId);
      if (guia.status === 'cancelled') throw new ConflitoError('guia_cancelada');
      if (agendamento.patientId !== guia.patientId) throw new ConflitoError('paciente_diferente');
      if (!statusConsome(agendamento.status)) throw new ConflitoError('agendamento_sem_sessao');
      const ativo = await consumoAtivoDoAgendamento(tx, ctx, agendamento.id);
      if (ativo.guia || ativo.pacote) throw new ConflitoError('sessao_ja_consumida');
      const vencida = estaVencida(guia.validUntil, hojeNaClinica());
      if (vencida && !dados.override) throw new ConflitoError('guia_vencida');
      if (guia.usedSessions >= guia.authorizedSessions) throw new ConflitoError('guia_sem_saldo');

      const agora = new Date();
      const override = vencida ? (dados.override ?? null) : null;
      const [consumo] = await tx
        .insert(guideSessions)
        .values({
          tenantId: ctx.tenantId,
          guideId: guia.id,
          appointmentId: agendamento.id,
          consumedAt: agora,
          consumedBy: ctx.userId,
          overrideReason: override,
        })
        .returning({ id: guideSessions.id });
      const [atualizada] = await tx
        .update(insuranceGuides)
        .set({ usedSessions: sql`${insuranceGuides.usedSessions} + 1`, updatedAt: agora })
        .where(and(eq(insuranceGuides.tenantId, ctx.tenantId), eq(insuranceGuides.id, guia.id)))
        .returning();
      if (!consumo || !atualizada) throw new Error('falha ao consumir guia');
      await recordAudit(tx, ctx, {
        action: AuditAction.Update,
        scope: SCOPE_CONSUMO_GUIA,
        metadata: {
          guide_session_id: consumo.id,
          guide_id: guia.id,
          appointment_id: agendamento.id,
          op: 'consume',
          override: override !== null,
          ...(override ? { reason: override } : {}),
        },
      });
      return this.resultado(consumo.id, atualizada);
    });
  }

  estornar(ctx: RequestContext, guiaId: string, consumoId: string, motivo: GuideReversalReason): Promise<ResultadoConsumoDto> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      const consumo = await this.consumoDaGuia(tx, ctx, guiaId, consumoId);
      // Mesma ordem de travas do consumo: agendamento -> guia; depois relê o consumo travado.
      await travarAgendamento(tx, ctx, consumo.appointmentId);
      await this.travarGuia(tx, ctx, guiaId);
      const [travado] = await tx
        .select()
        .from(guideSessions)
        .where(and(eq(guideSessions.tenantId, ctx.tenantId), eq(guideSessions.id, consumoId)))
        .for('update');
      if (!travado) throw new NaoEncontradoError();
      if (travado.reversedAt) throw new ConflitoError('consumo_ja_estornado');
      const agora = new Date();
      try {
        await tx
          .update(guideSessions)
          .set({ reversedAt: agora, reversedBy: ctx.userId, reversalReason: motivo })
          .where(and(eq(guideSessions.tenantId, ctx.tenantId), eq(guideSessions.id, consumoId)));
      } catch (e) {
        // R20 do #65 (0042): o banco exige perfil ativo em clinic_members para estornar o consumo da guia.
        if (dbErrorCode(e) === '42501') throw new ProibidoError('perfil_nao_registrado');
        throw e;
      }
      const [atualizada] = await tx
        .update(insuranceGuides)
        .set({ usedSessions: sql`${insuranceGuides.usedSessions} - 1`, updatedAt: agora })
        .where(and(eq(insuranceGuides.tenantId, ctx.tenantId), eq(insuranceGuides.id, guiaId)))
        .returning();
      if (!atualizada) throw new NaoEncontradoError();
      await recordAudit(tx, ctx, {
        action: AuditAction.Update,
        scope: SCOPE_CONSUMO_GUIA,
        metadata: { guide_session_id: consumoId, guide_id: guiaId, appointment_id: consumo.appointmentId, op: 'reverse', reason: motivo },
      });
      return this.resultado(consumoId, atualizada);
    });
  }

  /**
   * Confirmação do paciente na sessão (CNV-04.4): registro sem biometria, com meio, dispositivo,
   * instante e hash. Uma por consumo; a tabela é append-only (o banco recusa alterar ou apagar).
   */
  registrarAssinatura(
    ctx: RequestContext,
    guiaId: string,
    consumoId: string,
    dados: { meio: SignatureMethod; dispositivo: string | null },
  ): Promise<{ id: string; assinadaEm: string; hash: string }> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      const consumo = await this.consumoDaGuia(tx, ctx, guiaId, consumoId);
      await travarAgendamento(tx, ctx, consumo.appointmentId);
      if (consumo.reversedAt) throw new ConflitoError('consumo_estornado');
      const [existente] = await tx
        .select({ id: guideSessionSignatures.id })
        .from(guideSessionSignatures)
        .where(and(eq(guideSessionSignatures.tenantId, ctx.tenantId), eq(guideSessionSignatures.guideSessionId, consumoId)));
      if (existente) throw new ConflitoError('sessao_ja_assinada');
      const assinadaEm = new Date();
      const hash = hashDaConfirmacao({
        tenantId: ctx.tenantId,
        consumoId,
        agendamentoId: consumo.appointmentId,
        guiaId,
        meio: dados.meio,
        dispositivo: dados.dispositivo,
        assinadaEm,
        registradoPor: ctx.userId,
      });
      const [s] = await tx
        .insert(guideSessionSignatures)
        .values({
          tenantId: ctx.tenantId,
          guideSessionId: consumoId,
          method: dados.meio,
          deviceLabel: dados.dispositivo,
          signedAt: assinadaEm,
          recordedBy: ctx.userId,
          recordHash: hash,
        })
        .returning({ id: guideSessionSignatures.id });
      if (!s) throw new Error('falha ao registrar assinatura');
      await recordAudit(tx, ctx, {
        action: AuditAction.Sign,
        scope: SCOPE_ASSINATURAS,
        metadata: { signature_id: s.id, guide_session_id: consumoId, guide_id: guiaId, method: dados.meio, hash },
      });
      return { id: s.id, assinadaEm: assinadaEm.toISOString(), hash };
    });
  }

  /** Histórico de consumos da guia, com assinatura e pendência (folha de frequência). */
  consumos(ctx: RequestContext, guiaId: string): Promise<ConsumoGuiaDto[]> {
    return lerNaClinica(this.db, ctx, async (tx) => {
      const [l] = await tx
        .select({ guia: insuranceGuides, exige: insurers.requiresSignature })
        .from(insuranceGuides)
        .innerJoin(insurers, and(eq(insurers.id, insuranceGuides.insurerId), eq(insurers.tenantId, insuranceGuides.tenantId)))
        .where(and(eq(insuranceGuides.tenantId, ctx.tenantId), eq(insuranceGuides.id, guiaId)));
      if (!l) throw new NaoEncontradoError();
      const linhas = await tx
        .select({ c: guideSessions, s: guideSessionSignatures })
        .from(guideSessions)
        .leftJoin(
          guideSessionSignatures,
          and(eq(guideSessionSignatures.guideSessionId, guideSessions.id), eq(guideSessionSignatures.tenantId, guideSessions.tenantId)),
        )
        .where(and(eq(guideSessions.tenantId, ctx.tenantId), eq(guideSessions.guideId, guiaId)))
        .orderBy(asc(guideSessions.consumedAt), asc(guideSessions.id));
      await recordAudit(tx, ctx, {
        action: AuditAction.Read,
        scope: SCOPE_CONSUMO_GUIA,
        metadata: { guide_id: guiaId, patient_id: l.guia.patientId, count: linhas.length },
      });
      return linhas.map(({ c, s }) => ({
        id: c.id,
        guiaId: c.guideId,
        agendamentoId: c.appointmentId,
        consumidoEm: c.consumedAt.toISOString(),
        override: c.overrideReason,
        estornadoEm: c.reversedAt?.toISOString() ?? null,
        motivoEstorno: c.reversalReason,
        assinatura: s ? { meio: s.method, dispositivo: s.deviceLabel, assinadaEm: s.signedAt.toISOString(), hash: s.recordHash } : null,
        assinaturaPendente: l.exige && !s && c.reversedAt === null,
      }));
    });
  }

  // ---------------------------------------------------------------- relatório (CNV-04.6)

  /** Sessões realizadas (consumos não estornados) do convênio na janela, por data do atendimento. */
  relatorio(ctx: RequestContext, convenioId: string, filtro: FiltroRelatorio): Promise<RelatorioConvenioDto> {
    return lerNaClinica(this.db, ctx, async (tx) => {
      const [convenio] = await tx
        .select()
        .from(insurers)
        .where(and(eq(insurers.tenantId, ctx.tenantId), eq(insurers.id, convenioId)));
      if (!convenio) throw new NaoEncontradoError();
      const { inicio, fim } = janelaDeDias(filtro.de, filtro.ate);
      const linhas = await tx
        .select({
          consumoId: guideSessions.id,
          guiaId: insuranceGuides.id,
          numeroEnc: insuranceGuides.numberEnc,
          pacienteId: insuranceGuides.patientId,
          profissionalId: appointments.professionalId,
          agendamentoId: appointments.id,
          inicio: appointments.startsAt,
          override: guideSessions.overrideReason,
          assinatura: guideSessionSignatures.id,
        })
        .from(guideSessions)
        .innerJoin(insuranceGuides, and(eq(insuranceGuides.id, guideSessions.guideId), eq(insuranceGuides.tenantId, guideSessions.tenantId)))
        .innerJoin(appointments, and(eq(appointments.id, guideSessions.appointmentId), eq(appointments.tenantId, guideSessions.tenantId)))
        .leftJoin(
          guideSessionSignatures,
          and(eq(guideSessionSignatures.guideSessionId, guideSessions.id), eq(guideSessionSignatures.tenantId, guideSessions.tenantId)),
        )
        .where(
          and(
            eq(guideSessions.tenantId, ctx.tenantId),
            eq(insuranceGuides.insurerId, convenioId),
            isNull(guideSessions.reversedAt),
            gte(appointments.startsAt, inicio),
            lt(appointments.startsAt, fim),
          ),
        )
        .orderBy(asc(appointments.startsAt), asc(guideSessions.id))
        .limit(MAXIMO_LINHAS_RELATORIO + 1);
      const truncado = linhas.length > MAXIMO_LINHAS_RELATORIO;
      const numeros = new Map<string, string>();
      const sessoes: RelatorioConvenioDto['sessoes'][number][] = [];
      for (const l of linhas.slice(0, MAXIMO_LINHAS_RELATORIO)) {
        let numero = numeros.get(l.guiaId);
        if (numero === undefined) {
          numero = (await decifrarCampoDaGuia(this.cipher, tx, ctx.tenantId, l.guiaId, 'number', l.numeroEnc)) ?? '';
          numeros.set(l.guiaId, numero);
        }
        const { data, hora } = noFusoDaClinica(l.inicio);
        sessoes.push({
          consumoId: l.consumoId,
          guiaId: l.guiaId,
          numeroGuia: numero,
          pacienteId: l.pacienteId,
          profissionalId: l.profissionalId,
          agendamentoId: l.agendamentoId,
          data,
          hora,
          assinada: l.assinatura !== null,
          override: l.override !== null,
        });
      }
      const assinadas = sessoes.filter((s) => s.assinada).length;
      await recordAudit(tx, ctx, {
        action: AuditAction.Read,
        scope: `${SCOPE_CONVENIOS}.report`,
        metadata: { insurer_id: convenioId, count: sessoes.length, days: diasEntre(filtro.de, filtro.ate) + 1 },
      });
      return {
        convenio: {
          id: convenio.id,
          nome: convenio.name,
          valorSessaoCentavos: convenio.sessionValueCents,
          exigeAssinatura: convenio.requiresSignature,
        },
        de: filtro.de,
        ate: filtro.ate,
        sessoes,
        totais: {
          sessoes: sessoes.length,
          assinadas,
          assinaturasPendentes: convenio.requiresSignature ? sessoes.length - assinadas : 0,
          valorCentavos: convenio.sessionValueCents === null ? null : convenio.sessionValueCents * sessoes.length,
        },
        truncado,
      };
    });
  }

  // ---------------------------------------------------------------- apoio

  private resultado(consumoId: string, g: LinhaGuia): ResultadoConsumoDto {
    return {
      consumoId,
      guiaId: g.id,
      sessoesUsadas: g.usedSessions,
      saldo: saldoDe({ total: g.authorizedSessions, usadas: g.usedSessions }),
      situacao: situacaoDe(baseDeSaldo(g), hojeNaClinica()),
    };
  }

  private validadePadrao(convenio: LinhaConvenio, emissao: string | undefined): string {
    if (convenio.defaultValidityDays === null) throw new EntradaInvalidaError(['validade']);
    return somarDias(emissao ?? hojeNaClinica(), convenio.defaultValidityDays);
  }

  private async nomeLivre(tx: TenantTx, ctx: RequestContext, nome: string): Promise<void> {
    const [existe] = await tx
      .select({ id: insurers.id })
      .from(insurers)
      .where(and(eq(insurers.tenantId, ctx.tenantId), sql`lower(${insurers.name}) = lower(${nome})`));
    if (existe) throw new ConflitoError('convenio_duplicado');
  }

  /**
   * Nº de guia duplicado no mesmo convênio é bloqueado (CNV-04.2). O número só existe cifrado, então
   * a comparação decifra as guias não canceladas do convênio (sob a trava do convênio). Índice cego
   * (HMAC por clínica) substitui esta varredura quando o serviço de chaves expuser HMAC.
   */
  private async numeroLivre(tx: TenantTx, ctx: RequestContext, convenioId: string, numero: string): Promise<void> {
    const alvo = normalizarIdentificador(numero);
    const linhas = await tx
      .select({ id: insuranceGuides.id, numero: insuranceGuides.numberEnc })
      .from(insuranceGuides)
      .where(
        and(
          eq(insuranceGuides.tenantId, ctx.tenantId),
          eq(insuranceGuides.insurerId, convenioId),
          ne(insuranceGuides.status, 'cancelled'),
        ),
      );
    for (const l of linhas) {
      const n = await decifrarCampoDaGuia(this.cipher, tx, ctx.tenantId, l.id, 'number', l.numero);
      if (n !== null && normalizarIdentificador(n) === alvo) throw new ConflitoError('guia_duplicada');
    }
  }

  private async travarConvenio(tx: TenantTx, ctx: RequestContext, id: string): Promise<LinhaConvenio> {
    const [c] = await tx
      .select()
      .from(insurers)
      .where(and(eq(insurers.tenantId, ctx.tenantId), eq(insurers.id, id)))
      .for('update');
    if (!c) throw new NaoEncontradoError();
    return c;
  }

  private async travarGuia(tx: TenantTx, ctx: RequestContext, id: string): Promise<LinhaGuia> {
    const [g] = await tx
      .select()
      .from(insuranceGuides)
      .where(and(eq(insuranceGuides.tenantId, ctx.tenantId), eq(insuranceGuides.id, id)))
      .for('update');
    if (!g) throw new NaoEncontradoError();
    return g;
  }

  private async consumoDaGuia(tx: TenantTx, ctx: RequestContext, guiaId: string, consumoId: string) {
    const [c] = await tx
      .select()
      .from(guideSessions)
      .where(and(eq(guideSessions.tenantId, ctx.tenantId), eq(guideSessions.id, consumoId), eq(guideSessions.guideId, guiaId)));
    if (!c) throw new NaoEncontradoError();
    return c;
  }

  private async guiaDto(tx: TenantTx, tenantId: TenantId, g: LinhaGuia, convenio: string, hoje: string): Promise<GuiaDto> {
    const base = baseDeSaldo(g);
    return {
      id: g.id,
      pacienteId: g.patientId,
      convenioId: g.insurerId,
      convenio,
      numero: (await decifrarCampoDaGuia(this.cipher, tx, tenantId, g.id, 'number', g.numberEnc)) ?? '',
      sessoesAutorizadas: g.authorizedSessions,
      sessoesUsadas: g.usedSessions,
      saldo: saldoDe(base),
      emissao: g.issuedOn,
      validade: g.validUntil,
      situacao: situacaoDe(base, hoje),
      alertas: alertasDe(base, hoje, LIMIARES_GUIA),
    };
  }

  private async detalheDto(tx: TenantTx, tenantId: TenantId, g: LinhaGuia, convenio: LinhaConvenio): Promise<GuiaDetalheDto> {
    return {
      ...(await this.guiaDto(tx, tenantId, g, convenio.name, hojeNaClinica())),
      senha: await decifrarCampoDaGuia(this.cipher, tx, tenantId, g.id, 'authorization_code', g.authorizationCodeEnc),
      carteirinha: await decifrarCampoDaGuia(this.cipher, tx, tenantId, g.id, 'card_number', g.cardNumberEnc),
      exigeAssinatura: convenio.requiresSignature,
    };
  }
}
