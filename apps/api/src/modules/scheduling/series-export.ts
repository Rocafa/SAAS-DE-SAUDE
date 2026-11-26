import type { TenantId } from '@plataforma/shared';
import { asc, eq } from 'drizzle-orm';
import { appointmentSeries } from '../../db/schema';
import type { TenantTx } from '../../db/tenant-transaction';

/**
 * Série de sessões recorrentes no pacote da garantia de saída (G2, 1.27.0; migração 0103): a regra inteira, o pacote
 * ligado e o cancelamento "a partir de". Os agendamentos gerados saem em `appointments[]` com `seriesId`.
 */
export interface ExportedAppointmentSeries {
  readonly id: string;
  readonly patientId: string;
  readonly professionalId: string;
  readonly appointmentTypeId: string;
  readonly packageId: string | null;
  readonly weekdays: readonly number[];
  readonly intervalWeeks: number;
  readonly startTime: string;
  readonly durationMinutes: number;
  readonly startsOn: string;
  readonly sessions: number | null;
  readonly endsOn: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly cancelledFrom: string | null;
  readonly cancelledAt: string | null;
  readonly cancelledBy: string | null;
}

export async function exportarSeries(tx: TenantTx, tenantId: TenantId): Promise<ExportedAppointmentSeries[]> {
  const linhas = await tx
    .select()
    .from(appointmentSeries)
    .where(eq(appointmentSeries.tenantId, tenantId))
    .orderBy(asc(appointmentSeries.createdAt), asc(appointmentSeries.id));
  if (linhas.some((s) => s.tenantId !== tenantId)) throw new Error('linha de outro tenant no export');
  return linhas.map((s) => ({
    id: s.id,
    patientId: s.patientId,
    professionalId: s.professionalId,
    appointmentTypeId: s.appointmentTypeId,
    packageId: s.packageId,
    weekdays: [...s.weekdays],
    intervalWeeks: s.intervalWeeks,
    startTime: s.startTime,
    durationMinutes: s.durationMinutes,
    startsOn: s.startsOn,
    sessions: s.sessions,
    endsOn: s.endsOn,
    createdBy: s.createdBy,
    createdAt: s.createdAt.toISOString(),
    cancelledFrom: s.cancelledFrom,
    cancelledAt: s.cancelledAt?.toISOString() ?? null,
    cancelledBy: s.cancelledBy,
  }));
}
