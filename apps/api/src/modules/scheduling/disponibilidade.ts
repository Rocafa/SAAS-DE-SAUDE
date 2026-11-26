import type { RequestContext } from '@plataforma/shared';
import { and, count, eq, gt, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { appointments, clinicHolidays, professionalSchedules, scheduleBlocks, type AppointmentStatusDb } from '../../db/schema';
import type { TenantTx } from '../../db/tenant-transaction';
import { STATUS_QUE_OCUPAM } from './agenda-regras';
import { datasDoHorario, motivoIndisponivel, type JanelaDaGrade, type MotivoIndisponivel } from './disponibilidade-regras';

/**
 * Travas da agenda (transacionais, soltas no COMMIT/ROLLBACK), em DOIS níveis e sempre nesta ordem (sem ciclo):
 * 1. agenda da CLÍNICA: compartilhada por quem mexe na agenda de um profissional (marcar, remarcar, trocar a grade,
 *    bloquear o profissional); EXCLUSIVA para o que vale para a clínica inteira (bloqueio da clínica e feriado).
 * 2. agenda do PROFISSIONAL: exclusiva (serializa marcações, capacidade, grade e bloqueio dele).
 * Depois delas vem audit_chain (o INSERT da auditoria). Quem cria um bloqueio ou feriado confere, sob a trava, se já
 * há agendamento ocupando o intervalo; quem marca confere bloqueio e feriado sob a trava. Assim, marcação e bloqueio
 * simultâneos nunca passam os dois com sobreposição: o segundo a pegar a trava enxerga o primeiro e recusa.
 */
export async function travarAgendaDaClinica(tx: TenantTx, ctx: RequestContext, modo: 'compartilhada' | 'exclusiva'): Promise<void> {
  const chave = `agenda:${ctx.tenantId}`;
  if (modo === 'exclusiva') await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${chave}, 0))`);
  else await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${chave}, 0))`);
}

/** Trava da agenda do profissional (com a da clínica, compartilhada, antes). */
export async function travarAgendaDoProfissional(tx: TenantTx, ctx: RequestContext, profissionalId: string): Promise<void> {
  await travarAgendaDaClinica(tx, ctx, 'compartilhada');
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`agenda:${ctx.tenantId}:${profissionalId}`}, 0))`);
}

/**
 * Agendamentos que ocupam vaga (inclusive encaixe) e se sobrepõem a [inicio, fim): do profissional, ou de todos os
 * profissionais se `profissionalId` for nulo. Chamar sob a trava correspondente.
 */
export async function agendamentosNoIntervalo(
  tx: TenantTx,
  ctx: RequestContext,
  profissionalId: string | null,
  inicio: Date,
  fim: Date,
): Promise<number> {
  const condicoes: SQL[] = [
    eq(appointments.tenantId, ctx.tenantId),
    inArray(appointments.status, STATUS_QUE_OCUPAM as AppointmentStatusDb[]),
    lt(appointments.startsAt, fim),
    gt(appointments.endsAt, inicio),
  ];
  if (profissionalId) condicoes.push(eq(appointments.professionalId, profissionalId));
  const [r] = await tx.select({ n: count() }).from(appointments).where(and(...condicoes));
  return r?.n ?? 0;
}

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
