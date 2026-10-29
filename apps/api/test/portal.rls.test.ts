/**
 * PORTAL DO PACIENTE (rodada 18.1; veto B3 do front-r8) contra Postgres REAL (DATABASE_URL = app_user,
 * migrações aplicadas). Dados 100% fictícios, gerados a cada execução.
 *
 * Prova: o paciente A nunca vê dados do B (mesma clínica e outra clínica), convite expira e é de uso
 * único, consulta alheia dá 404, nenhum cabeçalho/parâmetro escolhe paciente ou clínica, pedido do
 * titular registrado e visível só para a clínica certa, consentimento em histórico, defesa no banco
 * (policies restritivas portal_titular/portal_fora e gatilho da agenda), limite por conta e trilha.
 */
import {
  CAMPOS_CLINICOS_PROIBIDOS,
  caminhoPortal,
  conferirForma,
  conferirRespostaPortal,
  CONTRATO_PORTAL,
  FormaErroDaApi,
  type RespostaPortal,
  type RotaPortal,
  type TenantId,
} from '@plataforma/shared';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appointments,
  auditLog,
  clinicalNotices,
  encounters,
  patientGuardians,
  patients,
  portalConsents,
  portalInvites,
  portalLinks,
  portalRightsRequests,
  professionals,
} from '../src/db/schema';
import { withTenant, type TenantTx } from '../src/db/tenant-transaction';
import { FIELD_CIPHER } from '../src/modules/crypto/crypto.module';
import type { FieldCipher } from '../src/modules/crypto/field-cipher';
import { patientFieldRef } from '../src/modules/patients/patient-fields';
import { verifyAuditChain } from '../src/modules/audit/audit-chain';
import { hojeNaClinica } from '../src/modules/insurance/guias-regras';
import { JobsService } from '../src/modules/jobs/jobs.module';
import { PortalClinicaService } from '../src/modules/portal/portal-clinica.service';
import { consentimentoIaDoPaciente } from '../src/modules/portal/consentimento-ia';
import { cab, cpfFicticio, subirApi, type ApiDeTeste } from './apoio-api';

type Sessao = { Authorization: string; userId: string };
type SessaoPortal = { Authorization: string; contaId: string };

let api: ApiDeTeste;
let clinicaA: TenantId;
let clinicaB: TenantId;
let adminA: Sessao;
let adminB: Sessao;
let pacA1: string;
let pacA2: string;
let pacB1: string;
let pacMenor: string;
const ag = { a1x: '', a1y: '', a1z: '', a2: '', b1: '' };
let reciboA1: string;
let reciboA2: string;
const DETALHE = 'Pedido ficticio de acesso QZX8801';
const RESPOSTA = 'Resposta ficticia da clinica QZX8802';

async function criarPaciente(s: Sessao, nome: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await api.http().post('/pacientes').set(cab(s)).send({ nome, telefone: '11900001111', ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return (r.body as { id: string }).id;
}

async function agendar(s: Sessao, pacienteId: string, prof: string, tipo: string, data: string, hora: string): Promise<string> {
  const r = await api.http().post('/agendamentos').set(cab(s)).send({ pacienteId, profissionalId: prof, tipoId: tipo, data, hora, encaixe: true });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return (r.body as { id: string }).id;
}

async function recibo(s: Sessao, agendamentoId: string): Promise<string> {
  const c = await api.http().post('/financeiro/cobrancas').set(cab(s)).send({ agendamentoId, valorCentavos: 5000 });
  expect(c.status, JSON.stringify(c.body)).toBe(201);
  const p = await api.http().post(`/financeiro/cobrancas/${(c.body as { id: string }).id}/recebimentos`).set(cab(s)).send({ forma: 'dinheiro' });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  const r = await api.http().post(`/financeiro/recebimentos/${(p.body as { id: string }).id}/recibo`).set(cab(s)).send({});
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return (r.body as { id: string }).id;
}

async function convidar(s: Sessao, pacienteId: string, extra: Record<string, unknown> = {}): Promise<{ id: string; token: string }> {
  const r = await api.http().post('/clinica/portal/convites').set(cab(s)).send({ pacienteId, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; token: string };
}

/** Telefone fictício de todo paciente criado por criarPaciente (destino do código de resgate). */
const TELEFONE = '11900001111';

/** Resgate em dois passos (A2 do #68): token -> código no telefone do cadastro -> token + código. */
async function resgatar(p: SessaoPortal, token: string, a: ApiDeTeste = api): Promise<{ status: number; vinculoId?: string; codigo?: string }> {
  const i = await a.http().post('/portal/convites/resgate').set(cab(p)).send({ token });
  if (i.status !== 200) return { status: i.status, ...(i.body as { codigo?: string }) };
  const r = await a.http().post('/portal/convites/resgate/confirmar').set(cab(p)).send({ token, codigo: a.otp.ultimoCodigo(TELEFONE) });
  return { status: r.status, ...(r.body as { vinculoId?: string; codigo?: string }) };
}

/** Conta nova do portal já vinculada ao paciente. */
async function contaDe(s: Sessao, pacienteId: string, extra: Record<string, unknown> = {}): Promise<SessaoPortal & { vinculoId: string }> {
  const p = api.sessaoPortal();
  const { token } = await convidar(s, pacienteId, extra);
  const r = await resgatar(p, token);
  expect(r.status).toBe(200);
  return { ...p, vinculoId: r.vinculoId as string };
}

/** Responsável (0028) do paciente, com o mesmo telefone fictício (destino do código); devolve o id do VÍNCULO. */
async function responsavelDe(pacienteId: string, nome: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await api.http().post(`/pacientes/${pacienteId}/responsaveis`).set(cab(adminA)).send({ nome, tipo: 'pai_mae', telefone: TELEFONE, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return (r.body as { id: string }).id;
}

/** Data de nascimento de quem completa `anos` em hoje + `dias` (hoje no fuso da clínica). */
function nascidoHa(anos: number, dias = 0): string {
  const [a, m, d] = hojeNaClinica().split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(a - anos, m - 1, d + dias)).toISOString().slice(0, 10);
}

beforeAll(async () => {
  api = await subirApi();
  clinicaA = await api.novaClinica();
  clinicaB = await api.novaClinica();
  // 0053: a conferência de documento exige perfil ATIVO no banco (clinic_members), não só na sessão.
  adminA = await api.membro(clinicaA, api.sessao(clinicaA, 'admin'), 'admin');
  adminB = api.sessao(clinicaB, 'admin');
  const profA = (await api.http().post('/profissionais').set(cab(adminA)).send({ nome: 'Prof Ficticia A', especialidade: 'Fisioterapia' })).body as { id: string };
  const tipoA = (await api.http().post('/tipos-atendimento').set(cab(adminA)).send({ nome: 'Sessao', minutos: 30 })).body as { id: string };
  const profB = (await api.http().post('/profissionais').set(cab(adminB)).send({ nome: 'Prof Ficticio B', especialidade: 'Psicologia' })).body as { id: string };
  const tipoB = (await api.http().post('/tipos-atendimento').set(cab(adminB)).send({ nome: 'Sessao B', minutos: 30 })).body as { id: string };
  pacA1 = await criarPaciente(adminA, 'Ana Ficticia Portal', { cpf: cpfFicticio(41), nascimento: '1990-03-04' });
  pacA2 = await criarPaciente(adminA, 'Bruno Ficticio Vizinho', { cpf: cpfFicticio(42), nascimento: '1985-05-06' });
  pacB1 = await criarPaciente(adminB, 'Ana Ficticia Outra Clinica', { nascimento: '1992-07-08' });
  pacMenor = await criarPaciente(adminA, 'Caio Ficticio Menor', { nascimento: '2018-01-01' });
  ag.a1x = await agendar(adminA, pacA1, profA.id, tipoA.id, '2027-02-03', '09:00');
  ag.a1y = await agendar(adminA, pacA1, profA.id, tipoA.id, '2027-02-10', '09:00');
  ag.a1z = await agendar(adminA, pacA1, profA.id, tipoA.id, '2027-02-17', '09:00');
  ag.a2 = await agendar(adminA, pacA2, profA.id, tipoA.id, '2027-02-03', '10:00');
  ag.b1 = await agendar(adminB, pacB1, profB.id, tipoB.id, '2027-02-03', '09:00');
  await api.http().post('/financeiro/caixas').set(cab(adminA)).send({ turno: 'unico' }).expect(201);
  reciboA1 = await recibo(adminA, ag.a1z);
  reciboA2 = await recibo(adminA, ag.a2);
});

afterAll(async () => {
  await api?.fechar();
});

describe('convite: uso único, expiração e revogação', () => {
  it('resgate cria o vínculo; o mesmo token de novo é recusado (409 igual a token desconhecido)', async () => {
    const p = api.sessaoPortal();
    const { token } = await convidar(adminA, pacA1);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const r1 = await resgatar(p, token);
    expect(r1.status).toBe(200);
    expect(r1.vinculoId).toMatch(/^[0-9a-f-]{36}$/);
    const outra = api.sessaoPortal();
    expect(await resgatar(outra, token)).toMatchObject({ status: 409, codigo: 'convite_invalido' });
    expect(await resgatar(p, randomBytes(32).toString('base64url'))).toMatchObject({ status: 409, codigo: 'convite_invalido' });
    expect(await resgatar(p, 'curto')).toMatchObject({ status: 409, codigo: 'convite_invalido' });
  });

  it('convite expirado e convite revogado não resgatam', async () => {
    const token = randomBytes(32).toString('base64url');
    await withTenant(
      api.db.db,
      clinicaA,
      (tx) =>
        tx.insert(portalInvites).values({
          tenantId: clinicaA,
          patientId: pacA1,
          tokenHash: createHash('sha256').update(token).digest('hex'),
          actingAs: 'titular',
          expiresAt: sql`now() + interval '1 second'`,
          createdBy: adminA.userId,
        }),
      adminA.userId,
    );
    await new Promise((r) => setTimeout(r, 1300));
    expect(await resgatar(api.sessaoPortal(), token)).toMatchObject({ status: 409, codigo: 'convite_invalido' });

    const c = await convidar(adminA, pacA1);
    await api.http().post(`/clinica/portal/convites/${c.id}/revogar`).set(cab(adminA)).send({}).expect(200);
    expect(await resgatar(api.sessaoPortal(), c.token)).toMatchObject({ status: 409, codigo: 'convite_invalido' });
    // Convite de outra clínica não se revoga daqui (404, igual a inexistente).
    await api.http().post(`/clinica/portal/convites/${c.id}/revogar`).set(cab(adminB)).send({}).expect(404);
  });

  it('o banco recusa: resgate fora da função, convite com validade > 7 dias e convite emitido pelo sistema', async () => {
    const c = await convidar(adminA, pacA2);
    await expect(
      withTenant(api.db.db, clinicaA, (tx) =>
        tx.update(portalInvites).set({ redeemedAt: sql`now()`, redeemedAccountId: randomUUID(), linkId: randomUUID() }).where(eq(portalInvites.id, c.id)),
      adminA.userId),
    ).rejects.toThrow();
    await expect(
      withTenant(api.db.db, clinicaA, (tx) =>
        tx.insert(portalInvites).values({
          tenantId: clinicaA,
          patientId: pacA2,
          tokenHash: 'b'.repeat(64),
          actingAs: 'titular',
          expiresAt: sql`now() + interval '8 days'`,
          createdBy: adminA.userId,
        }),
      adminA.userId),
    ).rejects.toThrow();
    await expect(
      withTenant(api.db.db, clinicaA, (tx) =>
        tx.insert(portalInvites).values({
          tenantId: clinicaA,
          patientId: pacA2,
          tokenHash: 'c'.repeat(64),
          actingAs: 'titular',
          expiresAt: sql`now() + interval '1 day'`,
          createdBy: adminA.userId,
        }),
      ),
    ).rejects.toThrow();
    // O runtime não insere vínculo direto (só o resgate).
    await expect(
      withTenant(api.db.db, clinicaA, (tx) =>
        tx.insert(portalLinks).values({ tenantId: clinicaA, accountId: randomUUID(), patientId: pacA2, inviteId: c.id, actingAs: 'titular' }),
      adminA.userId),
    ).rejects.toThrow();
  });

  it('A2 do #68: o token sozinho não resgata; código do telefone do cadastro, da mesma conta, 5 tentativas', async () => {
    const p = api.sessaoPortal();
    const { token } = await convidar(adminA, pacA2);
    const i = await api.http().post('/portal/convites/resgate').set(cab(p)).send({ token }).expect(200);
    expect(i.body).toEqual({ canal: 'sms', destino: '(**) *****-1111' });
    expect(JSON.stringify(i.body)).not.toContain(TELEFONE);
    const certo = api.otp.ultimoCodigo(TELEFONE) as string;
    expect(certo).toMatch(/^\d{6}$/);
    const errado = certo === '000000' ? '000001' : '000000';
    const confirmar = (s: SessaoPortal, codigo: string) =>
      api.http().post('/portal/convites/resgate/confirmar').set(cab(s)).send({ token, codigo });
    // Outra conta com o código certo: recusada (o código é da conta que pediu).
    expect((await confirmar(api.sessaoPortal(), certo)).body).toMatchObject({ statusCode: 409, codigo: 'convite_invalido' });
    // Código errado 5 vezes: o código certo deixa de valer.
    for (let k = 0; k < 5; k++) expect((await confirmar(p, errado)).status).toBe(409);
    expect((await confirmar(p, certo)).status).toBe(409);
    // Novo código (novo envio) resgata.
    expect(await resgatar(p, token)).toMatchObject({ status: 200 });
    // Token nunca na URL: query é 400; a versão antiga (só o token) não existe mais no banco.
    await api.http().post('/portal/convites/resgate').query({ token }).set(cab(p)).send({ token }).expect(400);
    await api.http().get('/portal/convites/resgate').query({ token }).set(cab(p)).expect(404);
    await expect(
      api.db.db.transaction((tx) => tx.execute(sql`select app_portal_redeem_invite(${p.contaId}::uuid, ${'a'.repeat(64)})`)),
    ).rejects.toThrow();
    // Paciente sem telefone no cadastro: não há para onde mandar o código (409 igual a convite inválido).
    const semTel = await criarPaciente(adminA, 'Fabi Ficticia Sem Telefone', { nascimento: '1987-09-10' });
    await withTenant(api.db.db, clinicaA, (tx) => tx.update(patients).set({ phoneEnc: null }).where(eq(patients.id, semTel)), adminA.userId);
    const c2 = await convidar(adminA, semTel);
    expect(await resgatar(api.sessaoPortal(), c2.token)).toMatchObject({ status: 409, codigo: 'convite_invalido' });
  });

  it('só quem tem portal:convidar emite convite; paciente de outra clínica = 404', async () => {
    await api.http().post('/clinica/portal/convites').set(cab(api.sessao(clinicaA, 'financeiro'))).send({ pacienteId: pacA1 }).expect(403);
    await api.http().post('/clinica/portal/convites').set(cab(api.sessao(clinicaA, 'profissional'))).send({ pacienteId: pacA1 }).expect(403);
    await api.http().post('/clinica/portal/convites').set(cab(api.sessao(clinicaA, 'recepcao'))).send({ pacienteId: pacA1 }).expect(201);
    await api.http().post('/clinica/portal/convites').set(cab(adminA)).send({ pacienteId: pacB1 }).expect(404);
    await api.http().post('/clinica/portal/convites').set(cab(adminA)).send({ pacienteId: pacA1, validadeHoras: 169 }).expect(400);
  });
});

describe('paciente A nunca vê o paciente B (mesma clínica e outra clínica)', () => {
  it('consultas: só as próprias; nada de A2 nem de B1', async () => {
    const p = await contaDe(adminA, pacA1);
    const r = await api.http().get('/portal/consultas').set(cab(p)).expect(200);
    const ids = (r.body as { id: string }[]).map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining([ag.a1x, ag.a1y]));
    expect(ids).not.toContain(ag.a2);
    expect(ids).not.toContain(ag.b1);
    expect(JSON.stringify(r.body)).not.toContain('Bruno');
    expect(r.body).toEqual(expect.arrayContaining([expect.objectContaining({ id: ag.a1x, profissional: 'Prof Ficticia A', status: 'agendado' })]));
  });

  it('confirmar/cancelar consulta alheia = 404 (mesma clínica e outra); a própria funciona dentro das regras', async () => {
    const p = await contaDe(adminA, pacA1);
    for (const alvo of [ag.a2, ag.b1, randomUUID()]) {
      await api.http().post(`/portal/consultas/${alvo}/confirmar`).set(cab(p)).send({}).expect(404);
      await api.http().post(`/portal/consultas/${alvo}/cancelar`).set(cab(p)).send({}).expect(404);
    }
    const conf = await api.http().post(`/portal/consultas/${ag.a1x}/confirmar`).set(cab(p)).send({}).expect(200);
    expect(conf.body).toEqual({ status: 'confirmado' });
    const repete = await api.http().post(`/portal/consultas/${ag.a1x}/confirmar`).set(cab(p)).send({});
    expect(repete.status).toBe(409);
    await api.http().post(`/portal/consultas/${ag.a1x}/desfazer-confirmacao`).set(cab(p)).send({}).expect(200);
    const canc = await api.http().post(`/portal/consultas/${ag.a1y}/cancelar`).set(cab(p)).send({}).expect(200);
    expect(canc.body).toEqual({ status: 'cancelado' });
    expect((await api.http().post(`/portal/consultas/${ag.a1y}/confirmar`).set(cab(p)).send({})).body).toMatchObject({ codigo: 'status_nao_permite' });
    // A agenda da clínica vê a mudança; as consultas dos outros pacientes ficaram intactas.
    const agenda = await api.http().get('/agendamentos').query({ de: '2027-02-03', ate: '2027-02-17' }).set(cab(adminA)).expect(200);
    const st = Object.fromEntries((agenda.body as { itens: { id: string; status: string }[] }).itens.map((i) => [i.id, i.status]));
    expect(st).toMatchObject({ [ag.a1x]: 'agendado', [ag.a1y]: 'cancelado', [ag.a2]: 'agendado' });
    // Não existe rota genérica de status no portal.
    await api.http().post(`/portal/consultas/${ag.a1x}/status`).set(cab(p)).send({ status: 'atendido' }).expect(404);
  });

  it('consulta passada não muda pelo portal (API e banco)', async () => {
    const p = await contaDe(adminA, pacA1);
    const passado = randomUUID();
    const [prof] = await withTenant(api.db.db, clinicaA, (tx) => tx.execute<{ professional_id: string; appointment_type_id: string }>(
      sql`select professional_id, appointment_type_id from appointments where id = ${ag.a1x}`));
    await withTenant(
      api.db.db,
      clinicaA,
      (tx) =>
        tx.execute(sql`insert into appointments (id, tenant_id, patient_id, professional_id, appointment_type_id, starts_at, ends_at, status, created_by)
          values (${passado}, ${clinicaA}, ${pacA1}, ${prof?.professional_id}, ${prof?.appointment_type_id}, now() - interval '3 days', now() - interval '3 days' + interval '30 minutes', 'scheduled', ${adminA.userId})`),
      adminA.userId,
    );
    expect((await api.http().post(`/portal/consultas/${passado}/cancelar`).set(cab(p)).send({})).body).toMatchObject({ codigo: 'consulta_ja_comecou' });
    await expect(
      api.db.db.transaction(async (tx) => {
        await tx.execute(sql`select app_set_portal_session(${p.contaId}::uuid, ${p.vinculoId}::uuid)`);
        await tx.execute(sql`update appointments set status = 'cancelled', cancelled_at = now() where id = ${passado}`);
      }),
    ).rejects.toThrow();
  });

  it('recibos: só os próprios; recibo de outro paciente = 404', async () => {
    const p = await contaDe(adminA, pacA1);
    const lista = await api.http().get('/portal/recibos').set(cab(p)).expect(200);
    expect((lista.body as { id: string }[]).map((r) => r.id)).toEqual([reciboA1]);
    const det = await api.http().get(`/portal/recibos/${reciboA1}`).set(cab(p)).expect(200);
    expect(det.body).toMatchObject({ id: reciboA1, beneficiario: { cpf: cpfFicticio(41) }, valorCentavos: 5000 });
    await api.http().get(`/portal/recibos/${reciboA2}`).set(cab(p)).expect(404);
  });

  it('meus dados: só o próprio cadastro, CPF mascarado; correção vira pedido para a clínica', async () => {
    const p = await contaDe(adminA, pacA1);
    const r = await api.http().get('/portal/meus-dados').set(cab(p)).expect(200);
    expect(r.body).toEqual({ rotulo: 'meus_dados', nome: 'Ana Ficticia Portal', nomeSocial: null, telefone: '11900001111', cpfMascarado: `***.***.***-${cpfFicticio(41).slice(9)}`, nascimento: '1990-03-04' });
    const c = await api.http().post('/portal/meus-dados/correcao').set(cab(p)).send({ detalhe: 'Telefone ficticio mudou' }).expect(201);
    expect(c.body).toMatchObject({ tipo: 'correcao', situacao: 'aberto' });
  });

  it('conteúdo clínico não é exposto: não há rota de prontuário no portal', async () => {
    const p = await contaDe(adminA, pacA1);
    for (const rota of ['/portal/prontuario', `/portal/pacientes/${pacA1}/prontuario`, '/portal/atendimentos', '/portal/evolucoes']) {
      await api.http().get(rota).set(cab(p)).expect(404);
    }
    const docs = await api.http().get('/portal/documentos').set(cab(p)).expect(200);
    expect(docs.body).toEqual({ itens: [], disponivel: false });
  });
});

describe('sem cabeçalho nem parâmetro de tenant/paciente: o servidor descobre o titular pela sessão', () => {
  it('cabeçalhos forjados são ignorados; query e corpo com ids são recusados (400)', async () => {
    const p = await contaDe(adminA, pacA1);
    const r = await api
      .http()
      .get('/portal/consultas')
      .set(cab(p))
      .set('x-tenant-id', clinicaB)
      .set('x-clinica-id', clinicaB)
      .set('x-paciente-id', pacA2)
      .set('x-vinculo-id', randomUUID())
      .expect(200);
    expect((r.body as { id: string }[]).map((c) => c.id)).not.toContain(ag.a2);
    for (const campo of ['pacienteId', 'tenantId', 'clinicaId', 'vinculoId']) {
      await api.http().get('/portal/consultas').query({ [campo]: pacA2 }).set(cab(p)).expect(400);
      await api.http().get('/portal/recibos').query({ [campo]: pacA2 }).set(cab(p)).expect(400);
      await api.http().post('/portal/solicitacoes').set(cab(p)).send({ tipo: 'acesso', [campo]: pacA2 }).expect(400);
      await api.http().post(`/portal/consultas/${ag.a1z}/confirmar`).set(cab(p)).send({ [campo]: pacA2 }).expect(400);
    }
  });

  it('sessão da clínica não abre o portal e sessão do portal não abre a clínica', async () => {
    const p = await contaDe(adminA, pacA1);
    await api.http().get('/portal/consultas').set(cab(adminA)).expect(401);
    await api.http().get('/portal/consultas').expect(401);
    await api.http().get('/pacientes').set(cab(p)).expect(401);
    await api.http().get('/clinica/portal/solicitacoes').set(cab(p)).expect(401);
  });

  it('conta com vínculo em duas clínicas escolhe na sessão; vínculo de outra conta = 404', async () => {
    const p = api.sessaoPortal();
    const vA = (await resgatar(p, (await convidar(adminA, pacA1)).token)).vinculoId as string;
    // O resgate escolhe o vínculo recém-criado; uma sessão NOVA da mesma conta ainda não escolheu.
    const vB = (await resgatar(p, (await convidar(adminB, pacB1)).token)).vinculoId as string;
    const nova = api.sessaoPortal(p.contaId);
    expect((await api.http().get('/portal/consultas').set(cab(nova))).body).toMatchObject({ codigo: 'escolher_vinculo' });
    const vinculos = await api.http().get('/portal/vinculos').set(cab(nova)).expect(200);
    expect((vinculos.body as { vinculoId: string }[]).map((v) => v.vinculoId).sort()).toEqual([vA, vB].sort());
    await api.http().post('/portal/sessao/vinculo').set(cab(nova)).send({ vinculoId: vB }).expect(200);
    const emB = await api.http().get('/portal/consultas').set(cab(nova)).expect(200);
    expect((emB.body as { id: string }[]).map((c) => c.id)).toEqual([ag.b1]);
    await api.http().post(`/portal/consultas/${ag.a1z}/confirmar`).set(cab(nova)).send({}).expect(404);
    const outra = await contaDe(adminA, pacA2);
    await api.http().post('/portal/sessao/vinculo').set(cab(nova)).send({ vinculoId: outra.vinculoId }).expect(404);
  });

  it('vínculo revogado pela clínica deixa de valer na hora (403 vinculo_inativo)', async () => {
    const p = await contaDe(adminA, pacA1);
    await api.http().get('/portal/consultas').set(cab(p)).expect(200);
    const lista = await api.http().get(`/clinica/portal/pacientes/${pacA1}/vinculos`).set(cab(adminA)).expect(200);
    expect((lista.body as { id: string }[]).map((l) => l.id)).toContain(p.vinculoId);
    await api.http().post(`/clinica/portal/vinculos/${p.vinculoId}/revogar`).set(cab(adminB)).send({ motivo: 'acesso_indevido' }).expect(404);
    await api.http().post(`/clinica/portal/vinculos/${p.vinculoId}/revogar`).set(cab(adminA)).send({ motivo: 'acesso_indevido' }).expect(200);
    expect((await api.http().get('/portal/consultas').set(cab(p))).body).toMatchObject({ statusCode: 403, codigo: 'vinculo_inativo' });
  });
});

describe('A4 do #68: paciente inativado perde o portal', () => {
  it('API 403 vinculo_inativo, some da lista de vínculos e o banco recusa a sessão (42501)', async () => {
    const pac = await criarPaciente(adminA, 'Dora Ficticia Inativa', { nascimento: '1985-05-05' });
    const p = await contaDe(adminA, pac);
    await api.http().get('/portal/consultas').set(cab(p)).expect(200);
    await api.http().post(`/pacientes/${pac}/inativar`).set(cab(adminA)).send({}).expect(200);
    expect((await api.http().get('/portal/consultas').set(cab(p))).body).toMatchObject({ statusCode: 403, codigo: 'vinculo_inativo' });
    expect((await api.http().get('/portal/vinculos').set(cab(p)).expect(200)).body).toEqual([]);
    await expect(
      api.db.db.transaction((tx) => tx.execute(sql`select app_set_portal_session(${p.contaId}::uuid, ${p.vinculoId}::uuid)`)),
    ).rejects.toHaveProperty('cause.code', '42501');
  });
});

describe('pedidos do titular (LGPD art. 18): registrados e visíveis só para a clínica certa', () => {
  it('portal abre; a clínica A vê e responde; a B não vê; recepção não lê; nada do texto na trilha', async () => {
    const p = await contaDe(adminA, pacA1);
    const aberto = await api.http().post('/portal/solicitacoes').set(cab(p)).send({ tipo: 'ver_dados', detalhe: DETALHE }).expect(201);
    const pedido = aberto.body as { id: string; protocolo: string; tipo: string; situacao: string; prazo: string; abertoEm: string };
    expect(pedido).toMatchObject({ tipo: 'acesso', situacao: 'aberto' });
    expect(pedido.protocolo).toMatch(/^\d{8}-[0-9A-F]{8}$/);
    expect(Date.parse(pedido.prazo) - Date.parse(pedido.abertoEm)).toBe(15 * 86_400_000);

    const listaA = await api.http().get('/clinica/portal/solicitacoes').set(cab(adminA)).expect(200);
    expect((listaA.body as { id: string }[]).map((x) => x.id)).toContain(pedido.id);
    expect(JSON.stringify(listaA.body)).not.toContain(DETALHE);
    const listaB = await api.http().get('/clinica/portal/solicitacoes').query({ situacao: 'todos' }).set(cab(adminB)).expect(200);
    expect((listaB.body as { id: string }[]).map((x) => x.id)).not.toContain(pedido.id);
    await api.http().get(`/clinica/portal/solicitacoes/${pedido.id}`).set(cab(adminB)).expect(404);
    await api.http().get(`/clinica/portal/solicitacoes/${pedido.id}`).set(cab(api.sessao(clinicaA, 'recepcao'))).expect(403);
    const det = await api.http().get(`/clinica/portal/solicitacoes/${pedido.id}`).set(cab(adminA)).expect(200);
    expect(det.body).toMatchObject({ pacienteId: pacA1, tipo: 'acesso', detalhe: DETALHE, situacao: 'aberta' });

    await api.http().post(`/clinica/portal/solicitacoes/${pedido.id}/situacao`).set(cab(adminB)).send({ situacao: 'atendida' }).expect(404);
    await api.http().post(`/clinica/portal/solicitacoes/${pedido.id}/situacao`).set(cab(adminA)).send({ situacao: 'em_andamento' }).expect(200);
    await api.http().post(`/clinica/portal/solicitacoes/${pedido.id}/situacao`).set(cab(adminA)).send({ situacao: 'atendida', resposta: RESPOSTA }).expect(200);
    expect((await api.http().post(`/clinica/portal/solicitacoes/${pedido.id}/situacao`).set(cab(adminA)).send({ situacao: 'recusada' })).body).toMatchObject({
      codigo: 'pedido_encerrado',
    });
    const meus = await api.http().get('/portal/solicitacoes').set(cab(p)).expect(200);
    expect(meus.body).toEqual([expect.objectContaining({ id: pedido.id, situacao: 'respondido', resposta: RESPOSTA })]);

    // O paciente A2 (mesma clínica) não vê o pedido do A1.
    const p2 = await contaDe(adminA, pacA2);
    expect((await api.http().get('/portal/solicitacoes').set(cab(p2)).expect(200)).body).toEqual([]);

    // Detalhe e resposta só cifrados no banco; nunca na trilha.
    const [linha] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(portalRightsRequests).where(eq(portalRightsRequests.id, pedido.id)));
    expect(linha?.detailEnc).toMatch(/^v1:/);
    expect(linha?.answerEnc).toMatch(/^v1:/);
    const trilha = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(auditLog).where(eq(auditLog.tenantId, clinicaA)));
    expect(JSON.stringify(trilha)).not.toContain(DETALHE);
    expect(JSON.stringify(trilha)).not.toContain(RESPOSTA);
  });

  it('o banco recusa: pedido aberto fora da sessão do portal e pedido mudado pelo portal', async () => {
    const p = await contaDe(adminA, pacA1);
    const aberto = (await api.http().post('/portal/solicitacoes').set(cab(p)).send({ tipo: 'eliminacao' }).expect(201)).body as { id: string };
    await expect(
      withTenant(api.db.db, clinicaA, (tx) =>
        tx.insert(portalRightsRequests).values({
          tenantId: clinicaA,
          patientId: pacA1,
          linkId: p.vinculoId,
          accountId: p.contaId,
          kind: 'acesso',
          actingAs: 'titular',
          protocol: '20310101-ABCDEF02',
        }),
      adminA.userId),
    ).rejects.toThrow();
    await expect(
      api.db.db.transaction(async (tx) => {
        await tx.execute(sql`select app_set_portal_session(${p.contaId}::uuid, ${p.vinculoId}::uuid)`);
        await tx.execute(sql`update portal_rights_requests set status = 'atendida', handled_at = now(), handled_by = ${p.contaId} where id = ${aberto.id}`);
      }),
    ).rejects.toThrow();
  });
});

describe('A3 do #68: resposta obrigatória, aviso à clínica e teto diário', () => {
  it('recusa/atendimento sem resposta = 400 (API) e recusado no banco; eliminação traz o texto-modelo da retenção', async () => {
    const p = await contaDe(adminA, pacA1);
    const { id } = (await api.http().post('/portal/solicitacoes').set(cab(p)).send({ tipo: 'apagar' }).expect(201)).body as { id: string };
    const sem = await api.http().post(`/clinica/portal/solicitacoes/${id}/situacao`).set(cab(adminA)).send({ situacao: 'recusada' }).expect(400);
    expect(sem.body).toMatchObject({ campos: ['resposta'] });
    await api.http().post(`/clinica/portal/solicitacoes/${id}/situacao`).set(cab(adminA)).send({ situacao: 'atendida' }).expect(400);
    const det = await api.http().get(`/clinica/portal/solicitacoes/${id}`).set(cab(adminA)).expect(200);
    expect((det.body as { modeloDeResposta: string }).modeloDeResposta).toMatch(/20 anos/);
    // Direto no banco (sem a API): estado final sem resposta é recusado.
    await expect(
      withTenant(api.db.db, clinicaA, (tx) => tx.update(portalRightsRequests).set({ status: 'recusada', handledBy: adminA.userId, handledAt: sql`now()` }).where(eq(portalRightsRequests.id, id)), adminA.userId),
    ).rejects.toThrow();
    await api.http().post(`/clinica/portal/solicitacoes/${id}/situacao`).set(cab(adminA)).send({ situacao: 'recusada', resposta: 'Resposta ficticia da recusa' }).expect(200);
  });

  it('pedido novo avisa os admins ativos da clínica (só o id do pedido); ninguém mais cria esse aviso', async () => {
    const p = await contaDe(adminA, pacA1);
    const { id } = (await api.http().post('/portal/solicitacoes').set(cab(p)).send({ tipo: 'acesso' }).expect(201)).body as { id: string };
    const fundador = api.fundador(clinicaA);
    const avisos = await withTenant(api.db.db, clinicaA, (tx) => tx.execute<{ recipient_user_id: string; kind: string; created_by: string }>(
      sql`select recipient_user_id, kind, created_by from clinical_notices where rights_request_id = ${id}::uuid`), fundador);
    expect(avisos).toEqual([{ recipient_user_id: fundador, kind: 'pedido_titular_aberto', created_by: '00000000-0000-0000-0000-000000000000' }]);
    const tok = api.sessoes.criarSessao({ tenantId: clinicaA, userId: fundador, perfis: ['admin'] });
    const caixa = await api.http().get('/avisos').set({ Authorization: `Bearer ${tok}` }).expect(200);
    expect(caixa.body).toEqual(expect.arrayContaining([expect.objectContaining({ tipo: 'pedido_titular_aberto', pedidoId: id })]));
    // Usuário da clínica e sessão do portal não fabricam o aviso.
    await expect(withTenant(api.db.db, clinicaA, (tx) => tx.execute(
      sql`insert into clinical_notices (tenant_id, recipient_user_id, kind, rights_request_id, created_by) values (${clinicaA}, ${fundador}, 'pedido_titular_aberto', ${id}, ${adminA.userId})`), adminA.userId)).rejects.toThrow();
    await expect(api.db.db.transaction(async (tx) => {
      await tx.execute(sql`select app_set_portal_session(${p.contaId}::uuid, ${p.vinculoId}::uuid)`);
      await tx.execute(sql`insert into clinical_notices (tenant_id, recipient_user_id, kind, rights_request_id, created_by) values (${clinicaA}, ${fundador}, 'pedido_titular_aberto', ${id}, '00000000-0000-0000-0000-000000000000')`);
    })).rejects.toThrow();
  });

  it('teto diário: 5 pedidos por vínculo em 24 h; o 6º = 429 e UM anomaly_alert; o banco confere o mesmo teto', async () => {
    const pac = await criarPaciente(adminA, 'Edu Ficticio Pedidos', { nascimento: '1979-07-07' });
    const p = await contaDe(adminA, pac);
    for (let i = 0; i < 5; i++) await api.http().post('/portal/solicitacoes').set(cab(p)).send({ tipo: 'acesso' }).expect(201);
    for (let i = 0; i < 2; i++) {
      const r = await api.http().post('/portal/solicitacoes').set(cab(p)).send({ tipo: 'acesso' });
      expect(r.status).toBe(429);
      expect(r.body).toMatchObject({ codigo: 'limite_diario_de_pedidos' });
    }
    const alertas = await withTenant(api.db.db, clinicaA, (tx) =>
      tx.select().from(auditLog).where(and(eq(auditLog.actorId, p.contaId), eq(auditLog.action, 'anomaly_alert'))).orderBy(sql`seq`), adminA.userId);
    expect(alertas.map((a) => a.metadata)).toEqual([{ rule: 'portal_teto_diario_pedidos', window_s: 86_400, threshold: 5, count: 6 }]);
    await expect(api.db.db.transaction(async (tx) => {
      await tx.execute(sql`select app_set_portal_session(${p.contaId}::uuid, ${p.vinculoId}::uuid)`);
      await tx.insert(portalRightsRequests).values({
        tenantId: clinicaA, patientId: pac, linkId: p.vinculoId, accountId: p.contaId, kind: 'acesso', actingAs: 'titular', protocol: '20310101-ABCDEF09',
      });
    })).rejects.toHaveProperty('cause.code', '54000');
  });
});

describe('central de privacidade: consentimento em histórico (IA em 3 estados)', () => {
  it('responder, desfazer e histórico; a clínica vê o estado da IA; nada é sobrescrito', async () => {
    const p = await contaDe(adminA, pacA1);
    const inicio = await api.http().get('/portal/privacidade/consentimentos').set(cab(p)).expect(200);
    expect(inicio.body).toEqual(expect.arrayContaining([expect.objectContaining({ finalidade: 'escriba_ia', resposta: 'nao_respondido', estadoIa: 'nao_informado' })]));
    await api.http().post('/portal/privacidade/consentimentos/escriba_ia').set(cab(p)).send({ resposta: 'nao' }).expect(200);
    const clin = await api.http().get(`/clinica/portal/pacientes/${pacA1}/consentimentos`).set(cab(adminA)).expect(200);
    expect(clin.body).toEqual(expect.arrayContaining([expect.objectContaining({ finalidade: 'escriba_ia', resposta: 'nao', estadoIa: 'recusou' })]));
    // A5 do #68: a fonte única que o gateway de IA consulta enxerga o "não" dado no portal.
    expect(await withTenant(api.db.db, clinicaA, (tx) => consentimentoIaDoPaciente(tx, clinicaA, pacA1), adminA.userId)).toBe('recusou');
    await api.http().post('/portal/privacidade/consentimentos/escriba_ia').set(cab(p)).send({ resposta: 'sim' }).expect(200);
    await api.http().post('/portal/privacidade/consentimentos/escriba_ia/desfazer').set(cab(p)).send({}).expect(200);
    const hist = await api.http().get('/portal/privacidade/consentimentos/escriba_ia/historico').set(cab(p)).expect(200);
    expect((hist.body as { resposta: string }[]).map((h) => h.resposta)).toEqual(['nao', 'sim', 'desfeito']);
    const fim = await api.http().get(`/clinica/portal/pacientes/${pacA1}/consentimentos`).set(cab(adminA)).expect(200);
    expect(fim.body).toEqual(expect.arrayContaining([expect.objectContaining({ finalidade: 'escriba_ia', resposta: 'nao_respondido', estadoIa: 'nao_informado' })]));
    expect((await api.http().post('/portal/privacidade/consentimentos/escriba_ia/desfazer').set(cab(p)).send({})).body).toMatchObject({ codigo: 'nada_a_desfazer' });
    await api.http().post('/portal/privacidade/consentimentos/outra_coisa').set(cab(p)).send({ resposta: 'sim' }).expect(400);
    // Append-only no banco, para qualquer papel.
    await expect(withTenant(api.db.db, clinicaA, (tx) => tx.update(portalConsents).set({ response: 'sim' }).where(eq(portalConsents.patientId, pacA1)), adminA.userId)).rejects.toThrow();
    // Texto apresentado registrado (versão + hash).
    const [ev] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(portalConsents).where(eq(portalConsents.patientId, pacA1)).limit(1));
    expect(ev?.textHash).toMatch(/^[0-9a-f]{64}$/);
    expect(ev?.channel).toBe('portal');
  });

  it('menor de idade: só o responsável legal responde consentimento (LGPD art. 14)', async () => {
    // V1 do #68: criança de 8 anos nem é convidada como titular; quem age é o responsável cadastrado (0028).
    const proprio = await api.http().post('/clinica/portal/convites').set(cab(adminA)).send({ pacienteId: pacMenor });
    expect(proprio.body).toMatchObject({ statusCode: 409, codigo: 'titular_menor_de_12' });
    const resp = await contaDe(adminA, pacMenor, { agindoComo: 'responsavel_legal', responsavelId: await responsavelDe(pacMenor, 'Gil Ficticio Pai') });
    await api.http().post('/portal/privacidade/consentimentos/lembretes_whatsapp').set(cab(resp)).send({ resposta: 'sim' }).expect(200);
    const hist = await api.http().get('/portal/privacidade/consentimentos/lembretes_whatsapp/historico').set(cab(resp)).expect(200);
    expect(hist.body).toEqual([expect.objectContaining({ resposta: 'sim', agindoComo: 'responsavel_legal' })]);
  });

  it('R3 do #68: convite de titular sem data de nascimento é recusado (409 nascimento_nao_informado)', async () => {
    const semNasc = await criarPaciente(adminA, 'Vera Ficticia Sem Nascimento');
    expect((await api.http().post('/clinica/portal/convites').set(cab(adminA)).send({ pacienteId: semNasc })).body).toMatchObject({
      statusCode: 409,
      codigo: 'nascimento_nao_informado',
    });
    const convites = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(portalInvites).where(eq(portalInvites.patientId, semNasc)), adminA.userId);
    expect(convites).toEqual([]);
  });

  it('A1 do #68: data de nascimento apagada depois do convite: quem age como titular NÃO consente (falha fechada) e nada é gravado', async () => {
    const pac = await criarPaciente(adminA, 'Xena Ficticia Cadastro Incompleto', { nascimento: '1980-01-02' });
    const semNasc = await contaDe(adminA, pac);
    await api.http().patch(`/pacientes/${pac}`).set(cab(adminA)).send({ nascimento: null }).expect(200);
    expect((await api.http().post('/portal/privacidade/consentimentos/escriba_ia').set(cab(semNasc)).send({ resposta: 'sim' })).body).toMatchObject({
      statusCode: 409,
      codigo: 'nascimento_nao_informado',
    });
    const hist = await api.http().get('/portal/privacidade/consentimentos/escriba_ia/historico').set(cab(semNasc)).expect(200);
    expect(hist.body).toEqual([]);
  });
});

describe('defesa no banco: sessão do portal só vê o próprio paciente', () => {
  it('patients/appointments/recibos só do titular; prontuário e convites: nenhuma linha; escrita alheia recusada', async () => {
    const p = await contaDe(adminA, pacA1);
    const r = await api.db.db.transaction(async (tx) => {
      await tx.execute(sql`select app_set_portal_session(${p.contaId}::uuid, ${p.vinculoId}::uuid)`);
      const pacs = await tx.select({ id: patients.id }).from(patients);
      const ags = await tx.execute<{ patient_id: string }>(sql`select patient_id from appointments`);
      const recs = await tx.execute<{ n: number }>(sql`select count(*)::int as n from receipts`);
      const ats = await tx.select({ id: encounters.id }).from(encounters);
      const convites = await tx.select({ id: portalInvites.id }).from(portalInvites);
      const vinc = await tx.select({ conta: portalLinks.accountId }).from(portalLinks);
      const outro = await tx.execute(sql`update appointments set status = 'confirmed' where id = ${ag.a2} returning id`);
      return { pacs, ags, recs, ats, convites, vinc, outro };
    });
    expect(r.pacs.map((x) => x.id)).toEqual([pacA1]);
    expect(new Set(r.ags.map((x) => x.patient_id))).toEqual(new Set([pacA1]));
    expect(r.recs[0]?.n).toBe(1);
    expect(r.ats).toEqual([]);
    expect(r.convites).toEqual([]);
    expect(new Set(r.vinc.map((v) => v.conta))).toEqual(new Set([p.contaId]));
    expect(r.outro).toHaveLength(0);
    // Inserir agendamento ou remarcar pelo portal: recusado pelo gatilho.
    await expect(
      api.db.db.transaction(async (tx) => {
        await tx.execute(sql`select app_set_portal_session(${p.contaId}::uuid, ${p.vinculoId}::uuid)`);
        await tx.execute(sql`update appointments set starts_at = starts_at + interval '1 day', ends_at = ends_at + interval '1 day' where id = ${ag.a1z}`);
      }),
    ).rejects.toThrow();
    // Sessão do portal não se mistura com a da clínica nem troca de vínculo na mesma transação.
    await expect(
      api.db.db.transaction(async (tx) => {
        await tx.execute(sql`select app_set_portal_session(${p.contaId}::uuid, ${p.vinculoId}::uuid)`);
        await tx.execute(sql`select app_set_user(${adminA.userId}::uuid)`);
      }),
    ).rejects.toThrow();
    // Vínculo de outra conta: recusado.
    await expect(
      api.db.db.transaction((tx) => tx.execute(sql`select app_set_portal_session(${randomUUID()}::uuid, ${p.vinculoId}::uuid)`)),
    ).rejects.toThrow();
    // Fora do portal (clínica), as policies restritivas não mudam nada.
    const naClinica = await withTenant(api.db.db, clinicaA, (tx) => tx.select({ id: patients.id }).from(patients), adminA.userId);
    expect(naClinica.length).toBeGreaterThanOrEqual(3);
  });
});

describe('V2 do #68: SQL arbitrário na sessão do portal não lê a trilha nem mexe em chave', () => {
  /** Roda `fn` numa transação do portal e devolve o código Postgres do erro (ou 'ok'). Sempre desfaz. */
  async function noPortal(p: { contaId: string; vinculoId: string }, fn: (tx: Parameters<Parameters<typeof api.db.db.transaction>[0]>[0]) => Promise<unknown>) {
    try {
      await api.db.db.transaction(async (tx) => {
        await tx.execute(sql`select app_set_portal_session(${p.contaId}::uuid, ${p.vinculoId}::uuid)`);
        await fn(tx);
        throw new Error('desfazer');
      });
      return 'ok';
    } catch (e) {
      for (let x: unknown = e; x instanceof Error; x = x.cause) {
        const c = (x as { code?: unknown }).code;
        if (typeof c === 'string') return c;
      }
      return (e as Error).message === 'desfazer' ? 'ok' : String(e);
    }
  }

  it('audit_log: zero linhas na sessão do portal (nem as do próprio paciente); a função do último elo não responde fora do gatilho', async () => {
    const p = await contaDe(adminA, pacA1);
    await api.http().get('/portal/consultas').set(cab(p)).expect(200);
    const r = await api.db.db.transaction(async (tx) => {
      await tx.execute(sql`select app_set_portal_session(${p.contaId}::uuid, ${p.vinculoId}::uuid)`);
      const todas = await tx.execute<{ n: number }>(sql`select count(*)::int as n from audit_log`);
      const outros = await tx.execute<{ n: number }>(sql`select count(*)::int as n from audit_log where metadata->>'patient_id' is distinct from ${pacA1}`);
      const elo = await tx.execute(sql`select * from app_audit_chain_tail(${clinicaA}::uuid) where seq is not null`);
      const outraClinica = await tx.execute(sql`select * from app_audit_chain_tail(${clinicaB}::uuid) where seq is not null`);
      return { todas: todas[0]?.n, outros: outros[0]?.n, elo, outraClinica };
    });
    expect(r).toEqual({ todas: 0, outros: 0, elo: [], outraClinica: [] });
    // Fora do portal a clínica continua lendo a trilha, e a cadeia (com os elos gravados pelo portal) fecha.
    const naClinica = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(auditLog).where(eq(auditLog.actorId, p.contaId)), adminA.userId);
    expect(naClinica.length).toBeGreaterThanOrEqual(2);
    const cadeia = await withTenant(api.db.db, clinicaA, (tx) => verifyAuditChain(tx, clinicaA), adminA.userId);
    expect(cadeia.problems).toEqual([]);
    expect(cadeia.ok).toBe(true);
  });

  it('chaves de dados: INSERT e UPDATE recusados (42501); só o contador de uso da DEK cresce, em lote limitado', async () => {
    const p = await contaDe(adminA, pacA1);
    const [dek] = await withTenant(api.db.db, clinicaA, (tx) => tx.execute<{ id: string; master_key_id: string }>(
      sql`select id, master_key_id from tenant_data_keys where tenant_id = ${clinicaA} and status = 'active'`), adminA.userId);
    expect(dek?.id).toBeTruthy();
    expect(await noPortal(p, (tx) => tx.execute(sql`insert into tenant_master_keys (id, tenant_id) values (${`local:portal-${randomUUID()}`}, ${clinicaA})`))).toBe('42501');
    expect(await noPortal(p, (tx) => tx.execute(sql`insert into tenant_data_keys (tenant_id, master_key_id, wrapped_key) values (${clinicaA}, ${dek?.master_key_id}, ${'x'.repeat(60)})`))).toBe('42501');
    expect(await noPortal(p, (tx) => tx.execute(sql`update tenant_data_keys set status = 'retired', retired_at = now() where id = ${dek?.id}::uuid`))).toBe('42501');
    expect(await noPortal(p, (tx) => tx.execute(sql`update tenant_data_keys set wrapped_key = wrapped_key where id = ${dek?.id}::uuid`))).toBe('42501');
    expect(await noPortal(p, (tx) => tx.execute(sql`update tenant_master_keys set status = 'retired' where tenant_id = ${clinicaA}`))).toBe('42501');
    expect(await noPortal(p, (tx) => tx.execute(sql`update tenant_data_keys set encrypt_count = encrypt_count + 100000 where id = ${dek?.id}::uuid`))).toBe('42501');
    expect(await noPortal(p, (tx) => tx.execute(sql`update tenant_data_keys set encrypt_count = encrypt_count - 1 where id = ${dek?.id}::uuid`))).toBe('42501');
    // O que a cifragem faz (somar o uso em lote) continua permitido; ler a chave também (decifrar o próprio dado).
    expect(await noPortal(p, (tx) => tx.execute(sql`update tenant_data_keys set encrypt_count = encrypt_count + 3 where id = ${dek?.id}::uuid`))).toBe('ok');
    expect(await noPortal(p, async (tx) => {
      const r = await tx.execute(sql`select id from tenant_data_keys where id = ${dek?.id}::uuid`);
      if (r.length !== 1) throw new Error('chave invisível');
    })).toBe('ok');
    // E o portal continua cifrando (pedido com detalhe) com a chave já provisionada pela clínica.
    await api.http().post('/portal/solicitacoes').set(cab(p)).send({ tipo: 'acesso', detalhe: 'Pedido ficticio V2' }).expect(201);
  });
});

describe('V1 do #68: responsável legal só para menor (ou curatela), ligado ao responsável da 0028', () => {
  it('convite: adulto, sem responsável, criança/adolescente como titular e emancipado são recusados (API e banco)', async () => {
    const respAdulto = await responsavelDe(pacA1, 'Hugo Ficticio Parente', { cienciaDoPaciente: true, confirmaPacienteMaior: true });
    expect((await api.http().post('/clinica/portal/convites').set(cab(adminA)).send({ pacienteId: pacA1, agindoComo: 'responsavel_legal', responsavelId: respAdulto })).body)
      .toMatchObject({ statusCode: 409, codigo: 'responsavel_so_para_menor' });
    await api.http().post('/clinica/portal/convites').set(cab(adminA)).send({ pacienteId: pacMenor, agindoComo: 'responsavel_legal' }).expect(400);
    // Responsável de OUTRO paciente não serve (404).
    await api.http().post('/clinica/portal/convites').set(cab(adminA)).send({ pacienteId: pacMenor, agindoComo: 'responsavel_legal', responsavelId: respAdulto }).expect(404);
    const teen = await criarPaciente(adminA, 'Iara Ficticia Adolescente', { nascimento: nascidoHa(15) });
    expect((await api.http().post('/clinica/portal/convites').set(cab(adminA)).send({ pacienteId: teen })).body).toMatchObject({ codigo: 'titular_adolescente_requer_decisao' });
    // Emancipado (16+): responsável deixa de valer.
    const eman = await criarPaciente(adminA, 'Joao Ficticio Emancipado', { nascimento: nascidoHa(17) });
    const respEman = await responsavelDe(eman, 'Kelly Ficticia Mae');
    await api.http().post(`/pacientes/${eman}/responsaveis/emancipacao`).set(cab(adminA)).send({ data: hojeNaClinica(), documento: 'Escritura ficticia 001' }).expect(200);
    expect((await api.http().post('/clinica/portal/convites').set(cab(adminA)).send({ pacienteId: eman, agindoComo: 'responsavel_legal', responsavelId: respEman })).status).toBe(409);
    // Direto no banco: responsável sem vínculo da 0028, ou sem fim da representação = recusado.
    const respTeen = await responsavelDe(teen, 'Leo Ficticio Pai');
    const [g] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(patientGuardians).where(eq(patientGuardians.id, respTeen)), adminA.userId);
    const base = { tenantId: clinicaA, patientId: teen, actingAs: 'responsavel_legal' as const, expiresAt: sql`now() + interval '1 day'`, createdBy: adminA.userId };
    await expect(withTenant(api.db.db, clinicaA, (tx) => tx.insert(portalInvites).values({ ...base, tokenHash: 'd'.repeat(64) }), adminA.userId)).rejects.toThrow();
    await expect(withTenant(api.db.db, clinicaA, (tx) => tx.insert(portalInvites).values({
      ...base, tokenHash: 'e'.repeat(64), guardianLinkId: respTeen, guardianId: g?.guardianId as string,
    }), adminA.userId)).rejects.toThrow();
    await expect(withTenant(api.db.db, clinicaA, (tx) => tx.insert(portalInvites).values({
      ...base, patientId: eman, tokenHash: 'f'.repeat(64), guardianLinkId: respEman, guardianId: g?.guardianId as string, representUntil: nascidoHa(-1),
    }), adminA.userId)).rejects.toThrow();
  });

  it('0055 (A3 do #67): apoiador de decisão apoiada não representa no portal (API 409 e banco recusa)', async () => {
    const adulto = await criarPaciente(adminA, 'Rita Ficticia Apoiada', { nascimento: nascidoHa(35) });
    const apoiador = await responsavelDe(adulto, 'Davi Ficticio Apoiador', {
      tipo: 'apoiador',
      apoioReferencia: 'Termo ficticio de decisao apoiada QZA0068',
      apoioEscopo: 'Apoio em decisoes de saude e contratos (ficticio)',
    });
    expect((await api.http().post('/clinica/portal/convites').set(cab(adminA)).send({ pacienteId: adulto, agindoComo: 'responsavel_legal', responsavelId: apoiador })).body)
      .toMatchObject({ statusCode: 409, codigo: 'apoiador_nao_representa' });
    // Direto no banco, até com uma data de representação coerente: o gatilho da 0055 recusa pelo tipo do vínculo.
    const [g] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(patientGuardians).where(eq(patientGuardians.id, apoiador)), adminA.userId);
    const erro = await withTenant(api.db.db, clinicaA, (tx) => tx.insert(portalInvites).values({
      tenantId: clinicaA, patientId: adulto, actingAs: 'responsavel_legal', expiresAt: sql`now() + interval '1 day'`, createdBy: adminA.userId,
      tokenHash: 'a5'.repeat(32), guardianLinkId: apoiador, guardianId: g?.guardianId as string, confidentialFrom: hojeNaClinica(), representUntil: nascidoHa(-1),
    }), adminA.userId).then(() => null, (e: unknown) => e);
    const e = erro as { message?: string; cause?: { message?: string } } | null;
    expect(e, 'o banco aceitou convite de apoiador').not.toBeNull();
    expect(`${e?.message ?? ''} ${e?.cause?.message ?? ''}`).toMatch(/apoiador/);
  });

  it('o código vai ao telefone DO RESPONSÁVEL; vínculo, consentimento, pedido e trilha registram qual responsável agiu', async () => {
    const menor = await criarPaciente(adminA, 'Mia Ficticia Menor', { nascimento: nascidoHa(10) });
    const pai = await responsavelDe(menor, 'Nilo Ficticio Pai', { telefone: '11900003333' });
    const mae = await responsavelDe(menor, 'Olga Ficticia Mae');
    // Código para o telefone do pai (não o do paciente).
    const p = api.sessaoPortal();
    const { token } = await convidar(adminA, menor, { agindoComo: 'responsavel_legal', responsavelId: pai });
    await api.http().post('/portal/convites/resgate').set(cab(p)).send({ token }).expect(200);
    const codigo = api.otp.ultimoCodigo('11900003333') as string;
    const vPai = (await api.http().post('/portal/convites/resgate/confirmar').set(cab(p)).send({ token, codigo }).expect(200)).body as { vinculoId: string };
    const contaMae = await contaDe(adminA, menor, { agindoComo: 'responsavel_legal', responsavelId: mae });
    await api.http().post('/portal/privacidade/consentimentos/pesquisa').set(cab(p)).send({ resposta: 'sim' }).expect(200);
    await api.http().post('/portal/privacidade/consentimentos/pesquisa').set(cab(contaMae)).send({ resposta: 'nao' }).expect(200);
    await api.http().post('/portal/solicitacoes').set(cab(contaMae)).send({ tipo: 'acesso' }).expect(201);
    const [gPai] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(patientGuardians).where(eq(patientGuardians.id, pai)), adminA.userId);
    const [gMae] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(patientGuardians).where(eq(patientGuardians.id, mae)), adminA.userId);
    const r = await withTenant(api.db.db, clinicaA, async (tx) => ({
      link: (await tx.select().from(portalLinks).where(eq(portalLinks.id, vPai.vinculoId)))[0],
      consents: await tx.select().from(portalConsents).where(eq(portalConsents.patientId, menor)).orderBy(portalConsents.createdAt),
      pedidos: await tx.select().from(portalRightsRequests).where(eq(portalRightsRequests.patientId, menor)),
      trilha: await tx.select().from(auditLog).where(and(eq(auditLog.actorId, contaMae.contaId), eq(auditLog.scope, 'portal_consents'))).orderBy(sql`seq`),
    }), adminA.userId);
    expect(r.link).toMatchObject({ guardianLinkId: pai, guardianId: gPai?.guardianId, representUntil: nascidoHa(-8) });
    expect(r.consents.map((c) => [c.response, c.guardianId])).toEqual([['sim', gPai?.guardianId], ['nao', gMae?.guardianId]]);
    expect(r.pedidos.map((x) => x.guardianId)).toEqual([gMae?.guardianId]);
    expect(r.trilha[0]?.metadata).toMatchObject({ guardian_id: gMae?.guardianId });
  });

  it('fim da vigência do responsável (0028) ou emancipação: acesso cai na hora; o job registra a revogação', async () => {
    const menor = await criarPaciente(adminA, 'Pedro Ficticio Menor', { nascimento: nascidoHa(16) });
    const resp = await responsavelDe(menor, 'Quiteria Ficticia Tutora', { tipo: 'tutor' });
    const conta = await contaDe(adminA, menor, { agindoComo: 'responsavel_legal', responsavelId: resp });
    await api.http().get('/portal/consultas').set(cab(conta)).expect(200);
    await api.http().post(`/pacientes/${menor}/responsaveis/emancipacao`).set(cab(adminA)).send({ data: hojeNaClinica(), documento: 'Escritura ficticia 002' }).expect(200);
    expect((await api.http().get('/portal/consultas').set(cab(conta))).body).toMatchObject({ statusCode: 403, codigo: 'vinculo_inativo' });
    expect(await api.app.get(PortalClinicaService).encerrarRepresentacoesVencidas()).toBeGreaterThanOrEqual(1);
    const lista = (await api.http().get(`/clinica/portal/pacientes/${menor}/vinculos`).set(cab(adminA)).expect(200)).body as { id: string; motivo: string; responsavelId: string }[];
    expect(lista).toEqual([expect.objectContaining({ id: conta.vinculoId, motivo: 'fim_da_representacao', responsavelId: resp })]);
    const trilha = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.actorKind, 'sistema'), eq(auditLog.scope, 'portal_links'))), adminA.userId);
    expect(trilha.map((t) => t.metadata)).toEqual(expect.arrayContaining([expect.objectContaining({ link_id: conta.vinculoId, reason: 'fim_da_representacao' })]));
    // A clínica não usa os motivos do sistema.
    await api.http().post(`/clinica/portal/vinculos/${conta.vinculoId}/revogar`).set(cab(adminA)).send({ motivo: 'maioridade_do_titular' }).expect(400);
  });

  it('C3/A1: responsável vê agenda, financeiro e cadastro; nada clínico, nem com a marca de informação clínica ligada; adolescente sem psicologia', async () => {
    const teen = await criarPaciente(adminA, 'Rita Ficticia Adolescente', { nascimento: nascidoHa(14) });
    const crianca = await criarPaciente(adminA, 'Sami Ficticio Crianca', { nascimento: nascidoHa(9) });
    // Psicóloga com usuário e vínculo de cuidado: liga a marca da 0031 (decisão do profissional).
    const psi = api.sessao(clinicaA, 'profissional');
    await api.membro(clinicaA, psi, 'profissional');
    const profPsi = (await api.http().post('/profissionais').set(cab(adminA)).send({ nome: 'Psi Ficticia', especialidade: 'Psicologia', usuarioId: psi.userId }).expect(201)).body as { id: string };
    const [base] = await withTenant(api.db.db, clinicaA, (tx) => tx.execute<{ professional_id: string; appointment_type_id: string }>(
      sql`select professional_id, appointment_type_id from appointments where id = ${ag.a1z}`), adminA.userId);
    const consulta = async (pac: string, prof: string, horas: number) => {
      const id = randomUUID();
      const ini = new Date(Date.now() + horas * 3_600_000);
      await withTenant(api.db.db, clinicaA, (tx) => tx.insert(appointments).values({
        id, tenantId: clinicaA, createdBy: adminA.userId, patientId: pac, professionalId: prof, appointmentTypeId: base?.appointment_type_id as string,
        startsAt: ini, endsAt: new Date(ini.getTime() + 30 * 60_000), status: 'confirmed',
      }), adminA.userId);
      return id;
    };
    const psiTeen = await consulta(teen, profPsi.id, 1);
    const fisioTeen = await consulta(teen, base?.professional_id as string, 30);
    const psiCrianca = await consulta(crianca, profPsi.id, 2);
    const respTeen = await responsavelDe(teen, 'Tais Ficticia Mae');
    const marca = await api.http().patch(`/pacientes/${teen}/responsaveis/${respTeen}`).set(cab(psi))
      .send({ recebeInformacaoClinica: true, justificativa: 'Avaliacao ficticia: compartilhar o essencial' });
    expect(marca.status, JSON.stringify(marca.body)).toBe(200);
    expect((marca.body as { informacaoClinica: { permitida: boolean } }).informacaoClinica.permitida).toBe(true);
    const conta = await contaDe(adminA, teen, { agindoComo: 'responsavel_legal', responsavelId: respTeen });
    const lista = ((await api.http().get('/portal/consultas').set(cab(conta)).expect(200)).body as { id: string }[]).map((c) => c.id);
    expect(lista).toContain(fisioTeen);
    expect(lista).not.toContain(psiTeen);
    await api.http().post(`/portal/consultas/${psiTeen}/confirmar`).set(cab(conta)).send({}).expect(404);
    for (const rota of ['/portal/prontuario', '/portal/atendimentos', '/portal/evolucoes', '/portal/informacao-clinica']) await api.http().get(rota).set(cab(conta)).expect(404);
    expect((await api.http().get('/portal/documentos').set(cab(conta)).expect(200)).body).toEqual({ itens: [], disponivel: false });
    await api.http().get('/portal/recibos').set(cab(conta)).expect(200);
    await api.http().get('/portal/meus-dados').set(cab(conta)).expect(200);
    // No banco, a sessão do responsável não vê prontuário nem a tabela da marca (0028/0031).
    const noBanco = await api.db.db.transaction(async (tx) => {
      await tx.execute(sql`select app_set_portal_session(${conta.contaId}::uuid, ${conta.vinculoId}::uuid)`);
      return {
        ats: await tx.select({ id: encounters.id }).from(encounters),
        marcas: await tx.select({ id: patientGuardians.id }).from(patientGuardians),
        // Sigilo também no banco: com SQL arbitrário, a consulta de área sensível do adolescente não aparece
        // (nem para ler, nem para mudar); a de fisioterapia aparece.
        consultas: (await tx.execute<{ id: string }>(sql`select id from appointments`)).map((x) => x.id),
        mudou: (await tx.execute(sql`update appointments set status = 'scheduled' where id = ${psiTeen} returning id`)).length,
      };
    });
    expect(noBanco).toEqual({ ats: [], marcas: [], consultas: [fisioTeen], mudou: 0 });
    const [linkTeen] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(portalLinks).where(eq(portalLinks.id, conta.vinculoId)), adminA.userId);
    expect(linkTeen?.confidentialFrom).toBe(nascidoHa(14 - 12));
    // A clínica (fora do portal) continua vendo tudo.
    const naClinica = await withTenant(api.db.db, clinicaA, (tx) => tx.select({ id: appointments.id }).from(appointments).where(eq(appointments.patientId, teen)), adminA.userId);
    expect(new Set(naClinica.map((x) => x.id))).toEqual(new Set([psiTeen, fisioTeen]));
    // Criança: a agenda inteira aparece para o responsável (sigilo por padrão vale a partir dos 12).
    const contaCrianca = await contaDe(adminA, crianca, { agindoComo: 'responsavel_legal', responsavelId: await responsavelDe(crianca, 'Ugo Ficticio Pai') });
    expect(((await api.http().get('/portal/consultas').set(cab(contaCrianca)).expect(200)).body as { id: string }[]).map((c) => c.id)).toContain(psiCrianca);
    const noBancoCrianca = await api.db.db.transaction(async (tx) => {
      await tx.execute(sql`select app_set_portal_session(${contaCrianca.contaId}::uuid, ${contaCrianca.vinculoId}::uuid)`);
      return (await tx.execute<{ id: string }>(sql`select id from appointments`)).map((x) => x.id);
    });
    expect(noBancoCrianca).toEqual([psiCrianca]);
  });

  it('R4: curatela encerrada = o consentimento dado pelo curador deixa de valer na hora; o job registra a expiração', async () => {
    const adulto = await criarPaciente(adminA, 'Edu Ficticio Curatelado', { nascimento: '1970-04-05' });
    const curador = await responsavelDe(adulto, 'Fabio Ficticio Curador', {
      tipo: 'curador',
      curatelaReferencia: 'Processo ficticio de curatela QZC0068',
      curatelaEscopo: 'Atos patrimoniais e negociais (ficticio)',
    });
    const conta = await contaDe(adminA, adulto, { agindoComo: 'responsavel_legal', responsavelId: curador });
    await api.http().post('/portal/privacidade/consentimentos/escriba_ia').set(cab(conta)).send({ resposta: 'sim' }).expect(200);
    const estado = async () => ({
      clinica: ((await api.http().get(`/clinica/portal/pacientes/${adulto}/consentimentos`).set(cab(adminA)).expect(200)).body as { finalidade: string; resposta: string }[])
        .find((c) => c.finalidade === 'escriba_ia')?.resposta,
      ia: await withTenant(api.db.db, clinicaA, (tx) => consentimentoIaDoPaciente(tx, clinicaA, adulto), adminA.userId),
    });
    expect(await estado()).toEqual({ clinica: 'sim', ia: 'informado_nao_recusou' });
    const [ev] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(portalConsents).where(eq(portalConsents.patientId, adulto)), adminA.userId);
    expect(ev).toMatchObject({ guardianLinkId: curador, representationEndedAt: null });
    // Curatela levantada (vínculo da 0028 encerrado): o "sim" do curador deixa de valer JÁ, antes do job.
    await api.http().post(`/pacientes/${adulto}/responsaveis/${curador}/encerrar`).set(cab(adminA)).send({ motivo: 'decisao_judicial' }).expect(200);
    expect(await estado()).toEqual({ clinica: 'nao_respondido', ia: 'nao_informado' });
    // O job marca o evento (uma vez) e deixa trilha do sistema.
    expect(await api.app.get(PortalClinicaService).expirarConsentimentosDeResponsavel()).toBeGreaterThanOrEqual(1);
    expect(await api.app.get(PortalClinicaService).expirarConsentimentosDeResponsavel()).toBe(0);
    const [depois] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(portalConsents).where(eq(portalConsents.id, ev?.id as string)), adminA.userId);
    expect(depois?.representationEndedAt).toBeInstanceOf(Date);
    const trilha = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.actorKind, 'sistema'), eq(auditLog.scope, 'portal_consents'))), adminA.userId);
    expect(trilha.map((t) => t.metadata)).toEqual(expect.arrayContaining([expect.objectContaining({ op: 'guardian_consent_expired', consent_id: ev?.id, guardian_link_id: curador })]));
    // Ninguém além do job mexe no evento (append-only): UPDATE pelo runtime é recusado.
    await expect(withTenant(api.db.db, clinicaA, (tx) => tx.update(portalConsents).set({ representationEndedAt: null }).where(eq(portalConsents.id, ev?.id as string)), adminA.userId)).rejects.toThrow();
  });

  it('R1: recibo de área sensível do adolescente sem profissional, especialidade e data para o responsável que NÃO é o pagador', async () => {
    const teen = await criarPaciente(adminA, 'Zara Ficticia Adolescente', { nascimento: nascidoHa(15) });
    const crianca = await criarPaciente(adminA, 'Abel Ficticio Crianca', { nascimento: nascidoHa(8) });
    const psi = (await api.http().post('/profissionais').set(cab(adminA)).send({ nome: 'Dra Psi Recibo Ficticia', especialidade: 'Clinica', areaSensivel: true }).expect(201)).body as { id: string };
    const [base] = await withTenant(api.db.db, clinicaA, (tx) => tx.execute<{ professional_id: string; appointment_type_id: string }>(
      sql`select professional_id, appointment_type_id from appointments where id = ${ag.a1z}`), adminA.userId);
    const tipo = base?.appointment_type_id as string;
    const pagador = await responsavelDe(teen, 'Bia Ficticia Mae Pagadora', { pagador: true });
    const outro = await responsavelDe(teen, 'Caco Ficticio Pai');
    const recPsi = await recibo(adminA, await agendar(adminA, teen, psi.id, tipo, '2027-03-03', '09:00'));
    const recFisio = await recibo(adminA, await agendar(adminA, teen, base?.professional_id as string, tipo, '2027-03-03', '11:00'));
    const respCrianca = await responsavelDe(crianca, 'Dora Ficticia Mae');
    const recPsiCrianca = await recibo(adminA, await agendar(adminA, crianca, psi.id, tipo, '2027-03-04', '09:00'));
    const contaPagador = await contaDe(adminA, teen, { agindoComo: 'responsavel_legal', responsavelId: pagador });
    const contaOutro = await contaDe(adminA, teen, { agindoComo: 'responsavel_legal', responsavelId: outro });
    const contaCrianca = await contaDe(adminA, crianca, { agindoComo: 'responsavel_legal', responsavelId: respCrianca });
    type Item = { id: string; data: string };
    const lista = async (c: SessaoPortal) => (await api.http().get('/portal/recibos').set(cab(c)).expect(200)).body as Item[];
    const doc = async (c: SessaoPortal, id: string) =>
      (await api.http().get(`/portal/recibos/${id}`).set(cab(c)).expect(200)).body as { dataPagamento: string; valorCentavos: number; restrito?: unknown };
    // N1 (conferência de 22/10): para o responsável que NÃO pagou, o recibo de psicologia NÃO aparece (nem
    // "restrito") e o detalhe é 404; o de fisioterapia aparece inteiro.
    const doOutro = await lista(contaOutro);
    expect(doOutro.map((r) => r.id)).not.toContain(recPsi);
    const fisio = doOutro.find((r) => r.id === recFisio);
    expect(fisio?.data).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(JSON.stringify(doOutro)).not.toContain('restrito');
    await api.http().get(`/portal/recibos/${recPsi}`).set(cab(contaOutro)).expect(404);
    // Responsável pagador (congelado no recebimento, 0031): o recibo é dele, inteiro.
    const doPagador = (await lista(contaPagador)).find((r) => r.id === recPsi);
    expect(doPagador?.data).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const inteiro = await doc(contaPagador, recPsi);
    expect(inteiro.dataPagamento).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(inteiro.restrito).toBeUndefined();
    // Criança: aparece.
    expect((await lista(contaCrianca)).map((r) => r.id)).toContain(recPsiCrianca);

    // N2 (conferência de 22/10): com SQL ARBITRÁRIO na sessão do portal, nada de psicologia do adolescente
    // por charges/payments/receipts/receipt_cancellations (JOIN com a marca do profissional) para quem não
    // pagou; o pagador congelado vê; o responsável da criança vê; a clínica vê tudo.
    const sensivelNoBanco = async (c: SessaoPortal & { vinculoId: string }) =>
      api.db.db.transaction(async (tx) => {
        await tx.execute(sql`select app_set_portal_session(${c.contaId}::uuid, ${c.vinculoId}::uuid)`);
        const linhas = async (q: ReturnType<typeof sql>) => (await tx.execute<{ id: string }>(q)).map((x) => x.id);
        return {
          cobrancas: await linhas(sql`select c.id from charges c
              left join appointments a on a.tenant_id = c.tenant_id and a.id = c.appointment_id
              join professionals pr on pr.tenant_id = c.tenant_id and pr.id = coalesce(c.professional_id, a.professional_id)
             where pr.sensitive_area`),
          cobrancasDoProf: await linhas(sql`select c.id from charges c where c.professional_id = ${psi.id}::uuid`),
          recebimentos: await linhas(sql`select p.id from payments p join charges c on c.tenant_id = p.tenant_id and c.id = p.charge_id
             where c.professional_id = ${psi.id}::uuid`),
          recibos: await linhas(sql`select r.id from receipts r where r.id = ${recPsi}::uuid`),
          cancelamentos: await linhas(sql`select rc.id from receipt_cancellations rc where rc.receipt_id = ${recPsi}::uuid`),
          // Cobrança de área sensível: invisível também para UPDATE (0 linhas; o portal não escreve, a 0027 já barra).
          mudou: (await tx.execute(sql`select id from charges where professional_id = ${psi.id}::uuid for update`)).length,
        };
      });
    const outroNoBanco = await sensivelNoBanco(contaOutro);
    expect(outroNoBanco).toEqual({ cobrancas: [], cobrancasDoProf: [], recebimentos: [], recibos: [], cancelamentos: [], mudou: 0 });
    const pagadorNoBanco = await sensivelNoBanco(contaPagador);
    expect(pagadorNoBanco.cobrancasDoProf.length).toBeGreaterThanOrEqual(1);
    expect(pagadorNoBanco.recebimentos.length).toBeGreaterThanOrEqual(1);
    expect(pagadorNoBanco.recibos).toEqual([recPsi]);
    // O responsável que não pagou continua vendo o que não é sensível (fisioterapia) pelo banco.
    const fisioNoBanco = await api.db.db.transaction(async (tx) => {
      await tx.execute(sql`select app_set_portal_session(${contaOutro.contaId}::uuid, ${contaOutro.vinculoId}::uuid)`);
      return (await tx.execute<{ id: string }>(sql`select id from receipts where id = ${recFisio}::uuid`)).map((x) => x.id);
    });
    expect(fisioNoBanco).toEqual([recFisio]);
    const criancaNoBanco = await api.db.db.transaction(async (tx) => {
      await tx.execute(sql`select app_set_portal_session(${contaCrianca.contaId}::uuid, ${contaCrianca.vinculoId}::uuid)`);
      return (await tx.execute<{ id: string }>(sql`select id from receipts where id = ${recPsiCrianca}::uuid`)).map((x) => x.id);
    });
    expect(criancaNoBanco).toEqual([recPsiCrianca]);
    const naClinica = await withTenant(api.db.db, clinicaA, (tx) => tx.execute<{ id: string }>(sql`select id from receipts where id = ${recPsi}::uuid`), adminA.userId);
    expect(naClinica.map((x) => x.id)).toEqual([recPsi]);
  });

  it('R3 do #73: reescrever birth_date_enc com a MESMA data (pela API ou numa recifração/rotação de chave) não encerra a representação', async () => {
    const pac = await criarPaciente(adminA, 'Tito Ficticio Recifra', { nascimento: nascidoHa(14) });
    const resp = await responsavelDe(pac, 'Vera Ficticia Mae Recifra');
    const conta = await contaDe(adminA, pac, { agindoComo: 'responsavel_legal', responsavelId: resp });
    const vinculo = async () =>
      (await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(portalLinks).where(eq(portalLinks.id, conta.vinculoId)), adminA.userId))[0];
    const recalculos = async () =>
      (await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.scope, 'portal_links'), sql`${auditLog.metadata}->>'patient_id' = ${pac}`, sql`${auditLog.metadata}->>'op' = 'confidentiality_recalculated'`)), adminA.userId)).length;
    const original = { confidentialFrom: nascidoHa(14 - 12), representUntil: nascidoHa(14 - 18), revokedAt: null };
    const cifraAntes = async () =>
      (await withTenant(api.db.db, clinicaA, (tx) => tx.select({ enc: patients.birthDateEnc }).from(patients).where(eq(patients.id, pac)), adminA.userId))[0]?.enc;
    const enc0 = await cifraAntes();
    // Pela API, a mesma data: o serviço compara com a data decifrada e NÃO reescreve a coluna (nem recalcula).
    await api.http().patch(`/pacientes/${pac}`).set(cab(adminA)).send({ nascimento: nascidoHa(14) }).expect(200);
    expect(await cifraAntes()).toBe(enc0);
    expect(await vinculo()).toMatchObject(original);
    expect(await recalculos()).toBe(0);
    // Recifração (como faria um job de rotação de chave): cifra NOVA da mesma data + recálculo com as mesmas
    // datas na mesma transação. Nada muda, nada fecha no COMMIT, nenhuma trilha de recálculo.
    const cifra = api.app.get<FieldCipher<TenantTx>>(FIELD_CIPHER);
    await withTenant(
      api.db.db,
      clinicaA,
      async (tx) => {
        const ref = patientFieldRef(clinicaA, pac, 'birth_date');
        const data = await cifra.decryptString(tx, ref, enc0 as string);
        const nova = await cifra.encrypt(tx, ref, data);
        expect(nova).not.toBe(enc0);
        await tx.update(patients).set({ birthDateEnc: nova }).where(eq(patients.id, pac));
        const [r] = await tx.execute<{ n: number }>(sql`select app_portal_recalc_sigilo(${pac}::uuid, ${original.confidentialFrom}::date, ${original.representUntil}::date) as n`);
        expect(Number(r?.n)).toBe(0);
      },
      adminA.userId,
    );
    expect(await cifraAntes()).not.toBe(enc0);
    expect(await vinculo()).toMatchObject(original);
    expect(await recalculos()).toBe(0);
    // O paciente continua legível pela API com a cifra nova.
    const lido = (await api.http().get(`/pacientes/${pac}`).set(cab(adminA)).expect(200)).body as { nascimento: string };
    expect(lido.nascimento).toBe(nascidoHa(14));
  });

  it('R2 do #73: as funções *_hidden respondem igual para "não existe", "é de outro paciente" e "existe, mas oculta"', async () => {
    const teen = await criarPaciente(adminA, 'Ivo Ficticio Adolescente Oraculo', { nascimento: nascidoHa(15) });
    const vizinho = await criarPaciente(adminA, 'Lia Ficticia Vizinha Oraculo', { nascimento: nascidoHa(30) });
    const psi = (await api.http().post('/profissionais').set(cab(adminA)).send({ nome: 'Dra Psi Oraculo Ficticia', especialidade: 'Clinica', areaSensivel: true }).expect(201)).body as { id: string };
    const [base] = await withTenant(api.db.db, clinicaA, (tx) => tx.execute<{ professional_id: string; appointment_type_id: string }>(
      sql`select professional_id, appointment_type_id from appointments where id = ${ag.a1z}`), adminA.userId);
    const tipo = base?.appointment_type_id as string;
    const pai = await responsavelDe(teen, 'Juca Ficticio Pai Oraculo');
    const recPsi = await recibo(adminA, await agendar(adminA, teen, psi.id, tipo, '2027-03-09', '09:00'));
    const recFisio = await recibo(adminA, await agendar(adminA, teen, base?.professional_id as string, tipo, '2027-03-09', '11:00'));
    const recVizinho = await recibo(adminA, await agendar(adminA, vizinho, base?.professional_id as string, tipo, '2027-03-09', '14:00'));
    const conta = await contaDe(adminA, teen, { agindoComo: 'responsavel_legal', responsavelId: pai });
    const ids = async (receipt: string) => {
      const [r] = await withTenant(api.db.db, clinicaA, (tx) => tx.execute<{ payment: string; charge: string }>(
        sql`select r.payment_id as payment, p.charge_id as charge from receipts r join payments p on p.id = r.payment_id where r.id = ${receipt}::uuid`), adminA.userId);
      return { receipt, payment: r?.payment as string, charge: r?.charge as string };
    };
    const [psiIds, fisioIds, vizinhoIds] = [await ids(recPsi), await ids(recFisio), await ids(recVizinho)];
    const inexistente = { receipt: randomUUID(), payment: randomUUID(), charge: randomUUID() };
    const oculta = (alvo: typeof psiIds) =>
      api.db.db.transaction(async (tx) => {
        await tx.execute(sql`select app_set_portal_session(${conta.contaId}::uuid, ${conta.vinculoId}::uuid)`);
        const [r] = await tx.execute<{ c: boolean; p: boolean; r: boolean }>(
          sql`select app_portal_charge_hidden(${alvo.charge}::uuid) as c, app_portal_payment_hidden(${alvo.payment}::uuid) as p, app_portal_receipt_hidden(${alvo.receipt}::uuid) as r`);
        return r;
      });
    const escondido = { c: true, p: true, r: true };
    expect(await oculta(inexistente)).toEqual(escondido);
    expect(await oculta(vizinhoIds)).toEqual(escondido); // não sensível, mas de OUTRO paciente: igual a "não existe"
    expect(await oculta(psiIds)).toEqual(escondido); // do próprio paciente, oculto pelo sigilo
    expect(await oculta(fisioIds)).toEqual({ c: false, p: false, r: false }); // só o que a sessão vê
  });

  it('N3: mudar a data de nascimento recalcula o sigilo (dia dos 12) e o fim da representação; o banco fecha se o serviço não recalcular', async () => {
    const pac = await criarPaciente(adminA, 'Nina Ficticia Recalculo', { nascimento: nascidoHa(9) });
    const resp = await responsavelDe(pac, 'Otto Ficticio Pai Recalculo');
    const conta = await contaDe(adminA, pac, { agindoComo: 'responsavel_legal', responsavelId: resp });
    const vinculo = async () =>
      (await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(portalLinks).where(eq(portalLinks.id, conta.vinculoId)), adminA.userId))[0];
    expect(await vinculo()).toMatchObject({ confidentialFrom: nascidoHa(9 - 12), representUntil: nascidoHa(9 - 18) });
    // Pela API: a clínica corrige para mais cedo (14 anos). O sigilo passa a valer (dia dos 12 já passou).
    await api.http().patch(`/pacientes/${pac}`).set(cab(adminA)).send({ nascimento: nascidoHa(14) }).expect(200);
    expect(await vinculo()).toMatchObject({ confidentialFrom: nascidoHa(14 - 12), representUntil: nascidoHa(14 - 18) });
    const trilha = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.scope, 'portal_links'), sql`${auditLog.metadata}->>'op' = 'confidentiality_recalculated'`)), adminA.userId);
    expect(trilha.map((t) => t.metadata)).toEqual(expect.arrayContaining([expect.objectContaining({ patient_id: pac, kind: 'link', target_id: conta.vinculoId, closed: false })]));
    // Direto no banco (sem o serviço): a data cifrada muda e, sem recálculo, o gatilho adiado da 0038 FECHA no
    // COMMIT (sigilo e representação hoje).
    const hoje = hojeNaClinica();
    // Troca pelo valor cifrado de OUTRO paciente da mesma clínica (selado, data diferente): o banco não lê a data.
    const outro = await criarPaciente(adminA, 'Pedro Ficticio Doador', { nascimento: nascidoHa(5) });
    await withTenant(
      api.db.db,
      clinicaA,
      (tx) => tx.execute(sql`update patients set birth_date_enc = (select birth_date_enc from patients where id = ${outro}::uuid) where id = ${pac}::uuid`),
      adminA.userId,
    );
    const depois = await vinculo();
    expect(depois?.confidentialFrom && depois.confidentialFrom <= hoje).toBe(true);
    expect(depois?.representUntil && depois.representUntil <= hoje).toBe(true);
    // Ninguém além do recálculo muda as duas colunas (nem o admin, direto).
    await expect(
      withTenant(api.db.db, clinicaA, (tx) => tx.update(portalLinks).set({ confidentialFrom: '2099-01-01' }).where(eq(portalLinks.id, conta.vinculoId)), adminA.userId),
    ).rejects.toThrow();
  });

  it('R1 do #73: SQL arbitrário na sessão da clínica não suspende o sigilo pela função de recálculo; a trilha sai do banco', async () => {
    const pac = await criarPaciente(adminA, 'Olga Ficticia Sigilo', { nascimento: nascidoHa(14) });
    const resp = await responsavelDe(pac, 'Rui Ficticio Pai Sigilo');
    const conta = await contaDe(adminA, pac, { agindoComo: 'responsavel_legal', responsavelId: resp });
    const vinculo = async () =>
      (await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(portalLinks).where(eq(portalLinks.id, conta.vinculoId)), adminA.userId))[0];
    const original = { confidentialFrom: nascidoHa(14 - 12), representUntil: nascidoHa(14 - 18) };
    expect(await vinculo()).toMatchObject(original);
    const recepcao = api.sessao(clinicaA, 'recepcao');
    const codigo = async (userId: string, q: ReturnType<typeof sql>) => {
      try {
        await withTenant(api.db.db, clinicaA, (tx) => tx.execute(q), userId);
        return 'ok';
      } catch (e) {
        return (e as { cause?: { code?: string }; code?: string }).cause?.code ?? (e as { code?: string }).code;
      }
    };
    for (const userId of [adminA.userId, recepcao.userId]) {
      // Datas coerentes (dia dos 12 e dos 18), mas sem a data de nascimento ter mudado: recusado.
      expect(await codigo(userId, sql`select app_portal_recalc_sigilo(${pac}::uuid, '2093-01-01'::date, '2099-01-01'::date)`)).toBe('42501');
      // Datas que não vêm de uma data de nascimento: recusado.
      expect(await codigo(userId, sql`select app_portal_recalc_sigilo(${pac}::uuid, '2099-01-01'::date, '2099-01-01'::date)`)).toBe('22023');
      // Fechar sem a data ter mudado também é recusado (encerraria a representação legítima).
      expect(await codigo(userId, sql`select app_portal_recalc_sigilo(${pac}::uuid, null, null)`)).toBe('42501');
      // A marca não é forjável: a tabela é interna (zero privilégio) e GUC não conta.
      expect(await codigo(userId, sql`insert into portal_birth_date_changes (tenant_id, patient_id, xact) values (${clinicaA}::uuid, ${pac}::uuid, txid_current())`)).toBe('42501');
      expect(await codigo(userId, sql`select set_config('app.portal_nascimento_mudou', ${pac}, true), set_config('app.portal_recalc', 'on', true), app_portal_recalc_sigilo(${pac}::uuid, '2093-01-01'::date, '2099-01-01'::date)`)).toBe('42501');
    }
    // Sem a sessão de usuário (só o tenant), nem fechar.
    await expect(withTenant(api.db.db, clinicaA, (tx) => tx.execute(sql`select app_portal_recalc_sigilo(${pac}::uuid, null, null)`))).rejects.toHaveProperty('cause.code', '42501');
    expect(await vinculo()).toMatchObject(original);

    // Pela API (a data muda de verdade): a trilha é gravada pelo BANCO, com os valores antigos e novos.
    await api.http().patch(`/pacientes/${pac}`).set(cab(adminA)).send({ nascimento: nascidoHa(13), documentoConferido: true }).expect(200);
    const novo = { confidentialFrom: nascidoHa(13 - 12), representUntil: nascidoHa(13 - 18) };
    expect(await vinculo()).toMatchObject(novo);
    const trilha = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.scope, 'portal_links'), sql`${auditLog.metadata}->>'patient_id' = ${pac}`, sql`${auditLog.metadata}->>'op' = 'confidentiality_recalculated'`)).orderBy(sql`seq`), adminA.userId);
    // O contrato da trilha (0005) proíbe datas: vão o deslocamento em dias e o estado antes/depois.
    const dias = (de: string, ate: string) => Math.round((Date.parse(ate) - Date.parse(de)) / 86_400_000);
    expect(trilha.map((t) => t.metadata)).toEqual([
      {
        op: 'confidentiality_recalculated', patient_id: pac, kind: 'link', target_id: conta.vinculoId, closed: false, reason: 'birth_date_changed',
        confidential_shift_days: dias(original.confidentialFrom, novo.confidentialFrom),
        represent_shift_days: dias(original.representUntil, novo.representUntil),
        confidential_was_on: true, confidential_now_on: true, representing_was_on: true, representing_now_on: true,
      },
    ]);
    expect(trilha[0]?.actorId).toBe(adminA.userId);
    // A marca é consumida: na transação seguinte, reabrir de novo (ou fechar) é recusado.
    expect(await codigo(adminA.userId, sql`select app_portal_recalc_sigilo(${pac}::uuid, '2093-01-01'::date, '2099-01-01'::date)`)).toBe('42501');
    expect(await codigo(recepcao.userId, sql`select app_portal_recalc_sigilo(${pac}::uuid, null, null)`)).toBe('42501');
    expect(await vinculo()).toMatchObject(novo);

    // SQL arbitrário que "reescreve" a coluna com a MESMA cifra não gera marca: o recálculo segue recusado.
    await expect(
      withTenant(
        api.db.db,
        clinicaA,
        async (tx) => {
          await tx.execute(sql`update patients set birth_date_enc = birth_date_enc where id = ${pac}::uuid`);
          await tx.execute(sql`select app_portal_recalc_sigilo(${pac}::uuid, '2093-01-01'::date, '2099-01-01'::date)`);
        },
        recepcao.userId,
      ),
    ).rejects.toHaveProperty('cause.code', '42501');
    expect(await vinculo()).toMatchObject(novo);
    // SQL arbitrário que troca a cifra e não recalcula: o COMMIT fecha (falha fechada), e a trilha do banco
    // registra o ator e o estado (representação deixou de valer).
    const outro = await criarPaciente(adminA, 'Saulo Ficticio Doador Sigilo', { nascimento: nascidoHa(30) });
    expect(await codigo(recepcao.userId, sql`update patients set birth_date_enc = (select birth_date_enc from patients where id = ${outro}::uuid) where id = ${pac}::uuid`)).toBe('ok');
    const fechado = await vinculo();
    expect(fechado?.representUntil && fechado.representUntil <= hojeNaClinica()).toBe(true);
    const fecho = await withTenant(
      api.db.db,
      clinicaA,
      (tx) => tx.select().from(auditLog).where(and(eq(auditLog.scope, 'portal_links'), sql`${auditLog.metadata}->>'patient_id' = ${pac}`, sql`${auditLog.metadata}->>'reason' = 'birth_date_changed_not_recalculated'`)).orderBy(sql`seq`),
      adminA.userId,
    );
    expect(fecho.map((t) => t.actorId)).toEqual([recepcao.userId]);
    expect(fecho[0]?.metadata).toMatchObject({ kind: 'link', closed: true, representing_was_on: true, representing_now_on: false });
  });

  it('N1 do #73 (a): trocar a cifra, recalcular e devolver a original na mesma transação não vale; o sigilo fecha e a representação volta', async () => {
    // 0053: a marca de conferência exige perfil ATIVO admin/profissional no banco.
    const conferente = await api.membro(clinicaA, api.sessao(clinicaA, 'profissional'), 'profissional');
    const doador = await criarPaciente(adminA, 'Teo Ficticio Doador Volta', { nascimento: nascidoHa(30) });
    const cifraDe = async (id: string) =>
      (await withTenant(api.db.db, clinicaA, (tx) => tx.select({ enc: patients.birthDateEnc }).from(patients).where(eq(patients.id, id)), adminA.userId))[0]?.enc as string;
    const troca = sql`update patients set birth_date_enc = (select birth_date_enc from patients where id = ${doador}::uuid) where id = `;
    // Duas variantes: devolve sem recalcular de novo; devolve e recalcula de novo (as duas com datas "coerentes"
    // de quem só faz 12 anos em 2093: sigilo desligado e representação estendida).
    for (const [idade, recalcDepois] of [[14, false], [10, true]] as const) {
      const pac = await criarPaciente(adminA, `Uma Ficticia Volta ${idade}`, { nascimento: nascidoHa(idade) });
      const conta = await contaDe(adminA, pac, { agindoComo: 'responsavel_legal', responsavelId: await responsavelDe(pac, `Vito Ficticio Pai Volta ${idade}`) });
      const vinculo = async () =>
        (await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(portalLinks).where(eq(portalLinks.id, conta.vinculoId)), adminA.userId))[0];
      const original = { confidentialFrom: nascidoHa(idade - 12), representUntil: nascidoHa(idade - 18) };
      expect(await vinculo()).toMatchObject(original);
      const enc0 = await cifraDe(pac);
      await withTenant(
        api.db.db,
        clinicaA,
        async (tx) => {
          await tx.execute(sql`${troca}${pac}::uuid`);
          // C1-b′ (0052): sem a conferência na marca, o recálculo que reduz a idade de quem tem 12+ é recusado.
          await tx.execute(sql`select app_patient_birth_date_document_checked(${pac}::uuid)`);
          await tx.execute(sql`select app_portal_recalc_sigilo(${pac}::uuid, '2093-01-01'::date, '2099-01-01'::date)`);
          await tx.execute(sql`update patients set birth_date_enc = ${enc0} where id = ${pac}::uuid`);
          if (recalcDepois) await tx.execute(sql`select app_portal_recalc_sigilo(${pac}::uuid, '2093-01-01'::date, '2099-01-01'::date)`);
        },
        conferente.userId,
      );
      expect(await cifraDe(pac)).toBe(enc0);
      const depois = await vinculo();
      // Sigilo fechado (valendo hoje) e representação de volta ao fim de antes (dia dos 18 da data real).
      const hoje = hojeNaClinica();
      expect(depois?.confidentialFrom).toBe(original.confidentialFrom <= hoje ? original.confidentialFrom : hoje);
      expect(depois?.representUntil).toBe(original.representUntil);
      const volta = await withTenant(
        api.db.db,
        clinicaA,
        (tx) => tx.select().from(auditLog).where(and(eq(auditLog.scope, 'portal_links'), sql`${auditLog.metadata}->>'patient_id' = ${pac}`, sql`${auditLog.metadata}->>'reason' = 'birth_date_reverted'`)).orderBy(sql`seq`),
        adminA.userId,
      );
      expect(volta.map((t) => t.actorId)).toEqual([conferente.userId]);
      expect(volta[0]?.metadata).toMatchObject({ kind: 'link', target_id: conta.vinculoId, closed: true, confidential_now_on: true, representing_now_on: true });
    }
  });

  it('N1 do #73 (b): o recálculo que desliga o sigilo ou estende a representação além dos 18 avisa admin e profissional e alerta o DPO', async () => {
    const [base] = await withTenant(api.db.db, clinicaA, (tx) => tx.execute<{ appointment_type_id: string }>(
      sql`select appointment_type_id from appointments where id = ${ag.a1z}`), adminA.userId);
    const profUser = randomUUID();
    const profId = randomUUID();
    await withTenant(api.db.db, clinicaA, (tx) => tx.insert(professionals).values({ id: profId, tenantId: clinicaA, userId: profUser, displayName: 'Dra Ficticia Aviso', specialty: 'Fisioterapia' }), adminA.userId);
    const fundador = api.fundador(clinicaA);
    // O1 (0040): cada destinatário só lê o próprio aviso; o teste junta a caixa de cada um.
    const avisos = async (pac: string) =>
      (
        await Promise.all(
          [fundador, profUser].map((u) =>
            withTenant(api.db.db, clinicaA, (tx) => tx.select().from(clinicalNotices).where(and(eq(clinicalNotices.kind, 'portal_sigilo_transicao'), eq(clinicalNotices.patientId, pac))), u),
          ),
        )
      ).flat();
    const alertas = async (transicao: string) =>
      (await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.action, 'anomaly_alert'), sql`${auditLog.metadata}->>'rule' = 'portal_sigilo_transicao'`, sql`${auditLog.metadata}->>'transition' = ${transicao}`)), adminA.userId)).length;
    const alertasAntes = { sigilo: await alertas('sigilo_desligado'), repr: await alertas('representacao_estendida') };

    // Sigilo desligado: adolescente de 14 "corrigido" para 11 (o dia dos 12 vai para o futuro).
    const teen = await criarPaciente(adminA, 'Bia Ficticia Aviso Sigilo', { nascimento: nascidoHa(14) });
    await agendar(adminA, teen, profId, base?.appointment_type_id as string, '2027-04-06', '09:00');
    await contaDe(adminA, teen, { agindoComo: 'responsavel_legal', responsavelId: await responsavelDe(teen, 'Caco Ficticio Pai Aviso') });
    expect(await avisos(teen)).toEqual([]);
    await api.http().patch(`/pacientes/${teen}`).set(cab(adminA)).send({ nascimento: nascidoHa(11), documentoConferido: true }).expect(200);
    // A representação também se estende (o dia dos 18 vai 3 anos para frente, valendo): N2 (0040) avisa as duas.
    const a1 = await avisos(teen);
    const desl = a1.filter((a) => a.portalTransition === 'sigilo_desligado');
    expect(desl.map((a) => a.recipientUserId).sort()).toEqual([fundador, profUser].sort());
    expect(a1.filter((a) => a.portalTransition === 'representacao_estendida').map((a) => a.recipientUserId).sort()).toEqual([fundador, profUser].sort());
    expect(a1).toHaveLength(4);
    expect(a1.every((a) => a.createdBy === adminA.userId && a.readAt === null)).toBe(true);
    expect(await alertas('sigilo_desligado')).toBe(alertasAntes.sigilo + 1);
    expect(await alertas('representacao_estendida')).toBe(alertasAntes.repr + 1);

    // Representação estendida: 17 anos -> "corrigido" para 19 (representação acaba) -> volta para 16 (reabre).
    const quase = await criarPaciente(adminA, 'Duda Ficticia Aviso Maioridade', { nascimento: nascidoHa(17) });
    await agendar(adminA, quase, profId, base?.appointment_type_id as string, '2027-04-06', '10:00');
    await contaDe(adminA, quase, { agindoComo: 'responsavel_legal', responsavelId: await responsavelDe(quase, 'Edu Ficticio Pai Aviso') });
    await api.http().patch(`/pacientes/${quase}`).set(cab(adminA)).send({ nascimento: nascidoHa(19) }).expect(200);
    expect(await avisos(quase)).toEqual([]); // encerrar a representação não é transição perigosa
    await api.http().patch(`/pacientes/${quase}`).set(cab(adminA)).send({ nascimento: nascidoHa(16), documentoConferido: true }).expect(200);
    const a2 = await avisos(quase);
    expect(a2.map((a) => a.recipientUserId).sort()).toEqual([fundador, profUser].sort());
    expect(a2.every((a) => a.portalTransition === 'representacao_estendida')).toBe(true);
    expect(await alertas('representacao_estendida')).toBe(alertasAntes.repr + 2);
    // O alerta não leva id de paciente (contrato dos alertas do #61): só regra, transição e contagens.
    const [ultimo] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.action, 'anomaly_alert'), sql`${auditLog.metadata}->>'transition' = 'representacao_estendida'`)).orderBy(sql`seq desc`).limit(1), adminA.userId);
    expect(Object.keys(ultimo?.metadata as object).sort()).toEqual(['count', 'notified', 'rule', 'transition']);
    expect(ultimo?.actorId).toBe(adminA.userId);
  });

  it('N2/N3/O1 do #73 (0040): extensão com a representação valendo alerta; aviso do banco não se forja; só o destinatário lê', async () => {
    const [base] = await withTenant(api.db.db, clinicaA, (tx) => tx.execute<{ appointment_type_id: string }>(
      sql`select appointment_type_id from appointments where id = ${ag.a1z}`), adminA.userId);
    const profUser = randomUUID();
    const profId = randomUUID();
    await withTenant(api.db.db, clinicaA, (tx) => tx.insert(professionals).values({ id: profId, tenantId: clinicaA, userId: profUser, displayName: 'Dra Ficticia Aviso N2', specialty: 'Fisioterapia' }), adminA.userId);
    const fundador = api.fundador(clinicaA);
    const recepcao = api.sessao(clinicaA, 'recepcao');
    const avisosDe = async (pac: string, userId: string) =>
      withTenant(api.db.db, clinicaA, (tx) => tx.select().from(clinicalNotices).where(and(eq(clinicalNotices.kind, 'portal_sigilo_transicao'), eq(clinicalNotices.patientId, pac))), userId);
    const alertas = async (transicao: string) =>
      (await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.action, 'anomaly_alert'), sql`${auditLog.metadata}->>'rule' = 'portal_sigilo_transicao'`, sql`${auditLog.metadata}->>'transition' = ${transicao}`)), adminA.userId)).length;
    const codigo = async (userId: string, q: ReturnType<typeof sql>) => {
      try {
        await withTenant(api.db.db, clinicaA, (tx) => tx.execute(q), userId);
        return 'ok';
      } catch (e) {
        return (e as { cause?: { code?: string }; code?: string }).cause?.code ?? (e as { code?: string }).code;
      }
    };
    const antes = { sigilo: await alertas('sigilo_desligado'), repr: await alertas('representacao_estendida') };

    // N2: 17 anos "corrigido" para 13. O sigilo segue ligado e a representação (que ainda valia) se estende:
    // aviso aos admins e ao profissional da agenda, e anomaly_alert ao DPO.
    const pac = await criarPaciente(adminA, 'Gabi Ficticia Aviso N2', { nascimento: nascidoHa(17) });
    await agendar(adminA, pac, profId, base?.appointment_type_id as string, '2027-04-07', '09:00');
    const conta = await contaDe(adminA, pac, { agindoComo: 'responsavel_legal', responsavelId: await responsavelDe(pac, 'Hugo Ficticio Pai N2') });
    await api.http().patch(`/pacientes/${pac}`).set(cab(adminA)).send({ nascimento: nascidoHa(13), documentoConferido: true }).expect(200);
    const [vinc] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(portalLinks).where(eq(portalLinks.id, conta.vinculoId)), adminA.userId);
    expect(vinc).toMatchObject({ confidentialFrom: nascidoHa(1), representUntil: nascidoHa(-5) });
    const doFundador = await avisosDe(pac, fundador);
    const doProf = await avisosDe(pac, profUser);
    expect((await avisosDe(pac, adminA.userId)).map((a) => a.portalTransition)).toEqual(['representacao_estendida']);
    expect(doFundador.map((a) => a.portalTransition)).toEqual(['representacao_estendida']);
    expect(doProf.map((a) => a.portalTransition)).toEqual(['representacao_estendida']);
    expect(await alertas('representacao_estendida')).toBe(antes.repr + 1);
    expect(await alertas('sigilo_desligado')).toBe(antes.sigilo);
    // Encurtar a representação (13 -> 15) não alerta.
    await api.http().patch(`/pacientes/${pac}`).set(cab(adminA)).send({ nascimento: nascidoHa(15), documentoConferido: true }).expect(200);
    expect(await avisosDe(pac, fundador)).toHaveLength(1);
    expect(await alertas('representacao_estendida')).toBe(antes.repr + 1);

    // O1: só o destinatário lê e marca como lido, inclusive por SQL arbitrário.
    // adminA é admin no banco desde a 0053 (também recebe); o "outro" é um admin só de sessão.
    for (const outro of [api.sessao(clinicaA, 'admin').userId, recepcao.userId]) {
      expect(await avisosDe(pac, outro)).toEqual([]);
      const [{ n } = { n: -1 }] = await withTenant(api.db.db, clinicaA, (tx) => tx.execute<{ n: number }>(
        sql`select count(*)::int as n from clinical_notices where patient_id = ${pac}::uuid or recipient_user_id = ${fundador}::uuid`), outro);
      expect(n).toBe(0);
      await withTenant(api.db.db, clinicaA, (tx) => tx.execute(sql`update clinical_notices set read_at = now() where patient_id = ${pac}::uuid`), outro);
    }
    expect((await avisosDe(pac, fundador))[0]?.readAt).toBeNull();
    // Sessão de sistema da clínica (sem usuário) não lê aviso nenhum.
    const sistema = await withTenant(api.db.db, clinicaA, (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from clinical_notices`));
    expect(sistema[0]?.n).toBe(0);
    // A caixa da API continua funcionando para o destinatário (sem nome nem data: só id, transição e ator).
    const tok = api.sessoes.criarSessao({ tenantId: clinicaA, userId: fundador, perfis: ['admin'] });
    const caixa = (await api.http().get('/avisos').set({ Authorization: `Bearer ${tok}` }).expect(200)).body as Record<string, unknown>[];
    const meu = caixa.find((a) => a.tipo === 'portal_sigilo_transicao' && a.pacienteId === pac);
    expect(Object.keys(meu as object).sort()).toEqual(['criadoEm', 'criadoPor', 'id', 'lidoEm', 'pacienteId', 'tipo', 'transicao']);
    await api.http().post(`/avisos/${String(meu?.id)}/lido`).set({ Authorization: `Bearer ${tok}` }).send({}).expect(200);
    await api.http().post(`/avisos/${String(meu?.id)}/lido`).set(cab(adminA)).send({}).expect(404);

    // N3: o runtime não forja o aviso do banco (nem com a GUC da função, nem com created_by = sessão), nem
    // chama a função interna.
    for (const userId of [adminA.userId, recepcao.userId, fundador]) {
      const forja = sql`insert into clinical_notices (tenant_id, recipient_user_id, kind, patient_id, portal_transition, created_by)
        values (${clinicaA}::uuid, ${fundador}::uuid, 'portal_sigilo_transicao', ${pac}::uuid, 'sigilo_desligado', ${userId}::uuid)`;
      expect(await codigo(userId, forja)).toBe('42501');
      expect(await codigo(userId, sql`select set_config('app.portal_alerta', 'on', true), set_config('app.portal_recalc', 'on', true)`)).toBe('ok');
      const comGuc = await withTenant(api.db.db, clinicaA, async (tx) => {
        await tx.execute(sql`select set_config('app.portal_alerta', 'on', true)`);
        await tx.execute(forja);
        return 'ok';
      }, userId).catch((e: { cause?: { code?: string } }) => e.cause?.code);
      expect(comGuc).toBe('42501');
      expect(await codigo(userId, sql`select app_portal_sigilo_alertar(${clinicaA}::uuid, ${pac}::uuid, 'sigilo_desligado', 1)`)).toBe('42501');
    }
    expect(await avisosDe(pac, fundador)).toHaveLength(1);
    // Os demais tipos continuam com a regra de antes (criados pela API como o usuário da sessão).
    expect(await codigo(adminA.userId, sql`insert into clinical_notices (tenant_id, recipient_user_id, kind, legal_hold_id, created_by)
      values (${clinicaA}::uuid, ${fundador}::uuid, 'retencao_retirada_pedida', ${randomUUID()}::uuid, ${recepcao.userId}::uuid)`)).toBe('42501');
  });

  it('R2: a área sensível vem da marca ESTRUTURADA do profissional; texto livre só reforça; o portal não altera a marca', async () => {
    // "Terapeuta" não é pego por texto: a clínica marca. "Saúde Mental" sem a marca: o banco liga sozinho.
    const terapeuta = (await api.http().post('/profissionais').set(cab(adminA)).send({ nome: 'Tera Ficticia', especialidade: 'Terapeuta', areaSensivel: true }).expect(201))
      .body as { id: string; areaSensivel: boolean };
    expect(terapeuta.areaSensivel).toBe(true);
    const saudeMental = (await api.http().post('/profissionais').set(cab(adminA)).send({ nome: 'Sama Ficticia', especialidade: 'Saúde Mental' }).expect(201))
      .body as { id: string; areaSensivel: boolean };
    expect(saudeMental.areaSensivel).toBe(true);
    // Desligar a marca não vence a especialidade sensível; ligar depois funciona (e é auditado).
    expect((await api.http().post(`/profissionais/${saudeMental.id}/area-sensivel`).set(cab(adminA)).send({ areaSensivel: false }).expect(201)).body)
      .toMatchObject({ areaSensivel: true });
    const nutri = (await api.http().post('/profissionais').set(cab(adminA)).send({ nome: 'Nutri Ficticia', especialidade: 'Nutricao' }).expect(201)).body as { id: string; areaSensivel: boolean };
    expect(nutri.areaSensivel).toBe(false);
    await api.http().post(`/profissionais/${nutri.id}/area-sensivel`).set(cab(api.sessao(clinicaA, 'recepcao'))).send({ areaSensivel: true }).expect(403);
    expect((await api.http().post(`/profissionais/${nutri.id}/area-sensivel`).set(cab(adminA)).send({ areaSensivel: true }).expect(201)).body)
      .toMatchObject({ areaSensivel: true });
    const teen = await criarPaciente(adminA, 'Wanda Ficticia Adolescente', { nascimento: nascidoHa(13) });
    const [base] = await withTenant(api.db.db, clinicaA, (tx) => tx.execute<{ appointment_type_id: string }>(
      sql`select appointment_type_id from appointments where id = ${ag.a1z}`), adminA.userId);
    const ids: string[] = [];
    for (const [i, prof] of [terapeuta.id, nutri.id].entries()) {
      const id = randomUUID();
      const ini = new Date(Date.now() + (5 + i) * 3_600_000);
      await withTenant(api.db.db, clinicaA, (tx) => tx.insert(appointments).values({
        id, tenantId: clinicaA, createdBy: adminA.userId, patientId: teen, professionalId: prof, appointmentTypeId: base?.appointment_type_id as string,
        startsAt: ini, endsAt: new Date(ini.getTime() + 30 * 60_000), status: 'confirmed',
      }), adminA.userId);
      ids.push(id);
    }
    const conta = await contaDe(adminA, teen, { agindoComo: 'responsavel_legal', responsavelId: await responsavelDe(teen, 'Yuri Ficticio Pai') });
    const lista = ((await api.http().get('/portal/consultas').set(cab(conta)).expect(200)).body as { id: string }[]).map((c) => c.id);
    expect(lista).not.toContain(ids[0]);
    expect(lista).not.toContain(ids[1]);
    // Na sessão do portal, professionals é só leitura (nem desligar a marca, nem renomear).
    await expect(api.db.db.transaction(async (tx) => {
      await tx.execute(sql`select app_set_portal_session(${conta.contaId}::uuid, ${conta.vinculoId}::uuid)`);
      await tx.execute(sql`update professionals set sensitive_area = false where id = ${terapeuta.id}::uuid`);
    })).rejects.toThrow();
  });
});

describe('auditoria e limite por conta', () => {
  it('toda ação do portal grava trilha com ator paciente_portal e o paciente; sem conteúdo', async () => {
    const p = await contaDe(adminA, pacA2);
    await api.http().get('/portal/consultas').set(cab(p)).expect(200);
    await api.http().get('/portal/meus-dados').set(cab(p)).expect(200);
    const linhas = await withTenant(api.db.db, clinicaA, (tx) =>
      tx.select().from(auditLog).where(and(eq(auditLog.tenantId, clinicaA), eq(auditLog.actorId, p.contaId))),
    );
    expect(linhas.length).toBeGreaterThanOrEqual(3);
    for (const l of linhas) {
      expect(l.actorKind).toBe('paciente_portal');
      expect(l.metadata).toMatchObject({ patient_id: pacA2 });
    }
    expect(linhas.map((l) => l.scope)).toEqual(expect.arrayContaining(['portal_links', 'appointments', 'patients']));
    expect(JSON.stringify(linhas)).not.toMatch(/Bruno|11900001111/);
  });

  it('acima do limite por conta: 429 e um anomaly_alert na trilha da clínica do vínculo', async () => {
    const api2 = await subirApi({ portalLimites: { contaMax: 3, contaJanelaMs: 60_000, resgateMax: 2, resgateJanelaMs: 60_000 } });
    try {
      // O resgate decifra o telefone do cadastro: faz pela API principal (a chave local é por instância) e a
      // MESMA conta abre sessão na api2, que tem o limite baixo.
      const vinculada = await contaDe(adminA, pacA1);
      const p = api2.sessaoPortal(vinculada.contaId);
      const codigos: number[] = [];
      for (let i = 0; i < 5; i++) codigos.push((await api2.http().get('/portal/consultas').set(cab(p))).status);
      expect(codigos).toEqual([200, 200, 200, 429, 429]);
      const alertas = await withTenant(api2.db.db, clinicaA, (tx) =>
        tx.select().from(auditLog).where(and(eq(auditLog.actorId, p.contaId), eq(auditLog.action, 'anomaly_alert'))).orderBy(sql`seq`),
      );
      expect(alertas).toHaveLength(1);
      expect(alertas[0]?.metadata).toEqual({ rule: 'portal_limite_por_conta', window_s: 60, threshold: 3, count: 4 });
      // Tentativas de resgate também têm teto.
      const q = api2.sessaoPortal();
      const tentativas: number[] = [];
      for (let i = 0; i < 4; i++) tentativas.push((await api2.http().post('/portal/convites/resgate').set(cab(q)).send({ token: randomBytes(32).toString('base64url') })).status);
      expect(tentativas).toEqual([409, 409, 429, 429]);
    } finally {
      await api2.fechar();
    }
  });
});

describe('R3 do #68 (0050): titular que passa a constar menor perde o acesso', () => {
  const SISTEMA = '00000000-0000-0000-0000-000000000000';
  let profUser: string;
  let profId: string;
  let tipoId: string;

  beforeAll(async () => {
    const [base] = await withTenant(api.db.db, clinicaA, (tx) => tx.execute<{ appointment_type_id: string }>(
      sql`select appointment_type_id from appointments where id = ${ag.a1z}`), adminA.userId);
    tipoId = base?.appointment_type_id as string;
    profUser = randomUUID();
    profId = randomUUID();
    await withTenant(api.db.db, clinicaA, (tx) => tx.insert(professionals).values({ id: profId, tenantId: clinicaA, userId: profUser, displayName: 'Dra Ficticia Titular Menor', specialty: 'Fisioterapia' }), adminA.userId);
  });

  const vinculo = async (id: string) =>
    (await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(portalLinks).where(eq(portalLinks.id, id)), adminA.userId))[0];
  const convite = async (id: string) =>
    (await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(portalInvites).where(eq(portalInvites.id, id)), adminA.userId))[0];
  const avisos = async (pac: string) =>
    (
      await Promise.all(
        [api.fundador(clinicaA), profUser].map((u) =>
          withTenant(api.db.db, clinicaA, (tx) => tx.select().from(clinicalNotices).where(and(eq(clinicalNotices.kind, 'portal_sigilo_transicao'), eq(clinicalNotices.patientId, pac))), u),
        ),
      )
    ).flat();
  const alertas = async () =>
    withTenant(api.db.db, clinicaA, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.action, 'anomaly_alert'), sql`${auditLog.metadata}->>'transition' = 'titular_menor_revogado'`)).orderBy(sql`seq desc`), adminA.userId);
  const trilha = async (pac: string) =>
    withTenant(api.db.db, clinicaA, (tx) => tx.select().from(auditLog).where(and(sql`${auditLog.metadata}->>'patient_id' = ${pac}`, sql`${auditLog.metadata}->>'reason' = 'titular_menor_de_idade'`)), adminA.userId);

  it('a correção da data revoga o titular e encerra o convite pendente na MESMA transação; trilha com o ator, aviso a admin e profissional, alerta sem id de paciente', async () => {
    const pac = await criarPaciente(adminA, 'Gil Ficticio Titular Corrigido', { nascimento: nascidoHa(30) });
    await agendar(adminA, pac, profId, tipoId, '2027-05-04', '09:00');
    const conta = await contaDe(adminA, pac);
    const pendente = await convidar(adminA, pac);
    await api.http().get('/portal/consultas').set(cab(conta)).expect(200);
    const alertasAntes = (await alertas()).length;

    await api.http().patch(`/pacientes/${pac}`).set(cab(adminA)).send({ nascimento: nascidoHa(15), documentoConferido: true }).expect(200);

    expect(await vinculo(conta.vinculoId)).toMatchObject({ revokeReason: 'titular_menor_de_idade', revokedBy: adminA.userId });
    expect(await convite(pendente.id)).toMatchObject({ revokedBy: adminA.userId, redeemedAt: null });
    expect((await api.http().get('/portal/consultas').set(cab(conta))).body).toMatchObject({ statusCode: 403, codigo: 'vinculo_inativo' });
    expect((await resgatar(api.sessaoPortal(), pendente.token)).status).toBe(409);
    const t = await trilha(pac);
    expect(t.map((l) => [l.scope, l.actorId, l.actorKind, (l.metadata as { origin: string }).origin]).sort()).toEqual([
      ['portal_invites', adminA.userId, 'usuario_clinica', 'correcao_do_nascimento'],
      ['portal_links', adminA.userId, 'usuario_clinica', 'correcao_do_nascimento'],
    ]);
    const a = await avisos(pac);
    expect(a.map((x) => x.recipientUserId).sort()).toEqual([api.fundador(clinicaA), profUser].sort());
    expect(a.every((x) => x.portalTransition === 'titular_menor_revogado' && x.createdBy === adminA.userId && x.readAt === null)).toBe(true);
    const al = await alertas();
    expect(al).toHaveLength(alertasAntes + 1);
    // notified: fundador, profissional e adminA (admin no banco desde a 0053; `avisos` só lê os dois primeiros).
    expect(al[0]?.metadata).toEqual({ rule: 'portal_sigilo_transicao', transition: 'titular_menor_revogado', count: 2, notified: 3 });
    expect(al[0]?.actorId).toBe(adminA.userId);
    // O job depois não acha mais nada deste paciente.
    await api.app.get(PortalClinicaService).revogarTitularesMenoresDaClinica(clinicaA);
    expect((await trilha(pac)).length).toBe(2);
  });

  it('o job diário pega o caso que escapou da correção (data gravada sem a API); ator sistema; idempotente', async () => {
    const pac = await criarPaciente(adminA, 'Hugo Ficticio Titular Escapou', { nascimento: nascidoHa(25) });
    await agendar(adminA, pac, profId, tipoId, '2027-05-04', '10:00');
    const conta = await contaDe(adminA, pac);
    const pendente = await convidar(adminA, pac);
    // Data trocada direto na coluna cifrada (importação, recifração, script): nenhuma revogação na hora.
    const cifra = api.app.get<FieldCipher<TenantTx>>(FIELD_CIPHER);
    await withTenant(api.db.db, clinicaA, async (tx) => {
      const nova = await cifra.encrypt(tx, patientFieldRef(clinicaA, pac, 'birth_date'), nascidoHa(16));
      await tx.update(patients).set({ birthDateEnc: nova }).where(eq(patients.id, pac));
    }, adminA.userId);
    expect(await vinculo(conta.vinculoId)).toMatchObject({ revokedAt: null });

    const jobs = api.app.get(JobsService);
    expect(await jobs.executar('portal-titular-menor')).toMatchObject({ job: 'portal-titular-menor', situacao: 'ok', clinicasComFalha: 0 });
    expect(await vinculo(conta.vinculoId)).toMatchObject({ revokeReason: 'titular_menor_de_idade', revokedBy: SISTEMA });
    expect(await convite(pendente.id)).toMatchObject({ revokedBy: SISTEMA });
    expect((await api.http().get('/portal/consultas').set(cab(conta))).body).toMatchObject({ statusCode: 403, codigo: 'vinculo_inativo' });
    const t = await trilha(pac);
    expect(t.map((l) => [l.scope, l.actorKind, (l.metadata as { origin: string }).origin]).sort()).toEqual([
      ['portal_invites', 'sistema', 'varredura_diaria'],
      ['portal_links', 'sistema', 'varredura_diaria'],
    ]);
    const a = await avisos(pac);
    expect(a.map((x) => x.recipientUserId).sort()).toEqual([api.fundador(clinicaA), profUser].sort());
    expect(a.every((x) => x.portalTransition === 'titular_menor_revogado' && x.createdBy === SISTEMA)).toBe(true);
    const [ultimo] = await alertas();
    expect(Object.keys(ultimo?.metadata as object).sort()).toEqual(['count', 'notified', 'rule', 'transition']);
    expect(ultimo?.actorKind).toBe('sistema');
    // Trilha do job na clínica, só contagens.
    const run = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.scope, 'jobs'), sql`${auditLog.metadata}->>'job' = 'portal-titular-menor'`)).orderBy(sql`seq desc`).limit(1), adminA.userId);
    expect(run[0]?.metadata).toMatchObject({ status: 'ok', titularesRevogados: 1, convitesEncerrados: 1, pacientes: 1, ilegiveis: 0, alarme: false });
    expect(JSON.stringify(run[0]?.metadata)).not.toContain(pac);
    // De novo: nada muda.
    await jobs.executar('portal-titular-menor');
    expect((await trilha(pac)).length).toBe(2);
    expect(await avisos(pac)).toHaveLength(2);
  });

  it('adulto (e menor emancipado) não é afetado: nem pela correção, nem pelo job', async () => {
    const adulto = await criarPaciente(adminA, 'Iara Ficticia Titular Adulta', { nascimento: nascidoHa(40) });
    const contaAdulto = await contaDe(adminA, adulto);
    const convAdulto = await convidar(adminA, adulto);
    await api.http().patch(`/pacientes/${adulto}`).set(cab(adminA)).send({ nascimento: nascidoHa(18), documentoConferido: true }).expect(200);
    // Emancipado aos 16 é titular; corrigir para 15 não o torna "menor não emancipado".
    const emanc = await criarPaciente(adminA, 'Juca Ficticio Emancipado', { nascimento: nascidoHa(16) });
    await api.http().post(`/pacientes/${emanc}/responsaveis/emancipacao`).set(cab(adminA)).send({ data: hojeNaClinica(), documento: 'Escritura ficticia 050' }).expect(200);
    const contaEmanc = await contaDe(adminA, emanc);
    await api.http().patch(`/pacientes/${emanc}`).set(cab(adminA)).send({ nascimento: nascidoHa(15), documentoConferido: true }).expect(200);
    await api.app.get(JobsService).executar('portal-titular-menor');
    for (const [pac, conta] of [[adulto, contaAdulto], [emanc, contaEmanc]] as const) {
      expect(await vinculo(conta.vinculoId)).toMatchObject({ revokedAt: null, revokeReason: null });
      await api.http().get('/portal/consultas').set(cab(conta)).expect(200);
      expect(await trilha(pac)).toEqual([]);
      expect(await avisos(pac)).toEqual([]);
    }
    expect(await convite(convAdulto.id)).toMatchObject({ revokedAt: null });
  });

  it('o motivo não se forja: a clínica não revoga com ele (API e SQL) nem chama a função fora da correção do nascimento', async () => {
    const pac = await criarPaciente(adminA, 'Lia Ficticia Titular Forja', { nascimento: nascidoHa(33) });
    const conta = await contaDe(adminA, pac);
    await api.http().post(`/clinica/portal/vinculos/${conta.vinculoId}/revogar`).set(cab(adminA)).send({ motivo: 'titular_menor_de_idade' }).expect(400);
    const codigo = async (fn: (tx: TenantTx) => Promise<unknown>) =>
      withTenant(api.db.db, clinicaA, fn, adminA.userId).then(
        () => 'ok',
        (e: { code?: string; cause?: { code?: string } }) => e.cause?.code ?? e.code,
      );
    const revogar = (tx: TenantTx) =>
      tx.execute(sql`update portal_links set revoked_at = now(), revoked_by = ${adminA.userId}::uuid, revoke_reason = 'titular_menor_de_idade' where id = ${conta.vinculoId}::uuid`);
    expect(await codigo(revogar)).toBe('42501');
    // Nem com a GUC da função ligada pelo runtime (não é o dono).
    expect(await codigo(async (tx) => {
      await tx.execute(sql`select set_config('app.portal_titular_menor', 'on', true)`);
      await revogar(tx);
    })).toBe('42501');
    // A função, sem mudar a data de nascimento na transação: recusada.
    expect(await codigo((tx) => tx.execute(sql`select * from app_portal_revoke_minor_titular(${pac}::uuid)`))).toBe('42501');
    expect(await vinculo(conta.vinculoId)).toMatchObject({ revokedAt: null });
  });

  it('R-a (rodada 23): nem em sessão de sistema, com a GUC ligada e o sentinela como criador, o runtime forja o aviso do banco', async () => {
    const pac = await criarPaciente(adminA, 'Mel Ficticia Forja Sistema', { nascimento: nascidoHa(31) });
    const fundador = api.fundador(clinicaA);
    for (const [transicao, guc] of [
      ['sigilo_desligado', 'app.portal_alerta'],
      ['titular_menor_revogado', 'app.portal_titular_menor'],
    ] as const) {
      // Sem userId: withTenant trava o slot no sentinela (app_set_system_user), como os jobs.
      const r = await withTenant(api.db.db, clinicaA, async (tx) => {
        expect((await tx.execute<{ s: boolean }>(sql`select app_is_system_session() as s`))[0]?.s).toBe(true);
        await tx.execute(sql`select set_config('app.portal_alerta', 'on', true), set_config(${guc}, 'on', true)`);
        await tx.execute(sql`insert into clinical_notices (tenant_id, recipient_user_id, kind, patient_id, portal_transition, created_by)
          values (${clinicaA}::uuid, ${fundador}::uuid, 'portal_sigilo_transicao', ${pac}::uuid, ${transicao}, ${SISTEMA}::uuid)`);
        return 'ok';
      }).catch((e: { code?: string; cause?: { code?: string } }) => e.cause?.code ?? e.code);
      expect(r).toBe('42501');
    }
    expect(await avisos(pac)).toEqual([]);
  });

  it('R-b (rodada 23): data de nascimento ilegível no job não revoga nada; conta em `ilegiveis` e acende `alarme`', async () => {
    const pac = await criarPaciente(adminA, 'Noa Ficticia Data Ilegivel', { nascimento: nascidoHa(29) });
    const conta = await contaDe(adminA, pac);
    const pendente = await convidar(adminA, pac);
    // Cifra válida, mas amarrada a OUTRO paciente (AAD): não decifra nesta linha. Mesmo dizendo "15 anos".
    const cifra = api.app.get<FieldCipher<TenantTx>>(FIELD_CIPHER);
    const trocarNascimento = (ref: string, valor: string) =>
      withTenant(api.db.db, clinicaA, async (tx) => {
        const enc = await cifra.encrypt(tx, patientFieldRef(clinicaA, ref, 'birth_date'), valor);
        await tx.update(patients).set({ birthDateEnc: enc }).where(eq(patients.id, pac));
      }, adminA.userId);
    await trocarNascimento(randomUUID(), nascidoHa(15));
    try {
      const jobs = api.app.get(JobsService);
      await jobs.executar('portal-titular-menor');
      const run = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.scope, 'jobs'), sql`${auditLog.metadata}->>'job' = 'portal-titular-menor'`)).orderBy(sql`seq desc`).limit(1), adminA.userId);
      expect(run[0]?.metadata).toMatchObject({ ilegiveis: 1, alarme: true, titularesRevogados: 0, convitesEncerrados: 0, pacientes: 0 });
      expect(JSON.stringify(run[0]?.metadata)).not.toContain(pac);
      expect(await api.app.get(PortalClinicaService).revogarTitularesMenoresDaClinica(clinicaA)).toMatchObject({ ilegiveis: 1, alarme: true, titularesRevogados: 0, convitesEncerrados: 0 });
      expect(await vinculo(conta.vinculoId)).toMatchObject({ revokedAt: null, revokeReason: null });
      expect(await convite(pendente.id)).toMatchObject({ revokedAt: null });
      await api.http().get('/portal/consultas').set(cab(conta)).expect(200);
      expect(await trilha(pac)).toEqual([]);
      expect(await avisos(pac)).toEqual([]);
    } finally {
      // Devolve uma data legível (adulto) para não deixar o alarme aceso para os outros testes.
      await trocarNascimento(pac, nascidoHa(29));
    }
  });
});

describe('contrato ApiPortal (packages/shared): respostas HTTP reais batem com o tipo', () => {
  it('titular: sessão, agenda (e ações), recibos (lista e detalhe), dados, pedidos, documentos e consentimento', async () => {
    const p = await contaDe(adminA, pacA1);
    const confere = (rota: RotaPortal, r: { status: number; body: unknown }) => {
      expect(r.status, rota).toBe(CONTRATO_PORTAL[rota].sucesso);
      expect(conferirRespostaPortal(rota, r.body), rota).toEqual([]);
      return r.body;
    };
    confere('GET /portal/vinculos', await api.http().get('/portal/vinculos').set(cab(p)));
    confere('GET /portal/sessao', await api.http().get('/portal/sessao').set(cab(p)));
    const consultas = (confere('GET /portal/consultas', await api.http().get('/portal/consultas').set(cab(p)))) as RespostaPortal<'GET /portal/consultas'>;
    expect(consultas.length).toBeGreaterThan(0);
    const alvo = consultas.find((c) => c.podeConfirmar);
    if (alvo) {
      confere('POST /portal/consultas/:id/confirmar', await api.http().post(caminhoPortal('POST /portal/consultas/:id/confirmar', { id: alvo.id })).set(cab(p)).send({}));
      confere(
        'POST /portal/consultas/:id/desfazer-confirmacao',
        await api.http().post(caminhoPortal('POST /portal/consultas/:id/desfazer-confirmacao', { id: alvo.id })).set(cab(p)).send({}),
      );
    }
    const recibos = (confere('GET /portal/recibos', await api.http().get('/portal/recibos').set(cab(p)))) as RespostaPortal<'GET /portal/recibos'>;
    expect(recibos.find((r) => r.id === reciboA1)).toMatchObject({ valorCentavos: 5000, forma: 'dinheiro' });
    confere('GET /portal/recibos/:id', await api.http().get(caminhoPortal('GET /portal/recibos/:id', { id: reciboA1 })).set(cab(p)));
    confere('GET /portal/meus-dados', await api.http().get('/portal/meus-dados').set(cab(p)));
    confere('GET /portal/documentos', await api.http().get('/portal/documentos').set(cab(p)));
    confere('POST /portal/solicitacoes', await api.http().post('/portal/solicitacoes').set(cab(p)).send({ tipo: 'baixar' }));
    confere('GET /portal/solicitacoes', await api.http().get('/portal/solicitacoes').set(cab(p)));
    confere('GET /portal/privacidade/consentimentos', await api.http().get('/portal/privacidade/consentimentos').set(cab(p)));
    const fin = { finalidade: 'pesquisa' };
    confere(
      'POST /portal/privacidade/consentimentos/:finalidade',
      await api.http().post(caminhoPortal('POST /portal/privacidade/consentimentos/:finalidade', fin)).set(cab(p)).send({ resposta: 'sim' }),
    );
    confere(
      'POST /portal/privacidade/consentimentos/:finalidade/desfazer',
      await api.http().post(caminhoPortal('POST /portal/privacidade/consentimentos/:finalidade/desfazer', fin)).set(cab(p)).send({}),
    );
    confere(
      'GET /portal/privacidade/consentimentos/:finalidade/historico',
      await api.http().get(caminhoPortal('GET /portal/privacidade/consentimentos/:finalidade/historico', fin)).set(cab(p)),
    );
  });

  it('convite (fragmento + OTP) e responsável: mesmos formatos, nada clínico; erro só com código', async () => {
    const menor = await criarPaciente(adminA, 'Rui Ficticio Contrato', { nascimento: nascidoHa(9) });
    const resp = await responsavelDe(menor, 'Sara Ficticia Contrato', { telefone: '11900004444' });
    const p = api.sessaoPortal();
    const { token } = await convidar(adminA, menor, { agindoComo: 'responsavel_legal', responsavelId: resp });
    const ini = await api.http().post('/portal/convites/resgate').set(cab(p)).send({ token });
    expect(ini.status).toBe(200);
    expect(conferirRespostaPortal('POST /portal/convites/resgate', ini.body)).toEqual([]);
    expect(JSON.stringify(ini.body)).not.toContain('11900004444');
    const fim = await api.http().post('/portal/convites/resgate/confirmar').set(cab(p)).send({ token, codigo: api.otp.ultimoCodigo('11900004444') });
    expect(fim.status).toBe(200);
    expect(conferirRespostaPortal('POST /portal/convites/resgate/confirmar', fim.body)).toEqual([]);
    const sessao = await api.http().get('/portal/sessao').set(cab(p)).expect(200);
    expect(conferirRespostaPortal('GET /portal/sessao', sessao.body)).toEqual([]);
    expect(sessao.body).toMatchObject({ agindoComo: 'responsavel_legal' });
    for (const rota of ['GET /portal/consultas', 'GET /portal/recibos', 'GET /portal/meus-dados', 'GET /portal/privacidade/consentimentos'] as const) {
      const r = await api.http().get(CONTRATO_PORTAL[rota].caminho).set(cab(p)).expect(200);
      expect(conferirRespostaPortal(rota, r.body), rota).toEqual([]);
      for (const k of CAMPOS_CLINICOS_PROIBIDOS) expect(JSON.stringify(r.body), `${rota} ${k}`).not.toContain(`"${k}"`);
    }
    const erro = await api.http().post('/portal/convites/resgate').set(cab(p)).send({ token: 'curto' });
    expect(erro.status).toBe(409);
    expect(conferirForma(FormaErroDaApi, erro.body)).toEqual([]);
    expect(erro.body).toMatchObject({ codigo: 'convite_invalido' });
  });

  it('adolescente (12+) e responsável NÃO pagador: recibo sensível fora da lista e 404 no detalhe; o do pagador confere', async () => {
    const nasc = nascidoHa(14);
    const teen = await criarPaciente(adminA, 'Nina Ficticia Contrato', { nascimento: nasc });
    const psi = (await api.http().post('/profissionais').set(cab(adminA)).send({ nome: 'Dra Psi Contrato Ficticia', especialidade: 'Clinica', areaSensivel: true }).expect(201))
      .body as { id: string };
    const [base] = await withTenant(api.db.db, clinicaA, (tx) => tx.execute<{ appointment_type_id: string }>(
      sql`select appointment_type_id from appointments where id = ${ag.a1z}`), adminA.userId);
    const pagador = await responsavelDe(teen, 'Olga Ficticia Pagadora', { pagador: true });
    const naoPagador = await responsavelDe(teen, 'Pio Ficticio Nao Pagador');
    const recPsi = await recibo(adminA, await agendar(adminA, teen, psi.id, base?.appointment_type_id as string, '2027-04-05', '09:00'));
    const contaPagador = await contaDe(adminA, teen, { agindoComo: 'responsavel_legal', responsavelId: pagador });
    const contaOutro = await contaDe(adminA, teen, { agindoComo: 'responsavel_legal', responsavelId: naoPagador });
    const confere = (rota: RotaPortal, r: { status: number; body: unknown }) => {
      expect(r.status, rota).toBe(CONTRATO_PORTAL[rota].sucesso);
      expect(conferirRespostaPortal(rota, r.body), rota).toEqual([]);
      return r.body;
    };
    const ids = (b: unknown) => (b as RespostaPortal<'GET /portal/recibos'>).map((r) => r.id);

    // Responsável que NÃO pagou: o recibo de área sensível não existe para ele (nem "neutro").
    const doOutro = confere('GET /portal/recibos', await api.http().get('/portal/recibos').set(cab(contaOutro)));
    expect(ids(doOutro)).not.toContain(recPsi);
    const nf = await api.http().get(caminhoPortal('GET /portal/recibos/:id', { id: recPsi })).set(cab(contaOutro));
    expect(nf.status).toBe(404);
    expect(conferirForma(FormaErroDaApi, nf.body)).toEqual([]);
    expect(JSON.stringify(nf.body)).not.toMatch(/Psi|profissional|emitente/);

    // Responsável pagador congelado: o recibo é dele, na lista e no detalhe, conforme o contrato (sem profissionalId, C3).
    expect(ids(confere('GET /portal/recibos', await api.http().get('/portal/recibos').set(cab(contaPagador))))).toContain(recPsi);
    const det = confere('GET /portal/recibos/:id', await api.http().get(caminhoPortal('GET /portal/recibos/:id', { id: recPsi })).set(cab(contaPagador)));
    expect(JSON.stringify(det)).not.toContain(psi.id);
    expect(JSON.stringify(det)).not.toContain('profissionalId');

    // C1: os dois responsáveis veem o nascimento completo, na tela rotulada "dados do paciente".
    for (const c of [contaOutro, contaPagador]) {
      const md = confere('GET /portal/meus-dados', await api.http().get('/portal/meus-dados').set(cab(c)));
      expect(md).toMatchObject({ rotulo: 'dados_do_paciente', nascimento: nasc });
    }
  });
});

describe('C1 (conferência de 24/10): nascimento não se edita pelo portal; correção analisada pela clínica', () => {
  const corrigir = (c: SessaoPortal, corpo: Record<string, unknown>) => api.http().post('/portal/meus-dados/correcao').set(cab(c)).send(corpo);
  const situacao = (id: string, corpo: Record<string, unknown>) => api.http().post(`/clinica/portal/solicitacoes/${id}/situacao`).set(cab(adminA)).send(corpo);

  it('responsável pede data que REDUZ a idade do adolescente: o cadastro não muda e atender exige documento conferido', async () => {
    const nasc = nascidoHa(15);
    const teen = await criarPaciente(adminA, 'Iara Ficticia Correcao', { nascimento: nasc });
    const resp = await responsavelDe(teen, 'Joel Ficticio Correcao');
    const c = await contaDe(adminA, teen, { agindoComo: 'responsavel_legal', responsavelId: resp });
    expect((await api.http().get('/portal/meus-dados').set(cab(c)).expect(200)).body).toMatchObject({ rotulo: 'dados_do_paciente', nascimento: nasc });
    // Não há rota que edite o cadastro pelo portal.
    await api.http().post('/portal/meus-dados').set(cab(c)).send({ nascimento: nascidoHa(11) }).expect(404);
    // Data inválida, em outro formato ou futura: 400 com o NOME do campo (nunca o valor).
    for (const n of ['2013-02-29', '01/01/2015', '2999-01-01', 'quinze anos']) {
      const r = await corrigir(c, { detalhe: 'Data ficticia', nascimento: n }).expect(400);
      expect(r.body, n).toMatchObject({ campos: ['nascimento'] });
      expect(JSON.stringify(r.body)).not.toContain(n);
    }
    const proposto = nascidoHa(11);
    const ped = (await corrigir(c, { detalhe: 'Data de nascimento ficticia errada', nascimento: proposto }).expect(201)).body as { id: string };
    expect(conferirRespostaPortal('POST /portal/meus-dados/correcao', ped)).toEqual([]);
    expect(ped).toMatchObject({ tipo: 'correcao', situacao: 'aberto' });
    // O pedido não muda o cadastro.
    expect((await api.http().get('/portal/meus-dados').set(cab(c)).expect(200)).body).toMatchObject({ nascimento: nasc });

    const det = await api.http().get(`/clinica/portal/solicitacoes/${ped.id}`).set(cab(adminA)).expect(200);
    expect(det.body).toMatchObject({ tipo: 'correcao', agindoComo: 'responsavel_legal', nascimentoProposto: proposto, exigeConferenciaDeDocumento: true, documentoConferidoEm: null });
    for (const corpo of [{}, { documentoConferido: false }]) {
      const r = await situacao(ped.id, { situacao: 'atendida', resposta: 'Resposta ficticia QZX', ...corpo }).expect(422);
      expect(r.body).toEqual({ statusCode: 422, message: 'Regra não atendida', codigo: 'documento_nao_conferido', campos: ['documentoConferido'] });
    }
    await situacao(ped.id, { situacao: 'em_andamento' }).expect(200);
    await situacao(ped.id, { situacao: 'atendida', resposta: 'Resposta ficticia QZX', documentoConferido: true }).expect(200);
    const depois = await api.http().get(`/clinica/portal/solicitacoes/${ped.id}`).set(cab(adminA)).expect(200);
    expect((depois.body as { documentoConferidoEm: string | null }).documentoConferidoEm).not.toBeNull();
    // Ressalva 5 (Conferência 0052): atender a correção grava a data no cadastro na mesma transação.
    expect((await api.http().get('/portal/meus-dados').set(cab(c)).expect(200)).body).toMatchObject({ nascimento: proposto });

    const [linha] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(portalRightsRequests).where(eq(portalRightsRequests.id, ped.id)), adminA.userId);
    expect(linha?.birthDateProposedEnc).toMatch(/^v1:/);
    expect(linha?.documentCheckedBy).toBe(adminA.userId);
    expect(linha?.documentCheckedAt).toBeInstanceOf(Date);
    expect(linha?.documentCheckedRole).toBe('admin');
    const trilha = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(auditLog).where(eq(auditLog.tenantId, clinicaA)));
    expect(JSON.stringify(trilha)).not.toContain(proposto);
  });

  it('titular adulto: aumentar a idade não exige documento; o banco guarda a data só em correção, imutável, e a conferência só pela clínica', async () => {
    const pac = await criarPaciente(adminA, 'Otto Ficticio Correcao', { nascimento: '1990-03-04' });
    const p = await contaDe(adminA, pac);
    expect((await api.http().get('/portal/meus-dados').set(cab(p)).expect(200)).body).toMatchObject({ rotulo: 'meus_dados', nascimento: '1990-03-04' });
    // A data proposta só entra pela rota de correção.
    await api.http().post('/portal/solicitacoes').set(cab(p)).send({ tipo: 'correcao', nascimento: '1989-03-04' }).expect(400);
    const ped = (await corrigir(p, { detalhe: 'Ano ficticio errado', nascimento: '1989-03-04' }).expect(201)).body as { id: string };
    const det = await api.http().get(`/clinica/portal/solicitacoes/${ped.id}`).set(cab(adminA)).expect(200);
    expect(det.body).toMatchObject({ agindoComo: 'titular', nascimentoProposto: '1989-03-04', exigeConferenciaDeDocumento: false });
    // Pedido sem data proposta não aceita a marca de conferência.
    const semData = (await corrigir(p, { detalhe: 'Telefone ficticio mudou' }).expect(201)).body as { id: string };
    expect((await situacao(semData.id, { situacao: 'em_andamento', documentoConferido: true }).expect(400)).body).toMatchObject({ campos: ['documentoConferido'] });

    const portal = <T>(fn: (tx: TenantTx) => Promise<T>) =>
      api.db.db.transaction(async (tx) => {
        await tx.execute(sql`select app_set_portal_session(${p.contaId}::uuid, ${p.vinculoId}::uuid)`);
        return fn(tx);
      });
    // O portal não marca a conferência.
    await expect(
      portal((tx) => tx.execute(sql`update portal_rights_requests set document_checked_by = ${p.contaId}::uuid, document_checked_at = now() where id = ${ped.id}::uuid`)),
    ).rejects.toThrow();
    // Data proposta fora de pedido de correção: o banco recusa (CHECK).
    const [linha] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(portalRightsRequests).where(eq(portalRightsRequests.id, ped.id)), adminA.userId);
    await expect(
      portal((tx) =>
        tx.execute(sql`insert into portal_rights_requests (tenant_id, patient_id, link_id, account_id, kind, acting_as, protocol, birth_date_proposed_enc)
          values (${clinicaA}::uuid, ${pac}::uuid, ${p.vinculoId}::uuid, ${p.contaId}::uuid, 'acesso', 'titular', '20310101-ABCDEF09', ${linha?.birthDateProposedEnc ?? ''})`),
      ),
    ).rejects.toThrow();
    const naClinica = (set: Record<string, unknown>) =>
      withTenant(
        api.db.db,
        clinicaA,
        (tx) => tx.update(portalRightsRequests).set({ status: 'em_andamento', handledBy: adminA.userId, handledAt: sql`now()`, ...set }).where(eq(portalRightsRequests.id, ped.id)),
        adminA.userId,
      );
    // A clínica não troca a data proposta nem marca a conferência em nome de outro usuário.
    await expect(naClinica({ birthDateProposedEnc: null })).rejects.toThrow();
    await expect(naClinica({ documentCheckedBy: randomUUID(), documentCheckedAt: sql`now()` })).rejects.toThrow();
    // Conferida pela API (uma vez), a marca não se reescreve.
    await situacao(ped.id, { situacao: 'em_andamento', documentoConferido: true }).expect(200);
    await expect(naClinica({ status: 'atendida', answerEnc: linha?.birthDateProposedEnc, documentCheckedAt: sql`now() - interval '1 day'` })).rejects.toThrow();
    await situacao(ped.id, { situacao: 'atendida', resposta: 'Resposta ficticia QZX' }).expect(200);
  });
});

describe('C1-b′ (conferência C1–C5 de 24/10): a conferência de documento trava a MUDANÇA da data, não só o pedido', () => {
  const corrigir = (c: SessaoPortal, corpo: Record<string, unknown>) => api.http().post('/portal/meus-dados/correcao').set(cab(c)).send(corpo);
  const situacao = (id: string, corpo: Record<string, unknown>) => api.http().post(`/clinica/portal/solicitacoes/${id}/situacao`).set(cab(adminA)).send(corpo);
  const vinculoDe = async (id: string) =>
    (await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(portalLinks).where(eq(portalLinks.id, id)), adminA.userId))[0];
  const avisos = async (pac: string) =>
    withTenant(api.db.db, clinicaA, (tx) => tx.select().from(clinicalNotices).where(and(eq(clinicalNotices.kind, 'portal_sigilo_transicao'), eq(clinicalNotices.patientId, pac))), api.fundador(clinicaA));
  const trilhaDe = async (pac: string) =>
    withTenant(api.db.db, clinicaA, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.scope, 'patients'), sql`${auditLog.metadata}->>'patient_id' = ${pac}`)).orderBy(sql`seq`), adminA.userId);
  const codigo = async (userId: string, fn: (tx: TenantTx) => Promise<unknown>) => {
    try {
      await withTenant(api.db.db, clinicaA, fn, userId);
      return 'ok';
    } catch (e) {
      return (e as { cause?: { code?: string }; code?: string }).cause?.code ?? (e as { code?: string }).code;
    }
  };

  it('item 1: a exigência é gravada NA ABERTURA; a clínica corrige o cadastro antes e, ao atender, o documento continua exigido', async () => {
    const nasc = nascidoHa(15);
    const teen = await criarPaciente(adminA, 'Rui Ficticio Ordem', { nascimento: nasc });
    const c = await contaDe(adminA, teen, { agindoComo: 'responsavel_legal', responsavelId: await responsavelDe(teen, 'Lia Ficticia Mae Ordem') });
    const proposto = nascidoHa(11);
    const ped = (await corrigir(c, { detalhe: 'Data ficticia errada', nascimento: proposto }).expect(201)).body as { id: string };
    const linha = async () =>
      (await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(portalRightsRequests).where(eq(portalRightsRequests.id, ped.id)), adminA.userId))[0];
    expect((await linha())?.documentRequired).toBe(true);
    // A clínica corrige o cadastro primeiro (a mudança direta exige documento: item 2).
    await api.http().patch(`/pacientes/${teen}`).set(cab(adminA)).send({ nascimento: proposto, documentoConferido: true }).expect(200);
    // Agora atual == proposto; mesmo assim o pedido continua exigindo a conferência gravada.
    const det = await api.http().get(`/clinica/portal/solicitacoes/${ped.id}`).set(cab(adminA)).expect(200);
    expect(det.body).toMatchObject({ nascimentoProposto: proposto, exigeConferenciaDeDocumento: true, documentoConferidoEm: null });
    for (const corpo of [{}, { documentoConferido: false }]) {
      const r = await situacao(ped.id, { situacao: 'atendida', resposta: 'Resposta ficticia QZX', ...corpo }).expect(422);
      expect(r.body).toEqual({ statusCode: 422, message: 'Regra não atendida', codigo: 'documento_nao_conferido', campos: ['documentoConferido'] });
    }
    // SQL arbitrário na sessão da clínica: atender sem a conferência gravada e trocar a exigência são recusados.
    const naClinica = (set: Record<string, unknown>) => (tx: TenantTx) =>
      tx.update(portalRightsRequests).set({ handledBy: adminA.userId, handledAt: sql`now()`, ...set }).where(eq(portalRightsRequests.id, ped.id));
    const resposta = (await linha())?.birthDateProposedEnc;
    expect(await codigo(adminA.userId, naClinica({ status: 'atendida', answerEnc: resposta }))).toBe('23514');
    expect(await codigo(adminA.userId, naClinica({ status: 'em_andamento', documentRequired: false }))).toBe('42501');
    expect((await linha())?.documentRequired).toBe(true);
    await situacao(ped.id, { situacao: 'atendida', resposta: 'Resposta ficticia QZX', documentoConferido: true }).expect(200);
    expect(await linha()).toMatchObject({ status: 'atendida', documentRequired: true, documentCheckedBy: adminA.userId });
    const abertura = (
      await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.scope, 'portal_rights_requests'), sql`${auditLog.metadata}->>'request_id' = ${ped.id}`)).orderBy(sql`seq`), adminA.userId)
    )[0];
    expect(abertura?.metadata).toMatchObject({ has_birth_date: true, document_required: true });
  });

  it('item 1: a exigência vem da data vigente na abertura (adulto que AUMENTA a idade: não exige); sem decisão, o banco preenche com falha fechada', async () => {
    const pac = await criarPaciente(adminA, 'Ana Ficticia Abertura', { nascimento: '1991-05-06' });
    const p = await contaDe(adminA, pac);
    const ped = (await corrigir(p, { detalhe: 'Ano ficticio', nascimento: '1990-05-06' }).expect(201)).body as { id: string };
    const [l] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(portalRightsRequests).where(eq(portalRightsRequests.id, ped.id)), adminA.userId);
    expect(l?.documentRequired).toBe(false);
    // Gravação sem a decisão da API (SQL na sessão do portal): o gatilho preenche true quando há data proposta;
    // `document_required` true sem data proposta é recusado (CHECK).
    const portal = (fn: (tx: TenantTx) => Promise<unknown>) =>
      api.db.db.transaction(async (tx) => {
        await tx.execute(sql`select app_set_portal_session(${p.contaId}::uuid, ${p.vinculoId}::uuid)`);
        return fn(tx);
      });
    const id = randomUUID();
    await portal((tx) =>
      tx.execute(sql`insert into portal_rights_requests (id, tenant_id, patient_id, link_id, account_id, kind, acting_as, protocol, birth_date_proposed_enc)
        values (${id}::uuid, ${clinicaA}::uuid, ${pac}::uuid, ${p.vinculoId}::uuid, ${p.contaId}::uuid, 'correcao', 'titular', '20310101-ABCDEF0A', ${l?.birthDateProposedEnc ?? ''})`),
    );
    const [semDecisao] = await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(portalRightsRequests).where(eq(portalRightsRequests.id, id)), adminA.userId);
    expect(semDecisao?.documentRequired).toBe(true);
    await expect(
      portal((tx) =>
        tx.execute(sql`insert into portal_rights_requests (tenant_id, patient_id, link_id, account_id, kind, acting_as, protocol, document_required)
          values (${clinicaA}::uuid, ${pac}::uuid, ${p.vinculoId}::uuid, ${p.contaId}::uuid, 'correcao', 'titular', '20310101-ABCDEF0B', true)`),
      ),
    ).rejects.toThrow();
  });

  it('item 2: PATCH /pacientes/:id que reduz a idade de quem tem 12+ exige documentoConferido (422), com a trilha de quem conferiu', async () => {
    const recepcao = await api.membro(clinicaA, api.sessao(clinicaA, 'recepcao'), 'recepcao');
    const prof = await api.membro(clinicaA, api.sessao(clinicaA, 'profissional'), 'profissional');
    const nasc = nascidoHa(15);
    const teen = await criarPaciente(adminA, 'Gil Ficticio Recepcao', { nascimento: nasc });
    const c = await contaDe(adminA, teen, { agindoComo: 'responsavel_legal', responsavelId: await responsavelDe(teen, 'Noa Ficticia Mae Recepcao') });
    const antes = await vinculoDe(c.vinculoId);
    const novo = nascidoHa(11);
    // (i) sem a flag (ou com false): 422 com código claro; cadastro, sigilo e avisos intactos.
    for (const extra of [{}, { documentoConferido: false }]) {
      const r = await api.http().patch(`/pacientes/${teen}`).set(cab(recepcao)).send({ nascimento: novo, ...extra }).expect(422);
      expect(r.body).toEqual({ statusCode: 422, message: 'Regra não atendida', codigo: 'documento_nao_conferido', campos: ['documentoConferido'] });
      expect(JSON.stringify(r.body)).not.toContain(novo);
    }
    expect(((await api.http().get(`/pacientes/${teen}`).set(cab(adminA)).expect(200)).body as { nascimento: string }).nascimento).toBe(nasc);
    expect(await vinculoDe(c.vinculoId)).toMatchObject({ confidentialFrom: antes?.confidentialFrom, representUntil: antes?.representUntil });
    expect(await avisos(teen)).toEqual([]);
    // A flag só acompanha a data e é booleana; o cadastro inicial não a aceita.
    await api.http().patch(`/pacientes/${teen}`).set(cab(recepcao)).send({ telefone: '11900001112', documentoConferido: true }).expect(400);
    await api.http().patch(`/pacientes/${teen}`).set(cab(recepcao)).send({ nascimento: novo, documentoConferido: 'sim' }).expect(400);
    await api.http().post('/pacientes').set(cab(recepcao)).send({ nome: 'Ivo Ficticio', telefone: '11900001111', nascimento: novo, documentoConferido: true }).expect(400);
    // 0053: a recepção sozinha não confere (403 com código; nada muda), nem registrada no banco.
    const r403 = await api.http().patch(`/pacientes/${teen}`).set(cab(recepcao)).send({ nascimento: novo, documentoConferido: true }).expect(403);
    expect(r403.body).toEqual({ statusCode: 403, message: 'Sem permissão', codigo: 'conferencia_exige_perfil' });
    expect(((await api.http().get(`/pacientes/${teen}`).set(cab(adminA)).expect(200)).body as { nascimento: string }).nascimento).toBe(nasc);
    // (ii) com a flag, pelo profissional: 200, recálculo da 0038 feito (sigilo desligado), aviso da 0039 gravado, trilha com quem conferiu e o perfil.
    await api.http().patch(`/pacientes/${teen}`).set(cab(prof)).send({ nascimento: novo, documentoConferido: true }).expect(200);
    const depois = await vinculoDe(c.vinculoId);
    expect((depois?.confidentialFrom ?? '') > hojeNaClinica()).toBe(true);
    expect((await avisos(teen)).some((a) => a.portalTransition === 'sigilo_desligado')).toBe(true);
    const trilha = await trilhaDe(teen);
    const update = trilha.find((t) => (t.metadata as { changed?: string }).changed === 'birth_date');
    expect(update?.actorId).toBe(prof.userId);
    expect(update?.metadata).toMatchObject({ document_required: true, document_checked: true });
    const conf = trilha.filter((t) => (t.metadata as { op?: string }).op === 'birth_date_document_checked');
    expect(conf.map((t) => [t.actorId, t.metadata])).toEqual([[prof.userId, { op: 'birth_date_document_checked', patient_id: teen, document_checked: true, role: 'profissional' }]]);
    expect(JSON.stringify(trilha)).not.toContain(novo);
    expect(JSON.stringify(trilha)).not.toContain(nasc);
    // (iii) aumentar a idade, ou corrigir a de uma criança: 200 sem a flag.
    await api.http().patch(`/pacientes/${teen}`).set(cab(recepcao)).send({ nascimento: nascidoHa(13) }).expect(200);
    const crianca = await criarPaciente(adminA, 'Mel Ficticia Crianca', { nascimento: nascidoHa(8) });
    await contaDe(adminA, crianca, { agindoComo: 'responsavel_legal', responsavelId: await responsavelDe(crianca, 'Teo Ficticio Pai Crianca') });
    await api.http().patch(`/pacientes/${crianca}`).set(cab(recepcao)).send({ nascimento: nascidoHa(7) }).expect(200);
    expect((await trilhaDe(crianca)).find((t) => (t.metadata as { changed?: string }).changed === 'birth_date')?.metadata).toMatchObject({
      document_required: false,
      document_checked: false,
    });
  });

  it('item 2 no banco: SQL arbitrário que reduz a idade de quem tem 12+ e recalcula sem a marca de conferência é recusado', async () => {
    const recepcao = await api.membro(clinicaA, api.sessao(clinicaA, 'recepcao'), 'recepcao');
    const prof = await api.membro(clinicaA, api.sessao(clinicaA, 'profissional'), 'profissional');
    const teen = await criarPaciente(adminA, 'Bel Ficticia Sql', { nascimento: nascidoHa(15) });
    const c = await contaDe(adminA, teen, { agindoComo: 'responsavel_legal', responsavelId: await responsavelDe(teen, 'Davi Ficticio Pai Sql') });
    const doador = await criarPaciente(adminA, 'Rafa Ficticio Doador Sql', { nascimento: nascidoHa(8) });
    const outro = await criarPaciente(adminA, 'Lu Ficticia Doadora Sql', { nascimento: nascidoHa(9) });
    const antes = await vinculoDe(c.vinculoId);
    const troca = (de: string) => sql`update patients set birth_date_enc = (select birth_date_enc from patients where id = ${de}::uuid) where id = ${teen}::uuid`;
    const recalc = sql`select app_portal_recalc_sigilo(${teen}::uuid, '2093-01-01'::date, '2099-01-01'::date)`;
    const marca = sql`select app_patient_birth_date_document_checked(${teen}::uuid)`;
    // Sem a marca: recusado; nada muda.
    expect(await codigo(recepcao.userId, async (tx) => { await tx.execute(troca(doador)); await tx.execute(recalc); })).toBe('42501');
    expect(await vinculoDe(c.vinculoId)).toMatchObject({ confidentialFrom: antes?.confidentialFrom, representUntil: antes?.representUntil });
    // A marca só vale na transação que mudou a data, antes do recálculo; e a data mudar de novo depois a zera.
    expect(await codigo(prof.userId, (tx) => tx.execute(marca))).toBe('55000');
    expect(await codigo(prof.userId, async (tx) => { await tx.execute(troca(doador)); await tx.execute(recalc); await tx.execute(marca); })).toBe('42501');
    expect(await codigo(prof.userId, async (tx) => { await tx.execute(troca(doador)); await tx.execute(marca); await tx.execute(troca(outro)); await tx.execute(recalc); })).toBe('42501');
    // 0053: a recepção (registrada no banco) não põe a marca, nem na ordem certa.
    expect(await codigo(recepcao.userId, async (tx) => { await tx.execute(troca(doador)); await tx.execute(marca); await tx.execute(recalc); })).toBe('42501');
    // A sessão do portal não marca.
    expect(
      await api.db.db
        .transaction(async (tx) => {
          await tx.execute(sql`select app_set_portal_session(${c.contaId}::uuid, ${c.vinculoId}::uuid)`);
          await tx.execute(marca);
        })
        .then(
          () => 'ok',
          (e: { cause?: { code?: string } }) => e.cause?.code,
        ),
    ).toBe('42501');
    expect(await vinculoDe(c.vinculoId)).toMatchObject({ confidentialFrom: antes?.confidentialFrom, representUntil: antes?.representUntil });
    // Com a marca: o recálculo vale, e a trilha registra quem conferiu (sem a data).
    expect(await codigo(prof.userId, async (tx) => { await tx.execute(troca(doador)); await tx.execute(marca); await tx.execute(recalc); })).toBe('ok');
    expect(await vinculoDe(c.vinculoId)).toMatchObject({ confidentialFrom: '2093-01-01', representUntil: '2099-01-01' });
    const conf = (await trilhaDe(teen)).filter((t) => (t.metadata as { op?: string }).op === 'birth_date_document_checked');
    expect(conf.map((t) => [t.actorId, (t.metadata as { role?: string }).role])).toEqual([[prof.userId, 'profissional']]);
    // Direção segura (sem recálculo): o COMMIT fecha sem exigir nada.
    expect(await codigo(recepcao.userId, (tx) => tx.execute(troca(outro)))).toBe('ok');
  });
});

describe('Conferência 0052 (ressalvas 1, 2, 3 e 5): perfil de quem confere, data desconhecida, 422 único e atendimento que grava a data', () => {
  const corrigir = (c: SessaoPortal, corpo: Record<string, unknown>) => api.http().post('/portal/meus-dados/correcao').set(cab(c)).send(corpo);
  const situacao = (id: string, corpo: Record<string, unknown>) => api.http().post(`/clinica/portal/solicitacoes/${id}/situacao`).set(cab(adminA)).send(corpo);
  const nascimentoDe = async (pac: string) => ((await api.http().get(`/pacientes/${pac}`).set(cab(adminA)).expect(200)).body as { nascimento: string | null }).nascimento;
  const vinculoDe = async (id: string) =>
    (await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(portalLinks).where(eq(portalLinks.id, id)), adminA.userId))[0];
  const pedidoDe = async (id: string) =>
    (await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(portalRightsRequests).where(eq(portalRightsRequests.id, id)), adminA.userId))[0];
  const trilhaDe = async (pac: string) =>
    withTenant(api.db.db, clinicaA, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.scope, 'patients'), sql`${auditLog.metadata}->>'patient_id' = ${pac}`)).orderBy(sql`seq`), adminA.userId);
  const avisos = async (pac: string) =>
    withTenant(api.db.db, clinicaA, (tx) => tx.select().from(clinicalNotices).where(and(eq(clinicalNotices.kind, 'portal_sigilo_transicao'), eq(clinicalNotices.patientId, pac))), api.fundador(clinicaA));
  const codigo = async (userId: string, fn: (tx: TenantTx) => Promise<unknown>) => {
    try {
      await withTenant(api.db.db, clinicaA, fn, userId);
      return 'ok';
    } catch (e) {
      return (e as { cause?: { code?: string }; code?: string }).cause?.code ?? (e as { code?: string }).code;
    }
  };
  const ERRO_422 = { statusCode: 422, message: 'Regra não atendida', codigo: 'documento_nao_conferido', campos: ['documentoConferido'] };

  it('ressalva 2: PATCH com a data atual desconhecida (nula ou ilegível) exige documento, até para criança; apagar não exige', async () => {
    // Nula: paciente cadastrado sem data.
    const semData = await criarPaciente(adminA, 'Lis Ficticia Sem Data');
    const crianca = nascidoHa(7);
    for (const extra of [{}, { documentoConferido: false }]) {
      const r = await api.http().patch(`/pacientes/${semData}`).set(cab(adminA)).send({ nascimento: crianca, ...extra }).expect(422);
      expect(r.body).toEqual(ERRO_422);
    }
    expect(await nascimentoDe(semData)).toBeNull();
    await api.http().patch(`/pacientes/${semData}`).set(cab(adminA)).send({ nascimento: crianca, documentoConferido: true }).expect(200);
    expect(await nascimentoDe(semData)).toBe(crianca);
    expect((await trilhaDe(semData)).find((t) => (t.metadata as { changed?: string }).changed === 'birth_date')?.metadata).toMatchObject({
      document_required: true,
      document_checked: true,
    });

    // Ilegível: cifra válida, mas amarrada a OUTRO paciente (AAD). Não é 500: conta como desconhecida.
    const ilegivel = await criarPaciente(adminA, 'Rui Ficticio Data Ilegivel', { nascimento: nascidoHa(8) });
    const cifra = api.app.get<FieldCipher<TenantTx>>(FIELD_CIPHER);
    const estragar = () =>
      withTenant(api.db.db, clinicaA, async (tx) => {
        const enc = await cifra.encrypt(tx, patientFieldRef(clinicaA, randomUUID(), 'birth_date'), nascidoHa(8));
        await tx.update(patients).set({ birthDateEnc: enc }).where(eq(patients.id, ilegivel));
      }, adminA.userId);
    await estragar();
    const r = await api.http().patch(`/pacientes/${ilegivel}`).set(cab(adminA)).send({ nascimento: nascidoHa(8) }).expect(422);
    expect(r.body).toEqual(ERRO_422);
    await api.http().patch(`/pacientes/${ilegivel}`).set(cab(adminA)).send({ nascimento: nascidoHa(8), documentoConferido: true }).expect(200);
    expect(await nascimentoDe(ilegivel)).toBe(nascidoHa(8));
    const upd = (await trilhaDe(ilegivel)).filter((t) => (t.metadata as { changed?: string }).changed === 'birth_date');
    expect(upd.at(-1)?.metadata).toMatchObject({ document_required: true, document_checked: true, birth_date_unreadable: true });
    // Apagar a data ilegível não exige documento (o recálculo fecha), e reescreve a coluna.
    await estragar();
    await api.http().patch(`/pacientes/${ilegivel}`).set(cab(adminA)).send({ nascimento: null }).expect(200);
    expect(await nascimentoDe(ilegivel)).toBeNull();
    const trilha = await trilhaDe(ilegivel);
    expect(JSON.stringify(trilha)).not.toContain(nascidoHa(8));
  });

  it('ressalva 5: ATENDER a correção grava a data no cadastro na mesma transação, com o recálculo da 0038, a marca e o perfil', async () => {
    const nasc = nascidoHa(15);
    const teen = await criarPaciente(adminA, 'Ivo Ficticio Atende', { nascimento: nasc });
    const c = await contaDe(adminA, teen, { agindoComo: 'responsavel_legal', responsavelId: await responsavelDe(teen, 'Ema Ficticia Mae Atende') });
    const antes = await vinculoDe(c.vinculoId);
    const proposto = nascidoHa(11);
    const ped = (await corrigir(c, { detalhe: 'Data ficticia errada', nascimento: proposto }).expect(201)).body as { id: string };
    // Em andamento e recusa não tocam o cadastro.
    await situacao(ped.id, { situacao: 'em_andamento' }).expect(200);
    expect(await nascimentoDe(teen)).toBe(nasc);
    // Sem a conferência: 422 único; nada muda (nem o cadastro, nem o sigilo, nem o pedido).
    expect((await situacao(ped.id, { situacao: 'atendida', resposta: 'Resposta ficticia QZX' }).expect(422)).body).toEqual(ERRO_422);
    expect(await nascimentoDe(teen)).toBe(nasc);
    expect(await vinculoDe(c.vinculoId)).toMatchObject({ confidentialFrom: antes?.confidentialFrom, representUntil: antes?.representUntil });
    expect(await pedidoDe(ped.id)).toMatchObject({ status: 'em_andamento', documentCheckedAt: null, documentCheckedRole: null });

    await situacao(ped.id, { situacao: 'atendida', resposta: 'Resposta ficticia QZX', documentoConferido: true }).expect(200);
    expect(await nascimentoDe(teen)).toBe(proposto);
    expect(await pedidoDe(ped.id)).toMatchObject({ status: 'atendida', documentCheckedBy: adminA.userId, documentCheckedRole: 'admin' });
    // Recálculo da 0038 com a data nova (sigilo desligado: 11 anos) e aviso da 0039.
    const depois = await vinculoDe(c.vinculoId);
    expect((depois?.confidentialFrom ?? '') > hojeNaClinica()).toBe(true);
    expect((await avisos(teen)).some((a) => a.portalTransition === 'sigilo_desligado')).toBe(true);
    // Trilha: update do cadastro com o pedido, a marca com o perfil; nunca a data.
    const trilha = await trilhaDe(teen);
    const upd = trilha.find((t) => (t.metadata as { changed?: string }).changed === 'birth_date');
    expect(upd?.actorId).toBe(adminA.userId);
    expect(upd?.metadata).toMatchObject({ request_id: ped.id, document_required: true, document_checked: true });
    const conf = trilha.filter((t) => (t.metadata as { op?: string }).op === 'birth_date_document_checked');
    expect(conf.map((t) => [t.actorId, (t.metadata as { role?: string }).role])).toEqual([[adminA.userId, 'admin']]);
    const ultimo = (
      await withTenant(api.db.db, clinicaA, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.scope, 'portal_rights_requests'), sql`${auditLog.metadata}->>'request_id' = ${ped.id}`)).orderBy(sql`seq`), adminA.userId)
    ).at(-1);
    expect(ultimo?.metadata).toMatchObject({ to: 'atendida', document_checked: true, birth_date_applied: true });
    expect(JSON.stringify(trilha)).not.toContain(proposto);
    expect(JSON.stringify(trilha)).not.toContain(nasc);
  });

  it('ressalva 3: o cadastro mudou depois da abertura e a data proposta passou a reduzir a idade: o mesmo 422 ao atender', async () => {
    const pac = await criarPaciente(adminA, 'Ari Ficticio Depois', { nascimento: '1991-05-06' });
    const p = await contaDe(adminA, pac);
    // Na abertura, a proposta AUMENTA a idade: não exige documento.
    const ped = (await corrigir(p, { detalhe: 'Ano ficticio', nascimento: '1990-05-06' }).expect(201)).body as { id: string };
    expect((await pedidoDe(ped.id))?.documentRequired).toBe(false);
    // A clínica muda o cadastro para uma data mais antiga (aumento: sem documento).
    await api.http().patch(`/pacientes/${pac}`).set(cab(adminA)).send({ nascimento: '1985-05-06' }).expect(200);
    // Agora aplicar a proposta reduz a idade de um adulto: falha fechada, 422 único.
    expect((await situacao(ped.id, { situacao: 'atendida', resposta: 'Resposta ficticia QZX' }).expect(422)).body).toEqual(ERRO_422);
    expect(await nascimentoDe(pac)).toBe('1985-05-06');
    await situacao(ped.id, { situacao: 'atendida', resposta: 'Resposta ficticia QZX', documentoConferido: true }).expect(200);
    expect(await nascimentoDe(pac)).toBe('1990-05-06');
  });

  it('ressalva 1 no banco: conferência do pedido por SQL exige perfil admin/profissional; o perfil é do banco e imutável', async () => {
    const pac = await criarPaciente(adminA, 'Bia Ficticia Perfil', { nascimento: '1990-03-04' });
    const p = await contaDe(adminA, pac);
    const ped = (await corrigir(p, { detalhe: 'Ano ficticio', nascimento: '1989-03-04' }).expect(201)).body as { id: string };
    const recepcao = await api.membro(clinicaA, api.sessao(clinicaA, 'recepcao'), 'recepcao');
    const prof = await api.membro(clinicaA, api.sessao(clinicaA, 'profissional'), 'profissional');
    const conferir = (userId: string, extra: Record<string, unknown> = {}) => (tx: TenantTx) =>
      tx
        .update(portalRightsRequests)
        .set({ status: 'em_andamento', handledBy: userId, handledAt: sql`now()`, documentCheckedBy: userId, documentCheckedAt: sql`now()`, ...extra })
        .where(eq(portalRightsRequests.id, ped.id));
    // A recepção (registrada no banco) não confere; perfil sem conferência também é recusado.
    expect(await codigo(recepcao.userId, conferir(recepcao.userId))).toBe('42501');
    expect(
      await codigo(prof.userId, (tx) =>
        tx.update(portalRightsRequests).set({ status: 'em_andamento', handledBy: prof.userId, handledAt: sql`now()`, documentCheckedRole: 'admin' }).where(eq(portalRightsRequests.id, ped.id)),
      ),
    ).toBe('42501');
    // O profissional confere; o perfil informado por quem grava é ignorado (o banco grava o de clinic_members).
    expect(await codigo(prof.userId, conferir(prof.userId, { documentCheckedRole: 'admin' }))).toBe('ok');
    expect(await pedidoDe(ped.id)).toMatchObject({ documentCheckedBy: prof.userId, documentCheckedRole: 'profissional' });
    // Depois, imutável.
    expect(
      await codigo(adminA.userId, (tx) =>
        tx.update(portalRightsRequests).set({ handledBy: adminA.userId, handledAt: sql`now()`, status: 'recusada', answerEnc: 'v1:x', documentCheckedRole: 'admin' }).where(eq(portalRightsRequests.id, ped.id)),
      ),
    ).toBe('42501');
    // Pela API, a recepção nem chega à rota (titular:atender é do dono).
    await api.http().post(`/clinica/portal/solicitacoes/${ped.id}/situacao`).set(cab(recepcao)).send({ situacao: 'atendida', resposta: 'Resposta ficticia QZX' }).expect(403);
  });
});
