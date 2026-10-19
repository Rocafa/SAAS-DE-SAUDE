import type { TenantId } from '@plataforma/shared';
import { asc, eq } from 'drizzle-orm';
import { guardians, patientGuardianHistory, patientGuardians } from '../../db/schema';
import type { TenantTx } from '../../db/tenant-transaction';
import type { FieldCipher } from '../crypto/field-cipher';
import { guardianFieldRef, type GuardianEncryptedColumn } from './guardian-fields';

/**
 * Responsáveis no pacote G2 (migração 0028, schemaVersion 1.13.0): pessoas (nome, CPF e telefone
 * DECIFRADOS — o pacote é da clínica, controladora), vínculos com a vigência e o histórico inteiro,
 * inclusive os valores anteriores da pessoa (decifrados). Arquivo próprio para o tenant-export.ts só agregar.
 */

const iso = (d: Date | null): string | null => d?.toISOString() ?? null;

export interface ExportedGuardians {
  readonly guardians: readonly {
    id: string;
    name: string | null;
    cpf: string | null;
    phone: string | null;
    createdAt: string;
    createdBy: string;
    updatedAt: string;
    updatedBy: string;
  }[];
  readonly patientGuardians: readonly {
    id: string;
    patientId: string;
    guardianId: string;
    kind: string;
    isPayer: boolean;
    receivesClinicalInfo: boolean;
    validFrom: string;
    validUntil: string | null;
    endReason: string | null;
    endedAt: string | null;
    endedBy: string | null;
    createdAt: string;
    createdBy: string;
    updatedAt: string;
    updatedBy: string;
  }[];
  readonly patientGuardianHistory: readonly {
    id: string;
    guardianId: string;
    linkId: string | null;
    event: string;
    changedFields: string;
    prevName: string | null;
    prevCpf: string | null;
    prevPhone: string | null;
    kind: string | null;
    isPayer: boolean | null;
    receivesClinicalInfo: boolean | null;
    validFrom: string | null;
    validUntil: string | null;
    endReason: string | null;
    actorId: string;
    occurredAt: string;
  }[];
}

export type GuardiansCounts = { readonly [K in keyof ExportedGuardians]: number };

function soDaClinica<T extends { tenantId: string }>(rows: readonly T[], tenantId: string): readonly T[] {
  if (rows.some((r) => r.tenantId !== tenantId)) throw new Error('linha de outro tenant no export');
  return rows;
}

export async function exportarResponsaveis(
  tx: TenantTx,
  tenantId: TenantId,
  /** Devolve a cifra ou lança (ExportCipherMissingError): falha fechada, como o resto do G2. */
  decifrar: () => FieldCipher<TenantTx>,
): Promise<{ data: ExportedGuardians; counts: GuardiansCounts }> {
  const dec = async (guardianId: string, coluna: GuardianEncryptedColumn, valor: string | null): Promise<string | null> => {
    if (valor === null) return null;
    return decifrar().decryptString(tx, guardianFieldRef(tenantId, guardianId, coluna), valor);
  };
  const pessoas = soDaClinica(
    await tx.select().from(guardians).where(eq(guardians.tenantId, tenantId)).orderBy(asc(guardians.createdAt), asc(guardians.id)),
    tenantId,
  );
  const vinculos = soDaClinica(
    await tx
      .select()
      .from(patientGuardians)
      .where(eq(patientGuardians.tenantId, tenantId))
      .orderBy(asc(patientGuardians.createdAt), asc(patientGuardians.id)),
    tenantId,
  );
  const historico = soDaClinica(
    await tx
      .select()
      .from(patientGuardianHistory)
      .where(eq(patientGuardianHistory.tenantId, tenantId))
      .orderBy(asc(patientGuardianHistory.occurredAt), asc(patientGuardianHistory.id)),
    tenantId,
  );

  const data: ExportedGuardians = {
    guardians: await Promise.all(
      pessoas.map(async (g) => ({
        id: g.id,
        name: await dec(g.id, 'name', g.nameEnc),
        cpf: await dec(g.id, 'cpf', g.cpfEnc),
        phone: await dec(g.id, 'phone', g.phoneEnc),
        createdAt: g.createdAt.toISOString(),
        createdBy: g.createdBy,
        updatedAt: g.updatedAt.toISOString(),
        updatedBy: g.updatedBy,
      })),
    ),
    patientGuardians: vinculos.map((v) => ({
      id: v.id,
      patientId: v.patientId,
      guardianId: v.guardianId,
      kind: v.kind,
      isPayer: v.isPayer,
      receivesClinicalInfo: v.receivesClinicalInfo,
      validFrom: v.validFrom,
      validUntil: v.validUntil,
      endReason: v.endReason,
      endedAt: iso(v.endedAt),
      endedBy: v.endedBy,
      createdAt: v.createdAt.toISOString(),
      createdBy: v.createdBy,
      updatedAt: v.updatedAt.toISOString(),
      updatedBy: v.updatedBy,
    })),
    patientGuardianHistory: await Promise.all(
      historico.map(async (h) => ({
        id: h.id,
        guardianId: h.guardianId,
        linkId: h.linkId,
        event: h.event,
        changedFields: h.changedFields,
        prevName: await dec(h.guardianId, 'name', h.prevNameEnc),
        prevCpf: await dec(h.guardianId, 'cpf', h.prevCpfEnc),
        prevPhone: await dec(h.guardianId, 'phone', h.prevPhoneEnc),
        kind: h.kind,
        isPayer: h.isPayer,
        receivesClinicalInfo: h.receivesClinicalInfo,
        validFrom: h.validFrom,
        validUntil: h.validUntil,
        endReason: h.endReason,
        actorId: h.actorId,
        occurredAt: h.occurredAt.toISOString(),
      })),
    ),
  };
  const counts = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, (v as readonly unknown[]).length])) as GuardiansCounts;
  return { data, counts };
}
