import type { TenantId } from '@plataforma/shared';
import { asc, eq } from 'drizzle-orm';
import { importBatches, importBatchRecords } from '../../db/schema';
import type { TenantTx } from '../../db/tenant-transaction';

/**
 * Importador no pacote G2 (migração 0024, schemaVersion 1.11.0), em `data.imports`.
 *
 * ENTRA: os lotes (`import_batches`: tipo, situação, ACEITE DO TERMO DE MIGRAÇÃO — versão, quem, quando —,
 * mapeamento por índice de coluna, contagens, hash da simulação aprovada, datas de cada etapa e a evidência
 * do descarte do arquivo bruto) e o livro do lote (`import_batch_records`: que paciente/agendamento cada
 * importação criou, em que linha). É a prova da instrução do controlador e a proveniência dos registros.
 *
 * FICA FORA (ver EXPORT_EXCLUDED_TABLES): o arquivo bruto (cópia transitória e cifrada do que a própria
 * clínica enviou; vive no máximo 7 dias e some ao aplicar — exportá-lo esticaria a vida dele) e as
 * divergências por linha (diagnóstico refeito a cada validação, só códigos; os totais estão no lote).
 */

const iso = (d: Date | null): string | null => d?.toISOString() ?? null;

export interface ExportedImports {
  readonly batches: readonly {
    id: string;
    kind: string;
    status: string;
    termVersion: string;
    termAcceptedBy: string;
    termAcceptedAt: string;
    fileFormat: string;
    byteSize: number;
    rowCount: number;
    columnCount: number;
    columnMapping: Record<string, number> | null;
    currentRun: number;
    validRows: number | null;
    errorRows: number | null;
    warningCount: number | null;
    plannedCreates: number | null;
    plannedSkips: number | null;
    simulationHash: string | null;
    createdRecords: number | null;
    rawExpiresAt: string;
    rawDiscardedAt: string | null;
    createdAt: string;
    createdBy: string;
    updatedAt: string;
    validatedAt: string | null;
    simulatedAt: string | null;
    appliedAt: string | null;
    appliedBy: string | null;
    undoneAt: string | null;
    undoneBy: string | null;
    expiredAt: string | null;
  }[];
  readonly batchRecords: readonly {
    batchId: string;
    entity: string;
    recordId: string;
    lineNumber: number;
    createdAt: string;
  }[];
}

export interface ImportCounts {
  readonly batches: number;
  readonly batchRecords: number;
}

export async function exportarImportacoes(tx: TenantTx, tenantId: TenantId): Promise<{ data: ExportedImports; counts: ImportCounts }> {
  const lotes = await tx.select().from(importBatches).where(eq(importBatches.tenantId, tenantId)).orderBy(asc(importBatches.createdAt), asc(importBatches.id));
  const livro = await tx
    .select()
    .from(importBatchRecords)
    .where(eq(importBatchRecords.tenantId, tenantId))
    .orderBy(asc(importBatchRecords.batchId), asc(importBatchRecords.lineNumber), asc(importBatchRecords.recordId));
  const data: ExportedImports = {
    batches: lotes.map((b) => ({
      id: b.id,
      kind: b.kind,
      status: b.status,
      termVersion: b.termVersion,
      termAcceptedBy: b.termAcceptedBy,
      termAcceptedAt: b.termAcceptedAt.toISOString(),
      fileFormat: b.fileFormat,
      byteSize: b.byteSize,
      rowCount: b.rowCount,
      columnCount: b.columnCount,
      columnMapping: b.columnMapping ?? null,
      currentRun: b.currentRun,
      validRows: b.validRows,
      errorRows: b.errorRows,
      warningCount: b.warningCount,
      plannedCreates: b.plannedCreates,
      plannedSkips: b.plannedSkips,
      simulationHash: b.simulationHash,
      createdRecords: b.createdRecords,
      rawExpiresAt: b.rawExpiresAt.toISOString(),
      rawDiscardedAt: iso(b.rawDiscardedAt),
      createdAt: b.createdAt.toISOString(),
      createdBy: b.createdBy,
      updatedAt: b.updatedAt.toISOString(),
      validatedAt: iso(b.validatedAt),
      simulatedAt: iso(b.simulatedAt),
      appliedAt: iso(b.appliedAt),
      appliedBy: b.appliedBy,
      undoneAt: iso(b.undoneAt),
      undoneBy: b.undoneBy,
      expiredAt: iso(b.expiredAt),
    })),
    batchRecords: livro.map((r) => ({
      batchId: r.batchId,
      entity: r.entity,
      recordId: r.recordId,
      lineNumber: r.lineNumber,
      createdAt: r.createdAt.toISOString(),
    })),
  };
  return { data, counts: { batches: data.batches.length, batchRecords: data.batchRecords.length } };
}
