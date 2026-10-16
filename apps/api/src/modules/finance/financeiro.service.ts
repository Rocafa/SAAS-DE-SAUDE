import { Inject, Injectable } from '@nestjs/common';
import { AuditAction, type RequestContext } from '@plataforma/shared';
import { and, asc, eq, gte, inArray, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { ConflitoError, NaoEncontradoError } from '../../common/erros-dominio';
import { escreverNaClinica, lerNaClinica } from '../../common/transacao-clinica';
import { EntradaInvalidaError } from '../../common/validacao';
import {
  appointments,
  charges,
  financeSettings,
  packageSessions,
  patients,
  paymentReversals,
  payments,
  professionalFiscalProfiles,
  professionals,
  receiptCancellations,
  sessionPackages,
  type AttendanceKind,
  type ChargeCancelReason,
  type PaymentMethod,
  type PaymentReversalReason,
} from '../../db/schema';
import type { TenantTx } from '../../db/tenant-transaction';
import { recordAudit } from '../audit/audit-log';
import { FIELD_CIPHER } from '../crypto/crypto.module';
import type { FieldCipher } from '../crypto/field-cipher';
import { travarAgendamento } from '../insurance/consumos';
import { hojeNaClinica } from '../insurance/guias-regras';
import { noFusoDaClinica } from '../scheduling/agenda-regras';
import { TenantDatabase } from '../tenancy/tenancy.module';
import { CAMPO_CPF_PAGADOR, CAMPO_CPF_PROFISSIONAL, cifrarCampoFinanceiro } from './finance-fields';
import {
  caixaAbertoPara,
  carregarConfig,
  reciboVivoDoRecebimento,
  SCOPE_CANCELAMENTO_RECIBO,
  SCOPE_COBRANCAS,
  SCOPE_CONFIG,
  SCOPE_ESTORNOS,
  SCOPE_PERFIL_FISCAL,
  SCOPE_RECEBIMENTOS,
  travarCobranca,
  type ConfigFinanceira,
  type LinhaCobranca,
} from './financeiro-comum';
import { AVISO_DESCRICAO_RECIBO, avisoDoRecebimento, situacaoDaCobranca, type SituacaoCobranca } from './financeiro-regras';
import {
  MAXIMO_LINHAS_FINANCEIRO,
  type ConfiguracaoFinanceiro,
  type FiltroContasAReceber,
  type NovaCobranca,
  type NovoRecebimento,
  type PerfilFiscal,
} from './financeiro.validation';

export interface ConfiguracaoDto {
  readonly descricaoRecibo: string;
  readonly atendimentoPadrao: AttendanceKind;
  readonly emitenteNome: string | null;
  readonly emitenteCnpj: string | null;
  readonly mostrarRegistroConselho: boolean;
  /** R4 do #65: aviso fixo para a tela (o texto vai para empregador, plano e Receita). */
  readonly avisoDescricao: string;
}

/**
 * Cobrança (conta a receber). Sem conteúdo clínico: nem tipo de atendimento, nem especialidade, nem
 * procedimento; `descricao` é o texto NEUTRO configurado pela clínica. CPF do pagador nunca volta aqui.
 */
export interface CobrancaDto {
  readonly id: string;
  readonly pacienteId: string;
  readonly paciente: string;
  readonly agendamentoId: string | null;
  readonly pacoteId: string | null;
  readonly profissionalId: string | null;
  readonly atendimentoPor: AttendanceKind;
  readonly descricao: string;
  readonly valorCentavos: number;
  readonly recebidoCentavos: number;
  readonly saldoCentavos: number;
  readonly vencimento: string;
  readonly situacao: SituacaoCobranca;
  readonly pagador: { readonly nome: string } | null;
  readonly criadaEm: string;
}

export interface RecebimentoDto {
  readonly id: string;
  readonly cobrancaId: string;
  readonly agendamentoId: string | null;
  readonly pacienteId: string;
  readonly caixaId: string;
  readonly forma: PaymentMethod;
  readonly valorCentavos: number;
  readonly recebidoEm: string;
  /** Dia do pagamento no fuso da clínica (contrato `Recibo.data` do front). */
  readonly data: string;
  readonly estornado: boolean;
  /** R8 do #65: aviso para a tela (Pix manual/transferência: não descrever o atendimento na mensagem). */
  readonly aviso: string | null;
  readonly cobranca: { readonly situacao: SituacaoCobranca; readonly saldoCentavos: number };
}

function cobrancaDto(c: LinhaCobranca, paciente: string, config: ConfigFinanceira): CobrancaDto {
  return {
    id: c.id,
    pacienteId: c.patientId,
    paciente,
    agendamentoId: c.appointmentId,
    pacoteId: c.packageId,
    profissionalId: c.professionalId,
    atendimentoPor: c.attendanceKind,
    descricao: config.descricao,
    valorCentavos: c.amountCents,
    recebidoCentavos: c.paidCents,
    saldoCentavos: c.status === 'cancelled' ? 0 : c.amountCents - c.paidCents,
    vencimento: c.dueDate,
    situacao: situacaoDaCobranca(c),
    pagador: c.payerName ? { nome: c.payerName } : null,
    criadaEm: c.createdAt.toISOString(),
  };
}

function configDto(c: ConfigFinanceira): ConfiguracaoDto {
  return {
    descricaoRecibo: c.descricao,
    atendimentoPadrao: c.atendimentoPadrao,
    emitenteNome: c.emitenteNome,
    emitenteCnpj: c.emitenteCnpj,
    mostrarRegistroConselho: c.mostrarRegistroConselho,
    avisoDescricao: AVISO_DESCRICAO_RECIBO,
  };
}

/**
 * Financeiro do MVP (FIN-01.1/01.3/01.8): configuração, perfil fiscal do profissional PF, cobranças,
 * contas a receber, recebimentos e estornos. Pix é registrado à mão (D5 pendente). Nada se apaga:
 * cobrança se cancela (só sem recebimento), recebimento se estorna (linha própria, no caixa aberto) e
 * o recibo vivo do recebimento estornado é cancelado na mesma transação. Auditoria só com ids, códigos
 * e contagens: nunca valor, nome, CPF ou texto.
 */
@Injectable()
export class FinanceiroService {
  constructor(
    @Inject(TenantDatabase) private readonly db: TenantDatabase,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher<TenantTx>,
  ) {}

  // ---------------------------------------------------------------- configuração

  obterConfiguracao(ctx: RequestContext): Promise<ConfiguracaoDto> {
    return lerNaClinica(this.db, ctx, async (tx) => {
      const c = await carregarConfig(tx, ctx);
      await recordAudit(tx, ctx, { action: AuditAction.Read, scope: SCOPE_CONFIG });
      return configDto(c);
    });
  }

  alterarConfiguracao(ctx: RequestContext, dados: ConfiguracaoFinanceiro): Promise<ConfiguracaoDto> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      const atual = await carregarConfig(tx, ctx);
      const nova: ConfigFinanceira = {
        descricao: dados.descricaoRecibo ?? atual.descricao,
        atendimentoPadrao: dados.atendimentoPadrao ?? atual.atendimentoPadrao,
        emitenteNome: dados.emitenteNome !== undefined ? dados.emitenteNome : atual.emitenteNome,
        emitenteCnpj: dados.emitenteCnpj !== undefined ? dados.emitenteCnpj : atual.emitenteCnpj,
        mostrarRegistroConselho: dados.mostrarRegistroConselho ?? atual.mostrarRegistroConselho,
      };
      const valores = {
        receiptDescription: nova.descricao,
        defaultAttendanceKind: nova.atendimentoPadrao,
        issuerName: nova.emitenteNome,
        issuerCnpj: nova.emitenteCnpj,
        showCouncilOnReceipt: nova.mostrarRegistroConselho,
        updatedAt: new Date(),
        updatedBy: ctx.userId,
      };
      await tx
        .insert(financeSettings)
        .values({ tenantId: ctx.tenantId, ...valores })
        .onConflictDoUpdate({ target: financeSettings.tenantId, set: valores });
      // Só QUAIS campos mudaram (nunca o texto, o nome ou o CNPJ).
      await recordAudit(tx, ctx, {
        action: AuditAction.Update,
        scope: SCOPE_CONFIG,
        metadata: {
          description: nova.descricao !== atual.descricao,
          default_kind: nova.atendimentoPadrao,
          issuer: nova.emitenteNome !== atual.emitenteNome || nova.emitenteCnpj !== atual.emitenteCnpj,
          show_council: nova.mostrarRegistroConselho,
        },
      });
      return configDto(nova);
    });
  }

  // ---------------------------------------------------------------- perfil fiscal do profissional PF

  obterPerfilFiscal(ctx: RequestContext, profissionalId: string): Promise<{ profissionalId: string; temCpf: boolean; registroConselho: string | null }> {
    return lerNaClinica(this.db, ctx, async (tx) => {
      await this.exigirProfissional(tx, ctx, profissionalId);
      const [p] = await tx
        .select()
        .from(professionalFiscalProfiles)
        .where(and(eq(professionalFiscalProfiles.tenantId, ctx.tenantId), eq(professionalFiscalProfiles.professionalId, profissionalId)));
      await recordAudit(tx, ctx, { action: AuditAction.Read, scope: SCOPE_PERFIL_FISCAL, metadata: { professional_id: profissionalId } });
      return { profissionalId, temCpf: Boolean(p?.cpfEnc), registroConselho: p?.councilRegistration ?? null };
    });
  }

  alterarPerfilFiscal(
    ctx: RequestContext,
    profissionalId: string,
    dados: PerfilFiscal,
  ): Promise<{ profissionalId: string; temCpf: boolean; registroConselho: string | null }> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      await this.exigirProfissional(tx, ctx, profissionalId);
      const [atual] = await tx
        .select()
        .from(professionalFiscalProfiles)
        .where(and(eq(professionalFiscalProfiles.tenantId, ctx.tenantId), eq(professionalFiscalProfiles.professionalId, profissionalId)));
      let cpfEnc = atual?.cpfEnc ?? null;
      if (dados.cpf !== undefined) {
        cpfEnc = dados.cpf === null ? null : await cifrarCampoFinanceiro(this.cipher, tx, ctx, profissionalId, CAMPO_CPF_PROFISSIONAL, dados.cpf);
      }
      const registro = dados.registroConselho !== undefined ? dados.registroConselho : (atual?.councilRegistration ?? null);
      const valores = { cpfEnc, councilRegistration: registro, updatedAt: new Date(), updatedBy: ctx.userId };
      await tx
        .insert(professionalFiscalProfiles)
        .values({ tenantId: ctx.tenantId, professionalId: profissionalId, ...valores })
        .onConflictDoUpdate({ target: [professionalFiscalProfiles.tenantId, professionalFiscalProfiles.professionalId], set: valores });
      await recordAudit(tx, ctx, {
        action: atual ? AuditAction.Update : AuditAction.Create,
        scope: SCOPE_PERFIL_FISCAL,
        metadata: { professional_id: profissionalId, cpf_changed: dados.cpf !== undefined, council_changed: dados.registroConselho !== undefined },
      });
      return { profissionalId, temCpf: cpfEnc !== null, registroConselho: registro };
    });
  }

  // ---------------------------------------------------------------- cobranças

  /**
   * Lança a cobrança de UM atendimento (agendamento) ou de UM pacote (FIN-01.8). O paciente vem do
   * alvo; o profissional, do agendamento (no pacote, do corpo). Sessão que consumiu pacote não gera
   * cobrança avulsa (409 `sessao_de_pacote`): o pacote já é cobrado inteiro.
   */
  lancarCobranca(ctx: RequestContext, dados: NovaCobranca): Promise<CobrancaDto> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      const config = await carregarConfig(tx, ctx);
      let pacienteId: string;
      let profissionalId: string | null = dados.profissionalId ?? null;
      let vencimentoPadrao = hojeNaClinica();
      if (dados.agendamentoId) {
        const a = await travarAgendamento(tx, ctx, dados.agendamentoId);
        if (a.status === 'cancelled') throw new ConflitoError('agendamento_cancelado');
        if (profissionalId && profissionalId !== a.professionalId) throw new ConflitoError('profissional_diferente');
        const [consumo] = await tx
          .select({ id: packageSessions.id })
          .from(packageSessions)
          .where(
            and(
              eq(packageSessions.tenantId, ctx.tenantId),
              eq(packageSessions.appointmentId, a.id),
              isNull(packageSessions.reversedAt),
            ),
          );
        if (consumo) throw new ConflitoError('sessao_de_pacote');
        pacienteId = a.patientId;
        profissionalId = a.professionalId;
        vencimentoPadrao = noFusoDaClinica(a.startsAt).data;
      } else {
        const [p] = await tx
          .select()
          .from(sessionPackages)
          .where(and(eq(sessionPackages.tenantId, ctx.tenantId), eq(sessionPackages.id, dados.pacoteId as string)))
          .for('update');
        if (!p) throw new NaoEncontradoError();
        if (p.status === 'cancelled') throw new ConflitoError('pacote_cancelado');
        pacienteId = p.patientId;
        // R13 do #65: com profissional fixado na venda, a cobrança é dele (padrão quando o corpo não diz).
        if (p.professionalId) {
          if (profissionalId && profissionalId !== p.professionalId) throw new ConflitoError('profissional_nao_e_do_pacote');
          profissionalId = p.professionalId;
        }
        if (profissionalId) await this.exigirProfissional(tx, ctx, profissionalId);
      }
      const tipo = dados.atendimentoPor ?? config.atendimentoPadrao;
      // Atendimento PF (Receita Saúde) exige o profissional emitente.
      if (tipo === 'pf' && !profissionalId) throw new EntradaInvalidaError(['profissionalId']);
      if (tipo === 'pf' && profissionalId) await this.exigirEmitentePf(tx, ctx, profissionalId, dados.pacoteId ?? null);

      const alvo = dados.agendamentoId
        ? eq(charges.appointmentId, dados.agendamentoId)
        : eq(charges.packageId, dados.pacoteId as string);
      const [viva] = await tx
        .select({ id: charges.id })
        .from(charges)
        .where(and(eq(charges.tenantId, ctx.tenantId), alvo, eq(charges.status, 'open')));
      if (viva) throw new ConflitoError('cobranca_ja_lancada');

      const id = randomUUID();
      const payerCpfEnc = dados.pagador?.cpf
        ? await cifrarCampoFinanceiro(this.cipher, tx, ctx, id, CAMPO_CPF_PAGADOR, dados.pagador.cpf)
        : null;
      const [c] = await tx
        .insert(charges)
        .values({
          id,
          tenantId: ctx.tenantId,
          patientId: pacienteId,
          appointmentId: dados.agendamentoId ?? null,
          packageId: dados.pacoteId ?? null,
          professionalId: profissionalId,
          attendanceKind: tipo,
          amountCents: dados.valorCentavos,
          dueDate: dados.vencimento ?? vencimentoPadrao,
          payerName: dados.pagador?.nome ?? null,
          payerCpfEnc,
          createdBy: ctx.userId,
        })
        .returning();
      if (!c) throw new Error('falha ao lançar cobrança');
      await recordAudit(tx, ctx, {
        action: AuditAction.Create,
        scope: SCOPE_COBRANCAS,
        metadata: {
          charge_id: c.id,
          patient_id: c.patientId,
          target: c.appointmentId ? 'appointment' : 'package',
          target_id: c.appointmentId ?? c.packageId,
          kind: c.attendanceKind,
          third_party_payer: c.payerName !== null,
        },
      });
      return cobrancaDto(c, await this.nomeDoPaciente(tx, ctx, c.patientId), config);
    });
  }

  obterCobranca(ctx: RequestContext, id: string): Promise<CobrancaDto & { recebimentos: RecebimentoDto[] }> {
    return lerNaClinica(this.db, ctx, async (tx) => {
      const [c] = await tx.select().from(charges).where(and(eq(charges.tenantId, ctx.tenantId), eq(charges.id, id)));
      if (!c) throw new NaoEncontradoError();
      const config = await carregarConfig(tx, ctx);
      const recebimentos = await this.recebimentosDe(tx, ctx, c);
      await recordAudit(tx, ctx, {
        action: AuditAction.Read,
        scope: SCOPE_COBRANCAS,
        metadata: { charge_id: id, patient_id: c.patientId, count: recebimentos.length },
      });
      return { ...cobrancaDto(c, await this.nomeDoPaciente(tx, ctx, c.patientId), config), recebimentos };
    });
  }

  /** Só sem recebimento vivo (estorne antes): cobrança paga não some. Nunca apaga. */
  cancelarCobranca(ctx: RequestContext, id: string, motivo: ChargeCancelReason): Promise<CobrancaDto> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      const atual = await travarCobranca(tx, ctx, id);
      if (atual.status === 'cancelled') throw new ConflitoError('cobranca_cancelada');
      if (atual.paidCents > 0) throw new ConflitoError('cobranca_com_recebimento');
      const agora = new Date();
      const [c] = await tx
        .update(charges)
        .set({ status: 'cancelled', cancelledAt: agora, cancelledBy: ctx.userId, cancelReason: motivo, updatedAt: agora })
        .where(and(eq(charges.tenantId, ctx.tenantId), eq(charges.id, id)))
        .returning();
      if (!c) throw new NaoEncontradoError();
      await recordAudit(tx, ctx, {
        action: AuditAction.Update,
        scope: SCOPE_COBRANCAS,
        metadata: { charge_id: id, patient_id: c.patientId, op: 'cancel', reason: motivo },
      });
      return cobrancaDto(c, await this.nomeDoPaciente(tx, ctx, c.patientId), await carregarConfig(tx, ctx));
    });
  }

  /** Contas a receber por vencimento (janela ≤ 31 dias), com totais. */
  contasAReceber(
    ctx: RequestContext,
    filtro: FiltroContasAReceber,
  ): Promise<{ itens: CobrancaDto[]; totais: { valorCentavos: number; recebidoCentavos: number; saldoCentavos: number }; truncado: boolean }> {
    return lerNaClinica(this.db, ctx, async (tx) => {
      const condicoes: SQL[] = [eq(charges.tenantId, ctx.tenantId), gte(charges.dueDate, filtro.de), lte(charges.dueDate, filtro.ate)];
      if (filtro.pacienteId) condicoes.push(eq(charges.patientId, filtro.pacienteId));
      if (filtro.profissionalId) condicoes.push(eq(charges.professionalId, filtro.profissionalId));
      if (filtro.situacao === 'em_aberto') condicoes.push(eq(charges.status, 'open'), sql`${charges.paidCents} < ${charges.amountCents}`);
      if (filtro.situacao === 'pagas') condicoes.push(eq(charges.status, 'open'), sql`${charges.paidCents} = ${charges.amountCents}`);
      if (filtro.situacao === 'canceladas') condicoes.push(eq(charges.status, 'cancelled'));
      const linhas = await tx
        .select({ c: charges, paciente: patients.displayName })
        .from(charges)
        .innerJoin(patients, and(eq(patients.tenantId, charges.tenantId), eq(patients.id, charges.patientId)))
        .where(and(...condicoes))
        .orderBy(asc(charges.dueDate), asc(charges.createdAt), asc(charges.id))
        .limit(MAXIMO_LINHAS_FINANCEIRO + 1);
      const config = await carregarConfig(tx, ctx);
      const itens = linhas.slice(0, MAXIMO_LINHAS_FINANCEIRO).map((l) => cobrancaDto(l.c, l.paciente, config));
      const totais = itens.reduce(
        (t, i) => ({
          valorCentavos: t.valorCentavos + (i.situacao === 'cancelada' ? 0 : i.valorCentavos),
          recebidoCentavos: t.recebidoCentavos + i.recebidoCentavos,
          saldoCentavos: t.saldoCentavos + i.saldoCentavos,
        }),
        { valorCentavos: 0, recebidoCentavos: 0, saldoCentavos: 0 },
      );
      await recordAudit(tx, ctx, {
        action: AuditAction.Read,
        scope: SCOPE_COBRANCAS,
        metadata: { op: 'receivables', count: itens.length, filter: filtro.situacao, ...(filtro.pacienteId ? { patient_id: filtro.pacienteId } : {}) },
      });
      return { itens, totais, truncado: linhas.length > MAXIMO_LINHAS_FINANCEIRO };
    });
  }

  // ---------------------------------------------------------------- recebimento e estorno

  /** Recebe (no todo ou em parte) num caixa ABERTO. Sem `valorCentavos`, recebe o saldo. */
  receber(ctx: RequestContext, cobrancaId: string, dados: NovoRecebimento): Promise<RecebimentoDto> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      const c = await travarCobranca(tx, ctx, cobrancaId);
      if (c.status === 'cancelled') throw new ConflitoError('cobranca_cancelada');
      const saldo = c.amountCents - c.paidCents;
      if (saldo <= 0) throw new ConflitoError('cobranca_quitada');
      const valor = dados.valorCentavos ?? saldo;
      if (valor > saldo) throw new ConflitoError('valor_acima_do_saldo');
      const caixaId = await caixaAbertoPara(tx, ctx, dados.caixaId);
      const agora = new Date();
      const [p] = await tx
        .insert(payments)
        .values({
          tenantId: ctx.tenantId,
          chargeId: c.id,
          cashSessionId: caixaId,
          method: dados.forma,
          amountCents: valor,
          receivedAt: agora,
          receivedBy: ctx.userId,
        })
        .returning();
      const [atualizada] = await tx
        .update(charges)
        .set({ paidCents: sql`${charges.paidCents} + ${valor}`, updatedAt: agora })
        .where(and(eq(charges.tenantId, ctx.tenantId), eq(charges.id, c.id)))
        .returning();
      if (!p || !atualizada) throw new Error('falha ao receber');
      await recordAudit(tx, ctx, {
        action: AuditAction.Create,
        scope: SCOPE_RECEBIMENTOS,
        metadata: { payment_id: p.id, charge_id: c.id, patient_id: c.patientId, cash_session_id: caixaId, method: dados.forma, partial: valor < saldo },
      });
      return this.recebimentoDto(p, atualizada, false);
    });
  }

  /**
   * Estorno TOTAL do recebimento, registrado no caixa aberto de agora (o dinheiro sai da gaveta de
   * hoje). Devolve o valor ao saldo da cobrança e cancela o recibo vivo, na mesma transação.
   */
  estornar(
    ctx: RequestContext,
    recebimentoId: string,
    dados: { motivo: PaymentReversalReason; caixaId?: string },
  ): Promise<RecebimentoDto & { reciboCancelado: string | null }> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      const [p0] = await tx
        .select()
        .from(payments)
        .where(and(eq(payments.tenantId, ctx.tenantId), eq(payments.id, recebimentoId)));
      if (!p0) throw new NaoEncontradoError();
      const c = await travarCobranca(tx, ctx, p0.chargeId);
      const [ja] = await tx
        .select({ id: paymentReversals.id })
        .from(paymentReversals)
        .where(and(eq(paymentReversals.tenantId, ctx.tenantId), eq(paymentReversals.paymentId, recebimentoId)));
      if (ja) throw new ConflitoError('recebimento_ja_estornado');
      const caixaId = await caixaAbertoPara(tx, ctx, dados.caixaId);
      const agora = new Date();
      const [e] = await tx
        .insert(paymentReversals)
        .values({ tenantId: ctx.tenantId, paymentId: recebimentoId, cashSessionId: caixaId, reason: dados.motivo, reversedAt: agora, reversedBy: ctx.userId })
        .returning({ id: paymentReversals.id });
      const [atualizada] = await tx
        .update(charges)
        .set({ paidCents: sql`${charges.paidCents} - ${p0.amountCents}`, updatedAt: agora })
        .where(and(eq(charges.tenantId, ctx.tenantId), eq(charges.id, c.id)))
        .returning();
      if (!e || !atualizada) throw new Error('falha ao estornar');
      const recibo = await reciboVivoDoRecebimento(tx, ctx, recebimentoId);
      if (recibo) {
        await tx.insert(receiptCancellations).values({
          tenantId: ctx.tenantId,
          receiptId: recibo.id,
          reason: 'recebimento_estornado',
          cancelledAt: agora,
          cancelledBy: ctx.userId,
        });
        await recordAudit(tx, ctx, {
          action: AuditAction.Update,
          scope: SCOPE_CANCELAMENTO_RECIBO,
          metadata: { receipt_id: recibo.id, payment_id: recebimentoId, op: 'cancel', reason: 'recebimento_estornado' },
        });
      }
      await recordAudit(tx, ctx, {
        action: AuditAction.Create,
        scope: SCOPE_ESTORNOS,
        metadata: { reversal_id: e.id, payment_id: recebimentoId, charge_id: c.id, cash_session_id: caixaId, method: p0.method, reason: dados.motivo },
      });
      return { ...this.recebimentoDto(p0, atualizada, true), reciboCancelado: recibo?.id ?? null };
    });
  }

  // ---------------------------------------------------------------- apoio

  private recebimentoDto(p: typeof payments.$inferSelect, c: LinhaCobranca, estornado: boolean): RecebimentoDto {
    return {
      id: p.id,
      cobrancaId: c.id,
      agendamentoId: c.appointmentId,
      pacienteId: c.patientId,
      caixaId: p.cashSessionId,
      forma: p.method,
      valorCentavos: p.amountCents,
      recebidoEm: p.receivedAt.toISOString(),
      data: noFusoDaClinica(p.receivedAt).data,
      estornado,
      aviso: avisoDoRecebimento(p.method),
      cobranca: { situacao: situacaoDaCobranca(c), saldoCentavos: c.status === 'cancelled' ? 0 : c.amountCents - c.paidCents },
    };
  }

  private async recebimentosDe(tx: TenantTx, ctx: RequestContext, c: LinhaCobranca): Promise<RecebimentoDto[]> {
    const linhas = await tx
      .select()
      .from(payments)
      .where(and(eq(payments.tenantId, ctx.tenantId), eq(payments.chargeId, c.id)))
      .orderBy(asc(payments.receivedAt), asc(payments.id));
    const estornados = linhas.length
      ? await tx
          .select({ paymentId: paymentReversals.paymentId })
          .from(paymentReversals)
          .where(and(eq(paymentReversals.tenantId, ctx.tenantId), inArray(paymentReversals.paymentId, linhas.map((l) => l.id))))
      : [];
    const setEstornados = new Set(estornados.map((e) => e.paymentId));
    return linhas.map((p) => this.recebimentoDto(p, c, setEstornados.has(p.id)));
  }

  private async nomeDoPaciente(tx: TenantTx, ctx: RequestContext, pacienteId: string): Promise<string> {
    const [p] = await tx
      .select({ nome: patients.displayName })
      .from(patients)
      .where(and(eq(patients.tenantId, ctx.tenantId), eq(patients.id, pacienteId)));
    return p?.nome ?? '';
  }

  /**
   * R1 do #65: o recibo PF leva o CPF do profissional e entra no Receita Saúde DELE, então ninguém o
   * lança em nome de um profissional arbitrário. Exige perfil fiscal com CPF (409
   * `profissional_sem_perfil_fiscal`). No pacote (que não tem profissional): ou todas as sessões já
   * consumidas (≥1) são dele, ou quem lança é o próprio profissional (409 `profissional_nao_e_do_pacote`).
   * O agendamento já fixa o profissional. O banco confere o mesmo (trigger da 0021).
   */
  private async exigirEmitentePf(tx: TenantTx, ctx: RequestContext, profissionalId: string, pacoteId: string | null): Promise<void> {
    const [perfil] = await tx
      .select({ cpf: professionalFiscalProfiles.cpfEnc })
      .from(professionalFiscalProfiles)
      .where(and(eq(professionalFiscalProfiles.tenantId, ctx.tenantId), eq(professionalFiscalProfiles.professionalId, profissionalId)));
    if (!perfil?.cpf) throw new ConflitoError('profissional_sem_perfil_fiscal');
    if (!pacoteId) return;
    // R14 do #65: a cobrança PF do pacote tem UM emitente e só cobre sessões dele. Sessão viva de outro
    // profissional (fixado ou não) é 409 `pacote_com_sessoes_de_outro_profissional`: estorne as sessões
    // do outro profissional ou cobre o pacote como PJ. O banco confere o mesmo (0025).
    const sessoes = await tx
      .select({ profissional: appointments.professionalId })
      .from(packageSessions)
      .innerJoin(appointments, and(eq(appointments.tenantId, packageSessions.tenantId), eq(appointments.id, packageSessions.appointmentId)))
      .where(and(eq(packageSessions.tenantId, ctx.tenantId), eq(packageSessions.packageId, pacoteId), isNull(packageSessions.reversedAt)));
    if (sessoes.some((s) => s.profissional !== profissionalId)) throw new ConflitoError('pacote_com_sessoes_de_outro_profissional');
    // R13 do #65: profissional fixado na venda (já conferido acima): a PF sai na venda, sem esperar sessão.
    const [pacote] = await tx
      .select({ fixado: sessionPackages.professionalId })
      .from(sessionPackages)
      .where(and(eq(sessionPackages.tenantId, ctx.tenantId), eq(sessionPackages.id, pacoteId)));
    if (pacote?.fixado) {
      if (pacote.fixado !== profissionalId) throw new ConflitoError('profissional_nao_e_do_pacote');
      return;
    }
    const [prof] = await tx
      .select({ userId: professionals.userId })
      .from(professionals)
      .where(and(eq(professionals.tenantId, ctx.tenantId), eq(professionals.id, profissionalId)));
    if (prof?.userId === ctx.userId) return;
    if (sessoes.length === 0) throw new ConflitoError('profissional_nao_e_do_pacote');
  }

  private async exigirProfissional(tx: TenantTx, ctx: RequestContext, profissionalId: string): Promise<void> {
    const [p] = await tx
      .select({ id: professionals.id })
      .from(professionals)
      .where(and(eq(professionals.tenantId, ctx.tenantId), eq(professionals.id, profissionalId)));
    if (!p) throw new NaoEncontradoError();
  }
}
