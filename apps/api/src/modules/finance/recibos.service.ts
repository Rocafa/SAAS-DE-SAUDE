import { Inject, Injectable } from '@nestjs/common';
import { AuditAction, type RequestContext } from '@plataforma/shared';
import { and, asc, eq, gte, inArray, isNull, lt, ne, sql, type SQL } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { ConflitoError, NaoEncontradoError } from '../../common/erros-dominio';
import { escreverNaClinica, lerNaClinica } from '../../common/transacao-clinica';
import {
  charges,
  patients,
  paymentReversals,
  payments,
  professionalFiscalProfiles,
  professionals,
  receiptCancellations,
  receiptCounters,
  receipts,
  tenants,
  type PaymentMethod,
  type ReceiptCancelReason,
} from '../../db/schema';
import type { TenantTx } from '../../db/tenant-transaction';
import { recordAudit } from '../audit/audit-log';
import { FIELD_CIPHER } from '../crypto/crypto.module';
import type { FieldCipher } from '../crypto/field-cipher';
import { diasEntre } from '../insurance/guias-regras';
import { patientFieldRef } from '../patients/patient-fields';
import { janelaDeDias, noFusoDaClinica } from '../scheduling/agenda-regras';
import { TenantDatabase } from '../tenancy/tenancy.module';
import { CAMPO_CPF_PAGADOR, CAMPO_CPF_PROFISSIONAL, CAMPO_RECIBO, cifrarCampoFinanceiro, decifrarCampoFinanceiro } from './finance-fields';
import {
  carregarConfig,
  reciboVivoDoRecebimento,
  SCOPE_CANCELAMENTO_RECIBO,
  SCOPE_RECEITA_SAUDE,
  SCOPE_RECIBOS,
  travarCobranca,
  type LinhaCobranca,
} from './financeiro-comum';
import {
  formaGeraRecibo,
  INSUMO_RECEITA_SAUDE,
  pendenciasDoItem,
  pendenciasDoRecibo,
  type ConteudoDoRecibo,
  type EmitenteDoRecibo,
  type ItemReceitaSaude,
  type PessoaDoRecibo,
} from './financeiro-regras';
import { MAXIMO_LINHAS_FINANCEIRO } from './financeiro.validation';

/** Recibo estruturado (JSON; o PDF fica para depois). CPF inteiro só aqui: é exigido para o IR. */
export interface ReciboDto extends ConteudoDoRecibo {
  readonly id: string;
  readonly numero: number;
  readonly recebimentoId: string;
  readonly emitidoEm: string;
  readonly situacao: 'emitido' | 'cancelado';
  readonly cancelamento: { readonly motivo: ReceiptCancelReason; readonly em: string } | null;
}

/** Item de lista: sem CPF e sem nome (a lista é para conferência; o detalhe abre o recibo). */
export interface ReciboResumoDto {
  readonly id: string;
  readonly numero: number;
  readonly recebimentoId: string;
  readonly cobrancaId: string;
  readonly pacienteId: string;
  readonly valorCentavos: number;
  readonly forma: PaymentMethod;
  readonly emitidoEm: string;
  readonly situacao: 'emitido' | 'cancelado';
}

export interface LoteReceitaSaudeDto {
  readonly formato: typeof INSUMO_RECEITA_SAUDE.formato;
  readonly versao: typeof INSUMO_RECEITA_SAUDE.versao;
  readonly oficial: false;
  readonly dependeDe: readonly string[];
  readonly lacuna: string;
  readonly geradoEm: string;
  readonly periodo: { readonly de: string; readonly ate: string };
  readonly emitente: { readonly profissionalId: string; readonly nome: string; readonly cpf: string | null; readonly registroConselho: string | null };
  readonly itens: readonly ItemReceitaSaude[];
  readonly totais: { readonly quantidade: number; readonly valorCentavos: number };
  readonly pendencias: readonly string[];
  readonly truncado: boolean;
}

/**
 * Recibos (FIN-01.4 / HU-FIN-003) e insumo do Receita Saúde (D14).
 *
 * Numeração por clínica SEM BURACO: o número sai do contador (`receipt_counters`, UPDATE na linha da
 * clínica) na MESMA transação do INSERT do recibo; emissões simultâneas esperam a linha do contador e
 * um rollback devolve o número. O banco confere que o recibo entra com o número recém-entregue.
 * Imutável: o conteúdo é um retrato cifrado do momento da emissão (runtime sem UPDATE; trigger recusa
 * para qualquer papel); cancelar grava `receipt_cancellations`. Texto NEUTRO por padrão: o recibo
 * nunca leva diagnóstico, especialidade ou procedimento; o registro no conselho só se a clínica pedir.
 */
@Injectable()
export class RecibosService {
  constructor(
    @Inject(TenantDatabase) private readonly db: TenantDatabase,
    @Inject(FIELD_CIPHER) private readonly cipher: FieldCipher<TenantTx>,
  ) {}

  /** Emite o recibo do recebimento. Idempotente: se já há recibo vivo, devolve o mesmo. */
  emitir(ctx: RequestContext, recebimentoId: string): Promise<ReciboDto> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      const [p] = await tx.select().from(payments).where(and(eq(payments.tenantId, ctx.tenantId), eq(payments.id, recebimentoId)));
      if (!p) throw new NaoEncontradoError();
      const c = await travarCobranca(tx, ctx, p.chargeId);
      const [estorno] = await tx
        .select({ id: paymentReversals.id })
        .from(paymentReversals)
        .where(and(eq(paymentReversals.tenantId, ctx.tenantId), eq(paymentReversals.paymentId, recebimentoId)));
      if (estorno) throw new ConflitoError('recebimento_estornado');
      if (!formaGeraRecibo(p.method)) throw new ConflitoError('recebimento_de_convenio');
      const vivo = await reciboVivoDoRecebimento(tx, ctx, recebimentoId);
      if (vivo) return this.lerRecibo(tx, ctx, vivo.id);

      const conteudo = await this.retrato(tx, ctx, c, p);
      // Contador: INSERT na primeira emissão, UPDATE (+1, travando a linha) nas demais.
      const [contador] = await tx
        .insert(receiptCounters)
        .values({ tenantId: ctx.tenantId, lastNumber: 1 })
        .onConflictDoUpdate({ target: receiptCounters.tenantId, set: { lastNumber: sql`${receiptCounters.lastNumber} + 1` } })
        .returning({ numero: receiptCounters.lastNumber });
      if (!contador) throw new Error('falha no contador de recibos');
      const id = randomUUID();
      const contentEnc = await cifrarCampoFinanceiro(this.cipher, tx, ctx, id, CAMPO_RECIBO, JSON.stringify(conteudo));
      await tx.insert(receipts).values({ id, tenantId: ctx.tenantId, number: contador.numero, paymentId: p.id, contentEnc, issuedBy: ctx.userId });
      await recordAudit(tx, ctx, {
        action: AuditAction.Create,
        scope: SCOPE_RECIBOS,
        metadata: {
          receipt_id: id,
          receipt_number: contador.numero,
          payment_id: p.id,
          charge_id: c.id,
          patient_id: c.patientId,
          kind: conteudo.emitente.tipo,
          pending: conteudo.pendencias.length,
        },
      });
      return this.lerRecibo(tx, ctx, id);
    });
  }

  obter(ctx: RequestContext, id: string): Promise<ReciboDto> {
    return lerNaClinica(this.db, ctx, async (tx) => {
      const r = await this.lerRecibo(tx, ctx, id);
      await recordAudit(tx, ctx, { action: AuditAction.Read, scope: SCOPE_RECIBOS, metadata: { receipt_id: id, receipt_number: r.numero } });
      return r;
    });
  }

  /** Cancela por registro próprio (o recibo emitido não muda). O número não é reaproveitado. */
  cancelar(ctx: RequestContext, id: string, motivo: ReceiptCancelReason): Promise<ReciboDto> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      const [r] = await tx
        .select({ id: receipts.id, chargeId: payments.chargeId, numero: receipts.number })
        .from(receipts)
        .innerJoin(payments, and(eq(payments.tenantId, receipts.tenantId), eq(payments.id, receipts.paymentId)))
        .where(and(eq(receipts.tenantId, ctx.tenantId), eq(receipts.id, id)));
      if (!r) throw new NaoEncontradoError();
      await travarCobranca(tx, ctx, r.chargeId);
      const [ja] = await tx
        .select({ id: receiptCancellations.id })
        .from(receiptCancellations)
        .where(and(eq(receiptCancellations.tenantId, ctx.tenantId), eq(receiptCancellations.receiptId, id)));
      if (ja) throw new ConflitoError('recibo_ja_cancelado');
      await tx.insert(receiptCancellations).values({ tenantId: ctx.tenantId, receiptId: id, reason: motivo, cancelledBy: ctx.userId });
      await recordAudit(tx, ctx, {
        action: AuditAction.Update,
        scope: SCOPE_CANCELAMENTO_RECIBO,
        metadata: { receipt_id: id, receipt_number: r.numero, op: 'cancel', reason: motivo },
      });
      return this.lerRecibo(tx, ctx, id);
    });
  }

  /** Recibos emitidos no período (≤ 31 dias), sem CPF nem nome. */
  listar(ctx: RequestContext, filtro: { de: string; ate: string; pacienteId?: string }): Promise<{ itens: ReciboResumoDto[]; truncado: boolean }> {
    return lerNaClinica(this.db, ctx, async (tx) => {
      const { inicio, fim } = janelaDeDias(filtro.de, filtro.ate);
      const condicoes: SQL[] = [eq(receipts.tenantId, ctx.tenantId), gte(receipts.issuedAt, inicio), lt(receipts.issuedAt, fim)];
      if (filtro.pacienteId) condicoes.push(eq(charges.patientId, filtro.pacienteId));
      const linhas = await tx
        .select({ r: receipts, p: payments, c: charges, cancelada: receiptCancellations.id })
        .from(receipts)
        .innerJoin(payments, and(eq(payments.tenantId, receipts.tenantId), eq(payments.id, receipts.paymentId)))
        .innerJoin(charges, and(eq(charges.tenantId, payments.tenantId), eq(charges.id, payments.chargeId)))
        .leftJoin(receiptCancellations, and(eq(receiptCancellations.tenantId, receipts.tenantId), eq(receiptCancellations.receiptId, receipts.id)))
        .where(and(...condicoes))
        .orderBy(asc(receipts.number))
        .limit(MAXIMO_LINHAS_FINANCEIRO + 1);
      const itens = linhas.slice(0, MAXIMO_LINHAS_FINANCEIRO).map(
        (l): ReciboResumoDto => ({
          id: l.r.id,
          numero: l.r.number,
          recebimentoId: l.p.id,
          cobrancaId: l.c.id,
          pacienteId: l.c.patientId,
          valorCentavos: l.p.amountCents,
          forma: l.p.method,
          emitidoEm: l.r.issuedAt.toISOString(),
          situacao: l.cancelada ? 'cancelado' : 'emitido',
        }),
      );
      await recordAudit(tx, ctx, {
        action: AuditAction.Read,
        scope: SCOPE_RECIBOS,
        metadata: { op: 'list', count: itens.length, days: diasEntre(filtro.de, filtro.ate) + 1, ...(filtro.pacienteId ? { patient_id: filtro.pacienteId } : {}) },
      });
      return { itens, truncado: linhas.length > MAXIMO_LINHAS_FINANCEIRO };
    });
  }

  /**
   * Insumo do Receita Saúde do profissional PF no período (pela DATA DO PAGAMENTO, ≤ 31 dias): os
   * recebimentos vivos (não estornados, fora convênio) das cobranças `pf` dele. NÃO é o layout oficial
   * (manual v2.1 fora do repositório; D14 pendente): é o insumo estruturado, marcado `oficial: false`.
   */
  loteReceitaSaude(ctx: RequestContext, filtro: { profissionalId: string; de: string; ate: string }): Promise<LoteReceitaSaudeDto> {
    return lerNaClinica(this.db, ctx, async (tx) => {
      const [prof] = await tx
        .select({ id: professionals.id, nome: professionals.displayName })
        .from(professionals)
        .where(and(eq(professionals.tenantId, ctx.tenantId), eq(professionals.id, filtro.profissionalId)));
      if (!prof) throw new NaoEncontradoError();
      const [perfil] = await tx
        .select()
        .from(professionalFiscalProfiles)
        .where(and(eq(professionalFiscalProfiles.tenantId, ctx.tenantId), eq(professionalFiscalProfiles.professionalId, prof.id)));
      const config = await carregarConfig(tx, ctx);
      const { inicio, fim } = janelaDeDias(filtro.de, filtro.ate);
      const linhas = await tx
        .select({ p: payments, c: charges, paciente: patients, estorno: paymentReversals.id })
        .from(payments)
        .innerJoin(charges, and(eq(charges.tenantId, payments.tenantId), eq(charges.id, payments.chargeId)))
        .innerJoin(patients, and(eq(patients.tenantId, charges.tenantId), eq(patients.id, charges.patientId)))
        .leftJoin(paymentReversals, and(eq(paymentReversals.tenantId, payments.tenantId), eq(paymentReversals.paymentId, payments.id)))
        .where(
          and(
            eq(payments.tenantId, ctx.tenantId),
            eq(charges.professionalId, prof.id),
            eq(charges.attendanceKind, 'pf'),
            ne(payments.method, 'convenio'),
            gte(payments.receivedAt, inicio),
            lt(payments.receivedAt, fim),
            isNull(paymentReversals.id),
          ),
        )
        .orderBy(asc(payments.receivedAt), asc(payments.id))
        .limit(MAXIMO_LINHAS_FINANCEIRO + 1);
      const usadas = linhas.slice(0, MAXIMO_LINHAS_FINANCEIRO);
      const numeros = new Map<string, number>();
      if (usadas.length) {
        const recs = await tx
          .select({ paymentId: receipts.paymentId, numero: receipts.number })
          .from(receipts)
          .leftJoin(receiptCancellations, and(eq(receiptCancellations.tenantId, receipts.tenantId), eq(receiptCancellations.receiptId, receipts.id)))
          .where(and(eq(receipts.tenantId, ctx.tenantId), inArray(receipts.paymentId, usadas.map((l) => l.p.id)), isNull(receiptCancellations.id)));
        for (const r of recs) numeros.set(r.paymentId, r.numero);
      }
      const itens: ItemReceitaSaude[] = [];
      for (const l of usadas) {
        const beneficiario: PessoaDoRecibo = {
          nome: l.paciente.displayName,
          cpf: l.paciente.cpfEnc ? await this.cipher.decryptString(tx, patientFieldRef(ctx.tenantId, l.paciente.id, 'cpf'), l.paciente.cpfEnc) : null,
        };
        const pagador: PessoaDoRecibo = l.c.payerName
          ? { nome: l.c.payerName, cpf: await decifrarCampoFinanceiro(this.cipher, tx, ctx.tenantId, l.c.id, CAMPO_CPF_PAGADOR, l.c.payerCpfEnc) }
          : beneficiario;
        itens.push({
          recebimentoId: l.p.id,
          cobrancaId: l.c.id,
          reciboNumero: numeros.get(l.p.id) ?? null,
          dataPagamento: noFusoDaClinica(l.p.receivedAt).data,
          valorCentavos: l.p.amountCents,
          pagador,
          beneficiario,
          descricao: config.descricao,
          pendencias: pendenciasDoItem({ pagador, beneficiario }),
        });
      }
      const cpfProf = await decifrarCampoFinanceiro(this.cipher, tx, ctx.tenantId, prof.id, CAMPO_CPF_PROFISSIONAL, perfil?.cpfEnc ?? null);
      const pendencias = [
        ...(cpfProf ? [] : ['cpf_do_profissional']),
        ...(itens.some((i) => i.pendencias.length > 0) ? ['itens_com_pendencia'] : []),
      ];
      // Exportação de dado pessoal em lote: trilha com profissional, contagens e dias (nunca CPF/data).
      await recordAudit(tx, ctx, {
        action: AuditAction.Export,
        scope: SCOPE_RECEITA_SAUDE,
        metadata: {
          professional_id: prof.id,
          count: itens.length,
          days: diasEntre(filtro.de, filtro.ate) + 1,
          pending: itens.filter((i) => i.pendencias.length > 0).length,
          official_layout: false,
        },
      });
      return {
        formato: INSUMO_RECEITA_SAUDE.formato,
        versao: INSUMO_RECEITA_SAUDE.versao,
        oficial: false,
        dependeDe: INSUMO_RECEITA_SAUDE.dependeDe,
        lacuna: INSUMO_RECEITA_SAUDE.lacuna,
        geradoEm: new Date().toISOString(),
        periodo: { de: filtro.de, ate: filtro.ate },
        emitente: { profissionalId: prof.id, nome: prof.nome, cpf: cpfProf, registroConselho: perfil?.councilRegistration ?? null },
        itens,
        totais: { quantidade: itens.length, valorCentavos: itens.reduce((s, i) => s + i.valorCentavos, 0) },
        pendencias,
        truncado: linhas.length > MAXIMO_LINHAS_FINANCEIRO,
      };
    });
  }

  // ---------------------------------------------------------------- apoio

  /** Retrato do recibo agora: emitente (clínica ou profissional PF), pagador, beneficiário, texto neutro. */
  private async retrato(tx: TenantTx, ctx: RequestContext, c: LinhaCobranca, p: typeof payments.$inferSelect): Promise<ConteudoDoRecibo> {
    const config = await carregarConfig(tx, ctx);
    let emitente: EmitenteDoRecibo;
    if (c.attendanceKind === 'pf' && c.professionalId) {
      const [prof] = await tx
        .select({ nome: professionals.displayName })
        .from(professionals)
        .where(and(eq(professionals.tenantId, ctx.tenantId), eq(professionals.id, c.professionalId)));
      const [perfil] = await tx
        .select()
        .from(professionalFiscalProfiles)
        .where(and(eq(professionalFiscalProfiles.tenantId, ctx.tenantId), eq(professionalFiscalProfiles.professionalId, c.professionalId)));
      emitente = {
        tipo: 'pf',
        nome: prof?.nome ?? '',
        documento: await decifrarCampoFinanceiro(this.cipher, tx, ctx.tenantId, c.professionalId, CAMPO_CPF_PROFISSIONAL, perfil?.cpfEnc ?? null),
        registroConselho: config.mostrarRegistroConselho ? (perfil?.councilRegistration ?? null) : null,
        profissionalId: c.professionalId,
      };
    } else {
      const [t] = await tx.select({ nome: tenants.displayName }).from(tenants).where(eq(tenants.id, ctx.tenantId));
      emitente = { tipo: 'pj', nome: config.emitenteNome ?? t?.nome ?? '', documento: config.emitenteCnpj, registroConselho: null, profissionalId: null };
    }
    const [pac] = await tx
      .select()
      .from(patients)
      .where(and(eq(patients.tenantId, ctx.tenantId), eq(patients.id, c.patientId)));
    if (!pac) throw new NaoEncontradoError();
    const beneficiario: PessoaDoRecibo = {
      nome: pac.displayName,
      cpf: pac.cpfEnc ? await this.cipher.decryptString(tx, patientFieldRef(ctx.tenantId, pac.id, 'cpf'), pac.cpfEnc) : null,
    };
    const pagador: PessoaDoRecibo = c.payerName
      ? { nome: c.payerName, cpf: await decifrarCampoFinanceiro(this.cipher, tx, ctx.tenantId, c.id, CAMPO_CPF_PAGADOR, c.payerCpfEnc) }
      : beneficiario;
    const base = {
      emitente,
      pagador,
      beneficiario,
      valorCentavos: p.amountCents,
      forma: p.method,
      dataPagamento: noFusoDaClinica(p.receivedAt).data,
      descricao: config.descricao,
    };
    return { versao: 1, ...base, pendencias: pendenciasDoRecibo(base) };
  }

  private async lerRecibo(tx: TenantTx, ctx: RequestContext, id: string): Promise<ReciboDto> {
    const [l] = await tx
      .select({ r: receipts, motivo: receiptCancellations.reason, em: receiptCancellations.cancelledAt })
      .from(receipts)
      .leftJoin(receiptCancellations, and(eq(receiptCancellations.tenantId, receipts.tenantId), eq(receiptCancellations.receiptId, receipts.id)))
      .where(and(eq(receipts.tenantId, ctx.tenantId), eq(receipts.id, id)));
    if (!l) throw new NaoEncontradoError();
    const conteudo = JSON.parse((await decifrarCampoFinanceiro(this.cipher, tx, ctx.tenantId, id, CAMPO_RECIBO, l.r.contentEnc)) ?? '{}') as ConteudoDoRecibo;
    return {
      ...conteudo,
      id: l.r.id,
      numero: l.r.number,
      recebimentoId: l.r.paymentId,
      emitidoEm: l.r.issuedAt.toISOString(),
      situacao: l.motivo ? 'cancelado' : 'emitido',
      cancelamento: l.motivo && l.em ? { motivo: l.motivo, em: l.em.toISOString() } : null,
    };
  }
}
