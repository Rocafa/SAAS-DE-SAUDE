/**
 * R4 do parecer do #119 (03/11/2026): a prova de alcance da análise estática é fraca para leitura. Aqui cada rota de
 * `AUDITADAS_LEITURA` é chamada de verdade, contra Postgres real, e tem de gravar uma linha nova na trilha da clínica
 * com o mesmo ator e ação `read` (ou `export`, que é mais forte). Rota auditada sem plano aqui falha o teste com o nome.
 * Dados 100% fictícios.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { TenantId } from '@plataforma/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appointments, auditLog, portalInvites, portalRightsRequests } from '../src/db/schema';
import { withTenant, type TenantTx } from '../src/db/tenant-transaction';
import { FIELD_CIPHER } from '../src/modules/crypto/crypto.module';
import type { FieldCipher } from '../src/modules/crypto/field-cipher';
import { TERMO_MIGRACAO_VERSAO } from '../src/modules/imports/importacao-regras';
import { cifrarCampoPortal } from '../src/modules/portal/portal-fields';
import { hashDoCodigo } from '../src/modules/portal/portal-otp';
import { AUDITADAS_LEITURA } from './cobertura-auditoria/lista';
import { cab, cpfFicticio, subirApi, type ApiDeTeste } from './apoio-api';

type Cabecalho = { Authorization: string };
/** Como chamar a rota: quem chama, a URL com ids e query, e o id do ator na trilha. */
type Plano = { readonly s: Cabecalho; readonly url: string; readonly ator: string };

let api: ApiDeTeste;
let clinica: TenantId;
const planos = new Map<string, Plano>();

const id = (r: { body: unknown }) => (r.body as { id: string }).id;

beforeAll(async () => {
  api = await subirApi();
  clinica = await api.novaClinica();
  const admin = await api.membro(clinica, api.sessao(clinica, 'admin', 'profissional'), 'admin', 'profissional');
  const s = admin;
  const post = (url: string, corpo: object = {}) => api.http().post(url).set(cab(s)).send(corpo);

  const prof = await post('/profissionais', { nome: 'Prof Ficticia Leitura', especialidade: 'Terapia ocupacional', usuarioId: admin.userId });
  expect(prof.status, JSON.stringify(prof.body)).toBe(201);
  const profId = id(prof);
  const tipoId = id(await post('/tipos-atendimento', { nome: 'Avaliacao', minutos: 40 }));
  const pac = await post('/pacientes', { nome: 'Paciente Ficticia Leitura', cpf: cpfFicticio(21), telefone: '11900000021', nascimento: '2001-01-02' });
  expect(pac.status, JSON.stringify(pac.body)).toBe(201);
  const pacienteId = id(pac);
  const ag = await post('/agendamentos', { pacienteId, profissionalId: profId, tipoId, data: '2030-05-06', hora: '08:00' });
  expect(ag.status, JSON.stringify(ag.body)).toBe(201);
  const agId = id(ag);
  await api.http().post(`/agendamentos/${agId}/check-in`).set(cab(s)).expect(200);

  // Convênio, guia com consumo; pacote com consumo.
  const convenioId = id(await post('/convenios', { nome: 'Operadora Ficticia Leitura' }));
  const guia = await post('/guias', { pacienteId, convenioId, numero: 'FIC-LEI-0001', senha: 'SENHALEI', carteirinha: 'CART-LEI-1', sessoesAutorizadas: 5, validade: '2099-12-31' });
  expect(guia.status, JSON.stringify(guia.body)).toBe(201);
  const guiaId = id(guia);
  expect((await post(`/guias/${guiaId}/consumos`, { agendamentoId: agId })).status).toBe(201);
  const ag2Id = id(await post('/agendamentos', { pacienteId, profissionalId: profId, tipoId, data: '2030-05-07', hora: '08:00' }));
  await api.http().post(`/agendamentos/${ag2Id}/check-in`).set(cab(s)).expect(200);
  const pacoteId = id(await post('/pacotes', { pacienteId, nome: 'Pacote Ficticio Leitura', total: 4 }));
  expect((await post(`/pacotes/${pacoteId}/consumos`, { agendamentoId: ag2Id })).status).toBe(201);

  // Prontuário: atendimento finalizado (agendamento em andamento agora) e uma nota privada do autor.
  const ag3 = randomUUID();
  const recepcao = randomUUID();
  await withTenant(
    api.db.db,
    clinica,
    (tx) =>
      tx.insert(appointments).values({
        createdBy: recepcao,
        id: ag3,
        tenantId: clinica,
        patientId: pacienteId,
        professionalId: profId,
        appointmentTypeId: tipoId,
        startsAt: new Date(Date.now() - 10 * 60_000),
        endsAt: new Date(Date.now() + 30 * 60_000),
        status: 'checked_in',
      }),
    recepcao,
  );
  const at = await post('/atendimentos', { agendamentoId: ag3 });
  expect(at.status, JSON.stringify(at.body)).toBe(200);
  const atId = id(at);
  await api.http().put(`/atendimentos/${atId}/registro`).set(cab(s)).send({ versaoBase: 0, conteudo: { queixa: 'Queixa ficticia' } }).expect(200);
  const nota = await post(`/pacientes/${pacienteId}/notas-privadas`, { texto: 'Nota privada ficticia de leitura' });
  expect(nota.status, JSON.stringify(nota.body)).toBe(201);
  const notaId = id(nota);

  // Custódia: autor e substituto psicólogos; designada pelo admin e aceita pelo substituto.
  const psiAutor = await api.membro(clinica, api.sessao(clinica, 'profissional'), 'profissional', 'psicologo');
  const psiSubst = await api.membro(clinica, api.sessao(clinica, 'profissional'), 'profissional', 'psicologo');
  const autorId = id(await post('/profissionais', { nome: 'Psi Autor Ficticio', especialidade: 'Psicologia', usuarioId: psiAutor.userId }));
  const substId = id(await post('/profissionais', { nome: 'Psi Subst Ficticio', especialidade: 'Psicologia', usuarioId: psiSubst.userId }));
  const cust = await post('/prontuario/custodias', { autorProfissionalId: autorId, substitutoProfissionalId: substId });
  expect(cust.status, JSON.stringify(cust.body)).toBe(201);
  const custodiaId = id(cust);
  await api.http().post(`/custodias/${custodiaId}/aceite`).set(cab(psiSubst)).send({}).expect(200);

  // Financeiro: caixa, cobrança sem pagador terceiro, recebimento com recibo.
  await api.http().put('/financeiro/configuracao').set(cab(s)).send({ atendimentoPadrao: 'pf', emitenteNome: 'Clinica Ficticia Leitura' }).expect(200);
  await api.http().put(`/financeiro/profissionais/${profId}/perfil-fiscal`).set(cab(s)).send({ cpf: cpfFicticio(22), registroConselho: 'CREFITO-0 00000-TO' }).expect(200);
  const caixa = await post('/financeiro/caixas', { turno: 'unico', trocoInicialCentavos: 1000 });
  expect(caixa.status, JSON.stringify(caixa.body)).toBe(201);
  const cobranca = await post('/financeiro/cobrancas', { agendamentoId: agId, valorCentavos: 10000 });
  expect(cobranca.status, JSON.stringify(cobranca.body)).toBe(201);
  const cobrancaId = id(cobranca);
  const pg = await post(`/financeiro/cobrancas/${cobrancaId}/recebimentos`, { forma: 'pix' });
  expect(pg.status, JSON.stringify(pg.body)).toBe(201);
  const recibo = await post(`/financeiro/recebimentos/${id(pg)}/recibo`);
  expect(recibo.status, JSON.stringify(recibo.body)).toBe(200);
  const reciboId = id(recibo);

  // Responsável e pedido de sigilo listável; opt-in do WhatsApp.
  const resp = await post(`/pacientes/${pacienteId}/responsaveis`, { nome: 'Responsavel Ficticio Leitura', telefone: '11900000023', tipo: 'pai_mae', cienciaDoPaciente: true, confirmaPacienteMaior: true });
  expect(resp.status, JSON.stringify(resp.body)).toBe(201);
  const vinculoId = id(resp);
  const opt = await post(`/pacientes/${pacienteId}/whatsapp/opt-in`, { destinatario: 'paciente', meio: 'formulario_assinado', comprovante: 'Termo ficticio leitura 1' });
  expect(opt.status, JSON.stringify(opt.body)).toBe(201);

  // Importação aplicada.
  const lote = await api
    .http()
    .post(`/importacoes?tipo=pacientes&termo=${TERMO_MIGRACAO_VERSAO}`)
    .set(cab(s))
    .set('Content-Type', 'text/csv; charset=utf-8')
    .send('nome;telefone\nPaciente Ficticio Importado Leitura;11900000024\n');
  expect(lote.status, JSON.stringify(lote.body)).toBe(201);
  const loteId = id(lote);
  await api.http().put(`/importacoes/${loteId}/mapeamento`).set(cab(s)).send({ mapeamento: { nome: 0, telefone: 1 } }).expect(200);
  await api.http().post(`/importacoes/${loteId}/validar`).set(cab(s)).send({}).expect(200);

  // Suporte: uma autorização listável.
  expect((await post('/suporte/autorizacoes', { chamado: 'SUP-4321', horas: 2 })).status).toBe(201);

  // Portal: convite, resgate e pedido do titular, direto pelo banco (o resgate pela rota decifra o telefone).
  const contaPortal = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const codigoHash = hashDoCodigo(token, '123456');
  await withTenant(
    api.db.db,
    clinica,
    (tx) => tx.insert(portalInvites).values({ tenantId: clinica, patientId: pacienteId, tokenHash, actingAs: 'titular', expiresAt: sql`now() + interval '1 day'`, createdBy: admin.userId }),
    admin.userId,
  );
  await api.db.db.transaction((tx) => tx.execute(sql`select invite_id from app_portal_invite_challenge(${contaPortal}::uuid, ${tokenHash}, ${codigoHash})`));
  const portalLink = await api.db.db.transaction(async (tx) => {
    const r = await tx.execute<{ v: string | null }>(sql`select app_portal_redeem_invite(${contaPortal}::uuid, ${tokenHash}, ${codigoHash}) as v`);
    return r[0]?.v ?? null;
  });
  expect(portalLink).toMatch(/^[0-9a-f-]{36}$/);
  const pedidoId = randomUUID();
  const cifra = api.app.get<FieldCipher<TenantTx>>(FIELD_CIPHER);
  await api.db.db.transaction(async (tx) => {
    await tx.execute(sql`select app_set_portal_session(${contaPortal}::uuid, ${portalLink}::uuid)`);
    await tx.insert(portalRightsRequests).values({
      id: pedidoId,
      tenantId: clinica,
      patientId: pacienteId,
      linkId: portalLink as string,
      accountId: contaPortal,
      kind: 'acesso',
      actingAs: 'titular',
      protocol: '20301231-ABCDEF02',
      detailEnc: await cifrarCampoPortal(cifra, tx, clinica, null, pedidoId, 'detail', 'Pedido ficticio de leitura'),
    });
  });
  const portal = api.sessaoPortal(contaPortal);
  const recibosDoPortal = await api.http().get('/portal/recibos').set(cab(portal));
  expect(recibosDoPortal.status, JSON.stringify(recibosDoPortal.body)).toBe(200);
  const reciboPortalId = (recibosDoPortal.body as { id: string }[])[0]?.id;
  expect(reciboPortalId, 'o recibo do paciente tem de aparecer no portal').toBeDefined();

  const c = (url: string): Plano => ({ s, url, ator: admin.userId });
  const p = (url: string): Plano => ({ s: portal, url, ator: contaPortal });
  const planosDaClinica: Record<string, Plano> = {
    'GET /agendamentos': c('/agendamentos?de=2030-05-05&ate=2030-05-11'),
    'GET /clinica/auditoria': c('/clinica/auditoria?limite=5'),
    'GET /atendimentos/:id': c(`/atendimentos/${atId}`),
    'GET /atendimentos/:id/versoes': c(`/atendimentos/${atId}/versoes`),
    'GET /clinica/portal/pacientes/:id/consentimentos': c(`/clinica/portal/pacientes/${pacienteId}/consentimentos`),
    'GET /clinica/portal/pacientes/:id/vinculos': c(`/clinica/portal/pacientes/${pacienteId}/vinculos`),
    'GET /clinica/portal/solicitacoes': c('/clinica/portal/solicitacoes'),
    'GET /clinica/portal/solicitacoes/:id': c(`/clinica/portal/solicitacoes/${pedidoId}`),
    'GET /convenios': c('/convenios'),
    'GET /convenios/:id/relatorio': c(`/convenios/${convenioId}/relatorio?de=2030-05-01&ate=2030-05-30`),
    'GET /custodias/:id/notas': { s: psiSubst, url: `/custodias/${custodiaId}/notas`, ator: psiSubst.userId },
    'GET /financeiro/caixas': c('/financeiro/caixas'),
    'GET /financeiro/caixas/:id': c(`/financeiro/caixas/${id(caixa)}`),
    'GET /financeiro/cobrancas/:id': c(`/financeiro/cobrancas/${cobrancaId}`),
    'GET /financeiro/configuracao': c('/financeiro/configuracao'),
    'GET /financeiro/contas-a-receber': c('/financeiro/contas-a-receber?de=2030-05-01&ate=2030-05-30'),
    'GET /financeiro/profissionais/:id/perfil-fiscal': c(`/financeiro/profissionais/${profId}/perfil-fiscal`),
    'GET /financeiro/recibos': c(`/financeiro/recibos?de=${new Date().toISOString().slice(0, 10)}&ate=${new Date().toISOString().slice(0, 10)}`),
    'GET /financeiro/recibos/:id': c(`/financeiro/recibos/${reciboId}`),
    'GET /guias': c('/guias'),
    'GET /guias/:id': c(`/guias/${guiaId}`),
    'GET /guias/:id/consumos': c(`/guias/${guiaId}/consumos`),
    'GET /guias/alertas': c('/guias/alertas'),
    'GET /importacoes': c('/importacoes'),
    'GET /importacoes/:id': c(`/importacoes/${loteId}`),
    'GET /importacoes/:id/divergencias': c(`/importacoes/${loteId}/divergencias`),
    'GET /notas-privadas/:id': c(`/notas-privadas/${notaId}`),
    'GET /pacientes': c('/pacientes'),
    'GET /pacientes/:id': c(`/pacientes/${pacienteId}`),
    'GET /pacientes/:id/notas-privadas': c(`/pacientes/${pacienteId}/notas-privadas`),
    'GET /pacientes/:id/prontuario': c(`/pacientes/${pacienteId}/prontuario`),
    'GET /pacientes/:id/responsaveis': c(`/pacientes/${pacienteId}/responsaveis`),
    'GET /pacientes/:id/responsaveis/:vinculoId/historico': c(`/pacientes/${pacienteId}/responsaveis/${vinculoId}/historico`),
    'GET /pacientes/:id/responsaveis/sigilo': c(`/pacientes/${pacienteId}/responsaveis/sigilo`),
    'GET /pacientes/:id/whatsapp/opt-in': c(`/pacientes/${pacienteId}/whatsapp/opt-in`),
    'GET /pacotes': c('/pacotes'),
    'GET /pacotes/:id': c(`/pacotes/${pacoteId}`),
    'GET /pacotes/:id/historico': c(`/pacotes/${pacoteId}/historico`),
    'GET /prontuario/configuracao': c('/prontuario/configuracao'),
    'GET /suporte/autorizacoes': c('/suporte/autorizacoes'),
    'GET /whatsapp/envios': c('/whatsapp/envios?de=2030-05-01&ate=2030-05-07'),
    'GET /portal/consultas': p('/portal/consultas'),
    'GET /portal/documentos': p('/portal/documentos'),
    'GET /portal/meus-dados': p('/portal/meus-dados'),
    'GET /portal/privacidade/consentimentos': p('/portal/privacidade/consentimentos'),
    'GET /portal/privacidade/consentimentos/:finalidade/historico': p('/portal/privacidade/consentimentos/escriba_ia/historico'),
    'GET /portal/recibos': p('/portal/recibos'),
    'GET /portal/recibos/:id': p(`/portal/recibos/${reciboPortalId}`),
    'GET /portal/sessao': p('/portal/sessao'),
    'GET /portal/solicitacoes': p('/portal/solicitacoes'),
    'GET /portal/vinculos': p('/portal/vinculos'),
  };
  for (const [rota, plano] of Object.entries(planosDaClinica)) planos.set(rota, plano);
}, 240_000);

afterAll(async () => {
  await api?.fechar();
});

/** Linhas de leitura (read ou export) do ator na trilha da clínica. */
async function leiturasDo(ator: string): Promise<number> {
  const linhas = await withTenant(api.db.db, clinica, (tx) =>
    tx
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, clinica), eq(auditLog.actorId, ator), inArray(auditLog.action, ['read', 'export']))),
  );
  return linhas.length;
}

describe('R4 do #119: toda rota de leitura auditada grava a linha de leitura de verdade', () => {
  it('toda rota de AUDITADAS_LEITURA tem plano neste teste (e não sobra plano)', () => {
    expect(AUDITADAS_LEITURA.filter((r) => !planos.has(r)), 'rota de leitura auditada sem plano no teste RLS').toEqual([]);
    expect([...planos.keys()].filter((r) => !AUDITADAS_LEITURA.includes(r)), 'plano de rota que não está em AUDITADAS_LEITURA').toEqual([]);
  });

  it.each([...AUDITADAS_LEITURA])('%s responde 200 e grava uma linha de leitura do mesmo ator', async (rota) => {
    const plano = planos.get(rota);
    expect(plano, `${rota}: sem plano`).toBeDefined();
    if (!plano) return;
    const antes = await leiturasDo(plano.ator);
    const r = await api.http().get(plano.url).set(cab(plano.s));
    expect(r.status, `${rota}: ${JSON.stringify(r.body).slice(0, 300)}`).toBe(200);
    expect(await leiturasDo(plano.ator), `${rota}: não gravou linha de leitura`).toBeGreaterThan(antes);
  });
});
