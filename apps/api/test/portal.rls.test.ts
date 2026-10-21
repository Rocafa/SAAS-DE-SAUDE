/**
 * PORTAL DO PACIENTE (rodada 18.1; veto B3 do front-r8) contra Postgres REAL (DATABASE_URL = app_user,
 * migrações aplicadas). Dados 100% fictícios, gerados a cada execução.
 *
 * Prova: o paciente A nunca vê dados do B (mesma clínica e outra clínica), convite expira e é de uso
 * único, consulta alheia dá 404, nenhum cabeçalho/parâmetro escolhe paciente ou clínica, pedido do
 * titular registrado e visível só para a clínica certa, consentimento em histórico, defesa no banco
 * (policies restritivas portal_titular/portal_fora e gatilho da agenda), limite por conta e trilha.
 */
import type { TenantId } from '@plataforma/shared';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, encounters, patients, portalConsents, portalInvites, portalLinks, portalRightsRequests } from '../src/db/schema';
import { withTenant } from '../src/db/tenant-transaction';
import { verifyAuditChain } from '../src/modules/audit/audit-chain';
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

async function resgatar(p: SessaoPortal, token: string): Promise<{ status: number; vinculoId?: string; codigo?: string }> {
  const r = await api.http().post('/portal/convites/resgate').set(cab(p)).send({ token });
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

beforeAll(async () => {
  api = await subirApi();
  clinicaA = await api.novaClinica();
  clinicaB = await api.novaClinica();
  adminA = api.sessao(clinicaA, 'admin');
  adminB = api.sessao(clinicaB, 'admin');
  const profA = (await api.http().post('/profissionais').set(cab(adminA)).send({ nome: 'Prof Ficticia A', especialidade: 'Fisioterapia' })).body as { id: string };
  const tipoA = (await api.http().post('/tipos-atendimento').set(cab(adminA)).send({ nome: 'Sessao', minutos: 30 })).body as { id: string };
  const profB = (await api.http().post('/profissionais').set(cab(adminB)).send({ nome: 'Prof Ficticio B', especialidade: 'Psicologia' })).body as { id: string };
  const tipoB = (await api.http().post('/tipos-atendimento').set(cab(adminB)).send({ nome: 'Sessao B', minutos: 30 })).body as { id: string };
  pacA1 = await criarPaciente(adminA, 'Ana Ficticia Portal', { cpf: cpfFicticio(41), nascimento: '1990-03-04' });
  pacA2 = await criarPaciente(adminA, 'Bruno Ficticio Vizinho', { cpf: cpfFicticio(42) });
  pacB1 = await criarPaciente(adminB, 'Ana Ficticia Outra Clinica');
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
    expect(r.body).toEqual({ nome: 'Ana Ficticia Portal', nomeSocial: null, telefone: '11900001111', cpfMascarado: `***.***.***-${cpfFicticio(41).slice(9)}`, nascimento: '1990-03-04' });
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
      tx.select().from(auditLog).where(and(eq(auditLog.actorId, p.contaId), eq(auditLog.action, 'anomaly_alert'))), adminA.userId);
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
    const proprio = await contaDe(adminA, pacMenor);
    expect((await api.http().post('/portal/privacidade/consentimentos/lembretes_whatsapp').set(cab(proprio)).send({ resposta: 'sim' })).body).toMatchObject({
      codigo: 'consentimento_pelo_responsavel',
    });
    const resp = await contaDe(adminA, pacMenor, { agindoComo: 'responsavel_legal' });
    await api.http().post('/portal/privacidade/consentimentos/lembretes_whatsapp').set(cab(resp)).send({ resposta: 'sim' }).expect(200);
    const hist = await api.http().get('/portal/privacidade/consentimentos/lembretes_whatsapp/historico').set(cab(resp)).expect(200);
    expect(hist.body).toEqual([expect.objectContaining({ resposta: 'sim', agindoComo: 'responsavel_legal' })]);
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
      const adm = api2.sessao(clinicaA, 'admin');
      const c = await api2.http().post('/clinica/portal/convites').set(cab(adm)).send({ pacienteId: pacA1 }).expect(201);
      const p = api2.sessaoPortal();
      await api2.http().post('/portal/convites/resgate').set(cab(p)).send({ token: (c.body as { token: string }).token }).expect(200);
      const codigos: number[] = [];
      for (let i = 0; i < 5; i++) codigos.push((await api2.http().get('/portal/consultas').set(cab(p))).status);
      expect(codigos).toEqual([200, 200, 200, 429, 429]);
      const alertas = await withTenant(api2.db.db, clinicaA, (tx) =>
        tx.select().from(auditLog).where(and(eq(auditLog.actorId, p.contaId), eq(auditLog.action, 'anomaly_alert'))),
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
