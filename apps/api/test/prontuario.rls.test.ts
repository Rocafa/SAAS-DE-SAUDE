/**
 * Atendimento e prontuário (rodada 14.1, migração 0012) contra Postgres REAL, pela API e pelo banco:
 * isolamento entre clínicas, porteiro do conteúdo clínico (vínculo de cuidado) com negação auditada,
 * sigilo da psicologia configurável, notas privadas só do autor, versões preservadas, finalizado não
 * edita (API e banco), conteúdo cifrado no banco e auditoria sem conteúdo.
 * Pré-requisitos: migrações aplicadas e DATABASE_URL = papel app_user. Dados 100% fictícios.
 */
import type { TenantId } from '@plataforma/shared';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appointments,
  auditLog,
  clinicalAddenda,
  clinicalRecordVersions,
  clinicalSettings,
  encounters,
  privateNotes,
  type AppointmentStatusDb,
} from '../src/db/schema';
import { withTenant } from '../src/db/tenant-transaction';
import { cab, subirApi, type ApiDeTeste } from './apoio-api';

type Sessao = { Authorization: string; userId: string };

/** Textos clínicos fictícios com marcadores, para procurar vazamento no banco e na trilha. */
const QUEIXA_V1 = 'Queixa ficticia primeira versao 5501';
const QUEIXA_V2 = 'Queixa ficticia segunda versao 5502';
const CONDUTA = 'Conduta ficticia com exercicios 5503';
const ADENDO = 'Adendo ficticio posterior 5504';
const PSICO = 'Registro ficticio de sessao de psicologia 5505';
const NOTA = 'Nota privada ficticia do psicologo 5506';
const MARCADORES = [QUEIXA_V1, QUEIXA_V2, CONDUTA, ADENDO, PSICO, NOTA, '5501', '5505', '5506'];

let api: ApiDeTeste;
let clinicaA: TenantId;
let clinicaB: TenantId;
let adminA: Sessao;
let recepA: Sessao;
let finA: Sessao;
let fisioA: Sessao;
let psiA: Sessao;
let outroA: Sessao;
let semVinculoA: Sessao;
let profB: Sessao;
let pacienteA: string;
let pacienteB: string;
let agFisio: string;
let agPsi: string;
let atFisio: string;
let atPsi: string;
let tipoA: string;
const profissionalDe = new Map<string, string>();

async function criarProfissional(admin: Sessao, s: Sessao, especialidade: string): Promise<string> {
  const res = await api.http().post('/profissionais').set(cab(admin)).send({ nome: 'Prof Ficticio', especialidade, usuarioId: s.userId });
  expect(res.status).toBe(201);
  const id = (res.body as { id: string }).id;
  profissionalDe.set(s.userId, id);
  return id;
}

async function criarPaciente(admin: Sessao): Promise<string> {
  const res = await api.http().post('/pacientes').set(cab(admin)).send({ nome: 'Paciente Ficticio Prontuario', telefone: '11900000055' });
  expect(res.status).toBe(201);
  return (res.body as { id: string }).id;
}

/** Agendamento direto no banco (hora atual: a rota de agenda não marca no passado). */
async function agendamento(
  tenantId: TenantId,
  paciente: string,
  profissional: string,
  tipo: string,
  status: AppointmentStatusDb = 'checked_in',
): Promise<string> {
  const id = randomUUID();
  await withTenant(api.db.db, tenantId, (tx) =>
    tx.insert(appointments).values({
      id,
      tenantId,
      patientId: paciente,
      professionalId: profissional,
      appointmentTypeId: tipo,
      startsAt: new Date(Date.now() - 10 * 60_000),
      endsAt: new Date(Date.now() + 40 * 60_000),
      status,
      checkedInAt: status === 'checked_in' ? new Date() : null,
    }),
  );
  return id;
}

/** SQLSTATE em qualquer ponto da cadeia de causas. */
async function sqlstates(p: Promise<unknown>): Promise<unknown[]> {
  const err: unknown = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  const codigos: unknown[] = [];
  for (let e: unknown = err; e instanceof Error; e = e.cause) codigos.push((e as { code?: unknown }).code);
  return codigos;
}

async function negacoes(tenantId: TenantId, s: Sessao) {
  return withTenant(api.db.db, tenantId, (tx) =>
    tx
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.scope, 'clinical_access_denied'), eq(auditLog.actorId, s.userId))),
  );
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
  outroA = api.sessao(clinicaA, 'profissional');
  semVinculoA = api.sessao(clinicaA, 'admin', 'profissional');
  const adminB = api.sessao(clinicaB, 'admin');
  profB = api.sessao(clinicaB, 'profissional');

  const pf = await criarProfissional(adminA, fisioA, 'Fisioterapia');
  const pp = await criarProfissional(adminA, psiA, 'Psicologia');
  const po = await criarProfissional(adminA, outroA, 'Terapia ocupacional');
  await criarProfissional(adminA, semVinculoA, 'Fisioterapia');
  const pB = await criarProfissional(adminB, profB, 'Fisioterapia');
  const tipo = await api.http().post('/tipos-atendimento').set(cab(adminA)).send({ nome: 'Sessao', minutos: 50 });
  tipoA = (tipo.body as { id: string }).id;
  const tipoB = await api.http().post('/tipos-atendimento').set(cab(adminB)).send({ nome: 'Sessao', minutos: 50 });
  pacienteA = await criarPaciente(adminA);
  pacienteB = await criarPaciente(adminB);

  agFisio = await agendamento(clinicaA, pacienteA, pf, tipoA);
  agPsi = await agendamento(clinicaA, pacienteA, pp, tipoA);
  // O "outro" profissional também atende o paciente hoje (tem vínculo), mas não é autor dos registros.
  await agendamento(clinicaA, pacienteA, po, tipoA);
  // Clínica B: o mesmo tipo de cenário, com o profissional de B.
  await agendamento(clinicaB, pacienteB, pB, (tipoB.body as { id: string }).id);
});

afterAll(async () => {
  await api?.fechar();
});

describe('abertura do atendimento a partir do check-in', () => {
  it('recepção, financeiro e admin não clínico: 403 sem consultar nada, e a tentativa fica na trilha', async () => {
    for (const s of [recepA, finA, adminA]) {
      const res = await api.http().post('/atendimentos').set(cab(s)).send({ agendamentoId: agFisio });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ codigo: 'sem_vinculo_de_cuidado' });
      const linhas = await negacoes(clinicaA, s);
      expect(linhas.length).toBeGreaterThan(0);
      expect(linhas[0]?.metadata).toMatchObject({ op: 'abrir', reason: 'sem_vinculo_de_cuidado', target_id: agFisio });
    }
    // Mesmo para rotas de leitura e de nota privada.
    for (const rota of [`/pacientes/${pacienteA}/prontuario`, `/pacientes/${pacienteA}/notas-privadas`]) {
      expect((await api.http().get(rota).set(cab(recepA))).status).toBe(403);
      expect((await api.http().get(rota).set(cab(finA))).status).toBe(403);
    }
  });

  it('profissional da clínica SEM vínculo com o paciente: 403 auditado (abrir não cria vínculo)', async () => {
    const res = await api.http().post('/atendimentos').set(cab(semVinculoA)).send({ agendamentoId: agFisio });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ codigo: 'sem_vinculo_de_cuidado' });
    expect((await negacoes(clinicaA, semVinculoA)).map((l) => l.metadata)).toContainEqual(
      expect.objectContaining({ op: 'abrir', reason: 'sem_vinculo_de_cuidado' }),
    );
    // A tentativa não deixou nenhum atendimento nem mudou o status do agendamento.
    const [ag] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(appointments).where(eq(appointments.id, agFisio)));
    expect(ag?.status).toBe('checked_in');
    const ats = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(encounters).where(eq(encounters.appointmentId, agFisio)));
    expect(ats).toHaveLength(0);
  });

  it('autoagendamento com check-in não abre (sem vínculo); depois de "em atendimento" pela agenda, abre com a base marcada', async () => {
    const paciente = await criarPaciente(adminA);
    const ag = randomUUID();
    await withTenant(api.db.db, clinicaA, (tx) =>
      tx.insert(appointments).values({
        id: ag,
        tenantId: clinicaA,
        patientId: paciente,
        professionalId: profissionalDe.get(fisioA.userId) as string,
        appointmentTypeId: tipoA,
        startsAt: new Date(Date.now() - 10 * 60_000),
        endsAt: new Date(Date.now() + 40 * 60_000),
        status: 'checked_in',
        createdBy: fisioA.userId,
      }),
    );
    const negado = await api.http().post('/atendimentos').set(cab(fisioA)).send({ agendamentoId: ag });
    expect(negado.status).toBe(403);
    expect(negado.body).toMatchObject({ codigo: 'sem_vinculo_de_cuidado' });
    // A agenda (com as regras dela: só o profissional do agendamento, dentro da janela) marca o início.
    const inicio = await api.http().post(`/agendamentos/${ag}/status`).set(cab(fisioA)).send({ status: 'em_atendimento' });
    expect(inicio.status).toBe(200);
    const aberto = await api.http().post('/atendimentos').set(cab(fisioA)).send({ agendamentoId: ag });
    expect(aberto.status).toBe(200);
    const [linha] = await withTenant(api.db.db, clinicaA, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.scope, 'encounters'), eq(auditLog.action, 'create'), sql`${auditLog.metadata}->>'appointment_id' = ${ag}`)),
    );
    expect(linha?.metadata).toMatchObject({ care_basis: 'autoagendamento' });
  });

  it('profissional com vínculo, mas que não é o do agendamento: 403 (só o profissional do agendamento registra)', async () => {
    const res = await api.http().post('/atendimentos').set(cab(outroA)).send({ agendamentoId: agFisio });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ codigo: 'somente_o_autor' });
  });

  it('o profissional do agendamento abre (modelo pela especialidade); abrir de novo devolve o mesmo', async () => {
    const res = await api.http().post('/atendimentos').set(cab(fisioA)).send({ agendamentoId: agFisio });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      pacienteId: pacienteA,
      agendamentoId: agFisio,
      modelo: 'fisio',
      restrito: false,
      status: 'aberto',
      versao: 0,
      conteudo: null,
      consentimentoIa: 'nao_informado',
      conteudoOculto: false,
    });
    atFisio = (res.body as { id: string }).id;
    const de_novo = await api.http().post('/atendimentos').set(cab(fisioA)).send({ agendamentoId: agFisio });
    expect((de_novo.body as { id: string }).id).toBe(atFisio);
    const psi = await api.http().post('/atendimentos').set(cab(psiA)).send({ agendamentoId: agPsi, consentimentoIa: 'recusou' });
    expect(psi.status).toBe(200);
    expect(psi.body).toMatchObject({ modelo: 'psicologia', restrito: true, consentimentoIa: 'recusou' });
    atPsi = (psi.body as { id: string }).id;
  });

  it('agendamento sem check-in: 409 agendamento_sem_chegada; agendamento inexistente: 404', async () => {
    const ag = await agendamento(clinicaA, pacienteA, profissionalDe.get(fisioA.userId) as string, tipoA, 'confirmed');
    const res = await api.http().post('/atendimentos').set(cab(fisioA)).send({ agendamentoId: ag });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ codigo: 'agendamento_sem_chegada' });
    expect((await api.http().post('/atendimentos').set(cab(fisioA)).send({ agendamentoId: randomUUID() })).status).toBe(404);
  });
});

describe('evolução versionada e cifrada', () => {
  it('cada salvamento cria uma versão; versão base desatualizada: 409', async () => {
    const v1 = await api.http().put(`/atendimentos/${atFisio}/registro`).set(cab(fisioA)).send({ versaoBase: 0, conteudo: { queixa: QUEIXA_V1 } });
    expect(v1.status).toBe(200);
    expect(v1.body).toMatchObject({ versao: 1, conteudo: { queixa: QUEIXA_V1 }, versaoModelo: 1 });
    const v2 = await api
      .http()
      .put(`/atendimentos/${atFisio}/registro`)
      .set(cab(fisioA))
      .send({
        versaoBase: 1,
        conteudo: {
          queixa: QUEIXA_V2,
          avaliacao: 'Linha 1\nLinha 2',
          medidas: [
            { tipo: 'eva', valor: 7 },
            { tipo: 'goniometria', rotulo: 'flexao de joelho D', valor: 95 },
          ],
          planoDeSessoes: { totalSessoes: 10, frequenciaSemanal: 2, metas: [{ descricao: 'Subir escadas sem apoio', progresso: 40 }] },
        },
      });
    expect(v2.status).toBe(200);
    expect(v2.body).toMatchObject({ versao: 2, conteudo: { queixa: QUEIXA_V2, avaliacao: 'Linha 1\nLinha 2' } });
    const velha = await api.http().put(`/atendimentos/${atFisio}/registro`).set(cab(fisioA)).send({ versaoBase: 1, conteudo: { queixa: 'x' } });
    expect(velha.status).toBe(409);
    expect(velha.body).toMatchObject({ codigo: 'versao_desatualizada' });
  });

  it('conteúdo validado pelo modelo: chave desconhecida, EVA fora da faixa e campo de outro nicho dão 400 sem eco do valor', async () => {
    const r1 = await api.http().put(`/atendimentos/${atFisio}/registro`).set(cab(fisioA)).send({ versaoBase: 2, conteudo: { tema: PSICO } });
    expect(r1.status).toBe(400);
    expect(JSON.stringify(r1.body)).not.toContain('5505');
    const r2 = await api
      .http()
      .put(`/atendimentos/${atFisio}/registro`)
      .set(cab(fisioA))
      .send({ versaoBase: 2, conteudo: { medidas: [{ tipo: 'eva', valor: 11 }] } });
    expect(r2.status).toBe(400);
    expect(r2.body).toMatchObject({ campos: ['conteudo.medidas.0.valor'] });
    const r3 = await api.http().put(`/atendimentos/${atFisio}/registro`).set(cab(fisioA)).send({ versaoBase: 2, conteudo: { queixa: 'a\u0000b' } });
    expect(r3.status).toBe(400);
  });

  it('só o autor edita: outro profissional com vínculo recebe 403 auditado', async () => {
    const res = await api.http().put(`/atendimentos/${atFisio}/registro`).set(cab(outroA)).send({ versaoBase: 2, conteudo: { queixa: 'x' } });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ codigo: 'somente_o_autor' });
    expect((await negacoes(clinicaA, outroA)).map((l) => l.metadata)).toContainEqual(
      expect.objectContaining({ op: 'salvar_registro', reason: 'somente_o_autor', target_id: atFisio }),
    );
  });

  it('no banco o conteúdo é só cifra: uma consulta direta não mostra o texto', async () => {
    const linhas = await withTenant(api.db.db, clinicaA, (tx) =>
      tx.execute<Record<string, unknown>>(sql`select * from clinical_record_versions where encounter_id = ${atFisio}`),
    );
    expect(linhas).toHaveLength(2);
    for (const l of linhas) expect(String(l.content_enc)).toMatch(/^v1:/);
    const tudo = JSON.stringify(linhas);
    for (const m of MARCADORES) expect(tudo).not.toContain(m);
    expect(tudo).not.toContain('goniometria');
    // E o banco recusa texto em claro, mesmo por SQL direto.
    const emClaro = withTenant(api.db.db, clinicaA, (tx) =>
      tx.insert(clinicalRecordVersions).values({
        tenantId: clinicaA,
        encounterId: atFisio,
        version: 3,
        template: 'fisio',
        templateVersion: 1,
        contentEnc: '{"queixa":"texto em claro"}',
        createdBy: fisioA.userId,
      }),
    );
    expect(await sqlstates(emClaro)).toContain('23514');
  });

  it('versões preservadas: a lista traz v1 e v2 originais; o runtime não altera nem apaga versão', async () => {
    const res = await api.http().get(`/atendimentos/${atFisio}/versoes`).set(cab(fisioA));
    expect(res.status).toBe(200);
    const versoes = res.body as { versao: number; conteudo: Record<string, unknown> }[];
    expect(versoes.map((v) => v.versao)).toEqual([1, 2]);
    expect(versoes[0]?.conteudo).toEqual({ queixa: QUEIXA_V1 });
    expect(versoes[1]?.conteudo).toMatchObject({ queixa: QUEIXA_V2 });
    const upd = withTenant(api.db.db, clinicaA, (tx) =>
      tx.execute(sql`update clinical_record_versions set version = version where encounter_id = ${atFisio}`),
    );
    expect(await sqlstates(upd)).toContain('42501');
    const del = withTenant(api.db.db, clinicaA, (tx) => tx.execute(sql`delete from clinical_record_versions where encounter_id = ${atFisio}`));
    expect(await sqlstates(del)).toContain('42501');
    const delAt = withTenant(api.db.db, clinicaA, (tx) => tx.execute(sql`delete from encounters where id = ${atFisio}`));
    expect(await sqlstates(delAt)).toContain('42501');
  });
});

describe('finalização e adendo', () => {
  it('adendo antes de finalizar: 409; finalizar incompleto: 409 com os campos faltando', async () => {
    const ad = await api.http().post(`/atendimentos/${atFisio}/adendos`).set(cab(fisioA)).send({ texto: ADENDO });
    expect(ad.status).toBe(409);
    expect(ad.body).toMatchObject({ codigo: 'registro_nao_finalizado' });
    const fin = await api.http().post(`/atendimentos/${atFisio}/finalizar`).set(cab(fisioA)).send({});
    expect(fin.status).toBe(409);
    expect(fin.body).toMatchObject({ codigo: 'registro_incompleto', campos: ['conduta'] });
  });

  it('finalizado não edita (API e banco); adendo depois sai com autor e data', async () => {
    await api
      .http()
      .put(`/atendimentos/${atFisio}/registro`)
      .set(cab(fisioA))
      .send({ versaoBase: 2, conteudo: { queixa: QUEIXA_V2, conduta: CONDUTA, medidas: [{ tipo: 'eva', valor: 6 }] } })
      .expect(200);
    const fin = await api.http().post(`/atendimentos/${atFisio}/finalizar`).set(cab(fisioA)).send({});
    expect(fin.status).toBe(200);
    expect(fin.body).toMatchObject({ status: 'finalizado', versao: 3, finalizadoPor: fisioA.userId });
    expect((fin.body as { hashFinalizacao: string }).hashFinalizacao).toMatch(/^[0-9a-f]{64}$/);

    const editar = await api.http().put(`/atendimentos/${atFisio}/registro`).set(cab(fisioA)).send({ versaoBase: 3, conteudo: { queixa: 'x' } });
    expect(editar.status).toBe(409);
    expect(editar.body).toMatchObject({ codigo: 'registro_finalizado' });
    expect((await api.http().post(`/atendimentos/${atFisio}/finalizar`).set(cab(fisioA)).send({})).status).toBe(409);

    // Pelo banco, nem versão nova nem alteração do atendimento finalizado.
    const novaVersao = withTenant(api.db.db, clinicaA, (tx) =>
      tx.execute(sql`insert into clinical_record_versions (tenant_id, encounter_id, version, template, template_version, content_enc, created_by)
        select tenant_id, encounter_id, 4, template, template_version, content_enc, created_by from clinical_record_versions
        where encounter_id = ${atFisio} and version = 3`),
    );
    expect(await sqlstates(novaVersao)).toContain('55000');
    const reabrir = withTenant(api.db.db, clinicaA, (tx) => tx.update(encounters).set({ updatedAt: new Date() }).where(eq(encounters.id, atFisio)));
    expect(await sqlstates(reabrir)).toContain('55000');

    const ad = await api.http().post(`/atendimentos/${atFisio}/adendos`).set(cab(fisioA)).send({ texto: ADENDO });
    expect(ad.status).toBe(201);
    const adendos = (ad.body as { adendos: { texto: string; autorId: string; em: string }[] }).adendos;
    expect(adendos).toHaveLength(1);
    expect(adendos[0]).toMatchObject({ texto: ADENDO, autorId: fisioA.userId });
    expect(Date.parse(adendos[0]?.em ?? '')).not.toBeNaN();
    const [linha] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(clinicalAddenda).where(eq(clinicalAddenda.encounterId, atFisio)));
    expect(linha?.textEnc).toMatch(/^v1:/);
    expect(JSON.stringify(linha)).not.toContain('5504');
  });

  it('outro profissional com vínculo lê o registro geral (prontuário único) com o adendo', async () => {
    const res = await api.http().get(`/atendimentos/${atFisio}`).set(cab(outroA));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ conteudoOculto: false, conteudo: { conduta: CONDUTA }, adendos: [{ texto: ADENDO }] });
  });
});

describe('sigilo da psicologia (configurável enquanto a 1.11 está com o advogado)', () => {
  it('padrão restrito_ao_autor: quem tem vínculo vê só os metadados; o autor vê o conteúdo', async () => {
    await api.http().put(`/atendimentos/${atPsi}/registro`).set(cab(psiA)).send({ versaoBase: 0, conteudo: { tema: PSICO, evolucao: 'Evolucao ficticia' } }).expect(200);
    const outro = await api.http().get(`/atendimentos/${atPsi}`).set(cab(outroA));
    expect(outro.status).toBe(200);
    expect(outro.body).toMatchObject({ conteudoOculto: true, motivoOculto: 'sigilo_psicologia', conteudo: null, adendos: [] });
    expect(JSON.stringify(outro.body)).not.toContain('5505');
    expect((await api.http().get(`/atendimentos/${atPsi}/versoes`).set(cab(outroA))).status).toBe(403);
    const autor = await api.http().get(`/atendimentos/${atPsi}`).set(cab(psiA));
    expect(autor.body).toMatchObject({ conteudoOculto: false, conteudo: { tema: PSICO } });
  });

  it('histórico paginado do paciente: registros visíveis com conteúdo, o de psicologia oculto para outro profissional', async () => {
    const res = await api.http().get(`/pacientes/${pacienteA}/prontuario`).set(cab(outroA));
    expect(res.status).toBe(200);
    const corpo = res.body as { itens: { id: string; conteudoOculto: boolean }[]; temMais: boolean };
    expect(corpo.itens.map((i) => i.id).sort()).toEqual([atFisio, atPsi].sort());
    expect(corpo.itens.find((i) => i.id === atPsi)?.conteudoOculto).toBe(true);
    expect(corpo.itens.find((i) => i.id === atFisio)?.conteudoOculto).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain('5505');
    const pag = await api.http().get(`/pacientes/${pacienteA}/prontuario?pagina=1&limite=1`).set(cab(outroA));
    expect(pag.body).toMatchObject({ pagina: 1, limite: 1, temMais: true });
    expect((pag.body as { itens: unknown[] }).itens).toHaveLength(1);
    const comBusca = await api.http().get(`/pacientes/${pacienteA}/prontuario?busca=dor`).set(cab(outroA));
    expect(comBusca.status).toBe(400);
    expect(comBusca.body).toMatchObject({ campos: ['dado_na_url'] });
  });

  it('o dono muda para prontuario_unico (auditado como permission_change): quem tem vínculo passa a ler', async () => {
    expect((await api.http().put('/prontuario/configuracao').set(cab(recepA)).send({ psicologia: 'prontuario_unico' })).status).toBe(403);
    expect((await api.http().put('/prontuario/configuracao').set(cab(fisioA)).send({ psicologia: 'prontuario_unico' })).status).toBe(403);
    const res = await api.http().put('/prontuario/configuracao').set(cab(adminA)).send({ psicologia: 'prontuario_unico' });
    expect(res.status).toBe(200);
    const outro = await api.http().get(`/atendimentos/${atPsi}`).set(cab(outroA));
    expect(outro.body).toMatchObject({ conteudoOculto: false, conteudo: { tema: PSICO } });
    const trilha = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(auditLog).where(eq(auditLog.scope, 'clinical_settings')));
    expect(trilha.map((l) => [l.action, l.metadata])).toContainEqual(['permission_change', { from: 'restrito_ao_autor', to: 'prontuario_unico' }]);
    await api.http().put('/prontuario/configuracao').set(cab(adminA)).send({ psicologia: 'restrito_ao_autor' }).expect(200);
    const [cfg] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(clinicalSettings));
    expect(cfg?.psychCompartment).toBe('restrito_ao_autor');
  });
});

describe('notas privadas (tabela separada, só o autor)', () => {
  let notaId: string;

  it('o autor cria e lê; no banco só cifra', async () => {
    const res = await api.http().post(`/pacientes/${pacienteA}/notas-privadas`).set(cab(psiA)).send({ texto: NOTA, atendimentoId: atPsi });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ texto: NOTA, atendimentoId: atPsi, incluirNaExportacao: false });
    notaId = (res.body as { id: string }).id;
    const lista = await api.http().get(`/pacientes/${pacienteA}/notas-privadas`).set(cab(psiA));
    expect((lista.body as { id: string }[]).map((n) => n.id)).toEqual([notaId]);
    const [linha] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(privateNotes).where(eq(privateNotes.id, notaId)));
    expect(linha?.contentEnc).toMatch(/^v1:/);
    expect(JSON.stringify(linha)).not.toContain('5506');
  });

  it('outro profissional (com vínculo, mesmo no modo prontuário único) não lê: 404 e tentativa auditada; lista vazia', async () => {
    await api.http().put('/prontuario/configuracao').set(cab(adminA)).send({ psicologia: 'prontuario_unico' }).expect(200);
    for (const pedir of [
      () => api.http().get(`/notas-privadas/${notaId}`).set(cab(outroA)),
      () => api.http().patch(`/notas-privadas/${notaId}`).set(cab(outroA)).send({ texto: 'invasao' }),
      () => api.http().post(`/notas-privadas/${notaId}/descartar`).set(cab(outroA)).send({}),
    ]) {
      const res = await pedir();
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain('5506');
    }
    const lista = await api.http().get(`/pacientes/${pacienteA}/notas-privadas`).set(cab(outroA));
    expect(lista.status).toBe(200);
    expect(lista.body).toEqual([]);
    expect((await negacoes(clinicaA, outroA)).map((l) => l.metadata)).toContainEqual(
      expect.objectContaining({ op: 'nota_ler', reason: 'nota_de_outro_autor', target_id: notaId }),
    );
    // Admin da clínica (não clínico): 403 antes de tudo.
    expect((await api.http().get(`/notas-privadas/${notaId}`).set(cab(adminA))).status).toBe(403);
    await api.http().put('/prontuario/configuracao').set(cab(adminA)).send({ psicologia: 'restrito_ao_autor' }).expect(200);
  });

  it('o autor altera, marca para exportar e descarta; descartada some da API mas a linha fica (sem DELETE)', async () => {
    const upd = await api.http().patch(`/notas-privadas/${notaId}`).set(cab(psiA)).send({ texto: `${NOTA} revista`, incluirNaExportacao: true });
    expect(upd.status).toBe(200);
    expect(upd.body).toMatchObject({ texto: `${NOTA} revista`, incluirNaExportacao: true });
    expect((await api.http().post(`/notas-privadas/${notaId}/descartar`).set(cab(psiA)).send({})).status).toBe(200);
    expect((await api.http().get(`/notas-privadas/${notaId}`).set(cab(psiA))).status).toBe(404);
    const [linha] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(privateNotes).where(eq(privateNotes.id, notaId)));
    expect(linha?.discardedAt).not.toBeNull();
    expect(linha?.exportConsent).toBe(false);
    const del = withTenant(api.db.db, clinicaA, (tx) => tx.execute(sql`delete from private_notes where id = ${notaId}`));
    expect(await sqlstates(del)).toContain('42501');
  });
});

describe('isolamento entre clínicas', () => {
  it('profissional de B não vê atendimento, histórico nem nota de A (404, igual a inexistente)', async () => {
    expect((await api.http().get(`/atendimentos/${atFisio}`).set(cab(profB))).status).toBe(404);
    expect((await api.http().get(`/atendimentos/${atFisio}/versoes`).set(cab(profB))).status).toBe(404);
    expect((await api.http().post(`/atendimentos/${atFisio}/adendos`).set(cab(profB)).send({ texto: 'x' })).status).toBe(404);
    expect((await api.http().get(`/pacientes/${pacienteA}/prontuario`).set(cab(profB))).status).toBe(404);
    expect((await api.http().post('/atendimentos').set(cab(profB)).send({ agendamentoId: agFisio })).status).toBe(404);
  });

  it('pelo RLS: a sessão de B não lê nem grava nas 5 tabelas de A', async () => {
    const lidas = await withTenant(api.db.db, clinicaB, async (tx) => ({
      encounters: (await tx.select().from(encounters).where(eq(encounters.id, atFisio))).length,
      versoes: (await tx.select().from(clinicalRecordVersions).where(eq(clinicalRecordVersions.encounterId, atFisio))).length,
      adendos: (await tx.select().from(clinicalAddenda).where(eq(clinicalAddenda.encounterId, atFisio))).length,
      notas: (await tx.select().from(privateNotes).where(eq(privateNotes.patientId, pacienteA))).length,
      cfg: (await tx.select().from(clinicalSettings).where(eq(clinicalSettings.tenantId, clinicaA))).length,
    }));
    expect(lidas).toEqual({ encounters: 0, versoes: 0, adendos: 0, notas: 0, cfg: 0 });
    // Gravar com tenant_id de A a partir da sessão de B: o WITH CHECK recusa (42501).
    const notaEmA = withTenant(api.db.db, clinicaB, (tx) =>
      tx.execute(sql`insert into private_notes (tenant_id, patient_id, author_user_id, content_enc)
        values (${clinicaA}, ${pacienteA}, ${profB.userId}, 'v1:x:x:x:x')`),
    );
    expect(await sqlstates(notaEmA)).toContain('42501');
    // Adendo em atendimento de A: o trigger (que roda antes do WITH CHECK) já não enxerga o atendimento
    // pela RLS de B e recusa (55000); se passasse, o WITH CHECK recusaria (42501).
    const adendoEmA = withTenant(api.db.db, clinicaB, (tx) =>
      tx.execute(sql`insert into clinical_addenda (tenant_id, encounter_id, text_enc, created_by)
        values (${clinicaA}, ${atFisio}, 'v1:x:x:x:x', ${profB.userId})`),
    );
    expect((await sqlstates(adendoEmA)).some((c) => c === '55000' || c === '42501')).toBe(true);
    const cfgEmA = withTenant(api.db.db, clinicaB, (tx) =>
      tx.insert(clinicalSettings).values({ tenantId: clinicaA, psychCompartment: 'prontuario_unico', updatedBy: profB.userId }),
    );
    expect(await sqlstates(cfgEmA)).toContain('42501');
    // Atendimento de B apontando para paciente/agendamento de A: a FK composta recusa.
    const cruzado = withTenant(api.db.db, clinicaB, (tx) =>
      tx.insert(encounters).values({
        tenantId: clinicaB,
        patientId: pacienteA,
        professionalId: profissionalDe.get(profB.userId) as string,
        appointmentId: agFisio,
        authorUserId: profB.userId,
        template: 'fisio',
        compartment: 'geral',
      }),
    );
    expect(await sqlstates(cruzado)).toContain('23503');
  });
});

describe('auditoria do prontuário', () => {
  it('abrir, salvar, finalizar, ler e adendo ficam na trilha com a base do vínculo e SEM conteúdo', async () => {
    const linhas = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(auditLog));
    const doAt = linhas.filter((l) => (l.metadata as Record<string, unknown>).encounter_id === atFisio);
    const pares = doAt.map((l) => `${l.action}:${l.scope}`);
    expect(pares).toEqual(
      expect.arrayContaining([
        'create:encounters',
        'update:clinical_records',
        'sign:encounters',
        'read:clinical_records',
        'create:clinical_addenda',
      ]),
    );
    const assinatura = doAt.find((l) => l.action === 'sign');
    expect(assinatura?.metadata).toMatchObject({ version: 3 });
    expect(typeof (assinatura?.metadata as { care_basis?: unknown }).care_basis).toBe('string');
    expect((assinatura?.metadata as { hash: string }).hash).toMatch(/^[0-9a-f]{64}$/);
    expect(linhas.some((l) => l.scope === 'private_notes' && l.action === 'create')).toBe(true);
    const tudo = JSON.stringify(linhas);
    for (const m of MARCADORES) expect(tudo).not.toContain(m);
    expect(tudo).not.toContain('invasao');
  });
});
