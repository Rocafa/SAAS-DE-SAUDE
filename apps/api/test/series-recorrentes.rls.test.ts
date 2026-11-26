/**
 * Sessões recorrentes (migração 0103, HU-AGD-008) contra Postgres REAL: isolamento entre clínicas em
 * `appointment_series`, perfis (recepção/admin; profissional e financeiro fora, também no banco), criação ATÔMICA
 * (um horário lotado no meio e nada é criado, com as datas na resposta), saldo do pacote (com as sessões já reservadas
 * por outra série e o consumo de hoje), cancelar a partir de uma data (só os futuros não realizados), imutabilidade e
 * concorrência básica (duas criações simultâneas no mesmo horário ou no mesmo pacote: uma passa). Pré-requisitos:
 * migrações aplicadas e DATABASE_URL = app_user. Dados 100% fictícios.
 */
import type { TenantId } from '@plataforma/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appointments, appointmentSeries, auditLog } from '../src/db/schema';
import { withTenant } from '../src/db/tenant-transaction';
import { cab, subirApi, type ApiDeTeste } from './apoio-api';

type Sessao = { Authorization: string; userId: string };
type Agendamento = { id: string; data: string; hora: string; minutos: number; status: string; serieId?: string };
type Serie = { id: string; pacienteId: string; pacoteId: string | null; canceladaAPartirDe: string | null; resumo: Record<string, number> };
type Criada = { serie: Serie; agendamentos: Agendamento[] };

let api: ApiDeTeste;
let clinicaA: TenantId;
let clinicaB: TenantId;
let adminA: Sessao;
let recepA: Sessao;
let profA: Sessao;
let finA: Sessao;
let adminB: Sessao;
let profissionalA: string;
let profissionalA2: string;
let tipoA: string;
let pac1: string;
let pac2: string;
let pacB: string;
let profissionalB: string;
let tipoB: string;

async function paciente(s: Sessao, nome: string): Promise<string> {
  const res = await api.http().post('/pacientes').set(cab(s)).send({ nome, telefone: '(11) 90000-0003' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return (res.body as { id: string }).id;
}

function corpo(extra: Record<string, unknown>): Record<string, unknown> {
  return { pacienteId: pac1, profissionalId: profissionalA, tipoId: tipoA, dias: [1], hora: '08:00', ...extra };
}

async function criar(s: Sessao, dados: Record<string, unknown>): Promise<Criada> {
  const res = await api.http().post('/series').set(cab(s)).send(dados);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as Criada;
}

async function agendamentosDaSerie(clinica: TenantId, serieId: string) {
  return withTenant(api.db.db, clinica, (tx) => tx.select().from(appointments).where(eq(appointments.seriesId, serieId)).orderBy(appointments.startsAt));
}

async function erroDoBanco(p: Promise<unknown>): Promise<unknown> {
  const err: unknown = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, 'era esperado erro do banco').toBeDefined();
  return err;
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
  const p1 = await api.http().post('/profissionais').set(cab(adminA)).send({ nome: 'Fisio Ficticio Serie', especialidade: 'Fisioterapia', usuarioId: profA.userId });
  expect(p1.status, JSON.stringify(p1.body)).toBe(201);
  profissionalA = (p1.body as { id: string }).id;
  const p2 = await api.http().post('/profissionais').set(cab(adminA)).send({ nome: 'TO Ficticia Serie', especialidade: 'Terapia ocupacional' });
  profissionalA2 = (p2.body as { id: string }).id;
  tipoA = ((await api.http().post('/tipos-atendimento').set(cab(adminA)).send({ nome: 'Sessao', minutos: 50 })).body as { id: string }).id;
  pac1 = await paciente(recepA, 'Paciente Ficticia Serie Um');
  pac2 = await paciente(recepA, 'Paciente Ficticio Serie Dois');
  const pB = await api.http().post('/profissionais').set(cab(adminB)).send({ nome: 'Prof Ficticio B', especialidade: 'Fisioterapia' });
  profissionalB = (pB.body as { id: string }).id;
  tipoB = ((await api.http().post('/tipos-atendimento').set(cab(adminB)).send({ nome: 'Sessao B', minutos: 50 })).body as { id: string }).id;
  pacB = await paciente(adminB, 'Paciente Ficticio Serie B');
});

afterAll(async () => {
  await api?.fechar();
});

describe('séries: criação, contrato e auditoria', () => {
  it('recepção cria série semanal: N agendamentos numa ação, com serieId, duração do tipo e trilha por série e por agendamento', async () => {
    // 2031-03-03 é segunda-feira.
    const r = await criar(recepA, corpo({ dataInicial: '2031-03-03', sessoes: 4 }));
    expect(r.agendamentos.map((a) => a.data)).toEqual(['2031-03-03', '2031-03-10', '2031-03-17', '2031-03-24']);
    expect(r.agendamentos.every((a) => a.hora === '08:00' && a.minutos === 50 && a.status === 'agendado' && a.serieId === r.serie.id)).toBe(true);
    expect(r.serie).toMatchObject({ pacienteId: pac1, pacoteId: null, canceladaAPartirDe: null, resumo: { agendadas: 4, realizadas: 0, faltas: 0, canceladas: 0 } });
    const trilha = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(auditLog).where(eq(auditLog.actorId, recepA.userId)));
    const daSerie = trilha.filter((t) => t.scope === 'appointment_series' && (t.metadata as Record<string, unknown>)['series_id'] === r.serie.id);
    expect(daSerie).toHaveLength(1);
    expect(daSerie[0]?.metadata).toMatchObject({ patient_id: pac1, count: 4 });
    const dosAgendamentos = trilha.filter((t) => t.scope === 'appointments' && t.action === 'create' && (t.metadata as Record<string, unknown>)['series_id'] === r.serie.id);
    expect(dosAgendamentos).toHaveLength(4);
  });

  it('a agenda mostra o serieId; a listagem traz a série e é auditada (leitura com paciente)', async () => {
    const ag = await api.http().get('/agendamentos').query({ de: '2031-03-03', ate: '2031-03-09', pacienteId: pac1 }).set(cab(recepA));
    expect(ag.status).toBe(200);
    const itens = (ag.body as { itens: Agendamento[] }).itens;
    expect(itens.length).toBeGreaterThan(0);
    expect(itens.every((a) => typeof a.serieId === 'string')).toBe(true);
    const lista = await api.http().get('/series').query({ pacienteId: pac1 }).set(cab(adminA));
    expect(lista.status).toBe(200);
    expect((lista.body as { itens: Serie[] }).itens.length).toBeGreaterThan(0);
    const leituras = await withTenant(api.db.db, clinicaA, (tx) =>
      tx.select().from(auditLog).where(and(eq(auditLog.actorId, adminA.userId), eq(auditLog.scope, 'appointment_series'), eq(auditLog.action, 'read'))),
    );
    expect(leituras.some((t) => (t.metadata as Record<string, unknown>)['patient_id'] === pac1)).toBe(true);
  });

  it('perfis: profissional e financeiro não criam nem listam (403); o banco também recusa série de quem não é recepção/admin', async () => {
    expect((await api.http().post('/series').set(cab(profA)).send(corpo({ dataInicial: '2031-04-07', sessoes: 1 }))).status).toBe(403);
    expect((await api.http().get('/series').set(cab(profA))).status).toBe(403);
    expect((await api.http().get('/series').set(cab(finA))).status).toBe(403);
    await erroDoBanco(
      withTenant(
        api.db.db,
        clinicaA,
        (tx) =>
          tx.insert(appointmentSeries).values({
            tenantId: clinicaA,
            patientId: pac1,
            professionalId: profissionalA,
            appointmentTypeId: tipoA,
            weekdays: [1],
            startTime: '08:00',
            durationMinutes: 50,
            startsOn: '2031-04-07',
            sessions: 1,
            createdBy: profA.userId,
          }),
        profA.userId,
      ),
    );
  });

  it('série que não gera nenhuma data e série no passado: 409 sem criar nada', async () => {
    const vazia = await api.http().post('/series').set(cab(adminA)).send(corpo({ dias: [0], dataInicial: '2031-04-07', dataFinal: '2031-04-11' }));
    expect(vazia.status).toBe(409);
    expect((vazia.body as { codigo: string }).codigo).toBe('serie_sem_sessoes');
    const passado = await api.http().post('/series').set(cab(adminA)).send(corpo({ dataInicial: '2020-01-06', sessoes: 2 }));
    expect(passado.status).toBe(409);
    expect((passado.body as { codigo: string }).codigo).toBe('horario_no_passado');
  });
});

describe('séries: atomicidade', () => {
  it('um horário lotado no MEIO da série: 409 serie_com_conflito com a data, e nada é criado', async () => {
    // Avulso na 3ª data (2031-05-19) às 10:00 com o mesmo profissional (capacidade 1).
    const avulso = await api.http().post('/agendamentos').set(cab(recepA)).send({ pacienteId: pac2, profissionalId: profissionalA, tipoId: tipoA, data: '2031-05-19', hora: '10:00' });
    expect(avulso.status).toBe(201);
    const antes = await withTenant(api.db.db, clinicaA, (tx) => tx.select({ id: appointments.id }).from(appointments));
    const seriesAntes = await withTenant(api.db.db, clinicaA, (tx) => tx.select({ id: appointmentSeries.id }).from(appointmentSeries));
    const res = await api.http().post('/series').set(cab(recepA)).send(corpo({ hora: '10:00', dataInicial: '2031-05-05', sessoes: 5 }));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ statusCode: 409, message: 'Conflito', codigo: 'serie_com_conflito', datas: ['2031-05-19'] });
    const depois = await withTenant(api.db.db, clinicaA, (tx) => tx.select({ id: appointments.id }).from(appointments));
    const seriesDepois = await withTenant(api.db.db, clinicaA, (tx) => tx.select({ id: appointmentSeries.id }).from(appointmentSeries));
    expect(depois).toHaveLength(antes.length);
    expect(seriesDepois).toHaveLength(seriesAntes.length);
    // Outro horário livre: a mesma série passa.
    const ok = await criar(recepA, corpo({ hora: '11:00', dataInicial: '2031-05-05', sessoes: 5 }));
    expect(ok.agendamentos).toHaveLength(5);
  });

  it('concorrência: duas séries simultâneas no mesmo horário do mesmo profissional — uma passa, a outra recebe as datas', async () => {
    const dados = (pacienteId: string) => corpo({ pacienteId, profissionalId: profissionalA2, hora: '14:00', dataInicial: '2031-06-02', sessoes: 3 });
    const [r1, r2] = await Promise.all([
      api.http().post('/series').set(cab(recepA)).send(dados(pac1)),
      api.http().post('/series').set(cab(adminA)).send(dados(pac2)),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    const perdedora = r1.status === 409 ? r1 : r2;
    expect((perdedora.body as { datas: string[] }).datas).toEqual(['2031-06-02', '2031-06-09', '2031-06-16']);
    const ocupados = await withTenant(api.db.db, clinicaA, (tx) =>
      tx.select({ id: appointments.id }).from(appointments).where(eq(appointments.professionalId, profissionalA2)),
    );
    expect(ocupados).toHaveLength(3);
  });
});

describe('séries: pacote', () => {
  async function pacote(total: number, extra: Record<string, unknown> = {}): Promise<string> {
    const res = await api.http().post('/pacotes').set(cab(recepA)).send({ pacienteId: pac1, nome: 'Pacote Ficticio', total, ...extra });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return (res.body as { id: string }).id;
  }

  it('número de sessões acima do saldo: 409 pacote_sem_saldo; dentro do saldo passa', async () => {
    const pac = await pacote(3);
    const acima = await api.http().post('/series').set(cab(recepA)).send(corpo({ pacoteId: pac, hora: '16:00', dataInicial: '2031-07-07', sessoes: 4 }));
    expect(acima.status).toBe(409);
    expect((acima.body as { codigo: string }).codigo).toBe('pacote_sem_saldo');
    const ok = await criar(recepA, corpo({ pacoteId: pac, hora: '16:00', dataInicial: '2031-07-07', sessoes: 3 }));
    expect(ok.serie.pacoteId).toBe(pac);
  });

  it('saldo livre desconta as sessões reservadas por outra série e as consumidas; cancelar libera; consumo segue o de hoje', async () => {
    const pac = await pacote(3);
    const s1 = await criar(recepA, corpo({ pacoteId: pac, hora: '17:00', dataInicial: '2031-08-04', sessoes: 3 }));
    // Reservadas 3: nenhuma sessão a mais neste pacote.
    const sem = await api.http().post('/series').set(cab(recepA)).send(corpo({ pacoteId: pac, hora: '18:00', dataInicial: '2031-09-01', sessoes: 1 }));
    expect((sem.body as { codigo: string }).codigo).toBe('pacote_sem_saldo');
    // A 1ª sessão acontece e consome o pacote pela rota de hoje (usadas 1, reservadas 2: ainda sem saldo).
    const primeira = s1.agendamentos[0] as Agendamento;
    expect((await api.http().post(`/agendamentos/${primeira.id}/check-in`).set(cab(recepA))).status).toBe(200);
    const consumo = await api.http().post(`/pacotes/${pac}/consumos`).set(cab(recepA)).send({ agendamentoId: primeira.id });
    expect(consumo.status, JSON.stringify(consumo.body)).toBe(201);
    expect(consumo.body).toMatchObject({ usadas: 1, saldo: 2 });
    expect((await api.http().post('/series').set(cab(recepA)).send(corpo({ pacoteId: pac, hora: '18:00', dataInicial: '2031-09-01', sessoes: 1 }))).status).toBe(409);
    // Cancelar a série a partir da 3ª data libera uma sessão do pacote.
    const canc = await api.http().post(`/series/${s1.serie.id}/cancelar`).set(cab(recepA)).send({ aPartirDe: '2031-08-18' });
    expect(canc.status).toBe(200);
    await criar(recepA, corpo({ pacoteId: pac, hora: '18:00', dataInicial: '2031-09-01', sessoes: 1 }));
  });

  it('pacote de outro paciente, cancelado ou vencido antes da última sessão: 409 sem criar nada', async () => {
    const outro = await api.http().post('/pacotes').set(cab(recepA)).send({ pacienteId: pac2, nome: 'Pacote Ficticio Dois', total: 5 });
    const r1 = await api.http().post('/series').set(cab(recepA)).send(corpo({ pacoteId: (outro.body as { id: string }).id, hora: '19:00', dataInicial: '2031-10-06', sessoes: 1 }));
    expect((r1.body as { codigo: string }).codigo).toBe('paciente_diferente');
    const vence = await pacote(5, { validade: '2031-10-10' });
    const r2 = await api.http().post('/series').set(cab(recepA)).send(corpo({ pacoteId: vence, hora: '19:00', dataInicial: '2031-10-06', sessoes: 2 }));
    expect((r2.body as { codigo: string }).codigo).toBe('pacote_vence_antes_da_serie');
    const cancelado = await pacote(5);
    await api.http().post(`/pacotes/${cancelado}/cancelar`).set(cab(recepA)).send({}).expect(200);
    const r3 = await api.http().post('/series').set(cab(recepA)).send(corpo({ pacoteId: cancelado, hora: '19:00', dataInicial: '2031-10-06', sessoes: 1 }));
    expect((r3.body as { codigo: string }).codigo).toBe('pacote_cancelado');
  });

  it('concorrência: duas séries simultâneas no mesmo pacote, cada uma com o saldo inteiro — uma passa', async () => {
    const pac = await pacote(2);
    const [r1, r2] = await Promise.all([
      api.http().post('/series').set(cab(recepA)).send(corpo({ pacoteId: pac, hora: '07:00', dataInicial: '2031-11-03', sessoes: 2 })),
      api.http().post('/series').set(cab(adminA)).send(corpo({ pacoteId: pac, profissionalId: profissionalA2, hora: '07:00', dataInicial: '2031-11-03', sessoes: 2 })),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    expect(((r1.status === 409 ? r1 : r2).body as { codigo: string }).codigo).toBe('pacote_sem_saldo');
  });
});

describe('séries: cancelar a partir de uma data', () => {
  it('só os futuros não realizados a partir da data; anteriores e com check-in ficam; a data só recua', async () => {
    // 2032-01-05 é segunda-feira.
    const r = await criar(recepA, corpo({ hora: '12:00', dataInicial: '2032-01-05', sessoes: 4 }));
    const [a1, a2, a3, a4] = r.agendamentos as [Agendamento, Agendamento, Agendamento, Agendamento];
    expect((await api.http().post(`/agendamentos/${a3.id}/check-in`).set(cab(recepA))).status).toBe(200);
    const canc = await api.http().post(`/series/${r.serie.id}/cancelar`).set(cab(recepA)).send({ aPartirDe: '2032-01-12' });
    expect(canc.status).toBe(200);
    expect(canc.body).toMatchObject({ serieId: r.serie.id, canceladaAPartirDe: '2032-01-12' });
    expect([...(canc.body as { cancelados: string[] }).cancelados].sort()).toEqual([a2.id, a4.id].sort());
    const linhas = await agendamentosDaSerie(clinicaA, r.serie.id);
    expect(Object.fromEntries(linhas.map((l) => [l.id, l.status]))).toEqual({ [a1.id]: 'scheduled', [a2.id]: 'cancelled', [a3.id]: 'checked_in', [a4.id]: 'cancelled' });
    // Data posterior não avança o cancelamento (idempotente); anterior recua e cancela o que faltava.
    const depois = await api.http().post(`/series/${r.serie.id}/cancelar`).set(cab(adminA)).send({ aPartirDe: '2032-01-26' });
    expect(depois.body).toMatchObject({ canceladaAPartirDe: '2032-01-12', cancelados: [] });
    const antes = await api.http().post(`/series/${r.serie.id}/cancelar`).set(cab(adminA)).send({ aPartirDe: '2032-01-05' });
    expect(antes.body).toMatchObject({ canceladaAPartirDe: '2032-01-05', cancelados: [a1.id] });
    const trilha = await withTenant(api.db.db, clinicaA, (tx) =>
      tx.select().from(auditLog).where(and(eq(auditLog.scope, 'appointments'), inArray(auditLog.action, ['update']))),
    );
    const cancelamentos = trilha.filter((t) => (t.metadata as Record<string, unknown>)['series_id'] === r.serie.id);
    expect(cancelamentos).toHaveLength(3);
    // Série cancelada não recebe agendamento novo (banco).
    await erroDoBanco(
      withTenant(
        api.db.db,
        clinicaA,
        (tx) =>
          tx.insert(appointments).values({
            tenantId: clinicaA,
            patientId: pac1,
            professionalId: profissionalA,
            appointmentTypeId: tipoA,
            startsAt: new Date('2032-03-01T15:00:00Z'),
            endsAt: new Date('2032-03-01T15:50:00Z'),
            createdBy: recepA.userId,
            seriesId: r.serie.id,
          }),
        recepA.userId,
      ),
    );
  });

  it('série e vínculo imutáveis; o runtime não apaga série', async () => {
    const r = await criar(adminA, corpo({ hora: '13:00', dataInicial: '2032-02-02', sessoes: 1 }));
    await erroDoBanco(
      withTenant(api.db.db, clinicaA, (tx) => tx.update(appointmentSeries).set({ weekdays: [2] }).where(eq(appointmentSeries.id, r.serie.id)), adminA.userId),
    );
    await erroDoBanco(
      withTenant(api.db.db, clinicaA, (tx) => tx.update(appointments).set({ seriesId: null }).where(eq(appointments.seriesId, r.serie.id)), adminA.userId),
    );
    await erroDoBanco(withTenant(api.db.db, clinicaA, (tx) => tx.delete(appointmentSeries).where(eq(appointmentSeries.id, r.serie.id)), adminA.userId));
  });
});

describe('séries: isolamento entre clínicas', () => {
  it('outra clínica não vê, não cancela e não usa paciente, profissional ou pacote de A', async () => {
    const r = await criar(recepA, corpo({ hora: '09:00', dataInicial: '2032-03-01', sessoes: 2 }));
    const listaB = await api.http().get('/series').set(cab(adminB));
    expect(listaB.status).toBe(200);
    expect((listaB.body as { itens: Serie[] }).itens.map((s) => s.id)).not.toContain(r.serie.id);
    expect((await api.http().post(`/series/${r.serie.id}/cancelar`).set(cab(adminB)).send({ aPartirDe: '2032-03-01' })).status).toBe(404);
    const comPacienteDeA = await api.http().post('/series').set(cab(adminB)).send({ ...corpo({ hora: '09:00', dataInicial: '2032-03-01', sessoes: 1 }), profissionalId: profissionalB, tipoId: tipoB });
    expect(comPacienteDeA.status).toBe(404);
    const pacoteA = await api.http().post('/pacotes').set(cab(recepA)).send({ pacienteId: pac1, nome: 'Pacote Ficticio A', total: 5 });
    const comPacoteDeA = await api
      .http()
      .post('/series')
      .set(cab(adminB))
      .send({ pacienteId: pacB, profissionalId: profissionalB, tipoId: tipoB, pacoteId: (pacoteA.body as { id: string }).id, dias: [1], hora: '09:00', dataInicial: '2032-03-01', sessoes: 1 });
    expect(comPacoteDeA.status).toBe(404);
    const noBancoB = await withTenant(api.db.db, clinicaB, (tx) => tx.select().from(appointmentSeries).where(eq(appointmentSeries.id, r.serie.id)));
    expect(noBancoB).toEqual([]);
    const agendamentosB = await agendamentosDaSerie(clinicaB, r.serie.id);
    expect(agendamentosB).toEqual([]);
    // A série de A segue intacta.
    expect((await agendamentosDaSerie(clinicaA, r.serie.id)).every((a) => a.status === 'scheduled')).toBe(true);
  });
});
