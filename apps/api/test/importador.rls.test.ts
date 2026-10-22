/**
 * Importador (migração 0024) contra Postgres REAL: isolamento entre clínicas (pela API e pelo RLS) em
 * import_batches, import_raw_files, import_issues e import_batch_records; termo de migração obrigatório;
 * só admin (na API e no banco); CSV UTF-8 (XLSX 415, tamanho 413); validação e duplicados; dry-run que
 * não grava; aplicar só com a simulação aprovada; desfazer e bloqueio quando algo foi usado; fórmulas
 * neutralizadas na leitura e no relatório; arquivo bruto só cifrado, descartado ao aplicar e expirado
 * pela função de expurgo (idempotente); auditoria sem conteúdo.
 * Pré-requisitos: migrações aplicadas e DATABASE_URL = papel app_user. Dados 100% fictícios.
 */
import type { TenantId, UserId } from '@plataforma/shared';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appointments, auditLog, importBatches, importBatchRecords, importIssues, importRawFiles, patients, tenants } from '../src/db/schema';
import { withTenant, type TenantTx } from '../src/db/tenant-transaction';
import { FIELD_CIPHER } from '../src/modules/crypto/crypto.module';
import type { FieldCipher } from '../src/modules/crypto/field-cipher';
import { TERMO_MIGRACAO_VERSAO } from '../src/modules/imports/importacao-regras';
import { TERMO_MIGRACAO_SHA256, TERMO_MIGRACAO_TEXTO } from '../src/modules/imports/termo-migracao';
import { ImportacaoService, loadImportacaoConfig } from '../src/modules/imports/importacao.service';
import { cab, cpfFicticio, subirApi, type ApiDeTeste } from './apoio-api';

type Sessao = { Authorization: string; userId: string };

let api: ApiDeTeste;
let clinicaA: TenantId;
let clinicaB: TenantId;
let adminA: Sessao;
let adminB: Sessao;
let recepA: Sessao;
let profA: Sessao;
let finA: Sessao;
let adminSemPerfilNoBanco: Sessao;
let profissionalA: string;
let tipoA: string;
/** Nome de cada clínica (para a confirmação da clínica de origem no aplicar, R6). */
const nomes = new Map<string, string>();

/** CPFs fictícios (prefixo 000, faixa não emitida), em faixa própria desta suíte. */
const CPF = (n: number) => cpfFicticio(730_000 + n);
const FORMULA = '=HYPERLINK("http://exemplo.test")';

function enviar(s: Sessao, tipo: string, csv: string | Buffer, termo: string | null = TERMO_MIGRACAO_VERSAO, contentType = 'text/csv; charset=utf-8') {
  const qs = termo === null ? `tipo=${tipo}` : `tipo=${tipo}&termo=${termo}`;
  return api.http().post(`/importacoes?${qs}`).set(cab(s)).set('Content-Type', contentType).send(csv);
}

/** Envia, mapeia, valida e simula; devolve o id e o resultado da simulação. */
async function ateSimular(s: Sessao, tipo: string, csv: string, mapeamento: Record<string, number>) {
  const r = await enviar(s, tipo, csv);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const id = (r.body as { id: string }).id;
  await api.http().put(`/importacoes/${id}/mapeamento`).set(cab(s)).send({ mapeamento }).expect(200);
  await api.http().post(`/importacoes/${id}/validar`).set(cab(s)).send({}).expect(200);
  const sim = await api.http().post(`/importacoes/${id}/simular`).set(cab(s)).send({});
  expect(sim.status, JSON.stringify(sim.body)).toBe(200);
  return { id, sim: sim.body as { resumoHash: string; lote: { criar: number; ignorar: number }; divergencias: { linha: number; campo: string; codigo: string; gravidade: string; valor: string | null }[] } };
}


/** Aplica confirmando a clínica de origem (nome da clínica do admin, R6). */
function aplicar(s: Sessao, id: string, resumoHash: string, clinicaConfirmada?: string) {
  const t = s === adminB ? clinicaB : clinicaA;
  return api.http().post(`/importacoes/${id}/aplicar`).set(cab(s)).send({ resumoHash, clinicaConfirmada: clinicaConfirmada ?? nomes.get(t) });
}

async function nomeDaClinica(t: TenantId): Promise<string> {
  const [linha] = await withTenant(api.db.db, t, (tx) => tx.select({ nome: tenants.displayName }).from(tenants));
  return linha?.nome as string;
}

const contarPacientes = (t: TenantId) =>
  withTenant(api.db.db, t, async (tx) => (await tx.select({ n: sql<number>`count(*)::int` }).from(patients))[0]?.n ?? -1);

beforeAll(async () => {
  api = await subirApi();
  clinicaA = await api.novaClinica();
  clinicaB = await api.novaClinica();
  nomes.set(clinicaA, await nomeDaClinica(clinicaA));
  nomes.set(clinicaB, await nomeDaClinica(clinicaB));
  adminA = await api.membro(clinicaA, api.sessao(clinicaA, 'admin'), 'admin');
  adminB = await api.membro(clinicaB, api.sessao(clinicaB, 'admin'), 'admin');
  recepA = api.sessao(clinicaA, 'recepcao');
  profA = api.sessao(clinicaA, 'profissional');
  finA = api.sessao(clinicaA, 'financeiro');
  adminSemPerfilNoBanco = api.sessao(clinicaA, 'admin');
  profissionalA = ((await api.http().post('/profissionais').set(cab(adminA)).send({ nome: 'Prof Ficticia Import', especialidade: 'Fisioterapia' }).expect(201)).body as { id: string }).id;
  tipoA = ((await api.http().post('/tipos-atendimento').set(cab(adminA)).send({ nome: 'Sessao Import', minutos: 50 }).expect(201)).body as { id: string }).id;
});

afterAll(async () => {
  await api?.fechar();
});

describe('termo de migração, formato e permissões', () => {
  it('sem aceite do termo: 409 termo_de_migracao_obrigatorio; versão antiga: 409 termo_desatualizado; nada gravado', async () => {
    const sem = await enviar(adminA, 'pacientes', 'nome;telefone\nAna Ficticia;11900000001\n', null);
    expect(sem.status).toBe(409);
    expect(sem.body).toMatchObject({ codigo: 'termo_de_migracao_obrigatorio' });
    const velho = await enviar(adminA, 'pacientes', 'nome;telefone\nAna Ficticia;11900000001\n', 'mig-02.4-v0');
    expect(velho.body).toMatchObject({ codigo: 'termo_desatualizado' });
    const lotes = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(importBatches));
    expect(lotes).toHaveLength(0);
  });

  it('o lote grava o aceite (versão, quem, quando)', async () => {
    const r = await enviar(adminA, 'pacientes', 'Nome;Celular\nAna Ficticia;11900000001\n');
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      status: 'recebido',
      termo: { versao: TERMO_MIGRACAO_VERSAO, aceitoPor: adminA.userId },
      cabecalho: [
        { indice: 0, texto: 'Nome' },
        { indice: 1, texto: 'Celular' },
      ],
      mapeamentoSugerido: { nome: 0, telefone: 1 },
    });
    expect(new Date((r.body as { arquivoExpiraEm: string }).arquivoExpiraEm).getTime() - Date.now()).toBeLessThanOrEqual(7 * 86_400_000);
  });

  it('R4: o termo tem texto versionado; o aceite grava a versão e o hash do texto, imutável; lote sem o hash é recusado', async () => {
    const t = await api.http().get('/importacoes/termo').set(cab(adminA)).expect(200);
    expect(t.body).toMatchObject({ versao: TERMO_MIGRACAO_VERSAO, texto: TERMO_MIGRACAO_TEXTO, textoSha256: TERMO_MIGRACAO_SHA256 });
    const r = await enviar(adminA, 'pacientes', 'nome;telefone\nTermo Ficticio;11900000002\n');
    expect(r.body).toMatchObject({ termo: { versao: TERMO_MIGRACAO_VERSAO, textoSha256: TERMO_MIGRACAO_SHA256 } });
    const id = (r.body as { id: string }).id;
    await expect(
      withTenant(api.db.db, clinicaA, (tx) => tx.update(importBatches).set({ termSha256: 'e'.repeat(64) }).where(eq(importBatches.id, id)), adminA.userId),
    ).rejects.toThrow();
    await expect(
      withTenant(api.db.db, clinicaA, (tx) =>
        tx.insert(importBatches).values({ tenantId: clinicaA, kind: 'pacientes', termVersion: TERMO_MIGRACAO_VERSAO, termAcceptedBy: adminA.userId, byteSize: 1, rowCount: 1, columnCount: 1, createdBy: adminA.userId, rawExpiresAt: sql`now() + interval '1 day'` }), adminA.userId),
    ).rejects.toThrow();
  });

  it('XLSX (pelo tipo ou pela assinatura ZIP) e texto não-CSV: 415; Latin-1: 400; acima de 5 MiB: 413', async () => {
    const xlsx = await enviar(adminA, 'pacientes', Buffer.from('PK\u0003\u0004qualquer'), TERMO_MIGRACAO_VERSAO, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(xlsx.status).toBe(415);
    expect(xlsx.body).toMatchObject({ codigo: 'formato_nao_suportado' });
    expect((await enviar(adminA, 'pacientes', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]))).status).toBe(415);
    expect((await enviar(adminA, 'pacientes', 'nome;telefone', TERMO_MIGRACAO_VERSAO, 'text/plain')).status).toBe(415);
    const latin1 = await enviar(adminA, 'pacientes', Buffer.from([0x6e, 0x6f, 0x6d, 0x65, 0x0a, 0x4a, 0x6f, 0xe3, 0x6f]));
    expect(latin1.status).toBe(400);
    expect(latin1.body).toMatchObject({ codigo: 'codificacao_invalida' });
    const grande = await enviar(adminA, 'pacientes', Buffer.alloc(5 * 1024 * 1024 + 10, 0x61));
    expect(grande.status).toBe(413);
  });

  it('só admin: recepção, profissional e financeiro recebem 403 em todas as rotas', async () => {
    for (const s of [recepA, profA, finA]) {
      expect((await enviar(s, 'pacientes', 'nome;telefone\nAna;11900000001\n')).status).toBe(403);
      expect((await api.http().get('/importacoes').set(cab(s))).status).toBe(403);
      expect((await api.http().post(`/importacoes/${randomUUID()}/desfazer`).set(cab(s)).send({})).status).toBe(403);
    }
  });

  it('admin só na sessão, sem perfil admin registrado no banco (clinic_members): 403 e nada gravado', async () => {
    const antes = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(importBatches));
    const r = await enviar(adminSemPerfilNoBanco, 'pacientes', 'nome;telefone\nAna Ficticia;11900000001\n');
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ codigo: 'perfil_admin_nao_registrado' });
    expect(await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(importBatches))).toHaveLength(antes.length);
  });
});

describe('pacientes: validar, dry-run, aplicar, duplicados e fórmulas', () => {
  let loteId: string;
  let hash: string;

  it('validação e dry-run com divergências; o dry-run NÃO cria paciente', async () => {
    // Paciente já cadastrado na clínica (CPF repetido deve ser ignorado, nunca sobrescrito).
    await api.http().post('/pacientes').set(cab(adminA)).send({ nome: 'Ja Cadastrado Ficticio', telefone: '11900000010', cpf: CPF(10) }).expect(201);
    const csv = [
      'Nome;CPF;Celular;Nascimento',
      `Carla Ficticia;${CPF(1)};(11) 90000-0011;02/01/1990`,
      `Duda Ficticia;${CPF(2)};11900000012;`,
      `${FORMULA};;11900000013;`,
      `Repetida Ficticia;${CPF(1)};11900000014;`,
      `Outro Nome Ja Cadastrado;${CPF(10)};11900000015;`,
      'Sem Telefone Ficticio;;;',
      `Cpf Errado Ficticio;12345678900;11900000017;`,
    ].join('\r\n');
    const antes = await contarPacientes(clinicaA);
    const { id, sim } = await ateSimular(adminA, 'pacientes', csv, { nome: 0, cpf: 1, telefone: 2, nascimento: 3 });
    loteId = id;
    hash = sim.resumoHash;
    expect(await contarPacientes(clinicaA)).toBe(antes);
    expect(sim.lote).toMatchObject({ criar: 2, ignorar: 1 });
    const cod = sim.divergencias.map((d) => `${d.linha}:${d.campo}:${d.codigo}`);
    expect(cod).toEqual(
      expect.arrayContaining(['4:nome:formula_na_celula', '5:cpf:cpf_duplicado_no_arquivo', '6:cpf:ja_cadastrado', '7:telefone:obrigatorio', '8:cpf:cpf_invalido']),
    );
    // Fórmula neutralizada no relatório (JSON).
    expect(sim.divergencias.find((d) => d.codigo === 'formula_na_celula')?.valor).toBe(`'${FORMULA}`);
    // Divergências gravadas só como código (sem valor).
    const issues = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(importIssues).where(eq(importIssues.batchId, id)));
    expect(JSON.stringify(issues)).not.toContain('HYPERLINK');
    expect(JSON.stringify(issues)).not.toContain(CPF(1));
  });

  it('relatório CSV: fórmula neutralizada com apóstrofo', async () => {
    const r = await api.http().get(`/importacoes/${loteId}/divergencias?formato=csv`).set(cab(adminA)).buffer(true);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/csv');
    expect(r.text).toContain(`"'${FORMULA.replaceAll('"', '""')}"`);
    expect(r.text).not.toContain(`,"${FORMULA.replaceAll('"', '""')}"`);
  });

  it('o arquivo bruto está SÓ cifrado (v1, chave da clínica) e o runtime não o altera nem apaga', async () => {
    const [bruto] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(importRawFiles).where(eq(importRawFiles.batchId, loteId)));
    expect(bruto?.contentEnc.startsWith('v1:')).toBe(true);
    expect(bruto?.contentEnc).not.toContain('Ficticia');
    expect(bruto?.sha256).toMatch(/^[0-9a-f]{64}$/);
    await expect(withTenant(api.db.db, clinicaA, (tx) => tx.delete(importRawFiles).where(eq(importRawFiles.batchId, loteId)), adminA.userId)).rejects.toThrow();
    await expect(
      withTenant(api.db.db, clinicaA, (tx) => tx.update(importRawFiles).set({ sha256: '0'.repeat(64) }).where(eq(importRawFiles.batchId, loteId)), adminA.userId),
    ).rejects.toThrow();
  });

  it('aplicar exige o hash da simulação aprovada', async () => {
    const r = await aplicar(adminA, loteId, 'f'.repeat(64));
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ codigo: 'simulacao_nao_aprovada' });
  });

  it('aplicar cria só as linhas planejadas, com a cifra do cadastro, e descarta o arquivo bruto no mesmo commit', async () => {
    const antes = await contarPacientes(clinicaA);
    const r = await aplicar(adminA, loteId, hash);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: 'aplicado', criados: 2 });
    expect((r.body as { arquivoDescartadoEm: string | null }).arquivoDescartadoEm).not.toBeNull();
    expect(await contarPacientes(clinicaA)).toBe(antes + 2);
    const livro = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(importBatchRecords).where(eq(importBatchRecords.batchId, loteId)));
    expect(livro.map((l) => l.lineNumber).sort()).toEqual([2, 3]);
    const carla = await api.http().get(`/pacientes/${livro.find((l) => l.lineNumber === 2)?.recordId}`).set(cab(adminA)).expect(200);
    expect(carla.body).toMatchObject({ nome: 'Carla Ficticia', cpf: CPF(1), telefone: '11900000011', nascimento: '1990-01-02' });
    const [linhaBanco] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(patients).where(eq(patients.id, livro[0]?.recordId as string)));
    expect(linhaBanco?.cpfEnc?.startsWith('v1:')).toBe(true);
    const brutos = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(importRawFiles).where(eq(importRawFiles.batchId, loteId)));
    expect(brutos).toHaveLength(0);
    // Aplicado não se aplica de novo.
    expect((await aplicar(adminA, loteId, hash)).status).toBe(409);
  });

  it('desfazer apaga o que o lote criou; desfeito é terminal', async () => {
    const antes = await contarPacientes(clinicaA);
    const r = await api.http().post(`/importacoes/${loteId}/desfazer`).set(cab(adminA)).send({});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: 'desfeito' });
    expect(await contarPacientes(clinicaA)).toBe(antes - 2);
    expect((await api.http().post(`/importacoes/${loteId}/desfazer`).set(cab(adminA)).send({})).status).toBe(409);
    // O paciente que já existia não foi tocado.
    const ja = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(patients).where(eq(patients.displayName, 'Ja Cadastrado Ficticio')));
    expect(ja).toHaveLength(1);
  });

  it('simulação desatualizada: CPF cadastrado depois do dry-run faz o aplicar recusar (409) sem gravar', async () => {
    const { id, sim } = await ateSimular(adminA, 'pacientes', `nome;cpf;telefone\nNova Ficticia;${CPF(20)};11900000020\n`, { nome: 0, cpf: 1, telefone: 2 });
    await api.http().post('/pacientes').set(cab(recepA)).send({ nome: 'Cadastrada Antes Ficticia', telefone: '11900000021', cpf: CPF(20) }).expect(201);
    const antes = await contarPacientes(clinicaA);
    const r = await aplicar(adminA, id, sim.resumoHash);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ codigo: 'simulacao_desatualizada' });
    expect(await contarPacientes(clinicaA)).toBe(antes);
  });

  it('desfazer bloqueado quando o importado foi alterado ou ganhou agendamento (motivos só em contagem)', async () => {
    const { id, sim } = await ateSimular(adminA, 'pacientes', 'nome;telefone\nUsada Ficticia;11900000030\nIntacta Ficticia;11900000031\n', { nome: 0, telefone: 1 });
    await aplicar(adminA, id, sim.resumoHash).expect(200);
    const livro = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(importBatchRecords).where(eq(importBatchRecords.batchId, id)));
    const usada = livro.find((l) => l.lineNumber === 2)?.recordId as string;
    await api.http().patch(`/pacientes/${usada}`).set(cab(recepA)).send({ telefone: '11900000032' }).expect(200);
    await api.http().post('/agendamentos').set(cab(recepA)).send({ pacienteId: usada, profissionalId: profissionalA, tipoId: tipoA, data: '2031-03-03', hora: '08:00' }).expect(201);
    const r = await api.http().post(`/importacoes/${id}/desfazer`).set(cab(adminA)).send({});
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ codigo: 'importacao_em_uso', motivos: { alterado_depois: 1, agenda_nova: 1, em_atendimento: 0, financeiro: 0 } });
    expect(JSON.stringify(r.body)).not.toContain(usada);
    // Nada foi apagado e o lote segue aplicado.
    const [lote] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(importBatches).where(eq(importBatches.id, id)));
    expect(lote?.status).toBe('aplicado');
    // Nem a função do banco desfaz (defesa em profundidade).
    await expect(withTenant(api.db.db, clinicaA, (tx) => tx.execute(sql`select app_undo_import_batch(${id}::uuid)`), adminA.userId)).rejects.toThrow();
  });
});

describe('V1 do #66: o desfazer só apaga o que nasceu com a marca do lote (SQL injetado no livro não apaga paciente antigo)', () => {
  it('livro forjado e marca forjada são recusados; aplicar + desfazer mantém o paciente antigo e a agenda dele', async () => {
    const antigo = ((await api.http().post('/pacientes').set(cab(recepA)).send({ nome: 'Paciente Antigo Ficticio', telefone: '11900000070' }).expect(201)).body as { id: string }).id;
    const agAntigo = ((await api.http().post('/agendamentos').set(cab(recepA)).send({ pacienteId: antigo, profissionalId: profissionalA, tipoId: tipoA, data: '2031-04-04', hora: '10:00' }).expect(201)).body as { id: string }).id;
    const { id, sim } = await ateSimular(adminA, 'pacientes', 'nome;telefone\nImportada V1 Ficticia;11900000071\n', { nome: 0, telefone: 1 });

    // 1. SQL injetado (até como admin) põe o paciente antigo e o agendamento dele no livro do lote em aplicação: recusado.
    for (const s of [adminA, recepA]) {
      for (const [entity, recordId] of [['patient', antigo], ['appointment', agAntigo]] as const) {
        await expect(
          withTenant(api.db.db, clinicaA, (tx) => tx.insert(importBatchRecords).values({ tenantId: clinicaA, batchId: id, entity, recordId, lineNumber: 2 }), s.userId),
        ).rejects.toThrow();
      }
      // 2. Nem marcar o paciente/agendamento antigo com o lote (a marca é imutável e só nasce no INSERT).
      await expect(withTenant(api.db.db, clinicaA, (tx) => tx.update(patients).set({ importBatchId: id }).where(eq(patients.id, antigo)), s.userId)).rejects.toThrow();
      await expect(withTenant(api.db.db, clinicaA, (tx) => tx.update(appointments).set({ importBatchId: id }).where(eq(appointments.id, agAntigo)), s.userId)).rejects.toThrow();
    }
    // 3. Paciente NOVO com a marca, criado fora do aplicar por quem não é admin: recusado.
    await expect(
      withTenant(api.db.db, clinicaA, (tx) => tx.insert(patients).values({ tenantId: clinicaA, displayName: 'Intruso', importBatchId: id }), recepA.userId),
    ).rejects.toThrow();

    await aplicar(adminA, id, sim.resumoHash).expect(200);
    const marcados = await withTenant(api.db.db, clinicaA, (tx) => tx.select({ id: patients.id }).from(patients).where(eq(patients.importBatchId, id)));
    expect(marcados).toHaveLength(1);
    // Depois de aplicado, a marca não se tira nem se troca.
    await expect(withTenant(api.db.db, clinicaA, (tx) => tx.update(patients).set({ importBatchId: null }).where(eq(patients.id, marcados[0]!.id)), adminA.userId)).rejects.toThrow();

    const d = await api.http().post(`/importacoes/${id}/desfazer`).set(cab(adminA)).send({});
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    const ainda = await withTenant(api.db.db, clinicaA, (tx) => tx.select({ id: patients.id }).from(patients).where(eq(patients.id, antigo)));
    expect(ainda).toHaveLength(1);
    const agAinda = await withTenant(api.db.db, clinicaA, (tx) => tx.select({ id: appointments.id }).from(appointments).where(eq(appointments.id, agAntigo)));
    expect(agAinda).toHaveLength(1);
    expect(await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(patients).where(eq(patients.id, marcados[0]!.id)))).toHaveLength(0);
  });
});

describe('R1 do #66: o plano aprovado fica amarrado ao mapeamento e ao arquivo', () => {
  it('UPDATE direto do mapeamento mantendo a simulação é recusado; não admin não altera o lote; remapear zera a simulação', async () => {
    const { id, sim } = await ateSimular(adminA, 'pacientes', 'nome;nome social;telefone\nNome R1 Ficticio;Social R1 Ficticio;11900000080\n', { nome: 0, nomeSocial: 1, telefone: 2 });
    const trocado = { nome: 1, nomeSocial: 0, telefone: 2 };
    // Admin (SQL injetado) troca nome <-> nome social e deixa o lote simulado com o mesmo hash: 42501.
    await expect(
      withTenant(api.db.db, clinicaA, (tx) => tx.update(importBatches).set({ columnMapping: trocado }).where(eq(importBatches.id, id)), adminA.userId),
    ).rejects.toThrow();
    // Quem não é admin não altera nada no lote (nem o hash, nem a situação).
    for (const s of [recepA, profA, finA]) {
      await expect(
        withTenant(api.db.db, clinicaA, (tx) => tx.update(importBatches).set({ simulationHash: 'b'.repeat(64) }).where(eq(importBatches.id, id)), s.userId),
      ).rejects.toThrow();
    }
    // Remapear pela API volta a "recebido" e zera a simulação; simular de novo dá outro hash e o antigo não aplica.
    await api.http().put(`/importacoes/${id}/mapeamento`).set(cab(adminA)).send({ mapeamento: trocado }).expect(200);
    await api.http().post(`/importacoes/${id}/validar`).set(cab(adminA)).send({}).expect(200);
    const nova = await api.http().post(`/importacoes/${id}/simular`).set(cab(adminA)).send({}).expect(200);
    expect((nova.body as { resumoHash: string }).resumoHash).not.toBe(sim.resumoHash);
    expect((await aplicar(adminA, id, sim.resumoHash)).body).toMatchObject({ codigo: 'simulacao_nao_aprovada' });
  });
});

describe('R6 do #66: arquivo de outra clínica', () => {
  it('aplicar exige confirmar a clínica de origem (nome ou CNPJ); o banco recusa aplicar sem ela e a confirmação não muda', async () => {
    const { id, sim } = await ateSimular(adminA, 'pacientes', 'nome;telefone\nOrigem R6 Ficticia;11900000085\n', { nome: 0, telefone: 1 });
    expect((await api.http().post(`/importacoes/${id}/aplicar`).set(cab(adminA)).send({ resumoHash: sim.resumoHash })).status).toBe(400);
    expect((await aplicar(adminA, id, sim.resumoHash, 'Outra Clinica Qualquer')).body).toMatchObject({ codigo: 'clinica_nao_confirmada' });
    expect((await aplicar(adminA, id, sim.resumoHash, nomes.get(clinicaB))).body).toMatchObject({ codigo: 'clinica_nao_confirmada' });
    // Direto no banco, sem a confirmação: recusado (mesmo como admin).
    await expect(
      withTenant(api.db.db, clinicaA, (tx) =>
        tx.update(importBatches).set({ status: 'aplicado', appliedAt: sql`now()`, appliedBy: adminA.userId }).where(eq(importBatches.id, id)), adminA.userId),
    ).rejects.toThrow();
    // CNPJ da clínica (configuração do financeiro), com pontuação: aceito; nome em caixa/acentos diferentes também.
    await api.http().put('/financeiro/configuracao').set(cab(adminA)).send({ emitenteCnpj: '00.000.000/0001-91' }).expect(200);
    expect((await aplicar(adminA, id, sim.resumoHash, '11.111.111/0001-91')).body).toMatchObject({ codigo: 'clinica_nao_confirmada' });
    const r = await aplicar(adminA, id, sim.resumoHash, '00000000000191');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // Nome em caixa e espaços diferentes também confirma (outro lote).
    const outro = await ateSimular(adminA, 'pacientes', 'nome;telefone\nOrigem R6b Ficticia;11900000086\n', { nome: 0, telefone: 1 });
    expect((await aplicar(adminA, outro.id, outro.sim.resumoHash, `  ${nomes.get(clinicaA)?.toUpperCase()} `)).status).toBe(200);
    expect((r.body as { origemConfirmadaEm: string | null }).origemConfirmadaEm).not.toBeNull();
    await expect(
      withTenant(api.db.db, clinicaA, (tx) => tx.update(importBatches).set({ originConfirmedBy: randomUUID() }).where(eq(importBatches.id, id)), adminA.userId),
    ).rejects.toThrow();
  });

  it('V2: a simulação responde exatamente igual com e sem coincidência de CPF em outra clínica (nenhum sinal entre controladoras)', async () => {
    const cpfs = [0, 1, 2, 3, 4, 5].map((i) => CPF(200 + i));
    const csvA = ['nome;cpf;telefone', ...cpfs.map((c, i) => `Paciente A${i} Ficticio;${c};1190000021${i}`), `Propria 1 Ficticia;${CPF(210)};11900000220`].join('\n');
    const dryRuns = () =>
      withTenant(api.db.db, clinicaA, async (tx) =>
        (await tx.select().from(auditLog).where(and(eq(auditLog.tenantId, clinicaA), eq(auditLog.scope, 'import_batches'))))
          .map((l) => l.metadata as Record<string, unknown>)
          .filter((m) => m.op === 'dry_run' && m.import_batch_id === a.id),
      );

    // 1) SEM coincidência: nenhum dos CPFs existe em outra clínica.
    const a = await ateSimular(adminA, 'pacientes', csvA, { nome: 0, cpf: 1, telefone: 2 });
    const semCoincidencia = a.sim;

    // 2) B importa (e aplica) os MESMOS CPFs; A simula de novo o MESMO lote.
    const csvB = ['nome;cpf;telefone', ...cpfs.map((c, i) => `Paciente B${i} Ficticio;${c};1190000020${i}`)].join('\n');
    const b = await ateSimular(adminB, 'pacientes', csvB, { nome: 0, cpf: 1, telefone: 2 });
    await aplicar(adminB, b.id, b.sim.resumoHash).expect(200);
    const com = await api.http().post(`/importacoes/${a.id}/simular`).set(cab(adminA)).send({});
    expect(com.status, JSON.stringify(com.body)).toBe(200);

    // Resposta idêntica, campo a campo (inclusive o hash do plano), e sem nenhum campo sobre outra clínica.
    expect(com.body).toStrictEqual(semCoincidencia);
    expect(JSON.stringify(com.body)).not.toMatch(/outra|other|clinica|clinic/i);
    // A trilha do dry-run também não muda: mesmos campos e valores nas duas rodadas.
    const eventos = await dryRuns();
    expect(eventos).toHaveLength(2);
    expect(eventos[1]).toStrictEqual(eventos[0]);
    expect(Object.keys(eventos[0] as object).sort()).toEqual(['create', 'errors', 'import_batch_id', 'op', 'skip']);

    // A confirmação da clínica de origem (R6 a) continua, e o aplicar funciona com a coincidência.
    expect((await aplicar(adminA, a.id, semCoincidencia.resumoHash, 'Outra Clinica Qualquer')).body).toMatchObject({ codigo: 'clinica_nao_confirmada' });
    await aplicar(adminA, a.id, semCoincidencia.resumoHash).expect(200);
    expect(await contarPacientes(clinicaA)).toBeGreaterThanOrEqual(7);
  });

  it('V2: alerta de CPFs em outra clínica removido do banco (função, tabela e impressões), via 0030', async () => {
    const [r] = await withTenant(api.db.db, clinicaA, (tx) =>
      tx.execute<{ tabela: string | null; funcoes: number }>(sql`
        select to_regclass('public.import_cpf_fingerprints')::text as tabela,
               (select count(*)::int from pg_proc where proname in ('app_import_cpfs_em_outras_clinicas', 'app_import_register_cpf_fingerprints')) as funcoes`),
      adminA.userId);
    expect(r).toMatchObject({ tabela: null, funcoes: 0 });
  });

  it('catálogo: toda FK para patients/appointments é RESTRICT/NO ACTION ou a tabela está em app_import_batch_blockers (desfazer nunca apaga em cascata o que veio depois)', async () => {
    const fks = await withTenant(api.db.db, clinicaA, (tx) =>
      tx.execute<{ conname: string; tabela: string; alvo: string; ondelete: string }>(sql`
        select c.conname, c.conrelid::regclass::text as tabela, c.confrelid::regclass::text as alvo, c.confdeltype::text as ondelete
          from pg_constraint c
         where c.contype = 'f' and c.confrelid in ('public.patients'::regclass, 'public.appointments'::regclass)
         order by 2, 1`),
      adminA.userId);
    const [def] = await withTenant(api.db.db, clinicaA, (tx) =>
      tx.execute<{ corpo: string }>(sql`select prosrc as corpo from pg_proc where oid = 'app_import_batch_blockers(uuid)'::regprocedure`), adminA.userId);
    const corpo = def?.corpo ?? '';
    expect(corpo).toContain('package_sessions');
    // Sanidade: o catálogo traz as FK conhecidas (senão o teste passaria vazio).
    expect(fks.map((f) => f.tabela)).toEqual(expect.arrayContaining(['encounters', 'charges', 'package_sessions', 'private_notes']));
    const fora = fks.filter((f) => !['r', 'a'].includes(f.ondelete) && !new RegExp(`\\b${f.tabela}\\b`).test(corpo));
    expect(fora, 'FK em CASCADE/SET NULL fora de app_import_batch_blockers').toEqual([]);
    // Hoje nenhuma é CASCADE/SET NULL (a única, import_cpf_fingerprints, saiu com a 0030).
    expect(fks.filter((f) => !['r', 'a'].includes(f.ondelete))).toEqual([]);
  });

  it('R11 (0035): o runner confere a regra das FK a cada migração; FK nova em CASCADE é recusada e desfeita', async () => {
    // O runner chama a função dentro da transação de cada migração aplicada.
    const runner = readFileSync(join(process.cwd(), 'scripts', 'migrate.mjs'), 'utf8');
    expect(runner).toContain('app_assert_regra_fk_desfazer()');
    // O runtime não executa a função (só o papel de migração).
    const [priv] = await withTenant(api.db.db, clinicaA, (tx) =>
      tx.execute<{ pode: boolean }>(sql`select has_function_privilege('app_user', 'public.app_assert_regra_fk_desfazer()', 'EXECUTE') as pode`), adminA.userId);
    expect(priv?.pode).toBe(false);
    // Uma "migração" com FK em CASCADE para patients falha na regra (e é desfeita: rollback).
    const migratorUrl = process.env.DATABASE_MIGRATOR_URL;
    if (!migratorUrl) throw new Error('DATABASE_MIGRATOR_URL é obrigatória para o teste da R11');
    const mig = postgres(migratorUrl, { max: 1, onnotice: () => undefined });
    try {
      await mig.unsafe('SELECT public.app_assert_regra_fk_desfazer()');
      const tabela = `r11_fk_teste_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const erro = await mig
        .begin(async (tx) => {
          await tx.unsafe(`CREATE TABLE ${tabela} (tenant_id uuid NOT NULL, patient_id uuid NOT NULL,
            FOREIGN KEY (tenant_id, patient_id) REFERENCES patients (tenant_id, id) ON DELETE CASCADE)`);
          await tx.unsafe('SELECT public.app_assert_regra_fk_desfazer()');
        })
        .then(() => null, (e: unknown) => e as { message?: string });
      expect(erro?.message ?? '').toMatch(/não é RESTRICT/);
      const [ficou] = await mig.unsafe(`SELECT to_regclass('public.${tabela}')::text AS t`);
      expect(ficou?.t ?? null).toBeNull();
    } finally {
      await mig.end({ timeout: 5 });
    }
  });
});

describe('agenda futura', () => {
  it('resolve paciente (CPF ou nome), profissional e tipo; passado, desconhecido e lotado viram divergência; aplica e bloqueia o desfazer após check-in', async () => {
    const pac = ((await api.http().post('/pacientes').set(cab(adminA)).send({ nome: 'Paciente Agenda Ficticia', telefone: '11900000040', cpf: CPF(40) }).expect(201)).body as { id: string }).id;
    await api.http().post('/pacientes').set(cab(adminA)).send({ nome: 'Paciente Por Nome Ficticio', telefone: '11900000041' }).expect(201);
    const amanha = new Date(Date.now() + 86_400_000 - 3 * 3_600_000).toISOString().slice(0, 10).split('-').reverse().join('/');
    const csv = [
      'CPF;Paciente;Data;Hora;Profissional;Tipo',
      `${CPF(40)};;10/10/2031;09:00;prof ficticia import;Sessao Import`,
      `;Paciente Por Nome Ficticio;10/10/2031;09:00;Prof Ficticia Import;sessão import`,
      `${CPF(40)};;10/10/2020;09:00;Prof Ficticia Import;Sessao Import`,
      `${CPF(40)};;11/10/2031;09:00;Prof Inexistente;Sessao Import`,
      `${CPF(99)};;12/10/2031;09:00;Prof Ficticia Import;Sessao Import`,
      `${CPF(40)};;${amanha};23:30;Prof Ficticia Import;Sessao Import`,
    ].join('\n');
    const { id, sim } = await ateSimular(adminA, 'agenda', csv, { cpf: 0, paciente: 1, data: 2, hora: 3, profissional: 4, tipo: 5 });
    const cod = sim.divergencias.map((d) => `${d.linha}:${d.codigo}`);
    expect(cod).toEqual(
      expect.arrayContaining(['3:horario_lotado', '4:horario_no_passado', '5:profissional_nao_encontrado', '6:paciente_nao_encontrado']),
    );
    expect(sim.lote).toMatchObject({ criar: 2, ignorar: 1 });
    const r = await aplicar(adminA, id, sim.resumoHash);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ criados: 2 });
    const ags = await api.http().get(`/agendamentos?de=2031-10-10&ate=2031-10-10&pacienteId=${pac}`).set(cab(adminA)).expect(200);
    expect((ags.body as { itens: unknown[] }).itens).toHaveLength(1);
    // Criados pela regra da agenda: auditoria com o lote.
    const auditados = await withTenant(api.db.db, clinicaA, (tx) =>
      tx.select().from(auditLog).where(and(eq(auditLog.scope, 'appointments'), sql`${auditLog.metadata}->>'import_batch_id' = ${id}`)),
    );
    expect(auditados).toHaveLength(2);
    // Check-in num agendamento importado: desfazer bloqueado (em_atendimento).
    const livro = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(importBatchRecords).where(eq(importBatchRecords.batchId, id)));
    const ultimo = livro.find((l) => l.lineNumber === 7)?.recordId as string;
    await api.http().post(`/agendamentos/${ultimo}/check-in`).set(cab(recepA)).expect(200);
    const d = await api.http().post(`/importacoes/${id}/desfazer`).set(cab(adminA)).send({});
    expect(d.status).toBe(409);
    expect((d.body as { motivos: Record<string, number> }).motivos.em_atendimento).toBeGreaterThan(0);
  });
});

describe('isolamento entre clínicas', () => {
  let loteA: string;

  beforeAll(async () => {
    const r = await enviar(adminA, 'pacientes', 'nome;telefone\nIsolada Ficticia;11900000050\n');
    loteA = (r.body as { id: string }).id;
    await api.http().put(`/importacoes/${loteA}/mapeamento`).set(cab(adminA)).send({ mapeamento: { nome: 0, telefone: 1 } }).expect(200);
    await api.http().post(`/importacoes/${loteA}/validar`).set(cab(adminA)).send({}).expect(200);
  });

  it('pela API: lote de A é 404 para o admin de B em todas as rotas', async () => {
    expect((await api.http().get(`/importacoes/${loteA}`).set(cab(adminB))).status).toBe(404);
    expect((await api.http().get(`/importacoes/${loteA}/divergencias`).set(cab(adminB))).status).toBe(404);
    expect((await api.http().put(`/importacoes/${loteA}/mapeamento`).set(cab(adminB)).send({ mapeamento: { nome: 0, telefone: 1 } })).status).toBe(404);
    expect((await api.http().post(`/importacoes/${loteA}/validar`).set(cab(adminB)).send({})).status).toBe(404);
    expect((await api.http().post(`/importacoes/${loteA}/simular`).set(cab(adminB)).send({})).status).toBe(404);
    expect((await api.http().post(`/importacoes/${loteA}/aplicar`).set(cab(adminB)).send({ resumoHash: 'a'.repeat(64), clinicaConfirmada: 'Qualquer' })).status).toBe(404);
    expect((await api.http().post(`/importacoes/${loteA}/desfazer`).set(cab(adminB)).send({})).status).toBe(404);
    const lista = await api.http().get('/importacoes').set(cab(adminB)).expect(200);
    expect(JSON.stringify(lista.body)).not.toContain(loteA);
  });

  it('pelo RLS: B não lê nem grava nas quatro tabelas do lote de A', async () => {
    await withTenant(api.db.db, clinicaB, async (tx) => {
      expect(await tx.select().from(importBatches).where(eq(importBatches.id, loteA))).toEqual([]);
      expect(await tx.select().from(importRawFiles).where(eq(importRawFiles.batchId, loteA))).toEqual([]);
      expect(await tx.select().from(importIssues).where(eq(importIssues.batchId, loteA))).toEqual([]);
      expect(await tx.select().from(importBatchRecords).where(eq(importBatchRecords.batchId, loteA))).toEqual([]);
    });
    // Gravar apontando para o lote de A, de dentro de B: RLS (WITH CHECK) ou FK composta recusam.
    await expect(
      withTenant(api.db.db, clinicaB, (tx) =>
        tx.insert(importIssues).values({ tenantId: clinicaA, batchId: loteA, run: 1, lineNumber: 2, field: 'nome', code: 'teste', severity: 'erro' }),
      ),
    ).rejects.toThrow();
    await expect(
      withTenant(api.db.db, clinicaB, (tx) =>
        tx.insert(importBatchRecords).values({ tenantId: clinicaB, batchId: loteA, entity: 'patient', recordId: randomUUID(), lineNumber: 2 }),
      ),
    ).rejects.toThrow();
    // A função de expurgo de B não toca o arquivo de A.
    await api.app.get(ImportacaoService).expurgar({ tenantId: clinicaB, userId: adminB.userId as UserId, roles: ['admin'] });
    expect(await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(importRawFiles).where(eq(importRawFiles.batchId, loteA)))).toHaveLength(1);
  });
});

describe('expiração do arquivo bruto (≤ 7 dias)', () => {
  it('o banco recusa expiração acima de 7 dias e lote "no futuro"', async () => {
    const tentar = (criado: string, expira: string) =>
      withTenant(
        api.db.db,
        clinicaA,
        (tx) =>
          tx.insert(importBatches).values({
            tenantId: clinicaA,
            kind: 'pacientes',
            termVersion: TERMO_MIGRACAO_VERSAO,
            termSha256: TERMO_MIGRACAO_SHA256,
            termAcceptedBy: adminA.userId,
            byteSize: 10,
            rowCount: 1,
            columnCount: 1,
            createdBy: adminA.userId,
            createdAt: sql`${sql.raw(criado)}`,
            rawExpiresAt: sql`${sql.raw(expira)}`,
          }),
        adminA.userId,
      );
    await expect(tentar('now()', "now() + interval '8 days'")).rejects.toThrow();
    await expect(tentar("now() + interval '1 day'", "now() + interval '2 days'")).rejects.toThrow();
  });

  it('a função de expurgo apaga o vencido, marca o lote expirado com evidência, é idempotente e poupa o que não venceu', async () => {
    const cipher = api.app.get<FieldCipher<TenantTx>>(FIELD_CIPHER);
    const vencido = randomUUID();
    await withTenant(
      api.db.db,
      clinicaA,
      async (tx) => {
        await tx.insert(importBatches).values({
          id: vencido,
          tenantId: clinicaA,
          kind: 'pacientes',
          termVersion: TERMO_MIGRACAO_VERSAO,
          termSha256: TERMO_MIGRACAO_SHA256,
          termAcceptedBy: adminA.userId,
          termAcceptedAt: sql`now() - interval '8 days'`,
          byteSize: 30,
          rowCount: 1,
          columnCount: 2,
          createdBy: adminA.userId,
          createdAt: sql`now() - interval '8 days'`,
          rawExpiresAt: sql`now() - interval '1 day'`,
        });
        await tx.insert(importRawFiles).values({
          batchId: vencido,
          tenantId: clinicaA,
          contentEnc: await cipher.encrypt(tx, { tenantId: clinicaA, table: 'import_raw_files', column: 'content', rowId: vencido }, Buffer.from('nome;telefone\nVencida;11900000060\n')),
          sha256: 'a'.repeat(64),
          createdAt: sql`now() - interval '8 days'`,
          expiresAt: sql`now() - interval '1 day'`,
        });
      },
      adminA.userId,
    );
    const pendentesAntes = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(importRawFiles));
    expect(pendentesAntes.some((b) => b.batchId === vencido)).toBe(true);
    const servico = api.app.get(ImportacaoService);
    const ctx = { tenantId: clinicaA, userId: adminA.userId as UserId, roles: ['admin'] };
    expect(await servico.expurgar(ctx)).toBe(1);
    expect(await servico.expurgar(ctx)).toBe(0);
    const [lote] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(importBatches).where(eq(importBatches.id, vencido)));
    expect(lote).toMatchObject({ status: 'expirado' });
    expect(lote?.rawDiscardedAt).not.toBeNull();
    const depois = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(importRawFiles));
    expect(depois.some((b) => b.batchId === vencido)).toBe(false);
    // Os que não venceram (e não foram aplicados) continuam.
    expect(depois.length).toBe(pendentesAntes.length - 1);
    // Expirado não segue o fluxo.
    const v = await api.http().post(`/importacoes/${vencido}/validar`).set(cab(adminA)).send({});
    expect(v.status).toBe(409);
    expect(v.body).toMatchObject({ codigo: 'lote_expirado' });
  });
});

describe('R2 do #66: rotina diária de descarte (job do sistema, todas as clínicas da lista)', () => {
  it('apaga o vencido de cada clínica, sem usuário, é idempotente, audita como sistema e não deixa atraso', async () => {
    const cipher = api.app.get<FieldCipher<TenantTx>>(FIELD_CIPHER);
    const vencidoHaDias = async (t: TenantId, admin: Sessao) => {
      const id = randomUUID();
      await withTenant(
        api.db.db,
        t,
        async (tx) => {
          await cipher.provisionTenant(tx, t, admin.userId).catch(() => undefined);
          await tx.insert(importBatches).values({
            id, tenantId: t, kind: 'pacientes', termVersion: TERMO_MIGRACAO_VERSAO, termSha256: TERMO_MIGRACAO_SHA256, termAcceptedBy: admin.userId,
            termAcceptedAt: sql`now() - interval '9 days'`, byteSize: 30, rowCount: 1, columnCount: 2, createdBy: admin.userId,
            createdAt: sql`now() - interval '9 days'`, rawExpiresAt: sql`now() - interval '2 days'`,
          });
          await tx.insert(importRawFiles).values({
            batchId: id, tenantId: t,
            contentEnc: await cipher.encrypt(tx, { tenantId: t, table: 'import_raw_files', column: 'content', rowId: id }, Buffer.from('nome;telefone\nX;11900000090\n')),
            sha256: 'c'.repeat(64), createdAt: sql`now() - interval '9 days'`, expiresAt: sql`now() - interval '2 days'`,
          });
        },
        admin.userId,
      );
      return id;
    };
    const emA = await vencidoHaDias(clinicaA, adminA);
    const emB = await vencidoHaDias(clinicaB, adminB);
    const servico = api.app.get(ImportacaoService);
    const r1 = await servico.expurgoDiario([clinicaA, clinicaB]);
    expect(r1.clinicas).toBe(2);
    expect(r1.arquivosDescartados).toBeGreaterThanOrEqual(2);
    expect(r1).toMatchObject({ atrasados: 0, alarme: false, clinicasComAtraso: [] });
    expect(await servico.expurgoDiario([clinicaA, clinicaB])).toMatchObject({ arquivosDescartados: 0, atrasados: 0, alarme: false });
    for (const [t, id] of [[clinicaA, emA], [clinicaB, emB]] as const) {
      const [lote] = await withTenant(api.db.db, t, (tx) => tx.select().from(importBatches).where(eq(importBatches.id, id)));
      expect(lote).toMatchObject({ status: 'expirado' });
      expect(lote?.rawDiscardedAt).not.toBeNull();
      expect(await withTenant(api.db.db, t, (tx) => tx.select().from(importRawFiles).where(eq(importRawFiles.batchId, id)))).toHaveLength(0);
    }
    const trilha = await withTenant(api.db.db, clinicaB, (tx) =>
      tx.select().from(auditLog).where(and(eq(auditLog.scope, 'import_batches'), eq(auditLog.actorKind, 'sistema'))),
    );
    expect(trilha.map((l) => (l.metadata as { op?: string }).op)).toContain('raw_discarded');
  });

  it('em produção o importador nasce desligado (flag); fora dela, ligado', () => {
    expect(loadImportacaoConfig({ NODE_ENV: 'production' }).habilitado).toBe(false);
    expect(loadImportacaoConfig({ NODE_ENV: 'production', IMPORTADOR_HABILITADO: 'true' }).habilitado).toBe(true);
    expect(loadImportacaoConfig({ NODE_ENV: 'test' }).habilitado).toBe(true);
    expect(loadImportacaoConfig({ NODE_ENV: 'test', IMPORTADOR_HABILITADO: 'false' }).habilitado).toBe(false);
    expect(() => loadImportacaoConfig({ IMPORTADOR_HABILITADO: 'sim' })).toThrow();
  });
});

describe('auditoria sem conteúdo', () => {
  it('a trilha da clínica registra cada etapa do importador sem nome, CPF, telefone nem fórmula', async () => {
    const linhas = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(auditLog).where(eq(auditLog.scope, 'import_batches')));
    const ops = new Set(linhas.map((l) => String((l.metadata as Record<string, string | undefined>).op ?? l.action)));
    for (const op of ['create', 'map', 'validate', 'dry_run', 'apply', 'undo', 'report']) expect(ops.has(op), op).toBe(true);
    const tudo = JSON.stringify(await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(auditLog)));
    for (const proibido of ['Ficticia', 'Ficticio', CPF(1), CPF(40), '11900000011', 'HYPERLINK']) expect(tudo).not.toContain(proibido);
  });
});
