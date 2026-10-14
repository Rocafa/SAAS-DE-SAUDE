import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuditAction, type RequestContext } from '@plataforma/shared';
import { and, asc, count, eq, gt, gte, inArray, lt, ne, sql, type SQL } from 'drizzle-orm';
import { ConflitoError, NaoEncontradoError, ProibidoError } from '../../common/erros-dominio';
import { escreverNaClinica, lerNaClinica } from '../../common/transacao-clinica';
import { appointments, appointmentTypes, patients, professionals, type AppointmentStatusDb } from '../../db/schema';
import type { TenantTx } from '../../db/tenant-transaction';
import { recordAudit } from '../audit/audit-log';
import { temPermissao, type Perfil } from '../auth/perfis';
import { estornarConsumosDoAgendamento } from '../insurance/consumos';
import { statusConsome } from '../insurance/guias-regras';
import { TenantDatabase } from '../tenancy/tenancy.module';
import {
  capacidadeDoHorario,
  dentroDaJanelaDeAtendimento,
  exigeAtendimento,
  janelaDeDias,
  noFusoDaClinica,
  paraInstante,
  STATUS_CLINICOS,
  STATUS_QUE_OCUPAM,
  STATUS_REMARCAVEIS,
  statusParaDb,
  statusParaFront,
  transicaoPermitida,
  type JanelaDeAtendimento,
  type StatusFront,
} from './agenda-regras';
import {
  MAXIMO_AGENDAMENTOS,
  type FiltroAgenda,
  type NovoAgendamento,
  type NovoProfissional,
  type NovoTipoAtendimento,
} from './scheduling.validation';

export interface AgendamentoDto {
  readonly id: string;
  readonly pacienteId: string;
  readonly profissionalId: string;
  readonly tipoId: string;
  /** AAAA-MM-DD e HH:MM no fuso da clínica (como o front usa). */
  readonly data: string;
  readonly hora: string;
  readonly minutos: number;
  /** Instantes ISO-8601 em UTC. */
  readonly inicio: string;
  readonly fim: string;
  readonly status: StatusFront;
  readonly encaixe: boolean;
}

export interface ProfissionalDto {
  readonly id: string;
  readonly nome: string;
  readonly especialidade: string;
  readonly capacidade: number;
}

export interface TipoAtendimentoDto {
  readonly id: string;
  readonly nome: string;
  readonly minutos: number;
  readonly capacidade: number;
}

const SCOPE = 'appointments';
const DIA_MS = 86_400_000;

/** Janela de atendimento e limiar do alerta de autoagendamento (provida pelo SchedulingModule). */
export const JANELA_DE_ATENDIMENTO = Symbol('JANELA_DE_ATENDIMENTO');

function paraDto(a: typeof appointments.$inferSelect): AgendamentoDto {
  const { data, hora } = noFusoDaClinica(a.startsAt);
  return {
    id: a.id,
    pacienteId: a.patientId,
    profissionalId: a.professionalId,
    tipoId: a.appointmentTypeId,
    data,
    hora,
    minutos: Math.round((a.endsAt.getTime() - a.startsAt.getTime()) / 60_000),
    inicio: a.startsAt.toISOString(),
    fim: a.endsAt.toISOString(),
    status: statusParaFront(a.status),
    encaixe: a.isWalkIn,
  };
}

/**
 * Agenda: listar por janela (dia/semana/profissional/paciente), criar (com capacidade por
 * profissional e tipo — AGD-01.5 — e encaixe), remarcar, mudar status, check-in e cancelar.
 * Mesmas garantias do PatientsService: clínica da sessão, política de assinatura e auditoria na
 * mesma transação (só ids). Agendamento revela vínculo paciente-profissional, então ler também audita.
 */
@Injectable()
export class SchedulingService {
  private readonly logger = new Logger('agenda');

  constructor(
    @Inject(TenantDatabase) private readonly db: TenantDatabase,
    @Inject(JANELA_DE_ATENDIMENTO) private readonly janela: JanelaDeAtendimento,
  ) {}

  listar(ctx: RequestContext, filtro: FiltroAgenda): Promise<{ itens: AgendamentoDto[]; truncado: boolean }> {
    return this.leitura(ctx, async (tx) => {
      const { inicio, fim } = janelaDeDias(filtro.de, filtro.ate);
      const condicoes: SQL[] = [
        eq(appointments.tenantId, ctx.tenantId),
        gte(appointments.startsAt, inicio),
        lt(appointments.startsAt, fim),
      ];
      if (filtro.profissionalId) condicoes.push(eq(appointments.professionalId, filtro.profissionalId));
      if (filtro.pacienteId) condicoes.push(eq(appointments.patientId, filtro.pacienteId));
      const linhas = await tx
        .select()
        .from(appointments)
        .where(and(...condicoes))
        .orderBy(asc(appointments.startsAt), asc(appointments.id))
        .limit(MAXIMO_AGENDAMENTOS + 1);
      const truncado = linhas.length > MAXIMO_AGENDAMENTOS;
      const itens = linhas.slice(0, MAXIMO_AGENDAMENTOS).map(paraDto);
      await recordAudit(tx, ctx, {
        action: AuditAction.Read,
        scope: SCOPE,
        metadata: { count: itens.length, ...(filtro.pacienteId ? { patient_id: filtro.pacienteId } : {}) },
      });
      return { itens, truncado };
    });
  }

  criar(ctx: RequestContext, dados: NovoAgendamento): Promise<AgendamentoDto> {
    return this.escrita(ctx, async (tx) => {
      const [paciente] = await tx
        .select({ ativo: patients.active })
        .from(patients)
        .where(and(eq(patients.tenantId, ctx.tenantId), eq(patients.id, dados.pacienteId)));
      if (!paciente) throw new NaoEncontradoError();
      if (!paciente.ativo) throw new ConflitoError('paciente_inativo');
      const profissional = await this.profissionalAtivo(tx, ctx, dados.profissionalId);
      const [tipo] = await tx
        .select()
        .from(appointmentTypes)
        .where(
          and(
            eq(appointmentTypes.tenantId, ctx.tenantId),
            eq(appointmentTypes.id, dados.tipoId),
            eq(appointmentTypes.active, true),
          ),
        );
      if (!tipo) throw new NaoEncontradoError();

      const inicio = paraInstante(dados.data, dados.hora);
      const fim = new Date(inicio.getTime() + tipo.durationMinutes * 60_000);
      await this.travarAgenda(tx, ctx, profissional.id);
      if (!dados.encaixe) {
        const ocupados = await this.ocupados(tx, ctx, profissional.id, inicio, fim);
        if (ocupados >= capacidadeDoHorario(profissional.capacity, tipo.capacity)) {
          throw new ConflitoError('horario_lotado');
        }
      }
      const [linha] = await tx
        .insert(appointments)
        .values({
          tenantId: ctx.tenantId,
          patientId: dados.pacienteId,
          professionalId: profissional.id,
          appointmentTypeId: tipo.id,
          startsAt: inicio,
          endsAt: fim,
          isWalkIn: dados.encaixe,
          // 0013: quem criou. Autoagendamento (criador = usuário do profissional) não dá vínculo de
          // cuidado antes do atendimento efetivo (V1 do parecer #61; vinculo-de-cuidado.ts).
          createdBy: ctx.userId,
        })
        .returning();
      if (!linha) throw new Error('falha ao criar agendamento');
      await recordAudit(tx, ctx, {
        action: AuditAction.Create,
        scope: SCOPE,
        metadata: {
          appointment_id: linha.id,
          patient_id: linha.patientId,
          walk_in: linha.isWalkIn,
          self_scheduled: profissional.userId === ctx.userId,
        },
      });
      return paraDto(linha);
    });
  }

  /** Devolve dia e hora anteriores (para o "Desfazer" do front). */
  remarcar(ctx: RequestContext, id: string, novo: { data: string; hora: string }): Promise<{ data: string; hora: string }> {
    return this.escrita(ctx, async (tx) => {
      const atual = await this.travarAgendamento(tx, ctx, id);
      if (!STATUS_REMARCAVEIS.includes(atual.status)) throw new ConflitoError('status_nao_permite');
      const duracao = atual.endsAt.getTime() - atual.startsAt.getTime();
      const inicio = paraInstante(novo.data, novo.hora);
      const fim = new Date(inicio.getTime() + duracao);
      await this.travarAgenda(tx, ctx, atual.professionalId);
      if (!atual.isWalkIn) {
        const [profissional] = await tx
          .select({ capacity: professionals.capacity })
          .from(professionals)
          .where(and(eq(professionals.tenantId, ctx.tenantId), eq(professionals.id, atual.professionalId)));
        const [tipo] = await tx
          .select({ capacity: appointmentTypes.capacity })
          .from(appointmentTypes)
          .where(and(eq(appointmentTypes.tenantId, ctx.tenantId), eq(appointmentTypes.id, atual.appointmentTypeId)));
        if (!profissional || !tipo) throw new NaoEncontradoError();
        const ocupados = await this.ocupados(tx, ctx, atual.professionalId, inicio, fim, atual.id);
        if (ocupados >= capacidadeDoHorario(profissional.capacity, tipo.capacity)) {
          throw new ConflitoError('horario_lotado');
        }
      }
      await tx
        .update(appointments)
        .set({ startsAt: inicio, endsAt: fim, updatedAt: new Date() })
        .where(and(eq(appointments.tenantId, ctx.tenantId), eq(appointments.id, id)));
      await recordAudit(tx, ctx, {
        action: AuditAction.Update,
        scope: SCOPE,
        metadata: { appointment_id: id, op: 'reschedule' },
      });
      return noFusoDaClinica(atual.startsAt);
    });
  }

  /** Devolve o status anterior (para o "Desfazer"). Check-in e cancelar são atalhos daqui. */
  alterarStatus(
    ctx: RequestContext,
    perfis: readonly Perfil[],
    id: string,
    novoFront: StatusFront,
  ): Promise<{ statusAnterior: StatusFront }> {
    return this.escrita(ctx, async (tx) => {
      const atual = await this.travarAgendamento(tx, ctx, id);
      const novo = statusParaDb(novoFront);
      if (atual.status === novo) return { statusAnterior: statusParaFront(atual.status) };
      if (!transicaoPermitida(atual.status, novo)) throw new ConflitoError('transicao_invalida');
      if (exigeAtendimento(atual.status, novo)) {
        if (!temPermissao(perfis, 'agenda:atender')) throw new ProibidoError();
        // R1 do parecer PR #57: o perfil não basta; só o profissional DO agendamento atende. O status
        // "em atendimento" será o gatilho do vínculo de cuidado e do escriba.
        const [profissional] = await tx
          .select({ userId: professionals.userId })
          .from(professionals)
          .where(and(eq(professionals.tenantId, ctx.tenantId), eq(professionals.id, atual.professionalId)));
        if (!profissional?.userId || profissional.userId !== ctx.userId) throw new ProibidoError();
      }
      const agora = new Date();
      // V1 do parecer #61: "em atendimento"/"atendido" só dentro da janela do horário. Consulta do
      // futuro ou de muito tempo atrás não vira atendimento (e, portanto, não vira vínculo).
      if (STATUS_CLINICOS.includes(novo) && !dentroDaJanelaDeAtendimento(atual.startsAt, atual.endsAt, agora, this.janela)) {
        throw new ConflitoError('fora_do_horario');
      }
      await tx
        .update(appointments)
        .set({
          status: novo,
          updatedAt: agora,
          ...(novo === 'cancelled' ? { cancelledAt: agora } : {}),
          ...(novo === 'checked_in' ? { checkedInAt: agora } : {}),
          ...(novo === 'scheduled' || novo === 'confirmed' ? { checkedInAt: null } : {}),
        })
        .where(and(eq(appointments.tenantId, ctx.tenantId), eq(appointments.id, id)));
      await recordAudit(tx, ctx, {
        action: AuditAction.Update,
        scope: SCOPE,
        metadata: { appointment_id: id, op: 'status', from: atual.status, to: novo },
      });
      // HU-CNV-003 "Estorno ao desfazer": a sessão deixou de ter acontecido (ex.: atendido -> faltou),
      // então o consumo de guia/pacote volta ao saldo, na mesma transação e com o agendamento travado.
      if (statusConsome(atual.status) && !statusConsome(novo)) await estornarConsumosDoAgendamento(tx, ctx, id);
      const autoagendado = atual.createdBy !== null && atual.createdBy === ctx.userId;
      if (autoagendado && STATUS_CLINICOS.includes(novo) && !STATUS_CLINICOS.includes(atual.status)) {
        await this.alertarAutoagendamento(tx, ctx, atual.professionalId, agora);
      }
      return { statusAnterior: statusParaFront(atual.status) };
    });
  }

  listarProfissionais(ctx: RequestContext): Promise<ProfissionalDto[]> {
    return this.leitura(ctx, async (tx) => {
      const linhas = await tx
        .select()
        .from(professionals)
        .where(and(eq(professionals.tenantId, ctx.tenantId), eq(professionals.active, true)))
        .orderBy(asc(professionals.displayName), asc(professionals.id));
      return linhas.map((p) => ({ id: p.id, nome: p.displayName, especialidade: p.specialty, capacidade: p.capacity }));
    });
  }

  criarProfissional(ctx: RequestContext, dados: NovoProfissional): Promise<ProfissionalDto> {
    return this.escrita(ctx, async (tx) => {
      const [p] = await tx
        .insert(professionals)
        .values({
          tenantId: ctx.tenantId,
          displayName: dados.nome,
          specialty: dados.especialidade,
          capacity: dados.capacidade,
          userId: dados.usuarioId ?? null,
        })
        .returning();
      if (!p) throw new Error('falha ao criar profissional');
      await recordAudit(tx, ctx, { action: AuditAction.Create, scope: 'professionals', metadata: { professional_id: p.id } });
      return { id: p.id, nome: p.displayName, especialidade: p.specialty, capacidade: p.capacity };
    });
  }

  listarTipos(ctx: RequestContext): Promise<TipoAtendimentoDto[]> {
    return this.leitura(ctx, async (tx) => {
      const linhas = await tx
        .select()
        .from(appointmentTypes)
        .where(and(eq(appointmentTypes.tenantId, ctx.tenantId), eq(appointmentTypes.active, true)))
        .orderBy(asc(appointmentTypes.name), asc(appointmentTypes.id));
      return linhas.map((t) => ({ id: t.id, nome: t.name, minutos: t.durationMinutes, capacidade: t.capacity }));
    });
  }

  criarTipo(ctx: RequestContext, dados: NovoTipoAtendimento): Promise<TipoAtendimentoDto> {
    return this.escrita(ctx, async (tx) => {
      const [t] = await tx
        .insert(appointmentTypes)
        .values({ tenantId: ctx.tenantId, name: dados.nome, durationMinutes: dados.minutos, capacity: dados.capacidade })
        .returning();
      if (!t) throw new Error('falha ao criar tipo de atendimento');
      await recordAudit(tx, ctx, { action: AuditAction.Create, scope: 'appointment_types', metadata: { type_id: t.id } });
      return { id: t.id, nome: t.name, minutos: t.durationMinutes, capacidade: t.capacity };
    });
  }

  private async profissionalAtivo(tx: TenantTx, ctx: RequestContext, id: string) {
    const [p] = await tx
      .select()
      .from(professionals)
      .where(and(eq(professionals.tenantId, ctx.tenantId), eq(professionals.id, id), eq(professionals.active, true)));
    if (!p) throw new NaoEncontradoError();
    return p;
  }

  /**
   * Serializa marcações do mesmo profissional (duas recepções no mesmo horário não passam as duas
   * da capacidade). Ordem das travas: agenda -> audit_chain (o INSERT da auditoria vem depois);
   * nenhum caminho toma audit_chain antes desta, então não há ciclo.
   */
  private async travarAgenda(tx: TenantTx, ctx: RequestContext, profissionalId: string): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`agenda:${ctx.tenantId}:${profissionalId}`}, 0))`);
  }

  private async travarAgendamento(tx: TenantTx, ctx: RequestContext, id: string) {
    const [a] = await tx
      .select()
      .from(appointments)
      .where(and(eq(appointments.tenantId, ctx.tenantId), eq(appointments.id, id)))
      .for('update');
    if (!a) throw new NaoEncontradoError();
    return a;
  }

  /** Agendamentos que ocupam vaga e se sobrepõem a [inicio, fim) para o profissional. */
  private async ocupados(
    tx: TenantTx,
    ctx: RequestContext,
    profissionalId: string,
    inicio: Date,
    fim: Date,
    exceto?: string,
  ): Promise<number> {
    const condicoes: SQL[] = [
      eq(appointments.tenantId, ctx.tenantId),
      eq(appointments.professionalId, profissionalId),
      inArray(appointments.status, STATUS_QUE_OCUPAM as AppointmentStatusDb[]),
      lt(appointments.startsAt, fim),
      gt(appointments.endsAt, inicio),
    ];
    if (exceto) condicoes.push(ne(appointments.id, exceto));
    const [r] = await tx.select({ n: count() }).from(appointments).where(and(...condicoes));
    return r?.n ?? 0;
  }

  /**
   * Autoagendamento atendido: o vínculo de cuidado nasce de um agendamento que o próprio profissional
   * criou para si (V1 do parecer #61). Grava `anomaly_alert` (regra `vinculo_autoagendado`) na MESMA
   * transação da mudança de status quando o número de pacientes distintos atendidos assim nas últimas
   * 24 h passa do limiar (padrão 0: todo caso alerta). Só regra, janela, limiar e contagem.
   */
  private async alertarAutoagendamento(tx: TenantTx, ctx: RequestContext, profissionalId: string, agora: Date): Promise<void> {
    const [linha] = await tx
      .select({ pacientes: sql<number>`count(distinct ${appointments.patientId})::int` })
      .from(appointments)
      .where(
        and(
          eq(appointments.tenantId, ctx.tenantId),
          eq(appointments.professionalId, profissionalId),
          eq(appointments.createdBy, ctx.userId),
          inArray(appointments.status, [...STATUS_CLINICOS]),
          gte(appointments.startsAt, new Date(agora.getTime() - DIA_MS)),
        ),
      );
    const contagem = linha?.pacientes ?? 0;
    const limiar = this.janela.alertaAutoagendadosPorDia;
    if (contagem <= limiar) return;
    this.logger.warn('ALERTA_ANOMALIA regra=vinculo_autoagendado');
    await recordAudit(tx, ctx, {
      action: AuditAction.AnomalyAlert,
      scope: SCOPE,
      metadata: { rule: 'vinculo_autoagendado', window_s: DIA_MS / 1000, threshold: limiar, count: contagem },
    });
  }

  private leitura<T>(ctx: RequestContext, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return lerNaClinica(this.db, ctx, fn);
  }

  private escrita<T>(ctx: RequestContext, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
    return escreverNaClinica(this.db, ctx, fn);
  }
}
