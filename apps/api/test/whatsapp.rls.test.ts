/**
 * Lembretes e confirmação por WhatsApp (migração 0032) contra Postgres REAL, com o adaptador FALSO
 * (nenhuma rede): sem opt-in não envia; texto neutro (falha se aparecer termo de especialidade, nome do
 * profissional ou tipo de atendimento); "1"/"2" mudam só a consulta daquele envio, dentro da janela e
 * pelas regras da agenda; webhook com assinatura inválida recusado; idempotência; fora do horário não
 * envia; menor recebe pelo responsável (porta); SAIR revoga; barreiras do banco; isolamento entre
 * clínicas em whatsapp_settings, whatsapp_opt_ins, whatsapp_outbox e
 * whatsapp_inbound; trilha sem número nem texto.
 * Pré-requisitos: migrações aplicadas, DATABASE_URL = papel app_user e DATABASE_MIGRATOR_URL (só para
 * "envelhecer" linhas no teste da limpeza de 30 dias, como dono da tabela). Dados 100% fictícios.
 */
import type { TenantId } from '@plataforma/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appointments, auditLog, patients, whatsappInbound, whatsappOptIns, whatsappOutbox, whatsappPhoneKeys, whatsappSettings } from '../src/db/schema';
import { withTenant, type TenantTx } from '../src/db/tenant-transaction';
import { AMOSTRAS_DE_TERMOS_SENSIVEIS, MODELO_PADRAO, MODELOS_DA_PLATAFORMA, RESPOSTA_FIXA_OUTRO, textoEhNeutro } from '../src/modules/messaging/lembretes-regras';
import { MensageiroFalso } from '../src/modules/messaging/mensageiro-falso';
import { assinarCorpo } from '../src/modules/messaging/mensageiro-whatsapp';
import { MessagingModule } from '../src/modules/messaging/messaging.module';
import { WhatsappService } from '../src/modules/messaging/whatsapp.service';
import { DATABASE_HANDLE, RotaDoWhatsapp } from '../src/modules/tenancy/tenancy.module';
import { noFusoDaClinica } from '../src/modules/scheduling/agenda-regras';
import { cab, subirApi, type ApiDeTeste } from './apoio-api';

type Sessao = { Authorization: string; userId: string };

/** Segredo do webhook e token de inscrição: gerados a cada execução, nunca fixos no código. */
const SEGREDO = randomBytes(32);
const TOKEN_INSCRICAO = randomBytes(24).toString('base64url');
const falso = new MensageiroFalso({ segredoWebhook: SEGREDO, tokenInscricao: TOKEN_INSCRICAO, nodeEnv: 'test' });

/** Telefones de responsáveis fictícios (os responsáveis são os da 0028, criados pela API): nunca na trilha. */
const telefonesDeResponsaveis: string[] = [];

/** Termos SENSÍVEIS do cadastro: nunca podem aparecer na mensagem. */
const NOME_PROFISSIONAL = 'Dra QZX Ficticia';
const ESPECIALIDADE = 'Psiquiatria';
const TIPO_SENSIVEL = 'Consulta oncologica QZX';

const migratorUrl = process.env.DATABASE_MIGRATOR_URL;
if (!migratorUrl) throw new Error('DATABASE_MIGRATOR_URL é obrigatória para este teste (envelhecer linhas na limpeza)');
let owner: postgres.Sql;

/**
 * "Envelhece" uma linha da fila como DONO da tabela (o runtime não consegue: o trigger carimba com o
 * relógio do banco). Sem RLS forçado e sem o trigger só dentro desta transação.
 */
async function envelhecer(id: string, campos: { criadoHaDias?: number; consultaHaHoras?: number; enviandoHaHoras?: number }): Promise<void> {
  await owner.begin(async (tx) => {
    await tx`alter table whatsapp_outbox no force row level security`;
    await tx`alter table whatsapp_outbox disable trigger whatsapp_outbox_guard`;
    if (campos.criadoHaDias !== undefined) await tx`update whatsapp_outbox set created_at = now() - make_interval(days => ${campos.criadoHaDias}) where id = ${id}`;
    if (campos.consultaHaHoras !== undefined)
      await tx`update whatsapp_outbox set appointment_starts_at = now() - make_interval(hours => ${campos.consultaHaHoras}) where id = ${id}`;
    if (campos.enviandoHaHoras !== undefined)
      await tx`update whatsapp_outbox set status = 'enviando', dispatch_started_at = now() - make_interval(hours => ${campos.enviandoHaHoras}) where id = ${id}`;
    await tx`alter table whatsapp_outbox enable trigger whatsapp_outbox_guard`;
    await tx`alter table whatsapp_outbox force row level security`;
  });
}

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

/** Colunas obrigatórias do opt-in em INSERT direto que o banco tem de recusar ANTES (trigger/RLS). */
const SELO_FALSO = { recipientPhoneEnc: 'x', recipientPhoneHash: '0'.repeat(64), evidenceEnc: 'x' };

async function optInDoBanco(tenant: TenantId, id: string) {
  return withTenant(api.db.db, tenant, async (tx) => (await tx.select().from(whatsappOptIns).where(eq(whatsappOptIns.id, id)))[0]);
}

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

/** Paciente fictício; por padrão ADULTO com data de nascimento (sem data, nada sai: V2). `null` = sem data. */
async function paciente(s: Sessao, telefone: string, nascimento: string | null = '1980-05-10'): Promise<string> {
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

async function optIn(s: Sessao, pacienteId: string, corpo: Record<string, unknown> = { destinatario: 'paciente', meio: 'verbal_na_recepcao', comprovante: 'Registro ficticio de recepcao' }) {
  const r = await api.http().post(`/pacientes/${pacienteId}/whatsapp/opt-in`).set(cab(s)).send(corpo);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string };
}

/** Responsável (0028) criado pela API: devolve o vínculo, a pessoa e o telefone (fictício). */
async function responsavel(
  s: Sessao,
  pacienteId: string,
  extra: Record<string, unknown> = { tipo: 'pai_mae' },
): Promise<{ vinculoId: string; pessoaId: string; telefone: string }> {
  const telefone = telefoneNovo();
  telefonesDeResponsaveis.push(telefone);
  const r = await api
    .http()
    .post(`/pacientes/${pacienteId}/responsaveis`)
    .set(cab(s))
    .send({ nome: `Responsavel Ficticio WA ${seq}`, telefone, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const b = r.body as { id: string; responsavelId: string };
  return { vinculoId: b.id, pessoaId: b.responsavelId, telefone };
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
  owner = postgres(migratorUrl, { max: 1, onnotice: () => undefined });
  api = await subirApi({ mensageiro: falso });
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
  await owner?.end();
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
          tx.insert(whatsappOptIns).values({ tenantId: clinicaA, patientId: p, recipientKind: 'paciente', method: 'verbal_na_recepcao', grantedBy: randomUUID(), ...SELO_FALSO }),
        ),
      ),
    ).toContain('42501');
  });

  it('o banco recusa envio sem opt-in vigente (INSERT direto) e não deixa apagar', async () => {
    const p = await paciente(adminA, telefoneNovo());
    const c = await consulta(adminA, p, 20);
    const o = await optIn(adminA, p);
    const hashDoOptIn = (await optInDoBanco(clinicaA, o.id))?.recipientPhoneHash ?? '';
    await api.http().post(`/pacientes/${p}/whatsapp/opt-in/revogar`).set(cab(adminA)).send({ meio: 'pedido_na_recepcao' }).expect(200);
    expect(
      await sqlstate(
        withTenant(
          api.db.db,
          clinicaA,
          (tx) =>
            tx.insert(whatsappOutbox).values({ tenantId: clinicaA, appointmentId: c.id, appointmentStartsAt: c.inicio, patientId: p, optInId: o.id, templateName: MODELO_PADRAO.nomeNoProvedor, recipientKind: 'paciente', recipientPhoneHash: hashDoOptIn, createdBy: adminA.userId }),
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

describe('V1: o opt-in vale só para o número que consentiu', () => {
  it('opt-in grava o número que consentiu, cifrado e com o HMAC', async () => {
    const tel = telefoneNovo();
    const p = await paciente(adminA, tel);
    const o = await optIn(recepA, p);
    const linha = await optInDoBanco(clinicaA, o.id);
    expect(linha?.recipientPhoneEnc).toMatch(/^v1:/);
    expect(linha?.recipientPhoneHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(linha)).not.toContain(tel);
  });

  it('telefone trocado no cadastro DEPOIS do opt-in: nada sai, o opt-in perde a validade e a recepção vê o motivo', async () => {
    const tel = telefoneNovo();
    const novo = telefoneNovo();
    const p = await paciente(adminA, tel);
    const c = await consulta(adminA, p, 20);
    const o = await optIn(adminA, p);
    await api.http().patch(`/pacientes/${p}`).set(cab(adminA)).send({ telefone: novo }).expect(200);
    const r = await svc.executarLembretesComoSistema(clinicaA);
    expect(r.numeroMudou).toBeGreaterThanOrEqual(1);
    expect(enviadasPara(tel)).toHaveLength(0);
    expect(enviadasPara(novo)).toHaveLength(0);
    expect(await envioDoAgendamento(clinicaA, c.id)).toBeUndefined();
    expect(await optInDoBanco(clinicaA, o.id)).toMatchObject({ revokeMethod: 'numero_mudou', revokedBy: null });
    const ver = await api.http().get(`/pacientes/${p}/whatsapp/opt-in`).set(cab(recepA));
    expect(ver.body).toMatchObject({ vigente: null, historico: [{ meioDaRevogacao: 'numero_mudou' }] });
    // Novo opt-in com o número novo: aí sai, para o número novo.
    await optIn(adminA, p);
    await svc.executarLembretesComoSistema(clinicaA);
    expect(enviadasPara(novo)).toHaveLength(1);
    expect(enviadasPara(tel)).toHaveLength(0);
  });

  it('telefone trocado entre a programação e o despacho: o envio agendado é cancelado (numero_mudou)', async () => {
    const tel = telefoneNovo();
    const novo = telefoneNovo();
    const p = await paciente(adminA, tel);
    const c = await consulta(adminA, p, 20);
    const o = await optIn(adminA, p);
    // 1ª passada: programa e o provedor falha TEMPORARIAMENTE; a linha volta para "agendado".
    falso.numerosIndisponiveis.add(`55${tel}`);
    await svc.executarLembretesComoSistema(clinicaA);
    falso.numerosIndisponiveis.delete(`55${tel}`);
    const linha = await envioDoAgendamento(clinicaA, c.id);
    expect(linha).toMatchObject({ status: 'agendado', attempts: 1 });
    const linhaId = linha?.id;
    // Troca o telefone e roda de novo: o despacho confere o número de agora e cancela.
    await api.http().patch(`/pacientes/${p}`).set(cab(adminA)).send({ telefone: novo }).expect(200);
    const r = await svc.executarLembretesComoSistema(clinicaA);
    expect(r.numeroMudou).toBeGreaterThanOrEqual(1);
    expect(enviadasPara(tel)).toHaveLength(0);
    expect(enviadasPara(novo)).toHaveLength(0);
    expect(await envioDoAgendamento(clinicaA, c.id)).toMatchObject({ id: linhaId, status: 'cancelado', failureCode: 'numero_mudou' });
    expect(await optInDoBanco(clinicaA, o.id)).toMatchObject({ revokeMethod: 'numero_mudou' });
  });

  it('o BANCO recusa envio com número diferente do consentido (INSERT e reserva para envio)', async () => {
    const p = await paciente(adminA, telefoneNovo());
    const c = await consulta(adminA, p, 20);
    const o = await optIn(adminA, p);
    const outro = 'f'.repeat(64);
    expect(
      await sqlstate(
        withTenant(
          api.db.db,
          clinicaA,
          (tx) =>
            tx.insert(whatsappOutbox).values({
              tenantId: clinicaA,
              appointmentId: c.id,
              appointmentStartsAt: c.inicio,
              patientId: p,
              optInId: o.id,
              templateName: MODELO_PADRAO.nomeNoProvedor,
              recipientKind: 'paciente',
              recipientPhoneHash: outro,
              createdBy: adminA.userId,
            }),
          adminA.userId,
        ),
      ),
    ).toContain('42501');
    // O HMAC e o número do opt-in não mudam (nem para "corrigir" o número).
    expect(
      await sqlstate(withTenant(api.db.db, clinicaA, (tx) => tx.update(whatsappOptIns).set({ recipientPhoneHash: outro }).where(eq(whatsappOptIns.id, o.id)), adminA.userId)),
    ).toContain('42501');
    // Usuário não revoga "como sistema" (numero_mudou sem autor).
    expect(
      await sqlstate(
        withTenant(api.db.db, clinicaA, (tx) => tx.update(whatsappOptIns).set({ revokedAt: new Date(), revokedBy: null, revokeMethod: 'numero_mudou' }).where(eq(whatsappOptIns.id, o.id)), adminA.userId),
      ),
    ).toContain('42501');
  });
});

describe('R6–R8: SAIR vale para o número, prova obrigatória, sem acesso cru ao banco', () => {
  it('R6: "SAIR" revoga TODOS os opt-ins vigentes do número (dois pacientes, mesmo telefone)', async () => {
    const tel = telefoneNovo();
    const p1 = await paciente(adminA, tel);
    const p2 = await paciente(adminA, tel);
    const outroTel = telefoneNovo();
    const p3 = await paciente(adminA, outroTel);
    await consulta(adminA, p1, 19);
    await optIn(adminA, p1);
    await optIn(adminA, p2);
    await optIn(adminA, p3);
    await svc.executarLembretesComoSistema(clinicaA);
    await webhook(corpoDeResposta(numeroA, `55${tel}`, 'SAIR')).expect(200);
    const opts = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(whatsappOptIns).where(inArray(whatsappOptIns.patientId, [p1, p2, p3])));
    expect(opts.find((o) => o.patientId === p1)).toMatchObject({ revokeMethod: 'resposta_sair' });
    expect(opts.find((o) => o.patientId === p2)).toMatchObject({ revokeMethod: 'resposta_sair' });
    // Outro número: intocado.
    expect(opts.find((o) => o.patientId === p3)?.revokedAt).toBeNull();
    // O lembrete do segundo paciente não sai mais.
    await consulta(adminA, p2, 21);
    await svc.executarLembretesComoSistema(clinicaA);
    expect(enviadasPara(tel)).toHaveLength(1);
  });

  it('R7: comprovante obrigatório (400) e "portal" não vem da recepção (400 na rota, 42501 no banco)', async () => {
    const p = await paciente(adminA, telefoneNovo());
    const semProva = await api.http().post(`/pacientes/${p}/whatsapp/opt-in`).set(cab(recepA)).send({ destinatario: 'paciente', meio: 'formulario_assinado' });
    expect(semProva.status).toBe(400);
    expect(semProva.body).toMatchObject({ campos: ['comprovante'] });
    const portal = await api.http().post(`/pacientes/${p}/whatsapp/opt-in`).set(cab(recepA)).send({ destinatario: 'paciente', meio: 'portal_do_paciente', comprovante: 'Sessao ficticia' });
    expect(portal.status).toBe(400);
    await optIn(recepA, p);
    const revPortal = await api.http().post(`/pacientes/${p}/whatsapp/opt-in/revogar`).set(cab(recepA)).send({ meio: 'portal_do_paciente' });
    expect(revPortal.status).toBe(400);
    // Direto no banco: portal recusado pelo trigger; sem comprovante, NOT NULL.
    expect(
      await sqlstate(
        withTenant(
          api.db.db,
          clinicaA,
          (tx) => tx.insert(whatsappOptIns).values({ tenantId: clinicaA, patientId: p, recipientKind: 'paciente', method: 'portal_do_paciente', grantedBy: recepA.userId, ...SELO_FALSO }),
          recepA.userId,
        ),
      ),
    ).toContain('42501');
    const [{ notnull } = { notnull: false }] = await api.db.db.execute<{ notnull: boolean }>(
      sql`select a.attnotnull as notnull from pg_attribute a join pg_class c on c.oid = a.attrelid where c.relname = 'whatsapp_opt_ins' and a.attname = 'evidence_enc'`,
    );
    expect(notnull).toBe(true);
  });

  it('R8: o handle cru do banco não é exportado; a rota do webhook é um provider estreito', async () => {
    expect(() => {
      api.app.select(MessagingModule).get<unknown>(DATABASE_HANDLE, { strict: true });
    }).toThrow();
    const rota = api.app.get(RotaDoWhatsapp);
    expect(await rota.clinicaDoNumero(numeroA)).toBe(clinicaA);
    expect(await rota.clinicaDoNumero('nao-numero')).toBeNull();
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
    expect(texto).toBe(MODELO_PADRAO.corpo.replace('{clinica}', 'Agendamentos').replace('{data}', `${data.slice(8, 10)}/${data.slice(5, 7)}`).replace('{hora}', hora));
    expect(texto).toContain('SAIR');
    expect(textoEhNeutro(texto)).toBe(true);
    for (const proibido of [NOME_PROFISSIONAL, 'QZX', ESPECIALIDADE, 'psiq', 'oncol', TIPO_SENSIVEL]) {
      expect(texto.toLowerCase()).not.toContain(proibido.toLowerCase());
    }
    for (const termo of AMOSTRAS_DE_TERMOS_SENSIVEIS) expect(texto.toLowerCase()).not.toContain(termo.toLowerCase());
    expect(m?.mensagem.modelo).toEqual({ nomeNoProvedor: MODELO_PADRAO.nomeNoProvedor, idioma: 'pt_BR', parametros: ['Agendamentos', `${data.slice(8, 10)}/${data.slice(5, 7)}`, hora] });
  });

  it('cada termo sensível é recusado no nome do remetente (400), na regra e no BANCO', async () => {
    const termos = [...AMOSTRAS_DE_TERMOS_SENSIVEIS, ESPECIALIDADE];
    for (const termo of termos) {
      expect(textoEhNeutro(`Clinica ${termo}`), termo).toBe(false);
      const n = await api.http().put('/whatsapp/configuracao').set(cab(adminA)).send({ nomeRemetente: `Clinica ${termo}`.slice(0, 40) });
      expect(n.status, termo).toBe(400);
      const [r] = await api.db.db.execute<{ ok: boolean }>(sql`select app_whatsapp_text_is_neutral(${`Clinica ${termo}`}) as ok`);
      expect(r?.ok, `banco aceitou: ${termo}`).toBe(false);
    }
  });
});

describe('modelos: só os da plataforma (V3 do parecer #69)', () => {
  it('a clínica não cria modelo (409, sem ler o corpo); a lista mostra só os da plataforma', async () => {
    const m = await api.http().post('/whatsapp/modelos').set(cab(adminA)).send({ texto: MODELO_PADRAO.corpo, nomeNoProvedor: 'lembrete_da_clinica' });
    expect(m.status).toBe(409);
    expect(m.body).toMatchObject({ codigo: 'modelo_da_clinica_desligado' });
    expect((await api.http().post('/whatsapp/modelos').set(cab(recepA)).send({})).status).toBe(403);
    const l = await api.http().get('/whatsapp/modelos').set(cab(recepA));
    expect(l.status).toBe(200);
    expect(l.body).toEqual({
      vigente: { nomeNoProvedor: MODELO_PADRAO.nomeNoProvedor, texto: MODELO_PADRAO.corpo },
      disponiveis: MODELOS_DA_PLATAFORMA.map((x) => ({ nomeNoProvedor: x.nomeNoProvedor, texto: x.corpo })),
    });
  });

  it('a lista de nomes do banco é IGUAL à do código; nome fora dela é recusado pelo banco', async () => {
    const [r] = await api.db.db.execute<{ nomes: string[] }>(sql`select app_whatsapp_platform_templates() as nomes`);
    expect([...(r?.nomes ?? [])].sort()).toEqual(MODELOS_DA_PLATAFORMA.map((m) => m.nomeNoProvedor).sort());
    const tel = telefoneNovo();
    const p = await paciente(adminA, tel);
    const c = await consulta(adminA, p, 20);
    const o = await optIn(adminA, p);
    const hashDoOptIn = (await optInDoBanco(clinicaA, o.id))?.recipientPhoneHash ?? '';
    expect(
      await sqlstate(
        withTenant(
          api.db.db,
          clinicaA,
          (tx) =>
            tx.insert(whatsappOutbox).values({
              tenantId: clinicaA,
              appointmentId: c.id,
              appointmentStartsAt: c.inicio,
              patientId: p,
              optInId: o.id,
              templateName: 'modelo_da_clinica_x',
              recipientKind: 'paciente',
              recipientPhoneHash: hashDoOptIn,
              createdBy: adminA.userId,
            }),
          adminA.userId,
        ),
      ),
    ).toContain('23514');
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
    // N2 do 2º parecer do #69: UMA resposta fixa por envio, por mais que o paciente escreva.
    expect(falso.respostasFixas.filter((r) => r.para === `55${tel}`)).toHaveLength(1);
  });

  it('R1: texto livre não é guardado; o paciente recebe a resposta FIXA (ligue para a clínica)', async () => {
    const tel = telefoneNovo();
    const p = await paciente(adminA, tel);
    const a = await consulta(adminA, p, 19);
    await optIn(adminA, p);
    await svc.executarLembretesComoSistema(clinicaA);
    const ea = await envioDoAgendamento(clinicaA, a.id);
    const queixa = 'Estou com dor no peito QZX-LIVRE, posso ir?';
    expect((await webhook(corpoDeResposta(numeroA, `55${tel}`, queixa, ea?.providerMessageId ?? ''))).body).toEqual({ processados: 1, ignorados: 0 });
    const [linha] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(whatsappInbound).where(eq(whatsappInbound.outboxId, ea?.id ?? '')));
    expect(linha).toMatchObject({ interpretation: 'outro', outcome: 'sem_acao' });
    expect(Object.keys(linha ?? {}).sort()).toEqual(['id', 'interpretation', 'outboxId', 'outcome', 'providerMessageId', 'receivedAt', 'tenantId']);
    // Nem cifrado: nenhuma coluna de texto ou número existe na tabela de respostas.
    const [cols] = await api.db.db.execute<{ n: number }>(
      sql`select count(*)::int as n from information_schema.columns where table_name = 'whatsapp_inbound' and column_name in ('body_enc', 'sender_phone_enc')`,
    );
    expect(cols?.n).toBe(0);
    expect(falso.respostasFixas.filter((r) => r.para === `55${tel}`)).toEqual([{ para: `55${tel}`, remetente: numeroA, texto: RESPOSTA_FIXA_OUTRO }]);
    expect(textoEhNeutro(RESPOSTA_FIXA_OUTRO)).toBe(true);
    // "1" não recebe texto fixo (é ação, não conversa).
    await webhook(corpoDeResposta(numeroA, `55${tel}`, '1', ea?.providerMessageId ?? '')).expect(200);
    expect(falso.respostasFixas.filter((r) => r.para === `55${tel}`)).toHaveLength(1);
    // A resposta gravada não muda (nem pelo runtime).
    expect(
      await sqlstate(withTenant(api.db.db, clinicaA, (tx) => tx.update(whatsappInbound).set({ outcome: 'confirmado' }).where(eq(whatsappInbound.id, linha?.id ?? '')), adminA.userId)),
    ).toContain('42501');
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

  it('V2: paciente SEM data de nascimento não registra opt-in próprio (409) e, se a data sumir depois, nada sai', async () => {
    const tel = telefoneNovo();
    const semData = await paciente(adminA, tel, null);
    const r = await api.http().post(`/pacientes/${semData}/whatsapp/opt-in`).set(cab(adminA)).send({ destinatario: 'paciente', meio: 'verbal_na_recepcao', comprovante: 'Registro ficticio V2' });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ codigo: 'data_de_nascimento_ausente' });
    // Adulto com opt-in; a data some do cadastro antes do lembrete: falha fechada, nada sai.
    const tel2 = telefoneNovo();
    const p = await paciente(adminA, tel2);
    const c = await consulta(adminA, p, 20);
    await optIn(adminA, p);
    await withTenant(api.db.db, clinicaA, (tx) => tx.update(patients).set({ birthDateEnc: null }).where(eq(patients.id, p)), adminA.userId);
    const res = await svc.executarLembretesComoSistema(clinicaA);
    expect(res.semDestinatario).toBeGreaterThanOrEqual(1);
    expect(enviadasPara(tel2)).toHaveLength(0);
    expect(await envioDoAgendamento(clinicaA, c.id)).toBeUndefined();
  });

  it('menor não registra opt-in em nome próprio (409); com o responsável, vai para o telefone dele', async () => {
    const tel = telefoneNovo();
    const nascimento = `${new Date().getUTCFullYear() - 10}-01-01`;
    const p = await paciente(adminA, tel, nascimento);
    const a = await consulta(adminA, p, 20);
    const proprio = await api.http().post(`/pacientes/${p}/whatsapp/opt-in`).set(cab(adminA)).send({ destinatario: 'paciente', meio: 'verbal_na_recepcao', comprovante: 'Registro ficticio menor' });
    expect(proprio.status).toBe(409);
    expect(proprio.body).toMatchObject({ codigo: 'paciente_menor_de_idade' });
    await svc.executarLembretesComoSistema(clinicaA);
    expect(enviadasPara(tel)).toHaveLength(0);
    // Responsável desconhecido (sem vínculo da 0028 com o paciente): 409.
    const sem = await api.http().post(`/pacientes/${p}/whatsapp/opt-in`).set(cab(adminA)).send({ destinatario: 'responsavel', responsavelId: randomUUID(), meio: 'verbal_na_recepcao', comprovante: 'Registro ficticio resp' });
    expect(sem.status).toBe(409);
    const resp = await responsavel(adminA, p);
    await optIn(adminA, p, { destinatario: 'responsavel', responsavelId: resp.pessoaId, meio: 'verbal_na_recepcao', comprovante: 'Registro ficticio resp' });
    expect((await svc.executarLembretesComoSistema(clinicaA)).programados).toBeGreaterThanOrEqual(1);
    expect(enviadasPara(resp.telefone).length).toBeGreaterThanOrEqual(1);
    expect(enviadasPara(tel)).toHaveLength(0);
    expect(await envioDoAgendamento(clinicaA, a.id)).toMatchObject({ recipientKind: 'responsavel', guardianId: resp.pessoaId });
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
  it('B não vê fila, opt-ins, respostas nem configuração de A (RLS e API)', async () => {
    const tel = telefoneNovo();
    const p = await paciente(adminA, tel);
    const a = await consulta(adminA, p, 20);
    await optIn(adminA, p);
    await svc.executarLembretesComoSistema(clinicaA);
    const ea = await envioDoAgendamento(clinicaA, a.id);
    await webhook(corpoDeResposta(numeroA, `55${tel}`, 'ok', ea?.providerMessageId ?? '')).expect(200);
    const contagens = await withTenant(api.db.db, clinicaB, async (tx: TenantTx) => {
      const n = async (t: typeof whatsappOutbox | typeof whatsappOptIns | typeof whatsappInbound | typeof whatsappSettings | typeof whatsappPhoneKeys) =>
        (await tx.select({ n: sql<number>`count(*)::int` }).from(t).where(eq(t.tenantId, clinicaA)))[0]?.n;
      return {
        outbox: await n(whatsappOutbox),
        optIns: await n(whatsappOptIns),
        inbound: await n(whatsappInbound),
        settings: await n(whatsappSettings),
        chaves: await n(whatsappPhoneKeys),
      };
    });
    expect(contagens).toEqual({ outbox: 0, optIns: 0, inbound: 0, settings: 0, chaves: 0 });
    // A chave de comparação de número de A existe (houve opt-in), mas B não a lê nem grava uma no nome de A.
    expect(await withTenant(api.db.db, clinicaA, async (tx) => (await tx.select().from(whatsappPhoneKeys)).length)).toBe(1);
    expect(
      await sqlstate(withTenant(api.db.db, clinicaB, (tx) => tx.insert(whatsappPhoneKeys).values({ tenantId: clinicaA, keyEnc: 'x' }), adminB.userId)),
    ).toContain('42501');
    // Gravar com o tenant de A no contexto de B: o WITH CHECK recusa.
    expect(
      await sqlstate(
        withTenant(
          api.db.db,
          clinicaB,
          (tx) => tx.insert(whatsappOptIns).values({ tenantId: clinicaA, patientId: p, recipientKind: 'paciente', method: 'verbal_na_recepcao', grantedBy: adminB.userId, ...SELO_FALSO }),
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

describe('limpeza (R2/R3): job chamável, 30 dias, nenhuma linha presa', () => {
  /** Envio de verdade (programado e despachado pelo job), para envelhecer depois. */
  async function envioReal(falhaTemporaria = false) {
    const tel = telefoneNovo();
    const p = await paciente(adminA, tel);
    const c = await consulta(adminA, p, 20);
    await optIn(adminA, p);
    if (falhaTemporaria) falso.numerosIndisponiveis.add(`55${tel}`);
    try {
      await svc.executarLembretesComoSistema(clinicaA);
    } finally {
      falso.numerosIndisponiveis.delete(`55${tel}`);
    }
    const e = await envioDoAgendamento(clinicaA, c.id);
    if (!e) throw new Error('envio não programado');
    return e;
  }

  it('job do sistema: conteúdo com mais de 30 dias sai (texto e número); status, datas e HMAC ficam; idempotente', async () => {
    const velho = await envioReal();
    const novo = await envioReal();
    expect(velho.status).toBe('enviado');
    await envelhecer(velho.id, { criadoHaDias: 31 });
    await envelhecer(novo.id, { criadoHaDias: 29 });
    const r = await svc.executarRetencaoComoSistema(clinicaA);
    expect(r.enviosLimpos).toBeGreaterThanOrEqual(1);
    const depois = await envioDoAgendamento(clinicaA, velho.appointmentId);
    expect(depois).toMatchObject({ bodyEnc: null, recipientPhoneEnc: null, status: 'enviado', recipientPhoneHash: velho.recipientPhoneHash });
    expect(depois?.contentPurgedAt).not.toBeNull();
    expect(depois?.sentAt).not.toBeNull();
    // 29 dias: fica.
    expect((await envioDoAgendamento(clinicaA, novo.appointmentId))?.bodyEnc).toMatch(/^v1:/);
    // De novo: nada a fazer (idempotente).
    expect(await svc.executarRetencaoComoSistema(clinicaA)).toEqual({ agendadosExpirados: 0, enviosInterrompidos: 0, enviosLimpos: 0 });
    // Trilha do job: ator sistema, só contagens.
    const [t] = await withTenant(api.db.db, clinicaA, (tx) =>
      tx.select().from(auditLog).where(and(eq(auditLog.scope, 'whatsapp_outbox'), sql`${auditLog.metadata}->>'op' = 'content_retention'`, sql`${auditLog.metadata}->>'outbox_purged' <> '0'`)),
    );
    expect(t).toMatchObject({ actorKind: 'sistema' });
  });

  it('"agendado" de consulta que já passou: cancelado (expirado) e o conteúdo sai aos 30 dias', async () => {
    const e = await envioReal(true);
    expect(e).toMatchObject({ status: 'agendado', attempts: 1 });
    await envelhecer(e.id, { criadoHaDias: 31, consultaHaHoras: 2 });
    const r = await svc.executarRetencaoComoSistema(clinicaA);
    expect(r.agendadosExpirados).toBeGreaterThanOrEqual(1);
    expect(await envioDoAgendamento(clinicaA, e.appointmentId)).toMatchObject({ status: 'cancelado', failureCode: 'expirado', bodyEnc: null, recipientPhoneEnc: null });
  });

  it('"enviando" preso há mais de 24 h: falhou (envio_interrompido) com fallback, sem reenviar; o conteúdo sai aos 30 dias', async () => {
    const e = await envioReal(true);
    const antes = falso.enviadas.length;
    await envelhecer(e.id, { criadoHaDias: 31, enviandoHaHoras: 25 });
    // Preso há menos de 24 h: fica (pode ser um envio em andamento).
    const outro = await envioReal(true);
    await envelhecer(outro.id, { enviandoHaHoras: 1 });
    const r = await svc.executarRetencaoComoSistema(clinicaA);
    expect(r.enviosInterrompidos).toBeGreaterThanOrEqual(1);
    expect(await envioDoAgendamento(clinicaA, e.appointmentId)).toMatchObject({
      status: 'falhou',
      failureCode: 'envio_interrompido',
      needsFallback: true,
      bodyEnc: null,
      recipientPhoneEnc: null,
    });
    expect((await envioDoAgendamento(clinicaA, outro.appointmentId))?.status).toBe('enviando');
    // Nada foi reenviado.
    await svc.executarLembretesComoSistema(clinicaA);
    expect(falso.enviadas.length).toBe(antes);
  });
});

describe('auditoria e retenção', () => {
  it('trilha do WhatsApp sem número de telefone, texto da mensagem ou do comprovante', async () => {
    const linhas = await withTenant(api.db.db, clinicaA, (tx) => tx.select({ m: auditLog.metadata, s: auditLog.scope }).from(auditLog).where(sql`${auditLog.scope} like 'whatsapp%'`));
    expect(linhas.length).toBeGreaterThan(5);
    const texto = JSON.stringify(linhas);
    for (const t of [...telefonesUsados, ...telefonesDeResponsaveis]) expect(texto).not.toContain(t);
    for (const proibido of ['Agendamentos', 'compromisso', 'QZX', 'Termo ficticio', 'SAIR', 'oi 1']) expect(texto).not.toContain(proibido);
  });

  it('retenção: conteúdo com menos de 30 dias fica; a regra do banco recusa limpar antes', async () => {
    const r = await api.http().post('/whatsapp/retencao/execucao').set(cab(adminA)).send({});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ enviosLimpos: 0 });
    const [e] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(whatsappOutbox).limit(1));
    expect(
      await sqlstate(
        withTenant(api.db.db, clinicaA, (tx) => tx.update(whatsappOutbox).set({ bodyEnc: null, recipientPhoneEnc: null, contentPurgedAt: new Date() }).where(eq(whatsappOutbox.id, e?.id ?? '')), adminA.userId),
      ),
    ).toContain('42501');
  });
});

/**
 * R4 do #69 (integração da rodada 19, migração 0036): o lembrete de MENOR sai pelo telefone do responsável
 * VIGENTE da 0028 (FK `guardian_id` -> guardians). Aos 18 anos ou na emancipação a representação acaba
 * (fora a curatela); sem responsável vigente, nada sai. Tudo pela porta REAL (ResponsaveisPeloCatalogo).
 */
describe('R4 do #69: responsável vigente da 0028, maioridade e emancipação', () => {
  const anosAtras = (anos: number) => `${new Date().getUTCFullYear() - anos}-01-01`;
  const rodar = () => svc.executarLembretesComoSistema(clinicaA);

  it('menor com responsável vigente: sai para o telefone do responsável, nunca para o do paciente', async () => {
    const tel = telefoneNovo();
    const p = await paciente(adminA, tel, anosAtras(9));
    const resp = await responsavel(adminA, p);
    await optIn(recepA, p, { destinatario: 'responsavel', responsavelId: resp.pessoaId, meio: 'formulario_assinado', comprovante: 'Termo ficticio R4-1' });
    const c = await consulta(adminA, p, 20);
    await rodar();
    expect(enviadasPara(resp.telefone)).toHaveLength(1);
    expect(enviadasPara(tel)).toHaveLength(0);
    expect(await envioDoAgendamento(clinicaA, c.id)).toMatchObject({ status: 'enviado', recipientKind: 'responsavel', guardianId: resp.pessoaId });
  });

  it('vínculo encerrado: nada sai e novo opt-in com a pessoa é recusado', async () => {
    const tel = telefoneNovo();
    const p = await paciente(adminA, tel, anosAtras(10));
    const resp = await responsavel(adminA, p);
    await optIn(adminA, p, { destinatario: 'responsavel', responsavelId: resp.pessoaId, meio: 'verbal_na_recepcao', comprovante: 'Registro ficticio R4-2' });
    const c = await consulta(adminA, p, 20);
    await api.http().post(`/pacientes/${p}/responsaveis/${resp.vinculoId}/encerrar`).set(cab(adminA)).send({ motivo: 'decisao_judicial' }).expect(200);
    const r = await rodar();
    expect(r.semDestinatario).toBeGreaterThanOrEqual(1);
    expect(enviadasPara(resp.telefone)).toHaveLength(0);
    expect(enviadasPara(tel)).toHaveLength(0);
    expect(await envioDoAgendamento(clinicaA, c.id)).toBeUndefined();
    const novo = await api
      .http()
      .post(`/pacientes/${p}/whatsapp/opt-in`)
      .set(cab(adminA))
      .send({ destinatario: 'responsavel', responsavelId: resp.pessoaId, meio: 'verbal_na_recepcao', comprovante: 'Registro ficticio R4-2b' });
    expect(novo.status).toBe(409);
    expect(novo.body).toMatchObject({ codigo: 'responsavel_nao_vinculado' });
  });

  it('maioridade: com o vínculo ainda vigente, o responsável deixa de receber (e não registra opt-in novo)', async () => {
    const tel = telefoneNovo();
    const p = await paciente(adminA, tel, anosAtras(17));
    const resp = await responsavel(adminA, p);
    await optIn(adminA, p, { destinatario: 'responsavel', responsavelId: resp.pessoaId, meio: 'verbal_na_recepcao', comprovante: 'Registro ficticio R4-3' });
    // A data de nascimento corrigida para a de um adulto: a representação (pai/mãe) acabou.
    const corr = await api.http().patch(`/pacientes/${p}`).set(cab(adminA)).send({ nascimento: anosAtras(19) });
    expect(corr.status, JSON.stringify(corr.body)).toBe(200);
    const c = await consulta(adminA, p, 20);
    await rodar();
    expect(enviadasPara(resp.telefone)).toHaveLength(0);
    expect(enviadasPara(tel)).toHaveLength(0);
    expect(await envioDoAgendamento(clinicaA, c.id)).toBeUndefined();
    const novo = await api
      .http()
      .post(`/pacientes/${p}/whatsapp/opt-in`)
      .set(cab(adminA))
      .send({ destinatario: 'responsavel', responsavelId: resp.pessoaId, meio: 'verbal_na_recepcao', comprovante: 'Registro ficticio R4-3b' });
    expect(novo.status).toBe(409);
    expect(novo.body).toMatchObject({ codigo: 'responsavel_nao_representa' });
  });

  it('emancipação: o responsável não recebe mais; o emancipado registra opt-in em nome próprio e recebe', async () => {
    const tel = telefoneNovo();
    const p = await paciente(adminA, tel, anosAtras(17));
    const resp = await responsavel(adminA, p);
    await optIn(adminA, p, { destinatario: 'responsavel', responsavelId: resp.pessoaId, meio: 'verbal_na_recepcao', comprovante: 'Registro ficticio R4-4' });
    const em = await api
      .http()
      .post(`/pacientes/${p}/responsaveis/emancipacao`)
      .set(cab(adminA))
      .send({ data: noFusoDaClinica(new Date()).data, documento: 'Escritura ficticia R4' });
    expect(em.status, JSON.stringify(em.body)).toBe(200);
    const c = await consulta(adminA, p, 20);
    await rodar();
    expect(enviadasPara(resp.telefone)).toHaveLength(0);
    expect(await envioDoAgendamento(clinicaA, c.id)).toBeUndefined();
    // Em nome próprio (troca de destinatário): agora sai para o telefone do paciente.
    await optIn(adminA, p, { destinatario: 'paciente', meio: 'verbal_na_recepcao', comprovante: 'Registro ficticio R4-4b' });
    await rodar();
    expect(enviadasPara(tel)).toHaveLength(1);
    expect(enviadasPara(resp.telefone)).toHaveLength(0);
  });

  /** Profissional SEM área sensível (o `profA` deste arquivo é de Psiquiatria). */
  let profNeutro: string;
  beforeAll(async () => {
    profNeutro = idDe(await api.http().post('/profissionais').set(cab(adminA)).send({ nome: 'Fisio Ficticio R4', especialidade: 'Fisioterapia' }));
  });

  it('curatela: o curador do paciente ADULTO recebe (a curatela não acaba aos 18)', async () => {
    const tel = telefoneNovo();
    const p = await paciente(adminA, tel, anosAtras(40));
    const cur = await responsavel(adminA, p, {
      tipo: 'curador',
      curatelaReferencia: 'Processo ficticio 0000-R4',
      curatelaEscopo: 'Escopo ficticio de teste da curatela',
    });
    await optIn(adminA, p, { destinatario: 'responsavel', responsavelId: cur.pessoaId, meio: 'verbal_na_recepcao', comprovante: 'Registro ficticio R4-5' });
    const c = await consulta(adminA, p, 20, profNeutro);
    await rodar();
    expect(enviadasPara(cur.telefone)).toHaveLength(1);
    expect(enviadasPara(tel)).toHaveLength(0);
    expect(await envioDoAgendamento(clinicaA, c.id)).toMatchObject({ recipientKind: 'responsavel', guardianId: cur.pessoaId });
  });

  it('R4 (c) sigilo do adolescente: consulta de área sensível do 12+ não vira lembrete ao responsável; a da criança vira', async () => {
    const telT = telefoneNovo();
    const teen = await paciente(adminA, telT, anosAtras(14));
    const respT = await responsavel(adminA, teen);
    await optIn(adminA, teen, { destinatario: 'responsavel', responsavelId: respT.pessoaId, meio: 'verbal_na_recepcao', comprovante: 'Registro ficticio R4-6' });
    const psiq = await consulta(adminA, teen, 20); // profA: Psiquiatria (área sensível)
    const fisio = await consulta(adminA, teen, 21, profNeutro);
    const r = await rodar();
    expect(r.semDestinatario).toBeGreaterThanOrEqual(1);
    expect(await envioDoAgendamento(clinicaA, psiq.id)).toBeUndefined();
    expect(await envioDoAgendamento(clinicaA, fisio.id)).toMatchObject({ recipientKind: 'responsavel', guardianId: respT.pessoaId });
    expect(enviadasPara(respT.telefone)).toHaveLength(1);
    // Criança (< 12): a agenda inteira é lembrada ao responsável, inclusive a de área sensível.
    const crianca = await paciente(adminA, telefoneNovo(), anosAtras(8));
    const respC = await responsavel(adminA, crianca);
    await optIn(adminA, crianca, { destinatario: 'responsavel', responsavelId: respC.pessoaId, meio: 'verbal_na_recepcao', comprovante: 'Registro ficticio R4-7' });
    const psiqC = await consulta(adminA, crianca, 20);
    await rodar();
    expect(await envioDoAgendamento(clinicaA, psiqC.id)).toMatchObject({ recipientKind: 'responsavel' });
  });

  it('banco (0036): FK de guardian_id para guardians e opt-in de responsável sem vínculo vigente recusado', async () => {
    const fks = await owner<{ tabela: string; alvo: string }[]>`
      SELECT conrelid::regclass::text AS tabela, confrelid::regclass::text AS alvo FROM pg_constraint
       WHERE contype = 'f' AND conname IN ('whatsapp_opt_ins_guardian_fk', 'whatsapp_outbox_guardian_fk') ORDER BY 1`;
    expect(fks).toEqual([
      { tabela: 'whatsapp_opt_ins', alvo: 'guardians' },
      { tabela: 'whatsapp_outbox', alvo: 'guardians' },
    ]);
    // Pessoa existente, mas o vínculo é com OUTRO paciente: o gatilho recusa antes de qualquer outra regra.
    const p = await paciente(adminA, telefoneNovo(), anosAtras(8));
    const outro = await paciente(adminA, telefoneNovo(), anosAtras(8));
    const resp = await responsavel(adminA, outro);
    const erro = await withTenant(
      api.db.db,
      clinicaA,
      (tx) =>
        tx.insert(whatsappOptIns).values({
          tenantId: clinicaA,
          patientId: p,
          recipientKind: 'responsavel',
          guardianId: resp.pessoaId,
          method: 'verbal_na_recepcao',
          grantedBy: adminA.userId,
          ...SELO_FALSO,
        }),
      adminA.userId,
    ).then(
      () => null,
      (e: unknown) => e,
    );
    const mensagens: string[] = [];
    for (let e: unknown = erro; e instanceof Error; e = e.cause) mensagens.push(e.message);
    expect(mensagens.join(' | ')).toContain('responsável sem vínculo vigente');
  });
});

/** Ressalvas novas do 2º parecer do #69 (22/10), resolvidas na integração (migração 0037). */
describe('2º parecer do #69: N1 (modelo reconferido), N3 + R3 (eliminação do paciente)', () => {
  it('N1: modelo divergente na reconferência PARA o despacho; voltando a conferir, sai', async () => {
    const tel = telefoneNovo();
    const p = await paciente(adminA, tel);
    await optIn(adminA, p);
    const c = await consulta(adminA, p, 20);
    falso.modeloDivergente = true;
    try {
      expect(await svc.reconferirModelos(true)).toBe(false);
      const r = await svc.executarLembretesComoSistema(clinicaA);
      expect(r).toMatchObject({ motivo: 'canal_desligado', programados: 0, enviados: 0 });
      expect(enviadasPara(tel)).toHaveLength(0);
      expect(await envioDoAgendamento(clinicaA, c.id)).toBeUndefined();
    } finally {
      falso.modeloDivergente = false;
    }
    // Divergente = reconfere a cada execução; voltou a bater, o despacho segue.
    expect((await svc.executarLembretesComoSistema(clinicaA)).motivo).toBe('ok');
    expect(enviadasPara(tel)).toHaveLength(1);
    // Conferido ok: a próxima execução não chama o provedor de novo (no máximo 1 vez a cada 24 h).
    const antes = falso.conferencias;
    await svc.executarLembretesComoSistema(clinicaA);
    expect(falso.conferencias).toBe(antes);
  });

  it('N3 + R3: eliminado o paciente (guarda vencida), saem envios, respostas e o número/HMAC do opt-in', async () => {
    await api.membro(clinicaA, adminA, 'admin');
    const tel = telefoneNovo();
    const p = await paciente(adminA, tel);
    await optIn(adminA, p);
    const c = await consulta(adminA, p, 20);
    await svc.executarLembretesComoSistema(clinicaA);
    const e = await envioDoAgendamento(clinicaA, c.id);
    expect(e?.status).toBe('enviado');
    await webhook(corpoDeResposta(numeroA, `55${tel}`, 'oi', e?.providerMessageId ?? '')).expect(200);
    const rota = `/pacientes/${p}/responsaveis/eliminacao`;
    // Na guarda: a API recusa e o banco também (55000), e o runtime nunca apaga a fila direto (42501).
    expect((await api.http().post(rota).set(cab(adminA)).send({})).body).toMatchObject({ codigo: 'prazo_de_guarda_do_prontuario' });
    expect(
      await sqlstate(withTenant(api.db.db, clinicaA, (tx) => tx.execute(sql`select * from app_patient_guardians_eliminate(${p}::uuid)`), adminA.userId)),
    ).toContain('55000');
    expect(
      await sqlstate(withTenant(api.db.db, clinicaA, (tx) => tx.execute(sql`delete from whatsapp_outbox where patient_id = ${p}::uuid`), adminA.userId)),
    ).toContain('42501');
    // Guarda vencida (papel de migração envelhece o cadastro: o runtime não consegue).
    await owner.begin(async (t) => {
      await t`select app_set_tenant(${clinicaA}::uuid)`;
      await t`update patients set created_at = created_at - interval '21 years' where id = ${p}::uuid`;
    });
    const r = await api.http().post(rota).set(cab(adminA)).send({});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const restos = await withTenant(
      api.db.db,
      clinicaA,
      async (tx) => ({
        fila: await tx.select().from(whatsappOutbox).where(eq(whatsappOutbox.patientId, p)),
        respostas: await tx.select().from(whatsappInbound).where(eq(whatsappInbound.outboxId, e?.id ?? '')),
        optIns: await tx.select().from(whatsappOptIns).where(eq(whatsappOptIns.patientId, p)),
      }),
      adminA.userId,
    );
    expect(restos.fila).toEqual([]);
    expect(restos.respostas).toEqual([]);
    expect(restos.optIns).toHaveLength(1);
    expect(restos.optIns[0]).toMatchObject({ recipientPhoneEnc: null, recipientPhoneHash: null, revokeMethod: 'eliminacao_do_titular', revokedBy: null });
    expect(restos.optIns[0]?.phonePurgedAt).toBeInstanceOf(Date);
    expect(restos.optIns[0]?.revokedAt).toBeInstanceOf(Date);
    // A prova do opt-in fica (regra própria de retenção ⚖️); nada mais muda no opt-in eliminado.
    expect(restos.optIns[0]?.evidenceEnc).toMatch(/^v1:/);
    expect(
      await sqlstate(
        withTenant(api.db.db, clinicaA, (tx) => tx.update(whatsappOptIns).set({ phonePurgedAt: null }).where(eq(whatsappOptIns.patientId, p)), adminA.userId),
      ),
    ).toContain('42501');
    // Idempotente.
    expect((await api.http().post(rota).set(cab(adminA)).send({})).status).toBe(200);
  });
});
