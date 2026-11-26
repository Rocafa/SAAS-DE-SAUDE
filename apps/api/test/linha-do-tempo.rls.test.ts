/**
 * Linha do tempo do paciente (HU-PAC-007) contra Postgres REAL, pela API: outra clínica não vê; cada perfil vê
 * só o que pode (recepção/financeiro/admin sem clínico; profissional só com vínculo; valores só com
 * financeiro:ler); psicologia só para o autor; nada de conteúdo clínico; paginação por cursor; leitura auditada.
 * Pré-requisitos: migrações aplicadas e DATABASE_URL = papel app_user. Dados 100% fictícios.
 */
import type { TenantId } from '@plataforma/shared';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appointments, auditLog } from '../src/db/schema';
import { withTenant } from '../src/db/tenant-transaction';
import { cab, cpfFicticio, subirApi, type ApiDeTeste } from './apoio-api';

type Sessao = { Authorization: string; userId: string };
interface Evento {
  id: string;
  data: string;
  hora: string;
  ocorridoEm: string;
  tipo: string;
  evento: string;
  categoria: string;
  texto: string;
  autor?: string;
}
interface Pagina {
  itens: Evento[];
  pagina: number;
  limite: number;
  temMais: boolean;
  proximoCursor: string | null;
}

const NOME_FISIO = 'Fisio Ficticio Linha';
const NOME_PSI = 'Psi Ficticia Sigilo';
const ESPECIALIDADES = ['Fisioterapia', 'Psicologia'];

let api: ApiDeTeste;
let clinicaA: TenantId;
let clinicaB: TenantId;
let adminA: Sessao;
let recepA: Sessao;
let finA: Sessao;
let fisioA: Sessao;
let psiA: Sessao;
let semVinculoA: Sessao;
let adminB: Sessao;
let profB: Sessao;
let pacienteA: string;
let pacienteA2: string;
let atFisio: string;
let atPsi: string;

const id = (r: { body: unknown }) => (r.body as { id: string }).id;

function post(s: Sessao, rota: string, corpo: object = {}) {
  return api.http().post(rota).set(cab(s)).send(corpo);
}

async function linha(s: Sessao, paciente = pacienteA, query: Record<string, string | number> = {}): Promise<Pagina> {
  const r = await api.http().get(`/pacientes/${paciente}/linha-do-tempo`).query(query).set(cab(s));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as Pagina;
}

/** Agendamento com chegada AGORA, direto no banco (a rota de agenda não marca no passado): dá vínculo do dia. */
async function chegadaAgora(paciente: string, profissional: string, tipo: string): Promise<string> {
  const ag = randomUUID();
  const recepcao = randomUUID();
  await withTenant(
    api.db.db,
    clinicaA,
    (tx) =>
      tx.insert(appointments).values({
        id: ag,
        tenantId: clinicaA,
        patientId: paciente,
        professionalId: profissional,
        appointmentTypeId: tipo,
        startsAt: new Date(Date.now() - 10 * 60_000),
        endsAt: new Date(Date.now() + 40 * 60_000),
        status: 'checked_in',
        checkedInAt: new Date(),
        createdBy: recepcao,
      }),
    recepcao,
  );
  return ag;
}

beforeAll(async () => {
  api = await subirApi();
  clinicaA = await api.novaClinica();
  clinicaB = await api.novaClinica();
  adminA = api.sessao(clinicaA, 'admin');
  recepA = api.sessao(clinicaA, 'recepcao');
  finA = api.sessao(clinicaA, 'financeiro');
  fisioA = api.sessao(clinicaA, 'profissional');
  psiA = api.sessao(clinicaA, 'profissional');
  semVinculoA = api.sessao(clinicaA, 'profissional');
  adminB = api.sessao(clinicaB, 'admin');
  profB = api.sessao(clinicaB, 'profissional');

  const pf = id(await post(adminA, '/profissionais', { nome: NOME_FISIO, especialidade: 'Fisioterapia', usuarioId: fisioA.userId }));
  const pp = id(await post(adminA, '/profissionais', { nome: NOME_PSI, especialidade: 'Psicologia', usuarioId: psiA.userId, areaSensivel: true }));
  await post(adminA, '/profissionais', { nome: 'Outro Prof Ficticio', especialidade: 'Fisioterapia', usuarioId: semVinculoA.userId });
  await post(adminB, '/profissionais', { nome: 'Prof Ficticio B', especialidade: 'Fisioterapia', usuarioId: profB.userId });
  const tipo = id(await post(adminA, '/tipos-atendimento', { nome: 'Sessao', minutos: 50 }));
  pacienteA = id(await post(recepA, '/pacientes', { nome: 'Paciente Ficticio Linha', telefone: '11900000701', cpf: cpfFicticio(701) }));
  pacienteA2 = id(await post(recepA, '/pacientes', { nome: 'Paciente Ficticio Linha Dois', telefone: '11900000702' }));
  await post(adminB, '/pacientes', { nome: 'Paciente Ficticio B', telefone: '11900000703' });

  // Agenda futura: marcada e remarcada; outra marcada e cancelada.
  const futura = await post(recepA, '/agendamentos', { pacienteId: pacienteA, profissionalId: pf, tipoId: tipo, data: '2031-04-10', hora: '09:00', encaixe: true });
  expect(futura.status, JSON.stringify(futura.body)).toBe(201);
  expect((await post(recepA, `/agendamentos/${id(futura)}/remarcar`, { data: '2031-04-11', hora: '10:00' })).status).toBe(200);
  const cancelada = await post(recepA, '/agendamentos', { pacienteId: pacienteA, profissionalId: pp, tipoId: tipo, data: '2031-04-12', hora: '11:00', encaixe: true });
  expect(cancelada.status, JSON.stringify(cancelada.body)).toBe(201);
  expect((await post(recepA, `/agendamentos/${id(cancelada)}/cancelar`)).status).toBe(200);

  // Atendimentos de hoje (fisio e psicologia), abertos pelos próprios profissionais.
  const agFisio = await chegadaAgora(pacienteA, pf, tipo);
  const agPsi = await chegadaAgora(pacienteA, pp, tipo);
  const af = await post(fisioA, '/atendimentos', { agendamentoId: agFisio });
  expect(af.status, JSON.stringify(af.body)).toBe(200);
  atFisio = id(af);
  const ap = await post(psiA, '/atendimentos', { agendamentoId: agPsi });
  expect(ap.status, JSON.stringify(ap.body)).toBe(200);
  atPsi = id(ap);

  // Financeiro: cobrança, recebimento e recibo.
  expect((await post(recepA, '/financeiro/caixas', { turno: 'manha', trocoInicialCentavos: 0 })).status).toBe(201);
  const c = await post(recepA, '/financeiro/cobrancas', { agendamentoId: id(futura), valorCentavos: 12345 });
  expect(c.status, JSON.stringify(c.body)).toBe(201);
  const p = await post(recepA, `/financeiro/cobrancas/${id(c)}/recebimentos`, { forma: 'pix' });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  expect((await post(recepA, `/financeiro/recebimentos/${id(p)}/recibo`)).status).toBe(200);
}, 120_000);

afterAll(async () => {
  await api?.fechar();
});

const eventos = (p: Pagina) => p.itens.map((e) => e.evento);
const clinicos = (p: Pagina) => p.itens.filter((e) => e.categoria === 'clinico');

describe('isolamento entre clínicas', () => {
  it('outra clínica recebe 404 (paciente de A não existe para B), sem nenhum evento', async () => {
    for (const s of [adminB, profB]) {
      const r = await api.http().get(`/pacientes/${pacienteA}/linha-do-tempo`).set(cab(s));
      expect(r.status).toBe(404);
      expect(JSON.stringify(r.body)).not.toContain(NOME_FISIO);
    }
  });
});

describe('cada perfil vê só o que pode', () => {
  it('recepção: agenda e financeiro com valores; nenhum evento clínico', async () => {
    const p = await linha(recepA);
    expect(eventos(p)).toEqual(
      expect.arrayContaining(['agenda_marcada', 'agenda_remarcada', 'agenda_cancelada', 'agenda_compareceu', 'cobranca_registrada', 'pagamento_recebido', 'recibo_emitido']),
    );
    expect(clinicos(p)).toEqual([]);
    expect(p.itens.find((e) => e.evento === 'pagamento_recebido')?.texto).toBe('Pagamento recebido: R$ 123,45');
    // Ordem: do mais recente para o mais antigo.
    const instantes = p.itens.map((e) => e.ocorridoEm);
    expect([...instantes].sort().reverse()).toEqual(instantes);
  });

  it('financeiro e admin não clínico: nenhum evento clínico', async () => {
    for (const s of [finA, adminA]) {
      const p = await linha(s);
      expect(clinicos(p)).toEqual([]);
      expect(eventos(p)).toContain('pagamento_recebido');
    }
  });

  it('profissional com vínculo: vê o atendimento (metadado e autor), não a psicologia de outro; financeiro sem valores', async () => {
    const p = await linha(fisioA);
    expect(clinicos(p).map((e) => e.id)).toEqual([`atendimento_registrado:${atFisio}`]);
    expect(clinicos(p)[0]).toMatchObject({ autor: NOME_FISIO, tipo: 'consulta' });
    expect(clinicos(p)[0]?.texto).toMatch(new RegExp(`^Atendimento registrado por ${NOME_FISIO} em \\d{2}/\\d{2}/\\d{4}$`));
    expect(JSON.stringify(p)).not.toContain(atPsi);
    const pagamento = p.itens.find((e) => e.evento === 'pagamento_recebido');
    expect(pagamento?.texto).toBe('Pagamento recebido');
    expect(JSON.stringify(p.itens.filter((e) => e.categoria !== 'agenda'))).not.toContain('R$');
  });

  it('psicólogo responsável vê o próprio atendimento de psicologia', async () => {
    const p = await linha(psiA);
    expect(clinicos(p).map((e) => e.id).sort()).toEqual([`atendimento_registrado:${atFisio}`, `atendimento_registrado:${atPsi}`].sort());
  });

  it('profissional SEM vínculo com o paciente: nenhum evento clínico (agenda continua)', async () => {
    const p = await linha(semVinculoA);
    expect(clinicos(p)).toEqual([]);
    expect(eventos(p)).toContain('agenda_marcada');
  });

  it('psicologia nunca aparece para quem não é o psicólogo: nem o atendimento, nem o nome do profissional de área sensível', async () => {
    for (const s of [recepA, finA, adminA, fisioA, semVinculoA]) {
      const serial = JSON.stringify(await linha(s));
      expect(serial).not.toContain(atPsi);
      expect(serial).not.toContain(NOME_PSI);
    }
    expect(JSON.stringify(await linha(psiA))).toContain(NOME_PSI);
  });
});

describe('nada de conteúdo clínico', () => {
  it('só os campos do contrato; sem especialidade, modelo, compartimento ou conteúdo', async () => {
    for (const s of [recepA, finA, adminA, fisioA, psiA, semVinculoA]) {
      const p = await linha(s);
      for (const e of p.itens) {
        expect(Object.keys(e).every((k) => ['id', 'data', 'hora', 'ocorridoEm', 'tipo', 'evento', 'categoria', 'texto', 'autor'].includes(k)), JSON.stringify(e)).toBe(true);
        expect(['consulta', 'falta', 'cancelamento', 'recibo', 'anexo', 'cadastro']).toContain(e.tipo);
      }
      const serial = JSON.stringify(p).toLowerCase();
      for (const proibido of [...ESPECIALIDADES.map((x) => x.toLowerCase()), 'psicologia', 'conteudo', 'modelo', 'queixa', 'evolu', 'adendo']) {
        expect(serial, proibido).not.toContain(proibido);
      }
    }
  });
});

describe('paginação por cursor', () => {
  it('percorre todas as páginas sem repetir nem pular, na mesma ordem da página única', async () => {
    const inteira = await linha(recepA, pacienteA, { limite: 100 });
    const vistos: string[] = [];
    let cursor: string | null = null;
    let paginas = 0;
    do {
      const p: Pagina = await linha(recepA, pacienteA, cursor ? { limite: 2, cursor } : { limite: 2 });
      vistos.push(...p.itens.map((e) => e.id));
      cursor = p.proximoCursor;
      paginas++;
    } while (cursor && paginas < 50);
    expect(paginas).toBeGreaterThan(1);
    expect(vistos).toEqual(inteira.itens.map((e) => e.id));
  });

  it('cursor de outro usuário, outro paciente ou outro limite: 409 cursor_invalido', async () => {
    const p = await linha(recepA, pacienteA, { limite: 2 });
    const cursor = p.proximoCursor as string;
    expect(cursor).toBeTruthy();
    const casos: [Sessao, string, number][] = [
      [finA, pacienteA, 2],
      [recepA, pacienteA2, 2],
      [recepA, pacienteA, 3],
    ];
    for (const [s, paciente, limite] of casos) {
      const r = await api.http().get(`/pacientes/${paciente}/linha-do-tempo`).query({ limite, cursor }).set(cab(s));
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ codigo: 'cursor_invalido' });
    }
  });

  it('texto livre na query é recusado (400)', async () => {
    const r = await api.http().get(`/pacientes/${pacienteA}/linha-do-tempo`).query({ busca: 'x' }).set(cab(recepA));
    expect(r.status).toBe(400);
  });
});

describe('auditoria', () => {
  it('cada leitura grava patient_timeline com o paciente, contagens e se houve clínico — sem texto', async () => {
    const p = await linha(fisioA);
    const linhas = await withTenant(api.db.db, clinicaA, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.scope, 'patient_timeline'), eq(auditLog.actorId, fisioA.userId)))
        .orderBy(sql`seq desc`)
        .limit(1),
    );
    expect(linhas[0]?.action).toBe('read');
    expect(linhas[0]?.metadata).toMatchObject({ patient_id: pacienteA, count: p.itens.length, clinical: true, clinical_count: 1, amounts: false });
    expect(JSON.stringify(linhas[0]?.metadata)).not.toContain(NOME_FISIO);
    const rec = await withTenant(api.db.db, clinicaA, (tx) =>
      tx.select().from(auditLog).where(and(eq(auditLog.scope, 'patient_timeline'), eq(auditLog.actorId, recepA.userId))),
    );
    expect(rec.length).toBeGreaterThan(0);
    expect(rec.every((l) => (l.metadata as { clinical?: boolean }).clinical === false)).toBe(true);
  });
});
