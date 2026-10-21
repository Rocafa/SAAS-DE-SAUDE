/**
 * Retenção legal, custódia das lacradas e retirada da retenção por duas pessoas (R10, R2 e R12 do
 * parecer do Guardião sobre o PR #63; migração 0017) contra Postgres REAL.
 * Pré-requisitos: migrações aplicadas e DATABASE_URL = papel app_user. Dados 100% fictícios.
 */
import type { RequestContext, TenantId, UserId } from '@plataforma/shared';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appointments, auditLog, clinicMembers, legalHolds, noteCustodies, patients, privateNotes, tenants } from '../src/db/schema';
import { withTenant, type TenantTx } from '../src/db/tenant-transaction';
import { FIELD_CIPHER } from '../src/modules/crypto/crypto.module';
import type { FieldCipher } from '../src/modules/crypto/field-cipher';
import { CicloNotasPrivadasService } from '../src/modules/records/ciclo-notas-privadas';
import { CAMPO_NOTA, decifrarCampoClinico } from '../src/modules/records/record-fields';
import { cab, subirApi, type ApiDeTeste } from './apoio-api';

type Sessao = { Authorization: string; userId: string };
const DIA = 86_400_000;
const TEXTO = 'Nota privada ficticia da custodia QZX8801';
const REFERENCIA = 'Oficio ficticio da retencao QZX8802';

let api: ApiDeTeste;
let clinica: TenantId;
let outraClinica: TenantId;
let admin: Sessao;
let admin2: Sessao;
let tipo: string;
let ciclo: CicloNotasPrivadasService;
let cipher: FieldCipher<TenantTx>;

const ctxAdmin = (): RequestContext => ({ tenantId: clinica, userId: admin.userId as UserId, roles: ['admin'] });

async function profissional(s: Sessao, especialidade: string): Promise<string> {
  const res = await api.http().post('/profissionais').set(cab(admin)).send({ nome: 'Prof Ficticio R15', especialidade, usuarioId: s.userId });
  expect(res.status).toBe(201);
  if (/psico/i.test(especialidade)) await api.membro(clinica, s, 'profissional', 'psicologo');
  return (res.body as { id: string }).id;
}

async function paciente(): Promise<string> {
  const res = await api.http().post('/pacientes').set(cab(admin)).send({ nome: 'Paciente Ficticio R15', telefone: '11900000088' });
  expect(res.status).toBe(201);
  return (res.body as { id: string }).id;
}

async function agendaDeHoje(pacienteId: string, profissionalId: string): Promise<void> {
  const recepcao = randomUUID();
  await withTenant(
    api.db.db,
    clinica,
    (tx) =>
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
    recepcao,
  );
}

async function novaNota(s: Sessao, pacienteId: string): Promise<string> {
  const res = await api.http().post(`/pacientes/${pacienteId}/notas-privadas`).set(cab(s)).send({ texto: TEXTO });
  expect(res.status).toBe(201);
  return (res.body as { id: string }).id;
}

async function linha(id: string) {
  const [n] = await withTenant(api.db.db, clinica, (tx) => tx.select().from(privateNotes).where(eq(privateNotes.id, id)));
  return n;
}

async function texto(id: string): Promise<string> {
  const n = await linha(id);
  return withTenant(api.db.db, clinica, (tx) => decifrarCampoClinico(cipher, tx, clinica, id, CAMPO_NOTA, n!.contentEnc));
}

function reter(pacienteId: string, quem: Sessao = admin) {
  return api.http().put(`/prontuario/pacientes/${pacienteId}/retencao-legal`).set(cab(quem)).send({ referencia: REFERENCIA });
}

async function sqlstates(p: Promise<unknown>): Promise<string[]> {
  try {
    await p;
    return [];
  } catch (e) {
    const out: string[] = [];
    let atual: unknown = e;
    while (atual && typeof atual === 'object') {
      const c = (atual as { code?: unknown }).code;
      if (typeof c === 'string') out.push(c);
      atual = (atual as { cause?: unknown }).cause;
    }
    return out;
  }
}

beforeAll(async () => {
  api = await subirApi();
  clinica = await api.novaClinica();
  outraClinica = await api.novaClinica();
  admin = api.sessao(clinica, 'admin');
  admin2 = api.sessao(clinica, 'admin');
  await api.membro(clinica, admin, 'admin');
  await api.membro(clinica, admin2, 'admin');
  const t = await api.http().post('/tipos-atendimento').set(cab(admin)).send({ nome: 'Sessao R15', minutos: 50 });
  tipo = (t.body as { id: string }).id;
  ciclo = api.app.get(CicloNotasPrivadasService);
  cipher = api.app.get(FIELD_CIPHER);
});

afterAll(async () => {
  await api?.fechar();
});

describe('R10: retenção legal bloqueia a eliminação de conteúdo', () => {
  it('o autor não descarta nem troca o texto (409 retencao_legal); o banco também recusa', async () => {
    const fisio = api.sessao(clinica, 'profissional');
    const p = await paciente();
    await agendaDeHoje(p, await profissional(fisio, 'Fisioterapia'));
    const id = await novaNota(fisio, p);
    await reter(p).expect(200);
    const d = await api.http().post(`/notas-privadas/${id}/descartar`).set(cab(fisio)).send({});
    expect(d.status).toBe(409);
    expect(d.body).toMatchObject({ codigo: 'retencao_legal' });
    const a = await api.http().patch(`/notas-privadas/${id}`).set(cab(fisio)).send({ texto: 'Texto ficticio substituto' });
    expect(a.status).toBe(409);
    expect(a.body).toMatchObject({ codigo: 'retencao_legal' });
    expect((await linha(id))?.discardedAt).toBeNull();
    expect(await texto(id)).toBe(TEXTO);
    // Direto no banco (SQL injetado no runtime): a lápide é recusada pelo trigger.
    const direto = withTenant(api.db.db, clinica, (tx) =>
      tx.update(privateNotes).set({ discardedAt: new Date() }).where(eq(privateNotes.id, id)),
    );
    expect(await sqlstates(direto)).toContain('55000');
  });

  it('o ciclo automático não elimina (fisio vencida nem lacrada vencida) enquanto houver retenção', async () => {
    const fisio = api.sessao(clinica, 'profissional');
    const psi = api.sessao(clinica, 'profissional');
    const fisioId = await profissional(fisio, 'Fisioterapia');
    const psiId = await profissional(psi, 'Psicologia');
    const p = await paciente();
    await agendaDeHoje(p, fisioId);
    await agendaDeHoje(p, psiId);
    const notaFisio = await novaNota(fisio, p);
    const notaPsi = await novaNota(psi, p);
    await api.http().post(`/prontuario/profissionais/${fisioId}/desligamento`).set(cab(admin)).send({}).expect(200);
    await api.http().post(`/prontuario/profissionais/${psiId}/desligamento`).set(cab(admin)).send({}).expect(200);
    const d31 = new Date(Date.now() + 31 * DIA);
    // Sem retenção: a psicologia lacra (e a de fisio seria eliminada, mas retemos antes).
    await reter(p).expect(200);
    const r = await ciclo.executarCicloDasNotas(ctxAdmin(), d31);
    expect(r).toMatchObject({ eliminadas: 0, lacradas: 0 });
    expect(r.suspensasPorRetencao).toBeGreaterThanOrEqual(2);
    expect(await linha(notaFisio)).toMatchObject({ custodyState: 'aguardando_decisao', discardedAt: null });
    expect(await texto(notaFisio)).toBe(TEXTO);
    expect(await texto(notaPsi)).toBe(TEXTO);
    // Retirada a retenção (duas pessoas), o ciclo volta a valer.
    await api.http().post(`/prontuario/pacientes/${p}/retencao-legal/retirada`).set(cab(admin)).send({ motivo: 'Processo ficticio encerrado' }).expect(200);
    await api.http().post(`/prontuario/pacientes/${p}/retencao-legal/retirada/aprovacao`).set(cab(admin2)).send({}).expect(200);
    const r2 = await ciclo.executarCicloDasNotas(ctxAdmin(), d31);
    expect(r2.eliminadas).toBeGreaterThanOrEqual(1);
    expect((await linha(notaFisio))?.discardedAt).not.toBeNull();
    expect((await linha(notaPsi))?.custodyState).toBe('lacrada');
    // Lacrada vencida com nova retenção: não é eliminada.
    await reter(p).expect(200);
    await ciclo.executarCicloDasNotas(ctxAdmin(), new Date(d31.getTime() + 91 * DIA));
    expect((await linha(notaPsi))?.discardedAt).toBeNull();
    expect(await texto(notaPsi)).toBe(TEXTO);
  });
});

describe('R12: retirar a retenção exige motivo e duas pessoas', () => {
  it('referência e motivo obrigatórios e cifrados; quem pede não aprova; o banco confere', async () => {
    const p = await paciente();
    await api.http().put(`/prontuario/pacientes/${p}/retencao-legal`).set(cab(admin)).send({ ativa: true }).expect(400);
    await api.http().put(`/prontuario/pacientes/${p}/retencao-legal`).set(cab(admin)).send({ ativa: false, referencia: REFERENCIA }).expect(400);
    const marcada = await reter(p);
    expect(marcada.status).toBe(200);
    expect(marcada.body).toMatchObject({ retiradaPendente: false });
    expect((marcada.body as { retencaoLegalDesde: string | null }).retencaoLegalDesde).not.toBeNull();
    // Aprovar sem pedido: 409. Pedir sem motivo: 400.
    await api.http().post(`/prontuario/pacientes/${p}/retencao-legal/retirada/aprovacao`).set(cab(admin2)).send({}).expect(409);
    await api.http().post(`/prontuario/pacientes/${p}/retencao-legal/retirada`).set(cab(admin)).send({}).expect(400);
    const prof = api.sessao(clinica, 'profissional');
    await api.http().post(`/prontuario/pacientes/${p}/retencao-legal/retirada`).set(cab(prof)).send({ motivo: 'Motivo ficticio qualquer' }).expect(403);
    const pedido = await api.http().post(`/prontuario/pacientes/${p}/retencao-legal/retirada`).set(cab(admin)).send({ motivo: 'Processo ficticio encerrado QZX8803' });
    expect(pedido.body).toMatchObject({ retiradaPendente: true });
    // A mesma pessoa não aprova.
    const mesma = await api.http().post(`/prontuario/pacientes/${p}/retencao-legal/retirada/aprovacao`).set(cab(admin)).send({});
    expect(mesma.status).toBe(409);
    expect(mesma.body).toMatchObject({ codigo: 'mesma_pessoa' });
    // Nem direto no banco: aprovação pelo próprio pedinte, ou forjando outro aprovador.
    const [h] = await withTenant(api.db.db, clinica, (tx) => tx.select().from(legalHolds).where(eq(legalHolds.patientId, p)));
    expect(h?.referenceEnc).not.toContain('QZX8802');
    expect(h?.releaseReasonEnc).not.toContain('QZX8803');
    const aprovar = (quem: string, sessao: string) =>
      withTenant(api.db.db, clinica, (tx) => tx.update(legalHolds).set({ releasedBy: quem, releasedAt: new Date() }).where(eq(legalHolds.id, h!.id)), sessao);
    expect(await sqlstates(aprovar(admin.userId, admin.userId))).toContain('42501');
    expect(await sqlstates(aprovar(admin2.userId, admin.userId))).toContain('42501');
    // E a marca do paciente não se apaga por UPDATE direto.
    const limpar = withTenant(api.db.db, clinica, (tx) => tx.update(patients).set({ legalHoldSince: null }).where(eq(patients.id, p)), admin.userId);
    expect(await sqlstates(limpar)).toContain('42501');
    // Nem se apaga a retenção.
    const apagar = withTenant(api.db.db, clinica, (tx) => tx.delete(legalHolds).where(eq(legalHolds.id, h!.id)), admin.userId);
    expect((await sqlstates(apagar)).length).toBeGreaterThan(0);
    // Outro admin aprova.
    const ok = await api.http().post(`/prontuario/pacientes/${p}/retencao-legal/retirada/aprovacao`).set(cab(admin2)).send({});
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ retencaoLegalDesde: null, retiradaPendente: false });
    // Trilha: as três etapas, sem referência nem motivo.
    const trilha = await withTenant(api.db.db, clinica, (tx) => tx.select().from(auditLog).where(eq(auditLog.scope, 'patients')));
    const metas = trilha.map((l) => l.metadata as Record<string, unknown>).filter((m) => m.patient_id === p && typeof m.op === 'string' && m.op.startsWith('legal_hold'));
    expect(metas.map((m) => m.op)).toEqual(['legal_hold', 'legal_hold_release_request', 'legal_hold']);
    expect(trilha.filter((l) => (l.metadata as Record<string, unknown>).op === 'legal_hold' && (l.metadata as Record<string, unknown>).patient_id === p).map((l) => l.actorId).sort()).toEqual(
      [admin.userId, admin2.userId].sort(),
    );
    expect(JSON.stringify(trilha)).not.toMatch(/880[23]/);
    // Outra clínica não vê a retenção.
    const deB = await withTenant(api.db.db, outraClinica, (tx) => tx.select().from(legalHolds).where(eq(legalHolds.id, h!.id)));
    expect(deB).toHaveLength(0);
  });
});

describe('R2: custódia das notas lacradas pelo psicólogo substituto', () => {
  it('o admin designa, só o substituto aceita, lê e decide; ninguém mais lê', async () => {
    const autor = api.sessao(clinica, 'profissional');
    const subst = api.sessao(clinica, 'profissional');
    const intruso = api.sessao(clinica, 'profissional');
    const autorId = await profissional(autor, 'Psicologia');
    const substId = await profissional(subst, 'Psicologia');
    const fisioId = await profissional(intruso, 'Fisioterapia');
    const p = await paciente();
    await agendaDeHoje(p, autorId);
    const guardar = await novaNota(autor, p);
    const descartar = await novaNota(autor, p);
    await api.http().post(`/prontuario/profissionais/${autorId}/desligamento`).set(cab(admin)).send({}).expect(200);
    await ciclo.executarCicloDasNotas(ctxAdmin(), new Date(Date.now() + 31 * DIA));
    expect((await linha(guardar))?.custodyState).toBe('lacrada');

    // Designação: só o admin; o substituto precisa ser psicólogo ativo.
    const corpo = { autorProfissionalId: autorId, substitutoProfissionalId: substId };
    await api.http().post('/prontuario/custodias').set(cab(subst)).send(corpo).expect(403);
    const naoPsi = await api.http().post('/prontuario/custodias').set(cab(admin)).send({ autorProfissionalId: autorId, substitutoProfissionalId: fisioId });
    expect(naoPsi.status).toBe(409);
    expect(naoPsi.body).toMatchObject({ codigo: 'substituto_nao_psicologo_ativo' });
    const des = await api.http().post('/prontuario/custodias').set(cab(admin)).send(corpo);
    expect(des.status).toBe(201);
    expect(des.body).toMatchObject({ aceita: false, notasLacradas: 2 });
    expect(JSON.stringify(des.body)).not.toContain('QZX8801');
    const cid = (des.body as { id: string }).id;
    await api.http().post('/prontuario/custodias').set(cab(admin)).send(corpo).expect(409);

    // Antes do aceite, nem o substituto lê; outro profissional e o admin nunca.
    expect((await api.http().get(`/custodias/${cid}/notas`).set(cab(subst))).body).toMatchObject({ codigo: 'custodia_nao_aceita' });
    await api.http().post(`/custodias/${cid}/aceite`).set(cab(intruso)).send({}).expect(404);
    await api.http().post(`/custodias/${cid}/aceite`).set(cab(admin)).send({}).expect(403);
    // O banco só aceita o aceite do próprio substituto.
    const aceiteForjado = withTenant(api.db.db, clinica, (tx) => tx.update(noteCustodies).set({ acceptedAt: new Date() }).where(eq(noteCustodies.id, cid)), intruso.userId);
    expect(await sqlstates(aceiteForjado)).toContain('42501');
    const aceite = await api.http().post(`/custodias/${cid}/aceite`).set(cab(subst)).send({});
    expect(aceite.status).toBe(200);
    expect(aceite.body).toMatchObject({ aceita: true });

    // Aceito: só o substituto lê (o autor continua sem ver as lacradas).
    await api.http().get(`/custodias/${cid}/notas`).set(cab(intruso)).expect(404);
    await api.http().get(`/custodias/${cid}/notas`).set(cab(admin)).expect(403);
    expect((await api.http().get(`/notas-privadas/${guardar}`).set(cab(autor))).status).toBe(404);
    const lidas = await api.http().get(`/custodias/${cid}/notas`).set(cab(subst));
    expect(lidas.status).toBe(200);
    expect((lidas.body as { texto: string }[]).map((n) => n.texto)).toEqual([TEXTO, TEXTO]);

    // Decisões: guarda da clínica (acompanha o prontuário) e descarte (lápide).
    await api.http().post(`/custodias/${cid}/notas/${guardar}/decisao`).set(cab(intruso)).send({ decisao: 'guarda_clinica' }).expect(404);
    const forjado = withTenant(api.db.db, clinica, (tx) => tx.update(privateNotes).set({ custodyState: 'guarda_clinica', custodyDeadline: null }).where(eq(privateNotes.id, guardar)), intruso.userId);
    // R13: quem não é psicólogo ativo no banco já cai no trigger de perfil (0020), antes da custódia (55000).
    expect(await sqlstates(forjado)).toContain('42501');
    await api.http().post(`/custodias/${cid}/notas/${guardar}/decisao`).set(cab(subst)).send({ decisao: 'guarda_clinica' }).expect(200);
    await api.http().post(`/custodias/${cid}/notas/${descartar}/decisao`).set(cab(subst)).send({ decisao: 'descartar' }).expect(200);
    expect(await linha(guardar)).toMatchObject({ custodyState: 'guarda_clinica', custodyDeadline: null, discardedAt: null });
    expect(await texto(guardar)).toBe(TEXTO);
    expect((await linha(descartar))?.discardedAt).not.toBeNull();
    expect(await texto(descartar)).toBe('');
    expect((await api.http().get(`/custodias/${cid}/notas`).set(cab(subst))).body).toEqual([]);
    // Trilha sem conteúdo.
    const trilha = await withTenant(api.db.db, clinica, (tx) => tx.select().from(auditLog).where(eq(auditLog.scope, 'private_notes')));
    expect(JSON.stringify(trilha)).not.toContain('QZX8801');
    const ops = trilha.map((l) => (l.metadata as Record<string, unknown>).op);
    for (const op of ['custody_designate', 'custody_accept', 'custody_read', 'custody_decide']) expect(ops).toContain(op);
    // Outra clínica não vê a custódia.
    const deB = await withTenant(api.db.db, outraClinica, (tx) => tx.select().from(noteCustodies).where(eq(noteCustodies.id, cid)));
    expect(deB).toHaveLength(0);
  });

  it('sob retenção legal, a custódia não descarta', async () => {
    const autor = api.sessao(clinica, 'profissional');
    const subst = api.sessao(clinica, 'profissional');
    const autorId = await profissional(autor, 'Psicologia');
    const substId = await profissional(subst, 'Psicologia');
    const p = await paciente();
    await agendaDeHoje(p, autorId);
    const nota = await novaNota(autor, p);
    await api.http().post(`/prontuario/profissionais/${autorId}/desligamento`).set(cab(admin)).send({}).expect(200);
    await ciclo.executarCicloDasNotas(ctxAdmin(), new Date(Date.now() + 31 * DIA));
    const cid = ((await api.http().post('/prontuario/custodias').set(cab(admin)).send({ autorProfissionalId: autorId, substitutoProfissionalId: substId })).body as { id: string }).id;
    await api.http().post(`/custodias/${cid}/aceite`).set(cab(subst)).send({}).expect(200);
    await reter(p).expect(200);
    const r = await api.http().post(`/custodias/${cid}/notas/${nota}/decisao`).set(cab(subst)).send({ decisao: 'descartar' });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ codigo: 'retencao_legal' });
    expect(await texto(nota)).toBe(TEXTO);
  });
});

describe('R13: o banco sabe quem é admin e psicólogo da clínica (0020)', () => {
  it('sessão "admin" sem perfil no banco não marca retenção; o trigger recusa mesmo direto', async () => {
    const p = await paciente();
    const semRegistro = api.sessao(clinica, 'admin');
    const r = await reter(p, semRegistro);
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ codigo: 'perfil_nao_registrado' });
    // Direto no banco (ex.: SQL injetado): 42501 antes de qualquer outra checagem.
    const direto = withTenant(api.db.db, clinica, (tx) =>
      tx.insert(legalHolds).values({ tenantId: clinica, patientId: p, referenceEnc: 'x', placedBy: semRegistro.userId }), semRegistro.userId);
    expect(await sqlstates(direto)).toContain('42501');
    // Admin revogado também perde: a revogação vale na hora.
    const ex = await api.membro(clinica, api.sessao(clinica, 'admin'), 'admin');
    await api.http().delete(`/clinica/membros/${ex.userId}/admin`).set(cab(admin)).expect(204);
    expect((await reter(p, ex)).status).toBe(403);
    expect((await reter(p, admin)).status).toBe(200);
  });

  it('custódia: o substituto precisa ser psicólogo no banco; o banco confere designação e aceite', async () => {
    const autor = api.sessao(clinica, 'profissional');
    const subst = api.sessao(clinica, 'profissional');
    const autorId = await profissional(autor, 'Psicologia');
    // Especialidade "Psicologia" no cadastro, mas sem o perfil psicologo no banco.
    const res = await api.http().post('/profissionais').set(cab(admin)).send({ nome: 'Psi sem registro', especialidade: 'Psicologia', usuarioId: subst.userId });
    const substId = (res.body as { id: string }).id;
    const r = await api.http().post('/prontuario/custodias').set(cab(admin)).send({ autorProfissionalId: autorId, substitutoProfissionalId: substId });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ codigo: 'substituto_nao_psicologo_ativo' });
    const direto = withTenant(api.db.db, clinica, (tx) =>
      tx.insert(noteCustodies).values({ tenantId: clinica, authorUserId: autor.userId, substituteUserId: subst.userId, designatedBy: admin.userId }), admin.userId);
    expect(await sqlstates(direto)).toContain('42501');
    // Designador que não é admin no banco (ex.: profissional injetando SQL): 42501.
    await api.membro(clinica, subst, 'psicologo');
    const naoAdmin = withTenant(api.db.db, clinica, (tx) =>
      tx.insert(noteCustodies).values({ tenantId: clinica, authorUserId: autor.userId, substituteUserId: subst.userId, designatedBy: autor.userId }), autor.userId);
    expect(await sqlstates(naoAdmin)).toContain('42501');
    // Com os perfis no banco, passa.
    expect((await api.http().post('/prontuario/custodias').set(cab(admin)).send({ autorProfissionalId: autorId, substitutoProfissionalId: substId })).status).toBe(201);
  });

  it('perfis: só admin ativo concede/revoga; ninguém se promove; o sistema não concede; não se apaga', async () => {
    const intruso = api.sessao(clinica, 'profissional');
    await api.membro(clinica, intruso, 'profissional');
    // Promover a si mesmo (clínica já tem membros): 42501.
    const auto = withTenant(api.db.db, clinica, (tx) =>
      tx.insert(clinicMembers).values({ tenantId: clinica, userId: intruso.userId, role: 'admin', grantedBy: intruso.userId }), intruso.userId);
    expect(await sqlstates(auto)).toContain('42501');
    // Forjar o concedente (dizer que foi o admin): 42501.
    const forjado = withTenant(api.db.db, clinica, (tx) =>
      tx.insert(clinicMembers).values({ tenantId: clinica, userId: intruso.userId, role: 'admin', grantedBy: admin.userId }), intruso.userId);
    expect(await sqlstates(forjado)).toContain('42501');
    // Job do sistema (sentinela da 0019): não concede.
    const sistema = withTenant(api.db.db, clinica, (tx) =>
      tx.insert(clinicMembers).values({ tenantId: clinica, userId: intruso.userId, role: 'admin', grantedBy: '00000000-0000-0000-0000-000000000000' }));
    expect(await sqlstates(sistema)).toContain('42501');
    // Pela rota: o profissional não chega (cadastros:gerir); o admin concede (idempotente) e revoga.
    await api.http().post('/clinica/membros').set(cab(intruso)).send({ usuarioId: intruso.userId, perfil: 'admin' }).expect(403);
    await api.http().post('/clinica/membros').set(cab(admin)).send({ usuarioId: intruso.userId, perfil: 'psicologo' }).expect(201);
    await api.http().post('/clinica/membros').set(cab(admin)).send({ usuarioId: intruso.userId, perfil: 'psicologo' }).expect(201);
    await api.http().post('/clinica/membros').set(cab(admin)).send({ usuarioId: intruso.userId, perfil: 'dono' }).expect(409);
    await api.http().delete(`/clinica/membros/${intruso.userId}/psicologo`).set(cab(admin)).expect(204);
    await api.http().delete(`/clinica/membros/${intruso.userId}/psicologo`).set(cab(admin)).expect(404);
    // Não se apaga; revogação não se desfaz.
    const apagar = withTenant(api.db.db, clinica, (tx) => tx.delete(clinicMembers).where(eq(clinicMembers.userId, intruso.userId)), admin.userId);
    expect(await sqlstates(apagar)).toContain('42501');
    const desfazer = withTenant(api.db.db, clinica, (tx) =>
      tx.update(clinicMembers).set({ revokedAt: null, revokedBy: null }).where(eq(clinicMembers.userId, intruso.userId)), admin.userId);
    expect(await sqlstates(desfazer)).toContain('42501');
    const trilha = await withTenant(api.db.db, clinica, (tx) => tx.select().from(auditLog).where(eq(auditLog.scope, 'clinic_members')));
    const ops = trilha.map((l) => (l.metadata as Record<string, unknown>).op);
    expect(ops).toEqual(expect.arrayContaining(['member_grant', 'member_revoke']));
  });

  it('fundação (R15): o fundador vem da criação da clínica, auditado; ninguém mais funda; o último admin não é revogado', async () => {
    const nova = await api.novaClinica();
    const fundadorId = api.fundador(nova);
    const dono = { Authorization: `Bearer ${api.sessoes.criarSessao({ tenantId: nova, userId: fundadorId, perfis: ['admin'] })}`, userId: fundadorId };
    const outro = api.sessao(nova, 'admin');
    // Fundador registrado em tenants e como admin; tenant_create e member_found na trilha.
    const membros = await api.http().get('/clinica/membros').set(cab(dono)).expect(200);
    expect(membros.body).toEqual([expect.objectContaining({ usuarioId: fundadorId, perfil: 'admin', concedidoPor: fundadorId })]);
    const trilha = await withTenant(api.db.db, nova, (tx) => tx.select().from(auditLog));
    expect(trilha.map((l) => (l.metadata as Record<string, unknown>).op)).toEqual(expect.arrayContaining(['tenant_create', 'member_found']));
    // A rota de "fundador" não existe mais.
    expect((await api.http().post('/clinica/membros/fundador').set(cab(outro)).send({})).status).toBe(404);
    // Pulando a API, o banco recusa outra fundação.
    const direto = withTenant(api.db.db, nova, (tx) =>
      tx.insert(clinicMembers).values({ tenantId: nova, userId: outro.userId, role: 'admin', grantedBy: outro.userId }), outro.userId);
    expect(await sqlstates(direto)).toContain('42501');
    const r = await api.http().delete(`/clinica/membros/${dono.userId}/admin`).set(cab(dono));
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ codigo: 'ultimo_admin' });
    const banco = withTenant(api.db.db, nova, (tx) =>
      tx.update(clinicMembers).set({ revokedAt: new Date(), revokedBy: dono.userId }).where(eq(clinicMembers.userId, dono.userId)), dono.userId);
    expect(await sqlstates(banco)).toContain('55000');
  });

  it('R15: clínica sem fundador não aceita "qualquer usuário" como 1º admin; fundador é imutável', async () => {
    // Clínica antiga (criada sem fundador, como antes da 0022): nenhum membro.
    const antiga = randomUUID() as TenantId;
    await withTenant(api.db.db, antiga, (tx) => tx.insert(tenants).values({ id: antiga, displayName: 'Clinica Ficticia Antiga' }));
    const recepcao = randomUUID();
    const semFundador = withTenant(api.db.db, antiga, (tx) =>
      tx.insert(clinicMembers).values({ tenantId: antiga, userId: recepcao, role: 'admin', grantedBy: recepcao }), recepcao);
    expect(await sqlstates(semFundador)).toContain('42501');
    // O runtime não se declara fundador depois.
    const virarFundador = withTenant(api.db.db, antiga, (tx) => tx.update(tenants).set({ founderUserId: recepcao }).where(eq(tenants.id, antiga)), recepcao);
    expect(await sqlstates(virarFundador)).toContain('42501');
    // Nem nasce com fundador de outra pessoa.
    const outra = randomUUID() as TenantId;
    const forjada = withTenant(api.db.db, outra, (tx) => tx.insert(tenants).values({ id: outra, displayName: 'Clinica Ficticia Forjada', founderUserId: randomUUID() }), recepcao);
    expect(await sqlstates(forjada)).toContain('42501');
    // Clínica com fundador mas sem a fundação na mesma transação: recusada no COMMIT.
    const semMembro = randomUUID() as TenantId;
    const incompleta = withTenant(api.db.db, semMembro, (tx) => tx.insert(tenants).values({ id: semMembro, displayName: 'Clinica Ficticia Incompleta', founderUserId: recepcao }), recepcao);
    expect(await sqlstates(incompleta)).toContain('23000');
    // O fundador de uma clínica criada não muda (nem para outro, nem para nulo).
    const nova = await api.novaClinica();
    const trocar = withTenant(api.db.db, nova, (tx) => tx.update(tenants).set({ founderUserId: recepcao }).where(eq(tenants.id, nova)), api.fundador(nova));
    expect(await sqlstates(trocar)).toContain('42501');
  });

  it('R15: runbook registra o fundador de clínica antiga (só papel de operação, uma vez, auditado)', async () => {
    const migratorUrl = process.env.DATABASE_MIGRATOR_URL;
    if (!migratorUrl) throw new Error('DATABASE_MIGRATOR_URL é obrigatória para o teste do runbook');
    const antiga = randomUUID() as TenantId;
    await withTenant(api.db.db, antiga, (tx) => tx.insert(tenants).values({ id: antiga, displayName: 'Clinica Ficticia Runbook' }));
    const fundadorId = randomUUID();
    // O runtime não executa o runbook.
    const peloRuntime = withTenant(api.db.db, antiga, (tx) => tx.execute(sql`select app_runbook_registrar_fundador(${antiga}::uuid, ${fundadorId}::uuid, 'OPS-1')`), fundadorId);
    expect(await sqlstates(peloRuntime)).toContain('42501');
    const op = postgres(migratorUrl, { max: 1, onnotice: () => undefined });
    try {
      await op.begin((t) => t`select app_runbook_registrar_fundador(${antiga}::uuid, ${fundadorId}::uuid, 'OPS-1')`);
      // Segunda vez: a clínica já tem fundador.
      const deNovo = op.begin((t) => t`select app_runbook_registrar_fundador(${antiga}::uuid, ${randomUUID()}::uuid, 'OPS-2')`);
      expect(await sqlstates(deNovo)).toContain('55000');
    } finally {
      await op.end({ timeout: 5 });
    }
    const [t] = await withTenant(api.db.db, antiga, (tx) => tx.select().from(tenants));
    expect(t?.founderUserId).toBe(fundadorId);
    const trilha = await withTenant(api.db.db, antiga, (tx) => tx.select().from(auditLog).where(eq(auditLog.scope, 'clinic_members')));
    expect(trilha.map((l) => l.metadata)).toEqual([expect.objectContaining({ op: 'member_found', user_id: fundadorId, via: 'runbook', chamado: 'OPS-1' })]);
  });

  it('R15: perfil concedido ou revogado direto no banco, sem o evento na trilha, é recusado no COMMIT', async () => {
    const alvo = randomUUID();
    const semTrilha = withTenant(api.db.db, clinica, (tx) =>
      tx.insert(clinicMembers).values({ tenantId: clinica, userId: alvo, role: 'recepcao', grantedBy: admin.userId }), admin.userId);
    expect(await sqlstates(semTrilha)).toContain('42501');
    await api.membro(clinica, { userId: alvo }, 'recepcao');
    const revogarSemTrilha = withTenant(api.db.db, clinica, (tx) =>
      tx.update(clinicMembers).set({ revokedAt: new Date(), revokedBy: admin.userId }).where(eq(clinicMembers.userId, alvo)), admin.userId);
    expect(await sqlstates(revogarSemTrilha)).toContain('42501');
  });

  it('R13: os demais admins são avisados quando perfis mudam e quando a retirada da retenção é pedida/aprovada', async () => {
    const avisosDe = async (s: Sessao) => (await api.http().get('/avisos').set(cab(s)).expect(200)).body as Array<Record<string, unknown>>;
    const alvo = api.sessao(clinica, 'recepcao');
    await api.http().post('/clinica/membros').set(cab(admin)).send({ usuarioId: alvo.userId, perfil: 'financeiro' }).expect(201);
    await api.http().delete(`/clinica/membros/${alvo.userId}/financeiro`).set(cab(admin)).expect(204);
    const doAdmin2 = await avisosDe(admin2);
    expect(doAdmin2).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tipo: 'perfil_alterado', usuarioId: alvo.userId, perfil: 'financeiro', mudanca: 'concedido', criadoPor: admin.userId }),
        expect.objectContaining({ tipo: 'perfil_alterado', usuarioId: alvo.userId, perfil: 'financeiro', mudanca: 'revogado', criadoPor: admin.userId }),
      ]),
    );
    // Quem fez a mudança não é avisado de si mesmo.
    expect((await avisosDe(admin)).filter((a) => a.tipo === 'perfil_alterado' && a.usuarioId === alvo.userId)).toEqual([]);
    // Retirada de retenção: o pedido avisa os outros admins; a aprovação avisa quem pediu.
    const p = await paciente();
    await reter(p).expect(200);
    await api.http().post(`/prontuario/pacientes/${p}/retencao-legal/retirada`).set(cab(admin)).send({ motivo: 'Processo ficticio encerrado' }).expect(200);
    const pedido = (await avisosDe(admin2)).find((a) => a.tipo === 'retencao_retirada_pedida' && a.criadoPor === admin.userId);
    expect(pedido?.retencaoId).toEqual(expect.any(String));
    await api.http().post(`/prontuario/pacientes/${p}/retencao-legal/retirada/aprovacao`).set(cab(admin2)).send({}).expect(200);
    const aprovado = (await avisosDe(admin)).find((a) => a.tipo === 'retencao_retirada_aprovada' && a.retencaoId === pedido?.retencaoId);
    expect(aprovado).toMatchObject({ criadoPor: admin2.userId });
    expect(Object.keys(aprovado ?? {}).sort()).toEqual(['criadoEm', 'criadoPor', 'id', 'lidoEm', 'retencaoId', 'tipo']);
    // Nada de paciente no aviso.
    expect(JSON.stringify(await avisosDe(admin))).not.toContain(p);
  });
});
