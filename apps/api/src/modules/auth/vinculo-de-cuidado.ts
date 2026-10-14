/**
 * Vínculo de cuidado (R2 do parecer do Guardião sobre o PR #57; B1 do front-r8).
 *
 * Conteúdo clínico (e, depois, o prontuário) só para perfil clínico COM vínculo de cuidado com o
 * paciente. O vínculo é DERIVADO NO SERVIDOR, a partir da agenda da clínica da sessão; nunca vem
 * da requisição (não existe parâmetro, cabeçalho ou campo de corpo que o conceda).
 *
 * Regra (docs/04-arquitetura/api-dominio.md §"Vínculo de cuidado"): o usuário da sessão é o
 * `user_id` de um profissional ATIVO da clínica e esse profissional tem, com o paciente, ao menos um
 * agendamento que satisfaz uma das bases:
 *
 * - `atendimento`: status `in_progress` ou `completed` (só o próprio profissional marca, R1) com
 *   início nos últimos VINCULO_ATENDIMENTO_DIAS dias (continuidade do cuidado). Passado o prazo,
 *   o vínculo expira e volta a exigir um novo atendimento;
 * - `agenda_do_dia`: status `scheduled`, `confirmed` ou `checked_in` com início entre
 *   agora − VINCULO_AGENDA_HORAS e agora + VINCULO_AGENDA_HORAS (preparo da consulta do dia).
 *
 * Cancelado e falta (`cancelled`, `no_show`) nunca dão vínculo. Outra clínica nunca dá vínculo: a
 * consulta roda na transação da clínica da sessão (RLS) e filtra `tenant_id` também.
 * Equipe do caso (vínculo explícito, registrado e auditado) entra com a API de prontuário.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { RequestContext } from '@plataforma/shared';
import { and, eq, gte, inArray, lte, or, sql } from 'drizzle-orm';
import { ProibidoError } from '../../common/erros-dominio';
import { lerNaClinica } from '../../common/transacao-clinica';
import { appointments, professionals, type AppointmentStatusDb } from '../../db/schema';
import type { TenantTx } from '../../db/tenant-transaction';
import { TenantDatabase } from '../tenancy/tenancy.module';
import { ehPerfil, podeLerConteudoClinico, type BaseDoVinculo, type VinculoDeCuidado } from './perfis';

/** Janela da continuidade do cuidado depois de um atendimento. */
export const VINCULO_ATENDIMENTO_DIAS = 180;
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
  const desdeAtendimento = new Date(agora.getTime() - VINCULO_ATENDIMENTO_DIAS * DIA_MS);
  const agendaDe = new Date(agora.getTime() - VINCULO_AGENDA_HORAS * HORA_MS);
  const agendaAte = new Date(agora.getTime() + VINCULO_AGENDA_HORAS * HORA_MS);
  const atendido = and(inArray(appointments.status, [...STATUS_ATENDIDO]), gte(appointments.startsAt, desdeAtendimento));
  const doDia = and(
    inArray(appointments.status, [...STATUS_AGENDADO]),
    gte(appointments.startsAt, agendaDe),
    lte(appointments.startsAt, agendaAte),
  );
  const [linha] = await tx
    .select({ atendido: sql<boolean>`bool_or(${atendido})`, doDia: sql<boolean>`bool_or(${doDia})` })
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
}
