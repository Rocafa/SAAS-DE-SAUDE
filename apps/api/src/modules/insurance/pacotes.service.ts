import { Inject, Injectable } from '@nestjs/common';
import { AuditAction, type RequestContext } from '@plataforma/shared';
import { and, asc, desc, eq, isNull, ne, sql, type SQL } from 'drizzle-orm';
import { ConflitoError, NaoEncontradoError } from '../../common/erros-dominio';
import { escreverNaClinica, lerNaClinica } from '../../common/transacao-clinica';
import {
  appointments,
  appointmentTypes,
  charges,
  packageProfessionalChanges,
  packageSessions,
  patients,
  professionals,
  sessionPackages,
  type PackageProfessionalChangeReason,
  type PackageReversalReason,
} from '../../db/schema';
import type { TenantTx } from '../../db/tenant-transaction';
import { recordAudit } from '../audit/audit-log';
import { TenantDatabase } from '../tenancy/tenancy.module';
import { consumoAtivoDoAgendamento, SCOPE_CONSUMO_PACOTE, travarAgendamento } from './consumos';
import {
  alertasDe,
  estaVencida,
  hojeNaClinica,
  LIMIARES_PACOTE,
  saldoDe,
  situacaoDe,
  statusConsome,
  type Alerta,
  type Situacao,
} from './guias-regras';
import type { FiltroPacotes, NovoPacote } from './guias.validation';

/** Contrato `Pacote` do front ({id, pacienteId, nome, total, usadas}) + saldo, situação e alertas. */
export interface PacoteDto {
  readonly id: string;
  readonly pacienteId: string;
  readonly nome: string;
  readonly total: number;
  readonly usadas: number;
  readonly saldo: number;
  readonly tipoId: string | null;
  readonly validade: string | null;
  /** R13 do #65: profissional fixado na venda (null: pacote antigo, regra da 0021). */
  readonly profissionalId: string | null;
  readonly situacao: Situacao;
  readonly alertas: readonly Alerta[];
}

export interface ConsumoPacoteDto {
  readonly id: string;
  readonly agendamentoId: string;
  readonly consumidoEm: string;
  readonly estornadoEm: string | null;
  readonly motivoEstorno: PackageReversalReason | null;
}

export interface ResultadoConsumoPacoteDto {
  readonly consumoId: string;
  readonly pacoteId: string;
  readonly usadas: number;
  readonly saldo: number;
  readonly situacao: Situacao;
}

const SCOPE = 'session_packages';
const MAXIMO_PACOTES = 500;

type LinhaPacote = typeof sessionPackages.$inferSelect;

function base(p: LinhaPacote) {
  return { cancelada: p.status === 'cancelled', total: p.totalSessions, usadas: p.usedSessions, validade: p.validUntil };
}

function paraDto(p: LinhaPacote, hoje: string): PacoteDto {
  const b = base(p);
  return {
    id: p.id,
    pacienteId: p.patientId,
    nome: p.name,
    total: p.totalSessions,
    usadas: p.usedSessions,
    saldo: saldoDe(b),
    tipoId: p.appointmentTypeId,
    validade: p.validUntil,
    profissionalId: p.professionalId,
    situacao: situacaoDe(b, hoje),
    alertas: alertasDe(b, hoje, LIMIARES_PACOTE),
  };
}

/**
 * Pacotes particulares de sessões (FIN-01.5 / HU-FIN-004): criar, consumir, estornar, saldo e
 * histórico. Saldo nunca negativo: consumo sob trava (agendamento -> pacote) e CHECK no banco. A
 * cobrança do pacote (FIN-01.8) fica para o M4. Auditoria só com ids e contagens.
 */
@Injectable()
export class PacotesService {
  constructor(@Inject(TenantDatabase) private readonly db: TenantDatabase) {}

  listar(ctx: RequestContext, filtro: FiltroPacotes): Promise<{ itens: PacoteDto[]; truncado: boolean }> {
    return lerNaClinica(this.db, ctx, async (tx) => {
      const condicoes: SQL[] = [eq(sessionPackages.tenantId, ctx.tenantId)];
      if (filtro.pacienteId) condicoes.push(eq(sessionPackages.patientId, filtro.pacienteId));
      if (filtro.situacao === 'ativos') condicoes.push(eq(sessionPackages.status, 'active'));
      const linhas = await tx
        .select()
        .from(sessionPackages)
        .where(and(...condicoes))
        .orderBy(desc(sessionPackages.createdAt), asc(sessionPackages.id))
        .limit(MAXIMO_PACOTES + 1);
      const hoje = hojeNaClinica();
      const itens = linhas.slice(0, MAXIMO_PACOTES).map((p) => paraDto(p, hoje));
      await recordAudit(tx, ctx, {
        action: AuditAction.Read,
        scope: SCOPE,
        metadata: { count: itens.length, ...(filtro.pacienteId ? { patient_id: filtro.pacienteId } : {}) },
      });
      return { itens, truncado: linhas.length > MAXIMO_PACOTES };
    });
  }

  obter(ctx: RequestContext, id: string): Promise<PacoteDto> {
    return lerNaClinica(this.db, ctx, async (tx) => {
      const [p] = await tx
        .select()
        .from(sessionPackages)
        .where(and(eq(sessionPackages.tenantId, ctx.tenantId), eq(sessionPackages.id, id)));
      if (!p) throw new NaoEncontradoError();
      await recordAudit(tx, ctx, { action: AuditAction.Read, scope: SCOPE, metadata: { package_id: id, patient_id: p.patientId } });
      return paraDto(p, hojeNaClinica());
    });
  }

  criar(ctx: RequestContext, dados: NovoPacote): Promise<PacoteDto> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      const [paciente] = await tx
        .select({ ativo: patients.active })
        .from(patients)
        .where(and(eq(patients.tenantId, ctx.tenantId), eq(patients.id, dados.pacienteId)));
      if (!paciente) throw new NaoEncontradoError();
      if (!paciente.ativo) throw new ConflitoError('paciente_inativo');
      if (dados.tipoId) {
        const [tipo] = await tx
          .select({ id: appointmentTypes.id })
          .from(appointmentTypes)
          .where(and(eq(appointmentTypes.tenantId, ctx.tenantId), eq(appointmentTypes.id, dados.tipoId)));
        if (!tipo) throw new NaoEncontradoError();
      }
      if (dados.profissionalId) await this.exigirProfissionalAtivo(tx, ctx, dados.profissionalId);
      const [p] = await tx
        .insert(sessionPackages)
        .values({
          tenantId: ctx.tenantId,
          patientId: dados.pacienteId,
          appointmentTypeId: dados.tipoId ?? null,
          name: dados.nome,
          totalSessions: dados.total,
          validUntil: dados.validade ?? null,
          professionalId: dados.profissionalId ?? null,
        })
        .returning();
      if (!p) throw new Error('falha ao criar pacote');
      await recordAudit(tx, ctx, {
        action: AuditAction.Create,
        scope: SCOPE,
        metadata: { package_id: p.id, patient_id: p.patientId, sessions: p.totalSessions, professional_id: p.professionalId },
      });
      return paraDto(p, hojeNaClinica());
    });
  }

  /** Cancela (nunca apaga); o histórico fica. Idempotente. */
  cancelar(ctx: RequestContext, id: string): Promise<PacoteDto> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      const atual = await this.travarPacote(tx, ctx, id);
      if (atual.status === 'cancelled') return paraDto(atual, hojeNaClinica());
      const agora = new Date();
      const [p] = await tx
        .update(sessionPackages)
        .set({ status: 'cancelled', cancelledAt: agora, updatedAt: agora })
        .where(and(eq(sessionPackages.tenantId, ctx.tenantId), eq(sessionPackages.id, id)))
        .returning();
      if (!p) throw new NaoEncontradoError();
      await recordAudit(tx, ctx, { action: AuditAction.Update, scope: SCOPE, metadata: { package_id: id, changed: 'status' } });
      return paraDto(p, hojeNaClinica());
    });
  }

  consumir(ctx: RequestContext, pacoteId: string, agendamentoId: string): Promise<ResultadoConsumoPacoteDto> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      const agendamento = await travarAgendamento(tx, ctx, agendamentoId);
      const pacote = await this.travarPacote(tx, ctx, pacoteId);
      if (pacote.status === 'cancelled') throw new ConflitoError('pacote_cancelado');
      if (agendamento.patientId !== pacote.patientId) throw new ConflitoError('paciente_diferente');
      if (pacote.appointmentTypeId && agendamento.appointmentTypeId !== pacote.appointmentTypeId) {
        throw new ConflitoError('tipo_diferente');
      }
      // R13 do #65: com profissional fixado na venda, só sessões dele consomem o pacote (o banco confere).
      if (pacote.professionalId && agendamento.professionalId !== pacote.professionalId) throw new ConflitoError('profissional_diferente');
      // R14 do #65: com cobrança PF viva do pacote em nome de P, só agendamento de P consome (o banco confere).
      const [pfDeOutro] = await tx
        .select({ id: charges.id })
        .from(charges)
        .where(
          and(
            eq(charges.tenantId, ctx.tenantId),
            eq(charges.packageId, pacote.id),
            eq(charges.attendanceKind, 'pf'),
            ne(charges.status, 'cancelled'),
            ne(charges.professionalId, agendamento.professionalId),
          ),
        )
        .limit(1);
      if (pfDeOutro) throw new ConflitoError('profissional_diferente');
      if (!statusConsome(agendamento.status)) throw new ConflitoError('agendamento_sem_sessao');
      const ativo = await consumoAtivoDoAgendamento(tx, ctx, agendamento.id);
      if (ativo.guia || ativo.pacote) throw new ConflitoError('sessao_ja_consumida');
      if (estaVencida(pacote.validUntil, hojeNaClinica())) throw new ConflitoError('pacote_vencido');
      if (pacote.usedSessions >= pacote.totalSessions) throw new ConflitoError('pacote_sem_saldo');

      const agora = new Date();
      const [consumo] = await tx
        .insert(packageSessions)
        .values({ tenantId: ctx.tenantId, packageId: pacote.id, appointmentId: agendamento.id, consumedAt: agora, consumedBy: ctx.userId })
        .returning({ id: packageSessions.id });
      const [p] = await tx
        .update(sessionPackages)
        .set({ usedSessions: sql`${sessionPackages.usedSessions} + 1`, updatedAt: agora })
        .where(and(eq(sessionPackages.tenantId, ctx.tenantId), eq(sessionPackages.id, pacote.id)))
        .returning();
      if (!consumo || !p) throw new Error('falha ao consumir pacote');
      await recordAudit(tx, ctx, {
        action: AuditAction.Update,
        scope: SCOPE_CONSUMO_PACOTE,
        metadata: { package_session_id: consumo.id, package_id: pacote.id, appointment_id: agendamento.id, op: 'consume' },
      });
      return this.resultado(consumo.id, p);
    });
  }

  /**
   * R13 do #65: troca do profissional fixado na venda. Só com motivo (enum), registrada em
   * package_professional_changes na mesma transação (o banco recusa a troca sem o registro) e auditada.
   * Recusada (409 `pacote_com_cobranca_pf`) se houver cobrança PF viva do pacote em nome de outro
   * profissional: o recibo e o Receita Saúde seguem o profissional da venda; cancele a cobrança antes.
   */
  trocarProfissional(ctx: RequestContext, pacoteId: string, profissionalId: string, motivo: PackageProfessionalChangeReason): Promise<PacoteDto> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      const atual = await this.travarPacote(tx, ctx, pacoteId);
      if (atual.status === 'cancelled') throw new ConflitoError('pacote_cancelado');
      if (atual.professionalId === profissionalId) return paraDto(atual, hojeNaClinica());
      if ((atual.professionalId === null) !== (motivo === 'fixar_pacote_antigo')) throw new ConflitoError('motivo_invalido', ['motivo']);
      await this.exigirProfissionalAtivo(tx, ctx, profissionalId);
      const [pf] = await tx
        .select({ id: charges.id })
        .from(charges)
        .where(
          and(
            eq(charges.tenantId, ctx.tenantId),
            eq(charges.packageId, pacoteId),
            eq(charges.attendanceKind, 'pf'),
            ne(charges.status, 'cancelled'),
            ne(charges.professionalId, profissionalId),
          ),
        )
        .limit(1);
      if (pf) throw new ConflitoError('pacote_com_cobranca_pf');
      // R14 do #65: fixar um pacote antigo em X com sessão viva de Y declararia algo falso (estorne antes).
      if (atual.professionalId === null) {
        const [deOutro] = await tx
          .select({ id: packageSessions.id })
          .from(packageSessions)
          .innerJoin(appointments, and(eq(appointments.tenantId, packageSessions.tenantId), eq(appointments.id, packageSessions.appointmentId)))
          .where(
            and(
              eq(packageSessions.tenantId, ctx.tenantId),
              eq(packageSessions.packageId, pacoteId),
              isNull(packageSessions.reversedAt),
              ne(appointments.professionalId, profissionalId),
            ),
          )
          .limit(1);
        if (deOutro) throw new ConflitoError('pacote_com_sessoes_de_outro_profissional');
      }
      const [troca] = await tx
        .insert(packageProfessionalChanges)
        .values({
          tenantId: ctx.tenantId,
          packageId: pacoteId,
          fromProfessionalId: atual.professionalId,
          toProfessionalId: profissionalId,
          reason: motivo,
          changedBy: ctx.userId,
        })
        .returning({ id: packageProfessionalChanges.id });
      const [p] = await tx
        .update(sessionPackages)
        .set({ professionalId: profissionalId, updatedAt: new Date() })
        .where(and(eq(sessionPackages.tenantId, ctx.tenantId), eq(sessionPackages.id, pacoteId)))
        .returning();
      if (!troca || !p) throw new Error('falha ao trocar o profissional do pacote');
      await recordAudit(tx, ctx, {
        action: AuditAction.Update,
        scope: SCOPE,
        metadata: {
          op: 'professional_change',
          package_id: pacoteId,
          change_id: troca.id,
          from_professional_id: atual.professionalId,
          to_professional_id: profissionalId,
          reason: motivo,
        },
      });
      return paraDto(p, hojeNaClinica());
    });
  }

  private async exigirProfissionalAtivo(tx: TenantTx, ctx: RequestContext, profissionalId: string): Promise<void> {
    const [prof] = await tx
      .select({ ativo: professionals.active })
      .from(professionals)
      .where(and(eq(professionals.tenantId, ctx.tenantId), eq(professionals.id, profissionalId)));
    if (!prof) throw new NaoEncontradoError();
    if (!prof.ativo) throw new ConflitoError('profissional_inativo');
  }

  estornar(ctx: RequestContext, pacoteId: string, consumoId: string, motivo: PackageReversalReason): Promise<ResultadoConsumoPacoteDto> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      const [consumo] = await tx
        .select()
        .from(packageSessions)
        .where(
          and(eq(packageSessions.tenantId, ctx.tenantId), eq(packageSessions.id, consumoId), eq(packageSessions.packageId, pacoteId)),
        );
      if (!consumo) throw new NaoEncontradoError();
      await travarAgendamento(tx, ctx, consumo.appointmentId);
      await this.travarPacote(tx, ctx, pacoteId);
      const [travado] = await tx
        .select()
        .from(packageSessions)
        .where(and(eq(packageSessions.tenantId, ctx.tenantId), eq(packageSessions.id, consumoId)))
        .for('update');
      if (!travado) throw new NaoEncontradoError();
      if (travado.reversedAt) throw new ConflitoError('consumo_ja_estornado');
      const agora = new Date();
      await tx
        .update(packageSessions)
        .set({ reversedAt: agora, reversedBy: ctx.userId, reversalReason: motivo })
        .where(and(eq(packageSessions.tenantId, ctx.tenantId), eq(packageSessions.id, consumoId)));
      const [p] = await tx
        .update(sessionPackages)
        .set({ usedSessions: sql`${sessionPackages.usedSessions} - 1`, updatedAt: agora })
        .where(and(eq(sessionPackages.tenantId, ctx.tenantId), eq(sessionPackages.id, pacoteId)))
        .returning();
      if (!p) throw new NaoEncontradoError();
      await recordAudit(tx, ctx, {
        action: AuditAction.Update,
        scope: SCOPE_CONSUMO_PACOTE,
        metadata: { package_session_id: consumoId, package_id: pacoteId, appointment_id: consumo.appointmentId, op: 'reverse', reason: motivo },
      });
      return this.resultado(consumoId, p);
    });
  }

  /** Extrato do pacote: cada sessão que consumiu crédito (e os estornos). */
  historico(ctx: RequestContext, pacoteId: string): Promise<{ pacote: PacoteDto; consumos: ConsumoPacoteDto[] }> {
    return lerNaClinica(this.db, ctx, async (tx) => {
      const [p] = await tx
        .select()
        .from(sessionPackages)
        .where(and(eq(sessionPackages.tenantId, ctx.tenantId), eq(sessionPackages.id, pacoteId)));
      if (!p) throw new NaoEncontradoError();
      const linhas = await tx
        .select()
        .from(packageSessions)
        .where(and(eq(packageSessions.tenantId, ctx.tenantId), eq(packageSessions.packageId, pacoteId)))
        .orderBy(asc(packageSessions.consumedAt), asc(packageSessions.id));
      await recordAudit(tx, ctx, {
        action: AuditAction.Read,
        scope: SCOPE_CONSUMO_PACOTE,
        metadata: { package_id: pacoteId, patient_id: p.patientId, count: linhas.length },
      });
      return {
        pacote: paraDto(p, hojeNaClinica()),
        consumos: linhas.map((c) => ({
          id: c.id,
          agendamentoId: c.appointmentId,
          consumidoEm: c.consumedAt.toISOString(),
          estornadoEm: c.reversedAt?.toISOString() ?? null,
          motivoEstorno: c.reversalReason,
        })),
      };
    });
  }

  private resultado(consumoId: string, p: LinhaPacote): ResultadoConsumoPacoteDto {
    const b = base(p);
    return { consumoId, pacoteId: p.id, usadas: p.usedSessions, saldo: saldoDe(b), situacao: situacaoDe(b, hojeNaClinica()) };
  }

  private async travarPacote(tx: TenantTx, ctx: RequestContext, id: string): Promise<LinhaPacote> {
    const [p] = await tx
      .select()
      .from(sessionPackages)
      .where(and(eq(sessionPackages.tenantId, ctx.tenantId), eq(sessionPackages.id, id)))
      .for('update');
    if (!p) throw new NaoEncontradoError();
    return p;
  }
}
