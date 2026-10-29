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
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adolescentConfidentialityRequests,
  appointments,
  auditLog,
  cashSessions,
  charges,
  guardians,
  patientGuardianHistory,
  patientGuardians,
  payments,
} from '../src/db/schema';
import { withTenant, type TenantTx } from '../src/db/tenant-transaction';
import { noFusoDaClinica } from '../src/modules/scheduling/agenda-regras';
import { mascararCpf } from '../src/modules/patients/responsaveis.service';
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
/** Profissional ligado ao usuário profA (perfil clínico no banco): quem decide a informação clínica. */
let profissionalDoProfA: string;
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

const JUSTIFICATIVA = 'Avaliacao ficticia do profissional: compartilhar o essencial';

/** Vínculo de cuidado de profA com o paciente: consulta confirmada daqui a 1 hora (agenda do dia), criada pela recepção. */
async function cuidar(pacienteId: string): Promise<void> {
  const inicio = new Date(Date.now() + 60 * 60_000);
  await withTenant(api.db.db, clinicaA, (tx) =>
    tx.insert(appointments).values({
      tenantId: clinicaA,
      createdBy: recepA.userId,
      patientId: pacienteId,
      professionalId: profissionalDoProfA,
      appointmentTypeId: tipoA,
      startsAt: inicio,
      endsAt: new Date(inicio.getTime() + 40 * 60_000),
      status: 'confirmed',
    }), recepA.userId);
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
  return r.body as { id: string; pendencias: string[]; pagador: { nome: string; cpf: string | null }; beneficiario: { nome: string } };
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
  await api.membro(clinicaA, profA, 'profissional');
  // R1 do 2º parecer do #67: anular pagador com recebimentos confere no banco o perfil que opera o financeiro.
  await api.membro(clinicaA, recepA, 'recepcao');
  // R2: o saneamento do pagador confere no banco admin ou financeiro ativo.
  await api.membro(clinicaA, finA, 'financeiro');
  profissionalDoProfA = id(await post(adminA, '/profissionais', { nome: 'Profissional Ficticia Cuidado', especialidade: 'Psicologia', usuarioId: profA.userId }));
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
    expect(r).toMatchObject({ nome: NOME_RESP, cpf: mascararCpf(CPF_RESP), telefone: TEL_RESP, tipo: 'pai_mae', parentesco: 'Pai/Mãe', pagador: false });
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
    expect((alt.body as Resp).cpf).toBe(mascararCpf(CPF_RESP_NOVO));
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
    // Recibo emitido pela recepção: CPF mascarado; financeiro e admin leem o mesmo recibo com o CPF completo.
    expect(r3.pagador).toEqual({ nome: NOME_RESP, cpf: mascararCpf(CPF_RESP) });
    expect(r3.beneficiario.nome).toBe('Paciente Ficticio Menor Recibo');
    for (const s of [finA, adminA]) {
      expect(((await get(s, `/financeiro/recibos/${r3.id}`)).body as { pagador: unknown }).pagador).toEqual({ nome: NOME_RESP, cpf: CPF_RESP });
    }
    // Receita Saúde do dia: só o item recebido com o responsável já pagador sai com o CPF dele.
    const lote = await post(finA, '/financeiro/receita-saude/lotes', { profissionalId: profissionalPfA, de: hoje(), ate: hoje() });
    expect(lote.status, JSON.stringify(lote.body)).toBe(200);
    const itens = (lote.body as { itens: { pendencias: string[]; pagador: { cpf: string | null }; beneficiario: { nome: string } }[] }).itens.filter(
      (i) => i.beneficiario.nome === 'Paciente Ficticio Menor Recibo',
    );
    expect(itens.length).toBe(3);
    // V1 do #67: o pagador é o CONGELADO no recebimento — os dois pagamentos de antes da marca seguem com a pendência.
    expect(itens.map((i) => i.pagador.cpf === CPF_RESP && !i.pendencias.includes('pagador_responsavel'))).toEqual([false, false, true]);
    // Vínculo encerrado HOJE (fim exclusivo): o pagamento de hoje fica fora da vigência e a pendência volta.
    await post(recepA, `/pacientes/${menor}/responsaveis/${resp.id}/encerrar`, { motivo: 'substituido' }).expect(200);
    expect((await reciboSemPagador(menor)).pendencias).toContain('pagador_responsavel');
  });
});

/** Cobrança PF sem pagador próprio, recebida agora; devolve o id do recebimento (sem emitir recibo). */
async function receberSemRecibo(pacienteId: string): Promise<string> {
  horaSeq++;
  const ag = await post(recepA, '/agendamentos', {
    pacienteId,
    profissionalId: profissionalPfA,
    tipoId: tipoA,
    data: `2031-05-${String(1 + (horaSeq % 28)).padStart(2, '0')}`,
    hora: `${String(6 + Math.floor(horaSeq / 28)).padStart(2, '0')}:00`,
    encaixe: true,
  });
  expect(ag.status, JSON.stringify(ag.body)).toBe(201);
  const c = await post(recepA, '/financeiro/cobrancas', { agendamentoId: id(ag), valorCentavos: 7000, atendimentoPor: 'pf' });
  expect(c.status, JSON.stringify(c.body)).toBe(201);
  const p = await post(recepA, `/financeiro/cobrancas/${id(c)}/recebimentos`, { forma: 'pix_manual' });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  return id(p);
}

describe('V1 do #67: pagador congelado no recebimento (sem retroatividade)', () => {
  it('trocar o pagador, encerrar/anular e criar vínculo com início antigo NÃO mudam recibo tardio nem lote de pagamento anterior', async () => {
    const CPF_MAE = cpfFicticio(891);
    const CPF_PAI = cpfFicticio(892);
    const CPF_NOVO = cpfFicticio(893);
    const pac = await paciente(recepA, { nome: 'Paciente Ficticio Retroativo', cpf: cpfFicticio(890), nascimento: nascidoHa(9) });
    const mae = await responsavel(recepA, pac, { nome: 'Mae Ficticia Retro', cpf: CPF_MAE, tipo: 'pai_mae', pagador: true, desde: '2025-01-01' });
    const pai = await responsavel(recepA, pac, { nome: 'Pai Ficticio Retro', cpf: CPF_PAI, tipo: 'pai_mae', desde: '2025-01-01' });
    // Recebido com a mãe pagadora; o recibo NÃO é emitido agora (recibo tardio).
    const antes = await receberSemRecibo(pac);
    const [linha] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(payments).where(eq(payments.id, antes)), recepA.userId);
    expect(linha?.guardianPayerLinkId).toBe(mae.id);
    expect(linha?.guardianPayerEnc).toBeTruthy();
    expect(JSON.stringify(linha)).not.toContain(CPF_MAE);

    // Encerrar a mãe com data anterior ao pagamento atribuído: 409 (o congelado não mudaria de qualquer forma).
    expect((await post(recepA, `/pacientes/${pac}/responsaveis/${mae.id}/encerrar`, { motivo: 'substituido', ate: '2025-01-02' })).body).toMatchObject({
      codigo: 'encerramento_antes_de_pagamento_atribuido',
    });
    // 1) Troca do pagador para o pai.
    await post(recepA, `/pacientes/${pac}/responsaveis/${pai.id}/pagador`, { pagador: true }).expect(200);
    // 2) Correção do CPF da mãe (a pessoa) depois do pagamento.
    await patch(recepA, `/pacientes/${pac}/responsaveis/${mae.id}`, { cpf: CPF_NOVO }).expect(200);
    // 3) Encerra o pai e cria um vínculo novo com início ANTIGO e pagador.
    await post(recepA, `/pacientes/${pac}/responsaveis/${pai.id}/encerrar`, { motivo: 'substituido' }).expect(200);
    const tutor = await responsavel(recepA, pac, { nome: 'Tutor Ficticio Retro', cpf: CPF_NOVO, tipo: 'tutor', pagador: true, desde: '2025-01-01' });

    // Recibo tardio do pagamento anterior: continua a MÃE com o CPF daquele momento.
    const tardio = await post(finA, `/financeiro/recebimentos/${antes}/recibo`);
    expect(tardio.status, JSON.stringify(tardio.body)).toBe(200);
    expect((tardio.body as { pagador: unknown }).pagador).toEqual({ nome: 'Mae Ficticia Retro', cpf: CPF_MAE });
    // Lote do Receita Saúde que cobre o pagamento anterior: idem (o lote é recalculado a cada geração).
    const lote = await post(finA, '/financeiro/receita-saude/lotes', { profissionalId: profissionalPfA, de: hoje(), ate: hoje() });
    expect(lote.status, JSON.stringify(lote.body)).toBe(200);
    const doPac = (lote.body as { itens: { pagador: { nome: string; cpf: string | null }; beneficiario: { nome: string } }[] }).itens.filter(
      (i) => i.beneficiario.nome === 'Paciente Ficticio Retroativo',
    );
    expect(doPac.map((i) => i.pagador)).toEqual([{ nome: 'Mae Ficticia Retro', cpf: CPF_MAE }]);
    // Pagamento NOVO: vale o pagador vivo de agora (o tutor).
    const depois = await receberSemRecibo(pac);
    expect(((await post(finA, `/financeiro/recebimentos/${depois}/recibo`)).body as { pagador: unknown }).pagador).toEqual({
      nome: 'Tutor Ficticio Retro',
      cpf: CPF_NOVO,
    });
    const [linhaDepois] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(payments).where(eq(payments.id, depois)), recepA.userId);
    expect(linhaDepois?.guardianPayerLinkId).toBe(tutor.id);
  });

  it('banco: recebimento só congela o pagador VIVO do paciente; o retrato não muda depois (append-only)', async () => {
    const pac = await paciente(recepA, { nome: 'Paciente Ficticio Congela Banco', nascimento: nascidoHa(7) });
    const naoPagador = await responsavel(recepA, pac, { nome: 'Resp Ficticio Nao Pagador', tipo: 'pai_mae' });
    const pagou = await receberSemRecibo(pac);
    const [p] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(payments).where(eq(payments.id, pagou)), recepA.userId);
    expect(p?.guardianPayerLinkId).toBeNull();
    // Forjar um recebimento com vínculo que não é pagador: o trigger recusa (23514).
    const [g] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(guardians).limit(1), recepA.userId);
    const selo = g!.nameEnc;
    expect(
      await sqlstate(
        withTenant(api.db.db, clinicaA, (tx) =>
          tx.insert(payments).values({
            tenantId: clinicaA,
            chargeId: p!.chargeId,
            cashSessionId: p!.cashSessionId,
            method: 'dinheiro',
            amountCents: 1,
            receivedBy: recepA.userId,
            guardianPayerLinkId: naoPagador.id,
            guardianPayerEnc: selo,
          }),
        recepA.userId),
      ),
    ).toContain('23514');
    // Reescrever o congelado depois: recusado (42501).
    expect(
      await sqlstate(
        withTenant(api.db.db, clinicaA, (tx) => tx.update(payments).set({ guardianPayerLinkId: naoPagador.id }).where(eq(payments.id, pagou)), recepA.userId),
      ),
    ).toContain('42501');
  });
});

describe('R1 do 2º parecer do #67: anular pagador que já tem recebimentos', () => {
  it('exige financeiro:operar (API e banco); recibo tardio e lote ganham pagador_anulado; recibo emitido não muda', async () => {
    const pac = await paciente(recepA, { nome: 'Paciente Ficticio Pagador Anulado', cpf: cpfFicticio(870), nascimento: nascidoHa(9) });
    const CPF_ERR = cpfFicticio(871);
    const errado = await responsavel(recepA, pac, { nome: 'Resp Ficticio Pagador Anulado QZR1', cpf: CPF_ERR, tipo: 'pai_mae', pagador: true });
    const emitido = await receberSemRecibo(pac);
    const reciboAntes = (await post(finA, `/financeiro/recebimentos/${emitido}/recibo`)).body as { id: string; pendencias: string[]; pagador: unknown };
    expect(reciboAntes.pagador).toEqual({ nome: 'Resp Ficticio Pagador Anulado QZR1', cpf: CPF_ERR });
    expect(reciboAntes.pendencias).not.toContain('pagador_anulado');
    const tardio = await receberSemRecibo(pac);
    const MOTIVO = 'Cadastro ficticio feito no paciente errado';

    // Profissional escreve responsáveis mas não opera o financeiro: 403 na API e 42501 no banco.
    const negado = await post(profA, `/pacientes/${pac}/responsaveis/${errado.id}/anular`, { motivo: MOTIVO });
    expect(negado.status).toBe(403);
    expect(negado.body).toMatchObject({ codigo: 'anular_pagador_com_recebimentos' });
    const [selo] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(guardians).where(eq(guardians.id, errado.responsavelId)), recepA.userId);
    expect(
      await sqlstate(
        withTenant(api.db.db, clinicaA, (tx) =>
          tx
            .update(patientGuardians)
            .set({ validUntil: errado.vigencia.desde, endReason: 'cadastro_errado', annulReasonEnc: selo!.nameEnc, discardAfter: '2099-01-01', endedAt: new Date(), endedBy: profA.userId, updatedBy: profA.userId })
            .where(eq(patientGuardians.id, errado.id)), profA.userId),
      ),
    ).toContain('42501');

    // Recepção opera o financeiro: anula.
    const an = await post(recepA, `/pacientes/${pac}/responsaveis/${errado.id}/anular`, { motivo: MOTIVO });
    expect(an.status, JSON.stringify(an.body)).toBe(200);
    // Recibo já emitido: igual (retrato imutável).
    const mesmo = (await get(finA, `/financeiro/recibos/${reciboAntes.id}`)).body as { pendencias: string[]; pagador: unknown };
    expect(mesmo).toMatchObject({ pendencias: reciboAntes.pendencias, pagador: reciboAntes.pagador });
    // Recibo tardio: o congelado continua, com a pendência pagador_anulado.
    const rt = await post(finA, `/financeiro/recebimentos/${tardio}/recibo`);
    expect(rt.status, JSON.stringify(rt.body)).toBe(200);
    expect(rt.body).toMatchObject({ pagador: { nome: 'Resp Ficticio Pagador Anulado QZR1', cpf: CPF_ERR } });
    expect((rt.body as { pendencias: string[] }).pendencias).toContain('pagador_anulado');
    // Lote do Receita Saúde: os dois recebimentos do paciente com a pendência.
    const lote = await post(finA, '/financeiro/receita-saude/lotes', { profissionalId: profissionalPfA, de: hoje(), ate: hoje() });
    expect(lote.status, JSON.stringify(lote.body)).toBe(200);
    const doPac = (lote.body as { itens: { pendencias: string[]; beneficiario: { nome: string } }[] }).itens.filter(
      (i) => i.beneficiario.nome === 'Paciente Ficticio Pagador Anulado',
    );
    expect(doPac).toHaveLength(2);
    for (const i of doPac) expect(i.pendencias).toContain('pagador_anulado');
    // Trilha: a anulação registra quantos recebimentos estavam atribuídos (só a contagem).
    const trilha = await withTenant(api.db.db, clinicaA, (tx) =>
      tx.select({ m: auditLog.metadata }).from(auditLog).where(and(eq(auditLog.scope, 'patient_guardians'), sql`${auditLog.metadata}->>'link_id' = ${errado.id}`, sql`${auditLog.metadata}->>'reason' = 'cadastro_errado'`)).orderBy(sql`seq`));
    expect(trilha.map((t) => (t.m as { payments_attributed?: number }).payments_attributed)).toEqual([2]);
    expect(JSON.stringify(trilha)).not.toContain('QZR1');
  });
});

describe('R2 do 2º parecer do #67: saneamento de pagador_responsavel pelo financeiro', () => {
  it('grava o pagador congelado UMA vez, só pelo financeiro, com vínculo vigente na data; recibo emitido não muda', async () => {
    const pac = await paciente(recepA, { nome: 'Paciente Ficticio Saneamento', cpf: cpfFicticio(860), nascimento: nascidoHa(10) });
    const outroPac = await paciente(recepA, { nome: 'Paciente Ficticio Outro Saneamento', nascimento: nascidoHa(10) });
    const CPF_MAE = cpfFicticio(861);
    // Responsável sem a marca de pagador: os recebimentos ficam SEM congelado (como os anteriores à 0031).
    const mae = await responsavel(recepA, pac, { nome: 'Mae Ficticia Saneamento QZS2', cpf: CPF_MAE, tipo: 'pai_mae' });
    const alheio = await responsavel(recepA, outroPac, { nome: 'Resp Ficticio Alheio', tipo: 'pai_mae' });
    const anulado = await responsavel(recepA, pac, { nome: 'Resp Ficticio Anulado Saneamento', tipo: 'tutor' });
    await post(recepA, `/pacientes/${pac}/responsaveis/${anulado.id}/anular`, { motivo: 'Cadastro ficticio feito por engano' }).expect(200);
    const comRecibo = await receberSemRecibo(pac);
    const semRecibo = await receberSemRecibo(pac);
    const naoMexe = await receberSemRecibo(pac);
    const recibo = (await post(finA, `/financeiro/recebimentos/${comRecibo}/recibo`)).body as { id: string; pendencias: string[]; pagador: { nome: string } };
    expect(recibo.pendencias).toContain('pagador_responsavel');

    const rota = (p: string) => `/financeiro/recebimentos/${p}/pagador-responsavel`;
    // Recepção e profissional não saneiam (403); corpo sem vínculo: 400; vínculo de outro paciente: 404.
    expect((await post(recepA, rota(comRecibo), { vinculoId: mae.id })).status).toBe(403);
    expect((await post(profA, rota(comRecibo), { vinculoId: mae.id })).status).toBe(403);
    expect((await post(finA, rota(comRecibo), {})).status).toBe(400);
    expect((await post(finA, rota(comRecibo), { vinculoId: alheio.id })).status).toBe(404);
    // Vínculo anulado (cadastro errado) não é responsável vigente na data: 409.
    expect((await post(finA, rota(comRecibo), { vinculoId: anulado.id })).body).toMatchObject({ codigo: 'vinculo_nao_vigente_no_recebimento' });

    // Financeiro saneia: 200; o recibo já emitido é apontado (não muda).
    const ok = await post(finA, rota(comRecibo), { vinculoId: mae.id });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toEqual({ recebimentoId: comRecibo, vinculoId: mae.id, reciboVivoId: recibo.id });
    // Uma única vez.
    expect((await post(adminA, rota(comRecibo), { vinculoId: mae.id })).body).toMatchObject({ codigo: 'pagador_ja_congelado' });
    const [linha] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(payments).where(eq(payments.id, comRecibo)), recepA.userId);
    expect(linha).toMatchObject({ guardianPayerLinkId: mae.id, guardianPayerResolvedBy: finA.userId });
    expect(linha?.guardianPayerEnc).toMatch(/^v1:/);
    expect(linha?.guardianPayerResolvedAt).toBeTruthy();
    expect(JSON.stringify(linha)).not.toContain(CPF_MAE);
    expect(((await get(finA, `/financeiro/recibos/${recibo.id}`)).body as { pendencias: string[] }).pendencias).toContain('pagador_responsavel');

    // Recebimento saneado ANTES de emitir: o recibo sai com a mãe e sem a pendência; o lote idem.
    await post(finA, rota(semRecibo), { vinculoId: mae.id }).expect(200);
    const novo = (await post(finA, `/financeiro/recebimentos/${semRecibo}/recibo`)).body as { pendencias: string[]; pagador: unknown };
    expect(novo.pagador).toEqual({ nome: 'Mae Ficticia Saneamento QZS2', cpf: CPF_MAE });
    expect(novo.pendencias).not.toContain('pagador_responsavel');
    const lote = await post(finA, '/financeiro/receita-saude/lotes', { profissionalId: profissionalPfA, de: hoje(), ate: hoje() });
    const doPac = (lote.body as { itens: { pendencias: string[]; pagador: { cpf: string | null }; beneficiario: { nome: string } }[] }).itens.filter(
      (i) => i.beneficiario.nome === 'Paciente Ficticio Saneamento',
    );
    expect(doPac.map((i) => i.pagador.cpf === CPF_MAE && !i.pendencias.includes('pagador_responsavel'))).toEqual([true, true, false]);

    // Banco: o profissional (perfil ativo, sem financeiro) não saneia nem pela função (42501); vínculo de
    // outro paciente é recusado (23514); o runtime não faz UPDATE direto em payments (42501).
    const [selo] = await withTenant(api.db.db, clinicaA, (tx) => tx.select({ enc: payments.guardianPayerEnc }).from(payments).where(eq(payments.id, comRecibo)), recepA.userId);
    expect(
      await sqlstate(withTenant(api.db.db, clinicaA, (tx) => tx.execute(sql`select app_payment_resolve_guardian_payer(${naoMexe}::uuid, ${mae.id}::uuid, ${selo!.enc})`), profA.userId)),
    ).toContain('42501');
    expect(
      await sqlstate(withTenant(api.db.db, clinicaA, (tx) => tx.execute(sql`select app_payment_resolve_guardian_payer(${naoMexe}::uuid, ${alheio.id}::uuid, ${selo!.enc})`), finA.userId)),
    ).toContain('23514');
    expect(
      await sqlstate(
        withTenant(api.db.db, clinicaA, (tx) => tx.update(payments).set({ guardianPayerLinkId: mae.id, guardianPayerEnc: selo!.enc, guardianPayerResolvedBy: finA.userId }).where(eq(payments.id, naoMexe)), finA.userId),
      ),
    ).toContain('42501');
    // Trilha: só ids.
    const trilha = JSON.stringify(
      await withTenant(api.db.db, clinicaA, (tx) => tx.select({ m: auditLog.metadata }).from(auditLog).where(sql`${auditLog.metadata}->>'op' = 'guardian_payer_resolution'`)),
    );
    expect(trilha).toContain(comRecibo);
    for (const proibido of [CPF_MAE, 'QZS2']) expect(trilha).not.toContain(proibido);
  });
});

describe('ressalvas do #67: curatela, emancipação, anulação, CPF mascarado e ciência do adulto', () => {
  it('curatela exige decisão judicial e escopo (cifrados), não vale para menor e só depende da decisão do profissional', async () => {
    const adulto = await paciente(recepA, { nome: 'Paciente Ficticio Curatelado', nascimento: nascidoHa(40) });
    const menor = await paciente(recepA, { nome: 'Paciente Ficticio Menor Curatela', nascimento: nascidoHa(10) });
    const REF = 'Processo ficticio de curatela QZC0001';
    expect((await post(recepA, `/pacientes/${adulto}/responsaveis`, { nome: 'Curador Ficticio', tipo: 'curador' })).status).toBe(400);
    const curatela = { curatelaReferencia: REF, curatelaEscopo: 'Atos patrimoniais e negociais (ficticio)' };
    expect((await post(recepA, `/pacientes/${menor}/responsaveis`, { nome: 'Curador Ficticio', tipo: 'curador', ...curatela })).body).toMatchObject({
      codigo: 'curatela_de_menor',
    });
    const c = await responsavel(recepA, adulto, { nome: 'Curador Ficticio', tipo: 'curador', ...curatela });
    // Curatela não libera informação clínica por si: sem decisão do profissional, a marca está desligada.
    expect(c.informacaoClinica.motivo).toBe('marca_desligada');
    const [linha] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(patientGuardians).where(eq(patientGuardians.id, c.id)), recepA.userId);
    expect(linha?.courtDecisionRefEnc).toMatch(/^v1:/);
    expect(JSON.stringify(linha)).not.toContain('QZC0001');
    // Referência visível para admin; recepção não vê.
    expect((c as unknown as { curatela: unknown }).curatela).toBeNull();
    const pelaAdmin = ((await get(adminA, `/pacientes/${adulto}/responsaveis`)).body as { itens: { curatela: { referencia: string } | null }[] }).itens;
    expect(pelaAdmin[0]?.curatela?.referencia).toBe(REF);
    // Com a decisão do profissional: permitida para o adulto curatelado.
    await cuidar(adulto);
    const lig = await patch(profA, `/pacientes/${adulto}/responsaveis/${c.id}`, { recebeInformacaoClinica: true, justificativa: JUSTIFICATIVA });
    expect((lig.body as Resp).informacaoClinica).toEqual({ permitida: true, motivo: 'permitida' });
  });

  it('0055: apoiador exige o termo e os limites (cifrados), não vale para menor nem sem nascimento; informação clínica só com decisão E autorização do paciente', async () => {
    const adulto = await paciente(recepA, { nome: 'Paciente Ficticio Apoiado', nascimento: nascidoHa(38) });
    const menor = await paciente(recepA, { nome: 'Paciente Ficticio Menor Apoio', nascimento: nascidoHa(12) });
    const REF = 'Termo ficticio de decisao apoiada QZA0001';
    const apoio = { apoioReferencia: REF, apoioEscopo: 'Apoio em decisoes de saude (ficticio)' };
    expect((await post(recepA, `/pacientes/${adulto}/responsaveis`, { nome: 'Apoiador Ficticio', tipo: 'apoiador' })).status).toBe(400);
    // Os campos da curatela não servem para o apoiador, nem os do apoio para outro tipo.
    expect((await post(recepA, `/pacientes/${adulto}/responsaveis`, { nome: 'Apoiador Ficticio', tipo: 'apoiador', curatelaReferencia: REF, curatelaEscopo: 'x'.repeat(5) })).status).toBe(400);
    expect((await post(recepA, `/pacientes/${adulto}/responsaveis`, { nome: 'Rep Ficticio', tipo: 'representante', ...apoio })).status).toBe(400);
    expect((await post(recepA, `/pacientes/${menor}/responsaveis`, { nome: 'Apoiador Ficticio', tipo: 'apoiador', ...apoio })).body).toMatchObject({ codigo: 'apoio_de_menor' });
    // R2: sem data de nascimento não se presume a maioridade.
    const semData = await paciente(recepA, { nome: 'Paciente Ficticio Apoio Sem Data' });
    expect((await post(recepA, `/pacientes/${semData}/responsaveis`, { nome: 'Apoiador Ficticio', tipo: 'apoiador', ...apoio })).body).toMatchObject({ codigo: 'apoio_sem_data_de_nascimento' });
    // R5: apoiador pagador de adulto também exige a ciência do paciente.
    expect((await post(recepA, `/pacientes/${adulto}/responsaveis`, { nome: 'Apoiador Ficticio', tipo: 'apoiador', ...apoio, pagador: true })).body).toMatchObject({ codigo: 'ciencia_do_paciente_obrigatoria' });
    const a = await responsavel(recepA, adulto, { nome: 'Apoiador Ficticio', tipo: 'apoiador', ...apoio });
    expect(a.informacaoClinica.motivo).toBe('marca_desligada');
    const [linha] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(patientGuardians).where(eq(patientGuardians.id, a.id)), recepA.userId);
    expect(linha?.kind).toBe('apoiador');
    expect(linha?.courtDecisionRefEnc).toMatch(/^v1:/);
    expect(JSON.stringify(linha)).not.toContain('QZA0001');
    // Termo visível só para quem vê a curatela, e no campo próprio (nunca em `curatela`).
    const pelaAdmin = ((await get(adminA, `/pacientes/${adulto}/responsaveis`)).body as { itens: { termoDeApoio: { referencia: string } | null; curatela: unknown }[] }).itens;
    expect(pelaAdmin[0]).toMatchObject({ termoDeApoio: { referencia: REF }, curatela: null });
    expect((a as unknown as { termoDeApoio: unknown }).termoDeApoio).toBeNull();
    // Banco: apoiador sem o termo é recusado (CHECK da 0055).
    const pessoa = linha?.guardianId as string;
    expect(
      await sqlstate(
        withTenant(api.db.db, clinicaA, (tx) =>
          tx.insert(patientGuardians).values({ tenantId: clinicaA, patientId: menor, guardianId: pessoa, kind: 'apoiador', validFrom: hoje(), createdBy: recepA.userId, updatedBy: recepA.userId }),
          recepA.userId),
      ),
    ).toContain('23514');
    // WhatsApp: o banco não deixa o lembrete do paciente ir ao apoiador (vínculo vigente, mas não representa).
    const [wa] = await withTenant(
      api.db.db,
      clinicaA,
      (tx) => tx.execute<{ ok: boolean }>(sql`select app_whatsapp_guardian_ok(${clinicaA}::uuid, ${adulto}::uuid, ${pessoa}::uuid) as ok`),
      recepA.userId,
    );
    expect(wa?.ok).toBe(false);
    // B1: a decisão do profissional sozinha não basta; o apoiado é capaz e precisa autorizar.
    await cuidar(adulto);
    const rota = `/pacientes/${adulto}/responsaveis/${a.id}`;
    expect((await patch(profA, rota, { recebeInformacaoClinica: true, justificativa: JUSTIFICATIVA })).body).toMatchObject({ codigo: 'autorizacao_do_paciente_obrigatoria' });
    const lig = await patch(profA, rota, { recebeInformacaoClinica: true, justificativa: JUSTIFICATIVA, autorizacaoDoPaciente: true });
    expect(lig.status, JSON.stringify(lig.body)).toBe(200);
    expect((lig.body as Resp).informacaoClinica).toEqual({ permitida: true, motivo: 'permitida' });
    const autorizacao = async () =>
      (await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(patientGuardians).where(eq(patientGuardians.id, a.id)), recepA.userId))[0];
    expect(await autorizacao()).toMatchObject({ patientAuthorizedBy: profA.userId });
    // Banco: sem a coluna da autorização, a marca do apoiador não fica ligada; nem dá para trocar quem autorizou
    // sem nova decisão.
    expect(await sqlstate(withTenant(api.db.db, clinicaA, (tx) => tx.update(patientGuardians).set({ patientAuthorizedBy: null, patientAuthorizedAt: null, updatedBy: profA.userId }).where(eq(patientGuardians.id, a.id)), profA.userId))).toContain('42501');
    expect(await sqlstate(withTenant(api.db.db, clinicaA, (tx) => tx.update(patientGuardians).set({ patientAuthorizedBy: recepA.userId, updatedBy: recepA.userId }).where(eq(patientGuardians.id, a.id)), recepA.userId))).toContain('42501');
    // Revogar = desligar a marca: a autorização some junto.
    const desl = await patch(recepA, rota, { recebeInformacaoClinica: false });
    expect((desl.body as Resp).informacaoClinica.motivo).toBe('marca_desligada');
    expect(await autorizacao()).toMatchObject({ patientAuthorizedBy: null, patientAuthorizedAt: null });
    // C1: autorização e revogação ficam na trilha.
    const trilha = await withTenant(
      api.db.db,
      clinicaA,
      (tx) => tx.select().from(auditLog).where(and(eq(auditLog.scope, 'patient_guardians'), sql`${auditLog.metadata}->>'link_id' = ${a.id}`)).orderBy(sql`seq`),
      recepA.userId,
    );
    expect(trilha.some((e) => (e.metadata as Record<string, unknown>).patient_authorized === true)).toBe(true);
    expect(trilha.some((e) => (e.metadata as Record<string, unknown>).patient_authorization_revoked === true)).toBe(true);
    // A autorização não cabe em outro tipo.
    const outro = await responsavel(recepA, adulto, { nome: 'Rep Ficticio Autorizacao', tipo: 'representante' });
    expect((await patch(profA, `/pacientes/${adulto}/responsaveis/${outro.id}`, { recebeInformacaoClinica: true, justificativa: JUSTIFICATIVA, autorizacaoDoPaciente: true })).status).toBe(400);
  });

  it('A3 do #67: pai/mãe ou tutor de paciente MAIOR só com confirmação explícita (registrada na trilha)', async () => {
    const adulto = await paciente(recepA, { nome: 'Paciente Ficticio Maior Pai', nascimento: nascidoHa(25) });
    for (const tipo of ['pai_mae', 'tutor']) {
      expect((await post(recepA, `/pacientes/${adulto}/responsaveis`, { nome: `Resp Ficticio ${tipo}`, tipo })).body).toMatchObject({
        codigo: 'pai_mae_tutor_de_maior_requer_confirmacao',
      });
    }
    // A confirmação só cabe a pai/mãe e tutor.
    expect((await post(recepA, `/pacientes/${adulto}/responsaveis`, { nome: 'Rep Ficticio', tipo: 'representante', confirmaPacienteMaior: true })).status).toBe(400);
    const ok = await responsavel(recepA, adulto, { nome: 'Mae Ficticia De Adulto', tipo: 'pai_mae', confirmaPacienteMaior: true });
    const [ev] = await withTenant(
      api.db.db,
      clinicaA,
      (tx) => tx.select().from(auditLog).where(and(eq(auditLog.scope, 'patient_guardians'), sql`${auditLog.metadata}->>'link_id' = ${ok.id}`)),
      recepA.userId,
    );
    expect(ev?.metadata).toMatchObject({ kind: 'pai_mae', adult_patient_confirmed: true });
    // Menor e paciente sem data de nascimento não pedem a confirmação.
    const menor = await paciente(recepA, { nome: 'Paciente Ficticio Menor Pai', nascimento: nascidoHa(5) });
    await responsavel(recepA, menor, { nome: 'Pai Ficticio De Menor', tipo: 'pai_mae' });
    const semData = await paciente(recepA, { nome: 'Paciente Ficticio Sem Data Pai' });
    await responsavel(recepA, semData, { nome: 'Pai Ficticio Sem Data', tipo: 'pai_mae' });
  });

  it('emancipação: encerra pai/mãe e tutor hoje, acaba a menoridade; imutável; fora de 16–17 anos recusada', async () => {
    const pac = await paciente(recepA, { nome: 'Paciente Ficticio Emancipado', nascimento: nascidoHa(17) });
    const pai = await responsavel(recepA, pac, { nome: 'Pai Ficticio Emancipacao', tipo: 'pai_mae', pagador: true });
    expect((await post(finA, `/pacientes/${pac}/responsaveis/emancipacao`, { data: hoje(), documento: 'Escritura ficticia 1' })).status).toBe(403);
    const r = await post(recepA, `/pacientes/${pac}/responsaveis/emancipacao`, { data: hoje(), documento: 'Escritura ficticia QZE0001' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const lista = (await get(recepA, `/pacientes/${pac}/responsaveis?situacao=todos`)).body as { itens: Resp[]; menorDeIdade: boolean; pendencias: string[] };
    expect(lista).toMatchObject({ menorDeIdade: false, pendencias: [] });
    expect(lista.itens.find((i) => i.id === pai.id)?.encerramento?.motivo).toBe('emancipacao');
    expect((await post(recepA, `/pacientes/${pac}/responsaveis/emancipacao`, { data: hoje(), documento: 'Outra ficticia' })).body).toMatchObject({
      codigo: 'emancipacao_ja_registrada',
    });
    const novo = await paciente(recepA, { nome: 'Paciente Ficticio Quinze', nascimento: nascidoHa(15) });
    expect((await post(recepA, `/pacientes/${novo}/responsaveis/emancipacao`, { data: hoje(), documento: 'Escritura ficticia 2' })).body).toMatchObject({
      codigo: 'emancipacao_fora_da_idade',
    });
    expect((await post(recepA, `/pacientes/${pac}/responsaveis/${pai.id}/encerrar`, { motivo: 'emancipacao' })).status).toBe(400);
    const [p] = await withTenant(api.db.db, clinicaA, (tx) => tx.execute<{ ref: string }>(sql`select emancipation_ref_enc as ref from patients where id = ${pac}`), recepA.userId);
    expect(String(p?.ref)).toMatch(/^v1:/);
  });

  it('anulação de cadastro errado: motivo cifrado, prazo de descarte; descarte apaga a pessoa e não muda recibo nem pagador congelado', async () => {
    const pac = await paciente(recepA, { nome: 'Paciente Ficticio Anulacao', nascimento: nascidoHa(6) });
    const CPF_ERRADO = cpfFicticio(894);
    const errado = await responsavel(recepA, pac, { nome: 'Resp Ficticio Errado QZA0001', cpf: cpfFicticio(895), tipo: 'pai_mae', pagador: true });
    // Corrige o CPF (o anterior vai cifrado ao histórico) e recebe um pagamento com ele pagador.
    await patch(recepA, `/pacientes/${pac}/responsaveis/${errado.id}`, { cpf: CPF_ERRADO }).expect(200);
    const pago = await receberSemRecibo(pac);
    const reciboAntes = (await post(finA, `/financeiro/recebimentos/${pago}/recibo`)).body as { pagador: unknown; id: string };
    expect(reciboAntes.pagador).toEqual({ nome: 'Resp Ficticio Errado QZA0001', cpf: CPF_ERRADO });
    expect((await post(recepA, `/pacientes/${pac}/responsaveis/${errado.id}/encerrar`, { motivo: 'cadastro_errado' })).status).toBe(400);
    expect((await post(recepA, `/pacientes/${pac}/responsaveis/${errado.id}/anular`, { motivo: 'curto' })).status).toBe(400);
    const an = await post(recepA, `/pacientes/${pac}/responsaveis/${errado.id}/anular`, { motivo: 'Pessoa ficticia cadastrada no paciente errado' });
    expect(an.status, JSON.stringify(an.body)).toBe(200);
    const anulado = an.body as Resp & { descarteApos: string };
    expect(anulado.encerramento?.motivo).toBe('cadastro_errado');
    expect(anulado.vigencia).toMatchObject({ desde: errado.vigencia.desde, ate: errado.vigencia.desde, vigente: false });
    expect(anulado.descarteApos > hoje()).toBe(true);
    // Antes do prazo: o descarte não elimina nada desta pessoa (nem direto no banco).
    expect(((await post(adminA, '/responsaveis/descarte')).body as { descartados: number }).descartados).toBe(0);
    expect((await post(recepA, '/responsaveis/descarte')).status).toBe(403);
    expect(
      await sqlstate(
        withTenant(api.db.db, clinicaA, (tx) =>
          tx.update(guardians).set({ nameEnc: null, cpfEnc: null, phoneEnc: null, discardedAt: new Date() }).where(eq(guardians.id, errado.responsavelId)), recepA.userId),
      ),
    ).toContain('55000');
    // Outra pessoa anulada com o prazo vencendo HOJE (direto no banco: a API sempre dá o prazo cheio).
    const outro = await responsavel(recepA, pac, { nome: 'Resp Ficticio Vence Hoje QZA0002', cpf: cpfFicticio(896), tipo: 'tutor' });
    await patch(recepA, `/pacientes/${pac}/responsaveis/${outro.id}`, { telefone: '11900008896' }).expect(200);
    const [selo] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(guardians).where(eq(guardians.id, outro.responsavelId)), recepA.userId);
    await withTenant(api.db.db, clinicaA, (tx) =>
      tx
        .update(patientGuardians)
        .set({ validUntil: outro.vigencia.desde, endReason: 'cadastro_errado', annulReasonEnc: selo!.nameEnc, discardAfter: hoje(), endedAt: new Date(), endedBy: recepA.userId, updatedBy: recepA.userId })
        .where(eq(patientGuardians.id, outro.id)), recepA.userId);
    const run = await post(adminA, '/responsaveis/descarte');
    expect(run.body).toEqual({ descartados: 1 });
    const [desc] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(guardians).where(eq(guardians.id, outro.responsavelId)), recepA.userId);
    expect(desc).toMatchObject({ nameEnc: null, cpfEnc: null, phoneEnc: null });
    expect(desc?.discardedAt).toBeTruthy();
    const hist = await withTenant(api.db.db, clinicaA, (tx) =>
      tx.select().from(patientGuardianHistory).where(eq(patientGuardianHistory.guardianId, outro.responsavelId)).orderBy(patientGuardianHistory.seq), recepA.userId);
    expect(hist.map((h) => h.event)).toContain('responsavel_descartado');
    expect(hist.every((h) => h.prevNameEnc === null && h.prevCpfEnc === null && h.prevPhoneEnc === null)).toBe(true);
    // Pessoa descartada é terminal e não se vincula de novo.
    expect((await post(recepA, `/pacientes/${pac}/responsaveis`, { responsavelId: outro.responsavelId, tipo: 'tutor' })).body).toMatchObject({ codigo: 'responsavel_descartado' });
    // O recibo já emitido e o pagador congelado do recebimento NÃO mudam com a anulação.
    expect(((await get(finA, `/financeiro/recibos/${reciboAntes.id}`)).body as { pagador: unknown }).pagador).toEqual({ nome: 'Resp Ficticio Errado QZA0001', cpf: CPF_ERRADO });
    const [pg] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(payments).where(eq(payments.id, pago)), recepA.userId);
    expect(pg?.guardianPayerEnc).toMatch(/^v1:/);
    // Trilha sem o motivo nem dados da pessoa.
    const trilha = JSON.stringify(await withTenant(api.db.db, clinicaA, (tx) => tx.select({ m: auditLog.metadata }).from(auditLog).where(eq(auditLog.scope, 'patient_guardians'))));
    for (const proibido of ['paciente errado', 'QZA0001', CPF_ERRADO]) expect(trilha).not.toContain(proibido);
  });

  it('CPF do responsável: completo só para admin e financeiro; mascarado para profissional e recepção', async () => {
    const pac = await paciente(recepA, { nome: 'Paciente Ficticio Mascara', nascimento: nascidoHa(8) });
    const CPF = cpfFicticio(897);
    await responsavel(recepA, pac, { nome: 'Resp Ficticio Mascara', cpf: CPF, tipo: 'pai_mae' });
    const cpfDe = async (s: Sessao) => (((await get(s, `/pacientes/${pac}/responsaveis`)).body as { itens: Resp[] }).itens[0]?.cpf);
    expect(await cpfDe(adminA)).toBe(CPF);
    expect(await cpfDe(finA)).toBe(CPF);
    expect(await cpfDe(profA)).toBe(mascararCpf(CPF));
    expect(await cpfDe(recepA)).toBe(mascararCpf(CPF));
    expect(mascararCpf(CPF)).toMatch(/^\*\*\*\.\*\*\*\.\d{3}-\*\*$/);
  });

  it('pagador terceiro de paciente ADULTO exige a ciência do paciente (registrada pelo banco)', async () => {
    const adulto = await paciente(recepA, { nome: 'Paciente Ficticio Adulto Pagador', nascimento: nascidoHa(70) });
    expect((await post(recepA, `/pacientes/${adulto}/responsaveis`, { nome: 'Filha Ficticia', tipo: 'representante', pagador: true })).body).toMatchObject({
      codigo: 'ciencia_do_paciente_obrigatoria',
    });
    const ok = await responsavel(recepA, adulto, { nome: 'Filha Ficticia', tipo: 'representante', pagador: true, cienciaDoPaciente: true });
    expect((ok as unknown as { pagadorComCienciaDoPaciente: boolean }).pagadorComCienciaDoPaciente).toBe(true);
    const [linha] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(patientGuardians).where(eq(patientGuardians.id, ok.id)), recepA.userId);
    expect(linha?.payerPatientAwareBy).toBe(recepA.userId);
    const outro = await responsavel(recepA, adulto, { nome: 'Filho Ficticio', tipo: 'representante' });
    expect((await post(recepA, `/pacientes/${adulto}/responsaveis/${outro.id}/pagador`, { pagador: true })).body).toMatchObject({ codigo: 'ciencia_do_paciente_obrigatoria' });
    await post(recepA, `/pacientes/${adulto}/responsaveis/${outro.id}/pagador`, { pagador: true, cienciaDoPaciente: true }).expect(200);
  });
});

/**
 * Envelhece em 21 anos o cadastro do paciente e os eventos dos vínculos dele (papel de MIGRAÇÃO; o runtime
 * não consegue: o histórico é append-only e `occurred_at` é do banco). Só para simular a guarda vencida.
 */
async function envelhecer(pacienteId: string): Promise<void> {
  const url = process.env.DATABASE_MIGRATOR_URL;
  if (!url) throw new Error('DATABASE_MIGRATOR_URL é obrigatória para simular a guarda vencida');
  const op = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    await op.begin(async (t) => {
      await t`select app_set_tenant(${clinicaA}::uuid)`;
      await t`alter table patient_guardian_history disable trigger patient_guardian_history_no_update_delete`;
      await t`update patient_guardian_history h set occurred_at = h.occurred_at - interval '21 years'
                from patient_guardians v where v.tenant_id = h.tenant_id and v.id = h.link_id and v.patient_id = ${pacienteId}::uuid`;
      await t`alter table patient_guardian_history enable trigger patient_guardian_history_no_update_delete`;
      // N1 do #67 (0045): a guarda conta também `updated_at`.
      await t`update patients set created_at = created_at - interval '21 years', updated_at = updated_at - interval '21 years' where id = ${pacienteId}::uuid`;
    });
  } finally {
    await op.end({ timeout: 5 });
  }
}

describe('A4 do 2º parecer do #67: responsáveis na guarda de 20 anos do prontuário', () => {
  it('nada se elimina na guarda; vencida, o admin elimina vínculos e a pessoa sem outro vínculo, com trilha', async () => {
    await api.membro(clinicaA, adminA, 'admin');
    const pac = await paciente(recepA, { nome: 'Paciente Ficticio Guarda', nascimento: nascidoHa(30) });
    const irmao = await paciente(recepA, { nome: 'Paciente Ficticio Guarda Irmao', nascimento: nascidoHa(30) });
    const so = await responsavel(recepA, pac, { nome: 'Resp Ficticio So Deste QZE4', cpf: cpfFicticio(850), tipo: 'representante' });
    await patch(recepA, `/pacientes/${pac}/responsaveis/${so.id}`, { cpf: cpfFicticio(851) }).expect(200);
    const comp = await responsavel(recepA, pac, { nome: 'Resp Ficticio Compartilhado QZE5', tipo: 'representante' });
    await responsavel(recepA, irmao, { responsavelId: comp.responsavelId, tipo: 'representante' });
    // 0056 (R3 do parecer de 29/10): um pedido de sigilo gravado direto (o banco não lê a idade) some com a eliminação.
    await withTenant(api.db.db, clinicaA, (tx) =>
      tx.insert(adolescentConfidentialityRequests).values({ tenantId: clinicaA, patientId: pac, guardianLinkId: so.id, guardianId: so.responsavelId, requestedBy: profA.userId }),
      profA.userId);
    const pedidosDe = async () =>
      withTenant(api.db.db, clinicaA, (tx) => tx.select().from(adolescentConfidentialityRequests).where(eq(adolescentConfidentialityRequests.patientId, pac)), adminA.userId);
    expect(await pedidosDe()).toHaveLength(1);
    const rota = `/pacientes/${pac}/responsaveis/eliminacao`;

    // Na guarda: recepção 403; admin 409; banco recusa (55000) até para o admin.
    expect((await post(recepA, rota)).status).toBe(403);
    expect((await post(adminA, rota)).body).toMatchObject({ codigo: 'prazo_de_guarda_do_prontuario' });
    expect(await sqlstate(withTenant(api.db.db, clinicaA, (tx) => tx.execute(sql`select * from app_patient_guardians_eliminate(${pac}::uuid)`), adminA.userId))).toContain('55000');
    // A recepção não elimina nem direto no banco (42501).
    expect(
      await sqlstate(withTenant(api.db.db, clinicaA, (tx) => tx.update(patientGuardians).set({ eliminatedAt: new Date() }).where(eq(patientGuardians.id, so.id)), recepA.userId)),
    ).toContain('42501');

    // Guarda vencida, mas com vínculo vigente: 409.
    await envelhecer(pac);
    expect((await post(adminA, rota)).body).toMatchObject({ codigo: 'vinculo_vigente' });
    for (const v of [so, comp]) await post(recepA, `/pacientes/${pac}/responsaveis/${v.id}/encerrar`, { motivo: 'fim_da_representacao' }).expect(200);
    // Encerrar gerou evento novo (hoje): a guarda volta a contar dele.
    expect((await post(adminA, rota)).body).toMatchObject({ codigo: 'prazo_de_guarda_do_prontuario' });
    await envelhecer(pac);

    const r = await post(adminA, rota);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ vinculosEliminados: 2, pessoasDescartadas: 1 });
    expect(await pedidosDe()).toEqual([]);
    const links = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(patientGuardians).where(eq(patientGuardians.patientId, pac)), recepA.userId);
    expect(links.every((l) => l.eliminatedAt !== null && l.annulReasonEnc === null && l.clinicalInfoBasisEnc === null)).toBe(true);
    const [pSo] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(guardians).where(eq(guardians.id, so.responsavelId)), recepA.userId);
    expect(pSo).toMatchObject({ nameEnc: null, cpfEnc: null, phoneEnc: null });
    // A pessoa que ainda é responsável do irmão (em guarda) fica.
    const [pComp] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(guardians).where(eq(guardians.id, comp.responsavelId)), recepA.userId);
    expect(pComp?.nameEnc).toMatch(/^v1:/);
    expect(pComp?.discardedAt).toBeNull();
    const hist = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(patientGuardianHistory).where(eq(patientGuardianHistory.guardianId, so.responsavelId)), recepA.userId);
    expect(hist.map((h) => h.event)).toEqual(expect.arrayContaining(['vinculo_eliminado', 'responsavel_descartado']));
    expect(hist.every((h) => h.prevCpfEnc === null && h.prevNameEnc === null)).toBe(true);
    // Eliminado é terminal; repetir não elimina mais nada.
    expect(
      await sqlstate(withTenant(api.db.db, clinicaA, (tx) => tx.update(patientGuardians).set({ eliminatedAt: null }).where(eq(patientGuardians.id, so.id)), adminA.userId)),
    ).toContain('42501');
    expect((await post(adminA, rota)).body).toEqual({ vinculosEliminados: 0, pessoasDescartadas: 0 });
    // Trilha só com contagens.
    const trilha = JSON.stringify(
      await withTenant(api.db.db, clinicaA, (tx) => tx.select({ m: auditLog.metadata }).from(auditLog).where(sql`${auditLog.metadata}->>'op' = 'record_retention_elimination'`)),
    );
    expect(trilha).toContain(pac);
    for (const proibido of ['QZE4', 'QZE5', cpfFicticio(850), cpfFicticio(851)]) expect(trilha).not.toContain(proibido);
  });
});

/** Comandos como dono (papel de migração), numa transação, no contexto da clínica A: simula o tempo passado. */
async function comoDono(fn: (t: postgres.TransactionSql) => Promise<unknown>): Promise<void> {
  const url = process.env.DATABASE_MIGRATOR_URL;
  if (!url) throw new Error('DATABASE_MIGRATOR_URL é obrigatória para simular a guarda vencida');
  const op = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    await op.begin(async (t) => {
      await t`select app_set_tenant(${clinicaA}::uuid)`;
      await fn(t);
    });
  } finally {
    await op.end({ timeout: 5 });
  }
}

/** A guarda do paciente vai até hoje + 20 anos ('hoje+20'), já venceu ('vencida') ou outra data (a própria data). */
async function guardaDe(pacienteId: string): Promise<string> {
  const [l] = await withTenant(
    api.db.db,
    clinicaA,
    (tx) =>
      tx.execute<{ ate: string; hoje20: string; hoje: string }>(sql`select app_patient_record_retention_until(${clinicaA}::uuid, ${pacienteId}::uuid)::text as ate,
        (app_fiscal_today() + make_interval(years => 20))::date::text as hoje20, app_fiscal_today()::text as hoje`),
    recepA.userId,
  );
  if (!l) throw new Error('sem resposta');
  if (l.ate === l.hoje20) return 'hoje+20';
  if (l.ate <= l.hoje) return 'vencida';
  return l.ate;
}

/** Agendamento do profissional de profA, com check-in (sessão realizada), para consumir pacote ou guia. */
async function sessaoRealizada(pacienteId: string): Promise<string> {
  horaSeq++;
  const ag = await post(recepA, '/agendamentos', {
    pacienteId,
    profissionalId: profissionalDoProfA,
    tipoId: tipoA,
    data: `2031-06-${String(1 + (horaSeq % 28)).padStart(2, '0')}`,
    hora: `${String(6 + Math.floor(horaSeq / 28)).padStart(2, '0')}:00`,
    encaixe: true,
  });
  expect(ag.status, JSON.stringify(ag.body)).toBe(201);
  expect((await post(recepA, `/agendamentos/${id(ag)}/check-in`)).status).toBe(200);
  return id(ag);
}

describe('N1 da conferência do #67: a guarda de 20 anos conta cadastro alterado, sessões de pacote e de guia e assinaturas', () => {
  it('patients.updated_at, package_sessions, guide_sessions e guide_session_signatures alongam a guarda (0045)', async () => {
    const envelhecerCadastro = (pac: string, ambos: boolean) =>
      comoDono((t) =>
        ambos
          ? t`update patients set created_at = created_at - interval '21 years', updated_at = updated_at - interval '21 years' where id = ${pac}::uuid`
          : t`update patients set created_at = created_at - interval '21 years' where id = ${pac}::uuid`,
      );

    // (1) Cadastro criado há 21 anos mas ALTERADO hoje: a guarda conta da alteração.
    const pCad = await paciente(recepA, { nome: 'Paciente Ficticio Guarda Cadastro', nascimento: nascidoHa(40) });
    await envelhecerCadastro(pCad, false);
    expect(await guardaDe(pCad)).toBe('hoje+20');
    await comoDono((t) => t`update patients set updated_at = updated_at - interval '21 years' where id = ${pCad}::uuid`);
    expect(await guardaDe(pCad)).toBe('vencida');

    // (2) Sessão de pacote consumida hoje (cadastro antigo).
    const pPac = await paciente(recepA, { nome: 'Paciente Ficticio Guarda Pacote', nascimento: nascidoHa(40) });
    await envelhecerCadastro(pPac, true);
    expect(await guardaDe(pPac)).toBe('vencida');
    const pacote = await post(recepA, '/pacotes', { pacienteId: pPac, nome: 'Pacote Ficticio Guarda', total: 5 });
    expect(pacote.status, JSON.stringify(pacote.body)).toBe(201);
    const consumo = await post(recepA, `/pacotes/${id(pacote)}/consumos`, { agendamentoId: await sessaoRealizada(pPac) });
    expect(consumo.status, JSON.stringify(consumo.body)).toBe(201);
    expect(await guardaDe(pPac)).toBe('hoje+20');

    // (3) Sessão de guia consumida hoje; depois, com a sessão envelhecida, a ASSINATURA de hoje ainda segura.
    const pGuia = await paciente(recepA, { nome: 'Paciente Ficticio Guarda Guia', nascimento: nascidoHa(40) });
    await envelhecerCadastro(pGuia, true);
    expect(await guardaDe(pGuia)).toBe('vencida');
    const conv = await post(adminA, '/convenios', { nome: `Operadora Ficticia Guarda ${randomUUID().slice(0, 6)}`, exigeAssinatura: true });
    expect(conv.status, JSON.stringify(conv.body)).toBe(201);
    const validade = `${Number(hoje().slice(0, 4)) + 1}${hoje().slice(4)}`;
    const guia = await post(recepA, '/guias', { pacienteId: pGuia, convenioId: id(conv), numero: `FIC-G-${randomUUID().slice(0, 8)}`, sessoesAutorizadas: 5, validade });
    expect(guia.status, JSON.stringify(guia.body)).toBe(201);
    const cg = await post(recepA, `/guias/${id(guia)}/consumos`, { agendamentoId: await sessaoRealizada(pGuia) });
    expect(cg.status, JSON.stringify(cg.body)).toBe(201);
    const consumoId = (cg.body as { consumoId: string }).consumoId;
    expect(await guardaDe(pGuia)).toBe('hoje+20');
    const ass = await post(profA, `/guias/${id(guia)}/consumos/${consumoId}/assinatura`, { meio: 'papel' });
    expect(ass.status, JSON.stringify(ass.body)).toBe(201);
    await comoDono(async (t) => {
      await t`alter table guide_sessions disable trigger guide_sessions_so_estorno`;
      await t`update guide_sessions set consumed_at = consumed_at - interval '21 years' where id = ${consumoId}::uuid`;
      await t`alter table guide_sessions enable trigger guide_sessions_so_estorno`;
    });
    expect(await guardaDe(pGuia)).toBe('hoje+20');
    // Sem a assinatura recente (envelhecida também), a guarda vence: prova que era ela que segurava.
    await comoDono((t) => t`update guide_session_signatures set signed_at = signed_at - interval '21 years' where guide_session_id = ${consumoId}::uuid`);
    expect(await guardaDe(pGuia)).toBe('vencida');
  });
});

/** Portão para coordenar duas transações concorrentes. */
function portao(): { aberto: Promise<void>; abrir: () => void } {
  let abrir!: () => void;
  const aberto = new Promise<void>((r) => (abrir = r));
  return { aberto, abrir };
}
const esperar = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('N3 da conferência do #67: corrida entre recebimento e anulação do pagador (0045)', () => {
  /** Paciente menor com responsável pagador e uma cobrança PF aberta, sem pagador próprio. */
  async function cenario(sufixo: string) {
    const pac = await paciente(recepA, { nome: `Paciente Ficticio Corrida ${sufixo}`, nascimento: nascidoHa(8) });
    const v = await responsavel(recepA, pac, { nome: `Resp Ficticio Corrida QZN3${sufixo}`, tipo: 'pai_mae', pagador: true });
    horaSeq++;
    const ag = await post(recepA, '/agendamentos', {
      pacienteId: pac,
      profissionalId: profissionalPfA,
      tipoId: tipoA,
      data: `2031-07-${String(1 + (horaSeq % 28)).padStart(2, '0')}`,
      hora: `${String(6 + Math.floor(horaSeq / 28)).padStart(2, '0')}:00`,
      encaixe: true,
    });
    expect(ag.status, JSON.stringify(ag.body)).toBe(201);
    const c = await post(recepA, '/financeiro/cobrancas', { agendamentoId: id(ag), valorCentavos: 6000, atendimentoPor: 'pf' });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const [caixa] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(cashSessions).where(eq(cashSessions.status, 'open')).limit(1), recepA.userId);
    const [g] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(guardians).where(eq(guardians.id, v.responsavelId)), recepA.userId);
    return { v, chargeId: id(c), cashSessionId: caixa!.id, selo: g!.nameEnc! };
  }

  /** Recebimento direto no banco congelando o vínculo (como o serviço faz), com o paid_cents coerente. */
  const receber = (tx: TenantTx, s: Awaited<ReturnType<typeof cenario>>) =>
    tx
      .insert(payments)
      .values({ tenantId: clinicaA, chargeId: s.chargeId, cashSessionId: s.cashSessionId, method: 'dinheiro', amountCents: 6000, receivedBy: recepA.userId, guardianPayerLinkId: s.v.id, guardianPayerEnc: s.selo })
      .then(() => tx.update(charges).set({ paidCents: 6000 }).where(eq(charges.id, s.chargeId)));
  /** Anulação (cadastro errado) pelo profissional, que não opera o financeiro. */
  const anular = (tx: TenantTx, s: Awaited<ReturnType<typeof cenario>>) =>
    tx
      .update(patientGuardians)
      .set({ validUntil: s.v.vigencia.desde, endReason: 'cadastro_errado', annulReasonEnc: s.selo, discardAfter: '2099-01-01', endedAt: new Date(), endedBy: profA.userId, updatedBy: profA.userId })
      .where(eq(patientGuardians.id, s.v.id));
  const recebimentosDo = async (vinculo: string) =>
    (await withTenant(api.db.db, clinicaA, (tx) => tx.select({ id: payments.id }).from(payments).where(eq(payments.guardianPayerLinkId, vinculo)), recepA.userId)).length;
  const situacao = async (vinculo: string) =>
    (await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(patientGuardians).where(eq(patientGuardians.id, vinculo)), recepA.userId))[0]?.endReason ?? null;

  /** pid e xid da transação corrente (para identificar quem espera e quem segura). */
  const quemSou = async (tx: TenantTx) => {
    const [r] = (await tx.execute(sql`select pg_backend_pid() as pid, pg_current_xact_id()::text as xid`)) as unknown as { pid: number; xid: string }[];
    return r!;
  };
  /**
   * R4 da conferência da rodada 21: COMO `pid` está esperando. Lê pg_stat_activity e pg_locks numa
   * conexão própria (o pool da API de teste tem 2 vagas, ambas presas na corrida), com o mesmo papel
   * app_user — por isso enxerga as duas sessões. Só lê catálogo de travas; nenhum dado de paciente.
   * Devolve evento de espera, travas NÃO concedidas, travas de tupla concedidas e quem bloqueia
   * (pg_blocking_pids). Repete por até ~1 s porque a espera começa de forma assíncrona.
   */
  async function esperaDe(pid: number) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL é obrigatória');
    const sonda = postgres(url, { max: 1, onnotice: () => undefined });
    try {
      for (let i = 0; ; i++) {
        const [e] = await sonda<
          {
            tipoEspera: string | null;
            evento: string | null;
            pendentes: { locktype: string; relacao: string | null; xid: string | null; modo: string }[] | null;
            tuplasSeguradas: string[];
            bloqueadores: number[];
          }[]
        >`
          select a.wait_event_type as "tipoEspera", a.wait_event as "evento",
                 (select json_agg(json_build_object('locktype', l.locktype, 'relacao', l.relation::regclass::text,
                                  'xid', l.transactionid::text, 'modo', l.mode))
                    from pg_locks l where l.pid = a.pid and not l.granted) as "pendentes",
                 (select coalesce(json_agg(l.relation::regclass::text), '[]'::json)
                    from pg_locks l where l.pid = a.pid and l.granted and l.locktype = 'tuple') as "tuplasSeguradas",
                 pg_blocking_pids(a.pid) as "bloqueadores"
            from pg_stat_activity a where a.pid = ${pid}`;
        if (e!.tipoEspera === 'Lock' || i >= 20) return e!;
        await esperar(50);
      }
    } finally {
      await sonda.end({ timeout: 5 });
    }
  }
  /**
   * Prova discriminante do FOR SHARE (R4): quem espera, espera pela trava de LINHA de patient_guardians
   * (trava de tupla do vínculo concedida + espera no xid de quem segura), e não pela consultiva da trilha
   * (`audit_chain:<tenant>`, 0033). As duas transações daqui gravam direto no banco e não escrevem trilha,
   * então a consultiva não serializa nada. A suspeita da rodada 21 ("recebimento primeiro passa sem o
   * FOR SHARE") era artefato do pool de 2 vagas da API de teste: o teste anterior, ao falhar, deixava a
   * transação aberta e a anulação "esperava" uma vaga do pool, não uma trava do banco. Agora a conexão
   * presa é liberada no `finally` e a espera é lida em pg_locks. Sem o FOR SHARE, as duas ordens ficam
   * vermelhas (§10a do api-dominio).
   */
  function exigirEsperaPorLinhaDoVinculo(e: Awaited<ReturnType<typeof esperaDe>>, quemSegura: { pid: number; xid: string }) {
    const diag = JSON.stringify(e);
    expect(e.tipoEspera, diag).toBe('Lock');
    expect(e.evento, diag).toBe('transactionid');
    expect(e.pendentes, diag).toEqual([expect.objectContaining({ locktype: 'transactionid', xid: quemSegura.xid })]);
    expect(e.tuplasSeguradas, diag).toEqual(['patient_guardians']);
    expect(e.bloqueadores, diag).toEqual([quemSegura.pid]);
  }

  it('anulação primeiro (sem COMMIT): o recebimento espera pela linha do vínculo e, confirmada a anulação, é recusado', async () => {
    const s = await cenario('A');
    const anulou = portao();
    const segurar = portao();
    let anulacao!: { pid: number; xid: string };
    let recebimento!: { pid: number; xid: string };
    const t1 = withTenant(api.db.db, clinicaA, async (tx) => {
      await anular(tx, s);
      anulacao = await quemSou(tx);
      anulou.abrir();
      await segurar.aberto;
    }, profA.userId);
    await anulou.aberto;
    const pidPronto = portao();
    let t2Terminou = false;
    const t2 = withTenant(api.db.db, clinicaA, async (tx) => {
      recebimento = await quemSou(tx);
      pidPronto.abrir();
      await receber(tx, s);
    }, recepA.userId).finally(() => {
      t2Terminou = true;
      pidPronto.abrir();
    });
    try {
      await pidPronto.aberto;
      const espera = await esperaDe(recebimento.pid);
      // Sem o FOR SHARE, o gatilho lê a versão antiga do vínculo (ainda vigente), o recebimento passa sem
      // esperar e congela o pagador anulado: as asserções abaixo ficam vermelhas.
      expect(t2Terminou, 'o recebimento não pode terminar enquanto a anulação está aberta').toBe(false);
      exigirEsperaPorLinhaDoVinculo(espera, anulacao);
    } finally {
      segurar.abrir();
      await Promise.allSettled([t1, t2]);
    }
    await t1;
    expect(await sqlstate(t2)).toContain('23514');
    expect(await situacao(s.v.id)).toBe('cadastro_errado');
    expect(await recebimentosDo(s.v.id)).toBe(0);
  });

  it('recebimento primeiro (sem COMMIT): a anulação espera pela linha do vínculo e, confirmado o recebimento, exige quem opera o financeiro', async () => {
    const s = await cenario('B');
    const recebeu = portao();
    const segurar = portao();
    let recebimento!: { pid: number; xid: string };
    let anulacao!: { pid: number; xid: string };
    const t2 = withTenant(api.db.db, clinicaA, async (tx) => {
      await receber(tx, s);
      recebimento = await quemSou(tx);
      recebeu.abrir();
      await segurar.aberto;
    }, recepA.userId);
    await recebeu.aberto;
    const pidPronto = portao();
    let t1Terminou = false;
    const t1 = withTenant(api.db.db, clinicaA, async (tx) => {
      anulacao = await quemSou(tx);
      pidPronto.abrir();
      await anular(tx, s);
    }, profA.userId).finally(() => {
      t1Terminou = true;
      pidPronto.abrir();
    });
    try {
      await pidPronto.aberto;
      const espera = await esperaDe(anulacao.pid);
      expect(t1Terminou, 'a anulação não pode terminar enquanto o recebimento está aberto').toBe(false);
      exigirEsperaPorLinhaDoVinculo(espera, recebimento);
    } finally {
      segurar.abrir();
      await Promise.allSettled([t1, t2]);
    }
    await t2;
    // A anulação enxerga o recebimento confirmado: o profissional não anula pagador com recebimento (R1).
    expect(await sqlstate(t1)).toContain('42501');
    expect(await situacao(s.v.id)).toBeNull();
    expect(await recebimentosDo(s.v.id)).toBe(1);
  });
});

describe('maioridade e informação clínica (LGPD art. 14; CC arts. 5º e 1.767)', () => {
  it('aos 18 anos a informação clínica cai sozinha; véspera ainda vale; curatela sobrevive; sem nascimento, negada', async () => {
    const vespera = await paciente(recepA, { nome: 'Paciente Ficticio Vespera', nascimento: nascidoHa(18, 1) });
    const fez18 = await paciente(recepA, { nome: 'Paciente Ficticio Fez 18', nascimento: nascidoHa(18) });
    const semData = await paciente(recepA, { nome: 'Paciente Ficticio Sem Data' });
    for (const p of [vespera, fez18, semData]) await cuidar(p);
    const liga = { recebeInformacaoClinica: true, justificativa: JUSTIFICATIVA };
    const a = await responsavel(profA, vespera, { nome: 'Resp Ficticio A', tipo: 'pai_mae', ...liga });
    const b = await responsavel(profA, fez18, { nome: 'Resp Ficticio B', tipo: 'pai_mae', confirmaPacienteMaior: true, ...liga });
    const d = await responsavel(profA, semData, { nome: 'Resp Ficticio D', tipo: 'pai_mae', ...liga });
    // Véspera dos 18 (adolescente) com decisão tomada HOJE pelo profissional: permitida.
    expect(a.informacaoClinica).toEqual({ permitida: true, motivo: 'permitida' });
    expect(b.informacaoClinica).toEqual({ permitida: false, motivo: 'paciente_maior_de_idade' });
    expect(d.informacaoClinica).toEqual({ permitida: false, motivo: 'sem_data_de_nascimento' });
    // Decisão gravada pelo banco (autor = sessão) e justificativa só cifrada.
    const [linha] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(patientGuardians).where(eq(patientGuardians.id, a.id)), recepA.userId);
    expect(linha?.clinicalInfoDecidedBy).toBe(profA.userId);
    expect(linha?.clinicalInfoBasisEnc).toMatch(/^v1:/);
    expect(JSON.stringify(linha)).not.toContain('Avaliacao ficticia');
    // A maioridade não encerra o vínculo (o pagador segue valendo), só a informação clínica.
    expect(b.vigencia.vigente).toBe(true);
    const sem = await responsavel(recepA, vespera, { nome: 'Resp Ficticio Sem Marca', tipo: 'tutor' });
    expect(sem.informacaoClinica.motivo).toBe('marca_desligada');
  });
});

describe('permissões', () => {
  it('recepção cadastra mas não liga a informação clínica; financeiro só lê; desligar qualquer um que escreve', async () => {
    const pac = await paciente(recepA, { nome: 'Paciente Ficticio Permissoes', nascimento: nascidoHa(4) });
    const negado = await post(recepA, `/pacientes/${pac}/responsaveis`, { nome: 'Resp Ficticio', tipo: 'pai_mae', recebeInformacaoClinica: true, justificativa: JUSTIFICATIVA });
    expect(negado.status).toBe(403);
    expect(negado.body).toMatchObject({ codigo: 'liberar_informacao_clinica_sem_permissao' });
    const r = await responsavel(recepA, pac, { nome: 'Resp Ficticio', tipo: 'pai_mae' });
    const rota = `/pacientes/${pac}/responsaveis/${r.id}`;
    const liga = { recebeInformacaoClinica: true, justificativa: JUSTIFICATIVA };
    expect((await patch(recepA, rota, liga)).status).toBe(403);
    // A2 do #67: admin SEM perfil clínico não liga (nem pela API nem direto no banco).
    expect((await patch(adminA, rota, liga)).body).toMatchObject({ codigo: 'liberar_informacao_clinica_sem_permissao' });
    // Profissional sem vínculo de cuidado com o paciente: 403; sem justificativa: 400.
    expect((await patch(profA, rota, liga)).body).toMatchObject({ codigo: 'sem_vinculo_de_cuidado' });
    await cuidar(pac);
    expect((await patch(profA, rota, { recebeInformacaoClinica: true })).status).toBe(400);
    expect((await patch(profA, rota, liga)).status).toBe(200);
    expect((await patch(recepA, rota, { recebeInformacaoClinica: false })).status).toBe(200);
    // Banco: usuário sem o perfil profissional na clínica não grava a decisão (42501).
    const [g] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(guardians).limit(1), recepA.userId);
    expect(
      await sqlstate(
        withTenant(api.db.db, clinicaA, (tx) =>
          tx
            .update(patientGuardians)
            .set({ receivesClinicalInfo: true, clinicalInfoDecidedBy: adminA.userId, clinicalInfoDecidedAt: new Date(), clinicalInfoBasisEnc: g!.nameEnc, updatedBy: adminA.userId })
            .where(eq(patientGuardians.id, r.id)),
        adminA.userId),
      ),
    ).toContain('42501');
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
    await post(recepA, `/pacientes/${pac}/responsaveis/${r.id}/encerrar`, { motivo: 'substituido' }).expect(200);
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

describe('0056 (A1 b/c do #67): escopo da informação clínica e pedido de sigilo do adolescente', () => {
  type RespEscopo = Resp & { escopoInformacaoClinica: string | null; superaSigiloPorRisco: boolean };
  const liga = { recebeInformacaoClinica: true, justificativa: JUSTIFICATIVA };
  const sigilo = (pac: string) => `/pacientes/${pac}/responsaveis/sigilo`;
  const motivoDe = async (s: Sessao, pac: string, vinculo: string) =>
    ((await get(s, `/pacientes/${pac}/responsaveis`)).body as { itens: RespEscopo[] }).itens.find((i) => i.id === vinculo)?.informacaoClinica.motivo;

  it('(b) escopo: ligada sem escopo = essencial; integral só por decisão; desligar apaga; o banco não troca o escopo sem nova decisão', async () => {
    const crianca = await paciente(recepA, { nome: 'Paciente Ficticio Escopo', nascimento: nascidoHa(8) });
    await cuidar(crianca);
    const a = (await responsavel(profA, crianca, { nome: 'Mae Ficticia Escopo', tipo: 'pai_mae', ...liga })) as RespEscopo;
    expect(a.escopoInformacaoClinica).toBe('essencial');
    const b = (await responsavel(profA, crianca, { nome: 'Pai Ficticio Escopo', tipo: 'pai_mae', ...liga, escopoInformacao: 'integral' })) as RespEscopo;
    expect(b.escopoInformacaoClinica).toBe('integral');
    // Escopo sem ligar a marca: 400.
    expect((await post(recepA, `/pacientes/${crianca}/responsaveis`, { nome: 'Tio Ficticio Escopo', tipo: 'representante', escopoInformacao: 'essencial' })).status).toBe(400);
    // Banco: trocar o escopo sem nova decisão é recusado.
    expect(
      await sqlstate(withTenant(api.db.db, clinicaA, (tx) => tx.update(patientGuardians).set({ clinicalInfoScope: 'integral', updatedBy: profA.userId }).where(eq(patientGuardians.id, a.id)), profA.userId)),
    ).toContain('42501');
    // Banco: marca ligada sem escopo é recusada (gatilho antes do CHECK).
    expect(
      await sqlstate(withTenant(api.db.db, clinicaA, (tx) => tx.update(patientGuardians).set({ clinicalInfoScope: null, updatedBy: profA.userId }).where(eq(patientGuardians.id, a.id)), profA.userId)),
    ).not.toEqual([]);
    // Nova decisão troca o escopo; desligar apaga.
    const renov = await patch(profA, `/pacientes/${crianca}/responsaveis/${a.id}`, { ...liga, justificativa: `${JUSTIFICATIVA} (renovada)`, escopoInformacao: 'integral' });
    expect((renov.body as RespEscopo).escopoInformacaoClinica).toBe('integral');
    const desl = await patch(recepA, `/pacientes/${crianca}/responsaveis/${a.id}`, { recebeInformacaoClinica: false });
    expect((desl.body as RespEscopo).escopoInformacaoClinica).toBeNull();
  });

  it('(c) pedido de sigilo: só o profissional com vínculo de cuidado, só para adolescente; a marca perde o efeito para quem o pedido alcança', async () => {
    const teen = await paciente(recepA, { nome: 'Paciente Ficticio Sigilo', nascimento: nascidoHa(14) });
    await cuidar(teen);
    const pai = await responsavel(profA, teen, { nome: 'Pai Ficticio Sigilo', tipo: 'pai_mae', ...liga });
    const mae = await responsavel(profA, teen, { nome: 'Mae Ficticia Sigilo', tipo: 'pai_mae', ...liga });
    expect(pai.informacaoClinica.permitida).toBe(true);

    // Quem pode registrar.
    expect((await post(recepA, sigilo(teen), { vinculoId: pai.id })).status).toBe(403);
    expect((await post(adminA, sigilo(teen), { vinculoId: pai.id })).status).toBe(403);
    const outroProf = api.sessao(clinicaA, 'profissional');
    await api.membro(clinicaA, outroProf, 'profissional');
    expect((await post(outroProf, sigilo(teen), { vinculoId: pai.id })).status).toBe(403);
    // Só para adolescente; sem nascimento não se presume.
    const crianca = await paciente(recepA, { nome: 'Paciente Ficticio Sigilo Crianca', nascimento: nascidoHa(9) });
    const adulto = await paciente(recepA, { nome: 'Paciente Ficticio Sigilo Adulto', nascimento: nascidoHa(30) });
    const semData = await paciente(recepA, { nome: 'Paciente Ficticio Sigilo Sem Data' });
    for (const p of [crianca, adulto, semData]) await cuidar(p);
    expect((await post(profA, sigilo(crianca))).body).toMatchObject({ codigo: 'sigilo_so_para_adolescente' });
    expect((await post(profA, sigilo(adulto))).body).toMatchObject({ codigo: 'sigilo_so_para_adolescente' });
    expect((await post(profA, sigilo(semData))).body).toMatchObject({ codigo: 'nascimento_nao_informado' });
    // Vínculo de outro paciente: 404.
    const teen2 = await paciente(recepA, { nome: 'Paciente Ficticio Sigilo Outro', nascimento: nascidoHa(15) });
    await cuidar(teen2);
    expect((await post(profA, sigilo(teen2), { vinculoId: pai.id })).status).toBe(404);

    // Pedido em relação ao pai.
    const r1 = await post(profA, sigilo(teen), { vinculoId: pai.id });
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    const pedidoPai = r1.body as { id: string; vinculoId: string | null; revogadoEm: string | null };
    expect(pedidoPai).toMatchObject({ vinculoId: pai.id, revogadoEm: null });
    expect((await post(profA, sigilo(teen), { vinculoId: pai.id })).body).toMatchObject({ codigo: 'pedido_de_sigilo_ja_vigente' });
    expect(await motivoDe(profA, teen, pai.id)).toBe('sigilo_pedido_pelo_adolescente');
    expect(await motivoDe(profA, teen, mae.id)).toBe('permitida');
    // Quem não é profissional vê só que está restrita, sem saber por quê.
    expect(await motivoDe(recepA, teen, pai.id)).toBe('restrita_pelo_profissional');
    // R2: o profissional SEM vínculo de cuidado também vê só o genérico.
    expect(await motivoDe(outroProf, teen, pai.id)).toBe('restrita_pelo_profissional');
    expect((await get(recepA, sigilo(teen))).status).toBe(403);

    // Exceção por risco: só contra pedido vigente que alcance o vínculo, e só com nova decisão.
    expect((await patch(profA, `/pacientes/${teen}/responsaveis/${mae.id}`, { ...liga, superaSigiloPorRisco: true })).body).toMatchObject({
      codigo: 'sem_pedido_de_sigilo_vigente',
    });
    const risco = await patch(profA, `/pacientes/${teen}/responsaveis/${pai.id}`, { ...liga, justificativa: `${JUSTIFICATIVA} (risco)`, superaSigiloPorRisco: true });
    expect(risco.status, JSON.stringify(risco.body)).toBe(200);
    expect(risco.body as RespEscopo).toMatchObject({ informacaoClinica: { permitida: true, motivo: 'permitida' }, superaSigiloPorRisco: true });
    // Banco: a exceção por risco não liga sem nova decisão.
    expect(
      await sqlstate(withTenant(api.db.db, clinicaA, (tx) => tx.update(patientGuardians).set({ clinicalInfoRiskOverride: true, updatedBy: profA.userId }).where(eq(patientGuardians.id, mae.id)), profA.userId)),
    ).toContain('42501');

    // Pedido para TODOS, depois da exceção: alcança a mãe e também o pai (a exceção é anterior a ele).
    const r2 = await post(profA, sigilo(teen));
    expect(r2.status, JSON.stringify(r2.body)).toBe(201);
    const pedidoTodos = r2.body as { id: string; vinculoId: string | null };
    expect(pedidoTodos.vinculoId).toBeNull();
    expect(await motivoDe(profA, teen, mae.id)).toBe('sigilo_pedido_pelo_adolescente');
    expect(await motivoDe(profA, teen, pai.id)).toBe('sigilo_pedido_pelo_adolescente');

    // Revogar (a pedido do adolescente) devolve o efeito; revogado é terminal.
    expect((await post(recepA, `${sigilo(teen)}/${pedidoTodos.id}/revogar`)).status).toBe(403);
    const rev = await post(profA, `${sigilo(teen)}/${pedidoTodos.id}/revogar`);
    expect(rev.status, JSON.stringify(rev.body)).toBe(200);
    expect((rev.body as { revogadoEm: string | null }).revogadoEm).not.toBeNull();
    expect((await post(profA, `${sigilo(teen)}/${pedidoTodos.id}/revogar`)).body).toMatchObject({ codigo: 'pedido_de_sigilo_revogado' });
    expect(await motivoDe(profA, teen, mae.id)).toBe('permitida');
    // O pedido do pai continua; a exceção por risco do pai foi tomada depois dele, então vale.
    expect(await motivoDe(profA, teen, pai.id)).toBe('permitida');
    const lista = (await get(profA, sigilo(teen))).body as { id: string; revogadoEm: string | null }[];
    expect(lista.map((p) => [p.id, p.revogadoEm === null])).toEqual([
      [pedidoPai.id, true],
      [pedidoTodos.id, false],
    ]);

    // Banco: recepção não registra; nada se apaga; revogado não muda.
    expect(
      await sqlstate(
        withTenant(api.db.db, clinicaA, (tx) => tx.insert(adolescentConfidentialityRequests).values({ tenantId: clinicaA, patientId: teen, requestedBy: recepA.userId }), recepA.userId),
      ),
    ).toContain('42501');
    expect(
      await sqlstate(withTenant(api.db.db, clinicaA, (tx) => tx.delete(adolescentConfidentialityRequests).where(eq(adolescentConfidentialityRequests.id, pedidoPai.id)), profA.userId)),
    ).not.toEqual([]);
    expect(
      await sqlstate(
        withTenant(api.db.db, clinicaA, (tx) => tx.update(adolescentConfidentialityRequests).set({ revokedBy: profA.userId, revokedAt: new Date() }).where(eq(adolescentConfidentialityRequests.id, pedidoTodos.id)), profA.userId),
      ),
    ).toContain('42501');
    // Clínica B não vê o pedido.
    const deB = await withTenant(api.db.db, clinicaB, (tx) => tx.select().from(adolescentConfidentialityRequests), adminB.userId);
    expect(deB).toEqual([]);
    // Trilha só com ids: nunca nome do paciente nem do responsável.
    const trilha = await withTenant(
      api.db.db,
      clinicaA,
      (tx) => tx.select().from(auditLog).where(eq(auditLog.scope, 'adolescent_confidentiality_requests')),
      adminA.userId,
    );
    expect(trilha.length).toBeGreaterThanOrEqual(3);
    for (const proibido of ['Sigilo', 'Ficticio']) expect(JSON.stringify(trilha.map((t) => t.metadata))).not.toContain(proibido);
  });
});

describe('0056: ressalvas do parecer de 29/10 sobre o sigilo do adolescente', () => {
  const liga = { recebeInformacaoClinica: true, justificativa: JUSTIFICATIVA };
  it('R1: para quem não tem vínculo de cuidado, qualquer negativa com a marca ligada é o mesmo motivo genérico', async () => {
    const fez18 = await paciente(recepA, { nome: 'Paciente Ficticio Generico 18', nascimento: nascidoHa(18) });
    await cuidar(fez18);
    const b = await responsavel(profA, fez18, { nome: 'Resp Ficticio Generico', tipo: 'pai_mae', confirmaPacienteMaior: true, ...liga });
    expect(b.informacaoClinica.motivo).toBe('paciente_maior_de_idade');
    const pelaRecepcao = ((await get(recepA, `/pacientes/${fez18}/responsaveis`)).body as { itens: Resp[] }).itens.find((i) => i.id === b.id);
    expect(pelaRecepcao?.informacaoClinica).toEqual({ permitida: false, motivo: 'restrita_pelo_profissional' });
  });

  it('R3: o pedido sobre um responsável segue a PESSOA (encerrar e refazer o vínculo não apaga o sigilo)', async () => {
    const teen = await paciente(recepA, { nome: 'Paciente Ficticio Sigilo Pessoa', nascimento: nascidoHa(13) });
    await cuidar(teen);
    const v1 = await responsavel(profA, teen, { nome: 'Pai Ficticio Sigilo Pessoa', tipo: 'pai_mae', ...liga });
    const pedido = await post(profA, `/pacientes/${teen}/responsaveis/sigilo`, { vinculoId: v1.id });
    expect(pedido.status, JSON.stringify(pedido.body)).toBe(201);
    expect(pedido.body).toMatchObject({ vinculoId: v1.id, responsavelId: v1.responsavelId });
    await post(recepA, `/pacientes/${teen}/responsaveis/${v1.id}/encerrar`, { motivo: 'fim_da_representacao' }).expect(200);
    const v2 = await responsavel(profA, teen, { responsavelId: v1.responsavelId, tipo: 'pai_mae', ...liga });
    expect(v2.informacaoClinica.motivo).toBe('sigilo_pedido_pelo_adolescente');
    // A exceção por risco também vale para o vínculo novo da mesma pessoa.
    const risco = await patch(profA, `/pacientes/${teen}/responsaveis/${v2.id}`, { ...liga, justificativa: `${JUSTIFICATIVA} (risco)`, superaSigiloPorRisco: true });
    expect((risco.body as Resp).informacaoClinica).toEqual({ permitida: true, motivo: 'permitida' });
    // Banco: o pedido aponta para o vínculo e para a MESMA pessoa (outra pessoa = recusado).
    const outra = await responsavel(recepA, teen, { nome: 'Mae Ficticia Sigilo Pessoa', tipo: 'pai_mae' });
    expect(
      await sqlstate(
        withTenant(api.db.db, clinicaA, (tx) =>
          tx.insert(adolescentConfidentialityRequests).values({ tenantId: clinicaA, patientId: teen, guardianLinkId: v2.id, guardianId: outra.responsavelId, requestedBy: profA.userId }),
          profA.userId),
      ),
    ).toContain('23514');
  });
});

describe('0057 (R4 do parecer do apoiador): pai/mãe ou tutor de paciente maior a revisar', () => {
  type RespMaior = Resp & { confirmadoParaMaior: boolean };
  const lista = async (pac: string) => (await get(recepA, `/pacientes/${pac}/responsaveis`)).body as { itens: RespMaior[]; pendencias: string[] };
  it('confirmado no cadastro: sem pendência; cadastrado sem data e a data mostra adulto: pendência até confirmar', async () => {
    const adulto = await paciente(recepA, { nome: 'Paciente Ficticio Revisao Maior', nascimento: nascidoHa(22) });
    const mae = (await responsavel(recepA, adulto, { nome: 'Mae Ficticia Revisao', tipo: 'pai_mae', confirmaPacienteMaior: true })) as RespMaior;
    expect(mae.confirmadoParaMaior).toBe(true);
    expect((await lista(adulto)).pendencias).toEqual([]);

    const semData = await paciente(recepA, { nome: 'Paciente Ficticio Revisao Sem Data' });
    const pai = (await responsavel(recepA, semData, { nome: 'Pai Ficticio Revisao', tipo: 'pai_mae' })) as RespMaior;
    expect(pai.confirmadoParaMaior).toBe(false);
    // Confirmar antes de saber a idade: 409.
    expect((await patch(recepA, `/pacientes/${semData}/responsaveis/${pai.id}`, { confirmaPacienteMaior: true })).body).toMatchObject({ codigo: 'paciente_nao_e_maior' });
    // A data de nascimento cadastrada depois mostra um adulto (documento conferido pelo profissional).
    const corr = await api.http().patch(`/pacientes/${semData}`).set(cab(profA)).send({ nascimento: nascidoHa(30), documentoConferido: true });
    expect(corr.status, JSON.stringify(corr.body)).toBe(200);
    expect((await lista(semData)).pendencias).toEqual(['revisar_pai_mae_tutor_de_maior']);
    // Só pai/mãe e tutor se confirmam.
    const rep = await responsavel(recepA, semData, { nome: 'Rep Ficticio Revisao', tipo: 'representante' });
    expect((await patch(recepA, `/pacientes/${semData}/responsaveis/${rep.id}`, { confirmaPacienteMaior: true })).status).toBe(400);
    const conf = await patch(recepA, `/pacientes/${semData}/responsaveis/${pai.id}`, { confirmaPacienteMaior: true });
    expect(conf.status, JSON.stringify(conf.body)).toBe(200);
    expect((conf.body as RespMaior).confirmadoParaMaior).toBe(true);
    expect((await lista(semData)).pendencias).toEqual([]);
    // Repetir não muda nada (nem a data da confirmação).
    const linha = async () => (await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(patientGuardians).where(eq(patientGuardians.id, pai.id)), recepA.userId))[0];
    const primeira = (await linha())?.adultConfirmedAt;
    expect((await linha())?.adultConfirmedBy).toBe(recepA.userId);
    await patch(recepA, `/pacientes/${semData}/responsaveis/${pai.id}`, { confirmaPacienteMaior: true }).expect(200);
    expect((await linha())?.adultConfirmedAt).toEqual(primeira);
    // Banco: a confirmação não se desfaz, não muda de autor e não vale para outro tipo.
    expect(
      await sqlstate(withTenant(api.db.db, clinicaA, (tx) => tx.update(patientGuardians).set({ adultConfirmedBy: null, adultConfirmedAt: null, updatedBy: recepA.userId }).where(eq(patientGuardians.id, pai.id)), recepA.userId)),
    ).toContain('42501');
    expect(
      await sqlstate(withTenant(api.db.db, clinicaA, (tx) => tx.update(patientGuardians).set({ adultConfirmedBy: adminA.userId, updatedBy: recepA.userId }).where(eq(patientGuardians.id, pai.id)), recepA.userId)),
    ).toContain('42501');
    expect(
      await sqlstate(withTenant(api.db.db, clinicaA, (tx) => tx.update(patientGuardians).set({ adultConfirmedBy: recepA.userId, adultConfirmedAt: new Date(), updatedBy: recepA.userId }).where(eq(patientGuardians.id, rep.id)), recepA.userId)),
    ).toContain('23514');
  });

  it('encerrar o vínculo (maioridade) também resolve a pendência', async () => {
    const semData = await paciente(recepA, { nome: 'Paciente Ficticio Revisao Encerra' });
    const tutor = await responsavel(recepA, semData, { nome: 'Tutor Ficticio Revisao', tipo: 'tutor' });
    await api.http().patch(`/pacientes/${semData}`).set(cab(profA)).send({ nascimento: nascidoHa(19), documentoConferido: true }).expect(200);
    expect((await lista(semData)).pendencias).toEqual(['revisar_pai_mae_tutor_de_maior']);
    await post(recepA, `/pacientes/${semData}/responsaveis/${tutor.id}/encerrar`, { motivo: 'maioridade' }).expect(200);
    expect((await lista(semData)).pendencias).toEqual([]);
  });
});

describe('0058 (R5 do parecer do sigilo): pedido ligado ao atendimento do prontuário', () => {
  const sigilo = (pac: string) => `/pacientes/${pac}/responsaveis/sigilo`;
  /** Atendimento aberto por profA: consulta com chegada registrada há 10 minutos. */
  async function atender(pacienteId: string): Promise<string> {
    const inicio = new Date(Date.now() - 10 * 60_000);
    const [ag] = await withTenant(api.db.db, clinicaA, (tx) =>
      tx.insert(appointments).values({
        tenantId: clinicaA,
        createdBy: recepA.userId,
        patientId: pacienteId,
        professionalId: profissionalDoProfA,
        appointmentTypeId: tipoA,
        startsAt: inicio,
        endsAt: new Date(inicio.getTime() + 40 * 60_000),
        status: 'checked_in',
      }).returning(), recepA.userId);
    const at = await post(profA, '/atendimentos', { agendamentoId: (ag as { id: string }).id });
    expect(at.status, JSON.stringify(at.body)).toBe(200);
    return id(at);
  }

  it('só atendimento do mesmo paciente e do próprio profissional; gravado na criação e imutável', async () => {
    const teen = await paciente(recepA, { nome: 'Paciente Ficticio Sigilo Prontuario', nascimento: nascidoHa(13) });
    await cuidar(teen);
    const enc = await atender(teen);
    const outro = await paciente(recepA, { nome: 'Paciente Ficticio Sigilo Prontuario Outro', nascimento: nascidoHa(13) });
    await cuidar(outro);
    const encOutro = await atender(outro);
    // Atendimento de outro paciente, ou inexistente: o mesmo 409 (não revela a evolução). Id inválido: 400.
    expect((await post(profA, sigilo(teen), { atendimentoId: encOutro })).body).toMatchObject({ codigo: 'atendimento_nao_confere' });
    expect((await post(profA, sigilo(teen), { atendimentoId: randomUUID() })).body).toMatchObject({ codigo: 'atendimento_nao_confere' });
    expect((await post(profA, sigilo(teen), { atendimentoId: 'x' })).status).toBe(400);
    // Banco: outro profissional não aponta para a evolução de profA.
    const outroProf = api.sessao(clinicaA, 'profissional');
    await api.membro(clinicaA, outroProf, 'profissional');
    expect(
      await sqlstate(withTenant(api.db.db, clinicaA, (tx) => tx.insert(adolescentConfidentialityRequests).values({ tenantId: clinicaA, patientId: teen, encounterId: enc, requestedBy: outroProf.userId }), outroProf.userId)),
    ).toContain('23514');
    // O próprio profissional, no atendimento do paciente: grava e lista o id.
    const r = await post(profA, sigilo(teen), { atendimentoId: enc });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const pedido = r.body as { id: string; atendimentoId: string | null; vinculoId: string | null };
    expect(pedido).toMatchObject({ atendimentoId: enc, vinculoId: null });
    const lista = (await get(profA, sigilo(teen))).body as { id: string; atendimentoId: string | null }[];
    expect(lista.find((p) => p.id === pedido.id)?.atendimentoId).toBe(enc);
    // Banco: a referência não muda depois (nem para outro atendimento do mesmo autor).
    const enc2 = await atender(teen);
    expect(
      await sqlstate(withTenant(api.db.db, clinicaA, (tx) => tx.update(adolescentConfidentialityRequests).set({ encounterId: enc2, revokedBy: profA.userId }).where(eq(adolescentConfidentialityRequests.id, pedido.id)), profA.userId)),
    ).toContain('42501');
    // Sem atendimento continua valendo (opcional).
    const semRef = await post(profA, sigilo(outro));
    expect((semRef.body as { atendimentoId: string | null }).atendimentoId).toBeNull();
  });
});
