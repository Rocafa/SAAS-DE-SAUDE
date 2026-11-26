/**
 * Grade semanal, bloqueios e feriados da agenda (migração 0100, HU-AGD-001/003) contra Postgres REAL: isolamento
 * entre clínicas nas tabelas novas (professional_schedules, schedule_blocks, clinic_holidays), perfis que configuram,
 * recusa da marcação e da remarcação fora da grade, em feriado e em bloqueio, encaixe, triggers (nada se apaga) e
 * auditoria. Pré-requisitos: migrações aplicadas e DATABASE_URL = papel app_user. Dados 100% fictícios.
 */
import type { TenantId } from '@plataforma/shared';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, clinicHolidays, professionalSchedules, scheduleBlocks } from '../src/db/schema';
import { withTenant, type TenantTx } from '../src/db/tenant-transaction';
import { cab, subirApi, type ApiDeTeste } from './apoio-api';

type Sessao = { Authorization: string; userId: string };

let api: ApiDeTeste;
let clinicaA: TenantId;
let clinicaB: TenantId;
let adminA: Sessao;
let recepA: Sessao;
let profA: Sessao;
let finA: Sessao;
let adminB: Sessao;
let profissionalA: string;
let outroProfissionalA: string;
let profissionalB: string;
let tipoA: string;
let pacienteA: string;
let bloqueioA: string;
let feriadoA: string;

const GRADE = [
  { diaSemana: 1, inicio: '08:00', fim: '12:00', minutos: 50 },
  { diaSemana: 1, inicio: '14:00', fim: '18:00', minutos: 50 },
  { diaSemana: 3, inicio: '08:00', fim: '12:00', minutos: 50 },
];
// Segundas-feiras fictícias em 2030.
const SEG_1 = '2030-05-06';
const SEG_FERIADO = '2030-05-13';
const SEG_BLOQUEIO = '2030-05-20';
const SEG_CLINICA_FECHADA = '2030-05-27';

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

function marcar(s: Sessao, data: string, hora: string, extra: Record<string, unknown> = {}) {
  return api
    .http()
    .post('/agendamentos')
    .set(cab(s))
    .send({ pacienteId: pacienteA, profissionalId: profissionalA, tipoId: tipoA, data, hora, ...extra });
}

function remarcar(s: Sessao, id: string, data: string, hora: string) {
  return api.http().post(`/agendamentos/${id}/remarcar`).set(cab(s)).send({ data, hora });
}

beforeAll(async () => {
  api = await subirApi();
  clinicaA = await api.novaClinica();
  clinicaB = await api.novaClinica();
  adminA = api.sessao(clinicaA, 'admin');
  recepA = api.sessao(clinicaA, 'recepcao');
  profA = api.sessao(clinicaA, 'profissional');
  finA = api.sessao(clinicaA, 'financeiro');
  adminB = api.sessao(clinicaB, 'admin');

  const prof = await api
    .http()
    .post('/profissionais')
    .set(cab(adminA))
    .send({ nome: 'Fisio Ficticio Grade', especialidade: 'Fisioterapia', usuarioId: profA.userId });
  expect(prof.status, JSON.stringify(prof.body)).toBe(201);
  profissionalA = (prof.body as { id: string }).id;
  outroProfissionalA = ((await api.http().post('/profissionais').set(cab(adminA)).send({ nome: 'Fono Ficticia', especialidade: 'Fonoaudiologia' })).body as { id: string }).id;
  tipoA = ((await api.http().post('/tipos-atendimento').set(cab(adminA)).send({ nome: 'Sessao', minutos: 50 })).body as { id: string }).id;
  const pac = await api.http().post('/pacientes').set(cab(recepA)).send({ nome: 'Paciente Ficticia Grade', telefone: '(11) 90000-0101' });
  expect(pac.status).toBe(201);
  pacienteA = (pac.body as { id: string }).id;
  profissionalB = ((await api.http().post('/profissionais').set(cab(adminB)).send({ nome: 'Psico Ficticio B', especialidade: 'Psicologia' })).body as { id: string }).id;
});

afterAll(async () => {
  await api?.fechar();
});

describe('perfis: só dono e recepção configuram', () => {
  it('profissional e financeiro não configuram a grade (403); recepção configura; todos leem', async () => {
    for (const s of [profA, finA]) {
      const r = await api.http().put(`/agenda/grade/${profissionalA}`).set(cab(s)).send({ janelas: GRADE });
      expect(r.status).toBe(403);
    }
    const ok = await api.http().put(`/agenda/grade/${profissionalA}`).set(cab(recepA)).send({ janelas: GRADE });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toHaveLength(3);
    const lida = await api.http().get('/agenda/grade').query({ profissionalId: profissionalA }).set(cab(finA));
    expect(lida.status).toBe(200);
    expect(lida.body).toEqual(GRADE);
  });

  it('profissional e financeiro não criam bloqueio nem feriado (403)', async () => {
    for (const s of [profA, finA]) {
      const b = await api.http().post('/agenda/bloqueios').set(cab(s)).send({ dataInicio: '2030-06-01', dataFim: '2030-06-02', motivo: 'ferias' });
      expect(b.status).toBe(403);
      const f = await api.http().post('/agenda/feriados').set(cab(s)).send({ data: '2030-06-03', nome: 'Feriado ficticio' });
      expect(f.status).toBe(403);
    }
  });

  it('grade com janelas sobrepostas: 409 janelas_sobrepostas (a anterior fica)', async () => {
    const r = await api
      .http()
      .put(`/agenda/grade/${profissionalA}`)
      .set(cab(adminA))
      .send({ janelas: [...GRADE, { diaSemana: 1, inicio: '11:00', fim: '13:00', minutos: 50 }] });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ codigo: 'janelas_sobrepostas' });
    const lida = await api.http().get('/agenda/grade').query({ profissionalId: profissionalA }).set(cab(adminA));
    expect(lida.body).toEqual(GRADE);
  });
});

describe('marcação e remarcação respeitam a grade', () => {
  let agendamento: string;

  it('dentro da grade marca; fora (almoço, noite, dia sem janela) recusa com fora_da_grade', async () => {
    const ok = await marcar(recepA, SEG_1, '08:00');
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    agendamento = (ok.body as { id: string }).id;
    for (const [data, hora] of [
      [SEG_1, '11:30'],
      [SEG_1, '19:00'],
      ['2030-05-07', '09:00'],
    ] as const) {
      const r = await marcar(recepA, data, hora);
      expect(r.status, `${data} ${hora}`).toBe(409);
      expect(r.body).toEqual({ statusCode: 409, message: 'Conflito', codigo: 'fora_da_grade' });
    }
  });

  it('encaixe ignora a grade (decisão documentada)', async () => {
    const r = await marcar(recepA, SEG_1, '19:00', { encaixe: true });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((r.body as { encaixe: boolean }).encaixe).toBe(true);
  });

  it('profissional sem grade configurada continua com agenda livre', async () => {
    const r = await api
      .http()
      .post('/agendamentos')
      .set(cab(recepA))
      .send({ pacienteId: pacienteA, profissionalId: outroProfissionalA, tipoId: tipoA, data: SEG_1, hora: '21:00' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it('remarcar para fora da grade recusa; para dentro, passa', async () => {
    const fora = await remarcar(recepA, agendamento, SEG_1, '12:30');
    expect(fora.status).toBe(409);
    expect(fora.body).toMatchObject({ codigo: 'fora_da_grade' });
    const dentro = await remarcar(recepA, agendamento, SEG_1, '14:00');
    expect(dentro.status, JSON.stringify(dentro.body)).toBe(200);
  });
});

describe('feriado', () => {
  let agendamento: string;

  it('marcar e remarcar em feriado recusam com feriado (encaixe também)', async () => {
    const ag = await marcar(recepA, SEG_1, '09:00');
    expect(ag.status).toBe(201);
    agendamento = (ag.body as { id: string }).id;
    const f = await api.http().post('/agenda/feriados').set(cab(recepA)).send({ data: SEG_FERIADO, nome: 'Feriado municipal ficticio' });
    expect(f.status, JSON.stringify(f.body)).toBe(201);
    feriadoA = (f.body as { id: string }).id;
    expect(f.body).toMatchObject({ data: SEG_FERIADO, origem: 'clinica' });

    for (const extra of [{}, { encaixe: true }]) {
      const r = await marcar(recepA, SEG_FERIADO, '08:00', extra);
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ codigo: 'feriado' });
    }
    const rem = await remarcar(recepA, agendamento, SEG_FERIADO, '08:00');
    expect(rem.status).toBe(409);
    expect(rem.body).toMatchObject({ codigo: 'feriado' });

    const dup = await api.http().post('/agenda/feriados').set(cab(adminA)).send({ data: SEG_FERIADO, nome: 'Outro nome' });
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ codigo: 'feriado_ja_cadastrado' });
  });

  it('removido o feriado, a data volta a aceitar marcação', async () => {
    await api.http().post(`/agenda/feriados/${feriadoA}/remover`).set(cab(adminA)).expect(204);
    await api.http().post(`/agenda/feriados/${feriadoA}/remover`).set(cab(adminA)).expect(404);
    const r = await remarcar(recepA, agendamento, SEG_FERIADO, '08:00');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });

  it('feriados nacionais pré-carregados (idempotente)', async () => {
    const r = await api.http().post('/agenda/feriados/nacionais').set(cab(recepA)).send({ ano: 2030 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const lista = r.body as { data: string; nome: string; origem: string }[];
    expect(lista).toContainEqual(expect.objectContaining({ data: '2030-09-07', origem: 'nacional' }));
    expect(lista).toContainEqual(expect.objectContaining({ data: '2030-04-19', nome: 'Paixão de Cristo' }));
    const de_novo = await api.http().post('/agenda/feriados/nacionais').set(cab(recepA)).send({ ano: 2030 });
    expect((de_novo.body as unknown[]).length).toBe(lista.length);
    const lidos = await api.http().get('/agenda/feriados').query({ ano: '2030' }).set(cab(finA));
    expect(lidos.status).toBe(200);
    expect((lidos.body as unknown[]).length).toBe(lista.length);
  });
});

describe('bloqueio', () => {
  let agendamento: string;

  it('bloqueio do profissional recusa marcar e remarcar (horario_bloqueado), encaixe também; outro profissional não é afetado', async () => {
    const ag = await marcar(recepA, SEG_1, '10:00');
    expect(ag.status).toBe(201);
    agendamento = (ag.body as { id: string }).id;
    const b = await api
      .http()
      .post('/agenda/bloqueios')
      .set(cab(recepA))
      .send({ profissionalId: profissionalA, dataInicio: SEG_BLOQUEIO, dataFim: '2030-05-24', motivo: 'ferias' });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    bloqueioA = (b.body as { id: string }).id;
    expect(b.body).toMatchObject({ profissionalId: profissionalA, dataInicio: SEG_BLOQUEIO, horaInicio: '00:00', dataFim: '2030-05-25', horaFim: '00:00', motivo: 'ferias' });

    for (const extra of [{}, { encaixe: true }]) {
      const r = await marcar(recepA, SEG_BLOQUEIO, '08:00', extra);
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ codigo: 'horario_bloqueado' });
    }
    const rem = await remarcar(recepA, agendamento, SEG_BLOQUEIO, '08:00');
    expect(rem.status).toBe(409);
    expect(rem.body).toMatchObject({ codigo: 'horario_bloqueado' });
    const outro = await api
      .http()
      .post('/agendamentos')
      .set(cab(recepA))
      .send({ pacienteId: pacienteA, profissionalId: outroProfissionalA, tipoId: tipoA, data: SEG_BLOQUEIO, hora: '08:00' });
    expect(outro.status).toBe(201);
  });

  it('bloqueio da clínica inteira vale para todos os profissionais, só no intervalo', async () => {
    const b = await api
      .http()
      .post('/agenda/bloqueios')
      .set(cab(adminA))
      .send({ dataInicio: SEG_CLINICA_FECHADA, horaInicio: '08:00', dataFim: SEG_CLINICA_FECHADA, horaFim: '10:00', motivo: 'manutencao' });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    expect(b.body).toMatchObject({ profissionalId: null });
    const r = await marcar(recepA, SEG_CLINICA_FECHADA, '09:00');
    expect(r.body).toMatchObject({ codigo: 'horario_bloqueado' });
    const outro = await api
      .http()
      .post('/agendamentos')
      .set(cab(recepA))
      .send({ pacienteId: pacienteA, profissionalId: outroProfissionalA, tipoId: tipoA, data: SEG_CLINICA_FECHADA, hora: '09:10' });
    expect(outro.body).toMatchObject({ codigo: 'horario_bloqueado' });
    const depois = await marcar(recepA, SEG_CLINICA_FECHADA, '10:00');
    expect(depois.status, JSON.stringify(depois.body)).toBe(201);
  });

  it('listar bloqueios por período; removido o bloqueio, a remarcação passa', async () => {
    const l = await api.http().get('/agenda/bloqueios').query({ de: '2030-05-01', ate: '2030-05-31', profissionalId: profissionalA }).set(cab(finA));
    expect(l.status).toBe(200);
    expect((l.body as { id: string }[]).map((x) => x.id)).toContain(bloqueioA);
    await api.http().post(`/agenda/bloqueios/${bloqueioA}/remover`).set(cab(recepA)).expect(204);
    const rem = await remarcar(recepA, agendamento, SEG_BLOQUEIO, '08:00');
    expect(rem.status, JSON.stringify(rem.body)).toBe(200);
  });

  it('motivo de texto livre é recusado (400): o bloqueio nunca leva dado de paciente', async () => {
    const r = await api
      .http()
      .post('/agenda/bloqueios')
      .set(cab(adminA))
      .send({ profissionalId: profissionalA, dataInicio: '2030-06-10', dataFim: '2030-06-10', motivo: 'retorno da paciente' });
    expect(r.status).toBe(400);
  });
});

describe('isolamento entre clínicas (RLS)', () => {
  it('outra clínica não lê nem altera a grade, os bloqueios e os feriados de A pela API (404 / lista vazia)', async () => {
    expect((await api.http().get('/agenda/grade').query({ profissionalId: profissionalA }).set(cab(adminB))).status).toBe(404);
    expect((await api.http().put(`/agenda/grade/${profissionalA}`).set(cab(adminB)).send({ janelas: [] })).status).toBe(404);
    const b = await api.http().post('/agenda/bloqueios').set(cab(adminB)).send({ profissionalId: profissionalA, dataInicio: '2030-06-01', dataFim: '2030-06-01', motivo: 'ferias' });
    expect(b.status).toBe(404);
    const listaB = await api.http().get('/agenda/bloqueios').query({ de: '2030-05-01', ate: '2030-06-30' }).set(cab(adminB));
    expect(listaB.body).toEqual([]);
    const feriadosB = await api.http().get('/agenda/feriados').query({ ano: '2030' }).set(cab(adminB));
    expect(feriadosB.body).toEqual([]);
    // Remover o da outra clínica: 404, e o bloqueio de A continua (o de A foi removido por A; o feriado nacional não).
    const [nacional] = await withTenant(api.db.db, clinicaA, (tx) =>
      tx.select({ id: clinicHolidays.id }).from(clinicHolidays).where(and(eq(clinicHolidays.tenantId, clinicaA), eq(clinicHolidays.source, 'nacional'))).limit(1),
    );
    expect((await api.http().post(`/agenda/feriados/${nacional?.id ?? ''}/remover`).set(cab(adminB))).status).toBe(404);
    const ainda = await api.http().get('/agenda/feriados').query({ ano: '2030' }).set(cab(adminA));
    expect((ainda.body as { id: string }[]).map((x) => x.id)).toContain(nacional?.id);
    // A grade de A continua a mesma.
    const grade = await api.http().get('/agenda/grade').query({ profissionalId: profissionalA }).set(cab(adminA));
    expect(grade.body).toEqual(GRADE);
  });

  it('no banco, a sessão de B não vê, não altera e não insere linha de A nas três tabelas', async () => {
    await withTenant(
      api.db.db,
      clinicaB,
      async (tx) => {
        expect(await tx.select().from(professionalSchedules)).toEqual([]);
        expect(await tx.select().from(scheduleBlocks)).toEqual([]);
        expect(await tx.select().from(clinicHolidays)).toEqual([]);
        const g = await tx.update(professionalSchedules).set({ active: false }).where(eq(professionalSchedules.professionalId, profissionalA)).returning();
        expect(g).toEqual([]);
        const f = await tx.update(clinicHolidays).set({ removedBy: adminB.userId, removedAt: new Date() }).returning();
        expect(f).toEqual([]);
      },
      adminB.userId,
    );
    for (const inserir of [
      (tx: TenantTx) =>
        tx.insert(professionalSchedules).values({ tenantId: clinicaA, professionalId: profissionalA, weekday: 2, startTime: '08:00', endTime: '09:00', slotMinutes: 30, createdBy: adminB.userId }),
      (tx: TenantTx) =>
        tx.insert(scheduleBlocks).values({ tenantId: clinicaA, startsAt: new Date('2030-07-01T11:00:00Z'), endsAt: new Date('2030-07-02T11:00:00Z'), reason: 'outro', createdBy: adminB.userId }),
      (tx: TenantTx) =>
        tx.insert(clinicHolidays).values({ tenantId: clinicaA, holidayDate: '2030-07-03', name: 'Invasor', source: 'clinica', createdBy: adminB.userId }),
    ]) {
      expect(await sqlstate(withTenant(api.db.db, clinicaB, inserir, adminB.userId))).toContain('42501');
    }
    // B também não aponta a grade dele para o profissional de A (FK composta com tenant_id).
    const codigos = await sqlstate(
      withTenant(
        api.db.db,
        clinicaB,
        (tx) => tx.insert(professionalSchedules).values({ tenantId: clinicaB, professionalId: profissionalA, weekday: 2, startTime: '08:00', endTime: '09:00', slotMinutes: 30, createdBy: adminB.userId }),
        adminB.userId,
      ),
    );
    expect(codigos).toContain('23503');
    expect(profissionalB).toBeDefined();
  });
});

describe('banco: nada se apaga e a trilha registra a configuração', () => {
  it('runtime sem DELETE; grade só desativa; bloqueio removido não muda mais', async () => {
    expect(await sqlstate(withTenant(api.db.db, clinicaA, (tx) => tx.delete(clinicHolidays), adminA.userId))).toContain('42501');
    expect(await sqlstate(withTenant(api.db.db, clinicaA, (tx) => tx.delete(scheduleBlocks), adminA.userId))).toContain('42501');
    expect(await sqlstate(withTenant(api.db.db, clinicaA, (tx) => tx.delete(professionalSchedules), adminA.userId))).toContain('42501');
    // Mudar o horário de uma janela (em vez de desativar) é recusado pelo trigger.
    expect(
      await sqlstate(
        withTenant(api.db.db, clinicaA, (tx) => tx.update(professionalSchedules).set({ endTime: '23:00' }).where(eq(professionalSchedules.professionalId, profissionalA)), adminA.userId),
      ),
    ).toContain('42501');
    // Desfazer a remoção do bloqueio também.
    expect(
      await sqlstate(
        withTenant(api.db.db, clinicaA, (tx) => tx.update(scheduleBlocks).set({ removedBy: null, removedAt: null }).where(eq(scheduleBlocks.id, bloqueioA)), adminA.userId),
      ),
    ).toContain('42501');
  });

  it('cada alteração de configuração gravou a trilha (schedule_config), só com ids, contagens e códigos', async () => {
    const linhas = await withTenant(api.db.db, clinicaA, (tx) =>
      tx.select({ metadata: auditLog.metadata, action: auditLog.action }).from(auditLog).where(and(eq(auditLog.tenantId, clinicaA), eq(auditLog.scope, 'schedule_config'))),
    );
    const ops = linhas.map((l) => (l.metadata as { op?: string }).op);
    expect(ops).toEqual(expect.arrayContaining(['grade', 'bloqueio', 'bloqueio_removido', 'feriado', 'feriado_removido', 'feriados_nacionais']));
    const texto = JSON.stringify(linhas);
    expect(texto).not.toContain(pacienteA);
    expect(texto).not.toContain('Feriado municipal ficticio');
    // A grade recusada (sobreposta) não gravou nada: 1 só troca de grade (a da recepção).
    expect(ops.filter((o) => o === 'grade')).toHaveLength(1);
    const [n] = await withTenant(api.db.db, clinicaB, (tx) =>
      tx.select({ n: sql<number>`count(*)::int` }).from(auditLog).where(eq(auditLog.scope, 'schedule_config')),
    );
    expect(n?.n).toBe(0);
  });
});

describe('concorrência e conflito com o que já está marcado (#244)', () => {
  type Resp = { status: number; body: unknown };
  const codigo = (r: Resp) => (r.body as { codigo?: string }).codigo;

  it('bloqueio ou feriado sobre agendamento já marcado: 409 (remarque ou cancele antes)', async () => {
    const ag = await api
      .http()
      .post('/agendamentos')
      .set(cab(recepA))
      .send({ pacienteId: pacienteA, profissionalId: outroProfissionalA, tipoId: tipoA, data: '2030-07-15', hora: '10:00' });
    expect(ag.status, JSON.stringify(ag.body)).toBe(201);
    for (const corpo of [
      { dataInicio: '2030-07-15', horaInicio: '10:30', dataFim: '2030-07-15', horaFim: '11:00', motivo: 'reuniao' },
      { profissionalId: outroProfissionalA, dataInicio: '2030-07-15', dataFim: '2030-07-15', motivo: 'ferias' },
    ]) {
      const b = await api.http().post('/agenda/bloqueios').set(cab(adminA)).send(corpo);
      expect(b.status).toBe(409);
      expect(codigo(b)).toBe('bloqueio_com_agendamentos');
    }
    // Bloqueio de OUTRO profissional no mesmo horário passa.
    const outro = await api
      .http()
      .post('/agenda/bloqueios')
      .set(cab(adminA))
      .send({ profissionalId: profissionalA, dataInicio: '2030-07-15', dataFim: '2030-07-15', motivo: 'congresso' });
    expect(outro.status, JSON.stringify(outro.body)).toBe(201);
    const f = await api.http().post('/agenda/feriados').set(cab(adminA)).send({ data: '2030-07-15', nome: 'Feriado ficticio' });
    expect(f.status).toBe(409);
    expect(codigo(f)).toBe('feriado_com_agendamentos');
  });

  it('bloqueio (da clínica ou do profissional) e marcação ao mesmo tempo: nunca passam os dois', async () => {
    for (let i = 0; i < 8; i++) {
      const data = `2030-08-${String(i + 1).padStart(2, '0')}`;
      const bloqueio =
        i % 2 === 0
          ? { dataInicio: data, horaInicio: '08:00', dataFim: data, horaFim: '09:00', motivo: 'manutencao' }
          : { profissionalId: outroProfissionalA, dataInicio: data, horaInicio: '08:00', dataFim: data, horaFim: '09:00', motivo: 'reuniao' };
      const [b, m] = (await Promise.all([
        api.http().post('/agenda/bloqueios').set(cab(adminA)).send(bloqueio),
        api
          .http()
          .post('/agendamentos')
          .set(cab(recepA))
          .send({ pacienteId: pacienteA, profissionalId: outroProfissionalA, tipoId: tipoA, data, hora: '08:10' }),
      ])) as [Resp, Resp];
      const passaram = [b.status, m.status].filter((s) => s === 201).length;
      expect(passaram, `${data}: bloqueio ${b.status} ${JSON.stringify(b.body)} / marcação ${m.status} ${JSON.stringify(m.body)}`).toBe(1);
      if (b.status === 201) expect(codigo(m)).toBe('horario_bloqueado');
      else expect(codigo(b)).toBe('bloqueio_com_agendamentos');
    }
    // E no banco: nenhum bloqueio vigente se sobrepõe a agendamento que ocupa vaga do mesmo profissional (ou da clínica).
    const linhas = await withTenant(api.db.db, clinicaA, (tx) =>
      tx.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM schedule_blocks b JOIN appointments a
          ON a.tenant_id = b.tenant_id AND (b.professional_id IS NULL OR b.professional_id = a.professional_id)
         AND a.starts_at < b.ends_at AND a.ends_at > b.starts_at
         AND a.status IN ('scheduled', 'confirmed', 'checked_in', 'in_progress', 'completed')
         WHERE b.removed_at IS NULL`),
    );
    expect(Number([...linhas][0]?.n)).toBe(0);
  });

  it('feriado e marcação ao mesmo tempo: nunca passam os dois', async () => {
    for (let i = 0; i < 4; i++) {
      const data = `2030-09-${String(i + 10).padStart(2, '0')}`;
      const [f, m] = (await Promise.all([
        api.http().post('/agenda/feriados').set(cab(adminA)).send({ data, nome: 'Feriado ficticio concorrente' }),
        api
          .http()
          .post('/agendamentos')
          .set(cab(recepA))
          .send({ pacienteId: pacienteA, profissionalId: outroProfissionalA, tipoId: tipoA, data, hora: '15:00' }),
      ])) as [Resp, Resp];
      expect([f.status, m.status].filter((s) => s === 201).length, `${data}: ${JSON.stringify([f.body, m.body])}`).toBe(1);
      if (f.status === 201) expect(codigo(m)).toBe('feriado');
      else expect(codigo(f)).toBe('feriado_com_agendamentos');
    }
  });

  it('nome do feriado com caractere de controle: 400 na API e recusado pelo CHECK no banco', async () => {
    const r = await api.http().post('/agenda/feriados').set(cab(adminA)).send({ data: '2030-10-01', nome: 'Feriado\u0007ficticio' });
    expect(r.status).toBe(400);
    const codigos = await sqlstate(
      withTenant(
        api.db.db,
        clinicaA,
        (tx) => tx.insert(clinicHolidays).values({ tenantId: clinicaA, holidayDate: '2030-10-01', name: 'Feriado\nficticio', source: 'clinica', createdBy: adminA.userId }),
        adminA.userId,
      ),
    );
    expect(codigos).toContain('23514');
  });
});
