/**
 * Regra 1 da D4 (requisito do Guardião): a clínica vem SEMPRE da sessão guardada no servidor, nunca
 * de cabeçalho, parâmetro ou corpo enviado pelo cliente. Também: toda rota de domínio exige sessão.
 * Contra Postgres REAL (DATABASE_URL = app_user, migrações aplicadas). Dados 100% fictícios.
 */
import type { TenantId } from '@plataforma/shared';
import { RequestMethod } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cab, subirApi, type ApiDeTeste } from '../apoio-api';

let api: ApiDeTeste;
let clinicaA: TenantId;
let clinicaB: TenantId;
let recepA: { Authorization: string; userId: string };
let pacienteB: string;

const CABECALHOS_DE_CLINICA = ['x-tenant-id', 'x-clinica-id', 'x-org-id', 'x-zitadel-orgid', 'tenant-id'];

beforeAll(async () => {
  api = await subirApi();
  clinicaA = await api.novaClinica();
  clinicaB = await api.novaClinica();
  recepA = api.sessao(clinicaA, 'recepcao');
  const adminB = api.sessao(clinicaB, 'admin');
  const res = await api.http().post('/pacientes').set(cab(adminB)).send({ nome: 'Paciente Ficticio B', telefone: '11900000002' });
  expect(res.status).toBe(201);
  pacienteB = (res.body as { id: string }).id;
});

afterAll(async () => {
  await api?.fechar();
});

describe('tenant só da sessão (D4, regra 1)', () => {
  it('cabeçalho de clínica forjado é ignorado: a sessão de A continua vendo só A', async () => {
    let req = api.http().get('/pacientes').set(cab(recepA));
    for (const h of CABECALHOS_DE_CLINICA) req = req.set(h, clinicaB);
    const res = await req.expect(200);
    expect((res.body as { itens: { id: string }[] }).itens.map((p) => p.id)).not.toContain(pacienteB);

    let det = api.http().get(`/pacientes/${pacienteB}`).set(cab(recepA));
    for (const h of CABECALHOS_DE_CLINICA) det = det.set(h, clinicaB);
    await det.expect(404);

    const sessao = await api.http().get('/sessao').set(cab(recepA)).set('x-tenant-id', clinicaB).expect(200);
    expect(sessao.body).toMatchObject({ clinicaId: clinicaA, perfis: ['recepcao'] });
  });

  it('escrita com cabeçalho de outra clínica grava na clínica da sessão', async () => {
    const res = await api
      .http()
      .post('/pacientes')
      .set(cab(recepA))
      .set('x-tenant-id', clinicaB)
      .send({ nome: 'Paciente Ficticio Cabecalho', telefone: '11900000003' })
      .expect(201);
    const id = (res.body as { id: string }).id;
    await api.http().get(`/pacientes/${id}`).set(cab(recepA)).expect(200);
    const adminB = api.sessao(clinicaB, 'admin');
    await api.http().get(`/pacientes/${id}`).set(cab(adminB)).expect(404);
  });

  it('tenant no corpo ou na query é recusado (400), não usado', async () => {
    for (const campo of ['tenantId', 'tenant_id', 'clinicaId']) {
      await api
        .http()
        .post('/pacientes')
        .set(cab(recepA))
        .send({ nome: 'X', telefone: '11900000004', [campo]: clinicaB })
        .expect(400);
      await api.http().get('/pacientes').query({ [campo]: clinicaB }).set(cab(recepA)).expect(400);
    }
  });
});

describe('toda rota de domínio exige sessão', () => {
  it('sem sessão, token inválido ou sessão encerrada: 401 genérico em todas as rotas', async () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const rotas: [RequestMethod, string][] = [
      [RequestMethod.GET, '/sessao'],
      [RequestMethod.GET, '/pacientes'],
      [RequestMethod.GET, `/pacientes/${id}`],
      [RequestMethod.POST, '/pacientes'],
      [RequestMethod.PATCH, `/pacientes/${id}`],
      [RequestMethod.POST, `/pacientes/${id}/inativar`],
      [RequestMethod.GET, '/agendamentos'],
      [RequestMethod.POST, '/agendamentos'],
      [RequestMethod.POST, `/agendamentos/${id}/remarcar`],
      [RequestMethod.POST, `/agendamentos/${id}/status`],
      [RequestMethod.POST, `/agendamentos/${id}/check-in`],
      [RequestMethod.POST, `/agendamentos/${id}/cancelar`],
      [RequestMethod.GET, '/profissionais'],
      [RequestMethod.POST, '/profissionais'],
      [RequestMethod.GET, '/tipos-atendimento'],
      [RequestMethod.POST, '/tipos-atendimento'],
      // Guias e pacotes (0011).
      [RequestMethod.GET, '/convenios'],
      [RequestMethod.POST, '/convenios'],
      [RequestMethod.PATCH, `/convenios/${id}`],
      [RequestMethod.POST, `/convenios/${id}/inativar`],
      [RequestMethod.GET, `/convenios/${id}/relatorio`],
      [RequestMethod.GET, '/guias'],
      [RequestMethod.GET, '/guias/alertas'],
      [RequestMethod.POST, '/guias'],
      [RequestMethod.GET, `/guias/${id}`],
      [RequestMethod.PATCH, `/guias/${id}`],
      [RequestMethod.POST, `/guias/${id}/cancelar`],
      [RequestMethod.GET, `/guias/${id}/consumos`],
      [RequestMethod.POST, `/guias/${id}/consumos`],
      [RequestMethod.POST, `/guias/${id}/consumos/${id}/estornar`],
      [RequestMethod.POST, `/guias/${id}/consumos/${id}/assinatura`],
      [RequestMethod.GET, '/pacotes'],
      [RequestMethod.POST, '/pacotes'],
      [RequestMethod.GET, `/pacotes/${id}`],
      [RequestMethod.GET, `/pacotes/${id}/historico`],
      [RequestMethod.POST, `/pacotes/${id}/cancelar`],
      [RequestMethod.POST, `/pacotes/${id}/consumos`],
      [RequestMethod.POST, `/pacotes/${id}/consumos/${id}/estornar`],
      // Prontuário (rodada 14.1).
      [RequestMethod.POST, '/atendimentos'],
      [RequestMethod.GET, `/atendimentos/${id}`],
      [RequestMethod.PUT, `/atendimentos/${id}/registro`],
      [RequestMethod.GET, `/atendimentos/${id}/versoes`],
      [RequestMethod.POST, `/atendimentos/${id}/finalizar`],
      [RequestMethod.POST, `/atendimentos/${id}/adendos`],
      [RequestMethod.GET, `/pacientes/${id}/prontuario`],
      [RequestMethod.GET, `/pacientes/${id}/notas-privadas`],
      [RequestMethod.POST, `/pacientes/${id}/notas-privadas`],
      [RequestMethod.GET, `/notas-privadas/${id}`],
      [RequestMethod.PATCH, `/notas-privadas/${id}`],
      [RequestMethod.POST, `/notas-privadas/${id}/descartar`],
      [RequestMethod.GET, '/prontuario/configuracao'],
      [RequestMethod.PUT, '/prontuario/configuracao'],
      [RequestMethod.POST, '/prontuario/notas-privadas/ciclo'],
      [RequestMethod.POST, `/prontuario/profissionais/${id}/desligamento`],
      [RequestMethod.PUT, `/prontuario/pacientes/${id}/retencao-legal`],
      // Financeiro (rodada 15.2).
      [RequestMethod.GET, '/financeiro/configuracao'],
      [RequestMethod.PUT, '/financeiro/configuracao'],
      [RequestMethod.GET, `/financeiro/profissionais/${id}/perfil-fiscal`],
      [RequestMethod.PUT, `/financeiro/profissionais/${id}/perfil-fiscal`],
      [RequestMethod.POST, '/financeiro/cobrancas'],
      [RequestMethod.GET, '/financeiro/contas-a-receber'],
      [RequestMethod.GET, `/financeiro/cobrancas/${id}`],
      [RequestMethod.POST, `/financeiro/cobrancas/${id}/cancelar`],
      [RequestMethod.POST, `/financeiro/cobrancas/${id}/recebimentos`],
      [RequestMethod.POST, `/financeiro/recebimentos/${id}/estornar`],
      [RequestMethod.POST, `/financeiro/recebimentos/${id}/recibo`],
      [RequestMethod.POST, `/financeiro/recebimentos/${id}/pagador-responsavel`],
      [RequestMethod.POST, '/financeiro/caixas'],
      [RequestMethod.GET, '/financeiro/caixas'],
      [RequestMethod.GET, `/financeiro/caixas/${id}`],
      [RequestMethod.POST, `/financeiro/caixas/${id}/fechar`],
      [RequestMethod.GET, '/financeiro/recibos'],
      [RequestMethod.GET, `/financeiro/recibos/${id}`],
      [RequestMethod.POST, `/financeiro/recibos/${id}/cancelar`],
      [RequestMethod.POST, '/financeiro/receita-saude/lotes'],
      // Responsáveis do paciente (0028).
      [RequestMethod.GET, `/pacientes/${id}/responsaveis`],
      [RequestMethod.POST, `/pacientes/${id}/responsaveis`],
      [RequestMethod.PATCH, `/pacientes/${id}/responsaveis/${id}`],
      [RequestMethod.POST, `/pacientes/${id}/responsaveis/${id}/pagador`],
      [RequestMethod.POST, `/pacientes/${id}/responsaveis/${id}/encerrar`],
      [RequestMethod.GET, `/pacientes/${id}/responsaveis/${id}/historico`],
      [RequestMethod.POST, `/pacientes/${id}/responsaveis/${id}/anular`],
      [RequestMethod.POST, `/pacientes/${id}/responsaveis/emancipacao`],
      [RequestMethod.POST, `/responsaveis/descarte`],
      [RequestMethod.POST, `/pacientes/${id}/responsaveis/eliminacao`],
    ];
    const efemera = api.sessao(clinicaA, 'admin');
    api.sessoes.encerrarSessao(efemera.Authorization.slice('Bearer '.length));
    for (const [metodo, rota] of rotas) {
      for (const auth of [undefined, 'Bearer invalido', `Bearer ${'a'.repeat(43)}`, efemera.Authorization]) {
        const http = api.http();
        const req =
          metodo === RequestMethod.GET
            ? http.get(rota)
            : metodo === RequestMethod.PATCH
              ? http.patch(rota)
              : metodo === RequestMethod.PUT
                ? http.put(rota)
                : http.post(rota);
        if (auth) void req.set('Authorization', auth);
        const res = await req.set('x-tenant-id', clinicaA).send({});
        expect(res.status, `${rota} com ${auth ?? 'nada'}`).toBe(401);
        expect(res.body).toEqual({ statusCode: 401, message: 'Não autenticado' });
      }
    }
  });
});
