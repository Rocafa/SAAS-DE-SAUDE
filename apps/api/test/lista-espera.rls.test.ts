/**
 * Lista de espera (migração 0102, HU-AGD-009) contra Postgres REAL: isolamento entre clínicas em `waitlist_entries`,
 * perfis (recepção/admin escrevem; profissional lê só os dele; financeiro não vê), paciente inativo fora da lista,
 * observação só cifrada e fora da trilha, retirada e desfazer, "marcar a partir da espera" atômico e a retenção de
 * 30 dias (job `lista-espera-retencao`). Pré-requisitos: migrações aplicadas, DATABASE_URL = app_user e
 * DATABASE_MIGRATOR_URL (só para envelhecer a saída). Dados 100% fictícios.
 */
import type { TenantId } from '@plataforma/shared';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appointments, auditLog, waitlistEntries } from '../src/db/schema';
import { withTenant } from '../src/db/tenant-transaction';
import { ListaEsperaService } from '../src/modules/scheduling/lista-espera.service';
import { cab, subirApi, type ApiDeTeste } from './apoio-api';

type Sessao = { Authorization: string; userId: string };
type Item = {
  id: string;
  pacienteId: string;
  preferencia: string;
  criadoEm: string;
  entrouEm: string;
  profissionalId: string | null;
  dias: number[];
  periodo: string | null;
  observacao: string | null;
};

let api: ApiDeTeste;
let clinicaA: TenantId;
let clinicaB: TenantId;
let adminA: Sessao;
let recepA: Sessao;
let profA: Sessao;
let profA2: Sessao;
let finA: Sessao;
let adminB: Sessao;
let profissionalA: string;
let profissionalA2: string;
let tipoA: string;
let pac1: string;
let pac2: string;
let pac3: string;
let pacB: string;
const OBS = 'Avisar pelo WhatsApp ficticio QZX8801';

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

async function paciente(s: Sessao, nome: string): Promise<string> {
  const res = await api.http().post('/pacientes').set(cab(s)).send({ nome, telefone: '(11) 90000-0002' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body as { id: string }).id;
}

async function colocar(s: Sessao, corpo: Record<string, unknown>): Promise<Item> {
  const res = await api.http().post('/espera').set(cab(s)).send(corpo);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as Item;
}

async function lista(s: Sessao, query: Record<string, string> = {}): Promise<Item[]> {
  const res = await api.http().get('/espera').query(query).set(cab(s));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body as { itens: Item[] }).itens;
}

/** Envelhece a saída da lista (papel de MIGRAÇÃO; o runtime não reescreve a saída: trigger da 0102). */
async function envelhecerSaida(id: string, dias: number): Promise<void> {
  const url = process.env.DATABASE_MIGRATOR_URL;
  if (!url) throw new Error('DATABASE_MIGRATOR_URL é obrigatória para simular a retenção vencida');
  const op = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    await op.begin(async (t) => {
      await t`select app_set_tenant(${clinicaA}::uuid)`;
      await t`alter table waitlist_entries disable trigger waitlist_entries_guard`;
      await t`update waitlist_entries set removed_at = removed_at - make_interval(days => ${dias}) where id = ${id}::uuid`;
      await t`alter table waitlist_entries enable trigger waitlist_entries_guard`;
    });
  } finally {
    await op.end({ timeout: 5 });
  }
}

/** Envelhece a inativação do paciente (papel de MIGRAÇÃO; `inactivated_at` é da API). */
async function envelhecerInativacao(pacienteId: string, dias: number): Promise<void> {
  const url = process.env.DATABASE_MIGRATOR_URL;
  if (!url) throw new Error('DATABASE_MIGRATOR_URL é obrigatória para simular a inativação antiga');
  const op = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    await op.begin(async (t) => {
      await t`select app_set_tenant(${clinicaA}::uuid)`;
      await t`update patients set inactivated_at = inactivated_at - make_interval(days => ${dias}) where id = ${pacienteId}::uuid`;
    });
  } finally {
    await op.end({ timeout: 5 });
  }
}

beforeAll(async () => {
  api = await subirApi();
  clinicaA = await api.novaClinica();
  clinicaB = await api.novaClinica();
  adminA = api.sessao(clinicaA, 'admin');
  recepA = api.sessao(clinicaA, 'recepcao');
  profA = api.sessao(clinicaA, 'profissional');
  profA2 = api.sessao(clinicaA, 'profissional');
  finA = api.sessao(clinicaA, 'financeiro');
  adminB = api.sessao(clinicaB, 'admin');
  const p1 = await api.http().post('/profissionais').set(cab(adminA)).send({ nome: 'Fisio Ficticio Espera', especialidade: 'Fisioterapia', usuarioId: profA.userId });
  expect(p1.status).toBe(201);
  profissionalA = (p1.body as { id: string }).id;
  const p2 = await api.http().post('/profissionais').set(cab(adminA)).send({ nome: 'TO Ficticia Espera', especialidade: 'Terapia ocupacional', usuarioId: profA2.userId });
  profissionalA2 = (p2.body as { id: string }).id;
  tipoA = ((await api.http().post('/tipos-atendimento').set(cab(adminA)).send({ nome: 'Sessao', minutos: 50 })).body as { id: string }).id;
  pac1 = await paciente(recepA, 'Paciente Ficticia Espera Um');
  pac2 = await paciente(recepA, 'Paciente Ficticio Espera Dois');
  pac3 = await paciente(recepA, 'Paciente Ficticia Espera Tres');
  pacB = await paciente(adminB, 'Paciente Ficticio Espera B');
});

afterAll(async () => {
  await api?.fechar();
});

describe('lista de espera: contrato, perfis e minimização', () => {
  it('recepção coloca na lista com o contrato do fake; observação só cifrada no banco e fora da trilha', async () => {
    const item = await colocar(recepA, { pacienteId: pac1, profissionalId: profissionalA, dias: [4, 2], periodo: 'manha', observacao: OBS });
    expect(item).toMatchObject({ pacienteId: pac1, profissionalId: profissionalA, dias: [2, 4], periodo: 'manha', observacao: OBS, preferencia: `ter, qui · manhã · ${OBS}` });
    expect(item.criadoEm).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const [linha] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(waitlistEntries).where(eq(waitlistEntries.id, item.id)));
    expect(linha?.noteEnc).toMatch(/^v1:/);
    expect(linha?.noteEnc).not.toContain('QZX8801');
    const trilha = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(auditLog).where(eq(auditLog.scope, 'waitlist')));
    expect(trilha.some((t) => t.action === 'create' && (t.metadata as Record<string, unknown>)['waitlist_id'] === item.id)).toBe(true);
    expect(JSON.stringify(trilha)).not.toContain('QZX8801');
  });

  it('`preferencia` do fake vira observação; sem nada = "Qualquer horário"; mesmo paciente e profissional: 409 ja_na_espera', async () => {
    const livre = await colocar(adminA, { pacienteId: pac2, preferencia: '' });
    expect(livre).toMatchObject({ preferencia: 'Qualquer horário', profissionalId: null, observacao: null });
    const dup = await api.http().post('/espera').set(cab(recepA)).send({ pacienteId: pac2 });
    expect(dup.status).toBe(409);
    expect((dup.body as { codigo: string }).codigo).toBe('ja_na_espera');
  });

  it('perfis: financeiro não lê; profissional não escreve e só vê os itens marcados para ele', async () => {
    await colocar(recepA, { pacienteId: pac3, profissionalId: profissionalA2 });
    expect((await api.http().get('/espera').set(cab(finA))).status).toBe(403);
    expect((await api.http().post('/espera').set(cab(profA)).send({ pacienteId: pac3 })).status).toBe(403);
    const doProf = await lista(profA);
    expect(doProf.length).toBeGreaterThan(0);
    expect(doProf.every((i) => i.profissionalId === profissionalA)).toBe(true);
    const doProf2 = await lista(profA2);
    expect(doProf2.map((i) => i.pacienteId)).toEqual([pac3]);
    // A recepção vê todos, em ordem de entrada.
    const todos = await lista(recepA);
    expect(todos.map((i) => i.pacienteId)).toEqual([pac1, pac2, pac3]);
  });

  it('candidatos compatíveis com a vaga (profissional, dia e período), em ordem de entrada', async () => {
    // 2030-05-07 é terça (2), 09:00 é manhã: pac1 (ter/qui manhã, profissional A) e pac2 (qualquer) servem; pac3 é do A2.
    const terca = await lista(recepA, { profissionalId: profissionalA, data: '2030-05-07', hora: '09:00' });
    expect(terca.map((i) => i.pacienteId)).toEqual([pac1, pac2]);
    // Quarta à tarde: pac1 não aceita.
    const quarta = await lista(recepA, { profissionalId: profissionalA, data: '2030-05-08', hora: '15:00' });
    expect(quarta.map((i) => i.pacienteId)).toEqual([pac2]);
  });

  it('paciente inativo não entra e some da lista (sem apagar)', async () => {
    const outro = await paciente(recepA, 'Paciente Ficticio Espera Inativo');
    const item = await colocar(recepA, { pacienteId: outro });
    expect((await api.http().post(`/pacientes/${outro}/inativar`).set(cab(recepA))).status).toBe(200);
    expect((await lista(recepA)).map((i) => i.id)).not.toContain(item.id);
    const de_novo = await api.http().post('/espera').set(cab(recepA)).send({ pacienteId: outro });
    expect(de_novo.status).toBe(409);
    expect((de_novo.body as { codigo: string }).codigo).toBe('paciente_inativo');
    // O banco recusa também (gatilho da 0102), mesmo sem passar pela API.
    const codigos = await sqlstate(
      withTenant(api.db.db, clinicaA, (tx) => tx.insert(waitlistEntries).values({ tenantId: clinicaA, patientId: outro, createdBy: recepA.userId }), recepA.userId),
    );
    expect(codigos).toContain('23514');
  });
});

describe('lista de espera: isolamento entre clínicas (RLS)', () => {
  it('outra clínica não vê, não tira, não marca e não usa paciente de A', async () => {
    const deB = await lista(adminB);
    expect(deB).toEqual([]);
    const [itemA] = await lista(recepA);
    expect(itemA).toBeDefined();
    expect((await api.http().delete(`/espera/${itemA?.id}`).set(cab(adminB))).status).toBe(404);
    expect((await api.http().post(`/espera/${itemA?.id}/marcar`).set(cab(adminB)).send({ tipoId: tipoA, data: '2030-05-07', hora: '10:00' })).status).toBe(404);
    expect((await api.http().post('/espera').set(cab(adminB)).send({ pacienteId: pac1 })).status).toBe(404);
    const vistoDeB = await withTenant(api.db.db, clinicaB, (tx) => tx.select().from(waitlistEntries).where(eq(waitlistEntries.tenantId, clinicaA)));
    expect(vistoDeB).toEqual([]);
  });

  it('INSERT com tenant de outra clínica é recusado; UPDATE de A a partir de B não afeta nada; o runtime não apaga', async () => {
    const codigos = await sqlstate(
      withTenant(api.db.db, clinicaB, (tx) => tx.insert(waitlistEntries).values({ tenantId: clinicaA, patientId: pac1, createdBy: adminB.userId }), adminB.userId),
    );
    expect(codigos.some((c) => c === '42501' || c === '23514')).toBe(true);
    const alterados = await withTenant(
      api.db.db,
      clinicaB,
      (tx) => tx.update(waitlistEntries).set({ removedAt: new Date(), removedBy: adminB.userId, removalReason: 'retirado' }).where(eq(waitlistEntries.tenantId, clinicaA)).returning(),
      adminB.userId,
    );
    expect(alterados).toEqual([]);
    expect(await sqlstate(withTenant(api.db.db, clinicaA, (tx) => tx.delete(waitlistEntries)))).toContain('42501');
  });

  it('item de B com paciente de A viola a FK composta', async () => {
    const usuario = randomUUID();
    const codigos = await sqlstate(
      withTenant(api.db.db, clinicaB, (tx) => tx.insert(waitlistEntries).values({ tenantId: clinicaB, patientId: pac1, createdBy: usuario }), usuario),
    );
    expect(codigos.some((c) => c === '23503' || c === '23514')).toBe(true);
    expect(pacB).toBeTruthy();
  });
});

describe('lista de espera: saída, desfazer e marcar a partir da espera', () => {
  it('retirar some da lista (devolve o item para o desfazer); desfazer volta na mesma posição; trilha só com ids', async () => {
    const antes = await lista(recepA);
    const alvo = antes.find((i) => i.pacienteId === pac2);
    expect(alvo).toBeDefined();
    const tirado = await api.http().delete(`/espera/${alvo?.id}`).query({ motivo: 'desistencia' }).set(cab(recepA));
    expect(tirado.status).toBe(200);
    expect(tirado.body).toMatchObject({ id: alvo?.id, pacienteId: pac2 });
    expect((await lista(recepA)).map((i) => i.id)).not.toContain(alvo?.id);
    expect((await api.http().delete(`/espera/${alvo?.id}`).set(cab(recepA))).status).toBe(404);
    const [linha] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(waitlistEntries).where(eq(waitlistEntries.id, alvo?.id ?? '')));
    expect(linha).toMatchObject({ removalReason: 'desistencia', removedBy: recepA.userId });
    const volta = await api.http().post(`/espera/${alvo?.id}/devolver`).set(cab(recepA)).send({});
    expect(volta.status).toBe(200);
    expect((await lista(recepA)).map((i) => i.id)).toEqual(antes.map((i) => i.id));
    const trilha = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(auditLog).where(eq(auditLog.scope, 'waitlist')));
    const ops = trilha.map((t) => (t.metadata as Record<string, unknown>)['op']);
    expect(ops).toEqual(expect.arrayContaining(['remove', 'restore']));
  });

  it('marcar é atômico: horário lotado = 409 e o item continua; livre = agendamento criado e item fora da lista, na mesma transação', async () => {
    const item = (await lista(recepA)).find((i) => i.pacienteId === pac1);
    expect(item).toBeDefined();
    // Ocupa o único lugar do profissional A às 10:00 de 2030-05-07 com outro paciente.
    const ocupa = await api.http().post('/agendamentos').set(cab(recepA)).send({ pacienteId: pac3, profissionalId: profissionalA, tipoId: tipoA, data: '2030-05-07', hora: '10:00' });
    expect(ocupa.status).toBe(201);
    const lotado = await api.http().post(`/espera/${item?.id}/marcar`).set(cab(recepA)).send({ tipoId: tipoA, data: '2030-05-07', hora: '10:00' });
    expect(lotado.status).toBe(409);
    expect((lotado.body as { codigo: string }).codigo).toBe('horario_lotado');
    expect((await lista(recepA)).map((i) => i.id)).toContain(item?.id);
    const doPac1 = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(appointments).where(and(eq(appointments.patientId, pac1))));
    expect(doPac1).toEqual([]);

    const ok = await api.http().post(`/espera/${item?.id}/marcar`).set(cab(recepA)).send({ tipoId: tipoA, data: '2030-05-07', hora: '11:00' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const { agendamento, esperaId } = ok.body as { agendamento: { id: string; pacienteId: string; profissionalId: string }; esperaId: string };
    expect(esperaId).toBe(item?.id);
    expect(agendamento).toMatchObject({ pacienteId: pac1, profissionalId: profissionalA });
    expect((await lista(recepA)).map((i) => i.id)).not.toContain(item?.id);
    const [linha] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(waitlistEntries).where(eq(waitlistEntries.id, item?.id ?? '')));
    expect(linha).toMatchObject({ removalReason: 'agendado', appointmentId: agendamento.id });
    // Agendado não volta para a lista.
    const volta = await api.http().post(`/espera/${item?.id}/devolver`).set(cab(recepA)).send({});
    expect(volta.status).toBe(409);
    expect((volta.body as { codigo: string }).codigo).toBe('espera_agendada');
  });

  it('item sem profissional exige o profissional na marcação; profissional não marca', async () => {
    const item = (await lista(recepA)).find((i) => i.pacienteId === pac2);
    const sem = await api.http().post(`/espera/${item?.id}/marcar`).set(cab(recepA)).send({ tipoId: tipoA, data: '2030-05-09', hora: '14:00' });
    expect(sem.status).toBe(409);
    expect((sem.body as { codigo: string }).codigo).toBe('espera_sem_profissional');
    const peloProf = await api.http().post(`/espera/${item?.id}/marcar`).set(cab(profA)).send({ profissionalId: profissionalA, tipoId: tipoA, data: '2030-05-09', hora: '14:00' });
    expect(peloProf.status).toBe(403);
  });
});

describe('lista de espera: retenção (job lista-espera-retencao)', () => {
  it('apaga o que saiu há mais de 30 dias; o que saiu há menos e o que está na lista ficam; outra clínica intacta', async () => {
    const velho = await colocar(recepA, { pacienteId: pac2, profissionalId: profissionalA2 });
    const recente = await colocar(recepA, { pacienteId: pac1 });
    expect((await api.http().delete(`/espera/${velho.id}`).set(cab(recepA))).status).toBe(200);
    expect((await api.http().delete(`/espera/${recente.id}`).set(cab(recepA))).status).toBe(200);
    await envelhecerSaida(velho.id, 31);
    await envelhecerSaida(recente.id, 29);
    const itemB = await colocar(adminB, { pacienteId: pacB });
    const naLista = (await lista(recepA)).map((i) => i.id);

    const r = await api.app.get(ListaEsperaService).purgarComoSistema(clinicaA);
    expect(r.apagados).toBeGreaterThanOrEqual(1);
    const restantes = await withTenant(api.db.db, clinicaA, (tx) => tx.select({ id: waitlistEntries.id }).from(waitlistEntries));
    const ids = restantes.map((x) => x.id);
    expect(ids).not.toContain(velho.id);
    expect(ids).toContain(recente.id);
    for (const id of naLista) expect(ids).toContain(id);
    expect((await lista(adminB)).map((i) => i.id)).toEqual([itemB.id]);
    const [trilha] = await withTenant(api.db.db, clinicaA, (tx) =>
      tx.select().from(auditLog).where(and(eq(auditLog.scope, 'waitlist'), sql`${auditLog.metadata} ->> 'op' = 'purge_run'`)),
    );
    expect(trilha).toMatchObject({ actorKind: 'sistema' });
  });

  it('V1 do #245: paciente sob retenção legal não perde o item, nem saído há mais de 30 dias nem inativado', async () => {
    const retido = await paciente(recepA, 'Paciente Ficticio Espera Retido');
    const saiu = await colocar(recepA, { pacienteId: retido });
    const naLista = await colocar(recepA, { pacienteId: retido, profissionalId: profissionalA });
    expect((await api.http().delete(`/espera/${saiu.id}`).set(cab(recepA))).status).toBe(200);
    await envelhecerSaida(saiu.id, 31);
    // Retenção legal exige o perfil admin registrado no banco (0020).
    const dono = await api.membro(clinicaA, api.sessao(clinicaA, 'admin'), 'admin');
    const retencao = await api.http().put(`/prontuario/pacientes/${retido}/retencao-legal`).set(cab(dono)).send({ referencia: 'Oficio ficticio da espera QZX8803' });
    expect(retencao.status, JSON.stringify(retencao.body)).toBe(200);
    // Inativado há mais de 30 dias também não apaga o item ainda na lista.
    expect((await api.http().post(`/pacientes/${retido}/inativar`).set(cab(recepA))).status).toBe(200);
    await envelhecerInativacao(retido, 31);

    await api.app.get(ListaEsperaService).purgarComoSistema(clinicaA);
    const ids = (await withTenant(api.db.db, clinicaA, (tx) => tx.select({ id: waitlistEntries.id }).from(waitlistEntries))).map((x) => x.id);
    expect(ids).toContain(saiu.id);
    expect(ids).toContain(naLista.id);
  });

  it('sem retenção legal, o item de paciente inativado há mais de 30 dias é apagado', async () => {
    const inativo = await paciente(recepA, 'Paciente Ficticia Espera Inativa Antiga');
    const item = await colocar(recepA, { pacienteId: inativo });
    expect((await api.http().post(`/pacientes/${inativo}/inativar`).set(cab(recepA))).status).toBe(200);
    await envelhecerInativacao(inativo, 31);
    await api.app.get(ListaEsperaService).purgarComoSistema(clinicaA);
    const ids = (await withTenant(api.db.db, clinicaA, (tx) => tx.select({ id: waitlistEntries.id }).from(waitlistEntries))).map((x) => x.id);
    expect(ids).not.toContain(item.id);
  });
});

describe('lista de espera: leitura auditada por item (recomendação do #245)', () => {
  it('GET /espera grava o waitlist_id e o patient_id de cada item lido, além do resumo', async () => {
    const leitor = api.sessao(clinicaA, 'recepcao');
    const itens = await lista(leitor);
    expect(itens.length).toBeGreaterThan(0);
    const linhas = await withTenant(api.db.db, clinicaA, (tx) =>
      tx.select().from(auditLog).where(and(eq(auditLog.scope, 'waitlist'), eq(auditLog.actorId, leitor.userId), eq(auditLog.action, 'read'))),
    );
    const porItem = linhas.map((l) => l.metadata as Record<string, unknown>).filter((m) => m['op'] === 'list_item');
    expect(porItem.map((m) => m['waitlist_id']).sort()).toEqual(itens.map((i) => i.id).sort());
    for (const i of itens) expect(porItem).toContainEqual(expect.objectContaining({ waitlist_id: i.id, patient_id: i.pacienteId }));
    expect(linhas.some((l) => (l.metadata as Record<string, unknown>)['count'] === itens.length)).toBe(true);
  });
});
