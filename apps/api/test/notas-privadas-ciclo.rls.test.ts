/**
 * Ciclo de vida das notas privadas (decisões D1 e D2 do parecer do Guardião sobre o PR #63, migração
 * 0015) contra Postgres REAL: lápide no descarte, expurgo idempotente em 30 dias salvo retenção legal,
 * e o desligamento do autor (aguardando decisão, guarda da clínica, lacre da psicologia, eliminação).
 * Pré-requisitos: migrações aplicadas e DATABASE_URL = papel app_user. Dados 100% fictícios.
 */
import type { RequestContext, TenantId, UserId } from '@plataforma/shared';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appointments, auditLog, privateNotes, professionals } from '../src/db/schema';
import { withTenant, type TenantTx } from '../src/db/tenant-transaction';
import { FIELD_CIPHER } from '../src/modules/crypto/crypto.module';
import type { FieldCipher } from '../src/modules/crypto/field-cipher';
import { CicloNotasPrivadasService } from '../src/modules/records/ciclo-notas-privadas';
import { CAMPO_NOTA, cifrarCampoClinico, decifrarCampoClinico } from '../src/modules/records/record-fields';
import { cab, subirApi, type ApiDeTeste } from './apoio-api';

type Sessao = { Authorization: string; userId: string };
const DIA = 86_400_000;
const TEXTO = 'Nota privada ficticia do ciclo 7701';

let api: ApiDeTeste;
let clinica: TenantId;
let outraClinica: TenantId;
let admin: Sessao;
let tipo: string;
let ciclo: CicloNotasPrivadasService;
let cipher: FieldCipher<TenantTx>;

async function profissional(s: Sessao, especialidade: string): Promise<string> {
  const res = await api.http().post('/profissionais').set(cab(admin)).send({ nome: 'Prof Ficticio Ciclo', especialidade, usuarioId: s.userId });
  expect(res.status).toBe(201);
  return (res.body as { id: string }).id;
}

async function paciente(): Promise<string> {
  const res = await api.http().post('/pacientes').set(cab(admin)).send({ nome: 'Paciente Ficticio Ciclo', telefone: '11900000077' });
  expect(res.status).toBe(201);
  return (res.body as { id: string }).id;
}

/** Atendimento de agora (recepção fictícia criou): dá vínculo `agenda_do_dia` ao profissional. */
async function agendaDeHoje(pacienteId: string, profissionalId: string): Promise<void> {
  const recepcao = randomUUID();
  await withTenant(api.db.db, clinica, (tx) =>
    tx.insert(appointments).values({
      tenantId: clinica,
      patientId: pacienteId,
      professionalId: profissionalId,
      appointmentTypeId: tipo,
      startsAt: new Date(Date.now() - 10 * 60_000),
      endsAt: new Date(Date.now() + 40 * 60_000),
      status: 'checked_in',
      checkedInAt: new Date(),
      createdBy: recepcao,
    }),
  recepcao);
}

async function novaNota(s: Sessao, pacienteId: string, incluirNaExportacao = false): Promise<string> {
  const res = await api.http().post(`/pacientes/${pacienteId}/notas-privadas`).set(cab(s)).send({ texto: TEXTO, incluirNaExportacao });
  expect(res.status).toBe(201);
  return (res.body as { id: string }).id;
}

async function linha(id: string) {
  const [n] = await withTenant(api.db.db, clinica, (tx) => tx.select().from(privateNotes).where(eq(privateNotes.id, id)));
  return n;
}

async function texto(id: string, enc: string): Promise<string> {
  return withTenant(api.db.db, clinica, (tx) => decifrarCampoClinico(cipher, tx, clinica, id, CAMPO_NOTA, enc));
}

/** Nota descartada há `dias` dias, inserida direto no banco (o tempo do expurgo não cabe no teste). */
async function descartadaHa(pacienteId: string, autor: string, dias: number): Promise<string> {
  const id = randomUUID();
  const quando = new Date(Date.now() - dias * DIA);
  await withTenant(api.db.db, clinica, async (tx) =>
    tx.insert(privateNotes).values({
      id,
      tenantId: clinica,
      patientId: pacienteId,
      authorUserId: autor,
      contentEnc: await cifrarCampoClinico(cipher, tx, ctxAdmin(), id, CAMPO_NOTA, ''),
      createdAt: quando,
      updatedAt: quando,
      discardedAt: quando,
    }),
  );
  return id;
}

const ctxAdmin = (): RequestContext => ({ tenantId: clinica, userId: admin.userId as UserId, roles: ['admin'] });

beforeAll(async () => {
  api = await subirApi();
  clinica = await api.novaClinica();
  outraClinica = await api.novaClinica();
  admin = api.sessao(clinica, 'admin');
  const t = await api.http().post('/tipos-atendimento').set(cab(admin)).send({ nome: 'Sessao', minutos: 50 });
  tipo = (t.body as { id: string }).id;
  ciclo = api.app.get(CicloNotasPrivadasService);
  cipher = api.app.get(FIELD_CIPHER);
});

afterAll(async () => {
  await api?.fechar();
});

describe('D1: descarte vira lápide na hora', () => {
  it('o conteúdo decifrado passa a ser vazio, a exportação é zerada e a trilha só tem id e op', async () => {
    const fisio = api.sessao(clinica, 'profissional');
    const p = await paciente();
    await agendaDeHoje(p, await profissional(fisio, 'Fisioterapia'));
    const id = await novaNota(fisio, p, true);
    const antes = await linha(id);
    expect(await texto(id, antes!.contentEnc)).toBe(TEXTO);
    const res = await api.http().post(`/notas-privadas/${id}/descartar`).set(cab(fisio)).send({});
    expect(res.status).toBe(200);
    const corpo = res.body as { descartadaEm: string; expurgoAte: string };
    expect(Date.parse(corpo.expurgoAte) - Date.parse(corpo.descartadaEm)).toBe(30 * DIA);
    const depois = await linha(id);
    expect(depois?.discardedAt).not.toBeNull();
    expect(depois?.exportConsent).toBe(false);
    expect(depois?.contentEnc).not.toBe(antes?.contentEnc);
    expect(await texto(id, depois!.contentEnc)).toBe('');
    const trilha = await withTenant(api.db.db, clinica, (tx) => tx.select().from(auditLog).where(eq(auditLog.scope, 'private_notes')));
    expect(JSON.stringify(trilha)).not.toContain('7701');
    expect(trilha.map((l) => l.metadata)).toContainEqual(expect.objectContaining({ note_id: id, op: 'discard' }));
  });
});

describe('D1: expurgo em 30 dias, idempotente, salvo retenção legal', () => {
  it('apaga só a descartada há mais de 30 dias; de novo, 0; retenção legal suspende; o runtime não apaga direto', async () => {
    const autor = randomUUID();
    const p = await paciente();
    const pRetido = await paciente();
    const velha = await descartadaHa(p, autor, 31);
    const recente = await descartadaHa(p, autor, 10);
    const retida = await descartadaHa(pRetido, autor, 40);
    // Perfis que não são o dono da clínica não rodam o ciclo nem mexem na retenção.
    const prof = api.sessao(clinica, 'profissional');
    expect((await api.http().post('/prontuario/notas-privadas/ciclo').set(cab(prof)).send({})).status).toBe(403);
    expect((await api.http().put(`/prontuario/pacientes/${pRetido}/retencao-legal`).set(cab(prof)).send({ ativa: true })).status).toBe(403);
    // O runtime não tem DELETE, nem para linha elegível.
    const direto = withTenant(api.db.db, clinica, (tx) => tx.execute(sql`delete from private_notes where id = ${velha}`));
    await expect(direto).rejects.toThrow();

    const hold = await api.http().put(`/prontuario/pacientes/${pRetido}/retencao-legal`).set(cab(admin)).send({ ativa: true });
    expect(hold.status).toBe(200);
    expect((hold.body as { retencaoLegalDesde: string | null }).retencaoLegalDesde).not.toBeNull();

    const r1 = await api.http().post('/prontuario/notas-privadas/ciclo').set(cab(admin)).send({});
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({ expurgadas: 1 });
    expect(await linha(velha)).toBeUndefined();
    expect(await linha(recente)).toBeDefined();
    expect(await linha(retida)).toBeDefined();
    // Idempotente.
    expect((await api.http().post('/prontuario/notas-privadas/ciclo').set(cab(admin)).send({})).body).toMatchObject({ expurgadas: 0 });
    // Retirada a retenção, a linha elegível sai na próxima execução.
    await api.http().put(`/prontuario/pacientes/${pRetido}/retencao-legal`).set(cab(admin)).send({ ativa: false }).expect(200);
    expect((await api.http().post('/prontuario/notas-privadas/ciclo').set(cab(admin)).send({})).body).toMatchObject({ expurgadas: 1 });
    expect(await linha(retida)).toBeUndefined();
    // Trilha: só contagens e a marca de retenção (sem texto).
    const trilha = await withTenant(api.db.db, clinica, (tx) => tx.select().from(auditLog).where(eq(auditLog.actorId, admin.userId)));
    const metas = trilha.map((l) => l.metadata);
    expect(metas).toContainEqual({ op: 'purge', count: 1 });
    expect(metas).toContainEqual({ patient_id: pRetido, op: 'legal_hold', active: true });
  });

  it('o expurgo só alcança a clínica do contexto', async () => {
    const autor = randomUUID();
    const p = await paciente();
    const velha = await descartadaHa(p, autor, 45);
    const adminB = api.sessao(outraClinica, 'admin');
    expect((await api.http().post('/prontuario/notas-privadas/ciclo').set(cab(adminB)).send({})).body).toMatchObject({ expurgadas: 0 });
    expect(await linha(velha)).toBeDefined();
    await api.http().post('/prontuario/notas-privadas/ciclo').set(cab(admin)).send({}).expect(200);
    expect(await linha(velha)).toBeUndefined();
  });
});

describe('D2: profissional que sai da clínica', () => {
  it('aguardando decisão por 30 dias; sem decisão: guarda da clínica, lacre da psicologia ou eliminação', async () => {
    const fisio = api.sessao(clinica, 'profissional');
    const psi = api.sessao(clinica, 'profissional');
    const fisioId = await profissional(fisio, 'Fisioterapia');
    const psiId = await profissional(psi, 'Psicologia');
    const p = await paciente();
    await agendaDeHoje(p, fisioId);
    await agendaDeHoje(p, psiId);
    const fisioExportar = await novaNota(fisio, p, true);
    const fisioSemDecisao = await novaNota(fisio, p);
    const fisioDecide = await novaNota(fisio, p);
    const psiSemDecisao = await novaNota(psi, p);

    // O admin vê só a contagem.
    const des = await api.http().post(`/prontuario/profissionais/${fisioId}/desligamento`).set(cab(admin)).send({});
    expect(des.status).toBe(200);
    expect(Object.keys(des.body as object).sort()).toEqual(['notas', 'prazo']);
    expect((des.body as { notas: number }).notas).toBe(3);
    expect(JSON.stringify(des.body)).not.toContain('7701');
    await api.http().post(`/prontuario/profissionais/${psiId}/desligamento`).set(cab(admin)).send({}).expect(200);
    expect((await linha(fisioSemDecisao))?.custodyState).toBe('aguardando_decisao');

    // Desligado (inativo, sem vínculo), o autor ainda decide as PRÓPRIAS notas — e só elas.
    await withTenant(api.db.db, clinica, (tx) => tx.update(professionals).set({ active: false }).where(eq(professionals.id, fisioId)));
    expect((await api.http().get(`/pacientes/${p}/prontuario`).set(cab(fisio))).status).toBe(403);
    const lida = await api.http().get(`/notas-privadas/${fisioDecide}`).set(cab(fisio));
    expect(lida.status).toBe(200);
    expect(lida.body).toMatchObject({ texto: TEXTO });
    await api.http().post(`/notas-privadas/${fisioDecide}/descartar`).set(cab(fisio)).send({}).expect(200);

    // Antes do prazo, nada muda.
    expect(await ciclo.executarCicloDasNotas(ctxAdmin(), new Date(Date.now() + 29 * DIA))).toMatchObject({ guardaClinica: 0, lacradas: 0, eliminadas: 0 });
    // Vencido o prazo de 30 dias.
    const depois = new Date(Date.now() + 31 * DIA);
    expect(await ciclo.executarCicloDasNotas(ctxAdmin(), depois)).toMatchObject({ guardaClinica: 1, lacradas: 1, eliminadas: 1 });
    expect(await linha(fisioExportar)).toMatchObject({ custodyState: 'guarda_clinica', custodyDeadline: null, discardedAt: null });
    const eliminada = await linha(fisioSemDecisao);
    expect(eliminada?.discardedAt).not.toBeNull();
    expect(await texto(fisioSemDecisao, eliminada!.contentEnc)).toBe('');
    const lacrada = await linha(psiSemDecisao);
    expect(lacrada?.custodyState).toBe('lacrada');
    expect(lacrada?.custodyDeadline?.getTime()).toBe(depois.getTime() + 90 * DIA);
    expect(await texto(psiSemDecisao, lacrada!.contentEnc)).toBe(TEXTO);
    // Lacrada e sob guarda ficam ilegíveis no aplicativo (nem o autor).
    expect((await api.http().get(`/notas-privadas/${psiSemDecisao}`).set(cab(psi))).status).toBe(404);
    expect((await api.http().get(`/notas-privadas/${fisioExportar}`).set(cab(fisio))).status).toBe(404);
    // E o banco não deixa uma nota lacrada voltar a ativa.
    await expect(
      withTenant(api.db.db, clinica, (tx) =>
        tx.update(privateNotes).set({ custodyState: 'ativa', custodyDeadline: null }).where(and(eq(privateNotes.id, psiSemDecisao))),
      ),
    ).rejects.toThrow();
    // Sem decisão da custódia em 90 dias: eliminação.
    expect(await ciclo.executarCicloDasNotas(ctxAdmin(), new Date(depois.getTime() + 91 * DIA))).toMatchObject({ eliminadas: 1 });
    expect(await texto(psiSemDecisao, (await linha(psiSemDecisao))!.contentEnc)).toBe('');
    // Idempotente.
    expect(await ciclo.executarCicloDasNotas(ctxAdmin(), new Date(depois.getTime() + 91 * DIA))).toMatchObject({
      guardaClinica: 0,
      lacradas: 0,
      eliminadas: 0,
    });
  });
});
