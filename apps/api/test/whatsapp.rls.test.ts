/**
 * Lembretes e confirmação por WhatsApp (migração 0032) contra Postgres REAL, com o adaptador FALSO
 * (nenhuma rede): sem opt-in não envia; texto neutro (falha se aparecer termo de especialidade, nome do
 * profissional ou tipo de atendimento); "1"/"2" mudam só a consulta daquele envio, dentro da janela e
 * pelas regras da agenda; webhook com assinatura inválida recusado; idempotência; fora do horário não
 * envia; menor recebe pelo responsável (porta); SAIR revoga; barreiras do banco; isolamento entre
 * clínicas em whatsapp_settings, whatsapp_opt_ins, whatsapp_templates, whatsapp_outbox e
 * whatsapp_inbound; trilha sem número nem texto.
 * Pré-requisitos: migrações aplicadas e DATABASE_URL = papel app_user. Dados 100% fictícios.
 */
import type { TenantId } from '@plataforma/shared';
import { and, eq, sql } from 'drizzle-orm';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appointments, auditLog, whatsappInbound, whatsappOptIns, whatsappOutbox, whatsappSettings, whatsappTemplates } from '../src/db/schema';
import { withTenant, type TenantTx } from '../src/db/tenant-transaction';
import { AMOSTRAS_DE_TERMOS_SENSIVEIS, MODELO_PADRAO, textoEhNeutro } from '../src/modules/messaging/lembretes-regras';
import { MensageiroFalso } from '../src/modules/messaging/mensageiro-falso';
import { assinarCorpo } from '../src/modules/messaging/mensageiro-whatsapp';
import type { FonteDeResponsaveis } from '../src/modules/messaging/responsaveis.port';
import { WhatsappService } from '../src/modules/messaging/whatsapp.service';
import { noFusoDaClinica } from '../src/modules/scheduling/agenda-regras';
import { cab, subirApi, type ApiDeTeste } from './apoio-api';

type Sessao = { Authorization: string; userId: string };

/** Segredo do webhook e token de inscrição: gerados a cada execução, nunca fixos no código. */
const SEGREDO = randomBytes(32);
const TOKEN_INSCRICAO = randomBytes(24).toString('base64url');
const falso = new MensageiroFalso({ segredoWebhook: SEGREDO, tokenInscricao: TOKEN_INSCRICAO, nodeEnv: 'test' });

/** Responsável fictício (a tabela de responsáveis é de outra branch): a porta é injetada. */
const RESPONSAVEL_ID = randomUUID();
const TELEFONE_RESPONSAVEL = `119${String(Date.now()).slice(-8)}`;
const responsaveis: FonteDeResponsaveis = {
  responsavelVigente: (_tx, _t, _p, id) => Promise.resolve(id === RESPONSAVEL_ID ? { telefone: TELEFONE_RESPONSAVEL } : null),
};

/** Termos SENSÍVEIS do cadastro: nunca podem aparecer na mensagem. */
const NOME_PROFISSIONAL = 'Dra QZX Ficticia';
const ESPECIALIDADE = 'Psiquiatria';
const TIPO_SENSIVEL = 'Consulta oncologica QZX';

let api: ApiDeTeste;
let svc: WhatsappService;
let clinicaA: TenantId;
let clinicaB: TenantId;
let adminA: Sessao;
let recepA: Sessao;
let finA: Sessao;
let adminB: Sessao;
let profA: string;
let tipoA: string;
let profB: string;
let tipoB: string;
const numeroA = `8${String(Date.now()).slice(-10)}1`;
const numeroB = `8${String(Date.now()).slice(-10)}2`;
let seq = 0;

const idDe = (r: { body: unknown }) => (r.body as { id: string }).id;

const telefonesUsados: string[] = [];
function telefoneNovo(): string {
  seq++;
  const t = `11${String(9e8 + ((Date.now() + seq * 7919) % 1e8)).slice(0, 9)}`;
  telefonesUsados.push(t);
  return t;
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

async function paciente(s: Sessao, telefone: string, nascimento?: string): Promise<string> {
  const r = await api
    .http()
    .post('/pacientes')
    .set(cab(s))
    .send({ nome: `Paciente Ficticio WA ${seq}`, telefone, ...(nascimento ? { nascimento } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return idDe(r);
}

/** Consulta (encaixe) daqui a `horas` horas, no fuso da clínica. */
async function consulta(s: Sessao, pacienteId: string, horas: number, prof = profA, tipo = tipoA): Promise<{ id: string; inicio: Date }> {
  const alvo = new Date(Math.ceil((Date.now() + horas * 3_600_000) / 300_000) * 300_000);
  const { data, hora } = noFusoDaClinica(alvo);
  const r = await api.http().post('/agendamentos').set(cab(s)).send({ pacienteId, profissionalId: prof, tipoId: tipo, data, hora, encaixe: true });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { id: idDe(r), inicio: new Date((r.body as { inicio: string }).inicio) };
}

async function optIn(s: Sessao, pacienteId: string, corpo: Record<string, unknown> = { destinatario: 'paciente', meio: 'verbal_na_recepcao' }) {
  const r = await api.http().post(`/pacientes/${pacienteId}/whatsapp/opt-in`).set(cab(s)).send(corpo);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string };
}

function corpoDeResposta(numero: string, de: string, texto: string, emRespostaA?: string, idMsg = `wamid.IN${randomUUID().replace(/-/g, '')}`): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: numero },
              messages: [{ id: idMsg, from: de, type: 'text', text: { body: texto }, timestamp: String(Math.floor(Date.now() / 1000)), ...(emRespostaA ? { context: { id: emRespostaA } } : {}) }],
            },
          },
        ],
      },
    ],
  });
}

function corpoDeStatus(numero: string, idProvedor: string, status: string): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: numero }, statuses: [{ id: idProvedor, status, timestamp: '1900000000' }] } }] }],
  });
}

function webhook(corpo: string, assinatura: string | null = assinarCorpo(SEGREDO, corpo)) {
  const req = api.http().post('/whatsapp/webhook').set('Content-Type', 'application/json');
  return (assinatura ? req.set('X-Hub-Signature-256', assinatura) : req).send(corpo);
}

const enviadasPara = (telefone: string) => falso.enviadas.filter((e) => e.mensagem.para === `55${telefone}`);

async function envioDoAgendamento(tenant: TenantId, agendamentoId: string) {
  return withTenant(api.db.db, tenant, async (tx) => (await tx.select().from(whatsappOutbox).where(eq(whatsappOutbox.appointmentId, agendamentoId)))[0]);
}

async function statusDoAgendamento(tenant: TenantId, id: string) {
  return withTenant(api.db.db, tenant, async (tx) => (await tx.select({ s: appointments.status }).from(appointments).where(eq(appointments.id, id)))[0]?.s);
}

beforeAll(async () => {
  api = await subirApi({ mensageiro: falso, responsaveis });
  svc = api.app.get(WhatsappService);
  clinicaA = await api.novaClinica();
  clinicaB = await api.novaClinica();
  adminA = api.sessao(clinicaA, 'admin');
  recepA = api.sessao(clinicaA, 'recepcao');
  finA = api.sessao(clinicaA, 'financeiro');
  adminB = api.sessao(clinicaB, 'admin');
  profA = idDe(await api.http().post('/profissionais').set(cab(adminA)).send({ nome: NOME_PROFISSIONAL, especialidade: ESPECIALIDADE }));
  tipoA = idDe(await api.http().post('/tipos-atendimento').set(cab(adminA)).send({ nome: TIPO_SENSIVEL, minutos: 30 }));
  profB = idDe(await api.http().post('/profissionais').set(cab(adminB)).send({ nome: 'Prof B Ficticio', especialidade: 'Fisio' }));
  tipoB = idDe(await api.http().post('/tipos-atendimento').set(cab(adminB)).send({ nome: 'Sessao', minutos: 30 }));
  for (const [s, numero] of [
    [adminA, numeroA],
    [adminB, numeroB],
  ] as const) {
    const r = await api
      .http()
      .put('/whatsapp/configuracao')
      .set(cab(s))
      .send({ ativo: true, nomeRemetente: 'Agendamentos', numeroDeNegocio: numero, enviarDe: 0, enviarAte: 24, horasAntes: 24 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
});

afterAll(async () => {
  await api?.fechar();
});

describe('opt-in: sem ele, nada sai', () => {
  it('consulta D-1 sem opt-in: não envia (nem entra na fila)', async () => {
    const tel = telefoneNovo();
    const p = await paciente(adminA, tel);
    const c = await consulta(adminA, p, 20);
    const r = await svc.executarLembretesComoSistema(clinicaA);
    expect(r.motivo).toBe('ok');
    expect(r.semOptIn).toBeGreaterThanOrEqual(1);
    expect(enviadasPara(tel)).toHaveLength(0);
    expect(await envioDoAgendamento(clinicaA, c.id)).toBeUndefined();
  });

  it('com opt-in registrado pela recepção (com prova), envia uma vez só (idempotente)', async () => {
    const tel = telefoneNovo();
    const p = await paciente(adminA, tel);
    const c = await consulta(adminA, p, 20);
    await optIn(recepA, p, { destinatario: 'paciente', meio: 'formulario_assinado', comprovante: 'Termo ficticio QZX-77' });
    await svc.executarLembretesComoSistema(clinicaA);
    await svc.executarLembretesComoSistema(clinicaA);
    expect(enviadasPara(tel)).toHaveLength(1);
    const e = await envioDoAgendamento(clinicaA, c.id);
    expect(e).toMatchObject({ status: 'enviado', attempts: 1, recipientKind: 'paciente' });
    expect(e?.bodyEnc).toMatch(/^v1:/);
    expect(e?.recipientPhoneEnc).toMatch(/^v1:/);
    const ver = await api.http().get(`/pacientes/${p}/whatsapp/opt-in`).set(cab(recepA));
    expect(ver.status).toBe(200);
    expect(ver.body).toMatchObject({ vigente: { meio: 'formulario_assinado', temComprovante: true, registradoPor: recepA.userId } });
    expect(JSON.stringify(ver.body)).not.toContain('QZX-77');
  });

  it('financeiro não registra opt-in (403); o banco recusa opt-in sem usuário (sistema)', async () => {
    const p = await paciente(adminA, telefoneNovo());
    const r = await api.http().post(`/pacientes/${p}/whatsapp/opt-in`).set(cab(finA)).send({ destinatario: 'paciente', meio: 'verbal_na_recepcao' });
    expect(r.status).toBe(403);
    expect(
      await sqlstate(
        withTenant(api.db.db, clinicaA, (tx) =>
          tx.insert(whatsappOptIns).values({ tenantId: clinicaA, patientId: p, recipientKind: 'paciente', method: 'verbal_na_recepcao', grantedBy: randomUUID() }),
        ),
      ),
    ).toContain('42501');
  });

  it('o banco recusa envio sem opt-in vigente (INSERT direto) e não deixa apagar', async () => {
    const p = await paciente(adminA, telefoneNovo());
    const c = await consulta(adminA, p, 20);
    const o = await optIn(adminA, p);
    await api.http().post(`/pacientes/${p}/whatsapp/opt-in/revogar`).set(cab(adminA)).send({ meio: 'pedido_na_recepcao' }).expect(200);
    expect(
      await sqlstate(
        withTenant(
          api.db.db,
          clinicaA,
          (tx) =>
            tx.insert(whatsappOutbox).values({ tenantId: clinicaA, appointmentId: c.id, appointmentStartsAt: c.inicio, patientId: p, optInId: o.id, recipientKind: 'paciente', createdBy: adminA.userId }),
          adminA.userId,
        ),
      ),
    ).toContain('42501');
    expect(await sqlstate(withTenant(api.db.db, clinicaA, (tx) => tx.delete(whatsappOptIns).where(eq(whatsappOptIns.id, o.id)), adminA.userId))).toContain('42501');
    // Revogado não "desrevoga".
    expect(
      await sqlstate(
        withTenant(api.db.db, clinicaA, (tx) => tx.update(whatsappOptIns).set({ revokedAt: null, revokedBy: null, revokeMethod: null }).where(eq(whatsappOptIns.id, o.id)), adminA.userId),
      ),
    ).toContain('42501');
  });
});

describe('texto neutro (falha se houver termo de especialidade sensível)', () => {
  it('a mensagem enviada leva só nome neutro, data e hora: sem profissional, especialidade nem tipo', async () => {
    const tel = telefoneNovo();
    const p = await paciente(adminA, tel);
    const c = await consulta(adminA, p, 21);
    await optIn(adminA, p);
    await svc.executarLembretesComoSistema(clinicaA);
    const [m] = enviadasPara(tel);
    expect(m).toBeDefined();
    const texto = m?.mensagem.texto ?? '';
    const { data, hora } = noFusoDaClinica(c.inicio);
    expect(texto).toBe(`Você tem um compromisso em Agendamentos dia ${data.slice(8, 10)}/${data.slice(5, 7)} às ${hora}. Responda 1 para confirmar ou 2 para cancelar.`);
    expect(textoEhNeutro(texto)).toBe(true);
    for (const proibido of [NOME_PROFISSIONAL, 'QZX', ESPECIALIDADE, 'psiq', 'oncol', TIPO_SENSIVEL]) {
      expect(texto.toLowerCase()).not.toContain(proibido.toLowerCase());
    }
    for (const termo of AMOSTRAS_DE_TERMOS_SENSIVEIS) expect(texto.toLowerCase()).not.toContain(termo.toLowerCase());
    expect(m?.mensagem.modelo).toEqual({ nomeNoProvedor: MODELO_PADRAO.nomeNoProvedor, idioma: 'pt_BR', parametros: ['Agendamentos', `${data.slice(8, 10)}/${data.slice(5, 7)}`, hora] });
  });

  it('cada termo sensível é recusado no modelo (400), no nome do remetente (400), na regra e no BANCO', async () => {
    const termos = [...AMOSTRAS_DE_TERMOS_SENSIVEIS, ESPECIALIDADE];
    for (const termo of termos) {
      expect(textoEhNeutro(`Clinica ${termo}`), termo).toBe(false);
      const m = await api
        .http()
        .post('/whatsapp/modelos')
        .set(cab(adminA))
        .send({ texto: `Seu horario de ${termo} em {clinica} dia {data} as {hora}. Responda 1 ou 2.`, nomeNoProvedor: 'lembrete_x' });
      expect(m.status, termo).toBe(400);
      expect(JSON.stringify(m.body)).not.toContain(termo);
      const n = await api.http().put('/whatsapp/configuracao').set(cab(adminA)).send({ nomeRemetente: `Clinica ${termo}`.slice(0, 40) });
      expect(n.status, termo).toBe(400);
      const [r] = await api.db.db.execute<{ ok: boolean }>(sql`select app_whatsapp_text_is_neutral(${`Clinica ${termo}`}) as ok`);
      expect(r?.ok, `banco aceitou: ${termo}`).toBe(false);
    }
    // Placeholder de profissional/especialidade não existe.
    const ph = await api.http().post('/whatsapp/modelos').set(cab(adminA)).send({ texto: 'Compromisso com {profissional} em {clinica} dia {data} as {hora}.', nomeNoProvedor: 'lembrete_x' });
    expect(ph.status).toBe(400);
    // E o banco recusa o modelo mesmo vindo direto.
    expect(
      await sqlstate(
        withTenant(
          api.db.db,
          clinicaA,
          (tx) =>
            tx.insert(whatsappTemplates).values({ tenantId: clinicaA, body: 'Sua consulta de psiquiatria em {clinica} dia {data} as {hora}.', providerTemplateName: 'x', createdBy: adminA.userId }),
          adminA.userId,
        ),
      ),
    ).toContain('23514');
    // O modelo padrão e um modelo neutro passam.
    expect(textoEhNeutro(MODELO_PADRAO.corpo)).toBe(true);
    const ok = await api.http().post('/whatsapp/modelos').set(cab(adminA)).send({ texto: MODELO_PADRAO.corpo, nomeNoProvedor: 'lembrete_neutro_v1' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });
});

describe('resposta 1/2: só a consulta daquele envio, pelas regras da agenda, dentro da janela', () => {
  it('"1" citando o envio A confirma A e não toca B (mesmo paciente, mesmo número)', async () => {
    const tel = telefoneNovo();
    const p = await paciente(adminA, tel);
    const a = await consulta(adminA, p, 19);
    const b = await consulta(adminA, p, 22);
    await optIn(adminA, p);
    await svc.executarLembretesComoSistema(clinicaA);
    const ea = await envioDoAgendamento(clinicaA, a.id);
    expect(ea?.providerMessageId).toBeTruthy();
    const r = await webhook(corpoDeResposta(numeroA, `55${tel}`, '1', ea?.providerMessageId ?? ''));
    expect(r.status).toBe(200);
    expect(await statusDoAgendamento(clinicaA, a.id)).toBe('confirmed');
    expect(await statusDoAgendamento(clinicaA, b.id)).toBe('scheduled');
    // "2" sem citar com DOIS lembretes em aberto para o número: ambíguo, nenhuma consulta muda.
    await webhook(corpoDeResposta(numeroA, `55${tel}`, '2')).expect(200);
    expect(await statusDoAgendamento(clinicaA, b.id)).toBe('scheduled');
    expect(await statusDoAgendamento(clinicaA, a.id)).toBe('confirmed');
    // Citando B, cancela B (e só B).
    const eb = await envioDoAgendamento(clinicaA, b.id);
    await webhook(corpoDeResposta(numeroA, `55${tel}`, '2', eb?.providerMessageId ?? '')).expect(200);
    expect(await statusDoAgendamento(clinicaA, b.id)).toBe('cancelled');
    expect(await statusDoAgendamento(clinicaA, a.id)).toBe('confirmed');
    // A trilha da agenda marca a origem.
    const trilha = await withTenant(api.db.db, clinicaA, (tx) =>
      tx.select().from(auditLog).where(and(eq(auditLog.scope, 'appointments'), sql`${auditLog.metadata}->>'appointment_id' = ${a.id}`, sql`${auditLog.metadata}->>'via' = 'whatsapp'`)),
    );
    expect(trilha).toHaveLength(1);
    expect(trilha[0]?.actorKind).toBe('sistema');
  });

  it('outro número citando o envio de A não muda nada (e nada é guardado)', async () => {
    const tel = telefoneNovo();
    const p = await paciente(adminA, tel);
    const a = await consulta(adminA, p, 19);
    await optIn(adminA, p);
    await svc.executarLembretesComoSistema(clinicaA);
    const ea = await envioDoAgendamento(clinicaA, a.id);
    const r = await webhook(corpoDeResposta(numeroA, '5511988887777', '2', ea?.providerMessageId ?? ''));
    expect(r.body).toEqual({ processados: 0, ignorados: 1 });
    expect(await statusDoAgendamento(clinicaA, a.id)).toBe('scheduled');
  });

  it('fora da janela de resposta: registra e não muda a consulta', async () => {
    const tel = telefoneNovo();
    const p = await paciente(adminA, tel);
    await api.http().put('/whatsapp/configuracao').set(cab(adminA)).send({ horasAntes: 72 }).expect(200);
    const a = await consulta(adminA, p, 60);
    await optIn(adminA, p);
    await svc.executarLembretesComoSistema(clinicaA);
    await api.http().put('/whatsapp/configuracao').set(cab(adminA)).send({ horasAntes: 24 }).expect(200);
    const ea = await envioDoAgendamento(clinicaA, a.id);
    expect(ea?.status).toBe('enviado');
    // 49 h depois do envio (janela padrão: 48 h), ainda antes da consulta.
    const ev = {
      tipo: 'resposta' as const,
      numeroDaClinica: numeroA,
      idProvedor: `wamid.LATE${randomUUID().replace(/-/g, '')}`,
      de: `55${tel}`,
      emRespostaA: ea?.providerMessageId ?? null,
      texto: '1',
      instante: new Date(),
    };
    await svc.processarEventos([ev], new Date(Date.now() + 49 * 3_600_000));
    expect(await statusDoAgendamento(clinicaA, a.id)).toBe('scheduled');
    const [resp] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(whatsappInbound).where(eq(whatsappInbound.providerMessageId, ev.idProvedor)));
    expect(resp).toMatchObject({ interpretation: 'confirmar', outcome: 'fora_da_janela', outboxId: ea?.id });
  });

  it('SAIR revoga o opt-in (pelo sistema) e o próximo lembrete não sai', async () => {
    const tel = telefoneNovo();
    const p = await paciente(adminA, tel);
    await consulta(adminA, p, 19);
    await optIn(adminA, p);
    await svc.executarLembretesComoSistema(clinicaA);
    await webhook(corpoDeResposta(numeroA, `55${tel}`, 'SAIR')).expect(200);
    const [o] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(whatsappOptIns).where(eq(whatsappOptIns.patientId, p)));
    expect(o).toMatchObject({ revokeMethod: 'resposta_sair', revokedBy: null });
    expect(o?.revokedAt).not.toBeNull();
    await consulta(adminA, p, 23);
    await svc.executarLembretesComoSistema(clinicaA);
    expect(enviadasPara(tel)).toHaveLength(1);
  });
});

describe('webhook: assinatura, idempotência e limite', () => {
  it('assinatura inválida, ausente ou de outro segredo: 401 e nada muda', async () => {
    const tel = telefoneNovo();
    const p = await paciente(adminA, tel);
    const a = await consulta(adminA, p, 19);
    await optIn(adminA, p);
    await svc.executarLembretesComoSistema(clinicaA);
    const ea = await envioDoAgendamento(clinicaA, a.id);
    const corpo = corpoDeResposta(numeroA, `55${tel}`, '2', ea?.providerMessageId ?? '');
    expect((await webhook(corpo, null)).status).toBe(401);
    expect((await webhook(corpo, 'sha256=' + '0'.repeat(64))).status).toBe(401);
    expect((await webhook(corpo, assinarCorpo(randomBytes(32), corpo))).status).toBe(401);
    // Assinatura de outro corpo (adulteração depois de assinado).
    expect((await webhook(corpo, assinarCorpo(SEGREDO, corpo.replace('"2"', '"1"')))).status).toBe(401);
    expect(await statusDoAgendamento(clinicaA, a.id)).toBe('scheduled');
    const n = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(whatsappInbound).where(eq(whatsappInbound.outboxId, ea?.id ?? '')));
    expect(n).toHaveLength(0);
  });

  it('inscrição do webhook só com o token certo', async () => {
    const ok = await api.http().get('/whatsapp/webhook').query({ 'hub.mode': 'subscribe', 'hub.verify_token': TOKEN_INSCRICAO, 'hub.challenge': 'desafio123' });
    expect(ok.status).toBe(200);
    expect(ok.text).toBe('desafio123');
    const nao = await api.http().get('/whatsapp/webhook').query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'errado', 'hub.challenge': 'x' });
    expect(nao.status).toBe(403);
  });

  it('a mesma resposta reentregue é processada uma vez; status só anda para a frente', async () => {
    const tel = telefoneNovo();
    const p = await paciente(adminA, tel);
    const a = await consulta(adminA, p, 19);
    await optIn(adminA, p);
    await svc.executarLembretesComoSistema(clinicaA);
    const ea = await envioDoAgendamento(clinicaA, a.id);
    const corpo = corpoDeResposta(numeroA, `55${tel}`, '1', ea?.providerMessageId ?? '', `wamid.DUP${randomUUID().replace(/-/g, '')}`);
    expect((await webhook(corpo)).body).toEqual({ processados: 1, ignorados: 0 });
    expect((await webhook(corpo)).body).toEqual({ processados: 0, ignorados: 1 });
    const linhas = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(whatsappInbound).where(eq(whatsappInbound.outboxId, ea?.id ?? '')));
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.outcome).toBe('confirmado');
    // Status: lido, depois "entregue" atrasado (ignorado), lido de novo (ignorado).
    const id = ea?.providerMessageId ?? '';
    expect((await webhook(corpoDeStatus(numeroA, id, 'read'))).body).toEqual({ processados: 1, ignorados: 0 });
    expect((await webhook(corpoDeStatus(numeroA, id, 'delivered'))).body).toEqual({ processados: 0, ignorados: 1 });
    expect((await webhook(corpoDeStatus(numeroA, id, 'read'))).body).toEqual({ processados: 0, ignorados: 1 });
    expect((await envioDoAgendamento(clinicaA, a.id))?.status).toBe('lido');
  });

  it('limite: corpo com eventos demais é recusado (400); no máximo 5 respostas por envio', async () => {
    const muitos = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: numeroA }, statuses: Array.from({ length: 101 }, (_, i) => ({ id: `wamid.X${i}`, status: 'read' })) } }] }],
    });
    expect((await webhook(muitos)).status).toBe(400);
    const tel = telefoneNovo();
    const p = await paciente(adminA, tel);
    const a = await consulta(adminA, p, 19);
    await optIn(adminA, p);
    await svc.executarLembretesComoSistema(clinicaA);
    const ea = await envioDoAgendamento(clinicaA, a.id);
    for (let i = 0; i < 7; i++) await webhook(corpoDeResposta(numeroA, `55${tel}`, `oi ${i}`, ea?.providerMessageId ?? '')).expect(200);
    const linhas = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(whatsappInbound).where(eq(whatsappInbound.outboxId, ea?.id ?? '')));
    expect(linhas).toHaveLength(5);
    expect(linhas.every((l) => l.outcome === 'sem_acao')).toBe(true);
  });

  it('o banco só aceita resposta gravada pelo sistema (usuário não fabrica "o paciente disse 1")', async () => {
    expect(
      await sqlstate(
        withTenant(
          api.db.db,
          clinicaA,
          (tx) => tx.insert(whatsappInbound).values({ tenantId: clinicaA, providerMessageId: 'wamid.FORJADO', interpretation: 'confirmar', outcome: 'confirmado' }),
          adminA.userId,
        ),
      ),
    ).toContain('42501');
  });
});

describe('horário, menor de idade e falha', () => {
  it('fora do horário configurado: não envia nem programa', async () => {
    const tel = telefoneNovo();
    const p = await paciente(adminA, tel);
    await consulta(adminA, p, 20);
    await optIn(adminA, p);
    const h = Number(noFusoDaClinica(new Date()).hora.slice(0, 2));
    const janela = h <= 21 ? { enviarDe: h + 1, enviarAte: h + 2 } : { enviarDe: 0, enviarAte: 1 };
    await api.http().put('/whatsapp/configuracao').set(cab(adminA)).send(janela).expect(200);
    try {
      const r = await svc.executarLembretesComoSistema(clinicaA);
      expect(r.motivo).toBe('fora_do_horario');
      expect(enviadasPara(tel)).toHaveLength(0);
    } finally {
      await api.http().put('/whatsapp/configuracao').set(cab(adminA)).send({ enviarDe: 0, enviarAte: 24 }).expect(200);
    }
  });

  it('menor com opt-in em nome próprio não recebe; com o responsável, vai para o telefone dele', async () => {
    const tel = telefoneNovo();
    const nascimento = `${new Date().getUTCFullYear() - 10}-01-01`;
    const p = await paciente(adminA, tel, nascimento);
    const a = await consulta(adminA, p, 20);
    await optIn(adminA, p);
    const r = await svc.executarLembretesComoSistema(clinicaA);
    expect(r.semDestinatario).toBeGreaterThanOrEqual(1);
    expect(enviadasPara(tel)).toHaveLength(0);
    // Responsável desconhecido: 409 (a tabela de responsáveis é de outra branch; aqui, a porta).
    const sem = await api.http().post(`/pacientes/${p}/whatsapp/opt-in`).set(cab(adminA)).send({ destinatario: 'responsavel', responsavelId: randomUUID(), meio: 'verbal_na_recepcao' });
    expect(sem.status).toBe(409);
    await optIn(adminA, p, { destinatario: 'responsavel', responsavelId: RESPONSAVEL_ID, meio: 'verbal_na_recepcao' });
    expect((await svc.executarLembretesComoSistema(clinicaA)).programados).toBeGreaterThanOrEqual(1);
    expect(enviadasPara(TELEFONE_RESPONSAVEL).length).toBeGreaterThanOrEqual(1);
    expect(enviadasPara(tel)).toHaveLength(0);
    expect(await envioDoAgendamento(clinicaA, a.id)).toMatchObject({ recipientKind: 'responsavel', guardianId: RESPONSAVEL_ID });
  });

  it('falha definitiva do provedor: "falhou" com fallback para a fila da recepção', async () => {
    const tel = telefoneNovo();
    const p = await paciente(adminA, tel);
    const a = await consulta(adminA, p, 20);
    await optIn(adminA, p);
    falso.numerosRecusados.add(`55${tel}`);
    await svc.executarLembretesComoSistema(clinicaA);
    expect(await envioDoAgendamento(clinicaA, a.id)).toMatchObject({ status: 'falhou', needsFallback: true, failureCode: '131026' });
    const hoje = noFusoDaClinica(new Date()).data;
    const lista = await api.http().get('/whatsapp/envios').query({ de: hoje, ate: hoje, situacao: 'falhou' }).set(cab(recepA));
    expect(lista.status).toBe(200);
    const itens = (lista.body as { itens: { agendamentoId: string; precisaFallback: boolean }[] }).itens;
    expect(itens.find((i) => i.agendamentoId === a.id)).toMatchObject({ precisaFallback: true });
    expect(JSON.stringify(lista.body)).not.toContain(tel);
  });
});

describe('isolamento entre clínicas', () => {
  it('B não vê fila, opt-ins, modelos, respostas nem configuração de A (RLS e API)', async () => {
    const tel = telefoneNovo();
    const p = await paciente(adminA, tel);
    const a = await consulta(adminA, p, 20);
    await optIn(adminA, p);
    await svc.executarLembretesComoSistema(clinicaA);
    const ea = await envioDoAgendamento(clinicaA, a.id);
    await webhook(corpoDeResposta(numeroA, `55${tel}`, 'ok', ea?.providerMessageId ?? '')).expect(200);
    const contagens = await withTenant(api.db.db, clinicaB, async (tx: TenantTx) => {
      const n = async (t: typeof whatsappOutbox | typeof whatsappOptIns | typeof whatsappTemplates | typeof whatsappInbound | typeof whatsappSettings) =>
        (await tx.select({ n: sql<number>`count(*)::int` }).from(t).where(eq(t.tenantId, clinicaA)))[0]?.n;
      return {
        outbox: await n(whatsappOutbox),
        optIns: await n(whatsappOptIns),
        templates: await n(whatsappTemplates),
        inbound: await n(whatsappInbound),
        settings: await n(whatsappSettings),
      };
    });
    expect(contagens).toEqual({ outbox: 0, optIns: 0, templates: 0, inbound: 0, settings: 0 });
    // Gravar com o tenant de A no contexto de B: o WITH CHECK recusa.
    expect(
      await sqlstate(
        withTenant(
          api.db.db,
          clinicaB,
          (tx) => tx.insert(whatsappOptIns).values({ tenantId: clinicaA, patientId: p, recipientKind: 'paciente', method: 'verbal_na_recepcao', grantedBy: adminB.userId }),
          adminB.userId,
        ),
      ),
    ).toContain('42501');
    // Pela API: opt-in de paciente de A pela sessão de B = 404; a fila de B não traz A.
    expect((await api.http().get(`/pacientes/${p}/whatsapp/opt-in`).set(cab(adminB))).status).toBe(404);
    const hoje = noFusoDaClinica(new Date()).data;
    const lista = await api.http().get('/whatsapp/envios').query({ de: hoje, ate: hoje }).set(cab(adminB));
    expect((lista.body as { itens: { agendamentoId: string }[] }).itens.some((i) => i.agendamentoId === a.id)).toBe(false);
    // B não toma o número de A.
    const tomar = await api.http().put('/whatsapp/configuracao').set(cab(adminB)).send({ numeroDeNegocio: numeroA });
    expect(tomar.status).toBe(409);
  });

  it('resposta chegando pelo número de B não acha o envio de A (mesmo telefone do paciente)', async () => {
    const tel = telefoneNovo();
    const pA = await paciente(adminA, tel);
    const a = await consulta(adminA, pA, 20);
    await optIn(adminA, pA);
    const pB = await paciente(adminB, tel);
    const b = await consulta(adminB, pB, 21, profB, tipoB);
    await optIn(adminB, pB);
    await svc.executarLembretesComoSistema(clinicaA);
    await svc.executarLembretesComoSistema(clinicaB);
    const ea = await envioDoAgendamento(clinicaA, a.id);
    // Cita o envio de A, mas chega pelo número de B: em B esse id não existe.
    const r = await webhook(corpoDeResposta(numeroB, `55${tel}`, '2', ea?.providerMessageId ?? ''));
    expect(r.body).toEqual({ processados: 0, ignorados: 1 });
    expect(await statusDoAgendamento(clinicaA, a.id)).toBe('scheduled');
    expect(await statusDoAgendamento(clinicaB, b.id)).toBe('scheduled');
    // Sem citar: vale o envio de B (o da clínica dona do número).
    await webhook(corpoDeResposta(numeroB, `55${tel}`, '2')).expect(200);
    expect(await statusDoAgendamento(clinicaB, b.id)).toBe('cancelled');
    expect(await statusDoAgendamento(clinicaA, a.id)).toBe('scheduled');
  });
});

describe('auditoria e retenção', () => {
  it('trilha do WhatsApp sem número de telefone, texto da mensagem ou do comprovante', async () => {
    const linhas = await withTenant(api.db.db, clinicaA, (tx) => tx.select({ m: auditLog.metadata, s: auditLog.scope }).from(auditLog).where(sql`${auditLog.scope} like 'whatsapp%'`));
    expect(linhas.length).toBeGreaterThan(5);
    const texto = JSON.stringify(linhas);
    for (const t of [...telefonesUsados, TELEFONE_RESPONSAVEL]) expect(texto).not.toContain(t);
    for (const proibido of ['Agendamentos', 'compromisso', 'QZX', 'Termo ficticio', 'SAIR', 'oi 1']) expect(texto).not.toContain(proibido);
  });

  it('retenção: conteúdo com menos de 30 dias fica; a regra do banco recusa limpar antes', async () => {
    const r = await api.http().post('/whatsapp/retencao/execucao').set(cab(adminA)).send({});
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ enviosLimpos: 0, respostasLimpas: 0 });
    const [e] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(whatsappOutbox).limit(1));
    expect(
      await sqlstate(
        withTenant(api.db.db, clinicaA, (tx) => tx.update(whatsappOutbox).set({ bodyEnc: null, recipientPhoneEnc: null, contentPurgedAt: new Date() }).where(eq(whatsappOutbox.id, e?.id ?? '')), adminA.userId),
      ),
    ).toContain('42501');
  });
});
