/**
 * Responsáveis do paciente (migração 0028) contra Postgres REAL: isolamento entre clínicas (pela API e
 * pelo RLS) em guardians, patient_guardians e patient_guardian_history; nome/CPF/telefone só cifrados no
 * banco; nada se apaga (DELETE, UPDATE do histórico e INSERT direto no histórico recusados); autor =
 * usuário da sessão; menor sem pagador -> pendência `pagador_responsavel`; responsável pagador vigente ->
 * recibo e Receita Saúde resolvidos; maioridade (aos 18 a informação clínica cai, salvo curatela);
 * permissões (recepção cadastra, não liga informação clínica; financeiro só lê); trilha sem dado pessoal.
 * Pré-requisitos: migrações aplicadas e DATABASE_URL = papel app_user. Dados 100% fictícios.
 */
import type { TenantId } from '@plataforma/shared';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, guardians, patientGuardianHistory, patientGuardians } from '../src/db/schema';
import { withTenant, type TenantTx } from '../src/db/tenant-transaction';
import { noFusoDaClinica } from '../src/modules/scheduling/agenda-regras';
import { cab, cpfFicticio, subirApi, type ApiDeTeste } from './apoio-api';

type Sessao = { Authorization: string; userId: string };
interface Resp {
  id: string;
  responsavelId: string;
  nome: string;
  cpf: string | null;
  telefone: string | null;
  pagador: boolean;
  tipo: string;
  parentesco: string;
  informacaoClinica: { permitida: boolean; motivo: string };
  vigencia: { desde: string; ate: string | null; vigente: boolean };
  encerramento: { motivo: string } | null;
}

let api: ApiDeTeste;
let clinicaA: TenantId;
let clinicaB: TenantId;
let adminA: Sessao;
let recepA: Sessao;
let finA: Sessao;
let profA: Sessao;
let adminB: Sessao;
let profissionalPfA: string;
let tipoA: string;
let horaSeq = 0;

const NOME_RESP = 'Responsavel Ficticia QZR8811';
const CPF_RESP = cpfFicticio(881);
const CPF_RESP_NOVO = cpfFicticio(882);
const TEL_RESP = '11900008811';

const hoje = (): string => noFusoDaClinica(new Date()).data;
/** Data de nascimento de quem faz `anos` anos HOJE (+ `dias` para ainda não ter feito). */
function nascidoHa(anos: number, dias = 0): string {
  const [a, m, d] = hoje().split('-').map(Number) as [number, number, number];
  const base = new Date(Date.UTC(a - anos, m - 1, d + dias));
  return base.toISOString().slice(0, 10);
}

const id = (r: { body: unknown }) => (r.body as { id: string }).id;
function post(s: Sessao, rota: string, corpo: object = {}) {
  return api.http().post(rota).set(cab(s)).send(corpo);
}
function get(s: Sessao, rota: string) {
  return api.http().get(rota).set(cab(s));
}
function patch(s: Sessao, rota: string, corpo: object) {
  return api.http().patch(rota).set(cab(s)).send(corpo);
}

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

async function paciente(s: Sessao, corpo: Record<string, unknown>): Promise<string> {
  const r = await post(s, '/pacientes', { telefone: '11900008800', ...corpo });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return id(r);
}

async function responsavel(s: Sessao, pacienteId: string, corpo: Record<string, unknown>): Promise<Resp> {
  const r = await post(s, `/pacientes/${pacienteId}/responsaveis`, corpo);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as Resp;
}

/** Recebe hoje uma cobrança PF sem pagador do paciente e emite o recibo; devolve o recibo. */
async function reciboSemPagador(pacienteId: string) {
  horaSeq++;
  const ag = await post(recepA, '/agendamentos', {
    pacienteId,
    profissionalId: profissionalPfA,
    tipoId: tipoA,
    data: `2031-04-${String(1 + (horaSeq % 28)).padStart(2, '0')}`,
    hora: `${String(6 + Math.floor(horaSeq / 28)).padStart(2, '0')}:00`,
    encaixe: true,
  });
  expect(ag.status, JSON.stringify(ag.body)).toBe(201);
  const c = await post(recepA, '/financeiro/cobrancas', { agendamentoId: id(ag), valorCentavos: 9000, atendimentoPor: 'pf' });
  expect(c.status, JSON.stringify(c.body)).toBe(201);
  const p = await post(recepA, `/financeiro/cobrancas/${id(c)}/recebimentos`, { forma: 'dinheiro' });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  const r = await post(recepA, `/financeiro/recebimentos/${id(p)}/recibo`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as { pendencias: string[]; pagador: { nome: string; cpf: string | null }; beneficiario: { nome: string } };
}

beforeAll(async () => {
  api = await subirApi();
  clinicaA = await api.novaClinica();
  clinicaB = await api.novaClinica();
  adminA = api.sessao(clinicaA, 'admin');
  recepA = api.sessao(clinicaA, 'recepcao');
  finA = api.sessao(clinicaA, 'financeiro');
  profA = api.sessao(clinicaA, 'profissional');
  adminB = api.sessao(clinicaB, 'admin');
  profissionalPfA = id(await post(adminA, '/profissionais', { nome: 'Profissional Ficticia Pediatrica', especialidade: 'Fisioterapia' }));
  tipoA = id(await post(adminA, '/tipos-atendimento', { nome: 'Sessao', minutos: 40 }));
  await api.http().put(`/financeiro/profissionais/${profissionalPfA}/perfil-fiscal`).set(cab(finA)).send({ cpf: cpfFicticio(880) }).expect(200);
  const caixa = await post(recepA, '/financeiro/caixas', { turno: 'unico' });
  expect(caixa.status, JSON.stringify(caixa.body)).toBe(201);
});

afterAll(async () => {
  await api?.fechar();
});

describe('cadastro, cifra e histórico', () => {
  it('recepção cadastra; nome, CPF e telefone só cifrados no banco; a resposta devolve em claro', async () => {
    const pac = await paciente(recepA, { nome: 'Paciente Ficticio Cifra', nascimento: nascidoHa(8) });
    const r = await responsavel(recepA, pac, { nome: NOME_RESP, cpf: CPF_RESP, telefone: TEL_RESP, tipo: 'pai_mae' });
    expect(r).toMatchObject({ nome: NOME_RESP, cpf: CPF_RESP, telefone: TEL_RESP, tipo: 'pai_mae', parentesco: 'Pai/Mãe', pagador: false });
    expect(r.vigencia).toEqual({ desde: hoje(), ate: null, vigente: true });
    const [linha] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(guardians).where(eq(guardians.id, r.responsavelId)));
    const bruto = JSON.stringify(linha);
    expect(bruto).not.toContain(CPF_RESP);
    expect(bruto).not.toContain('QZR8811');
    expect(bruto).not.toContain(TEL_RESP);
    expect(linha?.cpfEnc).toBeTruthy();
    expect(linha?.createdBy).toBe(recepA.userId);
  });

  it('corrigir o CPF não apaga o anterior: histórico guarda o valor antigo CIFRADO; a rota mostra só eventos e campos', async () => {
    const pac = await paciente(recepA, { nome: 'Paciente Ficticio Historico', nascimento: nascidoHa(5) });
    const r = await responsavel(recepA, pac, { nome: NOME_RESP, cpf: CPF_RESP, tipo: 'tutor' });
    const alt = await patch(recepA, `/pacientes/${pac}/responsaveis/${r.id}`, { cpf: CPF_RESP_NOVO });
    expect(alt.status, JSON.stringify(alt.body)).toBe(200);
    expect((alt.body as Resp).cpf).toBe(CPF_RESP_NOVO);
    const hist = await withTenant(api.db.db, clinicaA, (tx) =>
      tx.select().from(patientGuardianHistory).where(eq(patientGuardianHistory.guardianId, r.responsavelId)),
    );
    const alterado = hist.find((h) => h.event === 'responsavel_alterado');
    expect(alterado).toMatchObject({ changedFields: 'cpf', actorId: recepA.userId });
    expect(alterado?.prevCpfEnc).toBeTruthy();
    expect(JSON.stringify(hist)).not.toContain(CPF_RESP);
    const rota = await get(recepA, `/pacientes/${pac}/responsaveis/${r.id}/historico`);
    expect(rota.status).toBe(200);
    expect((rota.body as { evento: string }[]).map((e) => e.evento)).toEqual(['responsavel_criado', 'vinculo_criado', 'responsavel_alterado']);
    expect(JSON.stringify(rota.body)).not.toContain(CPF_RESP);
  });

  it('pessoa existente vinculada a outro paciente (irmão); vínculo duplicado vivo e segundo pagador: 409', async () => {
    const irmao1 = await paciente(recepA, { nome: 'Paciente Ficticio Irmao Um', nascimento: nascidoHa(6) });
    const irmao2 = await paciente(recepA, { nome: 'Paciente Ficticio Irmao Dois', nascimento: nascidoHa(9) });
    const r1 = await responsavel(recepA, irmao1, { nome: NOME_RESP, tipo: 'pai_mae', pagador: true });
    const r2 = await responsavel(recepA, irmao2, { responsavelId: r1.responsavelId, tipo: 'pai_mae' });
    expect(r2.responsavelId).toBe(r1.responsavelId);
    expect(r2.nome).toBe(NOME_RESP);
    expect((await post(recepA, `/pacientes/${irmao1}/responsaveis`, { responsavelId: r1.responsavelId, tipo: 'tutor' })).body).toMatchObject({ codigo: 'responsavel_ja_vinculado' });
    expect((await post(recepA, `/pacientes/${irmao1}/responsaveis`, { nome: 'Outro Resp Ficticio', tipo: 'tutor', pagador: true })).body).toMatchObject({ codigo: 'pagador_ja_definido' });
  });

  it('marcar outro pagador desmarca o anterior na mesma transação; encerrar é terminal', async () => {
    const pac = await paciente(recepA, { nome: 'Paciente Ficticio Pagador', nascimento: nascidoHa(10) });
    const mae = await responsavel(recepA, pac, { nome: 'Mae Ficticia', tipo: 'pai_mae', pagador: true });
    const pai = await responsavel(recepA, pac, { nome: 'Pai Ficticio', tipo: 'pai_mae' });
    const m = await post(recepA, `/pacientes/${pac}/responsaveis/${pai.id}/pagador`, { pagador: true });
    expect(m.status, JSON.stringify(m.body)).toBe(200);
    const lista = (await get(finA, `/pacientes/${pac}/responsaveis`)).body as { itens: Resp[]; pendencias: string[]; menorDeIdade: boolean };
    expect(lista.itens.find((i) => i.id === mae.id)?.pagador).toBe(false);
    expect(lista.itens.find((i) => i.id === pai.id)?.pagador).toBe(true);
    expect(lista).toMatchObject({ menorDeIdade: true, pendencias: [] });
    const e = await post(recepA, `/pacientes/${pac}/responsaveis/${mae.id}/encerrar`, { motivo: 'decisao_judicial' });
    expect(e.status, JSON.stringify(e.body)).toBe(200);
    expect(e.body).toMatchObject({ vigencia: { ate: hoje(), vigente: false }, encerramento: { motivo: 'decisao_judicial' } });
    expect((await patch(recepA, `/pacientes/${pac}/responsaveis/${mae.id}`, { telefone: TEL_RESP })).body).toMatchObject({ codigo: 'vinculo_encerrado' });
    expect((await post(recepA, `/pacientes/${pac}/responsaveis/${mae.id}/encerrar`, { motivo: 'substituido' })).body).toMatchObject({ codigo: 'vinculo_encerrado' });
    // Vigentes por padrão; ?situacao=todos traz o encerrado.
    expect(((await get(recepA, `/pacientes/${pac}/responsaveis`)).body as { itens: Resp[] }).itens.map((i) => i.id)).toEqual([pai.id]);
    expect(((await get(recepA, `/pacientes/${pac}/responsaveis?situacao=todos`)).body as { itens: Resp[] }).itens).toHaveLength(2);
    // Menor sem responsável vigente: pendência no cadastro.
    const sem = await paciente(recepA, { nome: 'Paciente Ficticio Sem Resp', nascimento: nascidoHa(3) });
    expect(((await get(recepA, `/pacientes/${sem}/responsaveis`)).body as { pendencias: string[] }).pendencias).toEqual([
      'menor_sem_responsavel_vigente',
      'menor_sem_pagador_vigente',
    ]);
  });
});

describe('financeiro: pendência pagador_responsavel (R3 do #65)', () => {
  it('menor sem pagador -> pendência; com responsável pagador vigente -> recibo e Receita Saúde resolvidos', async () => {
    const menor = await paciente(recepA, { nome: 'Paciente Ficticio Menor Recibo', cpf: cpfFicticio(883), nascimento: nascidoHa(12) });
    const r1 = await reciboSemPagador(menor);
    expect(r1.pendencias).toContain('pagador_responsavel');
    expect(r1.pagador.nome).toBe('Paciente Ficticio Menor Recibo');
    // Responsável sem a marca de pagador não resolve.
    const resp = await responsavel(recepA, menor, { nome: NOME_RESP, cpf: CPF_RESP, tipo: 'pai_mae' });
    expect((await reciboSemPagador(menor)).pendencias).toContain('pagador_responsavel');
    // Marcado pagador: o recibo sai em nome do responsável, com o CPF dele, sem a pendência.
    await post(recepA, `/pacientes/${menor}/responsaveis/${resp.id}/pagador`, { pagador: true }).expect(200);
    const r3 = await reciboSemPagador(menor);
    expect(r3.pendencias).not.toContain('pagador_responsavel');
    expect(r3.pendencias).not.toContain('cpf_do_pagador');
    expect(r3.pagador).toEqual({ nome: NOME_RESP, cpf: CPF_RESP });
    expect(r3.beneficiario.nome).toBe('Paciente Ficticio Menor Recibo');
    // Receita Saúde do dia: os itens com o responsável saem com o CPF dele e sem a pendência.
    const lote = await post(finA, '/financeiro/receita-saude/lotes', { profissionalId: profissionalPfA, de: hoje(), ate: hoje() });
    expect(lote.status, JSON.stringify(lote.body)).toBe(200);
    const itens = (lote.body as { itens: { pendencias: string[]; pagador: { cpf: string | null }; beneficiario: { nome: string } }[] }).itens.filter(
      (i) => i.beneficiario.nome === 'Paciente Ficticio Menor Recibo',
    );
    expect(itens.length).toBe(3);
    expect(itens.every((i) => i.pagador.cpf === CPF_RESP && !i.pendencias.includes('pagador_responsavel'))).toBe(true);
    // Vínculo encerrado HOJE (fim exclusivo): o pagamento de hoje fica fora da vigência e a pendência volta.
    await post(recepA, `/pacientes/${menor}/responsaveis/${resp.id}/encerrar`, { motivo: 'substituido' }).expect(200);
    expect((await reciboSemPagador(menor)).pendencias).toContain('pagador_responsavel');
  });
});

describe('maioridade e informação clínica (LGPD art. 14; CC arts. 5º e 1.767)', () => {
  it('aos 18 anos a informação clínica cai sozinha; véspera ainda vale; curatela sobrevive; sem nascimento, negada', async () => {
    const vespera = await paciente(recepA, { nome: 'Paciente Ficticio Vespera', nascimento: nascidoHa(18, 1) });
    const fez18 = await paciente(recepA, { nome: 'Paciente Ficticio Fez 18', nascimento: nascidoHa(18) });
    const semData = await paciente(recepA, { nome: 'Paciente Ficticio Sem Data' });
    const a = await responsavel(adminA, vespera, { nome: 'Resp Ficticio A', tipo: 'pai_mae', recebeInformacaoClinica: true });
    const b = await responsavel(profA, fez18, { nome: 'Resp Ficticio B', tipo: 'pai_mae', recebeInformacaoClinica: true });
    const c = await responsavel(adminA, fez18, { nome: 'Curador Ficticio', tipo: 'curador', recebeInformacaoClinica: true });
    const d = await responsavel(adminA, semData, { nome: 'Resp Ficticio D', tipo: 'pai_mae', recebeInformacaoClinica: true });
    expect(a.informacaoClinica).toEqual({ permitida: true, motivo: 'permitida' });
    expect(b.informacaoClinica).toEqual({ permitida: false, motivo: 'paciente_maior_de_idade' });
    expect(c.informacaoClinica).toEqual({ permitida: true, motivo: 'permitida' });
    expect(d.informacaoClinica).toEqual({ permitida: false, motivo: 'sem_data_de_nascimento' });
    // A maioridade não encerra o vínculo (o pagador segue valendo), só a informação clínica.
    expect(b.vigencia.vigente).toBe(true);
    const sem = await responsavel(recepA, vespera, { nome: 'Resp Ficticio Sem Marca', tipo: 'tutor' });
    expect(sem.informacaoClinica.motivo).toBe('marca_desligada');
  });
});

describe('permissões', () => {
  it('recepção cadastra mas não liga a informação clínica; financeiro só lê; desligar qualquer um que escreve', async () => {
    const pac = await paciente(recepA, { nome: 'Paciente Ficticio Permissoes', nascimento: nascidoHa(4) });
    const negado = await post(recepA, `/pacientes/${pac}/responsaveis`, { nome: 'Resp Ficticio', tipo: 'pai_mae', recebeInformacaoClinica: true });
    expect(negado.status).toBe(403);
    expect(negado.body).toMatchObject({ codigo: 'liberar_informacao_clinica_sem_permissao' });
    const r = await responsavel(recepA, pac, { nome: 'Resp Ficticio', tipo: 'pai_mae' });
    expect((await patch(recepA, `/pacientes/${pac}/responsaveis/${r.id}`, { recebeInformacaoClinica: true })).status).toBe(403);
    expect((await patch(profA, `/pacientes/${pac}/responsaveis/${r.id}`, { recebeInformacaoClinica: true })).status).toBe(200);
    expect((await patch(recepA, `/pacientes/${pac}/responsaveis/${r.id}`, { recebeInformacaoClinica: false })).status).toBe(200);
    expect((await post(finA, `/pacientes/${pac}/responsaveis`, { nome: 'Resp Ficticio Fin', tipo: 'tutor' })).status).toBe(403);
    expect((await post(finA, `/pacientes/${pac}/responsaveis/${r.id}/pagador`, { pagador: true })).status).toBe(403);
    expect((await post(finA, `/pacientes/${pac}/responsaveis/${r.id}/encerrar`, { motivo: 'substituido' })).status).toBe(403);
    expect((await get(finA, `/pacientes/${pac}/responsaveis`)).status).toBe(200);
    // Texto livre não entra na query.
    expect((await get(recepA, `/pacientes/${pac}/responsaveis?nome=x`)).status).toBe(400);
  });

  it('a trilha leva só ids, campos e códigos: nunca nome, CPF ou telefone', async () => {
    const linhas = await withTenant(api.db.db, clinicaA, (tx) =>
      tx.select({ m: auditLog.metadata }).from(auditLog).where(eq(auditLog.scope, 'patient_guardians')),
    );
    expect(linhas.length).toBeGreaterThan(5);
    const tudo = JSON.stringify(linhas);
    for (const proibido of [CPF_RESP, CPF_RESP_NOVO, 'QZR8811', TEL_RESP, 'Ficticia', 'Ficticio']) expect(tudo).not.toContain(proibido);
  });
});

describe('isolamento entre clínicas', () => {
  it('pela API: a clínica B não lista, não altera, não encerra nem vincula responsável de A (404)', async () => {
    const pac = await paciente(recepA, { nome: 'Paciente Ficticio Isolamento', nascimento: nascidoHa(7) });
    const r = await responsavel(recepA, pac, { nome: NOME_RESP, cpf: CPF_RESP, tipo: 'pai_mae' });
    expect((await get(adminB, `/pacientes/${pac}/responsaveis`)).status).toBe(404);
    expect((await patch(adminB, `/pacientes/${pac}/responsaveis/${r.id}`, { telefone: TEL_RESP })).status).toBe(404);
    expect((await post(adminB, `/pacientes/${pac}/responsaveis/${r.id}/pagador`, { pagador: true })).status).toBe(404);
    expect((await post(adminB, `/pacientes/${pac}/responsaveis/${r.id}/encerrar`, { motivo: 'substituido' })).status).toBe(404);
    expect((await get(adminB, `/pacientes/${pac}/responsaveis/${r.id}/historico`)).status).toBe(404);
    // A pessoa de A não pode ser vinculada a paciente de B.
    const pacB = await paciente(adminB, { nome: 'Paciente Ficticio B' });
    expect((await post(adminB, `/pacientes/${pacB}/responsaveis`, { responsavelId: r.responsavelId, tipo: 'tutor' })).status).toBe(404);
  });

  it('pelo RLS: B não vê nem grava nas três tabelas de A', async () => {
    const vistos = await withTenant(api.db.db, clinicaB, async (tx) => ({
      g: (await tx.select({ n: sql<number>`count(*)::int` }).from(guardians).where(eq(guardians.tenantId, clinicaA)))[0]?.n,
      v: (await tx.select({ n: sql<number>`count(*)::int` }).from(patientGuardians).where(eq(patientGuardians.tenantId, clinicaA)))[0]?.n,
      h: (await tx.select({ n: sql<number>`count(*)::int` }).from(patientGuardianHistory).where(eq(patientGuardianHistory.tenantId, clinicaA)))[0]?.n,
    }), adminB.userId);
    expect(vistos).toEqual({ g: 0, v: 0, h: 0 });
    const [algum] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(guardians).limit(1), adminA.userId);
    expect(algum).toBeDefined();
    // INSERT com o tenant de A a partir da sessão de B: a policy recusa (42501).
    expect(
      await sqlstate(
        withTenant(api.db.db, clinicaB, (tx) =>
          tx.insert(guardians).values({ tenantId: clinicaA, nameEnc: algum!.nameEnc, createdBy: adminB.userId, updatedBy: adminB.userId }),
        adminB.userId),
      ),
    ).toContain('42501');
    // UPDATE de linha de A pela sessão de B: zero linhas (invisível).
    const alterados = await withTenant(api.db.db, clinicaB, (tx) =>
      tx.update(guardians).set({ updatedBy: adminB.userId }).where(eq(guardians.id, algum!.id)).returning(), adminB.userId);
    expect(alterados).toEqual([]);
  });
});

describe('nada se apaga e o autor é a sessão (banco)', () => {
  it('DELETE recusado; histórico sem UPDATE e sem INSERT direto; autor diferente da sessão recusado; encerrado é terminal', async () => {
    const pac = await paciente(recepA, { nome: 'Paciente Ficticio Banco', nascimento: nascidoHa(9) });
    const r = await responsavel(recepA, pac, { nome: NOME_RESP, tipo: 'pai_mae' });
    const em = <T>(fn: (tx: TenantTx) => Promise<T>, user = recepA.userId) => withTenant(api.db.db, clinicaA, fn, user);
    expect(await sqlstate(em((tx) => tx.delete(patientGuardians).where(eq(patientGuardians.id, r.id))))).toContain('42501');
    expect(await sqlstate(em((tx) => tx.delete(guardians).where(eq(guardians.id, r.responsavelId))))).toContain('42501');
    expect(await sqlstate(em((tx) => tx.delete(patientGuardianHistory).where(eq(patientGuardianHistory.linkId, r.id))))).toContain('42501');
    expect(await sqlstate(em((tx) => tx.update(patientGuardianHistory).set({ changedFields: '' }).where(eq(patientGuardianHistory.linkId, r.id))))).toContain('42501');
    expect(
      await sqlstate(
        em((tx) =>
          tx.insert(patientGuardianHistory).values({ tenantId: clinicaA, guardianId: r.responsavelId, event: 'responsavel_criado', actorId: recepA.userId }),
        ),
      ),
    ).toContain('42501');
    // Autor forjado (created_by de outro usuário) e troca do autor na alteração: recusados.
    const [g] = await em((tx) => tx.select().from(guardians).where(eq(guardians.id, r.responsavelId)));
    const outro = randomUUID();
    expect(await sqlstate(em((tx) => tx.insert(guardians).values({ tenantId: clinicaA, nameEnc: g!.nameEnc, createdBy: outro, updatedBy: outro })))).toContain('42501');
    expect(await sqlstate(em((tx) => tx.update(guardians).set({ updatedBy: outro }).where(eq(guardians.id, r.responsavelId))))).toContain('42501');
    // Paciente, pessoa, tipo e início imutáveis.
    expect(
      await sqlstate(em((tx) => tx.update(patientGuardians).set({ kind: 'curador', updatedBy: recepA.userId }).where(eq(patientGuardians.id, r.id)))),
    ).toContain('42501');
    // Encerramento futuro recusado pelo banco; encerrado é terminal mesmo direto no banco.
    expect(
      await sqlstate(
        em((tx) =>
          tx
            .update(patientGuardians)
            .set({ validUntil: '2099-01-01', endReason: 'substituido', endedAt: new Date(), endedBy: recepA.userId, updatedBy: recepA.userId })
            .where(eq(patientGuardians.id, r.id)),
        ),
      ),
    ).toContain('23514');
    await post(recepA, `/pacientes/${pac}/responsaveis/${r.id}/encerrar`, { motivo: 'cadastro_errado' }).expect(200);
    expect(
      await sqlstate(em((tx) => tx.update(patientGuardians).set({ isPayer: true, updatedBy: recepA.userId }).where(and(eq(patientGuardians.id, r.id))))),
    ).toContain('42501');
    // O histórico registrou o encerramento com o autor da sessão.
    const hist = await em((tx) =>
      tx.select().from(patientGuardianHistory).where(eq(patientGuardianHistory.linkId, r.id)).orderBy(patientGuardianHistory.seq),
    );
    expect(hist.map((h) => h.event)).toEqual(['vinculo_criado', 'vinculo_encerrado']);
    expect(hist.every((h) => h.actorId === recepA.userId)).toBe(true);
  });
});
