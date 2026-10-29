/**
 * Importador — responsáveis no lote de pacientes (R5 do parecer do importador, migração 0048) contra
 * Postgres REAL: dry-run que não grava e mostra os avisos; aplicar que cria pessoa + vínculo pelas regras do
 * cadastro (só menor, ou curatela com decisão e escopo; marca clínica nunca ligada; pagador só de menor);
 * deduplicação por CPF dentro da clínica (irmãos e pessoa já cadastrada); marca imutável do lote no banco;
 * desfazer que apaga só o que o lote criou (pessoa que já existia fica, com o histórico) e os motivos de
 * bloqueio novos; isolamento entre clínicas. Dados 100% fictícios.
 */
import type { TenantId, UserId } from '@plataforma/shared';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditLog,
  guardians,
  importBatchRecords,
  importBatches,
  patientCpfIndexKeys,
  patientGuardianHistory,
  patientGuardians,
  patients,
  payments,
  tenants,
} from '../src/db/schema';
import { withTenant, type TenantTx } from '../src/db/tenant-transaction';
import { FIELD_CIPHER } from '../src/modules/crypto/crypto.module';
import type { FieldCipher } from '../src/modules/crypto/field-cipher';
import { TERMO_MIGRACAO_VERSAO } from '../src/modules/imports/importacao-regras';
import { PatientsService } from '../src/modules/patients/patients.service';
import { cab, cpfFicticio, subirApi, type ApiDeTeste } from './apoio-api';

type Sessao = { Authorization: string; userId: string };

let api: ApiDeTeste;
let clinicaA: TenantId;
let clinicaB: TenantId;
let adminA: Sessao;
let adminB: Sessao;
let recepA: Sessao;
const nomes = new Map<string, string>();

/** CPFs fictícios (prefixo 000, faixa não emitida), em faixa própria desta suíte. */
const CPF = (n: number) => cpfFicticio(740_000 + n);

/** Nascimento de menor e de adulto relativos a hoje (a suíte não envelhece). */
const anoAtual = new Date().getUTCFullYear();
const MENOR = `01/01/${anoAtual - 8}`;
const MENOR2 = `01/01/${anoAtual - 6}`;
const ADULTO = `01/01/${anoAtual - 40}`;

const MAPA = {
  nome: 0,
  telefone: 1,
  nascimento: 2,
  responsavelNome: 3,
  responsavelCpf: 4,
  responsavelTelefone: 5,
  responsavelTipo: 6,
  responsavelPagador: 7,
  responsavelCuratelaReferencia: 8,
  responsavelCuratelaEscopo: 9,
};
const CAB = 'Nome;Celular;Nascimento;Responsavel;CPF do responsavel;Telefone do responsavel;Parentesco;Pagador;Decisao judicial;Escopo da curatela';

type Sim = {
  resumoHash: string;
  lote: { criar: number; ignorar: number };
  responsaveis: { vinculos: number; pessoasNovas: number; pessoasJaCadastradas: number; pagadores: number };
  divergencias: { linha: number; campo: string; codigo: string; gravidade: string }[];
};

async function ateSimular(s: Sessao, csv: string, mapeamento: Record<string, number> = MAPA) {
  const r = await api.http().post(`/importacoes?tipo=pacientes&termo=${TERMO_MIGRACAO_VERSAO}`).set(cab(s)).set('Content-Type', 'text/csv; charset=utf-8').send(csv);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const id = (r.body as { id: string }).id;
  const m = await api.http().put(`/importacoes/${id}/mapeamento`).set(cab(s)).send({ mapeamento });
  expect(m.status, JSON.stringify(m.body)).toBe(200);
  const v = await api.http().post(`/importacoes/${id}/validar`).set(cab(s)).send({});
  expect(v.status, JSON.stringify(v.body)).toBe(200);
  const sim = await api.http().post(`/importacoes/${id}/simular`).set(cab(s)).send({});
  expect(sim.status, JSON.stringify(sim.body)).toBe(200);
  return { id, sim: sim.body as Sim };
}

function aplicar(s: Sessao, id: string, resumoHash: string, clinica?: TenantId) {
  const t = clinica ?? (s === adminB ? clinicaB : clinicaA);
  return api.http().post(`/importacoes/${id}/aplicar`).set(cab(s)).send({ resumoHash, clinicaConfirmada: nomes.get(t) });
}

const desfazer = (s: Sessao, id: string) => api.http().post(`/importacoes/${id}/desfazer`).set(cab(s)).send({});

async function pacienteDaLinha(t: TenantId, lote: string, linha: number): Promise<string> {
  const [r] = await withTenant(api.db.db, t, (tx) =>
    tx.select().from(importBatchRecords).where(and(eq(importBatchRecords.batchId, lote), eq(importBatchRecords.lineNumber, linha))),
  );
  return r?.recordId as string;
}

const vinculosDoLote = (t: TenantId, lote: string) =>
  withTenant(api.db.db, t, (tx) => tx.select().from(patientGuardians).where(eq(patientGuardians.importBatchId, lote)));
const pessoasDoLote = (t: TenantId, lote: string) => withTenant(api.db.db, t, (tx) => tx.select().from(guardians).where(eq(guardians.importBatchId, lote)));
const contarPessoas = (t: TenantId) => withTenant(api.db.db, t, async (tx) => (await tx.select({ n: sql<number>`count(*)::int` }).from(guardians))[0]?.n ?? -1);
const contarVinculos = (t: TenantId) => withTenant(api.db.db, t, async (tx) => (await tx.select({ n: sql<number>`count(*)::int` }).from(patientGuardians))[0]?.n ?? -1);

/** Responsável criado pelo CADASTRO (antes do lote), num paciente adulto já existente. */
async function responsavelDoCadastro(s: Sessao, cpf: string, nome: string): Promise<{ pacienteId: string; vinculoId: string; responsavelId: string }> {
  const pacienteId = ((await api.http().post('/pacientes').set(cab(s)).send({ nome: `Paciente de ${nome}`, telefone: '11900000500' }).expect(201)).body as { id: string }).id;
  const r = await api.http().post(`/pacientes/${pacienteId}/responsaveis`).set(cab(s)).send({ nome, cpf, tipo: 'representante', pagador: false });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const b = r.body as { id: string; responsavelId: string };
  return { pacienteId, vinculoId: b.id, responsavelId: b.responsavelId };
}

beforeAll(async () => {
  api = await subirApi();
  clinicaA = await api.novaClinica();
  clinicaB = await api.novaClinica();
  for (const t of [clinicaA, clinicaB]) {
    const [l] = await withTenant(api.db.db, t, (tx) => tx.select({ nome: tenants.displayName }).from(tenants));
    nomes.set(t, l?.nome as string);
  }
  adminA = await api.membro(clinicaA, api.sessao(clinicaA, 'admin'), 'admin');
  adminB = await api.membro(clinicaB, api.sessao(clinicaB, 'admin'), 'admin');
  recepA = await api.membro(clinicaA, api.sessao(clinicaA, 'recepcao'), 'recepcao');
});

afterAll(async () => {
  await api?.fechar();
});

describe('dry-run, aplicar e desfazer com responsáveis', () => {
  let lote: string;
  let existente: { pacienteId: string; vinculoId: string; responsavelId: string };
  let historicoDoExistente: number;

  it('dry-run: avisos por linha, contagens do responsável e NADA gravado em guardians/patient_guardians', async () => {
    existente = await responsavelDoCadastro(adminA, CPF(1), 'Avo Ja Cadastrado Ficticio');
    historicoDoExistente = (
      await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(patientGuardianHistory).where(eq(patientGuardianHistory.guardianId, existente.responsavelId)))
    ).length;
    const csv = [
      CAB,
      `Irmao Um Ficticio;11900000101;${MENOR};Mae Ficticia;${CPF(2)};11900000191;mae;sim;;`, // 2: pessoa nova + pagador
      `Irmao Dois Ficticio;11900000102;${MENOR2};Mae Ficticia;${CPF(2)};;mae;nao;;`, // 3: mesma pessoa (irmãos)
      `Neto Ficticio;11900000103;${MENOR};Avo Ja Cadastrado Ficticio;${CPF(1)};;tutor;;;`, // 4: pessoa já cadastrada
      `Curatelado Ficticio;11900000104;${ADULTO};Curadora Ficticia;${CPF(3)};;curadora;sim;Proc 0000001-00 fict;Atos patrimoniais`, // 5
      `Adulto Ficticio;11900000105;${ADULTO};Pai Ficticio;${CPF(4)};;pai;;;`, // 6: adulto sem curatela
      `Curatela Sem Decisao;11900000106;${ADULTO};Curador Ficticio;${CPF(5)};;curador;;;`, // 7: sem decisão
      `Menor Sem Resp Ficticio;11900000107;${MENOR};;;;;;;`, // 8
    ].join('\r\n');
    const pessoasAntes = await contarPessoas(clinicaA);
    const vinculosAntes = await contarVinculos(clinicaA);
    const { id, sim } = await ateSimular(adminA, csv);
    lote = id;
    expect(sim.lote).toMatchObject({ criar: 7, ignorar: 0 });
    expect(sim.responsaveis).toEqual({ vinculos: 4, pessoasNovas: 2, pessoasJaCadastradas: 1, pagadores: 1 });
    const cod = sim.divergencias.map((d) => `${d.linha}:${d.campo}:${d.codigo}`);
    expect(cod).toEqual(
      expect.arrayContaining([
        '4:responsavelCpf:responsavel_ja_cadastrado',
        '5:responsavelPagador:pagador_exige_ciencia_do_paciente',
        '6:responsavelTipo:vinculo_exige_menor_ou_curatela',
        '7:responsavelCuratelaReferencia:curatela_sem_decisao',
        '8:nascimento:menor_sem_responsavel',
      ]),
    );
    expect(cod.some((c) => c.startsWith('2:') || c.startsWith('3:'))).toBe(false);
    expect(await contarPessoas(clinicaA)).toBe(pessoasAntes);
    expect(await contarVinculos(clinicaA)).toBe(vinculosAntes);
  });

  it('aplicar cria pessoa uma vez por CPF, reaproveita a já cadastrada, marca o lote e nunca liga a informação clínica', async () => {
    const [b] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(importBatches).where(eq(importBatches.id, lote)));
    const r = await aplicar(adminA, lote, b?.simulationHash as string);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const vinculos = await vinculosDoLote(clinicaA, lote);
    const pessoas = await pessoasDoLote(clinicaA, lote);
    expect(vinculos).toHaveLength(4);
    expect(pessoas).toHaveLength(2);
    expect(vinculos.every((v) => !v.receivesClinicalInfo && v.clinicalInfoDecidedBy === null && v.clinicalInfoBasisEnc === null)).toBe(true);
    // Irmãos: a mesma pessoa nos dois vínculos.
    const [l2, l3, l4, l5] = (await Promise.all([2, 3, 4, 5].map((l) => pacienteDaLinha(clinicaA, lote, l)))) as [string, string, string, string];
    const porPaciente = new Map(vinculos.map((v) => [v.patientId, v]));
    expect(porPaciente.get(l2)?.guardianId).toBe(porPaciente.get(l3)?.guardianId);
    expect(porPaciente.get(l2)).toMatchObject({ kind: 'pai_mae', isPayer: true });
    expect(porPaciente.get(l3)).toMatchObject({ kind: 'pai_mae', isPayer: false });
    // Pessoa já cadastrada: reaproveitada SEM a marca do lote; só o vínculo é do lote.
    expect(porPaciente.get(l4)).toMatchObject({ kind: 'tutor', guardianId: existente.responsavelId });
    const [pessoaExistente] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(guardians).where(eq(guardians.id, existente.responsavelId)));
    expect(pessoaExistente?.importBatchId).toBeNull();
    // Curatela com a decisão e o escopo cifrados; o pagador de adulto não veio.
    const cur = porPaciente.get(l5);
    expect(cur).toMatchObject({ kind: 'curador', isPayer: false });
    expect(cur?.courtDecisionRefEnc?.startsWith('v1:')).toBe(true);
    expect(cur?.curatorshipScopeEnc?.startsWith('v1:')).toBe(true);
    expect(pessoas.every((p) => p.cpfEnc?.startsWith('v1:') && p.nameEnc?.startsWith('v1:'))).toBe(true);
    // O cadastro mostra o responsável do menor (pendência resolvida) e o histórico nasceu pelos gatilhos.
    const lista = await api.http().get(`/pacientes/${l2}/responsaveis`).set(cab(adminA)).expect(200);
    expect(lista.body).toMatchObject({ menorDeIdade: true, pendencias: [] });
    expect((lista.body as { itens: { nome: string; recebeInformacaoClinica: boolean }[] }).itens[0]).toMatchObject({ nome: 'Mae Ficticia', recebeInformacaoClinica: false });
    const hist = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(patientGuardianHistory).where(inArray(patientGuardianHistory.linkId, vinculos.map((v) => v.id))));
    expect(hist.map((h) => h.event)).toEqual(Array(4).fill('vinculo_criado'));
    // Trilha só com contagens (sem CPF nem nome).
    const trilha = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(auditLog).where(eq(auditLog.scope, 'patient_guardians')).orderBy(sql`seq`));
    const doLote = trilha.filter((t) => (t.metadata as Record<string, unknown>).import_batch_id === lote);
    expect(doLote).toHaveLength(1);
    expect(doLote[0]?.metadata).toMatchObject({ op: 'import', links_created: 4, guardians_created: 2, existing_guardians: 1, payers: 1 });
    expect(JSON.stringify(trilha)).not.toContain(CPF(2));
    expect(JSON.stringify(trilha)).not.toContain('Mae Ficticia');
  });

  it('o banco: marca do lote imutável; runtime não apaga pessoa nem vínculo (nem com a marca do desfazer)', async () => {
    const [v] = await vinculosDoLote(clinicaA, lote);
    const [p] = await pessoasDoLote(clinicaA, lote);
    await expect(withTenant(api.db.db, clinicaA, (tx) => tx.update(patientGuardians).set({ importBatchId: null, updatedBy: adminA.userId }).where(eq(patientGuardians.id, v?.id as string)), adminA.userId)).rejects.toThrow();
    await expect(withTenant(api.db.db, clinicaA, (tx) => tx.update(guardians).set({ importBatchId: null, updatedBy: adminA.userId }).where(eq(guardians.id, p?.id as string)), adminA.userId)).rejects.toThrow();
    // Pessoa antiga não ganha a marca do lote.
    await expect(withTenant(api.db.db, clinicaA, (tx) => tx.update(guardians).set({ importBatchId: lote, updatedBy: adminA.userId }).where(eq(guardians.id, existente.responsavelId)), adminA.userId)).rejects.toThrow();
    await expect(
      withTenant(api.db.db, clinicaA, async (tx) => {
        await tx.execute(sql`select set_config('app.import_undo_batch', ${lote}, true)`);
        await tx.delete(guardians).where(eq(guardians.id, p?.id as string));
      }, adminA.userId),
    ).rejects.toThrow();
    expect(await pessoasDoLote(clinicaA, lote)).toHaveLength(2);
  });

  it('desfazer apaga só o que o lote criou: pessoa já cadastrada fica, com o vínculo e o histórico dela', async () => {
    const r = await desfazer(adminA, lote);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ status: 'desfeito' });
    expect(await vinculosDoLote(clinicaA, lote)).toHaveLength(0);
    expect(await pessoasDoLote(clinicaA, lote)).toHaveLength(0);
    const [pessoa] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(guardians).where(eq(guardians.id, existente.responsavelId)));
    expect(pessoa?.cpfEnc).toBeTruthy();
    const [vinculo] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(patientGuardians).where(eq(patientGuardians.id, existente.vinculoId)));
    expect(vinculo).toMatchObject({ endedAt: null, patientId: existente.pacienteId });
    const hist = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(patientGuardianHistory).where(eq(patientGuardianHistory.guardianId, existente.responsavelId)));
    expect(hist).toHaveLength(historicoDoExistente);
    const pacientesDoLote = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(patients).where(eq(patients.importBatchId, lote)));
    expect(pacientesDoLote).toHaveLength(0);
    const [ev] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.scope, 'import_batches'), sql`${auditLog.metadata}->>'op' = 'undo'`, sql`${auditLog.metadata}->>'import_batch_id' = ${lote}`)).orderBy(sql`seq`));
    expect(ev?.metadata).toMatchObject({ patients: 7, guardian_links: 4, guardians: 2 });
  });
});

describe('desfazer bloqueado por uso do responsável (motivos só em contagem)', () => {
  it('pessoa do lote vinculada a paciente de fora: responsavel_em_uso; vínculo novo no paciente do lote: responsavel_novo', async () => {
    const csv = [CAB, `Filha Ficticia;11900000201;${MENOR};Pai Bloqueio Ficticio;${CPF(10)};;pai;;;`, `Filho Ficticio;11900000202;${MENOR};Mae Bloqueio Ficticia;${CPF(11)};;mae;;;`].join('\n');
    const { id, sim } = await ateSimular(adminA, csv);
    expect((await aplicar(adminA, id, sim.resumoHash)).status).toBe(200);
    const [p1] = await pessoasDoLote(clinicaA, id);
    const fora = ((await api.http().post('/pacientes').set(cab(recepA)).send({ nome: 'Paciente De Fora Ficticio', telefone: '11900000203' }).expect(201)).body as { id: string }).id;
    await api.http().post(`/pacientes/${fora}/responsaveis`).set(cab(adminA)).send({ responsavelId: p1?.id, tipo: 'representante', pagador: false }).expect(201);
    const filho = await pacienteDaLinha(clinicaA, id, 3);
    await api.http().post(`/pacientes/${filho}/responsaveis`).set(cab(adminA)).send({ nome: 'Tio Cadastro Ficticio', tipo: 'tutor', pagador: false }).expect(201);
    const r = await desfazer(adminA, id);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ codigo: 'importacao_em_uso', motivos: { responsavel_em_uso: 1, responsavel_novo: 1 } });
    expect(JSON.stringify(r.body)).not.toContain(p1?.id as string);
    expect(await vinculosDoLote(clinicaA, id)).toHaveLength(2);
  });

  it('recebimento com o pagador do lote (guardian_payer_link_id): responsavel_em_uso, e nada é apagado', async () => {
    // Financeiro mínimo: profissional PF com perfil fiscal, tipo, caixa aberto.
    const finA = await api.membro(clinicaA, api.sessao(clinicaA, 'financeiro'), 'financeiro');
    const prof = ((await api.http().post('/profissionais').set(cab(adminA)).send({ nome: 'Prof Ficticia Bloqueio', especialidade: 'Fisioterapia' }).expect(201)).body as { id: string }).id;
    const tipo = ((await api.http().post('/tipos-atendimento').set(cab(adminA)).send({ nome: 'Sessao Bloqueio', minutos: 40 }).expect(201)).body as { id: string }).id;
    await api.http().put(`/financeiro/profissionais/${prof}/perfil-fiscal`).set(cab(finA)).send({ cpf: CPF(30) }).expect(200);
    await api.http().post('/financeiro/caixas').set(cab(recepA)).send({ turno: 'unico' }).expect(201);

    const csv = [CAB, `Paga Ficticio;11900000211;${MENOR};Mae Pagadora Ficticia;${CPF(12)};;mae;sim;;`].join('\n');
    const { id, sim } = await ateSimular(adminA, csv);
    expect(sim.responsaveis).toMatchObject({ vinculos: 1, pagadores: 1 });
    expect((await aplicar(adminA, id, sim.resumoHash)).status).toBe(200);
    const paciente = await pacienteDaLinha(clinicaA, id, 2);
    const [vinculo] = await vinculosDoLote(clinicaA, id);
    const ag = await api.http().post('/agendamentos').set(cab(recepA)).send({ pacienteId: paciente, profissionalId: prof, tipoId: tipo, data: '2031-06-02', hora: '09:00', encaixe: true });
    expect(ag.status, JSON.stringify(ag.body)).toBe(201);
    const c = await api.http().post('/financeiro/cobrancas').set(cab(recepA)).send({ agendamentoId: (ag.body as { id: string }).id, valorCentavos: 7000, atendimentoPor: 'pf' });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const p = await api.http().post(`/financeiro/cobrancas/${(c.body as { id: string }).id}/recebimentos`).set(cab(recepA)).send({ forma: 'pix_manual' });
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    const [pg] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(payments).where(eq(payments.id, (p.body as { id: string }).id)), recepA.userId);
    expect(pg?.guardianPayerLinkId).toBe(vinculo?.id);

    const r = await desfazer(adminA, id);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ codigo: 'importacao_em_uso', motivos: { responsavel_em_uso: 1 } });
    expect(JSON.stringify(r.body)).not.toContain(vinculo?.id as string);
    expect(await vinculosDoLote(clinicaA, id)).toHaveLength(1);
    expect(await pessoasDoLote(clinicaA, id)).toHaveLength(1);
  });

  it('convite do portal para o responsável do lote: responsavel_em_uso, e nada é apagado', async () => {
    const csv = [CAB, `Portal Ficticio;11900000221;${MENOR};Pai Portal Ficticio;${CPF(13)};11900000222;pai;;;`].join('\n');
    const { id, sim } = await ateSimular(adminA, csv);
    expect((await aplicar(adminA, id, sim.resumoHash)).status).toBe(200);
    const paciente = await pacienteDaLinha(clinicaA, id, 2);
    const [vinculo] = await vinculosDoLote(clinicaA, id);
    const conv = await api.http().post('/clinica/portal/convites').set(cab(adminA)).send({ pacienteId: paciente, agindoComo: 'responsavel_legal', responsavelId: vinculo?.id });
    expect(conv.status, JSON.stringify(conv.body)).toBe(201);

    const r = await desfazer(adminA, id);
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ codigo: 'importacao_em_uso', motivos: { responsavel_em_uso: 1 } });
    expect(JSON.stringify(r.body)).not.toContain(vinculo?.id as string);
    expect(await vinculosDoLote(clinicaA, id)).toHaveLength(1);
    expect(await pessoasDoLote(clinicaA, id)).toHaveLength(1);
  });
});

describe('aviso de curatela sem data de nascimento (observação da R5, rodada 22)', () => {
  it('o dry-run avisa curatela_sem_data_de_nascimento, sem valor, e o vínculo entra no plano', async () => {
    const csv = [CAB, `Curatelado Sem Data Ficticio;11900000231;;Curador Sem Data Ficticio;${CPF(14)};;curador;;Proc 0000002-00 fict;Atos patrimoniais`].join('\n');
    const { sim } = await ateSimular(adminA, csv);
    expect(sim.responsaveis).toMatchObject({ vinculos: 1 });
    const aviso = sim.divergencias.find((d) => d.codigo === 'curatela_sem_data_de_nascimento');
    expect(aviso).toMatchObject({ linha: 2, campo: 'nascimento', gravidade: 'aviso' });
    expect(JSON.stringify(sim.divergencias)).not.toMatch(/Proc 0000002|Curador Sem Data/);
  });
});

describe('isolamento entre clínicas', () => {
  it('o mesmo CPF na clínica B cria pessoa própria (não reaproveita a da A); B não vê nem desfaz o lote da A', async () => {
    const a = await responsavelDoCadastro(adminA, CPF(20), 'Pessoa Da Clinica A');
    const csv = [CAB, `Menor B Ficticio;11900000301;${MENOR};Pessoa Da Clinica B;${CPF(20)};;mae;sim;;`].join('\n');
    const { id, sim } = await ateSimular(adminB, csv);
    expect(sim.responsaveis).toEqual({ vinculos: 1, pessoasNovas: 1, pessoasJaCadastradas: 0, pagadores: 1 });
    expect(sim.divergencias.map((d) => d.codigo)).not.toContain('responsavel_ja_cadastrado');
    expect((await aplicar(adminB, id, sim.resumoHash)).status).toBe(200);
    const [pB] = await pessoasDoLote(clinicaB, id);
    expect(pB?.id).not.toBe(a.responsavelId);
    // RLS: a clínica A não enxerga a pessoa nem o vínculo da B (e vice-versa).
    expect(await pessoasDoLote(clinicaA, id)).toHaveLength(0);
    expect(await vinculosDoLote(clinicaA, id)).toHaveLength(0);
    const daA = await withTenant(api.db.db, clinicaB, (tx) => tx.select().from(guardians).where(eq(guardians.id, a.responsavelId)));
    expect(daA).toHaveLength(0);
    // Pela API: A não desfaz o lote da B.
    expect((await desfazer(adminA, id)).status).toBe(404);
    // A marca de um lote da B não entra em vínculo da A (FK composta com a clínica).
    await expect(
      withTenant(api.db.db, clinicaA, (tx) =>
        tx.insert(guardians).values({ id: randomUUID(), tenantId: clinicaA, nameEnc: pB?.nameEnc as string, createdBy: adminA.userId, updatedBy: adminA.userId, importBatchId: id }), adminA.userId),
    ).rejects.toThrow();
    // Desfazer da B apaga só o da B; a pessoa da A segue.
    expect((await desfazer(adminB, id)).status).toBe(200);
    const [aindaA] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(guardians).where(and(eq(guardians.id, a.responsavelId), isNull(guardians.discardedAt))));
    expect(aindaA).toBeTruthy();
  });

  it('marca de lote só pelo lote em aplicação, só em paciente do lote e sem marca clínica', async () => {
    // Lote simulado (ainda não aplicado) da A: admin injeta via SQL.
    const { id } = await ateSimular(adminA, [CAB, `Injetado Ficticio;11900000401;${MENOR};Mae Inj Ficticia;${CPF(30)};;mae;;;`].join('\n'));
    const antigo = ((await api.http().post('/pacientes').set(cab(recepA)).send({ nome: 'Antigo Inj Ficticio', telefone: '11900000402' }).expect(201)).body as { id: string }).id;
    const pessoa = randomUUID();
    const [qualquer] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(guardians).limit(1));
    // Recepção não marca nada com o lote.
    await expect(
      withTenant(api.db.db, clinicaA, (tx) =>
        tx.insert(guardians).values({ id: pessoa, tenantId: clinicaA, nameEnc: qualquer?.nameEnc as string, createdBy: recepA.userId, updatedBy: recepA.userId, importBatchId: id }), recepA.userId),
    ).rejects.toThrow();
    // Admin: vínculo do lote em paciente antigo (fora do lote) é recusado.
    await expect(
      withTenant(api.db.db, clinicaA, (tx) =>
        tx.insert(patientGuardians).values({ tenantId: clinicaA, patientId: antigo, guardianId: qualquer?.id as string, kind: 'tutor', validFrom: '2020-01-01', createdBy: adminA.userId, updatedBy: adminA.userId, importBatchId: id }), adminA.userId),
    ).rejects.toThrow();
    // Admin: paciente do lote (aceito pela 0026) + vínculo com a marca clínica ligada: recusado; sem a marca: aceito.
    const pacLote = randomUUID();
    await withTenant(api.db.db, clinicaA, (tx) => tx.insert(patients).values({ id: pacLote, tenantId: clinicaA, displayName: 'Paciente Lote Inj Ficticio', importBatchId: id }), adminA.userId);
    const base = { tenantId: clinicaA, patientId: pacLote, guardianId: qualquer?.id as string, kind: 'tutor' as const, validFrom: '2020-01-01', createdBy: adminA.userId, updatedBy: adminA.userId, importBatchId: id };
    await expect(
      withTenant(api.db.db, clinicaA, (tx) =>
        tx.insert(patientGuardians).values({ ...base, receivesClinicalInfo: true, clinicalInfoDecidedBy: adminA.userId, clinicalInfoBasisEnc: qualquer?.nameEnc as string }), adminA.userId),
    ).rejects.toThrow();
    await withTenant(api.db.db, clinicaA, (tx) => tx.insert(patientGuardians).values(base), adminA.userId);
    expect(await vinculosDoLote(clinicaA, id)).toHaveLength(1);
  });
});

describe('0054: índice cego do CPF nos responsáveis (mesma chave da clínica, domínio guardians.cpf:v1:)', () => {
  let clinicaC: TenantId;
  let clinicaD: TenantId;
  let adminC: Sessao;
  let adminD: Sessao;
  let loteC: string;
  const dedup: { pacienteId: string; vinculoId: string; responsavelId: string }[] = [];
  const ctxC = () => ({ tenantId: clinicaC, userId: adminC.userId as UserId, roles: ['admin'] });
  const servico = () => api.app.get(PatientsService);
  const cipher = () => api.app.get<FieldCipher<TenantTx>>(FIELD_CIPHER);
  const indiceDe = async (t: TenantId, id: string) =>
    (
      await withTenant(api.db.db, t, (tx) =>
        tx.select({ b: guardians.cpfBidx, v: guardians.cpfBidxVersion, em: guardians.updatedAt, por: guardians.updatedBy }).from(guardians).where(eq(guardians.id, id)),
      )
    )[0];
  const historico = async (t: TenantId, id: string) =>
    (await withTenant(api.db.db, t, (tx) => tx.select().from(patientGuardianHistory).where(eq(patientGuardianHistory.guardianId, id)))).length;
  const procurar = (t: TenantId, cpfs: string[]) => withTenant(api.db.db, t, (tx) => servico().indiceCpf.procurarResponsaveis(tx, t, cpfs));
  /** Só as colunas do índice, SEM usuário da sessão (sessão `sistema`, como o job). */
  const gravarIndiceSemUsuario = (t: TenantId, id: string, b: string | null, v: number | null) =>
    withTenant(api.db.db, t, (tx) => tx.update(guardians).set({ cpfBidx: b, cpfBidxVersion: v }).where(eq(guardians.id, id)));

  /** Conta as decifrações de CPF de RESPONSÁVEL durante `fn`. */
  async function contandoDecifracoes<T>(fn: () => Promise<T>): Promise<{ r: T; n: number }> {
    const c = cipher();
    const original = c.decryptString.bind(c);
    let n = 0;
    c.decryptString = (tx, ref, valor) => {
      if (ref.table === 'guardians' && ref.column === 'cpf') n++;
      return original(tx, ref, valor);
    };
    try {
      const r = await fn();
      return { r, n };
    } finally {
      c.decryptString = original;
    }
  }

  beforeAll(async () => {
    clinicaC = await api.novaClinica();
    clinicaD = await api.novaClinica();
    for (const t of [clinicaC, clinicaD]) {
      const [l] = await withTenant(api.db.db, t, (tx) => tx.select({ nome: tenants.displayName }).from(tenants));
      nomes.set(t, l?.nome as string);
    }
    adminC = await api.membro(clinicaC, api.sessao(clinicaC, 'admin'), 'admin');
    adminD = await api.membro(clinicaD, api.sessao(clinicaD, 'admin'), 'admin');
  });

  it('o mesmo CPF dá índice diferente em clínicas diferentes e entre paciente e responsável; alterar o CPF regrava o índice', async () => {
    const cpf = CPF(500);
    const pac = ((await api.http().post('/pacientes').set(cab(adminC)).send({ nome: 'Paciente Indice Ficticio', telefone: '11900000501', cpf }).expect(201)).body as { id: string }).id;
    const emC = await responsavelDoCadastro(adminC, cpf, 'Resp Indice C Ficticio');
    const emD = await responsavelDoCadastro(adminD, cpf, 'Resp Indice D Ficticio');
    const [p] = await withTenant(api.db.db, clinicaC, (tx) => tx.select({ b: patients.cpfBidx, v: patients.cpfBidxVersion }).from(patients).where(eq(patients.id, pac)));
    const c = await indiceDe(clinicaC, emC.responsavelId);
    const d = await indiceDe(clinicaD, emD.responsavelId);
    expect(c?.b).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(d?.b).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Mesma chave (mesma versão) do paciente na clínica, mas outro domínio: outro valor.
    expect(c?.v).toBe(p?.v);
    expect(c?.b).not.toBe(p?.b);
    expect(c?.b).not.toBe(d?.b);
    // Uma tabela de chaves só (a dos pacientes): o responsável não criou chave nova.
    expect(await withTenant(api.db.db, clinicaC, (tx) => tx.select().from(patientCpfIndexKeys))).toHaveLength(1);
    // A clínica D não casa o índice da C (RLS + chave por clínica).
    expect(await withTenant(api.db.db, clinicaD, (tx) => tx.select().from(guardians).where(eq(guardians.cpfBidx, c?.b as string)))).toHaveLength(0);
    expect((await procurar(clinicaD, [cpf])).get(cpf)).toBe(emD.responsavelId);
    // Alterar o CPF pelo cadastro grava o índice novo na mesma escrita; apagar o CPF apaga o índice.
    const novo = CPF(501);
    const alt = await api.http().patch(`/pacientes/${emC.pacienteId}/responsaveis/${emC.vinculoId}`).set(cab(adminC)).send({ cpf: novo });
    expect(alt.status, JSON.stringify(alt.body)).toBe(200);
    const depois = await indiceDe(clinicaC, emC.responsavelId);
    expect(depois?.b).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(depois?.b).not.toBe(c?.b);
    const achados = await procurar(clinicaC, [novo, cpf]);
    expect(achados.get(novo)).toBe(emC.responsavelId);
    expect(achados.has(cpf)).toBe(false);
    // Reenviar o MESMO CPF (tela que manda o formulário inteiro) não regrava nada: o índice continua lá.
    const cifraAntes = (await withTenant(api.db.db, clinicaC, (tx) => tx.select({ e: guardians.cpfEnc }).from(guardians).where(eq(guardians.id, emC.responsavelId))))[0]?.e;
    const igual = await api.http().patch(`/pacientes/${emC.pacienteId}/responsaveis/${emC.vinculoId}`).set(cab(adminC)).send({ cpf: novo, telefone: '11900000502' });
    expect(igual.status, JSON.stringify(igual.body)).toBe(200);
    expect(await indiceDe(clinicaC, emC.responsavelId)).toEqual(depois);
    const cifraDepois = (await withTenant(api.db.db, clinicaC, (tx) => tx.select({ e: guardians.cpfEnc }).from(guardians).where(eq(guardians.id, emC.responsavelId))))[0]?.e;
    expect(cifraDepois).toBe(cifraAntes);
    const sem = await api.http().patch(`/pacientes/${emC.pacienteId}/responsaveis/${emC.vinculoId}`).set(cab(adminC)).send({ cpf: null });
    expect(sem.status, JSON.stringify(sem.body)).toBe(200);
    expect(await indiceDe(clinicaC, emC.responsavelId)).toMatchObject({ b: null, v: null });
  });

  it('dedup do importador: acha a pessoa pelo índice decifrando só a casada; o aplicar grava o índice da pessoa nova', async () => {
    for (let i = 0; i < 4; i++) dedup.push(await responsavelDoCadastro(adminC, CPF(510 + i), `Resp Dedup Ficticio ${i}`));
    const csv = [
      CAB,
      `Menor Dedup Ficticio;11900000511;${MENOR};Resp Dedup Ficticio 2;${CPF(512)};;mae;;;`,
      `Menor Novo Ficticio;11900000512;${MENOR};Resp Novo Ficticio;${CPF(519)};;pai;;;`,
    ].join('\n');
    const { r, n } = await contandoDecifracoes(() => ateSimular(adminC, csv));
    expect(r.sim.responsaveis).toMatchObject({ vinculos: 2, pessoasNovas: 1, pessoasJaCadastradas: 1 });
    expect(r.sim.divergencias).toContainEqual(expect.objectContaining({ linha: 2, campo: 'responsavelCpf', codigo: 'responsavel_ja_cadastrado' }));
    // 4 pessoas com CPF na clínica, todas indexadas: o dry-run decifra só a casada (1), nunca as 4.
    expect(n).toBe(1);
    const ap = await aplicar(adminC, r.id, r.sim.resumoHash, clinicaC);
    expect(ap.status, JSON.stringify(ap.body)).toBe(200);
    loteC = r.id;
    const vinculos = await vinculosDoLote(clinicaC, loteC);
    expect(vinculos.map((v) => v.guardianId)).toContain(dedup[2]?.responsavelId);
    const [nova] = await pessoasDoLote(clinicaC, loteC);
    const ix = await indiceDe(clinicaC, nova?.id as string);
    expect(ix?.b).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(ix?.v).toBe(1);
    expect((await procurar(clinicaC, [CPF(519)])).get(CPF(519))).toBe(nova?.id);
  });

  it('CPF reescrito sem índice: o índice cai para NULL e a busca ainda acha; índice forjado não casa; a exceção da guarda é só do índice', async () => {
    const alvo = await responsavelDoCadastro(adminC, CPF(520), 'Resp Sem Indice Ficticio');
    await withTenant(
      api.db.db,
      clinicaC,
      async (tx) => {
        const novo = await cipher().encrypt(tx, { tenantId: clinicaC, table: 'guardians', column: 'cpf', rowId: alvo.responsavelId }, CPF(521));
        await tx.update(guardians).set({ cpfEnc: novo, updatedBy: adminC.userId }).where(eq(guardians.id, alvo.responsavelId));
      },
      adminC.userId,
    );
    expect(await indiceDe(clinicaC, alvo.responsavelId)).toMatchObject({ b: null, v: null });
    const { r: achados, n } = await contandoDecifracoes(() => procurar(clinicaC, [CPF(521), CPF(520)]));
    expect(achados.get(CPF(521))).toBe(alvo.responsavelId);
    expect(achados.has(CPF(520))).toBe(false);
    // Nenhuma pessoa indexada casou: decifra só a pendente.
    expect(n).toBe(1);

    // Índice forjado (SQL direto copia o índice de outra pessoa): a busca confirma decifrando e não erra a pessoa.
    const outro = await indiceDe(clinicaC, dedup[0]?.responsavelId as string);
    const antes = await indiceDe(clinicaC, alvo.responsavelId);
    const histAntes = await historico(clinicaC, alvo.responsavelId);
    await gravarIndiceSemUsuario(clinicaC, alvo.responsavelId, outro?.b ?? null, outro?.v ?? null);
    expect((await procurar(clinicaC, [CPF(510)])).get(CPF(510))).toBe(dedup[0]?.responsavelId);
    // A UPDATE só do índice passou sem usuário, sem mexer em updated_at/updated_by e sem histórico.
    const forjado = await indiceDe(clinicaC, alvo.responsavelId);
    expect(forjado).toMatchObject({ b: outro?.b, v: outro?.v, por: antes?.por });
    expect(forjado?.em).toEqual(antes?.em);
    expect(await historico(clinicaC, alvo.responsavelId)).toBe(histAntes);
    // Qualquer outra coluna junto com o índice cai nas regras de sempre: sem usuário da sessão, recusado.
    await expect(
      withTenant(api.db.db, clinicaC, (tx) => tx.update(guardians).set({ cpfBidx: null, cpfBidxVersion: null, phoneEnc: null }).where(eq(guardians.id, alvo.responsavelId))),
    ).rejects.toThrow();
    await expect(
      withTenant(api.db.db, clinicaC, (tx) => tx.update(guardians).set({ cpfBidx: null, cpfBidxVersion: null, updatedAt: new Date(0) }).where(eq(guardians.id, alvo.responsavelId))),
    ).rejects.toThrow();
    // Par e formato continuam valendo também na exceção.
    await expect(gravarIndiceSemUsuario(clinicaC, alvo.responsavelId, outro?.b ?? null, null)).rejects.toThrow();
    await expect(gravarIndiceSemUsuario(clinicaC, alvo.responsavelId, 'curto', outro?.v ?? null)).rejects.toThrow();
    // Desfaz o forjado (fica pendente; a reindexação do próximo teste o acerta).
    await gravarIndiceSemUsuario(clinicaC, alvo.responsavelId, null, null);
  });

  it('reindexação (job como `sistema`): responsável na chave nova sem mudar updated_at nem histórico; o desfazer do lote continua funcionando', async () => {
    const [pessoaDoLote] = await pessoasDoLote(clinicaC, loteC);
    const id = pessoaDoLote?.id as string;
    const antes = await indiceDe(clinicaC, id);
    const histAntes = await historico(clinicaC, id);
    const ativa = await withTenant(api.db.db, clinicaC, (tx) => servico().indiceCpf.girarChave(tx, ctxC()), adminC.userId);
    const pendentes = await withTenant(api.db.db, clinicaC, (tx) => servico().indiceCpf.pendentes(tx, clinicaC));
    // Pacientes com CPF (1) + responsáveis com CPF (as 4 do dedup, a reescrita e a do lote).
    expect(pendentes).toBe(1 + 6);
    expect(await servico().reindexarIndiceCpfComoSistema(clinicaC)).toEqual({ reindexados: pendentes, pendentes: 0, chavesDescartadas: 1, chaveDestruida: 0 });
    const depois = await indiceDe(clinicaC, id);
    expect(depois?.v).toBe(ativa);
    expect(depois?.b).not.toBe(antes?.b);
    expect(depois?.em).toEqual(antes?.em);
    expect(depois?.por).toBe(antes?.por);
    expect(await historico(clinicaC, id)).toBe(histAntes);
    expect((await procurar(clinicaC, [CPF(519)])).get(CPF(519))).toBe(id);
    // Trilha só com contagens; a dos responsáveis diferenciada por `table`.
    const trilha = await withTenant(api.db.db, clinicaC, (tx) =>
      tx.select().from(auditLog).where(and(eq(auditLog.actorKind, 'sistema'), sql`${auditLog.metadata}->>'op' = 'cpf_reindex'`)).orderBy(sql`seq`),
    );
    expect(trilha.map((l) => l.metadata)).toEqual([
      { op: 'cpf_reindex', version: ativa, count: 1, pending: 0 },
      { op: 'cpf_reindex', table: 'guardians', version: ativa, count: 6, pending: 0 },
    ]);
    // O desfazer do lote não vê `alterado_depois` por causa da reindexação.
    const bloqueios = await withTenant(api.db.db, clinicaC, (tx) => tx.execute<{ r: Record<string, number> }>(sql`select app_import_batch_blockers(${loteC}::uuid) as r`));
    expect(bloqueios[0]?.r).toMatchObject({ alterado_depois: 0 });
    const d = await desfazer(adminC, loteC);
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(await pessoasDoLote(clinicaC, loteC)).toHaveLength(0);
    expect(await withTenant(api.db.db, clinicaC, (tx) => tx.select().from(guardians).where(eq(guardians.id, dedup[2]?.responsavelId as string)))).toHaveLength(1);
  });

  it('versão com responsável indexado não é destruída (nem pelo serviço, nem por SQL direto)', async () => {
    const indice = servico().indiceCpf;
    const pessoa = await responsavelDoCadastro(adminC, CPF(530), 'Resp Versao Ficticio');
    const velho = await indiceDe(clinicaC, pessoa.responsavelId);
    const nova = await withTenant(api.db.db, clinicaC, (tx) => indice.girarChave(tx, ctxC()), adminC.userId);
    let r = { reindexados: 0, pendentes: 1 };
    for (let voltas = 0; r.pendentes > 0 && voltas < 20; voltas++) r = await withTenant(api.db.db, clinicaC, (tx) => indice.reindexar(tx, ctxC(), 3), adminC.userId);
    expect(r.pendentes).toBe(0);
    // Só o responsável volta para a versão aposentada (com o índice legítimo que ele tinha nela).
    await gravarIndiceSemUsuario(clinicaC, pessoa.responsavelId, velho?.b ?? null, velho?.v ?? null);
    expect(await withTenant(api.db.db, clinicaC, (tx) => tx.select().from(patients).where(eq(patients.cpfBidxVersion, velho?.v as number)))).toHaveLength(0);
    expect(await withTenant(api.db.db, clinicaC, (tx) => indice.descartarChavesAntigas(tx, ctxC()), adminC.userId)).toBe(0);
    await expect(
      withTenant(api.db.db, clinicaC, (tx) =>
        tx.update(patientCpfIndexKeys).set({ status: 'destroyed', keyEnc: null, destroyedAt: sql`now()` }).where(eq(patientCpfIndexKeys.version, velho?.v as number)), adminC.userId),
    ).rejects.toThrow();
    // Enquanto a versão vive, a busca ainda acha a pessoa por ela.
    expect((await procurar(clinicaC, [CPF(530)])).get(CPF(530))).toBe(pessoa.responsavelId);
    // Reindexado o responsável, a versão sai.
    expect(await withTenant(api.db.db, clinicaC, (tx) => indice.pendentes(tx, clinicaC))).toBe(1);
    await withTenant(api.db.db, clinicaC, (tx) => indice.reindexar(tx, ctxC()), adminC.userId);
    expect((await indiceDe(clinicaC, pessoa.responsavelId))?.v).toBe(nova);
    expect(await withTenant(api.db.db, clinicaC, (tx) => indice.descartarChavesAntigas(tx, ctxC()), adminC.userId)).toBe(1);
  });

  it('nenhum CPF em claro na trilha nem no log (stdout/stderr) do índice dos responsáveis', async () => {
    const saida: string[] = [];
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    process.stdout.write = (c: string | Uint8Array, ...resto: never[]) => (saida.push(String(c)), out(c, ...resto));
    process.stderr.write = (c: string | Uint8Array, ...resto: never[]) => (saida.push(String(c)), err(c, ...resto));
    try {
      const csv = [CAB, `Menor Log Ficticio;11900000541;${MENOR};Resp Dedup Ficticio 1;${CPF(511)};;mae;;;`, `Menor Log Dois;11900000542;${MENOR};Resp Log Ficticio;${CPF(540)};;pai;;;`].join('\n');
      const { id, sim } = await ateSimular(adminC, csv);
      expect((await aplicar(adminC, id, sim.resumoHash, clinicaC)).status).toBe(200);
      const p = dedup[3] as { pacienteId: string; vinculoId: string };
      await api.http().patch(`/pacientes/${p.pacienteId}/responsaveis/${p.vinculoId}`).set(cab(adminC)).send({ cpf: CPF(541) }).expect(200);
      await withTenant(api.db.db, clinicaC, (tx) => servico().indiceCpf.girarChave(tx, ctxC()), adminC.userId);
      await servico().reindexarIndiceCpfComoSistema(clinicaC);
    } finally {
      process.stdout.write = out;
      process.stderr.write = err;
    }
    const todos = [500, 501, 510, 511, 512, 513, 519, 520, 521, 530, 540, 541].map((n) => CPF(n));
    const formatado = (c: string) => `${c.slice(0, 3)}.${c.slice(3, 6)}.${c.slice(6, 9)}-${c.slice(9)}`;
    const trilha = JSON.stringify([
      ...(await withTenant(api.db.db, clinicaC, (tx) => tx.select().from(auditLog))),
      ...(await withTenant(api.db.db, clinicaD, (tx) => tx.select().from(auditLog))),
    ]);
    const log = saida.join('');
    for (const c of todos) {
      expect(trilha.includes(c) || trilha.includes(formatado(c)), 'CPF na trilha').toBe(false);
      expect(log.includes(c) || log.includes(formatado(c)), 'CPF no log').toBe(false);
    }
    expect(trilha).toContain('"table":"guardians"');
  });
});
