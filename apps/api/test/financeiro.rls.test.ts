/**
 * Financeiro (migração 0018) contra Postgres REAL: isolamento entre clínicas (pela API e pelo RLS) em
 * finance_settings, professional_fiscal_profiles, cash_sessions, charges, payments, payment_reversals,
 * receipt_counters, receipts e receipt_cancellations; numeração de recibos SEM BURACO com emissões
 * PARALELAS e com rollback; estorno; caixa que fecha (e o banco que recusa lançamento depois);
 * texto neutro; insumo do Receita Saúde; permissões e auditoria sem dado pessoal.
 * Pré-requisitos: migrações aplicadas e DATABASE_URL = papel app_user. Dados 100% fictícios.
 */
import type { TenantId, UserId } from '@plataforma/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appointments,
  auditLog,
  cashSessions,
  charges,
  financeSettings,
  packageProfessionalChanges,
  packageSessions,
  paymentReversals,
  payments,
  professionalFiscalProfiles,
  receiptCancellations,
  receiptCounters,
  receipts,
  sessionPackages,
} from '../src/db/schema';
import { withTenant } from '../src/db/tenant-transaction';
import { RetencaoFiscalService } from '../src/modules/finance/retencao-fiscal';
import { mascararCpf } from '../src/modules/patients/responsaveis.service';
import { cab, cpfFicticio, subirApi, type ApiDeTeste } from './apoio-api';

type Sessao = { Authorization: string; userId: string };

/** UUID aleatório: tirado do texto antes de procurar marcador numérico (só dígitos casariam com ele). */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
let api: ApiDeTeste;
let clinicaA: TenantId;
let clinicaB: TenantId;
let adminA: Sessao;
let recepA: Sessao;
let finA: Sessao;
let profA: Sessao;
let adminB: Sessao;
let profissionalA: string;
let profissionalPfA: string;
let tipoA: string;
let pacienteA: string;
let pacienteB: string;
let profissionalB: string;
let tipoB: string;
let caixaA: string;
let caixaB: string;
let horaSeq = 0;

/** Termos SENSÍVEIS do cadastro (tipo e especialidade): nunca podem aparecer em cobrança ou recibo. */
const TIPO_SENSIVEL = 'Psicoterapia para depressao';
const ESPECIALIDADE = 'Psicologia clinica';
const CONSELHO = 'CRP-00 00000';
const PAGADOR = 'Responsavel Ficticio Pagador';

const id = (r: { body: unknown }) => (r.body as { id: string }).id;

function post(s: Sessao, rota: string, corpo: object = {}) {
  return api.http().post(rota).set(cab(s)).send(corpo);
}
function get(s: Sessao, rota: string) {
  return api.http().get(rota).set(cab(s));
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

/** Agendamento futuro (encaixe) na clínica A, para cobrar. */
async function agendamento(opts: { s?: Sessao; prof?: string; tipo?: string; paciente?: string } = {}) {
  horaSeq++;
  const r = await post(opts.s ?? recepA, '/agendamentos', {
    pacienteId: opts.paciente ?? pacienteA,
    profissionalId: opts.prof ?? profissionalA,
    tipoId: opts.tipo ?? tipoA,
    data: `2031-03-${String(1 + (horaSeq % 28)).padStart(2, '0')}`,
    hora: `${String(6 + Math.floor(horaSeq / 28)).padStart(2, '0')}:00`,
    encaixe: true,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return id(r);
}

async function cobranca(s: Sessao, corpo: Record<string, unknown>) {
  const r = await post(s, '/financeiro/cobrancas', corpo);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; situacao: string; saldoCentavos: number; descricao: string };
}

async function receber(s: Sessao, cobrancaId: string, corpo: Record<string, unknown>) {
  const r = await post(s, `/financeiro/cobrancas/${cobrancaId}/recebimentos`, corpo);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; cobranca: { situacao: string; saldoCentavos: number } };
}

beforeAll(async () => {
  api = await subirApi();
  clinicaA = await api.novaClinica();
  clinicaB = await api.novaClinica();
  adminA = api.sessao(clinicaA, 'admin');
  recepA = api.sessao(clinicaA, 'recepcao');
  // R19 do #65 (0041): estornar sessão de pacote exige o perfil registrado no banco.
  finA = await api.membro(clinicaA, api.sessao(clinicaA, 'financeiro'), 'financeiro');
  profA = api.sessao(clinicaA, 'profissional');
  adminB = api.sessao(clinicaB, 'admin');

  profissionalA = id(await post(adminA, '/profissionais', { nome: 'Prof Ficticia Clinica', especialidade: ESPECIALIDADE, usuarioId: profA.userId }));
  profissionalPfA = id(await post(adminA, '/profissionais', { nome: 'Profissional Ficticia Autonoma', especialidade: ESPECIALIDADE }));
  tipoA = id(await post(adminA, '/tipos-atendimento', { nome: TIPO_SENSIVEL, minutos: 50 }));
  pacienteA = id(await post(recepA, '/pacientes', { nome: 'Paciente Ficticio Financeiro', telefone: '11900000301', cpf: cpfFicticio(301) }));
  pacienteB = id(await post(adminB, '/pacientes', { nome: 'Paciente Ficticio Outra Clinica', telefone: '11900000302' }));
  profissionalB = id(await post(adminB, '/profissionais', { nome: 'Prof B', especialidade: 'Fisio' }));
  tipoB = id(await post(adminB, '/tipos-atendimento', { nome: 'Sessao B', minutos: 50 }));

  const ca = await post(recepA, '/financeiro/caixas', { turno: 'manha', trocoInicialCentavos: 5000 });
  expect(ca.status, JSON.stringify(ca.body)).toBe(201);
  caixaA = id(ca);
  caixaB = id(await post(adminB, '/financeiro/caixas', { turno: 'unico' }));
});

afterAll(async () => {
  await api?.fechar();
});

describe('cobrança, recebimento e texto neutro', () => {
  it('lança do agendamento: paciente e profissional vêm do agendamento; texto neutro; nada do tipo/especialidade', async () => {
    const ag = await agendamento();
    const c = await cobranca(recepA, { agendamentoId: ag, valorCentavos: 15000 });
    expect(c).toMatchObject({ pacienteId: pacienteA, profissionalId: profissionalA, descricao: 'Atendimento', situacao: 'aberta', saldoCentavos: 15000, atendimentoPor: 'pj' });
    const serial = JSON.stringify(c);
    for (const proibido of [TIPO_SENSIVEL, 'depressao', ESPECIALIDADE, 'Psico']) expect(serial).not.toContain(proibido);
    // Uma cobrança viva por atendimento.
    const dup = await post(recepA, '/financeiro/cobrancas', { agendamentoId: ag, valorCentavos: 100 });
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ codigo: 'cobranca_ja_lancada' });
    // Parcial, depois o saldo; acima do saldo dá 409; quitada não recebe mais.
    const r1 = await receber(recepA, c.id, { valorCentavos: 5000, forma: 'cartao' });
    expect(r1.cobranca).toEqual({ situacao: 'parcial', saldoCentavos: 10000 });
    const acima = await post(recepA, `/financeiro/cobrancas/${c.id}/recebimentos`, { valorCentavos: 10001, forma: 'pix' });
    expect(acima.body).toMatchObject({ codigo: 'valor_acima_do_saldo' });
    const r2 = await receber(recepA, c.id, { forma: 'pix' });
    expect(r2.cobranca).toEqual({ situacao: 'paga', saldoCentavos: 0 });
    expect((await post(recepA, `/financeiro/cobrancas/${c.id}/recebimentos`, { forma: 'dinheiro' })).body).toMatchObject({ codigo: 'cobranca_quitada' });
    // Paga não se cancela.
    expect((await post(recepA, `/financeiro/cobrancas/${c.id}/cancelar`, { motivo: 'lancamento_errado' })).body).toMatchObject({
      codigo: 'cobranca_com_recebimento',
    });
  });

  it('sessão que consumiu pacote não gera cobrança avulsa; o pacote é cobrado inteiro (FIN-01.8)', async () => {
    const pacote = id(await post(recepA, '/pacotes', { pacienteId: pacienteA, nome: 'Pacote Ficticio', total: 4 }));
    const ag = await agendamento();
    expect((await post(recepA, `/agendamentos/${ag}/check-in`)).status).toBe(200);
    expect((await post(recepA, `/pacotes/${pacote}/consumos`, { agendamentoId: ag })).status).toBe(201);
    const avulsa = await post(recepA, '/financeiro/cobrancas', { agendamentoId: ag, valorCentavos: 100 });
    expect(avulsa.body).toMatchObject({ codigo: 'sessao_de_pacote' });
    const c = await cobranca(finA, { pacoteId: pacote, valorCentavos: 40000 });
    expect(c).toMatchObject({ pacoteId: pacote, agendamentoId: null, pacienteId: pacienteA });
    // Agendamento E pacote juntos (ou nenhum) é 400.
    expect((await post(finA, '/financeiro/cobrancas', { agendamentoId: ag, pacoteId: pacote, valorCentavos: 1 })).body).toMatchObject({ campos: ['alvo'] });
  });

  it('a clínica configura o texto; termos de diagnóstico/condição e CID são recusados sem eco', async () => {
    for (const ruim of ['Tratamento de depressao', 'Sessao F32.1', 'Diagnostico inicial', 'Atendimento TEA']) {
      const r = await api.http().put('/financeiro/configuracao').set(cab(adminA)).send({ descricaoRecibo: ruim });
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ statusCode: 400, message: 'Dados inválidos', campos: ['descricaoRecibo'] });
    }
    expect((await api.http().put('/financeiro/configuracao').set(cab(finA)).send({ descricaoRecibo: 'Consulta' })).status).toBe(403);
    const ok = await api.http().put('/financeiro/configuracao').set(cab(adminA)).send({ descricaoRecibo: 'Atendimento em saude' });
    expect(ok.status).toBe(200);
    expect((await get(recepA, '/financeiro/configuracao')).body).toMatchObject({ descricaoRecibo: 'Atendimento em saude', mostrarRegistroConselho: false });
    expect((await get(recepA, '/financeiro/configuracao')).text).toContain('Receita Federal');
    await api.http().put('/financeiro/configuracao').set(cab(adminA)).send({ descricaoRecibo: 'Atendimento' }).expect(200);
  });
});

describe('estorno e recibo', () => {
  it('estorno devolve o saldo, cancela o recibo vivo e nunca apaga; o recibo do convênio não existe', async () => {
    const c = await cobranca(recepA, { agendamentoId: await agendamento(), valorCentavos: 8000 });
    const p = await receber(recepA, c.id, { forma: 'dinheiro' });
    const rec = await post(recepA, `/financeiro/recebimentos/${p.id}/recibo`);
    expect(rec.status).toBe(200);
    // Idempotente: o mesmo recibo volta.
    expect(id(await post(recepA, `/financeiro/recebimentos/${p.id}/recibo`))).toBe(id(rec));
    // Recepção não estorna.
    expect((await post(recepA, `/financeiro/recebimentos/${p.id}/estornar`, { motivo: 'lancamento_errado' })).status).toBe(403);
    const e = await post(finA, `/financeiro/recebimentos/${p.id}/estornar`, { motivo: 'devolucao_ao_pagador' });
    expect(e.status).toBe(200);
    expect(e.body).toMatchObject({ estornado: true, reciboCancelado: id(rec), cobranca: { situacao: 'aberta', saldoCentavos: 8000 } });
    expect((await post(finA, `/financeiro/recebimentos/${p.id}/estornar`, { motivo: 'devolucao_ao_pagador' })).body).toMatchObject({
      codigo: 'recebimento_ja_estornado',
    });
    expect((await get(finA, `/financeiro/recibos/${id(rec)}`)).body).toMatchObject({ situacao: 'cancelado', cancelamento: { motivo: 'recebimento_estornado' } });
    expect((await post(recepA, `/financeiro/recebimentos/${p.id}/recibo`)).body).toMatchObject({ codigo: 'recebimento_estornado' });
    const det = await get(finA, `/financeiro/cobrancas/${c.id}`);
    expect((det.body as { recebimentos: { estornado: boolean }[] }).recebimentos).toEqual([expect.objectContaining({ estornado: true })]);
    // Convênio: sem recibo ao paciente.
    const conv = await receber(recepA, c.id, { forma: 'convenio' });
    expect((await post(recepA, `/financeiro/recebimentos/${conv.id}/recibo`)).body).toMatchObject({ codigo: 'recebimento_de_convenio' });
  });

  it('recibo: retrato com CPFs para o IR, texto neutro, sem conselho por padrão; imutável no banco', async () => {
    await api.http().put(`/financeiro/profissionais/${profissionalPfA}/perfil-fiscal`).set(cab(finA)).send({ cpf: cpfFicticio(302), registroConselho: CONSELHO }).expect(200);
    const c = await cobranca(recepA, {
      agendamentoId: await agendamento({ prof: profissionalPfA }),
      valorCentavos: 20000,
      atendimentoPor: 'pf',
      pagador: { nome: PAGADOR, cpf: cpfFicticio(303) },
    });
    const p = await receber(recepA, c.id, { forma: 'pix_manual' });
    // R8 do #65: o recebimento Pix devolve o aviso para a tela; dinheiro não.
    expect((p as unknown as { aviso: string | null }).aviso).toContain('mensagem do Pix');
    const r = await post(recepA, `/financeiro/recebimentos/${p.id}/recibo`);
    expect(r.status).toBe(200);
    const comum = { situacao: 'emitido', descricao: 'Atendimento', valorCentavos: 20000, forma: 'pix_manual', pendencias: [] };
    // 2º parecer do #67: a recepção emite e entrega, mas vê os CPFs mascarados (pagador, beneficiário, emitente PF).
    expect(r.body).toMatchObject({
      ...comum,
      cpfMascarado: true,
      emitente: { tipo: 'pf', nome: 'Profissional Ficticia Autonoma', documento: mascararCpf(cpfFicticio(302)), registroConselho: null },
      pagador: { nome: PAGADOR, cpf: mascararCpf(cpfFicticio(303)) },
      beneficiario: { nome: 'Paciente Ficticio Financeiro', cpf: mascararCpf(cpfFicticio(301)) },
    });
    for (const cpf of [cpfFicticio(301), cpfFicticio(302), cpfFicticio(303)]) expect(JSON.stringify(r.body)).not.toContain(cpf);
    expect((await get(recepA, `/financeiro/recibos/${id(r)}`)).body).toMatchObject({ cpfMascarado: true, pagador: { cpf: mascararCpf(cpfFicticio(303)) } });
    // Financeiro e admin: o mesmo recibo com os CPFs completos (o retrato gravado é o completo).
    for (const s of [finA, adminA]) {
      expect((await get(s, `/financeiro/recibos/${id(r)}`)).body).toMatchObject({
        ...comum,
        cpfMascarado: false,
        emitente: { tipo: 'pf', nome: 'Profissional Ficticia Autonoma', documento: cpfFicticio(302), registroConselho: null },
        pagador: { nome: PAGADOR, cpf: cpfFicticio(303) },
        beneficiario: { nome: 'Paciente Ficticio Financeiro', cpf: cpfFicticio(301) },
      });
    }
    const serial = JSON.stringify(r.body);
    for (const proibido of [TIPO_SENSIVEL, ESPECIALIDADE, CONSELHO, 'Psico']) expect(serial).not.toContain(proibido);
    // O cadastro muda depois; o recibo emitido não.
    await api.http().put('/financeiro/configuracao').set(cab(adminA)).send({ descricaoRecibo: 'Sessao' }).expect(200);
    expect((await get(finA, `/financeiro/recibos/${id(r)}`)).body).toMatchObject({ descricao: 'Atendimento' });
    await api.http().put('/financeiro/configuracao').set(cab(adminA)).send({ descricaoRecibo: 'Atendimento' }).expect(200);
    // No banco: conteúdo só cifrado; UPDATE/DELETE recusados (sem privilégio e por trigger).
    const [linha] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(receipts).where(eq(receipts.id, id(r))));
    expect(linha?.contentEnc).toMatch(/^v1:/);
    expect(JSON.stringify(linha)).not.toContain(cpfFicticio(303));
    expect(await sqlstate(withTenant(api.db.db, clinicaA, (tx) => tx.update(receipts).set({ number: 999 }).where(eq(receipts.id, id(r)))))).toContain('42501');
    expect(await sqlstate(withTenant(api.db.db, clinicaA, (tx) => tx.delete(receipts).where(eq(receipts.id, id(r)))))).toContain('42501');
    expect(await sqlstate(withTenant(api.db.db, clinicaA, (tx) => tx.delete(payments).where(eq(payments.id, p.id))))).toContain('42501');
    // Cancelar recibo: registro próprio; não se cancela duas vezes; recepção não cancela.
    expect((await post(recepA, `/financeiro/recibos/${id(r)}/cancelar`, { motivo: 'dados_incorretos' })).status).toBe(403);
    expect((await post(finA, `/financeiro/recibos/${id(r)}/cancelar`, { motivo: 'dados_incorretos' })).body).toMatchObject({ situacao: 'cancelado' });
    expect((await post(finA, `/financeiro/recibos/${id(r)}/cancelar`, { motivo: 'dados_incorretos' })).body).toMatchObject({ codigo: 'recibo_ja_cancelado' });
    // Reemitir gera NOVO número (o cancelado não é reaproveitado).
    const novo = await post(recepA, `/financeiro/recebimentos/${p.id}/recibo`);
    expect((novo.body as { numero: number }).numero).toBeGreaterThan((r.body as { numero: number }).numero);
  });
});

describe('numeração dos recibos sem buraco', () => {
  it('12 emissões PARALELAS em cobranças diferentes: números consecutivos, sem repetição; rollback não deixa buraco', async () => {
    const recebimentos: string[] = [];
    for (let i = 0; i < 12; i++) {
      const c = await cobranca(recepA, { agendamentoId: await agendamento(), valorCentavos: 1000 + i });
      recebimentos.push((await receber(recepA, c.id, { forma: 'cartao_debito' })).id);
    }
    // Emissão que incrementa o contador e desfaz (rollback): o número volta.
    await withTenant(api.db.db, clinicaA, async (tx) => {
      await tx
        .insert(receiptCounters)
        .values({ tenantId: clinicaA, lastNumber: 1 })
        .onConflictDoUpdate({ target: receiptCounters.tenantId, set: { lastNumber: sql`${receiptCounters.lastNumber} + 1` } });
      throw new Error('falha simulada depois de pegar o número');
    }).catch(() => undefined);
    const respostas = await Promise.all(recebimentos.map((p) => post(recepA, `/financeiro/recebimentos/${p}/recibo`)));
    for (const r of respostas) expect(r.status, JSON.stringify(r.body)).toBe(200);
    const todos = await withTenant(api.db.db, clinicaA, (tx) => tx.select({ n: receipts.number }).from(receipts));
    const numeros = todos.map((r) => r.n).sort((a, b) => a - b);
    expect(numeros).toEqual(numeros.map((_, i) => i + 1));
    const [contador] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(receiptCounters));
    expect(contador?.lastNumber).toBe(numeros.length);
    // O banco não aceita número fora da sequência nem contador que pula/volta.
    const pagamento = recebimentos[0] as string;
    expect(
      await sqlstate(
        withTenant(api.db.db, clinicaA, (tx) =>
          tx.insert(receipts).values({ tenantId: clinicaA, number: numeros.length + 5, paymentId: pagamento, contentEnc: 'v1:x', issuedBy: randomUUID() }),
        ),
      ),
    ).toEqual(expect.arrayContaining(['23514']));
    expect(
      await sqlstate(withTenant(api.db.db, clinicaA, (tx) => tx.update(receiptCounters).set({ lastNumber: numeros.length + 2 }))),
    ).toContain('23514');
    // A numeração é por clínica: a B começa do 1.
    const cb = await cobranca(adminB, { agendamentoId: await agendamento({ s: adminB, prof: profissionalB, tipo: tipoB, paciente: pacienteB }), valorCentavos: 500 });
    const pb = await receber(adminB, cb.id, { forma: 'dinheiro' });
    expect((await post(adminB, `/financeiro/recebimentos/${pb.id}/recibo`)).body).toMatchObject({ numero: 1 });
  });
});

describe('caixa do dia', () => {
  it('fecha com a conferência do dinheiro; fechado não recebe (API e banco) e não muda', async () => {
    const r = await post(finA, '/financeiro/caixas', { turno: 'tarde', trocoInicialCentavos: 2000 });
    expect(r.status).toBe(201);
    const tarde = id(r);
    expect((await post(finA, '/financeiro/caixas', { turno: 'tarde' })).body).toMatchObject({ codigo: 'caixa_ja_aberto' });
    // Dois caixas abertos hoje: sem caixaId é ambíguo.
    const c = await cobranca(recepA, { agendamentoId: await agendamento(), valorCentavos: 3000 });
    expect((await post(recepA, `/financeiro/cobrancas/${c.id}/recebimentos`, { forma: 'dinheiro' })).body).toMatchObject({ codigo: 'caixa_ambiguo' });
    const p = await receber(recepA, c.id, { forma: 'dinheiro', caixaId: tarde, valorCentavos: 1000 });
    await receber(recepA, c.id, { forma: 'cartao_credito', caixaId: tarde, valorCentavos: 500 });
    await post(finA, `/financeiro/recebimentos/${p.id}/estornar`, { motivo: 'lancamento_errado', caixaId: tarde }).expect(200);
    await receber(recepA, c.id, { forma: 'dinheiro', caixaId: tarde, valorCentavos: 700 });
    const f = await post(recepA, `/financeiro/caixas/${tarde}/fechar`, { dinheiroContadoCentavos: 2600 });
    expect(f.status).toBe(200);
    // Esperado = 2000 + (1000 + 700) − 1000 = 2700; contado 2600: falta 100.
    expect(f.body).toMatchObject({
      situacao: 'fechado',
      dinheiroEsperadoCentavos: 2700,
      dinheiroContadoCentavos: 2600,
      diferencaCentavos: -100,
      recebidoPorForma: { dinheiro: 1700, cartao_credito: 500 },
      estornadoPorForma: { dinheiro: 1000 },
      lancamentos: 4,
    });
    expect((await post(recepA, `/financeiro/caixas/${tarde}/fechar`, { dinheiroContadoCentavos: 0 })).body).toMatchObject({ codigo: 'caixa_fechado' });
    expect((await post(recepA, `/financeiro/cobrancas/${c.id}/recebimentos`, { forma: 'pix', caixaId: tarde })).body).toMatchObject({ codigo: 'caixa_fechado' });
    // Banco: lançamento direto em caixa fechado e alteração do fechado são recusados.
    expect(
      await sqlstate(
        withTenant(api.db.db, clinicaA, (tx) =>
          tx.insert(payments).values({ tenantId: clinicaA, chargeId: c.id, cashSessionId: tarde, method: 'dinheiro', amountCents: 1, receivedBy: randomUUID() }),
        ),
      ),
    ).toContain('55000');
    expect(await sqlstate(withTenant(api.db.db, clinicaA, (tx) => tx.update(cashSessions).set({ countedCashCents: 2700 }).where(eq(cashSessions.id, tarde))))).toContain(
      '55000',
    );
    // Caixa do dia: os dois turnos, com totais.
    const dia = await get(finA, '/financeiro/caixas');
    expect(dia.status).toBe(200);
    const turnos = (dia.body as { caixas: { id: string }[] }).caixas.map((x) => x.id);
    expect(turnos).toEqual(expect.arrayContaining([caixaA, tarde]));
    expect(turnos).not.toContain(caixaB);
  });
});

describe('contas a receber e Receita Saúde', () => {
  it('contas a receber: janela ≤ 31 dias, filtros, sem dado pessoal na URL', async () => {
    const r = await get(finA, '/financeiro/contas-a-receber?de=2031-03-01&ate=2031-03-31&situacao=todas');
    expect(r.status).toBe(200);
    const corpo = r.body as { itens: { pacienteId: string; situacao: string }[]; totais: { saldoCentavos: number } };
    expect(corpo.itens.length).toBeGreaterThan(0);
    expect(corpo.itens.every((i) => i.pacienteId === pacienteA)).toBe(true);
    expect(JSON.stringify(corpo)).not.toContain(TIPO_SENSIVEL);
    expect((await get(finA, '/financeiro/contas-a-receber?de=2031-03-01&ate=2031-04-01')).body).toMatchObject({ campos: ['ate'] });
    expect((await get(finA, `/financeiro/contas-a-receber?de=2031-03-01&ate=2031-03-31&cpf=${cpfFicticio(301)}`)).body).toMatchObject({
      campos: ['dado_na_url'],
    });
    const abertas = (await get(finA, '/financeiro/contas-a-receber?de=2031-03-01&ate=2031-03-31')).body as { itens: { situacao: string }[] };
    expect(abertas.itens.every((i) => i.situacao === 'aberta' || i.situacao === 'parcial')).toBe(true);
  });

  it('insumo do Receita Saúde: só PF do profissional, vivo e fora convênio; marcado como NÃO oficial', async () => {
    const ag = await agendamento({ prof: profissionalPfA });
    const c = await cobranca(finA, { agendamentoId: ag, valorCentavos: 18000, atendimentoPor: 'pf' });
    await receber(finA, c.id, { forma: 'pix', valorCentavos: 10000 });
    const estornar = await receber(finA, c.id, { forma: 'dinheiro', valorCentavos: 3000 });
    await post(finA, `/financeiro/recebimentos/${estornar.id}/estornar`, { motivo: 'lancamento_errado' }).expect(200);
    await receber(finA, c.id, { forma: 'convenio', valorCentavos: 1000 });
    // PJ do mesmo profissional fica fora.
    const pj = await cobranca(finA, { agendamentoId: await agendamento({ prof: profissionalPfA }), valorCentavos: 999, atendimentoPor: 'pj' });
    await receber(finA, pj.id, { forma: 'pix' });

    const hoje = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
    const l = await post(finA, '/financeiro/receita-saude/lotes', { profissionalId: profissionalPfA, de: hoje, ate: hoje });
    expect(l.status, JSON.stringify(l.body)).toBe(200);
    const lote = l.body as { oficial: boolean; dependeDe: string[]; emitente: { cpf: string }; itens: { valorCentavos: number; pagador: { cpf: string | null } }[]; totais: { quantidade: number } };
    expect(lote.oficial).toBe(false);
    expect(lote.dependeDe).toContain('D14');
    expect(lote.emitente.cpf).toBe(cpfFicticio(302));
    // Itens: o pix de 10000 desta cobrança e o pix de 20000 do teste do recibo (pagador terceiro).
    expect(lote.itens.map((i) => i.valorCentavos).sort((a, b) => a - b)).toEqual([10000, 20000]);
    expect(JSON.stringify(lote)).not.toContain(TIPO_SENSIVEL);
    // Recepção não gera lote; janela > 31 dias é 400.
    expect((await post(recepA, '/financeiro/receita-saude/lotes', { profissionalId: profissionalPfA, de: hoje, ate: hoje })).status).toBe(403);
    expect((await post(finA, '/financeiro/receita-saude/lotes', { profissionalId: profissionalPfA, de: '2031-01-01', ate: '2031-03-01' })).body).toMatchObject({
      campos: ['ate'],
    });
  });
});

describe('permissões e conteúdo clínico', () => {
  it('profissional não opera o financeiro; financeiro e recepção não leem prontuário', async () => {
    expect((await get(profA, '/financeiro/contas-a-receber?de=2031-03-01&ate=2031-03-02')).status).toBe(403);
    expect((await post(profA, '/financeiro/cobrancas', { agendamentoId: await agendamento(), valorCentavos: 100 })).status).toBe(403);
    expect((await post(profA, '/financeiro/caixas', { turno: 'noite' })).status).toBe(403);
    expect((await get(recepA, `/financeiro/profissionais/${profissionalPfA}/perfil-fiscal`)).status).toBe(403);
    for (const s of [finA, recepA]) {
      const r = await get(s, `/pacientes/${pacienteA}/prontuario`);
      expect(r.status).toBe(403);
    }
  });
});

describe('isolamento entre clínicas', () => {
  it('pela API: cobrança, recebimento, recibo e caixa de outra clínica são 404', async () => {
    const cb = await cobranca(adminB, { agendamentoId: await agendamento({ s: adminB, prof: profissionalB, tipo: tipoB, paciente: pacienteB }), valorCentavos: 700 });
    const pb = await receber(adminB, cb.id, { forma: 'pix' });
    const rb = id(await post(adminB, `/financeiro/recebimentos/${pb.id}/recibo`));
    expect((await get(adminA, `/financeiro/cobrancas/${cb.id}`)).status).toBe(404);
    expect((await post(adminA, `/financeiro/cobrancas/${cb.id}/recebimentos`, { forma: 'pix' })).status).toBe(404);
    expect((await post(adminA, `/financeiro/recebimentos/${pb.id}/estornar`, { motivo: 'lancamento_errado' })).status).toBe(404);
    expect((await post(adminA, `/financeiro/recebimentos/${pb.id}/recibo`)).status).toBe(404);
    expect((await get(adminA, `/financeiro/recibos/${rb}`)).status).toBe(404);
    expect((await post(adminA, `/financeiro/recibos/${rb}/cancelar`, { motivo: 'dados_incorretos' })).status).toBe(404);
    expect((await get(adminA, `/financeiro/caixas/${caixaB}`)).status).toBe(404);
    expect((await post(adminA, `/financeiro/caixas/${caixaB}/fechar`, { dinheiroContadoCentavos: 0 })).status).toBe(404);
    // Cobrar agendamento de outra clínica: 404.
    const agB = await agendamento({ s: adminB, prof: profissionalB, tipo: tipoB, paciente: pacienteB });
    expect((await post(adminA, '/financeiro/cobrancas', { agendamentoId: agB, valorCentavos: 100 })).status).toBe(404);
  });

  it('pelo RLS: no contexto de A, nenhuma linha financeira de B aparece nem pode ser gravada', async () => {
    const tabelas = [financeSettings, professionalFiscalProfiles, cashSessions, charges, payments, paymentReversals, receiptCounters, receipts, receiptCancellations];
    for (const t of tabelas) {
      const vistas = await withTenant(api.db.db, clinicaA, (tx) => tx.select({ tenantId: t.tenantId }).from(t));
      expect(vistas.every((v) => v.tenantId === clinicaA)).toBe(true);
    }
    const deB = await withTenant(api.db.db, clinicaB, (tx) => tx.select({ n: sql<number>`count(*)::int` }).from(receipts));
    expect(deB[0]?.n).toBeGreaterThan(0);
    // Gravar com tenant_id de B no contexto de A: o WITH CHECK recusa (42501).
    expect(
      await sqlstate(
        withTenant(api.db.db, clinicaA, (tx) =>
          tx.insert(cashSessions).values({ tenantId: clinicaB, businessDate: '2031-01-01', shift: 'noite', openedBy: randomUUID() }),
        ),
      ),
    ).toContain('42501');
    expect(
      await sqlstate(withTenant(api.db.db, clinicaA, (tx) => tx.insert(receiptCounters).values({ tenantId: clinicaB, lastNumber: 1 }))),
    ).toContain('42501');
  });
});

describe('quem lança é o usuário da sessão (0016)', () => {
  it('o banco recusa recebimento/cobrança em nome de outra pessoa e sem usuário na transação', async () => {
    const c = await cobranca(recepA, { agendamentoId: await agendamento(), valorCentavos: 900 });
    const outro = randomUUID();
    const comSessao = (fn: Parameters<typeof withTenant>[2]) => withTenant(api.db.db, clinicaA, fn, recepA.userId);
    expect(
      await sqlstate(
        comSessao((tx) => tx.insert(payments).values({ tenantId: clinicaA, chargeId: c.id, cashSessionId: caixaA, method: 'pix_manual', amountCents: 1, receivedBy: outro })),
      ),
    ).toContain('42501');
    expect(await sqlstate(comSessao((tx) => tx.update(charges).set({ status: 'cancelled', cancelledAt: new Date(), cancelledBy: outro, cancelReason: 'cortesia' }).where(eq(charges.id, c.id))))).toContain('42501');
    // Sem app_set_user: falha fechada.
    expect(
      await sqlstate(
        withTenant(api.db.db, clinicaA, (tx) =>
          tx.insert(payments).values({ tenantId: clinicaA, chargeId: c.id, cashSessionId: caixaA, method: 'pix_manual', amountCents: 1, receivedBy: recepA.userId }),
        ),
      ),
    ).toContain('42501');
    // Com o próprio usuário da sessão, passa (e a cobrança fica coerente pela API depois).
    await comSessao(async (tx) => {
      await tx.insert(payments).values({ tenantId: clinicaA, chargeId: c.id, cashSessionId: caixaA, method: 'pix_manual', amountCents: 1, receivedBy: recepA.userId });
      await tx.update(charges).set({ paidCents: 1 }).where(eq(charges.id, c.id));
    });
  });
});

describe('auditoria sem dado pessoal nem valores', () => {
  it('a trilha do financeiro tem só ids, códigos e contagens', async () => {
    const linhas = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(auditLog).where(eq(auditLog.tenantId, clinicaA)));
    const fin = linhas.filter((l) =>
      ['finance_settings', 'professional_fiscal_profiles', 'charges', 'payments', 'payment_reversals', 'cash_sessions', 'receipts', 'receipt_cancellations', 'receita_saude.batch'].includes(
        l.scope,
      ),
    );
    expect(new Set(fin.map((l) => l.scope)).size).toBeGreaterThanOrEqual(8);
    // Sem os UUIDs: um id aleatório como "8a180008-..." contém "18000" e dava falso negativo.
    const serial = JSON.stringify(fin).replace(UUID_RE, '<uuid>');
    for (const proibido of [cpfFicticio(301), cpfFicticio(302), cpfFicticio(303), PAGADOR, 'Paciente Ficticio', 'Atendimento', CONSELHO, TIPO_SENSIVEL, '20000', '18000']) {
      expect(serial).not.toContain(proibido);
    }
  });
});

describe('R1 do #65: cobrança PF não sai em nome de profissional arbitrário', () => {
  it('exige perfil fiscal com CPF; no pacote, profissional das sessões ou o próprio; o banco confere', async () => {
    const semPerfil = id(await post(adminA, '/profissionais', { nome: 'Prof Ficticio Sem Perfil', especialidade: 'Fisio' }));
    const r1 = await post(recepA, '/financeiro/cobrancas', { agendamentoId: await agendamento({ prof: semPerfil }), valorCentavos: 100, atendimentoPor: 'pf' });
    expect(r1.status).toBe(409);
    expect(r1.body).toMatchObject({ codigo: 'profissional_sem_perfil_fiscal' });
    await api.http().put(`/financeiro/profissionais/${profissionalPfA}/perfil-fiscal`).set(cab(finA)).send({ cpf: cpfFicticio(302) }).expect(200);

    // Pacote sem sessão consumida: a recepção não escolhe o emitente PF.
    const vazio = id(await post(recepA, '/pacotes', { pacienteId: pacienteA, nome: 'Pacote Ficticio R1', total: 4 }));
    const r2 = await post(recepA, '/financeiro/cobrancas', { pacoteId: vazio, valorCentavos: 100, atendimentoPor: 'pf', profissionalId: profissionalPfA });
    expect(r2.status).toBe(409);
    expect(r2.body).toMatchObject({ codigo: 'profissional_nao_e_do_pacote' });
    // Pacote cujas sessões são de OUTRO profissional: recusado.
    const deOutro = id(await post(recepA, '/pacotes', { pacienteId: pacienteA, nome: 'Pacote Ficticio R1b', total: 4 }));
    const agOutro = await agendamento();
    expect((await post(recepA, `/agendamentos/${agOutro}/check-in`)).status).toBe(200);
    expect((await post(recepA, `/pacotes/${deOutro}/consumos`, { agendamentoId: agOutro })).status).toBe(201);
    expect((await post(recepA, '/financeiro/cobrancas', { pacoteId: deOutro, valorCentavos: 100, atendimentoPor: 'pf', profissionalId: profissionalPfA })).body).toMatchObject({
      codigo: 'pacote_com_sessoes_de_outro_profissional', // R14 do #65
    });
    // Pacote com as sessões do profissional: passa.
    const dele = id(await post(recepA, '/pacotes', { pacienteId: pacienteA, nome: 'Pacote Ficticio R1c', total: 4 }));
    const agDele = await agendamento({ prof: profissionalPfA });
    expect((await post(recepA, `/agendamentos/${agDele}/check-in`)).status).toBe(200);
    expect((await post(recepA, `/pacotes/${dele}/consumos`, { agendamentoId: agDele })).status).toBe(201);
    await cobranca(recepA, { pacoteId: dele, valorCentavos: 100, atendimentoPor: 'pf', profissionalId: profissionalPfA });

    // No banco (ex.: SQL injetado): agendamento de um profissional, emitente outro; pacote vazio pela recepção.
    const linha = (alvo: { appointmentId?: string; packageId?: string }, prof: string, por: string) => ({
      tenantId: clinicaA, patientId: pacienteA, ...alvo, professionalId: prof, attendanceKind: 'pf' as const,
      amountCents: 100, dueDate: '2031-01-01', createdBy: por,
    });
    const agA = await agendamento();
    expect(await sqlstate(withTenant(api.db.db, clinicaA, (tx) => tx.insert(charges).values(linha({ appointmentId: agA }, profissionalPfA, recepA.userId)), recepA.userId))).toContain('42501');
    expect(await sqlstate(withTenant(api.db.db, clinicaA, (tx) => tx.insert(charges).values(linha({ packageId: vazio }, profissionalPfA, recepA.userId)), recepA.userId))).toContain('42501');
    // Sem CPF no perfil fiscal: 23514 mesmo direto.
    const agSem = await agendamento({ prof: semPerfil });
    expect(await sqlstate(withTenant(api.db.db, clinicaA, (tx) => tx.insert(charges).values(linha({ appointmentId: agSem }, semPerfil, recepA.userId)), recepA.userId))).toContain('23514');
    // Regra explícita: o PRÓPRIO profissional (usuário vinculado) lança a cobrança PF do pacote.
    await api.http().put(`/financeiro/profissionais/${profissionalA}/perfil-fiscal`).set(cab(finA)).send({ cpf: cpfFicticio(304) }).expect(200);
    await withTenant(api.db.db, clinicaA, (tx) => tx.insert(charges).values(linha({ packageId: vazio }, profissionalA, profA.userId)), profA.userId);
    // Cobrança nasce com paid_cents = 0 (R9).
    expect(await sqlstate(withTenant(api.db.db, clinicaA, (tx) => tx.insert(charges).values({ ...linha({ appointmentId: agA }, profissionalA, recepA.userId), attendanceKind: 'pj', paidCents: 50 }), recepA.userId))).toContain('23514');
  });
});

describe('R3 do #65: paciente menor sem pagador informado', () => {
  it('o recibo e o insumo do Receita Saúde saem com a pendência pagador_responsavel; com pagador, não', async () => {
    const menor = id(await post(recepA, '/pacientes', { nome: 'Paciente Ficticio Menor', telefone: '11900000311', cpf: cpfFicticio(311), nascimento: '2020-05-10' }));
    const semPagador = await cobranca(recepA, { agendamentoId: await agendamento({ prof: profissionalPfA, paciente: menor }), valorCentavos: 10000, atendimentoPor: 'pf' });
    const p1 = await receber(recepA, semPagador.id, { forma: 'dinheiro' });
    const r1 = await post(recepA, `/financeiro/recebimentos/${p1.id}/recibo`);
    expect(r1.status).toBe(200);
    expect((r1.body as { pendencias: string[] }).pendencias).toContain('pagador_responsavel');
    const comPagador = await cobranca(recepA, {
      agendamentoId: await agendamento({ prof: profissionalPfA, paciente: menor }),
      valorCentavos: 10000,
      atendimentoPor: 'pf',
      pagador: { nome: PAGADOR, cpf: cpfFicticio(312) },
    });
    const p2 = await receber(recepA, comPagador.id, { forma: 'dinheiro' });
    const r2 = await post(recepA, `/financeiro/recebimentos/${p2.id}/recibo`);
    expect((r2.body as { pendencias: string[] }).pendencias).not.toContain('pagador_responsavel');
    // Adulto sem pagador (pacienteA, sem data de nascimento) não ganha a pendência.
    const hoje = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
    const lote = await post(finA, '/financeiro/receita-saude/lotes', { profissionalId: profissionalPfA, de: hoje, ate: hoje });
    expect(lote.status, JSON.stringify(lote.body)).toBe(200);
    const itens = (lote.body as { itens: { pendencias: string[]; beneficiario: { nome: string } }[] }).itens;
    expect(itens.filter((i) => i.pendencias.includes('pagador_responsavel')).every((i) => i.beneficiario.nome === 'Paciente Ficticio Menor')).toBe(true);
    expect(itens.some((i) => i.pendencias.includes('pagador_responsavel'))).toBe(true);
  });
});

describe('R13 do #65: profissional fixado na venda do pacote', () => {
  it('PF já na venda; consumo só do profissional; troca só registrada, com motivo e sem cobrança PF viva', async () => {
    await api.http().put(`/financeiro/profissionais/${profissionalPfA}/perfil-fiscal`).set(cab(finA)).send({ cpf: cpfFicticio(302) }).expect(200);
    const pacote = await post(recepA, '/pacotes', { pacienteId: pacienteA, nome: 'Pacote Ficticio R13', total: 4, profissionalId: profissionalPfA });
    expect(pacote.status, JSON.stringify(pacote.body)).toBe(201);
    expect(pacote.body).toMatchObject({ profissionalId: profissionalPfA });
    const pacoteId = id(pacote);
    // A recepção cobra PF na venda, sem sessão consumida; o emitente é o da venda (padrão).
    const c = await cobranca(recepA, { pacoteId, valorCentavos: 40000, atendimentoPor: 'pf' });
    const [linhaCobranca] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(charges).where(eq(charges.id, c.id)));
    expect(linhaCobranca?.professionalId).toBe(profissionalPfA);
    // Outro emitente: 409 (API) e 42501 (banco).
    await api.http().put(`/financeiro/profissionais/${profissionalA}/perfil-fiscal`).set(cab(finA)).send({ cpf: cpfFicticio(304) }).expect(200);
    expect((await post(recepA, '/financeiro/cobrancas', { pacoteId, valorCentavos: 100, atendimentoPor: 'pf', profissionalId: profissionalA })).body).toMatchObject({
      codigo: 'profissional_nao_e_do_pacote',
    });
    const direta = withTenant(api.db.db, clinicaA, (tx) =>
      tx.insert(charges).values({ tenantId: clinicaA, patientId: pacienteA, packageId: pacoteId, professionalId: profissionalA, attendanceKind: 'pf', amountCents: 100, dueDate: '2031-01-01', createdBy: profA.userId }), profA.userId);
    expect(await sqlstate(direta)).toContain('42501');
    // Consumo por sessão de outro profissional: 409 (API) e 42501 (banco).
    const agOutro = await agendamento();
    expect((await post(recepA, `/agendamentos/${agOutro}/check-in`)).status).toBe(200);
    expect((await post(recepA, `/pacotes/${pacoteId}/consumos`, { agendamentoId: agOutro })).body).toMatchObject({ codigo: 'profissional_diferente' });
    const consumoDireto = withTenant(api.db.db, clinicaA, (tx) =>
      tx.insert(packageSessions).values({ tenantId: clinicaA, packageId: pacoteId, appointmentId: agOutro, consumedBy: recepA.userId }), recepA.userId);
    expect(await sqlstate(consumoDireto)).toContain('42501');
    const agDele = await agendamento({ prof: profissionalPfA });
    expect((await post(recepA, `/agendamentos/${agDele}/check-in`)).status).toBe(200);
    expect((await post(recepA, `/pacotes/${pacoteId}/consumos`, { agendamentoId: agDele })).status).toBe(201);

    // Troca: UPDATE direto sem o registro é recusado pelo banco.
    const semRegistro = withTenant(api.db.db, clinicaA, (tx) => tx.update(sessionPackages).set({ professionalId: profissionalA }).where(eq(sessionPackages.id, pacoteId)), recepA.userId);
    expect(await sqlstate(semRegistro)).toContain('42501');
    // Com cobrança PF viva do profissional da venda: 409; motivo fora do enum: 400.
    expect((await post(recepA, `/pacotes/${pacoteId}/profissional`, { profissionalId: profissionalA, motivo: 'pedido_do_paciente' })).body).toMatchObject({
      codigo: 'pacote_com_cobranca_pf',
    });
    expect((await post(recepA, `/pacotes/${pacoteId}/profissional`, { profissionalId: profissionalA, motivo: 'porque sim' })).status).toBe(400);
    expect((await post(finA, `/financeiro/cobrancas/${c.id}/cancelar`, { motivo: 'lancamento_errado' })).status).toBe(200);
    const troca = await post(recepA, `/pacotes/${pacoteId}/profissional`, { profissionalId: profissionalA, motivo: 'pedido_do_paciente' });
    expect(troca.status, JSON.stringify(troca.body)).toBe(200);
    expect(troca.body).toMatchObject({ profissionalId: profissionalA });
    const registros = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(packageProfessionalChanges).where(eq(packageProfessionalChanges.packageId, pacoteId)));
    expect(registros).toEqual([expect.objectContaining({ fromProfessionalId: profissionalPfA, toProfessionalId: profissionalA, reason: 'pedido_do_paciente', changedBy: recepA.userId })]);
    // O registro é append-only.
    const apagar = withTenant(api.db.db, clinicaA, (tx) => tx.delete(packageProfessionalChanges).where(eq(packageProfessionalChanges.packageId, pacoteId)), recepA.userId);
    expect(await sqlstate(apagar)).toContain('42501');
    // Trilha: só ids e o motivo.
    const trilha = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(auditLog).where(eq(auditLog.scope, 'session_packages')));
    expect(trilha.map((l) => l.metadata)).toEqual(
      expect.arrayContaining([expect.objectContaining({ op: 'professional_change', package_id: pacoteId, from_professional_id: profissionalPfA, to_professional_id: profissionalA })]),
    );
  });
});

describe('R14 e R15 do #65: cobrança PF de pacote só com sessões do emitente; agendamento imutável', () => {
  const consumir = async (pacoteId: string, ag: string) => {
    expect((await post(recepA, `/agendamentos/${ag}/check-in`)).status).toBe(200);
    const r = await post(recepA, `/pacotes/${pacoteId}/consumos`, { agendamentoId: ag });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  };
  const pfDireta = (pacoteId: string, profissional: string) =>
    withTenant(api.db.db, clinicaA, (tx) =>
      tx.insert(charges).values({ tenantId: clinicaA, patientId: pacienteA, packageId: pacoteId, professionalId: profissional, attendanceKind: 'pf', amountCents: 100, dueDate: '2031-01-01', createdBy: profA.userId }), profA.userId);

  beforeAll(async () => {
    await api.http().put(`/financeiro/profissionais/${profissionalPfA}/perfil-fiscal`).set(cab(finA)).send({ cpf: cpfFicticio(302) }).expect(200);
    await api.http().put(`/financeiro/profissionais/${profissionalA}/perfil-fiscal`).set(cab(finA)).send({ cpf: cpfFicticio(304) }).expect(200);
  });

  it('(a) fixar pacote antigo com sessões de X e Y é recusado, e a PF de X também (API e banco)', async () => {
    const pacoteId = id(await post(recepA, '/pacotes', { pacienteId: pacienteA, nome: 'Pacote Ficticio R14a', total: 4 }));
    await consumir(pacoteId, await agendamento({ prof: profissionalPfA }));
    await consumir(pacoteId, await agendamento({ prof: profissionalA }));
    expect((await post(recepA, `/pacotes/${pacoteId}/profissional`, { profissionalId: profissionalPfA, motivo: 'fixar_pacote_antigo' })).body).toMatchObject({
      codigo: 'pacote_com_sessoes_de_outro_profissional',
    });
    const fixarDireto = withTenant(api.db.db, clinicaA, async (tx) => {
      await tx.insert(packageProfessionalChanges).values({ tenantId: clinicaA, packageId: pacoteId, fromProfessionalId: null, toProfessionalId: profissionalPfA, reason: 'fixar_pacote_antigo', changedBy: recepA.userId });
      await tx.update(sessionPackages).set({ professionalId: profissionalPfA }).where(eq(sessionPackages.id, pacoteId));
    }, recepA.userId);
    expect(await sqlstate(fixarDireto)).toContain('55000');
    expect((await post(recepA, '/financeiro/cobrancas', { pacoteId, valorCentavos: 100, atendimentoPor: 'pf', profissionalId: profissionalPfA })).body).toMatchObject({
      codigo: 'pacote_com_sessoes_de_outro_profissional',
    });
    // Nem o próprio profissional (usuário da sessão = profA, vinculado a profissionalA) lança PF no banco.
    expect(await sqlstate(pfDireta(pacoteId, profissionalA))).toContain('42501');
    expect(await sqlstate(pfDireta(pacoteId, profissionalPfA))).toContain('42501');
    // PJ continua possível.
    await cobranca(recepA, { pacoteId, valorCentavos: 100, atendimentoPor: 'pj' });
  });

  it('(b) X atendeu, cancela a PF, troca para Y: a PF de Y é recusada (API e banco); estornada a sessão de X, passa', async () => {
    const pacoteId = id(await post(recepA, '/pacotes', { pacienteId: pacienteA, nome: 'Pacote Ficticio R14b', total: 4, profissionalId: profissionalPfA }));
    const c = await cobranca(recepA, { pacoteId, valorCentavos: 40000, atendimentoPor: 'pf' });
    await consumir(pacoteId, await agendamento({ prof: profissionalPfA }));
    expect((await post(finA, `/financeiro/cobrancas/${c.id}/cancelar`, { motivo: 'lancamento_errado' })).status).toBe(200);
    expect((await post(recepA, `/pacotes/${pacoteId}/profissional`, { profissionalId: profissionalA, motivo: 'profissional_desligado' })).status).toBe(200);
    expect((await post(recepA, '/financeiro/cobrancas', { pacoteId, valorCentavos: 100, atendimentoPor: 'pf' })).body).toMatchObject({
      codigo: 'pacote_com_sessoes_de_outro_profissional',
    });
    expect(await sqlstate(pfDireta(pacoteId, profissionalA))).toContain('42501');
    const [sessao] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(packageSessions).where(eq(packageSessions.packageId, pacoteId)));
    const estorno = await post(finA, `/pacotes/${pacoteId}/consumos/${sessao!.id}/estornar`, { motivo: 'lancamento_errado' });
    expect(estorno.status, JSON.stringify(estorno.body)).toBeLessThan(300);
    await cobranca(recepA, { pacoteId, valorCentavos: 100, atendimentoPor: 'pf' });
  });

  it('(3) pacote NÃO fixado com PF viva de X: consumo por agendamento de Y é recusado (API e banco)', async () => {
    const pacoteId = id(await post(recepA, '/pacotes', { pacienteId: pacienteA, nome: 'Pacote Ficticio R14c', total: 4 }));
    await consumir(pacoteId, await agendamento({ prof: profissionalPfA }));
    await cobranca(recepA, { pacoteId, valorCentavos: 100, atendimentoPor: 'pf', profissionalId: profissionalPfA });
    const agY = await agendamento({ prof: profissionalA });
    expect((await post(recepA, `/agendamentos/${agY}/check-in`)).status).toBe(200);
    expect((await post(recepA, `/pacotes/${pacoteId}/consumos`, { agendamentoId: agY })).body).toMatchObject({ codigo: 'profissional_diferente' });
    const direto = withTenant(api.db.db, clinicaA, (tx) =>
      tx.insert(packageSessions).values({ tenantId: clinicaA, packageId: pacoteId, appointmentId: agY, consumedBy: recepA.userId }), recepA.userId);
    expect(await sqlstate(direto)).toContain('42501');
  });

  it('R15: profissional e paciente do agendamento não mudam para nenhum papel (antes ou depois do consumo/cobrança)', async () => {
    const outroPaciente = id(await post(recepA, '/pacientes', { nome: 'Paciente Ficticio R15', telefone: '11900000315' }));
    const livre = await agendamento({ prof: profissionalPfA });
    const pacoteId = id(await post(recepA, '/pacotes', { pacienteId: pacienteA, nome: 'Pacote Ficticio R15', total: 2, profissionalId: profissionalPfA }));
    const consumido = await agendamento({ prof: profissionalPfA });
    await consumir(pacoteId, consumido);
    const cobrado = await agendamento({ prof: profissionalPfA });
    await cobranca(recepA, { agendamentoId: cobrado, valorCentavos: 100, atendimentoPor: 'pf' });
    for (const ag of [livre, consumido, cobrado]) {
      for (const s of [recepA, adminA, finA, profA]) {
        const prof = withTenant(api.db.db, clinicaA, (tx) => tx.update(appointments).set({ professionalId: profissionalA }).where(eq(appointments.id, ag)), s.userId);
        expect(await sqlstate(prof)).toContain('42501');
        const pac = withTenant(api.db.db, clinicaA, (tx) => tx.update(appointments).set({ patientId: outroPaciente }).where(eq(appointments.id, ag)), s.userId);
        expect(await sqlstate(pac)).toContain('42501');
      }
    }
    const [linha] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(appointments).where(eq(appointments.id, consumido)));
    expect(linha).toMatchObject({ professionalId: profissionalPfA, patientId: pacienteA });
  });

  it('R17: sessão de pacote só aceita o estorno, uma vez, pelo usuário da sessão; SQL injetado não desfaz estorno nem troca agendamento/pacote (0029)', async () => {
    // Cenário da R17: Y atendeu e a sessão de Y foi estornada; X atende depois. Desfazer o estorno de Y tem de falhar.
    const pacoteId = id(await post(recepA, '/pacotes', { pacienteId: pacienteA, nome: 'Pacote Ficticio R17', total: 4 }));
    const outroPacote = id(await post(recepA, '/pacotes', { pacienteId: pacienteA, nome: 'Pacote Ficticio R17 outro', total: 4 }));
    await consumir(pacoteId, await agendamento({ prof: profissionalA }));
    const [deY] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(packageSessions).where(eq(packageSessions.packageId, pacoteId)));
    const estorno = await post(finA, `/pacotes/${pacoteId}/consumos/${deY!.id}/estornar`, { motivo: 'lancamento_errado' });
    expect(estorno.status, JSON.stringify(estorno.body)).toBeLessThan(300);
    await consumir(pacoteId, await agendamento({ prof: profissionalPfA }));
    const [deX] = await withTenant(api.db.db, clinicaA, (tx) =>
      tx.select().from(packageSessions).where(and(eq(packageSessions.packageId, pacoteId), isNull(packageSessions.reversedAt))));
    const outroAg = await agendamento({ prof: profissionalPfA });
    const upd = (sessaoId: string, set: Partial<typeof packageSessions.$inferInsert>, quem: string) =>
      withTenant(api.db.db, clinicaA, (tx) => tx.update(packageSessions).set(set).where(eq(packageSessions.id, sessaoId)), quem);

    for (const s of [recepA, adminA, finA, profA]) {
      // Desfazer o estorno (reversed_* de volta a NULL) e reestornar com outro motivo/autor.
      expect(await sqlstate(upd(deY!.id, { reversedAt: null, reversedBy: null, reversalReason: null }, s.userId))).toContain('42501');
      expect(await sqlstate(upd(deY!.id, { reversalReason: 'pacote_errado' }, s.userId))).toContain('42501');
      // Trocar agendamento, pacote ou autoria de uma sessão viva.
      expect(await sqlstate(upd(deX!.id, { appointmentId: outroAg }, s.userId))).toContain('42501');
      expect(await sqlstate(upd(deX!.id, { packageId: outroPacote }, s.userId))).toContain('42501');
      expect(await sqlstate(upd(deX!.id, { consumedBy: s.userId, consumedAt: new Date(0) }, s.userId))).toContain('42501');
      // Estorno em nome de outra pessoa, ou "estorno" que troca o agendamento junto.
      const outro = s === finA ? recepA : finA;
      expect(await sqlstate(upd(deX!.id, { reversedAt: new Date(), reversedBy: outro.userId, reversalReason: 'lancamento_errado' }, s.userId))).toContain('42501');
      expect(
        await sqlstate(upd(deX!.id, { reversedAt: new Date(), reversedBy: s.userId, reversalReason: 'lancamento_errado', appointmentId: outroAg }, s.userId)),
      ).toContain('42501');
    }
    // Sem usuário na transação, nem o estorno passa.
    expect(await sqlstate(withTenant(api.db.db, clinicaA, (tx) =>
      tx.update(packageSessions).set({ reversedAt: new Date(), reversedBy: finA.userId, reversalReason: 'lancamento_errado' }).where(eq(packageSessions.id, deX!.id))))).toContain('42501');

    const [y, x] = await withTenant(api.db.db, clinicaA, (tx) =>
      Promise.all([deY, deX].map(async (d) => (await tx.select().from(packageSessions).where(eq(packageSessions.id, d!.id)))[0])));
    expect(y).toMatchObject({ reversedBy: finA.userId, reversalReason: 'lancamento_errado', appointmentId: deY!.appointmentId, packageId: pacoteId });
    expect(y?.reversedAt).not.toBeNull();
    expect(x).toMatchObject({ reversedAt: null, reversedBy: null, appointmentId: deX!.appointmentId, packageId: pacoteId, consumedBy: deX!.consumedBy });

    // O estorno legítimo pela API continua funcionando, uma vez só.
    expect((await post(finA, `/pacotes/${pacoteId}/consumos/${deX!.id}/estornar`, { motivo: 'status_corrigido' })).status).toBeLessThan(300);
    expect(await sqlstate(upd(deX!.id, { reversedAt: new Date(), reversedBy: finA.userId, reversalReason: 'pacote_errado' }, finA.userId))).toContain('42501');
  });

  it('R18: o estorno grava a hora do banco, não a enviada pelo cliente (0029)', async () => {
    const pacoteId = id(await post(recepA, '/pacotes', { pacienteId: pacienteA, nome: 'Pacote Ficticio R18', total: 4 }));
    await consumir(pacoteId, await agendamento({ prof: profissionalA }));
    const [sessao] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(packageSessions).where(eq(packageSessions.packageId, pacoteId)));
    const antes = Date.now();
    // Estorno válido (usuário da sessão, motivo da lista), mas com data antiga vinda do cliente.
    await withTenant(
      api.db.db,
      clinicaA,
      (tx) => tx.update(packageSessions).set({ reversedAt: new Date(0), reversedBy: finA.userId, reversalReason: 'lancamento_errado' }).where(eq(packageSessions.id, sessao!.id)),
      finA.userId,
    );
    const [gravada] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(packageSessions).where(eq(packageSessions.id, sessao!.id)));
    expect(gravada).toMatchObject({ reversedBy: finA.userId, reversalReason: 'lancamento_errado' });
    // Hora do banco: recente (folga de relógio entre o processo do teste e o Postgres local).
    expect(gravada!.reversedAt!.getTime()).toBeGreaterThan(antes - 60_000);
    expect(gravada!.reversedAt!.getTime()).toBeLessThan(Date.now() + 60_000);
  });

  it('R19: estornar em nome próprio por SQL exige perfil autorizado registrado no banco (0041)', async () => {
    const pacoteId = id(await post(recepA, '/pacotes', { pacienteId: pacienteA, nome: 'Pacote Ficticio R19', total: 6 }));
    await consumir(pacoteId, await agendamento({ prof: profissionalA }));
    const [viva] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(packageSessions).where(eq(packageSessions.packageId, pacoteId)));
    const estornoDireto = (quem: string) =>
      withTenant(
        api.db.db,
        clinicaA,
        (tx) => tx.update(packageSessions).set({ reversedAt: new Date(), reversedBy: quem, reversalReason: 'lancamento_errado' }).where(eq(packageSessions.id, viva!.id)),
        quem,
      );
    // Perfil só no token (sem clinic_members), perfil fora da lista (psicólogo) e usuário de outra clínica: 42501.
    const soToken = api.sessao(clinicaA, 'financeiro');
    const psicologo = await api.membro(clinicaA, api.sessao(clinicaA, 'profissional'), 'psicologo');
    const deOutraClinica = await api.membro(clinicaB, api.sessao(clinicaB, 'financeiro'), 'financeiro');
    for (const s of [soToken, psicologo, deOutraClinica]) expect(await sqlstate(estornoDireto(s.userId))).toContain('42501');
    // Pela API, o perfil do token sem registro no banco vira 403 explicável, sem estornar.
    const api403 = await post(soToken, `/pacotes/${pacoteId}/consumos/${viva!.id}/estornar`, { motivo: 'lancamento_errado' });
    expect(api403.status).toBe(403);
    expect(api403.body).toMatchObject({ codigo: 'perfil_nao_registrado' });
    const [intacta] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(packageSessions).where(eq(packageSessions.id, viva!.id)));
    expect(intacta).toMatchObject({ reversedAt: null, reversedBy: null });
    // Perfil autorizado registrado (recepção) estorna em nome próprio.
    const recepRegistrada = await api.membro(clinicaA, api.sessao(clinicaA, 'recepcao'), 'recepcao');
    await estornoDireto(recepRegistrada.userId);
    const [estornada] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(packageSessions).where(eq(packageSessions.id, viva!.id)));
    expect(estornada).toMatchObject({ reversedBy: recepRegistrada.userId, reversalReason: 'lancamento_errado' });
  });
});

describe('R2 do #65: registro no conselho escolhido por recibo', () => {
  it('padrão oculto; só aparece no recibo que pedir; a clínica só habilita a opção', async () => {
    await api.http().put(`/financeiro/profissionais/${profissionalPfA}/perfil-fiscal`).set(cab(finA)).send({ cpf: cpfFicticio(302), registroConselho: CONSELHO }).expect(200);
    const pagamento = async () => {
      const c = await cobranca(recepA, { agendamentoId: await agendamento({ prof: profissionalPfA }), valorCentavos: 1500, atendimentoPor: 'pf' });
      return (await receber(recepA, c.id, { forma: 'dinheiro' })).id;
    };
    // Clínica sem a opção habilitada: pedir o conselho é 409.
    const p0 = await pagamento();
    expect((await post(recepA, `/financeiro/recebimentos/${p0}/recibo`, { incluirRegistroConselho: true })).body).toMatchObject({
      codigo: 'registro_conselho_nao_habilitado',
    });
    await api.http().put('/financeiro/configuracao').set(cab(adminA)).send({ mostrarRegistroConselho: true }).expect(200);
    try {
      // Habilitada: o padrão continua oculto.
      const oculto = await post(recepA, `/financeiro/recebimentos/${p0}/recibo`, {});
      expect(oculto.body).toMatchObject({ emitente: { registroConselho: null } });
      expect(JSON.stringify(oculto.body)).not.toContain(CONSELHO);
      // Só o recibo que pediu leva o conselho (gravado no retrato).
      const p1 = await pagamento();
      const comConselho = await post(recepA, `/financeiro/recebimentos/${p1}/recibo`, { incluirRegistroConselho: true });
      expect(comConselho.body).toMatchObject({ emitente: { registroConselho: CONSELHO } });
      expect((await get(finA, `/financeiro/recibos/${id(comConselho)}`)).body).toMatchObject({ emitente: { registroConselho: CONSELHO } });
      expect((await post(recepA, `/financeiro/recebimentos/${p1}/recibo`, { incluirRegistroConselho: 'sim' })).status).toBe(400);
    } finally {
      await api.http().put('/financeiro/configuracao').set(cab(adminA)).send({ mostrarRegistroConselho: false }).expect(200);
    }
  });
});

describe('R5 do #65: insumo do Receita Saúde minimizado', () => {
  it('itens só com número do recibo, data, valor, pagador, beneficiário e pendências; sem descrição, ids ou conselho', async () => {
    await api.http().put(`/financeiro/profissionais/${profissionalPfA}/perfil-fiscal`).set(cab(finA)).send({ cpf: cpfFicticio(302), registroConselho: CONSELHO }).expect(200);
    const c = await cobranca(recepA, { agendamentoId: await agendamento({ prof: profissionalPfA }), valorCentavos: 700, atendimentoPor: 'pf' });
    const p = await receber(recepA, c.id, { forma: 'pix_manual' });
    const hoje = new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
    const l = await post(finA, '/financeiro/receita-saude/lotes', { profissionalId: profissionalPfA, de: hoje, ate: hoje });
    expect(l.status).toBe(200);
    const lote = l.body as { versao: string; emitente: Record<string, unknown>; itens: Record<string, unknown>[] };
    expect(lote.versao).toBe('0.2.0');
    expect(Object.keys(lote.emitente).sort()).toEqual(['cpf', 'nome']);
    expect(lote.itens.length).toBeGreaterThan(0);
    for (const i of lote.itens) {
      expect(Object.keys(i).sort()).toEqual(['beneficiario', 'dataPagamento', 'pagador', 'pendencias', 'reciboNumero', 'valorCentavos']);
    }
    const serial = JSON.stringify(lote);
    for (const proibido of [CONSELHO, c.id, p.id, profissionalPfA, 'descricao', 'Atendimento']) expect(serial).not.toContain(proibido);
  });
});

describe('R7 do #65: retenção fiscal parametrizada, idempotente e respeitando a retenção legal', () => {
  it('elimina retrato do recibo e pagador vencido o prazo; o recente, o da virada e o retido ficam', async () => {
    await api.membro(clinicaA, adminA, 'admin');
    const pol = await get(adminA, '/financeiro/retencao-fiscal');
    expect(pol.body).toMatchObject({ anos: 5, inicio: 'primeiro_de_janeiro_do_ano_seguinte_ao_pagamento', confirmadaPeloContador: false });
    expect((pol.body as { nota: string }).nota).toContain('CONTADOR');

    const novoPaciente = async (n: number) =>
      id(await post(recepA, '/pacientes', { nome: `Paciente Ficticio Fiscal ${n}`, telefone: `1190000${String(n).padStart(4, '0')}`, cpf: cpfFicticio(n) }));
    /** Cobrança PJ com pagador terceiro, quitada por um recebimento na data dada, e o recibo emitido. */
    const quitadaEm = async (paciente: string, quando: Date | null) => {
      const c = await cobranca(recepA, {
        agendamentoId: await agendamento({ paciente }),
        valorCentavos: 4200,
        atendimentoPor: 'pj',
        pagador: { nome: PAGADOR, cpf: cpfFicticio(399) },
      });
      let pagamento: string;
      if (quando) {
        // Recebimento antigo (o banco não aceita "envelhecer" pela API): mesmo caminho do runtime, com a data.
        pagamento = await withTenant(api.db.db, clinicaA, async (tx) => {
          const [p] = await tx
            .insert(payments)
            .values({ tenantId: clinicaA, chargeId: c.id, cashSessionId: caixaA, method: 'dinheiro', amountCents: 4200, receivedAt: quando, receivedBy: recepA.userId })
            .returning({ id: payments.id });
          await tx.update(charges).set({ paidCents: 4200 }).where(eq(charges.id, c.id));
          return p!.id;
        }, recepA.userId);
      } else {
        pagamento = (await receber(recepA, c.id, { forma: 'dinheiro' })).id;
      }
      const r = await post(recepA, `/financeiro/recebimentos/${pagamento}/recibo`, {});
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return { cobranca: c.id, recibo: id(r) };
    };
    const velho = await quitadaEm(await novoPaciente(3901), new Date('2019-06-01T12:00:00-03:00'));
    // Pago em 31/12/2021 (fuso da clínica): prazo conta de 1º/1/2022, vence só em 1º/1/2027.
    const virada = await quitadaEm(await novoPaciente(3902), new Date('2021-12-31T22:00:00-03:00'));
    const recente = await quitadaEm(await novoPaciente(3903), null);
    const pRetido = await novoPaciente(3904);
    const retido = await quitadaEm(pRetido, new Date('2018-03-01T12:00:00-03:00'));
    await api.http().put(`/prontuario/pacientes/${pRetido}/retencao-legal`).set(cab(adminA)).send({ referencia: 'Oficio ficticio fiscal 1' }).expect(200);

    // Antes do prazo, nem direto no banco (qualquer papel): o trigger confere o prazo.
    expect(
      await sqlstate(
        withTenant(api.db.db, clinicaA, (tx) =>
          tx.update(charges).set({ payerName: null, payerCpfEnc: null, fiscalPurgedAt: new Date() }).where(eq(charges.id, recente.cobranca)), recepA.userId),
      ),
    ).toContain('55000');
    expect(
      await sqlstate(withTenant(api.db.db, clinicaA, (tx) => tx.update(receipts).set({ contentEnc: null }).where(eq(receipts.id, velho.recibo)), recepA.userId)),
    ).toContain('42501');

    // Só o admin executa (recepção não).
    expect((await post(recepA, '/financeiro/retencao-fiscal/execucao', {})).status).toBe(403);
    const r1 = await post(adminA, '/financeiro/retencao-fiscal/execucao', {});
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect(r1.body).toMatchObject({ recibosEliminados: 1, cobrancasEliminadas: 1 });
    // Idempotente.
    expect((await post(adminA, '/financeiro/retencao-fiscal/execucao', {})).body).toMatchObject({ recibosEliminados: 0, cobrancasEliminadas: 0 });
    // Como job do sistema (sentinela, sem usuário) também roda e dá zero.
    const job = await api.app.get(RetencaoFiscalService).executarComoSistema(clinicaA, { tenantId: clinicaA, userId: adminA.userId as UserId, roles: [] });
    expect(job).toMatchObject({ recibosEliminados: 0, cobrancasEliminadas: 0 });

    const recibo = async (rid: string) => (await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(receipts).where(eq(receipts.id, rid))))[0];
    const cobr = async (cid: string) => (await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(charges).where(eq(charges.id, cid))))[0];
    expect(await recibo(velho.recibo)).toMatchObject({ contentEnc: null });
    expect((await recibo(velho.recibo))?.fiscalPurgedAt).not.toBeNull();
    expect(await cobr(velho.cobranca)).toMatchObject({ payerName: null, payerCpfEnc: null, paidCents: 4200, amountCents: 4200 });
    expect((await get(finA, `/financeiro/recibos/${velho.recibo}`)).body).toMatchObject({ codigo: 'recibo_eliminado_por_retencao_fiscal' });
    for (const ficou of [virada, recente, retido]) {
      expect((await recibo(ficou.recibo))?.contentEnc).toMatch(/^v1:/);
      expect((await cobr(ficou.cobranca))?.payerName).toBe(PAGADOR);
    }
    // Eliminado não volta nem se reescreve.
    expect(
      await sqlstate(withTenant(api.db.db, clinicaA, (tx) => tx.update(charges).set({ payerName: 'Outro', fiscalPurgedAt: null }).where(eq(charges.id, velho.cobranca)), recepA.userId)),
    ).toContain('42501');
    const trilha = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(auditLog).where(eq(auditLog.scope, 'finance.fiscal_retention')));
    expect(trilha.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(trilha)).not.toContain(PAGADOR);
  });
});

describe('R9 e R10 do #65: o banco garante paid_cents e a numeração', () => {
  it('paid_cents só acompanha os recebimentos; recebimento sem paid_cents é recusado no COMMIT', async () => {
    const c = await cobranca(recepA, { agendamentoId: await agendamento(), valorCentavos: 800 });
    const sessao = (fn: Parameters<typeof withTenant>[2]) => withTenant(api.db.db, clinicaA, fn, recepA.userId);
    // Marcar como paga sem recebimento.
    expect(await sqlstate(sessao((tx) => tx.update(charges).set({ paidCents: 800 }).where(eq(charges.id, c.id))))).toContain('23514');
    // Recebimento sem atualizar a cobrança (ou atualizando errado).
    const pagar = (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) =>
      tx.insert(payments).values({ tenantId: clinicaA, chargeId: c.id, cashSessionId: caixaA, method: 'dinheiro', amountCents: 300, receivedBy: recepA.userId });
    expect(await sqlstate(sessao(async (tx) => { await pagar(tx); }))).toContain('23514');
    expect(await sqlstate(sessao(async (tx) => { await pagar(tx); await tx.update(charges).set({ paidCents: 800 }).where(eq(charges.id, c.id)); }))).toContain('23514');
    // Pela API continua coerente: recebe, estorna, recebe o saldo.
    const p = await receber(recepA, c.id, { valorCentavos: 300, forma: 'dinheiro' });
    await post(finA, `/financeiro/recebimentos/${p.id}/estornar`, { motivo: 'lancamento_errado' }).expect(200);
    // Estorno sem devolver o saldo: recusado no COMMIT.
    const p2 = await receber(recepA, c.id, { valorCentavos: 200, forma: 'dinheiro' });
    expect(
      await sqlstate(
        withTenant(api.db.db, clinicaA, (tx) =>
          tx.insert(paymentReversals).values({ tenantId: clinicaA, paymentId: p2.id, cashSessionId: caixaA, reason: 'lancamento_errado', reversedBy: finA.userId }), finA.userId),
      ),
    ).toContain('23514');
    expect((await receber(recepA, c.id, { forma: 'dinheiro' })).cobranca).toMatchObject({ situacao: 'paga', saldoCentavos: 0 });
  });

  it('contador nasce em 1; número que não virou recibo é recusado no COMMIT', async () => {
    const nova = await api.novaClinica();
    const s = api.sessao(nova, 'admin');
    // Começar em 500 abre buraco: recusado.
    expect(await sqlstate(withTenant(api.db.db, nova, (tx) => tx.insert(receiptCounters).values({ tenantId: nova, lastNumber: 500 }), s.userId))).toContain('23514');
    // Começar em 1 sem emitir o recibo 1: recusado no COMMIT.
    expect(await sqlstate(withTenant(api.db.db, nova, (tx) => tx.insert(receiptCounters).values({ tenantId: nova, lastNumber: 1 }), s.userId))).toContain('23514');
    // Na clínica A (que já emite): avançar o contador sem recibo também.
    expect(
      await sqlstate(
        withTenant(api.db.db, clinicaA, (tx) => tx.update(receiptCounters).set({ lastNumber: sql`${receiptCounters.lastNumber} + 1` }).where(eq(receiptCounters.tenantId, clinicaA)), recepA.userId),
      ),
    ).toContain('23514');
  });
});

describe('N2 da conferência do #67: via oficial do recibo (IR) e via de conferência da recepção', () => {
  it('a recepção entrega a via de conferência ("não vale para IR"); a oficial, completa e auditada, só admin e financeiro', async () => {
    await api.http().put(`/financeiro/profissionais/${profissionalPfA}/perfil-fiscal`).set(cab(finA)).send({ cpf: cpfFicticio(302) }).expect(200);
    const c = await cobranca(recepA, {
      agendamentoId: await agendamento({ prof: profissionalPfA }),
      valorCentavos: 15000,
      atendimentoPor: 'pf',
      pagador: { nome: PAGADOR, cpf: cpfFicticio(303) },
    });
    const p = await receber(recepA, c.id, { forma: 'dinheiro' });
    const r = await post(recepA, `/financeiro/recebimentos/${p.id}/recibo`);
    expect(r.status).toBe(200);
    // Via de conferência: CPF mascarado e o aviso explícito de que não vale para o IR.
    expect(r.body).toMatchObject({ via: 'conferencia', cpfMascarado: true, pagador: { cpf: mascararCpf(cpfFicticio(303)) } });
    expect((r.body as { aviso: string }).aviso).toMatch(/via de conferência, não vale para IR/i);
    expect((await get(recepA, `/financeiro/recibos/${id(r)}`)).body).toMatchObject({ via: 'conferencia', cpfMascarado: true });
    // A leitura do financeiro também é conferência (a via oficial é um ato próprio, auditado).
    expect((await get(finA, `/financeiro/recibos/${id(r)}`)).body).toMatchObject({ via: 'conferencia', cpfMascarado: false });

    // Recepção e profissional não emitem a via oficial (403, sem CPF na resposta).
    for (const s of [recepA, profA]) {
      const neg = await post(s, `/financeiro/recibos/${id(r)}/via-oficial`);
      expect(neg.status).toBe(403);
      expect(JSON.stringify(neg.body)).not.toContain(cpfFicticio(303));
    }
    // Admin e financeiro: CPFs completos (pagador, beneficiário, emitente PF), sem o aviso de conferência.
    for (const s of [finA, adminA]) {
      const of = await post(s, `/financeiro/recibos/${id(r)}/via-oficial`);
      expect(of.status, JSON.stringify(of.body)).toBe(200);
      expect(of.body).toMatchObject({
        via: 'oficial',
        cpfMascarado: false,
        numero: (r.body as { numero: number }).numero,
        emitente: { tipo: 'pf', documento: cpfFicticio(302) },
        pagador: { nome: PAGADOR, cpf: cpfFicticio(303) },
        beneficiario: { cpf: cpfFicticio(301) },
      });
      expect((of.body as { aviso: string }).aviso).not.toMatch(/não vale/i);
    }
    // Corpo com campo: 400; recibo de outra clínica: 404.
    expect((await post(finA, `/financeiro/recibos/${id(r)}/via-oficial`, { cpf: cpfFicticio(303) })).status).toBe(400);
    expect((await post(adminB, `/financeiro/recibos/${id(r)}/via-oficial`)).status).toBe(404);

    // Trilha: uma exportação por via oficial emitida, só ids e número (sem CPF, nome ou valor).
    const trilha = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(auditLog).where(eq(auditLog.tenantId, clinicaA)));
    const oficiais = trilha.filter(
      (l) => l.scope === 'receipts' && (l.metadata as { op?: string }).op === 'official_copy' && (l.metadata as { receipt_id?: string }).receipt_id === id(r),
    );
    expect(oficiais).toHaveLength(2);
    expect(oficiais.map((l) => l.action)).toEqual(['export', 'export']);
    expect(new Set(oficiais.map((l) => l.actorId))).toEqual(new Set([finA.userId, adminA.userId]));
    // Sem os UUIDs (receipt_id etc.): um id aleatório pode conter "15000"; o valor só conta como número inteiro.
    const serial = JSON.stringify(oficiais.map((l) => l.metadata)).replace(UUID_RE, '<uuid>');
    for (const proibido of [cpfFicticio(301), cpfFicticio(302), cpfFicticio(303), PAGADOR]) expect(serial).not.toContain(proibido);
    expect(serial).not.toMatch(/(?<![\w-])15000(?![\w-])/);

    // Recibo cancelado não tem via oficial.
    await post(finA, `/financeiro/recibos/${id(r)}/cancelar`, { motivo: 'dados_incorretos' }).expect(200);
    expect((await post(finA, `/financeiro/recibos/${id(r)}/via-oficial`)).body).toMatchObject({ codigo: 'recibo_cancelado' });
  });
});
