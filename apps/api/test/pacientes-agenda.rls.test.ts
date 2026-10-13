/**
 * Pacientes e agenda (migração 0007) contra Postgres REAL: isolamento entre clínicas nas tabelas
 * novas (professionals, appointment_types, appointments e as colunas novas de patients), cifragem
 * dos campos sensíveis, permissões por perfil, paginação, capacidade (AGD-01.5) e auditoria.
 * Pré-requisitos: migrações aplicadas e DATABASE_URL = papel app_user. Dados 100% fictícios.
 */
import type { TenantId } from '@plataforma/shared';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appointments, appointmentTypes, auditLog, patients, professionals } from '../src/db/schema';
import { withTenant } from '../src/db/tenant-transaction';
import { cab, cpfFicticio, subirApi, type ApiDeTeste } from './apoio-api';

let api: ApiDeTeste;
let clinicaA: TenantId;
let clinicaB: TenantId;
let adminA: { Authorization: string; userId: string };
let recepA: { Authorization: string; userId: string };
let profA: { Authorization: string; userId: string };
let finA: { Authorization: string; userId: string };
let adminB: { Authorization: string; userId: string };
let profissionalA: string;
let tipoGrupoA: string;
let tipoIndividualA: string;
let pacienteA: string;
let pacienteB: string;
let profissionalB: string;
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

async function criarPaciente(s: { Authorization: string }, nome: string, extra: Record<string, unknown> = {}) {
  const res = await api
    .http()
    .post('/pacientes')
    .set(cab(s))
    .send({ nome, telefone: '(11) 90000-0001', ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; cpf: string | null; telefone: string };
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
    .send({ nome: 'Fisio Ficticia', especialidade: 'Fisioterapia', capacidade: 2, usuarioId: profA.userId });
  expect(prof.status).toBe(201);
  profissionalA = (prof.body as { id: string }).id;
  const grupo = await api.http().post('/tipos-atendimento').set(cab(adminA)).send({ nome: 'Grupo', minutos: 60, capacidade: 4 });
  tipoGrupoA = (grupo.body as { id: string }).id;
  const indiv = await api.http().post('/tipos-atendimento').set(cab(adminA)).send({ nome: 'Individual', minutos: 50 });
  tipoIndividualA = (indiv.body as { id: string }).id;

  pacienteA = (await criarPaciente(recepA, 'Paciente Ficticia Ágata', { cpf: cpfFicticio(1), nascimento: '1990-05-17' })).id;
  pacienteB = (await criarPaciente(adminB, 'Paciente Ficticio Bento')).id;
  profissionalB = ((await api.http().post('/profissionais').set(cab(adminB)).send({ nome: 'Psico B', especialidade: 'Psicologia' })).body as { id: string }).id;
  tipoB = ((await api.http().post('/tipos-atendimento').set(cab(adminB)).send({ nome: 'Sessao', minutos: 50 })).body as { id: string }).id;
});

afterAll(async () => {
  await api?.fechar();
});

describe('RLS nas tabelas novas (0007)', () => {
  it('professionals, appointment_types e appointments: contexto A não lê nada de B', async () => {
    await api.http().post('/agendamentos').set(cab(adminB)).send({
      pacienteId: pacienteB, profissionalId: profissionalB, tipoId: tipoB, data: '2030-01-07', hora: '09:00',
    });
    const visto = await withTenant(api.db.db, clinicaA, async (tx) => ({
      prof: await tx.select().from(professionals).where(eq(professionals.id, profissionalB)),
      tipos: await tx.select().from(appointmentTypes).where(eq(appointmentTypes.id, tipoB)),
      agenda: await tx.select().from(appointments).where(eq(appointments.tenantId, clinicaB)),
      pac: await tx.select().from(patients).where(eq(patients.id, pacienteB)),
    }));
    expect(visto).toEqual({ prof: [], tipos: [], agenda: [], pac: [] });
    const deB = await withTenant(api.db.db, clinicaB, (tx) => tx.select().from(appointments));
    expect(deB.length).toBeGreaterThan(0);
  });

  it('INSERT com tenant_id de outra clínica é bloqueado (WITH CHECK)', async () => {
    const codigos = await sqlstate(
      withTenant(api.db.db, clinicaA, (tx) =>
        tx.insert(professionals).values({ tenantId: clinicaB, displayName: 'Intruso', specialty: 'X' }),
      ),
    );
    expect(codigos).toContain('42501');
  });

  it('agendamento na clínica A apontando para paciente/profissional de B viola a FK composta', async () => {
    const codigos = await sqlstate(
      withTenant(api.db.db, clinicaA, (tx) =>
        tx.insert(appointments).values({
          tenantId: clinicaA,
          patientId: pacienteB,
          professionalId: profissionalA,
          appointmentTypeId: tipoIndividualA,
          startsAt: new Date('2030-01-07T12:00:00Z'),
          endsAt: new Date('2030-01-07T13:00:00Z'),
        }),
      ),
    );
    expect(codigos).toContain('23503');
  });

  it('UPDATE de agendamento de B a partir de A não afeta nada; o runtime não apaga agendamento', async () => {
    const alterados = await withTenant(api.db.db, clinicaA, (tx) =>
      tx.update(appointments).set({ status: 'cancelled', cancelledAt: new Date() }).where(eq(appointments.tenantId, clinicaB)).returning(),
    );
    expect(alterados).toEqual([]);
    const codigos = await sqlstate(withTenant(api.db.db, clinicaB, (tx) => tx.delete(appointments)));
    expect(codigos).toContain('42501');
  });
});

describe('cifragem dos campos sensíveis do paciente', () => {
  it('CPF, telefone e nascimento ficam só cifrados no banco (formato v1, sem os dígitos)', async () => {
    const [linha] = await withTenant(api.db.db, clinicaA, (tx) =>
      tx.select().from(patients).where(eq(patients.id, pacienteA)),
    );
    expect(linha?.cpfEnc).toMatch(/^v1:/);
    expect(linha?.phoneEnc).toMatch(/^v1:/);
    expect(linha?.birthDateEnc).toMatch(/^v1:/);
    const bruto = JSON.stringify(linha);
    expect(bruto).not.toContain(cpfFicticio(1));
    expect(bruto).not.toContain('11900000001');
    expect(bruto).not.toContain('1990-05-17');
  });

  it('o banco recusa CPF em claro mesmo fora da API (CHECK)', async () => {
    const codigos = await sqlstate(
      withTenant(api.db.db, clinicaA, (tx) =>
        tx.insert(patients).values({ tenantId: clinicaA, displayName: 'Direto', cpfEnc: cpfFicticio(2) }),
      ),
    );
    expect(codigos).toContain('23514');
  });

  it('a API devolve o valor decifrado só no detalhe', async () => {
    const res = await api.http().get(`/pacientes/${pacienteA}`).set(cab(recepA)).expect(200);
    expect(res.body).toMatchObject({ id: pacienteA, cpf: cpfFicticio(1), telefone: '11900000001', nascimento: '1990-05-17', ativo: true });
    const lista = await api.http().get('/pacientes').set(cab(recepA)).expect(200);
    const item = (lista.body as { itens: Record<string, unknown>[] }).itens.find((p) => p.id === pacienteA);
    expect(Object.keys(item ?? {}).sort()).toEqual(['ativo', 'id', 'nome', 'nomeSocial']);
  });

  it('cifra vale só na linha de origem: copiar o CPF cifrado para outro paciente não abre', async () => {
    const outro = await criarPaciente(recepA, 'Paciente Ficticio Copia');
    await withTenant(api.db.db, clinicaA, async (tx) => {
      const [a] = await tx.select({ cpf: patients.cpfEnc }).from(patients).where(eq(patients.id, pacienteA));
      await tx.update(patients).set({ cpfEnc: a?.cpf ?? null }).where(eq(patients.id, outro.id));
    });
    const res = await api.http().get(`/pacientes/${outro.id}`).set(cab(recepA));
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ statusCode: 500, message: 'Erro interno' });
  });
});

describe('pacientes: rotas, permissões e paginação', () => {
  it('busca sem acento e paginação limitada', async () => {
    const res = await api.http().get('/pacientes').query({ busca: 'agata' }).set(cab(finA)).expect(200);
    expect((res.body as { itens: { id: string }[] }).itens.map((p) => p.id)).toEqual([pacienteA]);
    await api.http().get('/pacientes').query({ limite: '101' }).set(cab(recepA)).expect(400);
    await api.http().get('/pacientes').query({ pagina: '0' }).set(cab(recepA)).expect(400);
    const pag = await api.http().get('/pacientes').query({ limite: '1' }).set(cab(recepA)).expect(200);
    expect(pag.body).toMatchObject({ pagina: 1, limite: 1, temMais: true });
    expect((pag.body as { itens: unknown[] }).itens).toHaveLength(1);
  });

  it('validação estrita: campo desconhecido, CPF inválido e telefone ausente dão 400 sem eco do valor', async () => {
    const r1 = await api.http().post('/pacientes').set(cab(recepA)).send({ nome: 'X', telefone: '11900000001', apelido: 'y' });
    expect(r1.status).toBe(400);
    expect(r1.body).toEqual({ statusCode: 400, message: 'Dados inválidos', campos: ['campo_desconhecido'] });
    const r2 = await api.http().post('/pacientes').set(cab(recepA)).send({ nome: 'X', telefone: '11900000001', cpf: '12345678900' });
    expect(r2.body).toEqual({ statusCode: 400, message: 'Dados inválidos', campos: ['cpf'] });
    expect(JSON.stringify(r2.body)).not.toContain('12345678900');
    const r3 = await api.http().post('/pacientes').set(cab(recepA)).send({ nome: 'X' });
    expect(r3.body).toMatchObject({ campos: ['telefone'] });
  });

  it('financeiro lê mas não cadastra; profissional não inativa; recepção inativa', async () => {
    await api.http().post('/pacientes').set(cab(finA)).send({ nome: 'X', telefone: '11900000001' }).expect(403);
    const p = await criarPaciente(profA, 'Paciente Ficticio Inativavel');
    await api.http().post(`/pacientes/${p.id}/inativar`).set(cab(profA)).expect(403);
    await api.http().post(`/pacientes/${p.id}/inativar`).set(cab(recepA)).expect(200, { id: p.id, ativo: false });
    await api.http().patch(`/pacientes/${p.id}`).set(cab(recepA)).send({ nome: 'Outro' }).expect(409);
    const inativos = await api.http().get('/pacientes').query({ situacao: 'inativos' }).set(cab(recepA)).expect(200);
    expect((inativos.body as { itens: { id: string }[] }).itens.map((i) => i.id)).toContain(p.id);
    const r = await api.http().post('/agendamentos').set(cab(recepA)).send({
      pacienteId: p.id, profissionalId: profissionalA, tipoId: tipoIndividualA, data: '2030-02-04', hora: '08:00',
    });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ codigo: 'paciente_inativo' });
  });

  it('atualizar recifra e permite limpar campo opcional', async () => {
    const p = await criarPaciente(recepA, 'Paciente Ficticio Edicao', { cpf: cpfFicticio(3) });
    const res = await api.http().patch(`/pacientes/${p.id}`).set(cab(recepA)).send({ telefone: '1133334444', cpf: null, nomeSocial: 'Nome Social Ficticio' }).expect(200);
    expect(res.body).toMatchObject({ telefone: '1133334444', cpf: null, nomeSocial: 'Nome Social Ficticio' });
    await api.http().patch(`/pacientes/${p.id}`).set(cab(recepA)).send({}).expect(400);
  });

  it('paciente de outra clínica: 404, igual a inexistente', async () => {
    await api.http().get(`/pacientes/${pacienteB}`).set(cab(adminA)).expect(404);
    await api.http().get(`/pacientes/${randomUUID()}`).set(cab(adminA)).expect(404);
    await api.http().patch(`/pacientes/${pacienteB}`).set(cab(adminA)).send({ nome: 'Invasor' }).expect(404);
    await api.http().get('/pacientes/nao-e-uuid').set(cab(adminA)).expect(400);
  });
});

describe('agenda: capacidade (AGD-01.5), encaixe, remarcar, status', () => {
  const marcar = (s: { Authorization: string }, corpo: Record<string, unknown>) =>
    api.http().post('/agendamentos').set(cab(s)).send({ pacienteId: pacienteA, profissionalId: profissionalA, ...corpo });

  it('profissional com capacidade 2 recebe 2 no mesmo horário; o 3º é bloqueado; encaixe passa', async () => {
    const base = { tipoId: tipoGrupoA, data: '2030-03-04', hora: '10:00' };
    expect((await marcar(recepA, base)).status).toBe(201);
    expect((await marcar(recepA, { ...base, hora: '10:30' })).status).toBe(201);
    const terceiro = await marcar(recepA, base);
    expect(terceiro.status).toBe(409);
    expect(terceiro.body).toEqual({ statusCode: 409, message: 'Conflito', codigo: 'horario_lotado' });
    const encaixe = await marcar(recepA, { ...base, encaixe: true });
    expect(encaixe.status).toBe(201);
    expect(encaixe.body).toMatchObject({ encaixe: true, data: '2030-03-04', hora: '10:00', minutos: 60, status: 'agendado' });
  });

  it('tipo individual (capacidade 1) bloqueia o segundo no mesmo horário', async () => {
    const base = { tipoId: tipoIndividualA, data: '2030-03-05', hora: '14:00' };
    expect((await marcar(recepA, base)).status).toBe(201);
    expect((await marcar(recepA, { ...base, hora: '14:30' })).status).toBe(409);
    expect((await marcar(recepA, { ...base, hora: '14:50' })).status).toBe(201);
  });

  it('remarcar devolve o horário anterior; check-in, atendimento e cancelamento respeitam perfil e transição', async () => {
    const criado = await marcar(recepA, { tipoId: tipoIndividualA, data: '2030-03-06', hora: '09:00' });
    const id = (criado.body as { id: string }).id;
    const rem = await api.http().post(`/agendamentos/${id}/remarcar`).set(cab(recepA)).send({ data: '2030-03-06', hora: '11:00' }).expect(200);
    expect(rem.body).toEqual({ data: '2030-03-06', hora: '09:00' });
    await api.http().post(`/agendamentos/${id}/check-in`).set(cab(recepA)).expect(200, { statusAnterior: 'agendado' });
    // Recepção não marca "em atendimento" (ato do profissional); o profissional marca.
    await api.http().post(`/agendamentos/${id}/status`).set(cab(recepA)).send({ status: 'em_atendimento' }).expect(403);
    await api.http().post(`/agendamentos/${id}/status`).set(cab(adminA)).send({ status: 'em_atendimento' }).expect(403);
    await api.http().post(`/agendamentos/${id}/status`).set(cab(profA)).send({ status: 'em_atendimento' }).expect(200, { statusAnterior: 'chegou' });
    await api.http().post(`/agendamentos/${id}/remarcar`).set(cab(recepA)).send({ data: '2030-03-07', hora: '11:00' }).expect(409);
    await api.http().post(`/agendamentos/${id}/status`).set(cab(profA)).send({ status: 'atendido' }).expect(200);

    const outro = (await marcar(recepA, { tipoId: tipoIndividualA, data: '2030-03-06', hora: '15:00' })).body as { id: string };
    await api.http().post(`/agendamentos/${outro.id}/cancelar`).set(cab(recepA)).expect(200, { statusAnterior: 'agendado' });
    const r = await api.http().post(`/agendamentos/${outro.id}/status`).set(cab(recepA)).send({ status: 'agendado' });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ codigo: 'transicao_invalida' });
    // Horário cancelado libera a vaga.
    expect((await marcar(recepA, { tipoId: tipoIndividualA, data: '2030-03-06', hora: '15:00' })).status).toBe(201);
    await api.http().post(`/agendamentos/${outro.id}/status`).set(cab(finA)).send({ status: 'confirmado' }).expect(403);
  });

  it('listar exige janela de até 31 dias e filtra por profissional; outra clínica não vê nada', async () => {
    await api.http().get('/agendamentos').set(cab(recepA)).expect(400);
    await api.http().get('/agendamentos').query({ de: '2030-03-01', ate: '2030-04-15' }).set(cab(recepA)).expect(400);
    const semana = await api.http().get('/agendamentos').query({ de: '2030-03-04', ate: '2030-03-10', profissionalId: profissionalA }).set(cab(finA)).expect(200);
    const itens = (semana.body as { itens: { profissionalId: string; pacienteId: string }[]; truncado: boolean }).itens;
    expect(itens.length).toBeGreaterThanOrEqual(6);
    expect(itens.every((a) => a.profissionalId === profissionalA)).toBe(true);
    const dia = await api.http().get('/agendamentos').query({ de: '2030-03-05', ate: '2030-03-05' }).set(cab(recepA)).expect(200);
    expect((dia.body as { itens: unknown[] }).itens).toHaveLength(2);
    const deB = await api.http().get('/agendamentos').query({ de: '2030-03-04', ate: '2030-03-10' }).set(cab(adminB)).expect(200);
    expect((deB.body as { itens: unknown[] }).itens).toEqual([]);
  });

  it('não agenda com profissional, tipo ou paciente de outra clínica (404)', async () => {
    const r1 = await marcar(recepA, { profissionalId: profissionalB, tipoId: tipoIndividualA, data: '2030-03-08', hora: '08:00' });
    expect(r1.status).toBe(404);
    const r2 = await api.http().post('/agendamentos').set(cab(recepA)).send({
      pacienteId: pacienteB, profissionalId: profissionalA, tipoId: tipoIndividualA, data: '2030-03-08', hora: '08:00',
    });
    expect(r2.status).toBe(404);
  });

  it('admin gere cadastros; recepção não', async () => {
    await api.http().post('/profissionais').set(cab(recepA)).send({ nome: 'X', especialidade: 'Y' }).expect(403);
    await api.http().post('/tipos-atendimento').set(cab(profA)).send({ nome: 'X', minutos: 30 }).expect(403);
    const lista = await api.http().get('/profissionais').set(cab(recepA)).expect(200);
    expect((lista.body as { id: string }[]).map((p) => p.id)).toEqual([profissionalA]);
  });
});

describe('auditoria', () => {
  it('toda leitura/escrita de paciente e de agenda grava auditoria só com ids e contagens', async () => {
    const antes = await withTenant(api.db.db, clinicaA, (tx) =>
      tx.select({ n: sql<number>`count(*)::int` }).from(auditLog).where(eq(auditLog.tenantId, clinicaA)),
    );
    await api.http().get(`/pacientes/${pacienteA}`).set(cab(recepA)).expect(200);
    await api.http().get('/pacientes').query({ busca: 'agata' }).set(cab(recepA)).expect(200);
    const depois = await withTenant(api.db.db, clinicaA, (tx) =>
      tx.select({ n: sql<number>`count(*)::int` }).from(auditLog).where(eq(auditLog.tenantId, clinicaA)),
    );
    expect((depois[0]?.n ?? 0) - (antes[0]?.n ?? 0)).toBe(2);

    const linhas = await withTenant(api.db.db, clinicaA, (tx) =>
      tx.select().from(auditLog).where(and(eq(auditLog.tenantId, clinicaA))),
    );
    const leituraDoDetalhe = linhas.find(
      (l) => l.action === 'read' && l.scope === 'patients' && l.actorId === recepA.userId && l.metadata.patient_id === pacienteA,
    );
    expect(leituraDoDetalhe).toBeDefined();
    const acoes = new Set(linhas.map((l) => `${l.scope}:${l.action}`));
    for (const esperado of ['patients:create', 'patients:read', 'patients:update', 'appointments:create', 'appointments:update', 'appointments:read', 'crypto.key.provision:key_provision']) {
      expect(acoes, esperado).toContain(esperado);
    }
    // Nenhum valor de paciente na trilha: nem nome, nem CPF, nem telefone, nem termo de busca.
    const tudo = JSON.stringify(linhas.map((l) => l.metadata)).toLowerCase();
    for (const proibido of ['agata', 'ágata', 'ficticia', cpfFicticio(1), '11900000001', '1990-05-17']) {
      expect(tudo).not.toContain(proibido);
    }
  });
});
