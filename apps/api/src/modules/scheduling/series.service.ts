import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { AuditAction, type RequestContext } from '@plataforma/shared';
import { and, asc, count, desc, eq, gte, inArray, isNull, notExists, sql, type SQL } from 'drizzle-orm';
import { ConflitoError, NaoEncontradoError } from '../../common/erros-dominio';
import { escreverNaClinica, lerNaClinica } from '../../common/transacao-clinica';
import {
  appointments,
  appointmentSeries,
  appointmentTypes,
  packageSessions,
  patients,
  professionals,
  sessionPackages,
  type AppointmentStatusDb,
} from '../../db/schema';
import type { TenantTx } from '../../db/tenant-transaction';
import { recordAudit } from '../audit/audit-log';
import { estaVencida, hojeNaClinica } from '../insurance/guias-regras';
import { TenantDatabase } from '../tenancy/tenancy.module';
import { capacidadeDoHorario, horarioJaPassou, paraInstante, STATUS_QUE_OCUPAM, type JanelaDeAtendimento } from './agenda-regras';
import { agendamentoParaDto, JANELA_DE_ATENDIMENTO, papelDoCriador, SchedulingService, type AgendamentoDto } from './scheduling.service';
import {
  datasDaSerie,
  MAXIMO_SERIES,
  MAXIMO_SESSOES_DA_SERIE,
  resumirStatus,
  STATUS_CANCELAVEIS_DA_SERIE,
  type ResumoDaSerie,
} from './series-regras';
import type { FiltroSeries, NovaSerie } from './series.validation';

/** Série no contrato da API: a regra, o pacote e o resumo dos agendamentos por status. */
export interface SerieDto {
  readonly id: string;
  readonly pacienteId: string;
  readonly profissionalId: string;
  readonly tipoId: string;
  readonly pacoteId: string | null;
  readonly dias: readonly number[];
  readonly intervaloSemanas: number;
  readonly hora: string;
  readonly minutos: number;
  readonly dataInicial: string;
  readonly sessoes: number | null;
  readonly dataFinal: string | null;
  /** Data a partir da qual a série foi cancelada (null: ativa). */
  readonly canceladaAPartirDe: string | null;
  readonly criadaEm: string;
  readonly resumo: ResumoDaSerie;
}

export interface CancelamentoDeSerieDto {
  readonly serieId: string;
  readonly canceladaAPartirDe: string;
  /** Agendamentos cancelados agora (os futuros ainda não realizados a partir da data). */
  readonly cancelados: readonly string[];
}

/**
 * 409 `serie_com_conflito`: um ou mais horários da série estão lotados. Nada foi criado; `datas` diz quais
 * (AAAA-MM-DD no fuso da clínica). Só datas: nenhum dado de quem ocupa o horário.
 */
export class SerieComConflitoError extends ConflictException {
  constructor(readonly datas: readonly string[]) {
    super({ statusCode: 409, message: 'Conflito', codigo: 'serie_com_conflito', datas: [...datas] });
  }
}

const SCOPE = 'appointment_series';
const SCOPE_AGENDA = 'appointments';

type LinhaSerie = typeof appointmentSeries.$inferSelect;

function paraDto(s: LinhaSerie, resumo: ResumoDaSerie): SerieDto {
  return {
    id: s.id,
    pacienteId: s.patientId,
    profissionalId: s.professionalId,
    tipoId: s.appointmentTypeId,
    pacoteId: s.packageId,
    dias: [...s.weekdays],
    intervaloSemanas: s.intervalWeeks,
    hora: s.startTime,
    minutos: s.durationMinutes,
    dataInicial: s.startsOn,
    sessoes: s.sessions,
    dataFinal: s.endsOn,
    canceladaAPartirDe: s.cancelledFrom,
    criadaEm: s.createdAt.toISOString(),
    resumo,
  };
}

/**
 * Sessões recorrentes (HU-AGD-008, migração 0103): criar a série gera TODOS os agendamentos numa transação (tudo ou
 * nada: um horário lotado e nada é criado, com as datas em conflito na resposta), cancelar a partir de uma data
 * cancela os futuros ainda não realizados, e listar mostra a regra e o resumo. Com pacote, o número de sessões não
 * passa do saldo LIVRE (total − usadas − sessões já reservadas por outras séries do pacote e ainda não consumidas),
 * conferido sob a trava do pacote. O consumo segue o de hoje (POST /pacotes/:id/consumos, por sessão realizada).
 * Auditoria na mesma transação, só com ids e contagens. Perfis: recepção e admin (o banco confere também).
 */
@Injectable()
export class SeriesService {
  constructor(
    @Inject(TenantDatabase) private readonly db: TenantDatabase,
    @Inject(SchedulingService) private readonly agenda: SchedulingService,
    @Inject(JANELA_DE_ATENDIMENTO) private readonly janela: JanelaDeAtendimento,
  ) {}

  listar(ctx: RequestContext, filtro: FiltroSeries): Promise<{ itens: SerieDto[]; truncado: boolean }> {
    return lerNaClinica(this.db, ctx, async (tx) => {
      const condicoes: SQL[] = [eq(appointmentSeries.tenantId, ctx.tenantId)];
      if (filtro.pacienteId) condicoes.push(eq(appointmentSeries.patientId, filtro.pacienteId));
      if (filtro.profissionalId) condicoes.push(eq(appointmentSeries.professionalId, filtro.profissionalId));
      if (filtro.pacoteId) condicoes.push(eq(appointmentSeries.packageId, filtro.pacoteId));
      const linhas = await tx
        .select()
        .from(appointmentSeries)
        .where(and(...condicoes))
        .orderBy(desc(appointmentSeries.createdAt), asc(appointmentSeries.id))
        .limit(MAXIMO_SERIES + 1);
      const series = linhas.slice(0, MAXIMO_SERIES);
      const porSerie = await this.resumos(
        tx,
        ctx,
        series.map((s) => s.id),
      );
      const itens = series.map((s) => paraDto(s, porSerie.get(s.id) ?? resumirStatus([])));
      // Série revela vínculo paciente-profissional (como a agenda): a leitura é auditada.
      await recordAudit(tx, ctx, {
        action: AuditAction.Read,
        scope: SCOPE,
        metadata: {
          count: itens.length,
          ...(filtro.pacienteId ? { patient_id: filtro.pacienteId } : {}),
          ...(filtro.profissionalId ? { professional_id: filtro.profissionalId } : {}),
          ...(filtro.pacoteId ? { package_id: filtro.pacoteId } : {}),
        },
      });
      return { itens, truncado: linhas.length > MAXIMO_SERIES };
    });
  }

  criar(ctx: RequestContext, dados: NovaSerie): Promise<{ serie: SerieDto; agendamentos: AgendamentoDto[] }> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      const [paciente] = await tx
        .select({ ativo: patients.active })
        .from(patients)
        .where(and(eq(patients.tenantId, ctx.tenantId), eq(patients.id, dados.pacienteId)));
      if (!paciente) throw new NaoEncontradoError();
      if (!paciente.ativo) throw new ConflitoError('paciente_inativo');
      const [profissional] = await tx
        .select()
        .from(professionals)
        .where(and(eq(professionals.tenantId, ctx.tenantId), eq(professionals.id, dados.profissionalId), eq(professionals.active, true)));
      if (!profissional) throw new NaoEncontradoError();
      const [tipo] = await tx
        .select()
        .from(appointmentTypes)
        .where(and(eq(appointmentTypes.tenantId, ctx.tenantId), eq(appointmentTypes.id, dados.tipoId), eq(appointmentTypes.active, true)));
      if (!tipo) throw new NaoEncontradoError();

      const datas = datasDaSerie(dados);
      if (datas.length === 0) throw new ConflitoError('serie_sem_sessoes');
      if (datas.length > MAXIMO_SESSOES_DA_SERIE) throw new ConflitoError('serie_longa_demais');
      const minutos = dados.minutos ?? tipo.durationMinutes;
      const horarios = datas.map((data) => {
        const inicio = paraInstante(data, dados.hora);
        return { data, inicio, fim: new Date(inicio.getTime() + minutos * 60_000) };
      });
      // Mesma regra da marcação avulsa (R7 do #61): nada no passado.
      const agora = new Date();
      if (horarios.some((h) => horarioJaPassou(h.inicio, agora, this.janela))) throw new ConflitoError('horario_no_passado');

      // Pacote primeiro (trava a linha: duas séries no mesmo pacote não passam as duas do saldo), depois a agenda.
      if (dados.pacoteId) await this.conferirPacote(tx, ctx, dados, datas);

      await this.agenda.travarAgenda(tx, ctx, profissional.id);
      const capacidade = capacidadeDoHorario(profissional.capacity, tipo.capacity);
      const conflitos: string[] = [];
      for (const h of horarios) {
        if ((await this.agenda.vagasOcupadas(tx, ctx, profissional.id, h.inicio, h.fim)) >= capacidade) conflitos.push(h.data);
      }
      if (conflitos.length > 0) throw new SerieComConflitoError(conflitos);

      const [serie] = await tx
        .insert(appointmentSeries)
        .values({
          tenantId: ctx.tenantId,
          patientId: dados.pacienteId,
          professionalId: profissional.id,
          appointmentTypeId: tipo.id,
          packageId: dados.pacoteId ?? null,
          weekdays: [...dados.dias],
          intervalWeeks: dados.intervaloSemanas,
          startTime: dados.hora,
          durationMinutes: minutos,
          startsOn: dados.dataInicial,
          sessions: dados.sessoes ?? null,
          endsOn: dados.dataFinal ?? null,
          createdBy: ctx.userId,
        })
        .returning();
      if (!serie) throw new Error('falha ao criar série');
      const linhas = await tx
        .insert(appointments)
        .values(
          horarios.map((h) => ({
            tenantId: ctx.tenantId,
            patientId: dados.pacienteId,
            professionalId: profissional.id,
            appointmentTypeId: tipo.id,
            startsAt: h.inicio,
            endsAt: h.fim,
            isWalkIn: false,
            createdBy: ctx.userId,
            seriesId: serie.id,
          })),
        )
        .returning();
      if (linhas.length !== horarios.length) throw new Error('falha ao criar agendamentos da série');
      linhas.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
      await recordAudit(tx, ctx, {
        action: AuditAction.Create,
        scope: SCOPE,
        metadata: {
          series_id: serie.id,
          patient_id: serie.patientId,
          professional_id: serie.professionalId,
          package_id: serie.packageId,
          count: linhas.length,
          creator_role: papelDoCriador(ctx.roles),
        },
      });
      // Cada agendamento tem a sua linha de criação na trilha, como a marcação avulsa (o vínculo nasce de cada um).
      for (const a of linhas) {
        await recordAudit(tx, ctx, {
          action: AuditAction.Create,
          scope: SCOPE_AGENDA,
          metadata: {
            appointment_id: a.id,
            patient_id: a.patientId,
            series_id: serie.id,
            walk_in: false,
            self_scheduled: profissional.userId === ctx.userId,
            creator_role: papelDoCriador(ctx.roles),
          },
        });
      }
      return { serie: paraDto(serie, { agendadas: linhas.length, realizadas: 0, faltas: 0, canceladas: 0 }), agendamentos: linhas.map(agendamentoParaDto) };
    });
  }

  /**
   * Cancela a série a partir de `aPartirDe` (calendário da clínica): os agendamentos da série desse dia em diante que
   * ainda não começaram e ainda não aconteceram (agendado/confirmado) viram cancelados; check-in, atendimento, falta e
   * os anteriores à data ficam intactos. A data só recua (cancelar de novo com data posterior não desfaz nada).
   * Idempotente.
   */
  cancelarAPartirDe(ctx: RequestContext, id: string, aPartirDe: string): Promise<CancelamentoDeSerieDto> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      const [serie] = await tx
        .select()
        .from(appointmentSeries)
        .where(and(eq(appointmentSeries.tenantId, ctx.tenantId), eq(appointmentSeries.id, id)))
        .for('update');
      if (!serie) throw new NaoEncontradoError();
      const agora = new Date();
      const corte = paraInstante(aPartirDe, '00:00');
      const desde = corte.getTime() > agora.getTime() ? corte : agora;
      // Trava em ordem de horário (mesma ordem em toda chamada: sem ciclo entre dois cancelamentos).
      const alvos = await tx
        .select({ id: appointments.id, status: appointments.status })
        .from(appointments)
        .where(
          and(
            eq(appointments.tenantId, ctx.tenantId),
            eq(appointments.seriesId, id),
            gte(appointments.startsAt, desde),
            inArray(appointments.status, STATUS_CANCELAVEIS_DA_SERIE as AppointmentStatusDb[]),
          ),
        )
        .orderBy(asc(appointments.startsAt), asc(appointments.id))
        .for('update');
      const efetiva = serie.cancelledFrom !== null && serie.cancelledFrom <= aPartirDe ? serie.cancelledFrom : aPartirDe;
      if (efetiva !== serie.cancelledFrom) {
        await tx
          .update(appointmentSeries)
          .set({ cancelledFrom: efetiva, cancelledAt: agora, cancelledBy: ctx.userId })
          .where(and(eq(appointmentSeries.tenantId, ctx.tenantId), eq(appointmentSeries.id, id)));
      }
      if (alvos.length > 0) {
        await tx
          .update(appointments)
          .set({ status: 'cancelled', cancelledAt: agora, updatedAt: agora })
          .where(
            and(
              eq(appointments.tenantId, ctx.tenantId),
              inArray(
                appointments.id,
                alvos.map((a) => a.id),
              ),
            ),
          );
      }
      await recordAudit(tx, ctx, {
        action: AuditAction.Update,
        scope: SCOPE,
        // A data fica na série (cancelled_from): na trilha, data com 8 dígitos seria recusada como possível dado pessoal.
        metadata: { series_id: id, patient_id: serie.patientId, op: 'cancel_from', moved: efetiva !== serie.cancelledFrom, count: alvos.length },
      });
      // Cada agendamento cancelado tem a sua linha, como o cancelamento avulso (op status).
      for (const a of alvos) {
        await recordAudit(tx, ctx, {
          action: AuditAction.Update,
          scope: SCOPE_AGENDA,
          metadata: { appointment_id: a.id, op: 'status', from: a.status, to: 'cancelled', series_id: id },
        });
      }
      return { serieId: id, canceladaAPartirDe: efetiva, cancelados: alvos.map((a) => a.id) };
    });
  }

  /**
   * Regras do consumo de hoje (PacotesService.consumir) aplicadas à série inteira, ANTES de marcar: pacote ativo, do
   * mesmo paciente, do mesmo tipo e profissional quando o pacote os fixa, não vencido (nem antes da última sessão) e
   * com saldo LIVRE para todas as sessões. Trava o pacote até o fim da transação.
   */
  private async conferirPacote(tx: TenantTx, ctx: RequestContext, dados: NovaSerie, datas: readonly string[]): Promise<void> {
    const [pacote] = await tx
      .select()
      .from(sessionPackages)
      .where(and(eq(sessionPackages.tenantId, ctx.tenantId), eq(sessionPackages.id, dados.pacoteId as string)))
      .for('update');
    if (!pacote) throw new NaoEncontradoError();
    if (pacote.status === 'cancelled') throw new ConflitoError('pacote_cancelado');
    if (pacote.patientId !== dados.pacienteId) throw new ConflitoError('paciente_diferente');
    if (pacote.appointmentTypeId && pacote.appointmentTypeId !== dados.tipoId) throw new ConflitoError('tipo_diferente');
    if (pacote.professionalId && pacote.professionalId !== dados.profissionalId) throw new ConflitoError('profissional_diferente');
    if (estaVencida(pacote.validUntil, hojeNaClinica())) throw new ConflitoError('pacote_vencido');
    const ultima = datas[datas.length - 1] as string;
    if (estaVencida(pacote.validUntil, ultima)) throw new ConflitoError('pacote_vence_antes_da_serie');
    const reservadas = await this.sessoesReservadas(tx, ctx, pacote.id);
    if (datas.length > pacote.totalSessions - pacote.usedSessions - reservadas) throw new ConflitoError('pacote_sem_saldo');
  }

  /**
   * Sessões de séries deste pacote que ainda ocupam horário e ainda não consumiram o pacote (as consumidas já estão em
   * `used_sessions`). Canceladas e faltas liberam o saldo.
   */
  private async sessoesReservadas(tx: TenantTx, ctx: RequestContext, pacoteId: string): Promise<number> {
    const [r] = await tx
      .select({ n: count() })
      .from(appointments)
      .innerJoin(
        appointmentSeries,
        and(eq(appointmentSeries.tenantId, appointments.tenantId), eq(appointmentSeries.id, appointments.seriesId)),
      )
      .where(
        and(
          eq(appointments.tenantId, ctx.tenantId),
          eq(appointmentSeries.packageId, pacoteId),
          inArray(appointments.status, STATUS_QUE_OCUPAM as AppointmentStatusDb[]),
          notExists(
            tx
              .select({ um: sql`1` })
              .from(packageSessions)
              .where(
                and(
                  eq(packageSessions.tenantId, appointments.tenantId),
                  eq(packageSessions.appointmentId, appointments.id),
                  isNull(packageSessions.reversedAt),
                ),
              ),
          ),
        ),
      );
    return r?.n ?? 0;
  }

  private async resumos(tx: TenantTx, ctx: RequestContext, ids: readonly string[]): Promise<Map<string, ResumoDaSerie>> {
    const mapa = new Map<string, ResumoDaSerie>();
    if (ids.length === 0) return mapa;
    const linhas = await tx
      .select({ serie: appointments.seriesId, status: appointments.status, n: count() })
      .from(appointments)
      .where(and(eq(appointments.tenantId, ctx.tenantId), inArray(appointments.seriesId, [...ids])))
      .groupBy(appointments.seriesId, appointments.status);
    const porSerie = new Map<string, { status: AppointmentStatusDb; n: number }[]>();
    for (const l of linhas) {
      if (!l.serie) continue;
      const lista = porSerie.get(l.serie) ?? [];
      lista.push({ status: l.status, n: l.n });
      porSerie.set(l.serie, lista);
    }
    for (const [id, lista] of porSerie) mapa.set(id, resumirStatus(lista));
    return mapa;
  }
}
