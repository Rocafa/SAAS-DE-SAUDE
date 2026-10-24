import type { TenantId } from '@plataforma/shared';
import { asc, eq } from 'drizzle-orm';
import { portalConsents, portalInvites, portalLinks, portalRightsRequests } from '../../db/schema';
import type { TenantTx } from '../../db/tenant-transaction';
import type { FieldCipher } from '../crypto/field-cipher';
import { decifrarCampoPortal, type CampoPortal } from './portal-fields';

/**
 * Portal do paciente no pacote G2 (migrações 0027 e 0033, schemaVersion 1.15.0): convites (sem o hash do token,
 * que é credencial), vínculos, o HISTÓRICO de consentimentos e os pedidos do titular com detalhe e
 * resposta DECIFRADOS (o pacote é da própria clínica, controladora, e é com ele que ela prova o
 * atendimento do art. 18 e o consentimento do art. 8º).
 */

const iso = (d: Date | null): string | null => d?.toISOString() ?? null;

export interface ExportedPortal {
  readonly invites: readonly {
    id: string;
    patientId: string;
    actingAs: string;
    expiresAt: string;
    createdBy: string;
    createdAt: string;
    redeemedAt: string | null;
    redeemedAccountId: string | null;
    linkId: string | null;
    revokedAt: string | null;
    revokedBy: string | null;
    /** 0033 (V1): vínculo de responsável da 0028, a pessoa e o fim da representação. */
    guardianLinkId: string | null;
    guardianId: string | null;
    representUntil: string | null;
    confidentialFrom: string | null;
  }[];
  readonly links: readonly {
    id: string;
    accountId: string;
    patientId: string;
    inviteId: string;
    actingAs: string;
    createdAt: string;
    revokedAt: string | null;
    revokedBy: string | null;
    revokeReason: string | null;
    guardianLinkId: string | null;
    guardianId: string | null;
    representUntil: string | null;
    confidentialFrom: string | null;
  }[];
  readonly consents: readonly {
    id: string;
    patientId: string;
    linkId: string;
    accountId: string;
    purpose: string;
    response: string;
    actingAs: string;
    textVersion: string;
    textHash: string;
    channel: string;
    createdAt: string;
    guardianId: string | null;
    representUntil: string | null;
    guardianLinkId: string | null;
    representationEndedAt: string | null;
  }[];
  readonly rightsRequests: readonly {
    id: string;
    patientId: string;
    linkId: string;
    accountId: string;
    kind: string;
    actingAs: string;
    protocol: string;
    detail: string | null;
    status: string;
    createdAt: string;
    dueAt: string;
    handledBy: string | null;
    handledAt: string | null;
    answer: string | null;
    guardianId: string | null;
    /** 0051: data de nascimento proposta no pedido de correção (decifrada no pacote). */
    birthDateProposed: string | null;
    documentCheckedBy: string | null;
    documentCheckedAt: string | null;
  }[];
}

export interface PortalCounts {
  readonly invites: number;
  readonly links: number;
  readonly consents: number;
  readonly rightsRequests: number;
}

function soDaClinica<T extends { tenantId: string }>(rows: readonly T[], tenantId: string): readonly T[] {
  if (rows.some((r) => r.tenantId !== tenantId)) throw new Error('linha de outro tenant no export');
  return rows;
}

export async function exportarPortal(
  tx: TenantTx,
  tenantId: TenantId,
  /** Devolve a cifra ou lança (ExportCipherMissingError): falha fechada, como o resto do G2. */
  decifrar: () => FieldCipher<TenantTx>,
): Promise<{ data: ExportedPortal; counts: PortalCounts }> {
  const convites = soDaClinica(
    await tx.select().from(portalInvites).where(eq(portalInvites.tenantId, tenantId)).orderBy(asc(portalInvites.createdAt), asc(portalInvites.id)),
    tenantId,
  );
  const vinculos = soDaClinica(
    await tx.select().from(portalLinks).where(eq(portalLinks.tenantId, tenantId)).orderBy(asc(portalLinks.createdAt), asc(portalLinks.id)),
    tenantId,
  );
  const consentimentos = soDaClinica(
    await tx
      .select()
      .from(portalConsents)
      .where(eq(portalConsents.tenantId, tenantId))
      .orderBy(asc(portalConsents.createdAt), asc(portalConsents.id)),
    tenantId,
  );
  const pedidos = soDaClinica(
    await tx
      .select()
      .from(portalRightsRequests)
      .where(eq(portalRightsRequests.tenantId, tenantId))
      .orderBy(asc(portalRightsRequests.createdAt), asc(portalRightsRequests.id)),
    tenantId,
  );
  const dec = (rowId: string, campo: CampoPortal, valor: string | null): Promise<string | null> =>
    valor === null ? Promise.resolve(null) : decifrarCampoPortal(decifrar(), tx, tenantId, rowId, campo, valor);

  const rightsRequests: ExportedPortal['rightsRequests'][number][] = [];
  for (const p of pedidos) {
    rightsRequests.push({
      id: p.id,
      patientId: p.patientId,
      linkId: p.linkId,
      accountId: p.accountId,
      kind: p.kind,
      actingAs: p.actingAs,
      protocol: p.protocol,
      detail: await dec(p.id, 'detail', p.detailEnc),
      status: p.status,
      createdAt: p.createdAt.toISOString(),
      dueAt: p.dueAt.toISOString(),
      handledBy: p.handledBy,
      handledAt: iso(p.handledAt),
      answer: await dec(p.id, 'answer', p.answerEnc),
      guardianId: p.guardianId,
      birthDateProposed: await dec(p.id, 'birth_date_proposed', p.birthDateProposedEnc),
      documentCheckedBy: p.documentCheckedBy,
      documentCheckedAt: iso(p.documentCheckedAt),
    });
  }
  const data: ExportedPortal = {
    invites: convites.map((c) => ({
      id: c.id,
      patientId: c.patientId,
      actingAs: c.actingAs,
      expiresAt: c.expiresAt.toISOString(),
      createdBy: c.createdBy,
      createdAt: c.createdAt.toISOString(),
      redeemedAt: iso(c.redeemedAt),
      redeemedAccountId: c.redeemedAccountId,
      linkId: c.linkId,
      revokedAt: iso(c.revokedAt),
      revokedBy: c.revokedBy,
      guardianLinkId: c.guardianLinkId,
      guardianId: c.guardianId,
      representUntil: c.representUntil,
      confidentialFrom: c.confidentialFrom,
    })),
    links: vinculos.map((l) => ({
      id: l.id,
      accountId: l.accountId,
      patientId: l.patientId,
      inviteId: l.inviteId,
      actingAs: l.actingAs,
      createdAt: l.createdAt.toISOString(),
      revokedAt: iso(l.revokedAt),
      revokedBy: l.revokedBy,
      revokeReason: l.revokeReason,
      guardianLinkId: l.guardianLinkId,
      guardianId: l.guardianId,
      representUntil: l.representUntil,
      confidentialFrom: l.confidentialFrom,
    })),
    consents: consentimentos.map((c) => ({
      id: c.id,
      patientId: c.patientId,
      linkId: c.linkId,
      accountId: c.accountId,
      purpose: c.purpose,
      response: c.response,
      actingAs: c.actingAs,
      textVersion: c.textVersion,
      textHash: c.textHash,
      channel: c.channel,
      createdAt: c.createdAt.toISOString(),
      guardianId: c.guardianId,
      representUntil: c.representUntil,
      guardianLinkId: c.guardianLinkId,
      representationEndedAt: iso(c.representationEndedAt),
    })),
    rightsRequests,
  };
  return {
    data,
    counts: { invites: data.invites.length, links: data.links.length, consents: data.consents.length, rightsRequests: rightsRequests.length },
  };
}
