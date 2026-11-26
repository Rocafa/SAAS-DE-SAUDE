import { Inject, Injectable } from '@nestjs/common';
import { AuditAction, type RequestContext } from '@plataforma/shared';
import { and, asc, eq, gt, gte, isNull, lt, lte, or, type SQL } from 'drizzle-orm';
import { ConflitoError, NaoEncontradoError } from '../../common/erros-dominio';
import { escreverNaClinica, lerNaClinica } from '../../common/transacao-clinica';
import { clinicHolidays, professionals, professionalSchedules, scheduleBlocks, type ScheduleBlockReason } from '../../db/schema';
import type { TenantTx } from '../../db/tenant-transaction';
import { recordAudit } from '../audit/audit-log';
import { TenantDatabase } from '../tenancy/tenancy.module';
import { janelaDeDias, noFusoDaClinica, paraInstante } from './agenda-regras';
import { feriadosNacionais, problemaNasJanelas, type JanelaDaGrade } from './disponibilidade-regras';
import { agendamentosNoIntervalo, janelasDoProfissional, travarAgendaDaClinica, travarAgendaDoProfissional } from './disponibilidade';
import type { FiltroBloqueios, NovoBloqueio } from './disponibilidade.validation';

export interface BloqueioDto {
  readonly id: string;
  /** null = clínica inteira. */
  readonly profissionalId: string | null;
  /** Instantes ISO-8601 em UTC e, para exibição, data/hora no fuso da clínica. Fim exclusivo. */
  readonly inicio: string;
  readonly fim: string;
  readonly dataInicio: string;
  readonly horaInicio: string;
  readonly dataFim: string;
  readonly horaFim: string;
  readonly motivo: ScheduleBlockReason;
}

export interface FeriadoDto {
  readonly id: string;
  readonly data: string;
  readonly nome: string;
  readonly origem: 'nacional' | 'clinica';
}

/** Escopo da trilha: configuração da agenda (sem dado de paciente; só ids, contagens e códigos). */
const SCOPE = 'schedule_config';
const DIA_MS = 86_400_000;

function bloqueioDto(b: typeof scheduleBlocks.$inferSelect): BloqueioDto {
  const ini = noFusoDaClinica(b.startsAt);
  const fim = noFusoDaClinica(b.endsAt);
  return {
    id: b.id,
    profissionalId: b.professionalId,
    inicio: b.startsAt.toISOString(),
    fim: b.endsAt.toISOString(),
    dataInicio: ini.data,
    horaInicio: ini.hora,
    dataFim: fim.data,
    horaFim: fim.hora,
    motivo: b.reason,
  };
}

function feriadoDto(f: typeof clinicHolidays.$inferSelect): FeriadoDto {
  return { id: f.id, data: f.holidayDate, nome: f.name, origem: f.source };
}

/**
 * Configuração da disponibilidade da agenda (0100, HU-AGD-001/003): grade semanal por profissional, bloqueios (do
 * profissional ou da clínica) e feriados. A clínica é a da sessão (RLS); toda escrita audita na mesma transação, só com
 * ids, contagens e códigos. As leituras não trazem dado de paciente (lista LEITURA_SEM_DADO_DE_PACIENTE).
 */
@Injectable()
export class DisponibilidadeService {
  constructor(@Inject(TenantDatabase) private readonly db: TenantDatabase) {}

  lerGrade(ctx: RequestContext, profissionalId: string): Promise<JanelaDaGrade[]> {
    return lerNaClinica(this.db, ctx, async (tx) => {
      await this.profissionalDaClinica(tx, ctx, profissionalId);
      return janelasDoProfissional(tx, ctx, profissionalId);
    });
  }

  /** Substitui a grade inteira do profissional (desativa as janelas vigentes e insere as novas). */
  definirGrade(ctx: RequestContext, profissionalId: string, janelas: readonly JanelaDaGrade[]): Promise<JanelaDaGrade[]> {
    const problema = problemaNasJanelas(janelas);
    if (problema) throw new ConflitoError(problema);
    return escreverNaClinica(this.db, ctx, async (tx) => {
      await this.profissionalDaClinica(tx, ctx, profissionalId, true);
      await travarAgendaDoProfissional(tx, ctx, profissionalId);
      const desativadas = await tx
        .update(professionalSchedules)
        .set({ active: false })
        .where(
          and(
            eq(professionalSchedules.tenantId, ctx.tenantId),
            eq(professionalSchedules.professionalId, profissionalId),
            eq(professionalSchedules.active, true),
          ),
        )
        .returning({ id: professionalSchedules.id });
      if (janelas.length > 0) {
        await tx.insert(professionalSchedules).values(
          janelas.map((j) => ({
            tenantId: ctx.tenantId,
            professionalId: profissionalId,
            weekday: j.diaSemana,
            startTime: j.inicio,
            endTime: j.fim,
            slotMinutes: j.minutos,
            createdBy: ctx.userId,
          })),
        );
      }
      await recordAudit(tx, ctx, {
        action: AuditAction.Update,
        scope: SCOPE,
        metadata: { op: 'grade', professional_id: profissionalId, windows: janelas.length, deactivated: desativadas.length },
      });
      return janelasDoProfissional(tx, ctx, profissionalId);
    });
  }

  listarBloqueios(ctx: RequestContext, filtro: FiltroBloqueios): Promise<BloqueioDto[]> {
    return lerNaClinica(this.db, ctx, async (tx) => {
      const { inicio, fim } = janelaDeDias(filtro.de, filtro.ate);
      const condicoes: SQL[] = [
        eq(scheduleBlocks.tenantId, ctx.tenantId),
        isNull(scheduleBlocks.removedAt),
        lt(scheduleBlocks.startsAt, fim),
        gt(scheduleBlocks.endsAt, inicio),
      ];
      if (filtro.profissionalId) {
        condicoes.push(or(eq(scheduleBlocks.professionalId, filtro.profissionalId), isNull(scheduleBlocks.professionalId)) as SQL);
      }
      const linhas = await tx
        .select()
        .from(scheduleBlocks)
        .where(and(...condicoes))
        .orderBy(asc(scheduleBlocks.startsAt), asc(scheduleBlocks.id))
        .limit(1000);
      return linhas.map(bloqueioDto);
    });
  }

  criarBloqueio(ctx: RequestContext, dados: NovoBloqueio): Promise<BloqueioDto> {
    const inicio = paraInstante(dados.dataInicio, dados.horaInicio);
    const fim = dados.horaFim
      ? paraInstante(dados.dataFim, dados.horaFim)
      : new Date(paraInstante(dados.dataFim, '00:00').getTime() + DIA_MS);
    if (fim.getTime() <= inicio.getTime()) throw new ConflitoError('intervalo_invalido');
    if (fim.getTime() - inicio.getTime() > 366 * DIA_MS) throw new ConflitoError('intervalo_longo_demais');
    return escreverNaClinica(this.db, ctx, async (tx) => {
      // Sob a trava (do profissional, ou a exclusiva da clínica): bloqueio e marcação simultâneos não passam os dois.
      if (dados.profissionalId) {
        await this.profissionalDaClinica(tx, ctx, dados.profissionalId);
        await travarAgendaDoProfissional(tx, ctx, dados.profissionalId);
      } else {
        await travarAgendaDaClinica(tx, ctx, 'exclusiva');
      }
      // Agendamento já marcado no intervalo: remarque ou cancele antes (nada fica marcado dentro de um bloqueio).
      if ((await agendamentosNoIntervalo(tx, ctx, dados.profissionalId ?? null, inicio, fim)) > 0) {
        throw new ConflitoError('bloqueio_com_agendamentos');
      }
      const [b] = await tx
        .insert(scheduleBlocks)
        .values({
          tenantId: ctx.tenantId,
          professionalId: dados.profissionalId ?? null,
          startsAt: inicio,
          endsAt: fim,
          reason: dados.motivo,
          createdBy: ctx.userId,
        })
        .returning();
      if (!b) throw new Error('falha ao criar bloqueio');
      await recordAudit(tx, ctx, {
        action: AuditAction.Create,
        scope: SCOPE,
        metadata: {
          op: 'bloqueio',
          block_id: b.id,
          professional_id: b.professionalId,
          whole_clinic: b.professionalId === null,
          reason: b.reason,
          hours: Math.round((fim.getTime() - inicio.getTime()) / 3_600_000),
        },
      });
      return bloqueioDto(b);
    });
  }

  removerBloqueio(ctx: RequestContext, id: string): Promise<void> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      const [b] = await tx
        .update(scheduleBlocks)
        .set({ removedBy: ctx.userId, removedAt: new Date() })
        .where(and(eq(scheduleBlocks.tenantId, ctx.tenantId), eq(scheduleBlocks.id, id), isNull(scheduleBlocks.removedAt)))
        .returning({ id: scheduleBlocks.id });
      if (!b) throw new NaoEncontradoError();
      await recordAudit(tx, ctx, { action: AuditAction.Update, scope: SCOPE, metadata: { op: 'bloqueio_removido', block_id: id } });
    });
  }

  listarFeriados(ctx: RequestContext, ano: number): Promise<FeriadoDto[]> {
    return lerNaClinica(this.db, ctx, async (tx) => {
      const linhas = await tx
        .select()
        .from(clinicHolidays)
        .where(
          and(
            eq(clinicHolidays.tenantId, ctx.tenantId),
            isNull(clinicHolidays.removedAt),
            gte(clinicHolidays.holidayDate, `${ano}-01-01`),
            lte(clinicHolidays.holidayDate, `${ano}-12-31`),
          ),
        )
        .orderBy(asc(clinicHolidays.holidayDate));
      return linhas.map(feriadoDto);
    });
  }

  criarFeriado(ctx: RequestContext, dados: { data: string; nome: string }): Promise<FeriadoDto> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      await travarAgendaDaClinica(tx, ctx, 'exclusiva');
      if (await this.feriadoVigente(tx, ctx, dados.data)) throw new ConflitoError('feriado_ja_cadastrado');
      if (await this.temAgendamentoNoDia(tx, ctx, dados.data)) throw new ConflitoError('feriado_com_agendamentos');
      const [f] = await tx
        .insert(clinicHolidays)
        .values({ tenantId: ctx.tenantId, holidayDate: dados.data, name: dados.nome, source: 'clinica', createdBy: ctx.userId })
        .returning();
      if (!f) throw new Error('falha ao criar feriado');
      await recordAudit(tx, ctx, {
        action: AuditAction.Create,
        scope: SCOPE,
        metadata: { op: 'feriado', holiday_id: f.id, year: Number(dados.data.slice(0, 4)) },
      });
      return feriadoDto(f);
    });
  }

  /**
   * Pré-carrega os feriados nacionais do ano. Idempotente: pula as datas que já têm feriado vigente. Pula também (e
   * conta em `skipped_with_appointments` na trilha) as datas com agendamento marcado: a clínica remarca e carrega de novo.
   */
  carregarFeriadosNacionais(ctx: RequestContext, ano: number): Promise<FeriadoDto[]> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      await travarAgendaDaClinica(tx, ctx, 'exclusiva');
      let criados = 0;
      let comAgendamentos = 0;
      for (const n of feriadosNacionais(ano)) {
        if (await this.feriadoVigente(tx, ctx, n.data)) continue;
        if (await this.temAgendamentoNoDia(tx, ctx, n.data)) {
          comAgendamentos++;
          continue;
        }
        await tx
          .insert(clinicHolidays)
          .values({ tenantId: ctx.tenantId, holidayDate: n.data, name: n.nome, source: 'nacional', createdBy: ctx.userId });
        criados++;
      }
      await recordAudit(tx, ctx, { action: AuditAction.Create, scope: SCOPE, metadata: { op: 'feriados_nacionais', year: ano, created: criados, skipped_with_appointments: comAgendamentos },
      });
      const linhas = await tx
        .select()
        .from(clinicHolidays)
        .where(
          and(
            eq(clinicHolidays.tenantId, ctx.tenantId),
            isNull(clinicHolidays.removedAt),
            gte(clinicHolidays.holidayDate, `${ano}-01-01`),
            lte(clinicHolidays.holidayDate, `${ano}-12-31`),
          ),
        )
        .orderBy(asc(clinicHolidays.holidayDate));
      return linhas.map(feriadoDto);
    });
  }

  removerFeriado(ctx: RequestContext, id: string): Promise<void> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      const [f] = await tx
        .update(clinicHolidays)
        .set({ removedBy: ctx.userId, removedAt: new Date() })
        .where(and(eq(clinicHolidays.tenantId, ctx.tenantId), eq(clinicHolidays.id, id), isNull(clinicHolidays.removedAt)))
        .returning({ id: clinicHolidays.id });
      if (!f) throw new NaoEncontradoError();
      await recordAudit(tx, ctx, { action: AuditAction.Update, scope: SCOPE, metadata: { op: 'feriado_removido', holiday_id: id } });
    });
  }

  /** Há agendamento ocupando vaga na data (fuso da clínica), de qualquer profissional? Chamar sob a trava exclusiva. */
  private async temAgendamentoNoDia(tx: TenantTx, ctx: RequestContext, data: string): Promise<boolean> {
    const { inicio, fim } = janelaDeDias(data, data);
    return (await agendamentosNoIntervalo(tx, ctx, null, inicio, fim)) > 0;
  }

  private async feriadoVigente(tx: TenantTx, ctx: RequestContext, data: string): Promise<boolean> {
    const [f] = await tx
      .select({ id: clinicHolidays.id })
      .from(clinicHolidays)
      .where(and(eq(clinicHolidays.tenantId, ctx.tenantId), eq(clinicHolidays.holidayDate, data), isNull(clinicHolidays.removedAt)))
      .limit(1);
    return !!f;
  }

  /** Profissional da clínica da sessão (o RLS esconde o de outra clínica: 404). `ativo`: exige ativo. */
  private async profissionalDaClinica(tx: TenantTx, ctx: RequestContext, id: string, ativo = false): Promise<void> {
    const condicoes: SQL[] = [eq(professionals.tenantId, ctx.tenantId), eq(professionals.id, id)];
    if (ativo) condicoes.push(eq(professionals.active, true));
    const [p] = await tx.select({ id: professionals.id }).from(professionals).where(and(...condicoes));
    if (!p) throw new NaoEncontradoError();
  }
}
