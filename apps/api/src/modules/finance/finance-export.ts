import type { TenantId } from '@plataforma/shared';
import { asc, eq } from 'drizzle-orm';
import {
  cashSessions,
  charges,
  financeSettings,
  paymentReversals,
  payments,
  professionalFiscalProfiles,
  receiptCancellations,
  receiptCounters,
  receipts,
} from '../../db/schema';
import type { TenantTx } from '../../db/tenant-transaction';
import type { FieldCipher } from '../crypto/field-cipher';
import { CAMPO_CPF_PAGADOR, CAMPO_CPF_PROFISSIONAL, CAMPO_RECIBO, campoFinanceiroRef, type CampoFinanceiro } from './finance-fields';

/**
 * Financeiro no pacote G2 (migração 0018, schemaVersion 1.9.0): todas as tabelas, com CPFs e o retrato
 * do recibo DECIFRADOS (o pacote é da própria clínica, controladora). Fica num arquivo próprio para o
 * tenant-export.ts só agregar.
 */

const iso = (d: Date | null): string | null => d?.toISOString() ?? null;

export interface ExportedFinance {
  readonly financeSettings: readonly {
    receiptDescription: string;
    defaultAttendanceKind: string;
    issuerName: string | null;
    issuerCnpj: string | null;
    showCouncilOnReceipt: boolean;
    updatedAt: string;
    updatedBy: string;
  }[];
  readonly professionalFiscalProfiles: readonly {
    professionalId: string;
    cpf: string | null;
    councilRegistration: string | null;
    updatedAt: string;
    updatedBy: string;
  }[];
  readonly cashSessions: readonly {
    id: string;
    businessDate: string;
    shift: string;
    openingFloatCents: number;
    status: string;
    openedAt: string;
    openedBy: string;
    closedAt: string | null;
    closedBy: string | null;
    expectedCashCents: number | null;
    countedCashCents: number | null;
  }[];
  readonly charges: readonly {
    id: string;
    patientId: string;
    appointmentId: string | null;
    packageId: string | null;
    professionalId: string | null;
    attendanceKind: string;
    amountCents: number;
    paidCents: number;
    dueDate: string;
    payerName: string | null;
    payerCpf: string | null;
    status: string;
    cancelledAt: string | null;
    cancelledBy: string | null;
    cancelReason: string | null;
    createdAt: string;
    createdBy: string;
    updatedAt: string;
  }[];
  readonly payments: readonly {
    id: string;
    chargeId: string;
    cashSessionId: string;
    method: string;
    amountCents: number;
    receivedAt: string;
    receivedBy: string;
  }[];
  readonly paymentReversals: readonly {
    id: string;
    paymentId: string;
    cashSessionId: string;
    reason: string;
    reversedAt: string;
    reversedBy: string;
  }[];
  readonly receiptCounters: readonly { lastNumber: number }[];
  readonly receipts: readonly {
    id: string;
    number: number;
    paymentId: string;
    /** Retrato do recibo decifrado (objeto JSON). */
    content: unknown;
    issuedAt: string;
    issuedBy: string;
  }[];
  readonly receiptCancellations: readonly {
    id: string;
    receiptId: string;
    reason: string;
    cancelledAt: string;
    cancelledBy: string;
  }[];
}

export type FinanceCounts = { readonly [K in keyof ExportedFinance]: number };

function soDaClinica<T extends { tenantId: string }>(rows: readonly T[], tenantId: string): readonly T[] {
  if (rows.some((r) => r.tenantId !== tenantId)) throw new Error('linha de outro tenant no export');
  return rows;
}

export async function exportarFinanceiro(
  tx: TenantTx,
  tenantId: TenantId,
  /** Devolve a cifra ou lança (ExportCipherMissingError): falha fechada, como o resto do G2. */
  decifrar: () => FieldCipher<TenantTx>,
): Promise<{ data: ExportedFinance; counts: FinanceCounts }> {
  const dec = async (rowId: string, campo: CampoFinanceiro, valor: string | null): Promise<string | null> => {
    if (valor === null) return null;
    return decifrar().decryptString(tx, campoFinanceiroRef(tenantId, rowId, campo), valor);
  };
  const settings = soDaClinica(await tx.select().from(financeSettings).where(eq(financeSettings.tenantId, tenantId)), tenantId);
  const perfis = soDaClinica(
    await tx
      .select()
      .from(professionalFiscalProfiles)
      .where(eq(professionalFiscalProfiles.tenantId, tenantId))
      .orderBy(asc(professionalFiscalProfiles.professionalId)),
    tenantId,
  );
  const caixas = soDaClinica(
    await tx.select().from(cashSessions).where(eq(cashSessions.tenantId, tenantId)).orderBy(asc(cashSessions.openedAt), asc(cashSessions.id)),
    tenantId,
  );
  const cobrancas = soDaClinica(
    await tx.select().from(charges).where(eq(charges.tenantId, tenantId)).orderBy(asc(charges.createdAt), asc(charges.id)),
    tenantId,
  );
  const recebimentos = soDaClinica(
    await tx.select().from(payments).where(eq(payments.tenantId, tenantId)).orderBy(asc(payments.receivedAt), asc(payments.id)),
    tenantId,
  );
  const estornos = soDaClinica(
    await tx
      .select()
      .from(paymentReversals)
      .where(eq(paymentReversals.tenantId, tenantId))
      .orderBy(asc(paymentReversals.reversedAt), asc(paymentReversals.id)),
    tenantId,
  );
  const contadores = soDaClinica(await tx.select().from(receiptCounters).where(eq(receiptCounters.tenantId, tenantId)), tenantId);
  const recibos = soDaClinica(await tx.select().from(receipts).where(eq(receipts.tenantId, tenantId)).orderBy(asc(receipts.number)), tenantId);
  const cancelamentos = soDaClinica(
    await tx
      .select()
      .from(receiptCancellations)
      .where(eq(receiptCancellations.tenantId, tenantId))
      .orderBy(asc(receiptCancellations.cancelledAt), asc(receiptCancellations.id)),
    tenantId,
  );

  const data: ExportedFinance = {
    financeSettings: settings.map((s) => ({
      receiptDescription: s.receiptDescription,
      defaultAttendanceKind: s.defaultAttendanceKind,
      issuerName: s.issuerName,
      issuerCnpj: s.issuerCnpj,
      showCouncilOnReceipt: s.showCouncilOnReceipt,
      updatedAt: s.updatedAt.toISOString(),
      updatedBy: s.updatedBy,
    })),
    professionalFiscalProfiles: await Promise.all(
      perfis.map(async (p) => ({
        professionalId: p.professionalId,
        cpf: await dec(p.professionalId, CAMPO_CPF_PROFISSIONAL, p.cpfEnc),
        councilRegistration: p.councilRegistration,
        updatedAt: p.updatedAt.toISOString(),
        updatedBy: p.updatedBy,
      })),
    ),
    cashSessions: caixas.map((c) => ({
      id: c.id,
      businessDate: c.businessDate,
      shift: c.shift,
      openingFloatCents: c.openingFloatCents,
      status: c.status,
      openedAt: c.openedAt.toISOString(),
      openedBy: c.openedBy,
      closedAt: iso(c.closedAt),
      closedBy: c.closedBy,
      expectedCashCents: c.expectedCashCents,
      countedCashCents: c.countedCashCents,
    })),
    charges: await Promise.all(
      cobrancas.map(async (c) => ({
        id: c.id,
        patientId: c.patientId,
        appointmentId: c.appointmentId,
        packageId: c.packageId,
        professionalId: c.professionalId,
        attendanceKind: c.attendanceKind,
        amountCents: c.amountCents,
        paidCents: c.paidCents,
        dueDate: c.dueDate,
        payerName: c.payerName,
        payerCpf: await dec(c.id, CAMPO_CPF_PAGADOR, c.payerCpfEnc),
        status: c.status,
        cancelledAt: iso(c.cancelledAt),
        cancelledBy: c.cancelledBy,
        cancelReason: c.cancelReason,
        createdAt: c.createdAt.toISOString(),
        createdBy: c.createdBy,
        updatedAt: c.updatedAt.toISOString(),
      })),
    ),
    payments: recebimentos.map((p) => ({
      id: p.id,
      chargeId: p.chargeId,
      cashSessionId: p.cashSessionId,
      method: p.method,
      amountCents: p.amountCents,
      receivedAt: p.receivedAt.toISOString(),
      receivedBy: p.receivedBy,
    })),
    paymentReversals: estornos.map((e) => ({
      id: e.id,
      paymentId: e.paymentId,
      cashSessionId: e.cashSessionId,
      reason: e.reason,
      reversedAt: e.reversedAt.toISOString(),
      reversedBy: e.reversedBy,
    })),
    receiptCounters: contadores.map((c) => ({ lastNumber: c.lastNumber })),
    receipts: await Promise.all(
      recibos.map(async (r) => ({
        id: r.id,
        number: r.number,
        paymentId: r.paymentId,
        content: JSON.parse((await dec(r.id, CAMPO_RECIBO, r.contentEnc)) ?? 'null') as unknown,
        issuedAt: r.issuedAt.toISOString(),
        issuedBy: r.issuedBy,
      })),
    ),
    receiptCancellations: cancelamentos.map((c) => ({
      id: c.id,
      receiptId: c.receiptId,
      reason: c.reason,
      cancelledAt: c.cancelledAt.toISOString(),
      cancelledBy: c.cancelledBy,
    })),
  };
  const counts = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, (v as readonly unknown[]).length])) as FinanceCounts;
  return { data, counts };
}
