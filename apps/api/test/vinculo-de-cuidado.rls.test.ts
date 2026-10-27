/**
 * Vínculo de cuidado (R2 do parecer PR #57) contra Postgres REAL: derivado no servidor a partir da
 * agenda da clínica da sessão. Com vínculo, sem vínculo, outra clínica, vínculo expirado, cancelado
 * e agenda futura. Pré-requisitos: migrações aplicadas e DATABASE_URL = papel app_user.
 * Dados 100% fictícios.
 */
import type { RequestContext, TenantId, UserId } from '@plataforma/shared';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProibidoError } from '../src/common/erros-dominio';
import { and, eq, sql } from 'drizzle-orm';
import { appointmentReschedules, appointments, auditLog, professionals, tenants, type AppointmentStatusDb } from '../src/db/schema';
import { noFusoDaClinica } from '../src/modules/scheduling/agenda-regras';
import { withTenant, type TenantTx } from '../src/db/tenant-transaction';
import {
  exigirConteudoClinico,
  VINCULO_AGENDA_HORAS,
  VINCULO_ATENDIMENTO_DIAS_PADRAO,
  VinculoDeCuidadoService,
} from '../src/modules/auth/vinculo-de-cuidado';
import { cab, subirApi, type ApiDeTeste } from './apoio-api';

const DIA = 86_400_000;
const HORA = 3_600_000;
const agora = new Date();

let api: ApiDeTeste;
let servico: VinculoDeCuidadoService;
let clinicaA: TenantId;
let clinicaB: TenantId;
let profA: { Authorization: string; userId: string };
let outroProfA: { Authorization: string; userId: string };
let profB: { Authorization: string; userId: string };
let profissionalA: string;
let outroProfissionalA: string;
let profissionalB: string;
let tipoA: string;
let tipoB: string;

const ctx = (tenantId: TenantId, s: { userId: string }, ...roles: string[]): RequestContext => ({
  tenantId,
  userId: s.userId as UserId,
  roles: roles.length ? roles : ['profissional'],
});

async function novoPaciente(adminTenant: { Authorization: string }): Promise<string> {
  const res = await api.http().post('/pacientes').set(cab(adminTenant)).send({ nome: 'Paciente Ficticio Vinculo', telefone: '11900000009' });
  expect(res.status).toBe(201);
  return (res.body as { id: string }).id;
}

async function profissional(admin: { Authorization: string }, usuarioId: string): Promise<string> {
  const res = await api.http().post('/profissionais').set(cab(admin)).send({ nome: 'Prof Ficticio', especialidade: 'Fisioterapia', usuarioId });
  expect(res.status).toBe(201);
  return (res.body as { id: string }).id;
}

async function tipo(admin: { Authorization: string }): Promise<string> {
  const res = await api.http().post('/tipos-atendimento').set(cab(admin)).send({ nome: 'Individual', minutos: 50 });
  expect(res.status).toBe(201);
  return (res.body as { id: string }).id;
}

/** Agendamento direto no banco (datas no passado não passam pela rota de agenda). */
async function agendamento(
  tenantId: TenantId,
  dados: { paciente: string; profissional: string; tipo: string; inicio: Date; status: AppointmentStatusDb; criadoPor?: string },
): Promise<string> {
  const id = randomUUID();
  // O banco exige created_by = usuário da sessão (0016): sem criadoPor, um usuário qualquer da recepção.
  const criador = dados.criadoPor ?? randomUUID();
  await withTenant(api.db.db, tenantId, async (tx) => {
    await tx.insert(appointments).values({
      id,
      createdBy: criador,
      tenantId,
      patientId: dados.paciente,
      professionalId: dados.profissional,
      appointmentTypeId: dados.tipo,
      startsAt: dados.inicio,
      endsAt: new Date(dados.inicio.getTime() + 50 * 60_000),
      status: dados.status,
      cancelledAt: dados.status === 'cancelled' ? dados.inicio : null,
    });
  }, criador);
  return id;
}

/** Agendamento pela ROTA (grava created_by = usuário da sessão). Hora no fuso da clínica. */
async function marcarPelaRota(
  s: { Authorization: string },
  dados: { paciente: string; profissional: string; tipo: string; inicio: Date; encaixe?: boolean },
): Promise<string> {
  const { data, hora } = noFusoDaClinica(dados.inicio);
  const res = await api
    .http()
    .post('/agendamentos')
    .set(cab(s))
    .send({ pacienteId: dados.paciente, profissionalId: dados.profissional, tipoId: dados.tipo, data, hora, encaixe: dados.encaixe ?? false });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body as { id: string }).id;
}

function status(s: { Authorization: string }, id: string, novo: string) {
  return api.http().post(`/agendamentos/${id}/status`).set(cab(s)).send({ status: novo });
}

async function alertasDe(tenantId: TenantId, ator: string): Promise<{ metadata: unknown }[]> {
  return withTenant(api.db.db, tenantId, (tx) =>
    tx
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.actorId, ator), eq(auditLog.action, 'anomaly_alert'))),
  );
}

let adminA: { Authorization: string; userId: string };
let adminB: { Authorization: string; userId: string };

beforeAll(async () => {
  api = await subirApi();
  servico = api.app.get(VinculoDeCuidadoService);
  clinicaA = await api.novaClinica();
  clinicaB = await api.novaClinica();
  adminA = api.sessao(clinicaA, 'admin');
  adminB = api.sessao(clinicaB, 'admin');
  profA = api.sessao(clinicaA, 'profissional');
  outroProfA = api.sessao(clinicaA, 'profissional');
  profB = api.sessao(clinicaB, 'profissional');
  profissionalA = await profissional(adminA, profA.userId);
  outroProfissionalA = await profissional(adminA, outroProfA.userId);
  profissionalB = await profissional(adminB, profB.userId);
  tipoA = await tipo(adminA);
  tipoB = await tipo(adminB);
});

afterAll(async () => {
  await api?.fechar();
});

describe('vínculo de cuidado derivado no servidor (R2)', () => {
  it('com vínculo: atendimento recente com o profissional da sessão', async () => {
    const p = await novoPaciente(adminA);
    await agendamento(clinicaA, { paciente: p, profissional: profissionalA, tipo: tipoA, inicio: new Date(agora.getTime() - 30 * DIA), status: 'completed' });
    const v = await servico.temVinculoDeCuidado(ctx(clinicaA, profA), p, agora);
    expect(v).toMatchObject({ temVinculo: true, base: 'atendimento' });
  });

  it('com vínculo: consulta do dia ainda não atendida (agendada/confirmada/check-in)', async () => {
    const p = await novoPaciente(adminA);
    await agendamento(clinicaA, { paciente: p, profissional: profissionalA, tipo: tipoA, inicio: new Date(agora.getTime() + 2 * HORA), status: 'confirmed' });
    expect(await servico.temVinculoDeCuidado(ctx(clinicaA, profA), p, agora)).toMatchObject({ temVinculo: true, base: 'agenda_do_dia' });
  });

  it('sem vínculo: profissional da MESMA clínica sem agendamento com o paciente (403 no porteiro)', async () => {
    const p = await novoPaciente(adminA);
    await agendamento(clinicaA, { paciente: p, profissional: profissionalA, tipo: tipoA, inicio: new Date(agora.getTime() - DIA), status: 'completed' });
    expect(await servico.temVinculoDeCuidado(ctx(clinicaA, outroProfA), p, agora)).toMatchObject({ temVinculo: false, base: null });
    await expect(
      withTenant(api.db.db, clinicaA, (tx) => exigirConteudoClinico(tx, ctx(clinicaA, outroProfA), p, agora)),
    ).rejects.toBeInstanceOf(ProibidoError);
    // O dono do vínculo passa no porteiro.
    await expect(
      withTenant(api.db.db, clinicaA, (tx) => exigirConteudoClinico(tx, ctx(clinicaA, profA), p, agora)),
    ).resolves.toMatchObject({ base: 'atendimento' });
  });

  it('perfil não clínico com o mesmo usuário do profissional: 403 (perfil E vínculo)', async () => {
    const p = await novoPaciente(adminA);
    await agendamento(clinicaA, { paciente: p, profissional: profissionalA, tipo: tipoA, inicio: new Date(agora.getTime() - DIA), status: 'completed' });
    for (const perfil of ['admin', 'recepcao', 'financeiro']) {
      await expect(
        withTenant(api.db.db, clinicaA, (tx) => exigirConteudoClinico(tx, ctx(clinicaA, profA, perfil), p, agora)),
        perfil,
      ).rejects.toBeInstanceOf(ProibidoError);
    }
  });

  it('outra clínica: profissional de B nunca tem vínculo com paciente de A, nem com o mesmo usuário', async () => {
    const pA = await novoPaciente(adminA);
    await agendamento(clinicaA, { paciente: pA, profissional: profissionalA, tipo: tipoA, inicio: new Date(agora.getTime() - DIA), status: 'completed' });
    // Sessão da clínica B com o id do paciente de A: RLS + filtro por tenant -> sem vínculo.
    expect(await servico.temVinculoDeCuidado(ctx(clinicaB, profB), pA, agora)).toMatchObject({ temVinculo: false });
    // Mesmo userId do profissional de A, mas sessão em B: o vínculo é da clínica A, não viaja.
    expect(await servico.temVinculoDeCuidado(ctx(clinicaB, profA), pA, agora)).toMatchObject({ temVinculo: false });
    // E o profissional de B, com agenda própria em B, só tem vínculo com o paciente de B.
    const pB = await novoPaciente(adminB);
    await agendamento(clinicaB, { paciente: pB, profissional: profissionalB, tipo: tipoB, inicio: new Date(agora.getTime() - DIA), status: 'completed' });
    expect(await servico.temVinculoDeCuidado(ctx(clinicaB, profB), pB, agora)).toMatchObject({ temVinculo: true });
    expect(await servico.temVinculoDeCuidado(ctx(clinicaA, profB), pB, agora)).toMatchObject({ temVinculo: false });
  });

  it('vínculo expirado: último atendimento fora da janela de continuidade', async () => {
    const p = await novoPaciente(adminA);
    await agendamento(clinicaA, {
      paciente: p,
      profissional: profissionalA,
      tipo: tipoA,
      inicio: new Date(agora.getTime() - (VINCULO_ATENDIMENTO_DIAS_PADRAO + 1) * DIA),
      status: 'completed',
    });
    expect(await servico.temVinculoDeCuidado(ctx(clinicaA, profA), p, agora)).toMatchObject({ temVinculo: false });
    // Dois dias atrás, o mesmo atendimento ainda estava dentro da janela.
    const quase = new Date(agora.getTime() - 2 * DIA);
    expect(await servico.temVinculoDeCuidado(ctx(clinicaA, profA), p, quase)).toMatchObject({ temVinculo: true });
  });

  it('cancelado, falta, agenda futura fora da janela e agenda velha não atendida não dão vínculo', async () => {
    const p = await novoPaciente(adminA);
    const casos: { inicio: Date; status: AppointmentStatusDb }[] = [
      { inicio: new Date(agora.getTime() - DIA), status: 'cancelled' },
      { inicio: new Date(agora.getTime() - DIA), status: 'no_show' },
      { inicio: new Date(agora.getTime() + (VINCULO_AGENDA_HORAS + 2) * HORA), status: 'scheduled' },
      { inicio: new Date(agora.getTime() - (VINCULO_AGENDA_HORAS + 2) * HORA), status: 'confirmed' },
    ];
    for (const c of casos) await agendamento(clinicaA, { paciente: p, profissional: profissionalA, tipo: tipoA, ...c });
    expect(await servico.temVinculoDeCuidado(ctx(clinicaA, profA), p, agora)).toMatchObject({ temVinculo: false });
  });

  it('profissional inativado perde o vínculo', async () => {
    const usuario = api.sessao(clinicaA, 'profissional');
    const prof = await profissional(adminA, usuario.userId);
    const p = await novoPaciente(adminA);
    await agendamento(clinicaA, { paciente: p, profissional: prof, tipo: tipoA, inicio: new Date(agora.getTime() - DIA), status: 'completed' });
    expect(await servico.temVinculoDeCuidado(ctx(clinicaA, usuario), p, agora)).toMatchObject({ temVinculo: true });
    // Sem rota de inativação ainda: direto no banco, na transação da clínica.
    await withTenant(api.db.db, clinicaA, (tx) => tx.update(professionals).set({ active: false }).where(eq(professionals.id, prof)));
    expect(await servico.temVinculoDeCuidado(ctx(clinicaA, usuario), p, agora)).toMatchObject({ temVinculo: false });
  });

  it('a requisição não concede vínculo: nenhuma rota aceita campo de vínculo', async () => {
    // Não há rota clínica ainda; a garantia aqui é de tipo (VinculoDeCuidado é marcado) e de que
    // o vínculo do outro profissional nunca se transfere, testado acima. Este caso fixa o código.
    const p = await novoPaciente(adminA);
    await expect(
      withTenant(api.db.db, clinicaA, (tx) => exigirConteudoClinico(tx, ctx(clinicaA, outroProfA), p, agora)),
    ).rejects.toMatchObject({ response: { codigo: 'sem_vinculo_de_cuidado' } });
    // Mesmo com agendamento do OUTRO profissional (outroProfissionalA) com o paciente, o vínculo é dele.
    await agendamento(clinicaA, { paciente: p, profissional: outroProfissionalA, tipo: tipoA, inicio: new Date(agora.getTime() - DIA), status: 'completed' });
    expect(await servico.temVinculoDeCuidado(ctx(clinicaA, profA), p, agora)).toMatchObject({ temVinculo: false });
    expect(await servico.temVinculoDeCuidado(ctx(clinicaA, outroProfA), p, agora)).toMatchObject({ temVinculo: true });
  });
});

/**
 * V1 do parecer do Guardião sobre o PR #61: o profissional não fabrica o próprio vínculo. Cada
 * caminho de ataque do parecer tem um teste negativo; os positivos mostram o fluxo legítimo.
 * Cada caso usa um profissional novo, para que capacidade e alertas não se misturem.
 */
describe('vínculo não autodeclarado (V1 do #61)', () => {
  async function novoProfissional(): Promise<{ sessao: { Authorization: string; userId: string }; id: string }> {
    const sessao = api.sessao(clinicaA, 'profissional');
    return { sessao, id: await profissional(adminA, sessao.userId) };
  }

  it('ataque 1: encaixe consigo mesmo AGORA não dá vínculo (nem agenda do dia) antes do atendimento', async () => {
    const eu = await novoProfissional();
    const p = await novoPaciente(adminA);
    await marcarPelaRota(eu.sessao, { paciente: p, profissional: eu.id, tipo: tipoA, inicio: new Date(), encaixe: true });
    expect(await servico.temVinculoDeCuidado(ctx(clinicaA, eu.sessao), p, new Date())).toMatchObject({ temVinculo: false, base: null });
    await expect(
      withTenant(api.db.db, clinicaA, (tx) => exigirConteudoClinico(tx, ctx(clinicaA, eu.sessao), p, new Date())),
    ).rejects.toMatchObject({ response: { codigo: 'sem_vinculo_de_cuidado' } });
  });

  it('ataque 1 (fim): autoagendamento atendido dentro da janela vira base `autoagendamento` e gera anomaly_alert sem dado pessoal', async () => {
    const eu = await novoProfissional();
    const p = await novoPaciente(adminA);
    const id = await marcarPelaRota(eu.sessao, { paciente: p, profissional: eu.id, tipo: tipoA, inicio: new Date(), encaixe: true });
    await api.http().post(`/agendamentos/${id}/check-in`).set(cab(eu.sessao)).expect(200);
    expect(await alertasDe(clinicaA, eu.sessao.userId)).toHaveLength(0);
    await status(eu.sessao, id, 'em_atendimento').expect(200);
    expect(await servico.temVinculoDeCuidado(ctx(clinicaA, eu.sessao), p, new Date())).toMatchObject({
      temVinculo: true,
      base: 'autoagendamento',
    });
    const alertas = await alertasDe(clinicaA, eu.sessao.userId);
    expect(alertas).toHaveLength(1);
    // Só regra, janela, limiar e contagem: nada de paciente, agendamento ou nome.
    expect(alertas[0]?.metadata).toEqual({ rule: 'vinculo_autoagendado', window_s: 86_400, threshold: 0, count: 1 });
    // "atendido" depois de "em atendimento" não duplica o alerta.
    await status(eu.sessao, id, 'atendido').expect(200);
    expect(await alertasDe(clinicaA, eu.sessao.userId)).toHaveLength(1);
  });

  it('positivo: agendamento feito pela RECEPÇÃO para agora dá agenda do dia; atendido dá `atendimento` sem alerta', async () => {
    const eu = await novoProfissional();
    const recep = api.sessao(clinicaA, 'recepcao');
    const p = await novoPaciente(adminA);
    const id = await marcarPelaRota(recep, { paciente: p, profissional: eu.id, tipo: tipoA, inicio: new Date() });
    expect(await servico.temVinculoDeCuidado(ctx(clinicaA, eu.sessao), p, new Date())).toMatchObject({ base: 'agenda_do_dia' });
    await api.http().post(`/agendamentos/${id}/check-in`).set(cab(recep)).expect(200);
    await status(eu.sessao, id, 'em_atendimento').expect(200);
    await status(eu.sessao, id, 'atendido').expect(200);
    expect(await servico.temVinculoDeCuidado(ctx(clinicaA, eu.sessao), p, new Date())).toMatchObject({ base: 'atendimento' });
    expect(await alertasDe(clinicaA, eu.sessao.userId)).toHaveLength(0);
  });

  it('ataque 2: consulta de AMANHÃ marcada "em atendimento" ou "atendido" dá 409 fora_do_horario e não dá vínculo', async () => {
    const eu = await novoProfissional();
    const p = await novoPaciente(adminA);
    const id = await marcarPelaRota(eu.sessao, { paciente: p, profissional: eu.id, tipo: tipoA, inicio: new Date(Date.now() + DIA) });
    await api.http().post(`/agendamentos/${id}/check-in`).set(cab(eu.sessao)).expect(200);
    for (const novo of ['em_atendimento', 'atendido']) {
      const r = await status(eu.sessao, id, novo);
      expect(r.status, novo).toBe(409);
      expect(r.body).toEqual({ statusCode: 409, message: 'Conflito', codigo: 'fora_do_horario' });
    }
    expect(await servico.temVinculoDeCuidado(ctx(clinicaA, eu.sessao), p, new Date())).toMatchObject({ temVinculo: false });
  });

  it('ataque 3: consulta de 100 dias atrás marcada "atendido" dá 409 (retroativo) e não dá vínculo', async () => {
    const eu = await novoProfissional();
    const p = await novoPaciente(adminA);
    // A rota não marca mais no passado (R7 do #61): o agendamento antigo entra direto no banco.
    const id = await agendamento(clinicaA, {
      paciente: p,
      profissional: eu.id,
      tipo: tipoA,
      inicio: new Date(Date.now() - 100 * DIA),
      status: 'scheduled',
      criadoPor: eu.sessao.userId,
    });
    await api.http().post(`/agendamentos/${id}/check-in`).set(cab(eu.sessao)).expect(200);
    const r = await status(eu.sessao, id, 'atendido');
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ codigo: 'fora_do_horario' });
    await status(eu.sessao, id, 'em_atendimento').expect(409);
    expect(await servico.temVinculoDeCuidado(ctx(clinicaA, eu.sessao), p, new Date())).toMatchObject({ temVinculo: false });
  });

  it('janela de atendimento: 30 min antes do início até 60 min depois do fim; fora dela, 409', async () => {
    const eu = await novoProfissional();
    const p = await novoPaciente(adminA);
    const minuto = 60_000;
    // Tipo de 50 min (tipoA). Fora: começa em 45 min; terminou há 2 h. Dentro: começa em 20 min; terminou há 30 min.
    const casos: { inicio: Date; esperado: number }[] = [
      { inicio: new Date(Date.now() + 45 * minuto), esperado: 409 },
      { inicio: new Date(Date.now() - (50 + 120) * minuto), esperado: 409 },
      { inicio: new Date(Date.now() + 20 * minuto), esperado: 200 },
      { inicio: new Date(Date.now() - (50 + 30) * minuto), esperado: 200 },
    ];
    for (const c of casos) {
      const id = await agendamento(clinicaA, { paciente: p, profissional: eu.id, tipo: tipoA, inicio: c.inicio, status: 'checked_in' });
      expect((await status(eu.sessao, id, 'em_atendimento')).status, c.inicio.toISOString()).toBe(c.esperado);
    }
  });

  it('ataque 4: consulta FUTURA já `in_progress`/`completed` inserida direto no banco não dá vínculo', async () => {
    const eu = await novoProfissional();
    const p = await novoPaciente(adminA);
    for (const [inicio, st] of [
      [new Date(Date.now() + 2 * HORA), 'in_progress'],
      [new Date(Date.now() + 30 * DIA), 'completed'],
    ] as const) {
      await agendamento(clinicaA, { paciente: p, profissional: eu.id, tipo: tipoA, inicio, status: st });
    }
    expect(await servico.temVinculoDeCuidado(ctx(clinicaA, eu.sessao), p, new Date())).toMatchObject({ temVinculo: false });
  });

  it('autoagendamento futuro do dia (agendado/confirmado/check-in) nunca dá agenda do dia', async () => {
    const eu = await novoProfissional();
    const p = await novoPaciente(adminA);
    for (const st of ['scheduled', 'confirmed', 'checked_in'] as const) {
      await agendamento(clinicaA, { paciente: p, profissional: eu.id, tipo: tipoA, inicio: new Date(Date.now() + HORA), status: st, criadoPor: eu.sessao.userId });
    }
    expect(await servico.temVinculoDeCuidado(ctx(clinicaA, eu.sessao), p, new Date())).toMatchObject({ temVinculo: false });
  });

  it('created_by é imutável no banco (o runtime não "desmarca" um autoagendamento)', async () => {
    const eu = await novoProfissional();
    const p = await novoPaciente(adminA);
    const id = await agendamento(clinicaA, { paciente: p, profissional: eu.id, tipo: tipoA, inicio: new Date(Date.now() + DIA), status: 'scheduled', criadoPor: eu.sessao.userId });
    await expect(
      withTenant(api.db.db, clinicaA, (tx) => tx.update(appointments).set({ createdBy: randomUUID() }).where(eq(appointments.id, id))),
    ).rejects.toThrow();
  });
});

/**
 * V2 da re-revisão do Guardião sobre o PR #61: reaproveitar um agendamento antigo (remarcar, ou
 * desfazer um status) não cria nem renova vínculo, e a data real do atendimento não se perde.
 * Os agendamentos antigos são da RECEPÇÃO (created_by = recepção), o caso que o parecer aponta.
 */
describe('remarcação e "Desfazer" não fabricam vínculo (V2 do #61)', () => {
  let recep: { Authorization: string; userId: string };

  beforeAll(() => {
    recep = api.sessao(clinicaA, 'recepcao');
  });

  async function novoProfissional(): Promise<{ sessao: { Authorization: string; userId: string }; id: string }> {
    const sessao = api.sessao(clinicaA, 'profissional');
    return { sessao, id: await profissional(adminA, sessao.userId) };
  }

  function remarcar(s: { Authorization: string }, id: string, quando: Date) {
    return api.http().post(`/agendamentos/${id}/remarcar`).set(cab(s)).send(noFusoDaClinica(quando));
  }

  async function linha(id: string) {
    const [a] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(appointments).where(eq(appointments.id, id)));
    return a;
  }

  async function historico(id: string) {
    return withTenant(api.db.db, clinicaA, (tx) =>
      tx.select().from(appointmentReschedules).where(eq(appointmentReschedules.appointmentId, id)),
    );
  }

  it('cenário 1: falta de 2 anos atrás não volta para "agendado", não se remarca e não dá vínculo', async () => {
    const eu = await novoProfissional();
    const p = await novoPaciente(adminA);
    const inicio = new Date(Date.now() - 730 * DIA);
    const id = await agendamento(clinicaA, { paciente: p, profissional: eu.id, tipo: tipoA, inicio, status: 'no_show', criadoPor: recep.userId });
    for (const novo of ['agendado', 'confirmado']) {
      const r = await status(eu.sessao, id, novo);
      expect(r.status, novo).toBe(409);
      expect(r.body).toEqual({ statusCode: 409, message: 'Conflito', codigo: 'fora_do_horario' });
    }
    const r = await remarcar(eu.sessao, id, new Date());
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ codigo: 'status_nao_permite' });
    expect(await servico.temVinculoDeCuidado(ctx(clinicaA, eu.sessao), p, new Date())).toMatchObject({ temVinculo: false });
    expect((await linha(id))?.startsAt.toISOString()).toBe(inicio.toISOString());
  });

  it('cenário 1 (variação): falta de HOJE desfeita na janela é permitida, mas o horário fica travado', async () => {
    const eu = await novoProfissional();
    const p = await novoPaciente(adminA);
    const id = await agendamento(clinicaA, { paciente: p, profissional: eu.id, tipo: tipoA, inicio: new Date(Date.now() - 10 * 60_000), status: 'scheduled', criadoPor: recep.userId });
    await status(recep, id, 'faltou').expect(200);
    await status(recep, id, 'agendado').expect(200);
    // Já teve falta: não muda de horário (nem pela recepção), e o banco mantém a trava.
    const r = await remarcar(recep, id, new Date(Date.now() + 2 * HORA));
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ codigo: 'status_nao_permite' });
    expect((await linha(id))?.rescheduleLocked).toBe(true);
    await expect(
      withTenant(api.db.db, clinicaA, (tx) => tx.update(appointments).set({ rescheduleLocked: false }).where(eq(appointments.id, id))),
    ).resolves.toBeDefined();
    expect((await linha(id))?.rescheduleLocked).toBe(true);
  });

  it('cenário 2: agendamento esquecido (agendado/confirmado de 2 anos atrás) não se remarca para agora', async () => {
    const eu = await novoProfissional();
    const p = await novoPaciente(adminA);
    for (const st of ['scheduled', 'confirmed'] as const) {
      const id = await agendamento(clinicaA, { paciente: p, profissional: eu.id, tipo: tipoA, inicio: new Date(Date.now() - 730 * DIA), status: st, criadoPor: recep.userId });
      for (const quem of [eu.sessao, recep]) {
        const r = await remarcar(quem, id, new Date());
        expect(r.status, st).toBe(409);
        expect(r.body).toMatchObject({ codigo: 'status_nao_permite' });
      }
      expect(await historico(id)).toHaveLength(0);
    }
    expect(await servico.temVinculoDeCuidado(ctx(clinicaA, eu.sessao), p, new Date())).toMatchObject({ temVinculo: false });
  });

  it('cenário 3: atendimento antigo deixado "em atendimento" não volta para "chegou" nem muda de data', async () => {
    const eu = await novoProfissional();
    const p = await novoPaciente(adminA);
    const inicio = new Date(Date.now() - 10 * DIA);
    const id = await agendamento(clinicaA, { paciente: p, profissional: eu.id, tipo: tipoA, inicio, status: 'in_progress', criadoPor: recep.userId });
    const r = await status(eu.sessao, id, 'chegou');
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ codigo: 'fora_do_horario' });
    // "atendido" também: o destino clínico já exigia a janela (V1).
    await status(eu.sessao, id, 'atendido').expect(409);
    await remarcar(eu.sessao, id, new Date()).expect(409);
    // O vínculo continua sendo o do atendimento REAL (10 dias atrás), sem renovação.
    expect(await servico.temVinculoDeCuidado(ctx(clinicaA, eu.sessao), p, new Date())).toMatchObject({ base: 'atendimento' });
    const depoisDaJanela = new Date(inicio.getTime() + (VINCULO_ATENDIMENTO_DIAS_PADRAO + 1) * DIA);
    expect(await servico.temVinculoDeCuidado(ctx(clinicaA, eu.sessao), p, depoisDaJanela)).toMatchObject({ temVinculo: false });
    // A data real fica: nem o banco aceita mudar o horário de um agendamento travado.
    await expect(
      withTenant(api.db.db, clinicaA, (tx) =>
        tx
          .update(appointments)
          .set({ startsAt: new Date(), endsAt: new Date(Date.now() + 50 * 60_000), rescheduledBy: recep.userId })
          .where(eq(appointments.id, id)),
      ),
    ).rejects.toThrow();
    expect((await linha(id))?.startsAt.toISOString()).toBe(inicio.toISOString());
  });

  it('cenário 3 (atendido de hoje): "Desfazer" dentro da janela funciona; o horário continua travado', async () => {
    const eu = await novoProfissional();
    const p = await novoPaciente(adminA);
    const id = await marcarPelaRota(recep, { paciente: p, profissional: eu.id, tipo: tipoA, inicio: new Date() });
    await api.http().post(`/agendamentos/${id}/check-in`).set(cab(recep)).expect(200);
    await status(eu.sessao, id, 'em_atendimento').expect(200);
    await status(eu.sessao, id, 'chegou').expect(200);
    await status(recep, id, 'agendado').expect(200);
    await remarcar(recep, id, new Date(Date.now() + DIA)).expect(409);
  });

  it('remarcar para o passado dá 409 horario_no_passado; marcar no passado também (R7)', async () => {
    const eu = await novoProfissional();
    const p = await novoPaciente(adminA);
    const id = await marcarPelaRota(recep, { paciente: p, profissional: eu.id, tipo: tipoA, inicio: new Date(Date.now() + DIA) });
    const r = await remarcar(recep, id, new Date(Date.now() - 2 * HORA));
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ codigo: 'horario_no_passado' });
    const { data, hora } = noFusoDaClinica(new Date(Date.now() - 2 * HORA));
    const c = await api
      .http()
      .post('/agendamentos')
      .set(cab(recep))
      .send({ pacienteId: p, profissionalId: eu.id, tipoId: tipoA, data, hora, encaixe: true });
    expect(c.status).toBe(409);
    expect(c.body).toMatchObject({ codigo: 'horario_no_passado' });
  });

  it('V2-c: remarcação pelo PRÓPRIO profissional vira autoagendamento (sem agenda do dia; alerta ao atender)', async () => {
    const eu = await novoProfissional();
    const p = await novoPaciente(adminA);
    const amanha = new Date(Date.now() + DIA);
    const id = await marcarPelaRota(recep, { paciente: p, profissional: eu.id, tipo: tipoA, inicio: amanha });
    await remarcar(eu.sessao, id, new Date()).expect(200);
    expect(await servico.temVinculoDeCuidado(ctx(clinicaA, eu.sessao), p, new Date())).toMatchObject({ temVinculo: false, base: null });
    await api.http().post(`/agendamentos/${id}/check-in`).set(cab(recep)).expect(200);
    expect(await alertasDe(clinicaA, eu.sessao.userId)).toHaveLength(0);
    await status(eu.sessao, id, 'em_atendimento').expect(200);
    expect(await servico.temVinculoDeCuidado(ctx(clinicaA, eu.sessao), p, new Date())).toMatchObject({ base: 'autoagendamento' });
    const alertas = await alertasDe(clinicaA, eu.sessao.userId);
    expect(alertas).toHaveLength(1);
    expect(alertas[0]?.metadata).toEqual({ rule: 'vinculo_autoagendado', window_s: 86_400, threshold: 0, count: 1 });
    // O histórico guarda o horário original, quem remarcou e o novo horário.
    const h = await historico(id);
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ rescheduledBy: eu.sessao.userId, tenantId: clinicaA });
    expect(h[0]?.fromStartsAt.toISOString()).toBe(new Date(Math.floor(amanha.getTime() / 60_000) * 60_000).toISOString());
    expect((await linha(id))?.rescheduledBy).toBe(eu.sessao.userId);
  });

  it('positivo: a RECEPÇÃO remarca uma consulta futura para hoje e o vínculo sai como agenda do dia', async () => {
    const eu = await novoProfissional();
    const p = await novoPaciente(adminA);
    const id = await marcarPelaRota(recep, { paciente: p, profissional: eu.id, tipo: tipoA, inicio: new Date(Date.now() + 3 * DIA) });
    expect(await servico.temVinculoDeCuidado(ctx(clinicaA, eu.sessao), p, new Date())).toMatchObject({ temVinculo: false });
    await remarcar(recep, id, new Date(Date.now() + HORA)).expect(200);
    expect(await servico.temVinculoDeCuidado(ctx(clinicaA, eu.sessao), p, new Date())).toMatchObject({ base: 'agenda_do_dia' });
    const h = await historico(id);
    expect(h).toHaveLength(1);
    expect(h[0]?.rescheduledBy).toBe(recep.userId);
  });

  it('histórico append-only e rescheduled_by só muda com o horário (banco)', async () => {
    const eu = await novoProfissional();
    const p = await novoPaciente(adminA);
    const id = await marcarPelaRota(recep, { paciente: p, profissional: eu.id, tipo: tipoA, inicio: new Date(Date.now() + DIA) });
    await remarcar(recep, id, new Date(Date.now() + 2 * DIA)).expect(200);
    const [h] = await historico(id);
    expect(h).toBeDefined();
    const tentativas: [string, (tx: TenantTx) => Promise<unknown>][] = [
      ['insert direto', (tx) => tx.insert(appointmentReschedules).values({ ...h!, id: randomUUID() })],
      ['update', (tx) => tx.update(appointmentReschedules).set({ rescheduledBy: eu.sessao.userId }).where(eq(appointmentReschedules.id, h!.id))],
      ['delete', (tx) => tx.delete(appointmentReschedules).where(eq(appointmentReschedules.id, h!.id))],
      ['rescheduled_by sem mudar horário', (tx) => tx.update(appointments).set({ rescheduledBy: randomUUID() }).where(eq(appointments.id, id))],
      ['rescheduled_by para NULL', (tx) => tx.update(appointments).set({ rescheduledBy: null }).where(eq(appointments.id, id))],
    ];
    for (const [nome, f] of tentativas) {
      await expect(withTenant(api.db.db, clinicaA, f), nome).rejects.toThrow();
    }
    expect(await historico(id)).toHaveLength(1);
    expect((await linha(id))?.rescheduledBy).toBe(recep.userId);
  });

  it('histórico de outra clínica é invisível', async () => {
    const eu = await novoProfissional();
    const p = await novoPaciente(adminA);
    const id = await marcarPelaRota(recep, { paciente: p, profissional: eu.id, tipo: tipoA, inicio: new Date(Date.now() + DIA) });
    await remarcar(recep, id, new Date(Date.now() + 2 * DIA)).expect(200);
    const deB = await withTenant(api.db.db, clinicaB, (tx) =>
      tx.select().from(appointmentReschedules).where(eq(appointmentReschedules.appointmentId, id)),
    );
    expect(deB).toHaveLength(0);
    // E a remarcação pela sessão de B dá 404 (o agendamento de A não existe para B).
    await remarcar(adminB, id, new Date(Date.now() + 3 * DIA)).expect(404);
  });

  it('R8: a recepção remarcar depois NÃO lava a marca de autoagendamento (vale o histórico inteiro)', async () => {
    const eu = await novoProfissional();
    const p = await novoPaciente(adminA);
    const id = await marcarPelaRota(recep, { paciente: p, profissional: eu.id, tipo: tipoA, inicio: new Date(Date.now() + 3 * DIA) });
    await remarcar(eu.sessao, id, new Date(Date.now() + 2 * DIA)).expect(200);
    await remarcar(recep, id, new Date()).expect(200);
    expect((await linha(id))?.rescheduledBy).toBe(recep.userId);
    expect(await historico(id)).toHaveLength(2);
    // Último remarcador é a recepção, mas o profissional remarcou antes: continua autoagendado.
    expect(await servico.temVinculoDeCuidado(ctx(clinicaA, eu.sessao), p, new Date())).toMatchObject({ temVinculo: false, base: null });
    await api.http().post(`/agendamentos/${id}/check-in`).set(cab(recep)).expect(200);
    await status(eu.sessao, id, 'em_atendimento').expect(200);
    expect(await servico.temVinculoDeCuidado(ctx(clinicaA, eu.sessao), p, new Date())).toMatchObject({ base: 'autoagendamento' });
    const alertas = await alertasDe(clinicaA, eu.sessao.userId);
    expect(alertas).toHaveLength(1);
    expect(alertas[0]?.metadata).toMatchObject({ rule: 'vinculo_autoagendado', count: 1 });
  });

  it('R9: o banco exige created_by e rescheduled_by = usuário da sessão travado na transação', async () => {
    const eu = await novoProfissional();
    const p = await novoPaciente(adminA);
    const base = { tenantId: clinicaA, patientId: p, professionalId: eu.id, appointmentTypeId: tipoA };
    const inicio = new Date(Date.now() + 5 * DIA);
    const novo = (criadoPor: string | null) => ({
      ...base,
      createdBy: criadoPor,
      startsAt: inicio,
      endsAt: new Date(inicio.getTime() + 50 * 60_000),
    });
    // INSERT: criador forjado (a recepção "assina" um agendamento que o profissional criou), NULL, ou sem usuário na transação.
    await expect(withTenant(api.db.db, clinicaA, (tx) => tx.insert(appointments).values(novo(recep.userId)), eu.sessao.userId)).rejects.toThrow();
    await expect(withTenant(api.db.db, clinicaA, (tx) => tx.insert(appointments).values(novo(null)), eu.sessao.userId)).rejects.toThrow();
    await expect(withTenant(api.db.db, clinicaA, (tx) => tx.insert(appointments).values(novo(eu.sessao.userId)))).rejects.toThrow();
    // O usuário fica travado: trocar no meio da transação é recusado; sem tenant antes, também.
    await expect(
      withTenant(api.db.db, clinicaA, async (tx) => {
        await tx.execute(sql`select app_set_user(${recep.userId}::uuid)`);
      }, eu.sessao.userId),
    ).rejects.toThrow();
    await expect(api.db.db.transaction((tx) => tx.execute(sql`select app_set_user(${recep.userId}::uuid)`))).rejects.toThrow();
    // Remarcação: o profissional não pode gravar a recepção como remarcadora (e não pode remarcar sem usuário).
    const id = await marcarPelaRota(recep, { paciente: p, profissional: eu.id, tipo: tipoA, inicio });
    const mover = (quem: string) => (tx: TenantTx) =>
      tx
        .update(appointments)
        .set({ startsAt: new Date(inicio.getTime() + DIA), endsAt: new Date(inicio.getTime() + DIA + 50 * 60_000), rescheduledBy: quem })
        .where(eq(appointments.id, id));
    await expect(withTenant(api.db.db, clinicaA, mover(recep.userId), eu.sessao.userId)).rejects.toThrow();
    await expect(withTenant(api.db.db, clinicaA, mover(recep.userId))).rejects.toThrow();
    expect(await historico(id)).toHaveLength(0);
    // Com o usuário certo, passa (é o que a rota faz).
    await withTenant(api.db.db, clinicaA, mover(eu.sessao.userId), eu.sessao.userId);
    expect((await historico(id))[0]?.rescheduledBy).toBe(eu.sessao.userId);
  });

  it('R10: transação sem usuário trava o slot com o sentinela de sistema; SQL injetado não define usuário', async () => {
    const eu = await novoProfissional();
    const p = await novoPaciente(adminA);
    const codigos = async (q: Promise<unknown>): Promise<unknown[]> => {
      const err: unknown = await q.then(() => undefined, (e: unknown) => e);
      expect(err, 'era esperado erro').toBeDefined();
      const out: unknown[] = [];
      for (let e: unknown = err; e instanceof Error; e = e.cause) out.push((e as { code?: unknown }).code);
      return out;
    };
    // Job do sistema (sem userId): o banco vê sessão de sistema e nenhum usuário.
    const estado = await withTenant(api.db.db, clinicaA, async (tx) =>
      (await tx.execute<{ sis: boolean; u: string | null }>(sql`select app_is_system_session() as sis, app_current_user() as u`))[0],
    );
    expect(estado).toEqual({ sis: true, u: null });
    // SQL injetado tentando se declarar usuário depois (qualquer UUID, inclusive o de um admin): 42501.
    expect(
      await codigos(withTenant(api.db.db, clinicaA, (tx) => tx.execute(sql`select app_set_user(${eu.sessao.userId}::uuid)`))),
    ).toContain('42501');
    expect(
      await codigos(withTenant(api.db.db, clinicaA, (tx) => tx.execute(sql`select app_set_user(${adminA.userId}::uuid)`))),
    ).toContain('42501');
    // Injeção "empilhada" com savepoint também não libera o slot.
    expect(
      await codigos(
        withTenant(api.db.db, clinicaA, (tx) =>
          tx.transaction((sp) => sp.execute(sql`select app_set_user(${eu.sessao.userId}::uuid)`)),
        ),
      ),
    ).toContain('42501');
    // Ninguém se declara sistema pela porta do usuário, nem troca usuário por sistema.
    await expect(
      withTenant(api.db.db, clinicaA, (tx) => tx.execute(sql`select app_set_user('00000000-0000-0000-0000-000000000000'::uuid)`), eu.sessao.userId),
    ).rejects.toThrow();
    expect(
      await codigos(withTenant(api.db.db, clinicaA, (tx) => tx.execute(sql`select app_set_system_user()`), eu.sessao.userId)),
    ).toContain('42501');
    await expect(withTenant(api.db.db, clinicaA, () => Promise.resolve(undefined), '00000000-0000-0000-0000-000000000000')).rejects.toThrow(
      /user_id inválido/,
    );
    // Sentinela não é autor: o job do sistema não cria agendamento, nem gravando o sentinela como criador.
    const inicio = new Date(Date.now() + 6 * DIA);
    const linha = (criadoPor: string) => ({
      tenantId: clinicaA, patientId: p, professionalId: eu.id, appointmentTypeId: tipoA, createdBy: criadoPor,
      startsAt: inicio, endsAt: new Date(inicio.getTime() + 50 * 60_000),
    });
    await expect(withTenant(api.db.db, clinicaA, (tx) => tx.insert(appointments).values(linha('00000000-0000-0000-0000-000000000000')))).rejects.toThrow();
    await expect(withTenant(api.db.db, clinicaA, (tx) => tx.insert(appointments).values(linha(eu.sessao.userId)))).rejects.toThrow();
  });
});

describe('janela de continuidade por clínica (R1 do #61)', () => {
  it('padrão 90, teto 180; só o admin muda; auditado; vale só para a clínica dele', async () => {
    const clinica = await api.novaClinica();
    const admin = api.sessao(clinica, 'admin');
    const prof = api.sessao(clinica, 'profissional');
    const profId = await profissional(admin, prof.userId);
    const t = await tipo(admin);
    await api.http().get('/clinica/vinculo-de-cuidado').set(cab(admin)).expect(200, { dias: 90, teto: 180 });
    await api.http().put('/clinica/vinculo-de-cuidado').set(cab(prof)).send({ dias: 180 }).expect(403);
    for (const dias of [0, 181, 30.5, '30']) {
      await api.http().put('/clinica/vinculo-de-cuidado').set(cab(admin)).send({ dias }).expect(400);
    }
    const p = await novoPaciente(admin);
    await agendamento(clinica, { paciente: p, profissional: profId, tipo: t, inicio: new Date(Date.now() - 45 * DIA), status: 'completed' });
    expect(await servico.temVinculoDeCuidado(ctx(clinica, prof), p, new Date())).toMatchObject({ base: 'atendimento' });
    await api.http().put('/clinica/vinculo-de-cuidado').set(cab(admin)).send({ dias: 30 }).expect(200, { dias: 30, teto: 180 });
    expect(await servico.temVinculoDeCuidado(ctx(clinica, prof), p, new Date())).toMatchObject({ temVinculo: false });
    // Outra clínica segue no padrão.
    await api.http().get('/clinica/vinculo-de-cuidado').set(cab(adminA)).expect(200, { dias: 90, teto: 180 });
    const [evento] = await withTenant(api.db.db, clinica, (tx) =>
      tx
        .select({ metadata: auditLog.metadata })
        .from(auditLog)
        .where(and(eq(auditLog.tenantId, clinica), eq(auditLog.scope, 'tenants'), eq(auditLog.actorId, admin.userId))),
    );
    expect(evento?.metadata).toEqual({ setting: 'care_link_days', from: 90, to: 30 });
    // O banco recusa acima do teto mesmo sem passar pela API.
    await expect(
      withTenant(api.db.db, clinica, (tx) => tx.update(tenants).set({ careLinkDays: 365 }).where(eq(tenants.id, clinica))),
    ).rejects.toThrow();
  });
});
