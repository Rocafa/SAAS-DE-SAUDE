/**
 * E12 da revisão interna de 04/11 (R6 do parecer do #61; parecer do #134): quem não cuida da agenda (sem recepção nem
 * admin) cria ou remarca agendamento de OUTRO profissional: alerta `vinculo_cruzado` na trilha NA HORA, porque o colega
 * já ganha leitura do prontuário pelo agendamento do dia. Recepção e autoagendamento não alertam. Dados fictícios.
 */
import type { TenantId } from '@plataforma/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog } from '../src/db/schema';
import { withTenant } from '../src/db/tenant-transaction';
import { noFusoDaClinica } from '../src/modules/scheduling/agenda-regras';
import { cab, subirApi, type ApiDeTeste } from './apoio-api';

type S = { Authorization: string; userId: string };
let api: ApiDeTeste;
let clinica: TenantId;
let recep: S;
let profA: S;
let profB: S;
let profFin: S;
let profissionalA: string;
let tipo: string;
let paciente: string;

const alertas = async () =>
  (
    await withTenant(api.db.db, clinica, (tx) =>
      tx
        .select({ metadata: auditLog.metadata })
        .from(auditLog)
        .where(and(eq(auditLog.tenantId, clinica), eq(auditLog.action, 'anomaly_alert'), sql`${auditLog.metadata}->>'rule' = 'vinculo_cruzado'`))
        .orderBy(asc(auditLog.id)),
    )
  ).map((l) => l.metadata as Record<string, unknown>);

async function agendar(quem: S): Promise<string> {
  const { data, hora } = noFusoDaClinica(new Date(Date.now() + 60 * 60_000));
  const r = await api.http().post('/agendamentos').set(cab(quem)).send({ pacienteId: paciente, profissionalId: profissionalA, tipoId: tipo, data, hora, encaixe: true });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return (r.body as { id: string }).id;
}

beforeAll(async () => {
  api = await subirApi();
  clinica = await api.novaClinica();
  const admin = await api.membro(clinica, api.sessao(clinica, 'admin'), 'admin');
  recep = await api.membro(clinica, api.sessao(clinica, 'recepcao'), 'recepcao');
  profA = await api.membro(clinica, api.sessao(clinica, 'profissional'), 'profissional');
  profB = await api.membro(clinica, api.sessao(clinica, 'profissional'), 'profissional');
  profFin = await api.membro(clinica, api.sessao(clinica, 'profissional', 'financeiro'), 'profissional', 'financeiro');
  const a = await api.http().post('/profissionais').set(cab(admin)).send({ nome: 'Prof A Ficticio', especialidade: 'Fisioterapia', usuarioId: profA.userId });
  expect(a.status, JSON.stringify(a.body)).toBe(201);
  profissionalA = (a.body as { id: string }).id;
  tipo = ((await api.http().post('/tipos-atendimento').set(cab(admin)).send({ nome: 'Sessao', minutos: 30, capacidade: 10 })).body as { id: string }).id;
  paciente = ((await api.http().post('/pacientes').set(cab(admin)).send({ nome: 'Paciente Ficticio Cruzado', telefone: '11900000061' })).body as { id: string }).id;
});

afterAll(async () => {
  await api?.fechar();
});

describe('E12: alerta de vínculo cruzado', () => {
  it('recepção cria: sem alerta, e a criação grava creator_role = recepcao', async () => {
    const ag = await agendar(recep);
    expect(await alertas()).toEqual([]);
    const [criado] = await withTenant(api.db.db, clinica, (tx) =>
      tx.select({ metadata: auditLog.metadata }).from(auditLog).where(and(eq(auditLog.tenantId, clinica), eq(auditLog.action, 'create'), sql`${auditLog.metadata}->>'appointment_id' = ${ag}`)),
    );
    expect(criado?.metadata).toMatchObject({ creator_role: 'recepcao' });
  });

  it('o próprio profissional cria: sem vínculo cruzado', async () => {
    await agendar(profA);
    expect(await alertas()).toEqual([]);
  });

  it('OUTRO profissional cria: alerta na hora, antes de qualquer atendimento, só com ids', async () => {
    const ag = await agendar(profB);
    expect(await alertas()).toEqual([{ rule: 'vinculo_cruzado', op: 'create', appointment_id: ag, professional_id: profissionalA, actor_id: profB.userId }]);
  });

  it('R3 do parecer do #134: profissional que também é financeiro não escapa', async () => {
    const ag = await agendar(profFin);
    const ultimo = (await alertas()).at(-1);
    expect(ultimo).toEqual({ rule: 'vinculo_cruzado', op: 'create', appointment_id: ag, professional_id: profissionalA, actor_id: profFin.userId });
  });

  it('R4 do parecer do #134: outro profissional remarca agendamento do colega: alerta op reschedule; a recepção remarcar não', async () => {
    const ag = await agendar(recep);
    const antes = (await alertas()).length;
    const { data, hora } = noFusoDaClinica(new Date(Date.now() + 90 * 60_000));
    expect((await api.http().post(`/agendamentos/${ag}/remarcar`).set(cab(recep)).send({ data, hora })).status).toBe(200);
    expect(await alertas()).toHaveLength(antes);
    const outra = noFusoDaClinica(new Date(Date.now() + 120 * 60_000));
    const r = await api.http().post(`/agendamentos/${ag}/remarcar`).set(cab(profB)).send(outra);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await alertas()).at(-1)).toEqual({ rule: 'vinculo_cruzado', op: 'reschedule', appointment_id: ag, professional_id: profissionalA, actor_id: profB.userId });
  });
});
