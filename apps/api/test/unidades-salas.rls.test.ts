/**
 * Unidades e salas (migração 0101, HU-NUC-002) e sala sem conflito na agenda (HU-AGD-004) contra Postgres REAL:
 * isolamento entre clínicas em units/rooms e em appointments.room_id, gestão só do admin, conflito de sala recusado
 * pelo banco (inclusive com duas transações concorrentes), remarcação para sala ocupada, cancelado não conta,
 * capacidade da sala e auditoria. Pré-requisitos: migrações aplicadas e DATABASE_URL = papel app_user.
 * Dados 100% fictícios.
 */
import type { TenantId } from '@plataforma/shared';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appointments, auditLog, rooms, units } from '../src/db/schema';
import { createDatabase, withTenant, type DatabaseHandle } from '../src/db/tenant-transaction';
import { paraInstante } from '../src/modules/scheduling/agenda-regras';
import { cab, subirApi, type ApiDeTeste } from './apoio-api';

type Sessao = { Authorization: string; userId: string };

let api: ApiDeTeste;
let paralelo: DatabaseHandle;
let clinicaA: TenantId;
let clinicaB: TenantId;
let adminA: Sessao;
let recepA: Sessao;
let adminB: Sessao;
let profs: string[] = [];
let tipoA: string;
let pacienteA: string;
let unidadeA: string;
let salaA: string;
let ginasioA: string;
let unidadeB: string;
let salaB: string;
let pacienteB: string;
let profB: string;
let tipoB: string;

/** Código SQLSTATE em qualquer ponto da cadeia de causas (não depende do idioma do servidor). */
async function sqlstate(p: Promise<unknown>): Promise<unknown[]> {
  const err: unknown = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, 'era esperado erro do banco').toBeDefined();
  const codigos: unknown[] = [];
  for (let e: unknown = err; e instanceof Error; e = e.cause) codigos.push((e as { code?: unknown }).code);
  return codigos;
}

async function criar<T = { id: string }>(s: Sessao, rota: string, corpo: Record<string, unknown>): Promise<T> {
  const res = await api.http().post(rota).set(cab(s)).send(corpo);
  expect(res.status, `${rota}: ${JSON.stringify(res.body)}`).toBe(201);
  return res.body as T;
}

function agendar(s: Sessao, profissionalId: string, data: string, hora: string, salaId?: string, pacienteId = pacienteA, tipoId = tipoA) {
  return api
    .http()
    .post('/agendamentos')
    .set(cab(s))
    .send({ pacienteId, profissionalId, tipoId, data, hora, ...(salaId ? { salaId } : {}) });
}

function remarcar(s: Sessao, id: string, corpo: Record<string, unknown>) {
  return api.http().post(`/agendamentos/${id}/remarcar`).set(cab(s)).send(corpo);
}

/** INSERT direto (sem o serviço): prova que a regra é do banco. */
function inserirDireto(tenant: TenantId, usuario: string, valores: { profissionalId: string; inicio: Date; salaId: string; pacienteId?: string; tipoId?: string }, db = api.db.db) {
  return withTenant(
    db,
    tenant,
    (tx) =>
      tx
        .insert(appointments)
        .values({
          tenantId: tenant,
          patientId: valores.pacienteId ?? pacienteA,
          professionalId: valores.profissionalId,
          appointmentTypeId: valores.tipoId ?? tipoA,
          startsAt: valores.inicio,
          endsAt: new Date(valores.inicio.getTime() + 60 * 60_000),
          createdBy: usuario,
          roomId: valores.salaId,
        })
        .returning({ id: appointments.id }),
    usuario,
  );
}

beforeAll(async () => {
  api = await subirApi();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL (papel app_user) é obrigatória');
  // Pool próprio para as duas transações concorrentes (o da apoio-api tem 2 vagas).
  paralelo = createDatabase(url, { max: 3 });
  clinicaA = await api.novaClinica();
  clinicaB = await api.novaClinica();
  adminA = api.sessao(clinicaA, 'admin');
  recepA = api.sessao(clinicaA, 'recepcao');
  adminB = api.sessao(clinicaB, 'admin');

  profs = [];
  for (const nome of ['Fisio Ficticia Um', 'Fisio Ficticia Dois', 'Fisio Ficticia Tres']) {
    profs.push((await criar(adminA, '/profissionais', { nome, especialidade: 'Fisioterapia' })).id);
  }
  tipoA = (await criar(adminA, '/tipos-atendimento', { nome: 'Sessao Ficticia', minutos: 60 })).id;
  pacienteA = (await criar(recepA, '/pacientes', { nome: 'Paciente Ficticia Sala', telefone: '(11) 90000-0101' })).id;
  unidadeA = (await criar(adminA, '/unidades', { nome: 'Centro Ficticio' })).id;
  salaA = (await criar(adminA, '/salas', { unidadeId: unidadeA, nome: 'Sala 2' })).id;
  ginasioA = (await criar(adminA, '/salas', { unidadeId: unidadeA, nome: 'Ginasio', capacidade: 2 })).id;

  unidadeB = (await criar(adminB, '/unidades', { nome: 'Unidade Ficticia B' })).id;
  salaB = (await criar(adminB, '/salas', { unidadeId: unidadeB, nome: 'Sala B' })).id;
  pacienteB = (await criar(adminB, '/pacientes', { nome: 'Paciente Ficticio B', telefone: '(11) 90000-0102' })).id;
  profB = (await criar(adminB, '/profissionais', { nome: 'Psico Ficticio B', especialidade: 'Psicologia' })).id;
  tipoB = (await criar(adminB, '/tipos-atendimento', { nome: 'Sessao B', minutos: 50 })).id;
});

afterAll(async () => {
  await paralelo?.close();
  await api?.fechar();
});

describe('RLS em units e rooms (0101)', () => {
  it('outra clínica não vê unidade nem sala (banco e API)', async () => {
    const visto = await withTenant(api.db.db, clinicaB, async (tx) => ({
      unidades: await tx.select().from(units).where(eq(units.id, unidadeA)),
      salas: await tx.select().from(rooms).where(eq(rooms.id, salaA)),
      todasAsSalas: await tx.select({ tenantId: rooms.tenantId }).from(rooms),
    }));
    expect(visto.unidades).toEqual([]);
    expect(visto.salas).toEqual([]);
    expect(visto.todasAsSalas.every((s) => s.tenantId === clinicaB)).toBe(true);

    const salasB = await api.http().get('/salas').set(cab(adminB));
    expect(salasB.status).toBe(200);
    expect((salasB.body as { id: string }[]).map((s) => s.id)).toEqual([salaB]);
    const unidadesB = await api.http().get('/unidades').set(cab(adminB));
    expect((unidadesB.body as { id: string }[]).map((u) => u.id)).toEqual([unidadeB]);
    // Alterar a sala/unidade de A a partir de B: 404, como inexistente.
    expect((await api.http().patch(`/salas/${salaA}`).set(cab(adminB)).send({ ativa: false })).status).toBe(404);
    expect((await api.http().patch(`/unidades/${unidadeA}`).set(cab(adminB)).send({ ativa: false })).status).toBe(404);
    // Sala em unidade de outra clínica: 404.
    expect((await api.http().post('/salas').set(cab(adminB)).send({ unidadeId: unidadeA, nome: 'Intrusa' })).status).toBe(404);
  });

  it('INSERT com tenant de outra clínica (WITH CHECK) e sala apontando para unidade de outra clínica (FK composta)', async () => {
    expect(await sqlstate(withTenant(api.db.db, clinicaA, (tx) => tx.insert(units).values({ tenantId: clinicaB, name: 'Intrusa' })))).toContain('42501');
    expect(
      await sqlstate(withTenant(api.db.db, clinicaA, (tx) => tx.insert(rooms).values({ tenantId: clinicaA, unitId: unidadeB, name: 'Intrusa' }))),
    ).toContain('23503');
  });

  it('o runtime não apaga unidade nem sala; a sala não muda de unidade', async () => {
    expect(await sqlstate(withTenant(api.db.db, clinicaA, (tx) => tx.delete(rooms).where(eq(rooms.id, salaA))))).toContain('42501');
    expect(await sqlstate(withTenant(api.db.db, clinicaA, (tx) => tx.delete(units).where(eq(units.id, unidadeA))))).toContain('42501');
    const outra = (await criar(adminA, '/unidades', { nome: 'Unidade Ficticia Norte' })).id;
    expect(
      await sqlstate(withTenant(api.db.db, clinicaA, (tx) => tx.update(rooms).set({ unitId: outra }).where(eq(rooms.id, salaA)))),
    ).toContain('23514');
  });

  it('gestão só do admin; a recepção lê (escolhe a sala ao agendar)', async () => {
    expect((await api.http().post('/unidades').set(cab(recepA)).send({ nome: 'Recepcao Nao' })).status).toBe(403);
    expect((await api.http().post('/salas').set(cab(recepA)).send({ unidadeId: unidadeA, nome: 'Recepcao Nao' })).status).toBe(403);
    expect((await api.http().patch(`/salas/${salaA}`).set(cab(recepA)).send({ capacidade: 3 })).status).toBe(403);
    const lidas = await api.http().get(`/salas?unidadeId=${unidadeA}`).set(cab(recepA));
    expect(lidas.status).toBe(200);
    expect((lidas.body as { id: string }[]).map((s) => s.id).sort()).toEqual([salaA, ginasioA].sort());
  });

  it('nome repetido na mesma unidade: 409 nome_em_uso', async () => {
    const res = await api.http().post('/salas').set(cab(adminA)).send({ unidadeId: unidadeA, nome: 'sala 2' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ codigo: 'nome_em_uso' });
  });
});

describe('sala no agendamento (HU-AGD-004)', () => {
  it('sala de outra clínica é recusada no agendamento (404 pela API; gatilho e FK composta no banco)', async () => {
    const res = await agendar(adminB, profB, '2030-06-03', '09:00', salaA, pacienteB, tipoB);
    expect(res.status).toBe(404);
    // Agendamento vivo: o gatilho (BEFORE) não acha a sala pelo RLS e recusa antes da FK.
    const usuario = randomUUID();
    const codigos = await sqlstate(
      inserirDireto(clinicaB, usuario, { profissionalId: profB, pacienteId: pacienteB, tipoId: tipoB, inicio: paraInstante('2030-06-03', '09:00'), salaId: salaA }),
    );
    expect(codigos).toContain('23514');
    // Mesmo cancelado (o gatilho não confere ocupação), a FK composta (room_id, tenant_id) recusa.
    const inicio = paraInstante('2030-06-03', '09:00');
    const fk = await sqlstate(
      withTenant(
        api.db.db,
        clinicaB,
        (tx) =>
          tx.insert(appointments).values({
            tenantId: clinicaB, patientId: pacienteB, professionalId: profB, appointmentTypeId: tipoB, startsAt: inicio,
            endsAt: new Date(inicio.getTime() + 50 * 60_000), createdBy: usuario, roomId: salaA, status: 'cancelled', cancelledAt: new Date(),
          }),
        usuario,
      ),
    );
    expect(fk).toContain('23503');
  });

  it('conflito de sala recusado; horário encostado (fim = início) passa', async () => {
    const primeiro = await agendar(recepA, profs[0] as string, '2030-06-03', '10:00', salaA);
    expect(primeiro.status, JSON.stringify(primeiro.body)).toBe(201);
    expect(primeiro.body).toMatchObject({ salaId: salaA });
    const sobreposto = await agendar(recepA, profs[1] as string, '2030-06-03', '10:30', salaA);
    expect(sobreposto.status).toBe(409);
    expect(sobreposto.body).toMatchObject({ codigo: 'sala_ocupada' });
    const encostado = await agendar(recepA, profs[1] as string, '2030-06-03', '11:00', salaA);
    expect(encostado.status).toBe(201);
    // Sem sala, o mesmo horário não conflita com a sala.
    expect((await agendar(recepA, profs[2] as string, '2030-06-03', '10:30')).status).toBe(201);
  });

  it('concorrência pela API: dois pedidos simultâneos na mesma sala, só um entra', async () => {
    const [a, b] = await Promise.all([
      agendar(recepA, profs[0] as string, '2030-06-04', '10:00', salaA),
      agendar(adminA, profs[1] as string, '2030-06-04', '10:00', salaA),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const n = await withTenant(api.db.db, clinicaA, (tx) =>
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(appointments)
        .where(and(eq(appointments.roomId, salaA), eq(appointments.startsAt, paraInstante('2030-06-04', '10:00')))),
    );
    expect(n[0]?.n).toBe(1);
  });

  it('concorrência no banco: duas transações abertas ao mesmo tempo, a segunda espera a trava e é recusada', async () => {
    const inicio = paraInstante('2030-06-10', '15:00');
    let avisarInseriu: () => void = () => undefined;
    const inseriu = new Promise<void>((r) => (avisarInseriu = r));
    let liberar: () => void = () => undefined;
    const podeCommitar = new Promise<void>((r) => (liberar = r));
    const u1 = randomUUID();
    const u2 = randomUUID();

    const t1 = withTenant(
      paralelo.db,
      clinicaA,
      async (tx) => {
        await tx.insert(appointments).values({
          tenantId: clinicaA, patientId: pacienteA, professionalId: profs[0] as string, appointmentTypeId: tipoA,
          startsAt: inicio, endsAt: new Date(inicio.getTime() + 60 * 60_000), createdBy: u1, roomId: salaA,
        });
        avisarInseriu();
        await podeCommitar;
      },
      u1,
    );
    await inseriu;
    // A segunda transação começa com a primeira ainda aberta (sem COMMIT): o gatilho dela espera a trava da sala.
    const t2 = sqlstate(inserirDireto(clinicaA, u2, { profissionalId: profs[1] as string, inicio: new Date(inicio.getTime() + 30 * 60_000), salaId: salaA }, paralelo.db));
    await new Promise((r) => setTimeout(r, 300));
    liberar();
    await t1;
    expect(await t2).toContain('23P01');
  });

  it('remarcar para sala ocupada é recusado; cancelado não conta', async () => {
    const ocupa = await agendar(recepA, profs[0] as string, '2030-06-05', '10:00', salaA);
    expect(ocupa.status).toBe(201);
    const outro = await agendar(recepA, profs[1] as string, '2030-06-05', '14:00', salaA);
    expect(outro.status).toBe(201);
    const semSala = await agendar(recepA, profs[2] as string, '2030-06-05', '16:00');
    expect(semSala.status).toBe(201);
    const idOcupa = (ocupa.body as { id: string }).id;
    const idOutro = (outro.body as { id: string }).id;
    const idSemSala = (semSala.body as { id: string }).id;

    // Horário novo sobreposto na mesma sala.
    const r1 = await remarcar(recepA, idOutro, { data: '2030-06-05', hora: '10:30' });
    expect(r1.status).toBe(409);
    expect(r1.body).toMatchObject({ codigo: 'sala_ocupada' });
    // Trocar para a sala ocupada no horário.
    const r2 = await remarcar(recepA, idSemSala, { data: '2030-06-05', hora: '10:00', salaId: salaA });
    expect(r2.status).toBe(409);
    expect(r2.body).toMatchObject({ codigo: 'sala_ocupada' });

    // Cancelado libera a sala.
    expect((await api.http().post(`/agendamentos/${idOcupa}/cancelar`).set(cab(recepA)).send({})).status).toBe(200);
    expect((await remarcar(recepA, idOutro, { data: '2030-06-05', hora: '10:30' })).status).toBe(200);
    expect((await remarcar(recepA, idSemSala, { data: '2030-06-05', hora: '12:00', salaId: salaA })).status).toBe(200);
    // E um agendamento novo no horário do cancelado, sem sobrepor os vivos.
    expect((await agendar(recepA, profs[0] as string, '2030-06-05', '09:00', salaA)).status).toBe(201);

    const salas = await withTenant(api.db.db, clinicaA, (tx) =>
      tx.select({ id: appointments.id, sala: appointments.roomId }).from(appointments).where(eq(appointments.id, idSemSala)),
    );
    expect(salas[0]?.sala).toBe(salaA);
    // Remarcar com `salaId: null` tira a sala.
    expect((await remarcar(recepA, idSemSala, { data: '2030-06-05', hora: '10:30', salaId: null })).status).toBe(200);
  });

  it('sala com capacidade 2: dois simultâneos entram, o terceiro não', async () => {
    expect((await agendar(recepA, profs[0] as string, '2030-06-06', '08:00', ginasioA)).status).toBe(201);
    expect((await agendar(recepA, profs[1] as string, '2030-06-06', '08:30', ginasioA)).status).toBe(201);
    const terceiro = await agendar(recepA, profs[2] as string, '2030-06-06', '08:00', ginasioA);
    expect(terceiro.status).toBe(409);
    expect(terceiro.body).toMatchObject({ codigo: 'sala_ocupada' });
  });

  it('sala inativa (ou de unidade inativa) não recebe agendamento', async () => {
    const unidade = (await criar(adminA, '/unidades', { nome: 'Unidade Ficticia Sul' })).id;
    const sala = (await criar(adminA, '/salas', { unidadeId: unidade, nome: 'Sala Sul' })).id;
    expect((await api.http().patch(`/salas/${sala}`).set(cab(adminA)).send({ ativa: false })).status).toBe(200);
    const r1 = await agendar(recepA, profs[0] as string, '2030-06-07', '10:00', sala);
    expect(r1.status).toBe(409);
    expect(r1.body).toMatchObject({ codigo: 'sala_inativa' });
    expect(await sqlstate(inserirDireto(clinicaA, randomUUID(), { profissionalId: profs[0] as string, inicio: paraInstante('2030-06-07', '10:00'), salaId: sala }))).toContain('23514');

    expect((await api.http().patch(`/salas/${sala}`).set(cab(adminA)).send({ ativa: true })).status).toBe(200);
    expect((await api.http().patch(`/unidades/${unidade}`).set(cab(adminA)).send({ ativa: false })).status).toBe(200);
    const r2 = await agendar(recepA, profs[0] as string, '2030-06-07', '10:00', sala);
    expect(r2.status).toBe(409);
    expect(r2.body).toMatchObject({ codigo: 'sala_inativa' });
  });

  it('auditoria: criar e alterar sala/unidade e agendar com sala ficam na trilha, só com ids', async () => {
    const trilha = await withTenant(api.db.db, clinicaA, (tx) =>
      tx.select({ scope: auditLog.scope, action: auditLog.action, metadata: auditLog.metadata }).from(auditLog),
    );
    const daSala = trilha.filter((l) => l.scope === 'rooms');
    expect(daSala.some((l) => (l.metadata as Record<string, unknown>)['room_id'] === salaA)).toBe(true);
    expect(trilha.some((l) => l.scope === 'units' && (l.metadata as Record<string, unknown>)['unit_id'] === unidadeA)).toBe(true);
    expect(trilha.some((l) => l.scope === 'appointments' && (l.metadata as Record<string, unknown>)['room_id'] === salaA)).toBe(true);
    const serial = JSON.stringify(trilha);
    for (const nome of ['Sala 2', 'Centro Ficticio', 'Ginasio']) expect(serial).not.toContain(nome);
  });
});
