/**
 * E12 da revisão interna de 04/11 (R6 do parecer do #61): quem SÓ é profissional cria agendamento para OUTRO
 * profissional e isso vira atendimento: alerta `vinculo_cruzado` na trilha. Agendamento da recepção, ou do próprio
 * profissional, não alerta. A criação grava `creator_role`. Dados fictícios.
 */
import type { TenantId } from '@plataforma/shared';
import { and, eq, sql } from 'drizzle-orm';
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
let profissionalA: string;
let tipo: string;
let paciente: string;

const alertas = () =>
  withTenant(api.db.db, clinica, (tx) =>
    tx
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, clinica), eq(auditLog.action, 'anomaly_alert'), sql`${auditLog.metadata}->>'rule' = 'vinculo_cruzado'`)),
  );

/** Cria o agendamento (por quem), faz o check-in pela recepção e o profissional A abre o atendimento. */
async function agendarEAtender(quem: S): Promise<{ agendamento: string }> {
  const { data, hora } = noFusoDaClinica(new Date());
  const r = await api.http().post('/agendamentos').set(cab(quem)).send({ pacienteId: paciente, profissionalId: profissionalA, tipoId: tipo, data, hora, encaixe: true });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const agendamento = (r.body as { id: string }).id;
  expect((await api.http().post(`/agendamentos/${agendamento}/check-in`).set(cab(recep)).send({})).status).toBe(200);
  const at = await api.http().post('/atendimentos').set(cab(profA)).send({ agendamentoId: agendamento });
  expect(at.status, JSON.stringify(at.body)).toBe(200);
  return { agendamento };
}

beforeAll(async () => {
  api = await subirApi();
  clinica = await api.novaClinica();
  const admin = await api.membro(clinica, api.sessao(clinica, 'admin'), 'admin');
  recep = await api.membro(clinica, api.sessao(clinica, 'recepcao'), 'recepcao');
  profA = await api.membro(clinica, api.sessao(clinica, 'profissional'), 'profissional');
  profB = await api.membro(clinica, api.sessao(clinica, 'profissional'), 'profissional');
  const a = await api.http().post('/profissionais').set(cab(admin)).send({ nome: 'Prof A Ficticio', especialidade: 'Fisioterapia', usuarioId: profA.userId });
  profissionalA = (a.body as { id: string }).id;
  await api.http().post('/profissionais').set(cab(admin)).send({ nome: 'Prof B Ficticio', especialidade: 'Fisioterapia', usuarioId: profB.userId }).expect(201);
  tipo = ((await api.http().post('/tipos-atendimento').set(cab(admin)).send({ nome: 'Sessao', minutos: 30, capacidade: 10 })).body as { id: string }).id;
  paciente = ((await api.http().post('/pacientes').set(cab(admin)).send({ nome: 'Paciente Ficticio Cruzado', telefone: '11900000061' })).body as { id: string }).id;
});

afterAll(async () => {
  await api?.fechar();
});

describe('E12: alerta de vínculo cruzado', () => {
  it('agendado pela recepção e atendido: sem alerta; a criação grava creator_role = recepcao', async () => {
    const { agendamento } = await agendarEAtender(recep);
    expect(await alertas()).toHaveLength(0);
    const [criado] = await withTenant(api.db.db, clinica, (tx) =>
      tx.select({ metadata: auditLog.metadata }).from(auditLog).where(and(eq(auditLog.tenantId, clinica), eq(auditLog.action, 'create'), sql`${auditLog.metadata}->>'appointment_id' = ${agendamento}`)),
    );
    expect(criado?.metadata).toMatchObject({ creator_role: 'recepcao' });
  });

  it('agendado pelo próprio profissional: sem vínculo cruzado', async () => {
    await agendarEAtender(profA);
    expect(await alertas()).toHaveLength(0);
  });

  it('agendado por OUTRO profissional (só profissional) e atendido: um alerta vinculo_cruzado, só com ids', async () => {
    const { agendamento } = await agendarEAtender(profB);
    const lista = await alertas();
    expect(lista).toHaveLength(1);
    expect(lista[0]?.metadata).toMatchObject({ rule: 'vinculo_cruzado', appointment_id: agendamento, professional_id: profissionalA, creator_id: profB.userId });
  });
});
