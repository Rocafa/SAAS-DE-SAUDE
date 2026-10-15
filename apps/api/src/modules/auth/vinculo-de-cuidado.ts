/**
 * Vínculo de cuidado (R2 do parecer do Guardião sobre o PR #57; B1 do front-r8; V1 e R1 do #61).
 *
 * Conteúdo clínico (e, depois, o prontuário) só para perfil clínico COM vínculo de cuidado com o
 * paciente. O vínculo é DERIVADO NO SERVIDOR, a partir da agenda da clínica da sessão; nunca vem
 * da requisição (não existe parâmetro, cabeçalho ou campo de corpo que o conceda).
 *
 * Regra (docs/04-arquitetura/api-dominio.md §"Vínculo de cuidado"): o usuário da sessão é o
 * `user_id` de um profissional ATIVO da clínica e esse profissional tem, com o paciente, ao menos um
 * agendamento que satisfaz uma das bases:
 *
 * - `atendimento`: status `in_progress` ou `completed` com início JÁ OCORRIDO (`starts_at <= agora`)
 *   e nos últimos N dias, N = `tenants.care_link_days` da clínica (padrão 90, teto 180; migração
 *   0013). Só o profissional do agendamento marca esses status (R1 do #57) e só dentro da janela do
 *   horário (agenda-regras.ts, 409 `fora_do_horario`): consulta futura ou retroativa não vira vínculo;
 * - `autoagendamento`: o mesmo, mas o agendamento foi criado pelo próprio usuário-profissional
 *   (`created_by` = usuário da sessão; encaixe incluído) OU remarcado por ele por último
 *   (`rescheduled_by`, migração 0014; V2 do #61). Vale, mas fica marcado na base para a
 *   auditoria do acesso clínico, e a agenda grava `anomaly_alert` (regra `vinculo_autoagendado`);
 * - `agenda_do_dia`: status `scheduled`, `confirmed` ou `checked_in` com início entre
 *   agora − VINCULO_AGENDA_HORAS e agora + VINCULO_AGENDA_HORAS (preparo da consulta do dia), e
 *   NUNCA de autoagendamento: o profissional não fabrica vínculo agendando para si mesmo.
 *
 * Cancelado e falta (`cancelled`, `no_show`) nunca dão vínculo. Outra clínica nunca dá vínculo: a
 * consulta roda na transação da clínica da sessão (RLS) e filtra `tenant_id` também.
 * Equipe do caso (vínculo explícito, registrado e auditado) entra com a API de prontuário, com o
 * mesmo princípio: quem concede não pode ser o próprio beneficiário sem segunda pessoa ou alerta.
 */
import { Inject, Injectable } from '@nestjs/common';
import { AuditAction, type RequestContext } from '@plataforma/shared';
import { and, eq, gte, inArray, lte, or, sql } from 'drizzle-orm';
import { ProibidoError } from '../../common/erros-dominio';
import { escreverNaClinica, lerNaClinica } from '../../common/transacao-clinica';
import { appointments, professionals, tenants, type AppointmentStatusDb } from '../../db/schema';
import type { TenantTx } from '../../db/tenant-transaction';
import { recordAudit } from '../audit/audit-log';
import { TenantDatabase } from '../tenancy/tenancy.module';
import { ehPerfil, podeLerConteudoClinico, type BaseDoVinculo, type VinculoDeCuidado } from './perfis';

/** Janela da continuidade do cuidado depois de um atendimento: padrão por clínica e teto absoluto. */
export const VINCULO_ATENDIMENTO_DIAS_PADRAO = 90;
export const VINCULO_ATENDIMENTO_DIAS_TETO = 180;
/** Janela, antes e depois do início, de um agendamento ainda não atendido. */
export const VINCULO_AGENDA_HORAS = 12;

const STATUS_ATENDIDO: readonly AppointmentStatusDb[] = ['in_progress', 'completed'];
const STATUS_AGENDADO: readonly AppointmentStatusDb[] = ['scheduled', 'confirmed', 'checked_in'];

const DIA_MS = 86_400_000;
const HORA_MS = 3_600_000;

function vinculo(base: BaseDoVinculo | null): VinculoDeCuidado {
  // Único ponto que constrói o tipo marcado: só o servidor produz um VinculoDeCuidado.
  return { temVinculo: base !== null, base } as VinculoDeCuidado;
}

/** Dias de continuidade da clínica da sessão, sempre limitados ao teto (defesa além do CHECK). */
export async function diasDeContinuidade(tx: TenantTx, ctx: RequestContext): Promise<number> {
  const [t] = await tx.select({ dias: tenants.careLinkDays }).from(tenants).where(eq(tenants.id, ctx.tenantId));
  const dias = t?.dias ?? VINCULO_ATENDIMENTO_DIAS_PADRAO;
  return Math.min(Math.max(dias, 1), VINCULO_ATENDIMENTO_DIAS_TETO);
}

/**
 * Calcula o vínculo na transação do chamador (a da clínica da sessão). Uso típico: dentro da
 * mesma transação que lê o conteúdo clínico e grava a auditoria.
 */
export async function calcularVinculoDeCuidado(
  tx: TenantTx,
  ctx: RequestContext,
  pacienteId: string,
  agora: Date = new Date(),
): Promise<VinculoDeCuidado> {
  const dias = await diasDeContinuidade(tx, ctx);
  const desdeAtendimento = new Date(agora.getTime() - dias * DIA_MS);
  const agendaDe = new Date(agora.getTime() - VINCULO_AGENDA_HORAS * HORA_MS);
  const agendaAte = new Date(agora.getTime() + VINCULO_AGENDA_HORAS * HORA_MS);
  // Autoagendamento: criado pelo próprio usuário da sessão (que aqui é sempre o profissional). Linhas
  // anteriores à 0013 têm created_by NULL e seguem as regras comuns.
  // V2-c do #61: remarcado pelo próprio usuário (rescheduled_by, 0014) também é autoagendamento.
  const autoagendado = sql<boolean>`(${appointments.createdBy} IS NOT DISTINCT FROM ${ctx.userId}::uuid OR ${appointments.rescheduledBy} IS NOT DISTINCT FROM ${ctx.userId}::uuid)`;
  const atendido = and(
    inArray(appointments.status, [...STATUS_ATENDIDO]),
    gte(appointments.startsAt, desdeAtendimento),
    lte(appointments.startsAt, agora),
  );
  const doDia = and(
    inArray(appointments.status, [...STATUS_AGENDADO]),
    gte(appointments.startsAt, agendaDe),
    lte(appointments.startsAt, agendaAte),
    sql`NOT ${autoagendado}`,
  );
  const [linha] = await tx
    .select({
      atendido: sql<boolean>`bool_or(${atendido} AND NOT ${autoagendado})`,
      autoagendado: sql<boolean>`bool_or(${atendido} AND ${autoagendado})`,
      doDia: sql<boolean>`bool_or(${doDia})`,
    })
    .from(appointments)
    .innerJoin(
      professionals,
      and(eq(professionals.id, appointments.professionalId), eq(professionals.tenantId, appointments.tenantId)),
    )
    .where(
      and(
        eq(appointments.tenantId, ctx.tenantId),
        eq(appointments.patientId, pacienteId),
        eq(professionals.userId, ctx.userId),
        eq(professionals.active, true),
        or(atendido, doDia),
      ),
    );
  if (linha?.atendido) return vinculo('atendimento');
  if (linha?.autoagendado) return vinculo('autoagendamento');
  if (linha?.doDia) return vinculo('agenda_do_dia');
  return vinculo(null);
}

/**
 * Porteiro do conteúdo clínico, na transação do chamador: perfil clínico E vínculo calculado aqui.
 * Sem um dos dois, 403 com código estável (o mesmo para "sem perfil" e "sem vínculo" não vaza se o
 * paciente tem agenda com outro profissional). Devolve o vínculo para o chamador auditar a base.
 */
export async function exigirConteudoClinico(
  tx: TenantTx,
  ctx: RequestContext,
  pacienteId: string,
  agora: Date = new Date(),
): Promise<VinculoDeCuidado> {
  const perfis = ctx.roles.filter(ehPerfil);
  const v = await calcularVinculoDeCuidado(tx, ctx, pacienteId, agora);
  if (!podeLerConteudoClinico(perfis, v)) throw new ProibidoError('sem_vinculo_de_cuidado');
  return v;
}

/** Serviço para quem não está dentro de uma transação (abre uma leitura na clínica da sessão). */
@Injectable()
export class VinculoDeCuidadoService {
  constructor(@Inject(TenantDatabase) private readonly db: TenantDatabase) {}

  temVinculoDeCuidado(ctx: RequestContext, pacienteId: string, agora: Date = new Date()): Promise<VinculoDeCuidado> {
    return lerNaClinica(this.db, ctx, (tx) => calcularVinculoDeCuidado(tx, ctx, pacienteId, agora));
  }

  /** Janela de continuidade da clínica da sessão (dias). */
  janelaDeContinuidade(ctx: RequestContext): Promise<{ dias: number; teto: number }> {
    return lerNaClinica(this.db, ctx, async (tx) => ({ dias: await diasDeContinuidade(tx, ctx), teto: VINCULO_ATENDIMENTO_DIAS_TETO }));
  }

  /**
   * Muda a janela de continuidade da clínica da sessão (R1 do parecer #61). Rota só para
   * `cadastros:gerir`; o banco recusa fora de 1..180. Auditado com o valor anterior e o novo
   * (números de configuração, não dado pessoal).
   */
  definirJanelaDeContinuidade(ctx: RequestContext, dias: number): Promise<{ dias: number; teto: number }> {
    return escreverNaClinica(this.db, ctx, async (tx) => {
      const anterior = await diasDeContinuidade(tx, ctx);
      await tx.update(tenants).set({ careLinkDays: dias }).where(eq(tenants.id, ctx.tenantId));
      await recordAudit(tx, ctx, {
        action: AuditAction.Update,
        scope: 'tenants',
        metadata: { setting: 'care_link_days', from: anterior, to: dias },
      });
      return { dias, teto: VINCULO_ATENDIMENTO_DIAS_TETO };
    });
  }
}
