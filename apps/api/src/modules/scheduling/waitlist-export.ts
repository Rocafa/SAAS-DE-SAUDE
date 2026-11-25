import type { TenantId } from '@plataforma/shared';
import { asc, eq } from 'drizzle-orm';
import { waitlistEntries } from '../../db/schema';
import type { TenantTx } from '../../db/tenant-transaction';
import type { FieldCipher } from '../crypto/field-cipher';
import { observacaoRef } from './lista-espera-regras';

/**
 * Item da lista de espera no pacote da garantia de saída (G2, 1.25.0; migração 0102): os que estão na lista e os que
 * saíram e ainda não passaram pela retenção de 30 dias. A observação sai decifrada para a própria clínica.
 */
export interface ExportedWaitlistEntry {
  readonly id: string;
  readonly patientId: string;
  readonly professionalId: string | null;
  readonly weekdays: readonly number[];
  readonly period: string | null;
  readonly note: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly removedAt: string | null;
  readonly removedBy: string | null;
  readonly removalReason: string | null;
  readonly appointmentId: string | null;
}

/** `cifra()` só é chamada se houver observação (falha fechada sem a cifra, como o resto do pacote). */
export async function exportarListaDeEspera(
  tx: TenantTx,
  tenantId: TenantId,
  cifra: () => FieldCipher<TenantTx>,
): Promise<ExportedWaitlistEntry[]> {
  const linhas = await tx
    .select()
    .from(waitlistEntries)
    .where(eq(waitlistEntries.tenantId, tenantId))
    .orderBy(asc(waitlistEntries.createdAt), asc(waitlistEntries.id));
  if (linhas.some((w) => w.tenantId !== tenantId)) throw new Error('linha de outro tenant no export');
  const itens: ExportedWaitlistEntry[] = [];
  for (const w of linhas) {
    itens.push({
      id: w.id,
      patientId: w.patientId,
      professionalId: w.professionalId,
      weekdays: [...w.weekdays],
      period: w.period,
      note: w.noteEnc === null ? null : await cifra().decryptString(tx, observacaoRef(tenantId, w.id), w.noteEnc),
      createdBy: w.createdBy,
      createdAt: w.createdAt.toISOString(),
      removedAt: w.removedAt?.toISOString() ?? null,
      removedBy: w.removedBy,
      removalReason: w.removalReason,
      appointmentId: w.appointmentId,
    });
  }
  return itens;
}
