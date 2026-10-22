import type { TenantId } from '@plataforma/shared';
import { asc, eq } from 'drizzle-orm';
import { whatsappInbound, whatsappOptIns, whatsappOutbox, whatsappSettings } from '../../db/schema';
import type { TenantTx } from '../../db/tenant-transaction';
import type { FieldCipher } from '../crypto/field-cipher';
import {
  CAMPO_EVIDENCIA,
  CAMPO_TELEFONE_ENVIO,
  CAMPO_TELEFONE_OPTIN,
  CAMPO_TELEFONE_RESPOSTA,
  CAMPO_TEXTO_ENVIO,
  CAMPO_TEXTO_RESPOSTA,
  campoWhatsappRef,
  type CampoWhatsapp,
} from './whatsapp-fields';

/**
 * WhatsApp no pacote G2 (migração 0032, schemaVersion 1.13.0), em `data.whatsapp`. Decisão desta rodada:
 * TUDO sai, porque o histórico de mensagens é dado do paciente e prova do que a clínica combinou com ele
 * (opt-in com a referência do comprovante, cada envio com o modelo da plataforma usado com status e cada resposta com a
 * interpretação). Conteúdo e números saem DECIFRADOS enquanto existirem; depois da retenção de 30 dias
 * saem `null` com `contentPurgedAt` (o metadado fica).
 */

const iso = (d: Date | null): string | null => d?.toISOString() ?? null;

export interface ExportedWhatsapp {
  readonly whatsappSettings: readonly {
    enabled: boolean;
    senderName: string | null;
    businessNumberId: string | null;
    reminderHoursBefore: number;
    sendFromHour: number;
    sendUntilHour: number;
    replyWindowHours: number;
    updatedAt: string;
    updatedBy: string;
  }[];
  readonly whatsappOptIns: readonly {
    id: string;
    patientId: string;
    recipientKind: string;
    guardianId: string | null;
    purpose: string;
    method: string;
    evidence: string | null;
    /** Número que consentiu (decifrado). O HMAC de comparação não sai (só serve com a chave interna). */
    recipientPhone: string | null;
    grantedAt: string;
    grantedBy: string;
    revokedAt: string | null;
    revokedBy: string | null;
    revokeMethod: string | null;
  }[];
  readonly whatsappOutbox: readonly {
    id: string;
    appointmentId: string;
    appointmentStartsAt: string;
    patientId: string;
    optInId: string;
    templateName: string;
    kind: string;
    recipientKind: string;
    guardianId: string | null;
    recipientPhone: string | null;
    body: string | null;
    status: string;
    attempts: number;
    providerMessageId: string | null;
    sentAt: string | null;
    deliveredAt: string | null;
    readAt: string | null;
    failedAt: string | null;
    failureCode: string | null;
    needsFallback: boolean;
    contentPurgedAt: string | null;
    createdAt: string;
    createdBy: string | null;
  }[];
  readonly whatsappInbound: readonly {
    id: string;
    providerMessageId: string;
    outboxId: string | null;
    senderPhone: string | null;
    body: string | null;
    interpretation: string;
    outcome: string;
    receivedAt: string;
    contentPurgedAt: string | null;
  }[];
}

export type WhatsappCounts = { readonly [K in keyof ExportedWhatsapp]: number };

function soDaClinica<T extends { tenantId: string }>(rows: readonly T[], tenantId: string): readonly T[] {
  if (rows.some((r) => r.tenantId !== tenantId)) throw new Error('linha de outro tenant no export');
  return rows;
}

export async function exportarWhatsapp(
  tx: TenantTx,
  tenantId: TenantId,
  /** Devolve a cifra ou lança (falha fechada, como o resto do G2). */
  decifrar: () => FieldCipher<TenantTx>,
): Promise<{ data: ExportedWhatsapp; counts: WhatsappCounts }> {
  const dec = async (rowId: string, campo: CampoWhatsapp, valor: string | null): Promise<string | null> =>
    valor === null ? null : decifrar().decryptString(tx, campoWhatsappRef(tenantId, rowId, campo), valor);

  const settings = soDaClinica(await tx.select().from(whatsappSettings).where(eq(whatsappSettings.tenantId, tenantId)), tenantId);
  const optIns = soDaClinica(
    await tx.select().from(whatsappOptIns).where(eq(whatsappOptIns.tenantId, tenantId)).orderBy(asc(whatsappOptIns.grantedAt), asc(whatsappOptIns.id)),
    tenantId,
  );
  const outbox = soDaClinica(
    await tx.select().from(whatsappOutbox).where(eq(whatsappOutbox.tenantId, tenantId)).orderBy(asc(whatsappOutbox.createdAt), asc(whatsappOutbox.id)),
    tenantId,
  );
  const inbound = soDaClinica(
    await tx.select().from(whatsappInbound).where(eq(whatsappInbound.tenantId, tenantId)).orderBy(asc(whatsappInbound.receivedAt), asc(whatsappInbound.id)),
    tenantId,
  );

  const data: ExportedWhatsapp = {
    whatsappSettings: settings.map((s) => ({
      enabled: s.enabled,
      senderName: s.senderName,
      businessNumberId: s.businessNumberId,
      reminderHoursBefore: s.reminderHoursBefore,
      sendFromHour: s.sendFromHour,
      sendUntilHour: s.sendUntilHour,
      replyWindowHours: s.replyWindowHours,
      updatedAt: s.updatedAt.toISOString(),
      updatedBy: s.updatedBy,
    })),
    whatsappOptIns: await Promise.all(
      optIns.map(async (o) => ({
        id: o.id,
        patientId: o.patientId,
        recipientKind: o.recipientKind,
        guardianId: o.guardianId,
        purpose: o.purpose,
        method: o.method,
        evidence: await dec(o.id, CAMPO_EVIDENCIA, o.evidenceEnc),
        recipientPhone: await dec(o.id, CAMPO_TELEFONE_OPTIN, o.recipientPhoneEnc),
        grantedAt: o.grantedAt.toISOString(),
        grantedBy: o.grantedBy,
        revokedAt: iso(o.revokedAt),
        revokedBy: o.revokedBy,
        revokeMethod: o.revokeMethod,
      })),
    ),
    whatsappOutbox: await Promise.all(
      outbox.map(async (o) => ({
        id: o.id,
        appointmentId: o.appointmentId,
        appointmentStartsAt: o.appointmentStartsAt.toISOString(),
        patientId: o.patientId,
        optInId: o.optInId,
        templateName: o.templateName,
        kind: o.kind,
        recipientKind: o.recipientKind,
        guardianId: o.guardianId,
        recipientPhone: await dec(o.id, CAMPO_TELEFONE_ENVIO, o.recipientPhoneEnc),
        body: await dec(o.id, CAMPO_TEXTO_ENVIO, o.bodyEnc),
        status: o.status,
        attempts: o.attempts,
        providerMessageId: o.providerMessageId,
        sentAt: iso(o.sentAt),
        deliveredAt: iso(o.deliveredAt),
        readAt: iso(o.readAt),
        failedAt: iso(o.failedAt),
        failureCode: o.failureCode,
        needsFallback: o.needsFallback,
        contentPurgedAt: iso(o.contentPurgedAt),
        createdAt: o.createdAt.toISOString(),
        createdBy: o.createdBy,
      })),
    ),
    whatsappInbound: await Promise.all(
      inbound.map(async (r) => ({
        id: r.id,
        providerMessageId: r.providerMessageId,
        outboxId: r.outboxId,
        senderPhone: await dec(r.id, CAMPO_TELEFONE_RESPOSTA, r.senderPhoneEnc),
        body: await dec(r.id, CAMPO_TEXTO_RESPOSTA, r.bodyEnc),
        interpretation: r.interpretation,
        outcome: r.outcome,
        receivedAt: r.receivedAt.toISOString(),
        contentPurgedAt: iso(r.contentPurgedAt),
      })),
    ),
  };
  return {
    data,
    counts: {
      whatsappSettings: data.whatsappSettings.length,
      whatsappOptIns: data.whatsappOptIns.length,
      whatsappOutbox: data.whatsappOutbox.length,
      whatsappInbound: data.whatsappInbound.length,
    },
  };
}
