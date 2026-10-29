import type { TenantId } from '@plataforma/shared';
import { asc, eq, sql } from 'drizzle-orm';
import { adolescentConfidentialityRequests, guardians, patientGuardianHistory, patientGuardians } from '../../db/schema';
import type { TenantTx } from '../../db/tenant-transaction';
import type { FieldCipher } from '../crypto/field-cipher';
import { guardianFieldRef, guardianLinkFieldRef, type GuardianEncryptedColumn, type GuardianLinkEncryptedColumn } from './guardian-fields';

/**
 * Responsáveis no pacote G2 (migração 0028, schemaVersion 1.13.0; 1.14.0 com a 0031): pessoas (nome, CPF e telefone
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
    discardedAt: string | null;
    /** 0048: lote de importação que criou a pessoa (null: cadastro ou pessoa que já existia). */
    importBatchId: string | null;
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
    clinicalInfoDecidedBy: string | null;
    clinicalInfoDecidedAt: string | null;
    clinicalInfoBasis: string | null;
    /** Curatela (kind = curador). Desde a 1.19.0 vem null para o apoiador: o termo dele sai em `supportTerm*`. */
    courtDecisionRef: string | null;
    curatorshipScope: string | null;
    /** 1.19.0 (0055): termo de decisão apoiada (kind = apoiador): referência da homologação e limites do apoio. */
    supportTermRef: string | null;
    supportTermScope: string | null;
    payerPatientAwareBy: string | null;
    payerPatientAwareAt: string | null;
    /** 1.19.0 (0055, B1): autorização expressa do paciente para o apoiador receber informação clínica. */
    patientAuthorizedBy: string | null;
    patientAuthorizedAt: string | null;
    /** 1.20.0 (0056): escopo da marca e exceção por risco ao pedido de sigilo do adolescente. */
    clinicalInfoScope: string | null;
    clinicalInfoRiskOverride: boolean;
    annulReason: string | null;
    discardAfter: string | null;
    /** 0034 (A4 do #67): eliminado com o prontuário e a data em que vence a guarda do prontuário do paciente. */
    eliminatedAt: string | null;
    recordRetentionUntil: string | null;
    /** 0048: lote de importação que criou o vínculo. */
    importBatchId: string | null;
  }[];
  readonly patientGuardianHistory: readonly {
    id: string;
    seq: number;
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
  /** 1.20.0 (0056, A1 c do #67): pedidos de sigilo do adolescente (só ids e datas; vínculo null = todos). */
  readonly adolescentConfidentialityRequests: readonly {
    id: string;
    patientId: string;
    guardianLinkId: string | null;
    requestedAt: string;
    requestedBy: string;
    revokedAt: string | null;
    revokedBy: string | null;
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
  const decVinculo = async (linkId: string, coluna: GuardianLinkEncryptedColumn, valor: string | null): Promise<string | null> => {
    if (valor === null) return null;
    return decifrar().decryptString(tx, guardianLinkFieldRef(tenantId, linkId, coluna), valor);
  };
  // A4 do #67: fim da guarda do prontuário do paciente (os vínculos a acompanham), uma consulta por paciente.
  const guardas = new Map<string, Promise<string | null>>();
  const guardaDe = (pacienteId: string): Promise<string | null> => {
    let g = guardas.get(pacienteId);
    if (!g) {
      g = tx
        .execute<{ ate: string | null }>(sql`select app_patient_record_retention_until(${tenantId}::uuid, ${pacienteId}::uuid)::text as ate`)
        .then((r) => r[0]?.ate ?? null);
      guardas.set(pacienteId, g);
    }
    return g;
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
      .orderBy(asc(patientGuardianHistory.seq)),
    tenantId,
  );

  const pedidosDeSigilo = soDaClinica(
    await tx
      .select()
      .from(adolescentConfidentialityRequests)
      .where(eq(adolescentConfidentialityRequests.tenantId, tenantId))
      .orderBy(asc(adolescentConfidentialityRequests.requestedAt), asc(adolescentConfidentialityRequests.id)),
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
        discardedAt: iso(g.discardedAt),
        importBatchId: g.importBatchId,
      })),
    ),
    patientGuardians: await Promise.all(vinculos.map(async (v) => ({
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
      clinicalInfoDecidedBy: v.clinicalInfoDecidedBy,
      clinicalInfoDecidedAt: iso(v.clinicalInfoDecidedAt),
      clinicalInfoBasis: await decVinculo(v.id, 'clinical_info_basis', v.clinicalInfoBasisEnc),
      // Curatela e termo de apoio dividem as colunas cifradas; o tipo decide em que campo cada um sai (R3 de 29/10).
      courtDecisionRef: v.kind === 'apoiador' ? null : await decVinculo(v.id, 'court_decision_ref', v.courtDecisionRefEnc),
      curatorshipScope: v.kind === 'apoiador' ? null : await decVinculo(v.id, 'curatorship_scope', v.curatorshipScopeEnc),
      supportTermRef: v.kind === 'apoiador' ? await decVinculo(v.id, 'court_decision_ref', v.courtDecisionRefEnc) : null,
      supportTermScope: v.kind === 'apoiador' ? await decVinculo(v.id, 'curatorship_scope', v.curatorshipScopeEnc) : null,
      payerPatientAwareBy: v.payerPatientAwareBy,
      payerPatientAwareAt: iso(v.payerPatientAwareAt),
      patientAuthorizedBy: v.patientAuthorizedBy,
      patientAuthorizedAt: iso(v.patientAuthorizedAt),
      clinicalInfoScope: v.clinicalInfoScope,
      clinicalInfoRiskOverride: v.clinicalInfoRiskOverride,
      annulReason: await decVinculo(v.id, 'annul_reason', v.annulReasonEnc),
      discardAfter: v.discardAfter,
      eliminatedAt: iso(v.eliminatedAt),
      recordRetentionUntil: await guardaDe(v.patientId),
      importBatchId: v.importBatchId,
    }))),
    patientGuardianHistory: await Promise.all(
      historico.map(async (h) => ({
        id: h.id,
        seq: h.seq,
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
    adolescentConfidentialityRequests: pedidosDeSigilo.map((p) => ({
      id: p.id,
      patientId: p.patientId,
      guardianLinkId: p.guardianLinkId,
      requestedAt: p.requestedAt.toISOString(),
      requestedBy: p.requestedBy,
      revokedAt: iso(p.revokedAt),
      revokedBy: p.revokedBy,
    })),
  };
  const counts = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, (v as readonly unknown[]).length])) as GuardiansCounts;
  return { data, counts };
}
