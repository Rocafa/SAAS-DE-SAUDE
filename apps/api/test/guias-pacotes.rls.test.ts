/**
 * Guias de convênio e pacotes de sessões (migração 0011) contra Postgres REAL: isolamento entre
 * clínicas em insurers, insurance_guides, guide_sessions, guide_session_signatures, session_packages e
 * package_sessions; saldo nunca negativo com transações PARALELAS; estorno (manual e automático pela
 * agenda); guia vencida bloqueia sem override; assinatura append-only; alertas, relatório, permissões
 * e auditoria sem conteúdo. Pré-requisitos: migrações aplicadas e DATABASE_URL = papel app_user.
 * Dados 100% fictícios, gerados a cada execução.
 */
import type { TenantId } from '@plataforma/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appointments,
  auditLog,
  guideSessions,
  guideSessionSignatures,
  insuranceGuides,
  insurers,
  packageSessions,
  sessionPackages,
} from '../src/db/schema';
import { withTenant } from '../src/db/tenant-transaction';
import { hashDaConfirmacao, hojeNaClinica, somarDias } from '../src/modules/insurance/guias-regras';
import { noFusoDaClinica } from '../src/modules/scheduling/agenda-regras';
import { cab, subirApi, type ApiDeTeste } from './apoio-api';

type Sessao = { Authorization: string; userId: string };

let api: ApiDeTeste;
let clinicaA: TenantId;
let clinicaB: TenantId;
let adminA: Sessao;
let recepA: Sessao;
let finA: Sessao;
let profA: Sessao;
let adminB: Sessao;
let recepB: Sessao;
let profissionalA: string;
let tipoA: string;
let tipoOutroA: string;
let pacienteA: string;
let pacienteA2: string;
let convenioA: string;
let pacienteB: string;
let profissionalB: string;
let tipoB: string;
let convenioB: string;

/** Números fictícios (não são de operadora nenhuma). */
const NUMERO_GUIA = 'FIC-2026.0001';
const SENHA = 'SENHAFIC77';
const CARTEIRINHA = '0000 1111 2222';
let horaSeq = 0;

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

const id = (r: { body: unknown }) => (r.body as { id: string }).id;

async function post(s: Sessao, rota: string, corpo: object = {}) {
  return api.http().post(rota).set(cab(s)).send(corpo);
}

/** Agendamento (encaixe: não esbarra na capacidade) com check-in feito. Datas futuras e distintas. */
async function sessaoRealizada(paciente = pacienteA, opts: { s?: Sessao; prof?: string; tipo?: string; checkIn?: boolean } = {}) {
  const s = opts.s ?? recepA;
  horaSeq++;
  const dia = 1 + (horaSeq % 28);
  const hora = `${String(6 + Math.floor(horaSeq / 28)).padStart(2, '0')}:00`;
  const r = await post(s, '/agendamentos', {
    pacienteId: paciente,
    profissionalId: opts.prof ?? profissionalA,
    tipoId: opts.tipo ?? tipoA,
    data: `2030-05-${String(dia).padStart(2, '0')}`,
    hora,
    encaixe: true,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  if (opts.checkIn !== false) expect((await post(s, `/agendamentos/${id(r)}/check-in`)).status).toBe(200);
  return id(r);
}

async function novaGuia(s: Sessao, extra: Record<string, unknown> = {}) {
  const r = await post(s, '/guias', {
    pacienteId: pacienteA,
    convenioId: convenioA,
    numero: `FIC-${randomUUID().slice(0, 8)}`,
    sessoesAutorizadas: 10,
    validade: somarDias(hojeNaClinica(), 60),
    ...extra,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; saldo: number; numero: string };
}

beforeAll(async () => {
  api = await subirApi();
  clinicaA = await api.novaClinica();
  clinicaB = await api.novaClinica();
  adminA = api.sessao(clinicaA, 'admin');
  // R19 do #65 (0041): estornar sessão de pacote exige o perfil registrado no banco.
  recepA = await api.membro(clinicaA, api.sessao(clinicaA, 'recepcao'), 'recepcao');
  // R20 do #65 (0042): estornar consumo de guia também exige o perfil registrado no banco.
  finA = await api.membro(clinicaA, api.sessao(clinicaA, 'financeiro'), 'financeiro');
  profA = api.sessao(clinicaA, 'profissional');
  adminB = api.sessao(clinicaB, 'admin');
  recepB = api.sessao(clinicaB, 'recepcao');

  profissionalA = id(await post(adminA, '/profissionais', { nome: 'Fisio Ficticia', especialidade: 'Fisioterapia', usuarioId: profA.userId }));
  tipoA = id(await post(adminA, '/tipos-atendimento', { nome: 'Sessao Fisio', minutos: 50 }));
  tipoOutroA = id(await post(adminA, '/tipos-atendimento', { nome: 'Pilates', minutos: 50 }));
  pacienteA = id(await post(recepA, '/pacientes', { nome: 'Paciente Ficticio Antonio', telefone: '11900000101' }));
  pacienteA2 = id(await post(recepA, '/pacientes', { nome: 'Paciente Ficticia Beatriz', telefone: '11900000102' }));
  const conv = await post(adminA, '/convenios', { nome: 'Operadora Ficticia X', valorSessaoCentavos: 4500, exigeAssinatura: true });
  expect(conv.status, JSON.stringify(conv.body)).toBe(201);
  convenioA = id(conv);

  pacienteB = id(await post(recepB, '/pacientes', { nome: 'Paciente Ficticio Outra Clinica', telefone: '11900000201' }));
  profissionalB = id(await post(adminB, '/profissionais', { nome: 'Psico B', especialidade: 'Psicologia' }));
  tipoB = id(await post(adminB, '/tipos-atendimento', { nome: 'Sessao B', minutos: 50 }));
  convenioB = id(await post(adminB, '/convenios', { nome: 'Operadora Ficticia B' }));
});

afterAll(async () => {
  await api?.fechar();
});

describe('convênios (CNV-04.1)', () => {
  it('só o dono cadastra; nome duplicado na clínica dá 409; todos listam', async () => {
    expect((await post(recepA, '/convenios', { nome: 'Outra' })).status).toBe(403);
    expect((await post(finA, '/convenios', { nome: 'Outra' })).status).toBe(403);
    const dup = await post(adminA, '/convenios', { nome: 'operadora ficticia x' });
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ codigo: 'convenio_duplicado' });
    // Mesmo nome em OUTRA clínica é livre.
    expect((await post(adminB, '/convenios', { nome: 'Operadora Ficticia X' })).status).toBe(201);
    const lista = await api.http().get('/convenios').set(cab(profA));
    expect(lista.status).toBe(200);
    expect((lista.body as { id: string }[]).map((c) => c.id)).toContain(convenioA);
    expect((lista.body as { id: string }[]).map((c) => c.id)).not.toContain(convenioB);
  });

  it('convênio inativado bloqueia guia nova; exigência de senha vale no registro', async () => {
    const c = id(await post(adminA, '/convenios', { nome: 'Operadora Ficticia Senha', exigeSenha: true, validadePadraoDias: 30 }));
    const semSenha = await post(recepA, '/guias', { pacienteId: pacienteA, convenioId: c, numero: 'FIC-S1', sessoesAutorizadas: 5 });
    expect(semSenha.status).toBe(400);
    expect(semSenha.body).toMatchObject({ campos: ['senha'] });
    const comSenha = await post(recepA, '/guias', { pacienteId: pacienteA, convenioId: c, numero: 'FIC-S1', senha: 'X1', sessoesAutorizadas: 5 });
    expect(comSenha.status).toBe(201);
    // Validade padrão do convênio: 30 dias a partir de hoje.
    expect(comSenha.body).toMatchObject({ validade: somarDias(hojeNaClinica(), 30) });
    expect((await post(adminA, `/convenios/${c}/inativar`)).status).toBe(200);
    const bloqueada = await post(recepA, '/guias', { pacienteId: pacienteA, convenioId: c, numero: 'FIC-S2', senha: 'X1', sessoesAutorizadas: 5 });
    expect(bloqueada.status).toBe(409);
    expect(bloqueada.body).toMatchObject({ codigo: 'convenio_inativo' });
  });
});

describe('guias (CNV-04.2): registro, cifragem e duplicidade', () => {
  let guia: string;

  it('recepção registra; número, senha e carteirinha ficam só cifrados no banco', async () => {
    const r = await post(recepA, '/guias', {
      pacienteId: pacienteA,
      convenioId: convenioA,
      numero: NUMERO_GUIA,
      senha: SENHA,
      carteirinha: CARTEIRINHA,
      sessoesAutorizadas: 10,
      emissao: hojeNaClinica(),
      validade: somarDias(hojeNaClinica(), 90),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({
      numero: NUMERO_GUIA,
      senha: SENHA,
      carteirinha: CARTEIRINHA,
      convenio: 'Operadora Ficticia X',
      sessoesAutorizadas: 10,
      sessoesUsadas: 0,
      saldo: 10,
      situacao: 'ativa',
      alertas: [],
    });
    guia = id(r);
    const [linha] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(insuranceGuides).where(eq(insuranceGuides.id, guia)));
    for (const enc of [linha?.numberEnc, linha?.authorizationCodeEnc, linha?.cardNumberEnc]) expect(enc).toMatch(/^v1:/);
    const bruto = JSON.stringify(linha);
    for (const claro of [NUMERO_GUIA, SENHA, CARTEIRINHA]) expect(bruto).not.toContain(claro);
  });

  it('banco recusa número em claro (CHECK da 0011)', async () => {
    const ins = withTenant(api.db.db, clinicaA, (tx) =>
      tx.insert(insuranceGuides).values({
        tenantId: clinicaA,
        patientId: pacienteA,
        insurerId: convenioA,
        numberEnc: '123456',
        authorizedSessions: 1,
        validUntil: '2030-01-01',
      }),
    );
    expect(await sqlstate(ins)).toContain('23514');
  });

  it('mesmo número no mesmo convênio (com outra pontuação) é bloqueado; em outro convênio, não', async () => {
    const dup = await post(finA, '/guias', { pacienteId: pacienteA2, convenioId: convenioA, numero: 'fic 2026 0001', sessoesAutorizadas: 3, validade: '2030-01-01' });
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ codigo: 'guia_duplicada' });
    expect(JSON.stringify(dup.body)).not.toMatch(/fic\W*2026\W*0001/i); // só "2026" casaria com UUID aleatório
    const outro = id(await post(adminA, '/convenios', { nome: 'Operadora Ficticia Y' }));
    expect((await post(finA, '/guias', { pacienteId: pacienteA2, convenioId: outro, numero: NUMERO_GUIA, sessoesAutorizadas: 3, validade: '2030-01-01' })).status).toBe(201);
  });

  it('lista e detalhe por perfil; profissional lê mas não registra; número na URL dá 400', async () => {
    expect((await post(profA, '/guias', { pacienteId: pacienteA, convenioId: convenioA, numero: 'FIC-P', sessoesAutorizadas: 1, validade: '2030-01-01' })).status).toBe(403);
    const lista = await api.http().get('/guias').query({ pacienteId: pacienteA }).set(cab(profA));
    expect(lista.status).toBe(200);
    const item = (lista.body as { itens: Record<string, unknown>[] }).itens.find((g) => g.id === guia);
    expect(item).toMatchObject({ numero: NUMERO_GUIA, saldo: 10 });
    // A lista não traz senha nem carteirinha (só o detalhe).
    expect(item).not.toHaveProperty('senha');
    expect(item).not.toHaveProperty('carteirinha');
    const naUrl = await api.http().get('/guias').query({ numero: NUMERO_GUIA }).set(cab(recepA));
    expect(naUrl.status).toBe(400);
    expect(naUrl.body).toMatchObject({ campos: ['dado_na_url'] });
    expect((await api.http().get(`/guias/${guia}`).query({ senha: 'x' }).set(cab(recepA))).status).toBe(400);
  });

  it('PATCH não reduz autorizadas abaixo das usadas; cancelar não apaga', async () => {
    const g = await novaGuia(recepA, { sessoesAutorizadas: 2 });
    const ag = await sessaoRealizada();
    expect((await post(recepA, `/guias/${g.id}/consumos`, { agendamentoId: ag })).status).toBe(201);
    const menos = await api.http().patch(`/guias/${g.id}`).set(cab(recepA)).send({ sessoesAutorizadas: 1, senha: null });
    expect(menos.status, JSON.stringify(menos.body)).toBe(200);
    const abaixo = await api.http().patch(`/guias/${g.id}`).set(cab(recepA)).send({ sessoesAutorizadas: 1 });
    expect(abaixo.status).toBe(200);
    expect(abaixo.body).toMatchObject({ saldo: 0, situacao: 'esgotada' });
    // Volta o consumo e tenta 0... autorizadas mínimo 1; simula o conflito com outra guia.
    const g2 = await novaGuia(recepA, { sessoesAutorizadas: 3 });
    for (let i = 0; i < 2; i++) expect((await post(recepA, `/guias/${g2.id}/consumos`, { agendamentoId: await sessaoRealizada() })).status).toBe(201);
    const conflito = await api.http().patch(`/guias/${g2.id}`).set(cab(recepA)).send({ sessoesAutorizadas: 1 });
    expect(conflito.status).toBe(409);
    expect(conflito.body).toMatchObject({ codigo: 'autorizadas_abaixo_das_usadas' });
    expect((await post(recepA, `/guias/${g2.id}/cancelar`)).body).toEqual({ id: g2.id, situacao: 'cancelada' });
    const consumoNaCancelada = await post(recepA, `/guias/${g2.id}/consumos`, { agendamentoId: await sessaoRealizada() });
    expect(consumoNaCancelada.body).toMatchObject({ codigo: 'guia_cancelada' });
    const historico = await api.http().get(`/guias/${g2.id}/consumos`).set(cab(recepA));
    expect((historico.body as unknown[]).length).toBe(2);
  });
});

describe('consumo, estorno e guia vencida (CNV-04.3)', () => {
  it('consome só com sessão realizada, uma vez por agendamento, do mesmo paciente', async () => {
    const g = await novaGuia(recepA);
    const marcado = await sessaoRealizada(pacienteA, { checkIn: false });
    const semSessao = await post(recepA, `/guias/${g.id}/consumos`, { agendamentoId: marcado });
    expect(semSessao.status).toBe(409);
    expect(semSessao.body).toMatchObject({ codigo: 'agendamento_sem_sessao' });

    const ag = await sessaoRealizada();
    const ok = await post(profA, `/guias/${g.id}/consumos`, { agendamentoId: ag });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toMatchObject({ guiaId: g.id, sessoesUsadas: 1, saldo: 9, situacao: 'ativa' });
    const denovo = await post(recepA, `/guias/${g.id}/consumos`, { agendamentoId: ag });
    expect(denovo.body).toMatchObject({ codigo: 'sessao_ja_consumida' });
    // Nem pelo pacote: a sessão já foi coberta pela guia.
    const pac = id(await post(recepA, '/pacotes', { pacienteId: pacienteA, nome: 'Pacote Ficticio', total: 5 }));
    expect((await post(recepA, `/pacotes/${pac}/consumos`, { agendamentoId: ag })).body).toMatchObject({ codigo: 'sessao_ja_consumida' });

    const deOutro = await sessaoRealizada(pacienteA2);
    expect((await post(recepA, `/guias/${g.id}/consumos`, { agendamentoId: deOutro })).body).toMatchObject({ codigo: 'paciente_diferente' });
  });

  it('estorno manual devolve o saldo, uma vez só, com motivo auditado', async () => {
    const g = await novaGuia(recepA);
    const c = await post(recepA, `/guias/${g.id}/consumos`, { agendamentoId: await sessaoRealizada() });
    const consumoId = (c.body as { consumoId: string }).consumoId;
    const semMotivo = await post(recepA, `/guias/${g.id}/consumos/${consumoId}/estornar`, {});
    expect(semMotivo.status).toBe(400);
    const est = await post(finA, `/guias/${g.id}/consumos/${consumoId}/estornar`, { motivo: 'lancamento_errado' });
    expect(est.status).toBe(200);
    expect(est.body).toMatchObject({ sessoesUsadas: 0, saldo: 10 });
    expect((await post(finA, `/guias/${g.id}/consumos/${consumoId}/estornar`, { motivo: 'lancamento_errado' })).body).toMatchObject({
      codigo: 'consumo_ja_estornado',
    });
    const [aud] = await withTenant(api.db.db, clinicaA, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.scope, 'guide_sessions'), sql`${auditLog.metadata}->>'guide_session_id' = ${consumoId}`, sql`${auditLog.metadata}->>'op' = 'reverse'`)),
    );
    expect(aud?.metadata).toMatchObject({ reason: 'lancamento_errado', guide_id: g.id });
  });

  it('estorno automático quando o status deixa de ser sessão realizada (chegou -> cancelado)', async () => {
    const g = await novaGuia(recepA);
    const ag = await sessaoRealizada();
    expect((await post(recepA, `/guias/${g.id}/consumos`, { agendamentoId: ag })).status).toBe(201);
    expect((await post(recepA, `/agendamentos/${ag}/status`, { status: 'confirmado' })).status).toBe(200);
    const det = await api.http().get(`/guias/${g.id}`).set(cab(recepA));
    expect(det.body).toMatchObject({ sessoesUsadas: 0, saldo: 10 });
    const hist = (await api.http().get(`/guias/${g.id}/consumos`).set(cab(recepA))).body as { motivoEstorno: string | null }[];
    expect(hist.map((h) => h.motivoEstorno)).toEqual(['status_corrigido']);
  });

  it('guia vencida bloqueia o consumo; override só com motivo codificado, e fica auditado', async () => {
    const g = await novaGuia(recepA, { validade: somarDias(hojeNaClinica(), -1), sessoesAutorizadas: 5 });
    const det = await api.http().get(`/guias/${g.id}`).set(cab(recepA));
    expect(det.body).toMatchObject({ situacao: 'vencida', alertas: [{ tipo: 'vencida' }] });
    const ag = await sessaoRealizada();
    const bloqueado = await post(recepA, `/guias/${g.id}/consumos`, { agendamentoId: ag });
    expect(bloqueado.status).toBe(409);
    expect(bloqueado.body).toMatchObject({ codigo: 'guia_vencida' });
    expect((await post(recepA, `/guias/${g.id}/consumos`, { agendamentoId: ag, overrideMotivo: 'texto livre' })).status).toBe(400);
    const comOverride = await post(recepA, `/guias/${g.id}/consumos`, { agendamentoId: ag, overrideMotivo: 'prorrogacao_da_operadora' });
    expect(comOverride.status).toBe(201);
    const consumoId = (comOverride.body as { consumoId: string }).consumoId;
    const [linha] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(guideSessions).where(eq(guideSessions.id, consumoId)));
    expect(linha?.overrideReason).toBe('prorrogacao_da_operadora');
    const [aud] = await withTenant(api.db.db, clinicaA, (tx) =>
      tx.select().from(auditLog).where(sql`${auditLog.metadata}->>'guide_session_id' = ${consumoId}`),
    );
    expect(aud?.metadata).toMatchObject({ op: 'consume', override: true, reason: 'prorrogacao_da_operadora' });
  });
});

describe('saldo nunca negativo sob concorrência (transações paralelas)', () => {
  it('guia com 3 sessões e 8 consumos simultâneos: exatamente 3 passam', async () => {
    const g = await novaGuia(recepA, { sessoesAutorizadas: 3 });
    const ags: string[] = [];
    for (let i = 0; i < 8; i++) ags.push(await sessaoRealizada());
    const respostas = await Promise.all(ags.map((ag) => post(recepA, `/guias/${g.id}/consumos`, { agendamentoId: ag })));
    const status = respostas.map((r) => r.status).sort();
    expect(status).toEqual([201, 201, 201, 409, 409, 409, 409, 409]);
    for (const r of respostas.filter((x) => x.status === 409)) expect(r.body).toMatchObject({ codigo: 'guia_sem_saldo' });
    const [linha] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(insuranceGuides).where(eq(insuranceGuides.id, g.id)));
    const ativos = await withTenant(api.db.db, clinicaA, (tx) =>
      tx.select().from(guideSessions).where(and(eq(guideSessions.guideId, g.id), isNull(guideSessions.reversedAt))),
    );
    // Saldo sempre igual à contagem de sessões consumidas (CNV-04.3).
    expect(linha?.usedSessions).toBe(3);
    expect(ativos).toHaveLength(3);
  });

  it('o mesmo agendamento em duas guias ao mesmo tempo: só um consumo', async () => {
    const g1 = await novaGuia(recepA);
    const g2 = await novaGuia(recepA);
    const ag = await sessaoRealizada();
    const [r1, r2] = await Promise.all([
      post(recepA, `/guias/${g1.id}/consumos`, { agendamentoId: ag }),
      post(finA, `/guias/${g2.id}/consumos`, { agendamentoId: ag }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([201, 409]);
  });

  it('pacote com 2 sessões e 6 consumos simultâneos: exatamente 2 passam', async () => {
    const pac = id(await post(finA, '/pacotes', { pacienteId: pacienteA, nome: 'Pacote Ficticio Corrida', total: 2 }));
    const ags: string[] = [];
    for (let i = 0; i < 6; i++) ags.push(await sessaoRealizada());
    const respostas = await Promise.all(ags.map((ag) => post(recepA, `/pacotes/${pac}/consumos`, { agendamentoId: ag })));
    expect(respostas.map((r) => r.status).sort()).toEqual([201, 201, 409, 409, 409, 409]);
    const [p] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(sessionPackages).where(eq(sessionPackages.id, pac)));
    expect(p?.usedSessions).toBe(2);
  });

  it('o banco recusa saldo negativo ou acima do autorizado mesmo sem a API (CHECK)', async () => {
    const g = await novaGuia(recepA, { sessoesAutorizadas: 2 });
    const acima = withTenant(api.db.db, clinicaA, (tx) =>
      tx.update(insuranceGuides).set({ usedSessions: 3 }).where(eq(insuranceGuides.id, g.id)),
    );
    expect(await sqlstate(acima)).toContain('23514');
    const negativo = withTenant(api.db.db, clinicaA, (tx) =>
      tx.update(insuranceGuides).set({ usedSessions: -1 }).where(eq(insuranceGuides.id, g.id)),
    );
    expect(await sqlstate(negativo)).toContain('23514');
  });
});

describe('confirmação do paciente por sessão (CNV-04.4)', () => {
  it('registra meio, dispositivo, instante e hash; uma vez; pendência some', async () => {
    const g = await novaGuia(recepA);
    const c1 = (await post(recepA, `/guias/${g.id}/consumos`, { agendamentoId: await sessaoRealizada() })).body as { consumoId: string };
    const ag2 = await sessaoRealizada();
    const c2 = (await post(recepA, `/guias/${g.id}/consumos`, { agendamentoId: ag2 })).body as { consumoId: string };
    const ass = await post(profA, `/guias/${g.id}/consumos/${c1.consumoId}/assinatura`, { meio: 'tela', dispositivo: 'tablet-recepcao-1' });
    expect(ass.status, JSON.stringify(ass.body)).toBe(201);
    const corpo = ass.body as { id: string; assinadaEm: string; hash: string };
    expect(corpo.hash).toMatch(/^[0-9a-f]{64}$/);
    const [linha] = await withTenant(api.db.db, clinicaA, (tx) =>
      tx.select().from(guideSessionSignatures).where(eq(guideSessionSignatures.id, corpo.id)),
    );
    const [consumo] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(guideSessions).where(eq(guideSessions.id, c1.consumoId)));
    // Quem audita recalcula o hash a partir do registro guardado.
    expect(
      hashDaConfirmacao({
        tenantId: clinicaA,
        consumoId: c1.consumoId,
        agendamentoId: consumo?.appointmentId ?? '',
        guiaId: g.id,
        meio: 'tela',
        dispositivo: linha?.deviceLabel ?? null,
        assinadaEm: linha?.signedAt ?? new Date(0),
        registradoPor: linha?.recordedBy ?? '',
      }),
    ).toBe(linha?.recordHash);
    expect((await post(recepA, `/guias/${g.id}/consumos/${c1.consumoId}/assinatura`, { meio: 'papel' })).body).toMatchObject({
      codigo: 'sessao_ja_assinada',
    });
    const hist = (await api.http().get(`/guias/${g.id}/consumos`).set(cab(recepA))).body as { id: string; assinaturaPendente: boolean }[];
    expect(hist.find((h) => h.id === c1.consumoId)?.assinaturaPendente).toBe(false);
    expect(hist.find((h) => h.id === c2.consumoId)?.assinaturaPendente).toBe(true);
    // Consumo estornado não recebe assinatura.
    expect((await post(recepA, `/agendamentos/${ag2}/status`, { status: 'confirmado' })).status).toBe(200);
    expect((await post(recepA, `/guias/${g.id}/consumos/${c2.consumoId}/assinatura`, { meio: 'tela' })).body).toMatchObject({
      codigo: 'consumo_estornado',
    });
  });

  it('assinatura é append-only: o banco recusa alterar ou apagar', async () => {
    const [qualquer] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(guideSessionSignatures).limit(1));
    expect(qualquer).toBeDefined();
    const alterar = withTenant(api.db.db, clinicaA, (tx) =>
      tx.update(guideSessionSignatures).set({ method: 'papel' }).where(eq(guideSessionSignatures.id, qualquer?.id ?? '')),
    );
    expect(await sqlstate(alterar)).toContain('42501');
    const apagar = withTenant(api.db.db, clinicaA, (tx) => tx.delete(guideSessionSignatures).where(eq(guideSessionSignatures.id, qualquer?.id ?? '')));
    expect(await sqlstate(apagar)).toContain('42501');
    const apagarConsumo = withTenant(api.db.db, clinicaA, (tx) => tx.delete(guideSessions).where(eq(guideSessions.tenantId, clinicaA)));
    expect(await sqlstate(apagarConsumo)).toContain('42501');
  });
});

describe('alertas (CNV-04.5) e relatório por convênio (CNV-04.6)', () => {
  it('alertas calculados no servidor: vence em X dias, só resta 1 sessão, vencida', async () => {
    const vence = await novaGuia(recepA, { validade: somarDias(hojeNaClinica(), 3), pacienteId: pacienteA2 });
    const ultima = await novaGuia(recepA, { sessoesAutorizadas: 2 });
    expect((await post(recepA, `/guias/${ultima.id}/consumos`, { agendamentoId: await sessaoRealizada() })).status).toBe(201);
    const vencida = await novaGuia(recepA, { validade: somarDias(hojeNaClinica(), -2) });
    const r = await api.http().get('/guias/alertas').set(cab(recepA));
    expect(r.status).toBe(200);
    const porGuia = new Map((r.body as { itens: { guiaId: string; alertas: unknown[] }[] }).itens.map((i) => [i.guiaId, i.alertas]));
    expect(porGuia.get(vence.id)).toEqual([{ tipo: 'vence_em_breve', dias: 3 }]);
    expect(porGuia.get(ultima.id)).toEqual([{ tipo: 'ultimas_sessoes', restantes: 1 }]);
    expect(porGuia.get(vencida.id)).toEqual([{ tipo: 'vencida' }]);
    // Limiar configurável na query (só números): com 2 dias, a de 3 dias sai.
    const curto = await api.http().get('/guias/alertas').query({ diasVencimento: '2' }).set(cab(recepA));
    expect((curto.body as { itens: { guiaId: string }[] }).itens.map((i) => i.guiaId)).not.toContain(vence.id);
    // O alerta não leva número da guia (preview sem identificador).
    expect(JSON.stringify(r.body)).not.toContain('FIC-');
  });

  it('relatório: dono e financeiro; recepção e profissional não; janela até 31 dias', async () => {
    const q = { de: '2030-05-01', ate: '2030-05-31' };
    expect((await api.http().get(`/convenios/${convenioA}/relatorio`).query(q).set(cab(recepA))).status).toBe(403);
    expect((await api.http().get(`/convenios/${convenioA}/relatorio`).query(q).set(cab(profA))).status).toBe(403);
    expect((await api.http().get(`/convenios/${convenioA}/relatorio`).query({ de: '2030-05-01', ate: '2030-06-01' }).set(cab(finA))).status).toBe(400);
    const r = await api.http().get(`/convenios/${convenioA}/relatorio`).query(q).set(cab(finA));
    expect(r.status).toBe(200);
    const corpo = r.body as {
      sessoes: { numeroGuia: string; assinada: boolean }[];
      totais: { sessoes: number; assinadas: number; assinaturasPendentes: number; valorCentavos: number };
    };
    // Bate com a contagem direta no banco (consumos ativos do convênio na janela).
    const [n] = await withTenant(api.db.db, clinicaA, (tx) =>
      tx.execute<{ n: number }>(sql`
        select count(*)::int as n from guide_sessions gs
        join insurance_guides g on g.id = gs.guide_id
        join appointments a on a.id = gs.appointment_id
        where g.insurer_id = ${convenioA} and gs.reversed_at is null
          and a.starts_at >= '2030-05-01T03:00:00Z' and a.starts_at < '2030-06-01T03:00:00Z'`),
    );
    expect(corpo.totais.sessoes).toBe(n?.n);
    expect(corpo.totais.sessoes).toBeGreaterThan(5);
    expect(corpo.totais.valorCentavos).toBe(4500 * corpo.totais.sessoes);
    expect(corpo.totais.assinaturasPendentes).toBe(corpo.totais.sessoes - corpo.totais.assinadas);
    expect(corpo.totais.assinadas).toBeGreaterThan(0);
    expect(corpo.sessoes.every((s) => s.numeroGuia.length > 0)).toBe(true);
  });
});

describe('pacotes (HU-FIN-004)', () => {
  it('cria, consome, saldo, histórico, estorno e tipo do pacote', async () => {
    const r = await post(recepA, '/pacotes', { pacienteId: pacienteA, nome: 'Pilates Ficticio', total: 3, tipoId: tipoOutroA });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const pac = id(r);
    expect(r.body).toMatchObject({ pacienteId: pacienteA, nome: 'Pilates Ficticio', total: 3, usadas: 0, saldo: 3, situacao: 'ativa' });
    const tipoErrado = await post(recepA, `/pacotes/${pac}/consumos`, { agendamentoId: await sessaoRealizada() });
    expect(tipoErrado.body).toMatchObject({ codigo: 'tipo_diferente' });
    const c1 = await post(profA, `/pacotes/${pac}/consumos`, { agendamentoId: await sessaoRealizada(pacienteA, { tipo: tipoOutroA }) });
    expect(c1.status).toBe(201);
    expect(c1.body).toMatchObject({ usadas: 1, saldo: 2 });
    const det = await api.http().get(`/pacotes/${pac}`).set(cab(finA));
    // Saldo 2 com limiar do pacote (2) já mostra o aviso de saldo baixo.
    expect(det.body).toMatchObject({ saldo: 2, alertas: [{ tipo: 'ultimas_sessoes', restantes: 2 }] });
    const consumoId = (c1.body as { consumoId: string }).consumoId;
    expect((await post(recepA, `/pacotes/${pac}/consumos/${consumoId}/estornar`, { motivo: 'pacote_errado' })).body).toMatchObject({ usadas: 0, saldo: 3 });
    const hist = await api.http().get(`/pacotes/${pac}/historico`).set(cab(recepA));
    expect(hist.status).toBe(200);
    expect((hist.body as { consumos: { motivoEstorno: string }[] }).consumos.map((c) => c.motivoEstorno)).toEqual(['pacote_errado']);
    const lista = await api.http().get('/pacotes').query({ pacienteId: pacienteA }).set(cab(profA));
    expect((lista.body as { itens: { id: string }[] }).itens.map((p) => p.id)).toContain(pac);
    expect((await post(profA, '/pacotes', { pacienteId: pacienteA, nome: 'X', total: 1 })).status).toBe(403);
    expect((await post(recepA, `/pacotes/${pac}/cancelar`)).body).toMatchObject({ situacao: 'cancelada' });
    expect((await post(recepA, `/pacotes/${pac}/consumos`, { agendamentoId: await sessaoRealizada(pacienteA, { tipo: tipoOutroA }) })).body).toMatchObject({
      codigo: 'pacote_cancelado',
    });
  });
});

describe('isolamento entre clínicas', () => {
  let guiaA: string;
  let pacoteA: string;
  let consumoA: string;
  let agendamentoB: string;

  beforeAll(async () => {
    guiaA = (await novaGuia(recepA)).id;
    const ag = await sessaoRealizada();
    consumoA = ((await post(recepA, `/guias/${guiaA}/consumos`, { agendamentoId: ag })).body as { consumoId: string }).consumoId;
    pacoteA = id(await post(recepA, '/pacotes', { pacienteId: pacienteA, nome: 'Pacote A', total: 4 }));
    agendamentoB = await sessaoRealizada(pacienteB, { s: recepB, prof: profissionalB, tipo: tipoB });
  });

  it('pela API, a outra clínica recebe 404 em tudo e não vê nada na lista', async () => {
    for (const rota of [`/guias/${guiaA}`, `/guias/${guiaA}/consumos`, `/pacotes/${pacoteA}`, `/pacotes/${pacoteA}/historico`]) {
      expect((await api.http().get(rota).set(cab(adminB))).status, rota).toBe(404);
    }
    expect((await api.http().get(`/convenios/${convenioA}/relatorio`).query({ de: '2030-05-01', ate: '2030-05-31' }).set(cab(adminB))).status).toBe(404);
    expect((await post(recepB, `/guias/${guiaA}/consumos`, { agendamentoId: agendamentoB })).status).toBe(404);
    expect((await post(recepB, `/pacotes/${pacoteA}/consumos`, { agendamentoId: agendamentoB })).status).toBe(404);
    expect((await post(recepB, `/guias/${guiaA}/consumos/${consumoA}/estornar`, { motivo: 'guia_errada' })).status).toBe(404);
    expect((await post(recepB, `/guias/${guiaA}/consumos/${consumoA}/assinatura`, { meio: 'tela' })).status).toBe(404);
    expect((await post(recepB, `/guias/${guiaA}/cancelar`)).status).toBe(404);
    expect((await api.http().patch(`/convenios/${convenioA}`).set(cab(adminB)).send({ nome: 'Tomado' })).status).toBe(404);
    // Guia em B apontando paciente ou convênio de A: 404.
    expect((await post(recepB, '/guias', { pacienteId: pacienteA, convenioId: convenioB, numero: 'FIC-B1', sessoesAutorizadas: 1, validade: '2030-01-01' })).status).toBe(404);
    expect((await post(recepB, '/guias', { pacienteId: pacienteB, convenioId: convenioA, numero: 'FIC-B2', sessoesAutorizadas: 1, validade: '2030-01-01' })).status).toBe(404);
    // Guia de B consumindo agendamento de A: 404.
    const guiaB = id(await post(recepB, '/guias', { pacienteId: pacienteB, convenioId: convenioB, numero: 'FIC-B3', sessoesAutorizadas: 2, validade: '2030-01-01' }));
    expect((await post(recepB, `/guias/${guiaB}/consumos`, { agendamentoId: await sessaoRealizada() })).status).toBe(404);
    const listaB = await api.http().get('/guias').query({ situacao: 'todas', limite: '100' }).set(cab(adminB));
    expect((listaB.body as { itens: { id: string }[] }).itens.map((g) => g.id)).toEqual([guiaB]);
    const pacotesB = await api.http().get('/pacotes').query({ situacao: 'todos' }).set(cab(adminB));
    expect((pacotesB.body as { itens: unknown[] }).itens).toEqual([]);
    const alertasB = JSON.stringify((await api.http().get('/guias/alertas').query({ diasVencimento: '90', sessoesRestantes: '20' }).set(cab(adminB))).body);
    expect(alertasB).not.toContain(guiaA);
  });

  it('pelo banco (RLS), no contexto de B nenhuma linha de A aparece e não se grava em A', async () => {
    const contagens = await withTenant(api.db.db, clinicaB, async (tx) => ({
      insurers: (await tx.select().from(insurers).where(eq(insurers.tenantId, clinicaA))).length,
      insuranceGuides: (await tx.select().from(insuranceGuides).where(eq(insuranceGuides.tenantId, clinicaA))).length,
      guideSessions: (await tx.select().from(guideSessions).where(eq(guideSessions.tenantId, clinicaA))).length,
      guideSessionSignatures: (await tx.select().from(guideSessionSignatures).where(eq(guideSessionSignatures.tenantId, clinicaA))).length,
      sessionPackages: (await tx.select().from(sessionPackages).where(eq(sessionPackages.tenantId, clinicaA))).length,
      packageSessions: (await tx.select().from(packageSessions).where(eq(packageSessions.tenantId, clinicaA))).length,
    }));
    expect(contagens).toEqual({ insurers: 0, insuranceGuides: 0, guideSessions: 0, guideSessionSignatures: 0, sessionPackages: 0, packageSessions: 0 });
    // UPDATE em linha de A a partir de B: 0 linhas (invisível).
    const afetadas = await withTenant(api.db.db, clinicaB, (tx) =>
      tx.update(insuranceGuides).set({ usedSessions: 0 }).where(eq(insuranceGuides.id, guiaA)).returning({ id: insuranceGuides.id }),
    );
    expect(afetadas).toEqual([]);
    // INSERT com tenant_id de A no contexto de B: RLS recusa.
    const intruso = withTenant(api.db.db, clinicaB, (tx) =>
      tx.insert(sessionPackages).values({ tenantId: clinicaA, patientId: pacienteA, name: 'Intruso', totalSessions: 1 }),
    );
    expect(await sqlstate(intruso)).toContain('42501');
    // Consumo em B apontando a guia de A: a FK composta (id, tenant_id) não acha a guia.
    const cruzado = withTenant(api.db.db, clinicaB, (tx) =>
      tx.insert(guideSessions).values({ tenantId: clinicaB, guideId: guiaA, appointmentId: agendamentoB, consumedBy: randomUUID() }),
    );
    expect(await sqlstate(cruzado)).toContain('23503');
  });
});

describe('R20 do #65: consumo de guia só aceita o estorno (0042)', () => {
  /** UPDATE em SQL arbitrário (como um SQL injetado faria), no contexto da clínica A e do usuário dado. */
  const sqlUpd = (consumoId: string, sets: ReturnType<typeof sql>, quem?: string) =>
    withTenant(api.db.db, clinicaA, (tx) => tx.execute(sql`update guide_sessions set ${sets} where id = ${consumoId}::uuid`), quem);
  const linha = async (consumoId: string) =>
    (await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(guideSessions).where(eq(guideSessions.id, consumoId))))[0]!;
  const consumir = async (guiaId: string, extra: Record<string, unknown> = {}) => {
    const r = await post(recepA, `/guias/${guiaId}/consumos`, { agendamentoId: await sessaoRealizada(), ...extra });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return (r.body as { consumoId: string }).consumoId;
  };

  it('SQL arbitrário não desfaz estorno nem troca guia, agendamento, autoria ou override; estorno só em nome próprio', async () => {
    const g = await novaGuia(recepA, { validade: somarDias(hojeNaClinica(), -1) });
    const outraGuia = await novaGuia(recepA);
    const estornado = await consumir(g.id, { overrideMotivo: 'prorrogacao_da_operadora' });
    expect((await post(finA, `/guias/${g.id}/consumos/${estornado}/estornar`, { motivo: 'lancamento_errado' })).status).toBe(200);
    const vivo = await consumir(g.id, { overrideMotivo: 'renovacao_em_andamento' });
    const outroAg = await sessaoRealizada();
    const adminReg = await api.membro(clinicaA, api.sessao(clinicaA, 'admin'), 'admin');
    const antesY = await linha(estornado);
    const antesX = await linha(vivo);

    for (const s of [recepA, finA, adminReg, profA]) {
      const u = s.userId;
      // Desfazer o estorno ou reescrever motivo/autor de um estorno já feito.
      expect(await sqlstate(sqlUpd(estornado, sql`reversed_at = null, reversed_by = null, reversal_reason = null`, u))).toContain('42501');
      expect(await sqlstate(sqlUpd(estornado, sql`reversal_reason = 'guia_errada'`, u))).toContain('42501');
      expect(await sqlstate(sqlUpd(estornado, sql`reversed_by = ${u}::uuid`, u))).toContain('42501');
      // Trocar guia, agendamento, autoria, instante ou override de um consumo vivo.
      expect(await sqlstate(sqlUpd(vivo, sql`guide_id = ${outraGuia.id}::uuid`, u))).toContain('42501');
      expect(await sqlstate(sqlUpd(vivo, sql`appointment_id = ${outroAg}::uuid`, u))).toContain('42501');
      expect(await sqlstate(sqlUpd(vivo, sql`consumed_by = ${u}::uuid`, u))).toContain('42501');
      expect(await sqlstate(sqlUpd(vivo, sql`consumed_at = 'epoch'`, u))).toContain('42501');
      expect(await sqlstate(sqlUpd(vivo, sql`override_reason = 'decisao_da_clinica'`, u))).toContain('42501');
      expect(await sqlstate(sqlUpd(vivo, sql`override_reason = null`, u))).toContain('42501');
      // Estorno em nome de outra pessoa, ou "estorno" que troca a guia junto.
      const outro = s === finA ? recepA : finA;
      expect(await sqlstate(sqlUpd(vivo, sql`reversed_at = now(), reversed_by = ${outro.userId}::uuid, reversal_reason = 'guia_errada'`, u))).toContain('42501');
      expect(
        await sqlstate(sqlUpd(vivo, sql`reversed_at = now(), reversed_by = ${u}::uuid, reversal_reason = 'guia_errada', guide_id = ${outraGuia.id}::uuid`, u)),
      ).toContain('42501');
    }
    // Sem usuário na transação, nem o estorno passa.
    expect(await sqlstate(sqlUpd(vivo, sql`reversed_at = now(), reversed_by = ${finA.userId}::uuid, reversal_reason = 'guia_errada'`))).toContain('42501');

    expect(await linha(estornado)).toEqual(antesY);
    expect(await linha(vivo)).toEqual(antesX);
    expect(antesX).toMatchObject({ reversedAt: null, overrideReason: 'renovacao_em_andamento', guideId: g.id });

    // O estorno legítimo pela API continua funcionando, uma vez só.
    expect((await post(finA, `/guias/${g.id}/consumos/${vivo}/estornar`, { motivo: 'status_corrigido' })).status).toBe(200);
    expect(await sqlstate(sqlUpd(vivo, sql`reversal_reason = 'guia_errada'`, finA.userId))).toContain('42501');
    expect(await linha(vivo)).toMatchObject({ reversedBy: finA.userId, reversalReason: 'status_corrigido', overrideReason: 'renovacao_em_andamento' });
  });

  it('o estorno grava a hora do banco, não a enviada pelo cliente', async () => {
    const g = await novaGuia(recepA);
    const c = await consumir(g.id);
    const antes = Date.now();
    await sqlUpd(c, sql`reversed_at = 'epoch', reversed_by = ${finA.userId}::uuid, reversal_reason = 'lancamento_errado'`, finA.userId);
    const gravada = await linha(c);
    expect(gravada).toMatchObject({ reversedBy: finA.userId, reversalReason: 'lancamento_errado' });
    expect(gravada.reversedAt!.getTime()).toBeGreaterThan(antes - 60_000);
    expect(gravada.reversedAt!.getTime()).toBeLessThan(Date.now() + 60_000);
  });

  it('estornar exige perfil autorizado ativo em clinic_members (SQL e API)', async () => {
    const g = await novaGuia(recepA);
    const c = await consumir(g.id);
    const estornoDireto = (quem: string) =>
      sqlUpd(c, sql`reversed_at = now(), reversed_by = ${quem}::uuid, reversal_reason = 'lancamento_errado'`, quem);
    // Perfil só no token, perfil fora da lista (psicólogo), perfil revogado e usuário de outra clínica: 42501.
    const soToken = api.sessao(clinicaA, 'financeiro');
    const psicologo = await api.membro(clinicaA, api.sessao(clinicaA, 'profissional'), 'psicologo');
    const deOutraClinica = await api.membro(clinicaB, api.sessao(clinicaB, 'recepcao'), 'recepcao');
    const revogado = await api.membro(clinicaA, api.sessao(clinicaA, 'recepcao'), 'recepcao');
    const adminReg = await api.membro(clinicaA, api.sessao(clinicaA, 'admin'), 'admin');
    expect((await api.http().delete(`/clinica/membros/${revogado.userId}/recepcao`).set(cab(adminReg))).status).toBe(204);
    for (const s of [soToken, psicologo, deOutraClinica, revogado]) expect(await sqlstate(estornoDireto(s.userId))).toContain('42501');
    // Pela API, o perfil do token sem registro no banco vira 403 explicável, sem estornar nem mexer no saldo.
    const api403 = await post(soToken, `/guias/${g.id}/consumos/${c}/estornar`, { motivo: 'lancamento_errado' });
    expect(api403.status).toBe(403);
    expect(api403.body).toMatchObject({ codigo: 'perfil_nao_registrado' });
    expect(await linha(c)).toMatchObject({ reversedAt: null, reversedBy: null });
    expect((await api.http().get(`/guias/${g.id}`).set(cab(recepA))).body).toMatchObject({ sessoesUsadas: 1, saldo: 9 });
    // Perfil autorizado registrado (recepção) estorna em nome próprio.
    await estornoDireto(recepA.userId);
    expect(await linha(c)).toMatchObject({ reversedBy: recepA.userId, reversalReason: 'lancamento_errado' });
  });
});

describe('R21 do #65: correção atendido -> faltou sem perfil registrado', () => {
  const status = (s: Sessao, ag: string, novo: string) => post(s, `/agendamentos/${ag}/status`, { status: novo });

  it('o passo que estorna devolve 403 perfil_nao_registrado (não 500) e nada é gravado; com o perfil, a correção chega a faltou', async () => {
    // Sessão de agora (dentro da janela de atendimento), atendida pelo profissional e consumida na guia.
    const { data, hora } = noFusoDaClinica(new Date());
    const r = await post(recepA, '/agendamentos', { pacienteId: pacienteA, profissionalId: profissionalA, tipoId: tipoA, data, hora, encaixe: true });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const ag = id(r);
    expect((await post(recepA, `/agendamentos/${ag}/check-in`)).status).toBe(200);
    expect((await status(profA, ag, 'atendido')).status).toBe(200);
    const g = await novaGuia(recepA);
    const c = await post(recepA, `/guias/${g.id}/consumos`, { agendamentoId: ag });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const consumoId = (c.body as { consumoId: string }).consumoId;

    // Correção atendido -> faltou: atendido -> em atendimento -> chegou -> agendado (estorna) -> faltou.
    expect((await status(profA, ag, 'em_atendimento')).status).toBe(200);
    expect((await status(profA, ag, 'chegou')).status).toBe(200);
    const auditoriaAntes = await withTenant(api.db.db, clinicaA, (tx) =>
      tx.select().from(auditLog).where(sql`${auditLog.metadata}->>'appointment_id' = ${ag}`));
    // Recepção só no token (sem linha em clinic_members): o passo que estorna é recusado com 403 explicável.
    const recepSoToken = api.sessao(clinicaA, 'recepcao');
    const recusa = await status(recepSoToken, ag, 'agendado');
    expect(recusa.status, JSON.stringify(recusa.body)).toBe(403);
    expect(recusa.body).toMatchObject({ codigo: 'perfil_nao_registrado' });
    expect(JSON.stringify(recusa.body)).not.toMatch(/42501|guide_sessions|SQL/i);
    // Nada gravado: status, consumo, saldo e trilha iguais.
    const [agLinha] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(appointments).where(eq(appointments.id, ag)));
    expect(agLinha?.status).toBe('checked_in');
    const [consumo] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(guideSessions).where(eq(guideSessions.id, consumoId)));
    expect(consumo).toMatchObject({ reversedAt: null, reversedBy: null });
    expect((await api.http().get(`/guias/${g.id}`).set(cab(recepA))).body).toMatchObject({ sessoesUsadas: 1, saldo: 9 });
    const auditoriaDepois = await withTenant(api.db.db, clinicaA, (tx) =>
      tx.select().from(auditLog).where(sql`${auditLog.metadata}->>'appointment_id' = ${ag}`));
    expect(auditoriaDepois.length).toBe(auditoriaAntes.length);

    // Com o perfil registrado (recepA), a mesma correção estorna e chega a faltou.
    expect((await status(recepA, ag, 'agendado')).status).toBe(200);
    expect((await status(recepA, ag, 'faltou')).status).toBe(200);
    expect((await api.http().get(`/guias/${g.id}`).set(cab(recepA))).body).toMatchObject({ sessoesUsadas: 0, saldo: 10 });
    const [estornado] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(guideSessions).where(eq(guideSessions.id, consumoId)));
    expect(estornado).toMatchObject({ reversedBy: recepA.userId, reversalReason: 'status_corrigido' });
  });
});

describe('auditoria sem conteúdo', () => {
  it('toda operação deixou trilha e nenhuma linha leva número, senha, carteirinha ou nome', async () => {
    const linhas = await withTenant(api.db.db, clinicaA, (tx) =>
      tx
        .select()
        .from(auditLog)
        .where(
          sql`${auditLog.scope} in ('insurers', 'insurers.report', 'insurance_guides', 'insurance_guides.alerts', 'guide_sessions', 'guide_session_signatures', 'session_packages', 'package_sessions')`,
        ),
    );
    const escopos = new Set(linhas.map((l) => `${l.scope}:${l.action}`));
    for (const e of [
      'insurers:create',
      'insurers:read',
      'insurers.report:read',
      'insurance_guides:create',
      'insurance_guides:read',
      'insurance_guides:update',
      'insurance_guides.alerts:read',
      'guide_sessions:update',
      'guide_sessions:read',
      'guide_session_signatures:sign',
      'session_packages:create',
      'session_packages:read',
      'package_sessions:update',
      'package_sessions:read',
    ]) {
      expect(escopos, e).toContain(e);
    }
    const serial = JSON.stringify(linhas);
    for (const proibido of [NUMERO_GUIA, 'FIC-2026', SENHA, CARTEIRINHA, '1111 2222', 'Antonio', 'Operadora Ficticia', 'Pilates', 'tablet-recepcao']) {
      expect(serial, proibido).not.toContain(proibido);
    }
  });
});
