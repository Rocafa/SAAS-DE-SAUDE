import { Inject, Injectable } from '@nestjs/common';
import { AuditAction, type RequestContext } from '@plataforma/shared';
import { and, asc, eq, gte, inArray, isNull, lt, ne, sql, type SQL } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { ConflitoError, NaoEncontradoError } from '../../common/erros-dominio';
import { escreverNaClinica, lerNaClinica } from '../../common/transacao-clinica';
import {
  charges,
  guardians,
  patientGuardians,
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
import { ehPerfil, temPermissao } from '../auth/perfis';
import { patientFieldRef } from '../patients/patient-fields';
import { decifrarCampoResponsavel } from '../patients/guardian-fields';
import { mascararCpf } from '../patients/responsaveis.service';
import { janelaDeDias, noFusoDaClinica } from '../scheduling/agenda-regras';
import { TenantDatabase } from '../tenancy/tenancy.module';
import {
  CAMPO_CPF_PAGADOR,
  CAMPO_CPF_PROFISSIONAL,
  CAMPO_PAGADOR_DO_RECEBIMENTO,
  CAMPO_RECIBO,
  cifrarCampoFinanceiro,
  decifrarCampoFinanceiro,
} from './finance-fields';
import {
  carregarConfig,
  reciboVivoDoRecebimento,
  SCOPE_CANCELAMENTO_RECIBO,
  SCOPE_RECEBIMENTOS,
  SCOPE_RECEITA_SAUDE,
  SCOPE_RECIBOS,
  travarCobranca,
  type LinhaCobranca,
} from './financeiro-comum';
import {
  formaGeraRecibo,
  INSUMO_RECEITA_SAUDE,
  menorDeIdadeEm,
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
  /** CPFs mascarados para quem não tem `recibos:ver_cpf_completo` (recepção). */
  readonly cpfMascarado: boolean;
}

/** CPFs do recibo mascarados (pagador, beneficiário e o documento do emitente PF, que é CPF; CNPJ fica). */
export function mascararCpfsDoRecibo(c: ConteudoDoRecibo): ConteudoDoRecibo {
  const pessoa = (p: PessoaDoRecibo): PessoaDoRecibo => ({ ...p, cpf: p.cpf === null ? null : mascararCpf(p.cpf) });
  return {
    ...c,
    pagador: pessoa(c.pagador),
    beneficiario: pessoa(c.beneficiario),
    emitente: c.emitente.tipo === 'pf' && c.emitente.documento !== null ? { ...c.emitente, documento: mascararCpf(c.emitente.documento) } : c.emitente,
  };
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
  /** R5: só nome e CPF do emitente (o registro no conselho e o id interno não vão no insumo). */
  readonly emitente: { readonly nome: string; readonly cpf: string | null };
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

  /**
   * Emite o recibo do recebimento. Idempotente: se já há recibo vivo, devolve o mesmo.
   * R2 do #65: o registro no conselho entra só se pedido NESTE recibo (`incluirRegistroConselho`) e se a
   * clínica habilitou a opção (409 `registro_conselho_nao_habilitado`); fica gravado no retrato.
   */
  emitir(ctx: RequestContext, recebimentoId: string, opcoes: { incluirRegistroConselho: boolean } = { incluirRegistroConselho: false }): Promise<ReciboDto> {
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

      if (opcoes.incluirRegistroConselho && !(await carregarConfig(tx, ctx)).mostrarRegistroConselho) {
        throw new ConflitoError('registro_conselho_nao_habilitado');
      }
      const conteudo = await this.retrato(tx, ctx, c, p, opcoes.incluirRegistroConselho);
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
          council_shown: conteudo.emitente.registroConselho !== null,
          pending: conteudo.pendencias.length,
          full_cpf: temPermissao(ctx.roles.filter(ehPerfil), 'recibos:ver_cpf_completo'),
        },
      });
      return this.lerRecibo(tx, ctx, id);
    });
  }

  obter(ctx: RequestContext, id: string): Promise<ReciboDto> {
    return lerNaClinica(this.db, ctx, async (tx) => {
      const r = await this.lerRecibo(tx, ctx, id);
      await recordAudit(tx, ctx, {
        action: AuditAction.Read,
        scope: SCOPE_RECIBOS,
        metadata: { receipt_id: id, receipt_number: r.numero, full_cpf: !r.cpfMascarado },
      });
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
      const anulados = await this.vinculosAnulados(tx, ctx, usadas.map((l) => l.p.guardianPayerLinkId));
      const itens: ItemReceitaSaude[] = [];
      for (const l of usadas) {
        const beneficiario: PessoaDoRecibo = {
          nome: l.paciente.displayName,
          cpf: l.paciente.cpfEnc ? await this.cipher.decryptString(tx, patientFieldRef(ctx.tenantId, l.paciente.id, 'cpf'), l.paciente.cpfEnc) : null,
        };
        const dataPagamento = noFusoDaClinica(l.p.receivedAt).data;
        // V1 do #67: sem pagador na cobrança, vale o responsável pagador CONGELADO no recebimento.
        const doResponsavel = l.c.payerName ? null : await this.pagadorCongelado(tx, ctx, l.p);
        const pagador: PessoaDoRecibo = l.c.payerName
          ? { nome: l.c.payerName, cpf: await decifrarCampoFinanceiro(this.cipher, tx, ctx.tenantId, l.c.id, CAMPO_CPF_PAGADOR, l.c.payerCpfEnc) }
          : (doResponsavel ?? beneficiario);
        const responsavel = !l.c.payerName && !doResponsavel && (await this.pacienteMenor(tx, ctx, l.paciente, dataPagamento));
        itens.push({
          reciboNumero: numeros.get(l.p.id) ?? null,
          dataPagamento,
          valorCentavos: l.p.amountCents,
          pagador,
          beneficiario,
          pendencias: pendenciasDoItem(
            { pagador, beneficiario },
            responsavel,
            doResponsavel !== null && l.p.guardianPayerLinkId !== null && anulados.has(l.p.guardianPayerLinkId),
          ),
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
        emitente: { nome: prof.nome, cpf: cpfProf },
        itens,
        totais: { quantidade: itens.length, valorCentavos: itens.reduce((s, i) => s + i.valorCentavos, 0) },
        pendencias,
        truncado: linhas.length > MAXIMO_LINHAS_FINANCEIRO,
      };
    });
  }

  /**
   * Saneamento de `pagador_responsavel` (R2 do 2º parecer do #67; api-dominio §10a): recebimento SEM pagador
   * congelado (ex.: anterior à 0031) ganha, UMA vez, o responsável que o financeiro aponta — vínculo do
   * paciente da cobrança vigente na DATA do recebimento, não anulado, pessoa não descartada; cobrança sem
   * pagador próprio; recebimento não estornado. O retrato (nome + CPF de agora da pessoa) é cifrado como o
   * congelado da 0031; o banco confere tudo de novo e grava quem/quando. Recibo já emitido NÃO muda: para
   * reemiti-lo, cancele-o (`recibos:cancelar`) e emita de novo. Trilha só com ids.
   */
  resolverPagadorResponsavel(
    ctx: RequestContext,
    recebimentoId: string,
    vinculoId: string,
  ): Promise<{ readonly recebimentoId: string; readonly vinculoId: string; readonly reciboVivoId: string | null }> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      const [p] = await tx.select().from(payments).where(and(eq(payments.tenantId, ctx.tenantId), eq(payments.id, recebimentoId)));
      if (!p) throw new NaoEncontradoError();
      const c = await travarCobranca(tx, ctx, p.chargeId);
      if (c.payerName) throw new ConflitoError('cobranca_com_pagador');
      if (p.guardianPayerLinkId) throw new ConflitoError('pagador_ja_congelado');
      if (!formaGeraRecibo(p.method)) throw new ConflitoError('recebimento_de_convenio');
      const [estorno] = await tx
        .select({ id: paymentReversals.id })
        .from(paymentReversals)
        .where(and(eq(paymentReversals.tenantId, ctx.tenantId), eq(paymentReversals.paymentId, p.id)));
      if (estorno) throw new ConflitoError('recebimento_estornado');
      const [l] = await tx
        .select({ v: patientGuardians, g: guardians })
        .from(patientGuardians)
        .innerJoin(guardians, and(eq(guardians.tenantId, patientGuardians.tenantId), eq(guardians.id, patientGuardians.guardianId)))
        .where(and(eq(patientGuardians.tenantId, ctx.tenantId), eq(patientGuardians.id, vinculoId), eq(patientGuardians.patientId, c.patientId)));
      if (!l) throw new NaoEncontradoError();
      const data = noFusoDaClinica(p.receivedAt).data;
      const vigente = l.v.validFrom <= data && (l.v.validUntil === null || l.v.validUntil > data);
      if (!vigente || l.v.endReason === 'cadastro_errado' || l.g.discardedAt !== null || l.g.nameEnc === null) {
        throw new ConflitoError('vinculo_nao_vigente_no_recebimento');
      }
      const retrato = JSON.stringify({
        nome: (await decifrarCampoResponsavel(this.cipher, tx, ctx.tenantId, l.g.id, 'name', l.g.nameEnc)) ?? '',
        cpf: await decifrarCampoResponsavel(this.cipher, tx, ctx.tenantId, l.g.id, 'cpf', l.g.cpfEnc),
      });
      const enc = await cifrarCampoFinanceiro(this.cipher, tx, ctx, p.id, CAMPO_PAGADOR_DO_RECEBIMENTO, retrato);
      const [r] = await tx.execute<{ ok: boolean }>(sql`select app_payment_resolve_guardian_payer(${p.id}::uuid, ${l.v.id}::uuid, ${enc}) as ok`);
      if (!r?.ok) throw new ConflitoError('pagador_ja_congelado');
      const vivo = await reciboVivoDoRecebimento(tx, ctx, p.id);
      await recordAudit(tx, ctx, {
        action: AuditAction.Update,
        scope: SCOPE_RECEBIMENTOS,
        metadata: {
          op: 'guardian_payer_resolution',
          payment_id: p.id,
          charge_id: c.id,
          patient_id: c.patientId,
          link_id: l.v.id,
          live_receipt: vivo !== null,
        },
      });
      return { recebimentoId: p.id, vinculoId: l.v.id, reciboVivoId: vivo?.id ?? null };
    });
  }

  // ---------------------------------------------------------------- apoio

  /** Retrato do recibo agora: emitente (clínica ou profissional PF), pagador, beneficiário, texto neutro. */
  private async retrato(
    tx: TenantTx,
    ctx: RequestContext,
    c: LinhaCobranca,
    p: typeof payments.$inferSelect,
    incluirRegistroConselho: boolean,
  ): Promise<ConteudoDoRecibo> {
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
        // R2: por recibo (padrão oculto); a chave da clínica só habilita a opção.
        registroConselho: incluirRegistroConselho && config.mostrarRegistroConselho ? (perfil?.councilRegistration ?? null) : null,
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
    const dataPagamento = noFusoDaClinica(p.receivedAt).data;
    // V1 do #67: sem pagador na cobrança, vale o responsável pagador CONGELADO no recebimento (nunca o
    // cadastro de hoje): recibo tardio sai com quem era o pagador quando o dinheiro entrou.
    const doResponsavel = c.payerName ? null : await this.pagadorCongelado(tx, ctx, p);
    const pagador: PessoaDoRecibo = c.payerName
      ? { nome: c.payerName, cpf: await decifrarCampoFinanceiro(this.cipher, tx, ctx.tenantId, c.id, CAMPO_CPF_PAGADOR, c.payerCpfEnc) }
      : (doResponsavel ?? beneficiario);
    const base = {
      emitente,
      pagador,
      beneficiario,
      valorCentavos: p.amountCents,
      forma: p.method,
      dataPagamento,
      descricao: config.descricao,
    };
    // R3 do #65: a pendência só fica quando nem a cobrança nem o cadastro dizem quem pagou.
    const responsavel = !c.payerName && !doResponsavel && (await this.pacienteMenor(tx, ctx, pac, dataPagamento));
    const anulado = doResponsavel !== null && (await this.vinculosAnulados(tx, ctx, [p.guardianPayerLinkId])).size > 0;
    return { versao: 1, ...base, pendencias: pendenciasDoRecibo(base, responsavel, anulado) };
  }

  /**
   * R1 do 2º parecer do #67: dos vínculos informados (pagador congelado de recebimentos), os anulados como
   * cadastro errado depois do recebimento. O congelado continua valendo, com a pendência `pagador_anulado`.
   */
  private async vinculosAnulados(tx: TenantTx, ctx: RequestContext, ids: readonly (string | null)[]): Promise<Set<string>> {
    const validos = [...new Set(ids.filter((i): i is string => i !== null))];
    if (!validos.length) return new Set();
    const linhas = await tx
      .select({ id: patientGuardians.id })
      .from(patientGuardians)
      .where(and(eq(patientGuardians.tenantId, ctx.tenantId), inArray(patientGuardians.id, validos), eq(patientGuardians.endReason, 'cadastro_errado')));
    return new Set(linhas.map((l) => l.id));
  }

  /** V1 do #67: o responsável pagador gravado no recebimento (null se não houve ou se já eliminado pela retenção). */
  private async pagadorCongelado(tx: TenantTx, ctx: RequestContext, p: typeof payments.$inferSelect): Promise<PessoaDoRecibo | null> {
    const json = await decifrarCampoFinanceiro(this.cipher, tx, ctx.tenantId, p.id, CAMPO_PAGADOR_DO_RECEBIMENTO, p.guardianPayerEnc);
    if (json === null) return null;
    const v = JSON.parse(json) as { nome?: unknown; cpf?: unknown };
    return { nome: typeof v.nome === 'string' ? v.nome : '', cpf: typeof v.cpf === 'string' ? v.cpf : null };
  }

  /** R3: paciente menor na data do pagamento (data de nascimento cifrada; ausente = não se sabe; emancipado = maior). */
  private async pacienteMenor(tx: TenantTx, ctx: RequestContext, pac: typeof patients.$inferSelect, data: string): Promise<boolean> {
    if (!pac.birthDateEnc) return false;
    if (pac.emancipatedOn !== null && pac.emancipatedOn <= data) return false;
    const nascimento = await this.cipher.decryptString(tx, patientFieldRef(ctx.tenantId, pac.id, 'birth_date'), pac.birthDateEnc);
    return menorDeIdadeEm(nascimento, data);
  }

  private async lerRecibo(tx: TenantTx, ctx: RequestContext, id: string): Promise<ReciboDto> {
    const [l] = await tx
      .select({ r: receipts, motivo: receiptCancellations.reason, em: receiptCancellations.cancelledAt })
      .from(receipts)
      .leftJoin(receiptCancellations, and(eq(receiptCancellations.tenantId, receipts.tenantId), eq(receiptCancellations.receiptId, receipts.id)))
      .where(and(eq(receipts.tenantId, ctx.tenantId), eq(receipts.id, id)));
    if (!l) throw new NaoEncontradoError();
    // R7: retrato eliminado pela retenção fiscal (ficam número, valor e datas, sem dado pessoal).
    if (l.r.contentEnc === null) throw new ConflitoError('recibo_eliminado_por_retencao_fiscal');
    const gravado = JSON.parse((await decifrarCampoFinanceiro(this.cipher, tx, ctx.tenantId, id, CAMPO_RECIBO, l.r.contentEnc)) ?? '{}') as ConteudoDoRecibo;
    // 2º parecer do #67: CPF completo no recibo só para admin e financeiro; a recepção (que emite e entrega)
    // vê pagador, beneficiário e emitente PF mascarados. O retrato gravado continua completo.
    const completo = temPermissao(ctx.roles.filter(ehPerfil), 'recibos:ver_cpf_completo');
    const conteudo: ConteudoDoRecibo = completo ? gravado : mascararCpfsDoRecibo(gravado);
    return {
      ...conteudo,
      cpfMascarado: !completo,
      id: l.r.id,
      numero: l.r.number,
      recebimentoId: l.r.paymentId,
      emitidoEm: l.r.issuedAt.toISOString(),
      situacao: l.motivo ? 'cancelado' : 'emitido',
      cancelamento: l.motivo && l.em ? { motivo: l.motivo, em: l.em.toISOString() } : null,
    };
  }
}
