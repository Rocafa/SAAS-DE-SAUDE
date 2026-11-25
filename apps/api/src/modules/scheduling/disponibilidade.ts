import type { RequestContext } from '@plataforma/shared';
import { and, eq, gt, inArray, isNull, lt, or } from 'drizzle-orm';
import { clinicHolidays, professionalSchedules, scheduleBlocks } from '../../db/schema';
import type { TenantTx } from '../../db/tenant-transaction';
import { datasDoHorario, motivoIndisponivel, type JanelaDaGrade, type MotivoIndisponivel } from './disponibilidade-regras';

/** Janelas ativas da grade do profissional (todas as da semana), na transação do chamador. */
export async function janelasDoProfissional(tx: TenantTx, ctx: RequestContext, profissionalId: string): Promise<JanelaDaGrade[]> {
  const linhas = await tx
    .select()
    .from(professionalSchedules)
    .where(
      and(
        eq(professionalSchedules.tenantId, ctx.tenantId),
        eq(professionalSchedules.professionalId, profissionalId),
        eq(professionalSchedules.active, true),
      ),
    );
  return linhas
    .map((l) => ({ diaSemana: l.weekday, inicio: l.startTime.slice(0, 5), fim: l.endTime.slice(0, 5), minutos: l.slotMinutes }))
    .sort((a, b) => a.diaSemana - b.diaSemana || a.inicio.localeCompare(b.inicio));
}

/**
 * O horário [inicio, fim) do profissional está indisponível? Feriado vigente da clínica numa das datas, bloqueio
 * vigente (do profissional ou da clínica inteira) que se sobreponha, ou fora da grade (regras e decisões em
 * disponibilidade-regras.ts). Só lê, na transação do chamador (a da marcação, que já trava a agenda do profissional).
 */
export async function motivoDeIndisponibilidade(
  tx: TenantTx,
  ctx: RequestContext,
  profissionalId: string,
  inicio: Date,
  fim: Date,
  encaixe: boolean,
): Promise<MotivoIndisponivel | null> {
  const [feriado] = await tx
    .select({ id: clinicHolidays.id })
    .from(clinicHolidays)
    .where(
      and(
        eq(clinicHolidays.tenantId, ctx.tenantId),
        inArray(clinicHolidays.holidayDate, datasDoHorario(inicio, fim)),
        isNull(clinicHolidays.removedAt),
      ),
    )
    .limit(1);
  const [bloqueio] = await tx
    .select({ id: scheduleBlocks.id })
    .from(scheduleBlocks)
    .where(
      and(
        eq(scheduleBlocks.tenantId, ctx.tenantId),
        isNull(scheduleBlocks.removedAt),
        or(eq(scheduleBlocks.professionalId, profissionalId), isNull(scheduleBlocks.professionalId)),
        lt(scheduleBlocks.startsAt, fim),
        gt(scheduleBlocks.endsAt, inicio),
      ),
    )
    .limit(1);
  const janelas = encaixe ? [] : await janelasDoProfissional(tx, ctx, profissionalId);
  return motivoIndisponivel({ feriado: !!feriado, bloqueado: !!bloqueio, janelas, encaixe, inicio, fim });
}
