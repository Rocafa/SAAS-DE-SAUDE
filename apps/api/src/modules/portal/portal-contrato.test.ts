/**
 * TESTE DE CONTRATO (unitário) do portal: as respostas que a API monta (as MESMAS funções que o serviço
 * usa, em portal-respostas.ts) batem com o contrato `ApiPortal` publicado em packages/shared.
 * A conferência é estrita: campo a mais (ex.: algo clínico) falha. Dados 100% fictícios.
 * A versão contra o Postgres real (respostas HTTP) está em test/portal.rls.test.ts ("contrato ApiPortal").
 */
import {
  CAMPOS_CLINICOS_PROIBIDOS,
  camposClinicosNoContrato,
  caminhoPortal,
  conferirForma,
  conferirRespostaPortal,
  CONTRATO_PORTAL,
  FormaErroDaApi,
  PORTAL_APELIDOS_DE_PEDIDO,
  PORTAL_FINALIDADES,
  PORTAL_TIPOS_DE_PEDIDO,
  type ApiPortal,
  type CorpoPortal,
  type RespostaPortal,
} from '@plataforma/shared';
import { describe, expect, it } from 'vitest';
import { AI_CONSENT_STATES, PAYMENT_METHODS, PORTAL_ACTING_AS, PORTAL_CONSENT_PURPOSES, RIGHTS_REQUEST_KINDS, type AppointmentStatusDb } from '../../db/schema';
import type { ConteudoDoRecibo } from '../finance/financeiro-regras';
import { STATUS_FRONT, statusParaFront } from '../scheduling/agenda-regras';
import { CONSENTIMENTOS, TIPOS_DE_PEDIDO_ACEITOS, tipoDePedido, transicaoDoPortal, VERSAO_TEXTOS_CONSENTIMENTO } from './portal-regras';
import {
  consentimentoParaPortal,
  consultaParaPortal,
  desafioDoConvite,
  meusDadosParaPortal,
  pedidoParaPortal,
  reciboParaPortal,
  reciboResumoParaPortal,
  vinculoParaPortal,
} from './portal-respostas';

const ID = '11111111-1111-4111-8111-111111111111';
const AGORA = Date.UTC(2027, 1, 1, 12, 0, 0);
const HORA = 3_600_000;

function conteudoFicticio(over: Partial<ConteudoDoRecibo> = {}): ConteudoDoRecibo {
  return {
    versao: 1,
    emitente: { tipo: 'pj', nome: 'Clinica Ficticia QZX', documento: null, registroConselho: null, profissionalId: null },
    pagador: { nome: 'Pagador Ficticio', cpf: '11122233396' },
    beneficiario: { nome: 'Paciente Ficticio', cpf: '11122233396' },
    valorCentavos: 15050,
    forma: 'pix_manual',
    dataPagamento: '2027-01-20',
    descricao: 'Atendimento em saúde',
    pendencias: ['cnpj_da_clinica'],
    ...over,
  };
}

describe('contrato ApiPortal: enums do banco = enums do contrato (runtime)', () => {
  it('mesmos valores, na mesma ordem', () => {
    const resp = (r: string) => (CONTRATO_PORTAL as Record<string, { resposta: unknown }>)[r]?.resposta;
    expect(PORTAL_FINALIDADES).toEqual(PORTAL_CONSENT_PURPOSES);
    expect(PORTAL_TIPOS_DE_PEDIDO).toEqual(RIGHTS_REQUEST_KINDS);
    expect(resp('GET /portal/vinculos')).toBeDefined();
    expect(JSON.stringify(CONTRATO_PORTAL['GET /portal/consultas'].resposta)).toContain(JSON.stringify(STATUS_FRONT));
    expect(JSON.stringify(CONTRATO_PORTAL['GET /portal/recibos'].resposta)).toContain(JSON.stringify(PAYMENT_METHODS));
    expect(JSON.stringify(CONTRATO_PORTAL['GET /portal/vinculos'].resposta)).toContain(JSON.stringify(PORTAL_ACTING_AS));
    expect(JSON.stringify(CONTRATO_PORTAL['GET /portal/privacidade/consentimentos'].resposta)).toContain(JSON.stringify(AI_CONSENT_STATES));
  });

  it('apelidos de pedido: o backend aceita os do contrato e devolve o canônico', () => {
    expect(TIPOS_DE_PEDIDO_ACEITOS).toEqual(Object.keys(PORTAL_APELIDOS_DE_PEDIDO));
    for (const [apelido, canonico] of Object.entries(PORTAL_APELIDOS_DE_PEDIDO)) expect(tipoDePedido(apelido)).toBe(canonico);
  });
});

describe('agenda', () => {
  const statuses: AppointmentStatusDb[] = ['scheduled', 'confirmed', 'checked_in', 'in_progress', 'completed', 'cancelled', 'no_show'];

  it('GET /portal/consultas: toda combinação de status/horário confere; botões vêm prontos', () => {
    const lista = statuses.flatMap((status) =>
      [-1, 1, 48].map((h) => consultaParaPortal({ id: ID, startsAt: new Date(AGORA + h * HORA), status }, 'Prof Ficticia', AGORA, 2)),
    );
    expect(conferirRespostaPortal('GET /portal/consultas', lista)).toEqual([]);
    const futura = consultaParaPortal({ id: ID, startsAt: new Date(AGORA + 48 * HORA), status: 'scheduled' }, 'Prof Ficticia', AGORA, 2);
    expect(futura).toMatchObject({ status: 'agendado', podeConfirmar: true, podeCancelar: true });
    // Dentro da antecedência mínima: confirma, mas não cancela.
    expect(consultaParaPortal({ id: ID, startsAt: new Date(AGORA + HORA), status: 'scheduled' }, 'P', AGORA, 2)).toMatchObject({ podeConfirmar: true, podeCancelar: false });
    expect(consultaParaPortal({ id: ID, startsAt: new Date(AGORA + 48 * HORA), status: 'cancelled' }, 'P', AGORA, 2)).toMatchObject({ podeConfirmar: false, podeCancelar: false });
  });

  it('POST confirmar / desfazer-confirmacao / cancelar: a resposta {status} confere', () => {
    for (const [rota, acao] of [
      ['POST /portal/consultas/:id/confirmar', 'confirmar'],
      ['POST /portal/consultas/:id/desfazer-confirmacao', 'desfazer_confirmacao'],
      ['POST /portal/consultas/:id/cancelar', 'cancelar'],
    ] as const) {
      for (const s of statuses) {
        const novo = transicaoDoPortal(acao, s);
        if (novo) expect(conferirRespostaPortal(rota, { status: statusParaFront(novo) })).toEqual([]);
      }
    }
  });

  it('campo clínico na consulta quebra o contrato (conferência estrita)', () => {
    const c = consultaParaPortal({ id: ID, startsAt: new Date(AGORA + 48 * HORA), status: 'scheduled' }, 'P', AGORA, 2);
    expect(conferirRespostaPortal('GET /portal/consultas', [{ ...c, especialidade: 'Psicologia' }])).toEqual(['$[0].especialidade: campo fora do contrato']);
  });
});

describe('recibos', () => {
  it('GET /portal/recibos: valor em centavos, forma com o nome do banco', () => {
    const itens = PAYMENT_METHODS.map((method, i) =>
      reciboResumoParaPortal({ id: ID, number: i + 1 }, { receivedAt: new Date(AGORA), amountCents: 15050, method }, i % 2 === 0),
    );
    expect(conferirRespostaPortal('GET /portal/recibos', itens)).toEqual([]);
    expect(itens[0]).toMatchObject({ valorCentavos: 15050, forma: 'dinheiro', situacao: 'cancelado' });
  });

  it('GET /portal/recibos/:id: detalhe confere; CPF de pagador terceiro mascarado; campo extra do retrato não vaza', () => {
    const proprio = reciboParaPortal(conteudoFicticio(), ID, 7, false);
    expect(conferirRespostaPortal('GET /portal/recibos/:id', proprio)).toEqual([]);
    expect(proprio.pagador.cpf).toBe('11122233396');
    const terceiro = reciboParaPortal(conteudoFicticio({ pagador: { nome: 'Resp Ficticio', cpf: '22233344405' } }), ID, 8, true);
    expect(conferirRespostaPortal('GET /portal/recibos/:id', terceiro)).toEqual([]);
    expect(terceiro).toMatchObject({ situacao: 'cancelado', pagador: { cpf: '***.***.***-05' }, beneficiario: { cpf: '11122233396' } });
    const comExtra = { ...conteudoFicticio(), especialidade: 'Psicologia' } as ConteudoDoRecibo;
    expect(conferirRespostaPortal('GET /portal/recibos/:id', reciboParaPortal(comExtra, ID, 9, false))).toEqual([]);
  });

  it('C3: o profissionalId do retrato (UUID interno) não sai pelo portal', () => {
    const PROF = '22222222-2222-4222-8222-222222222222';
    const r = reciboParaPortal(
      conteudoFicticio({ emitente: { tipo: 'pf', nome: 'Prof Ficticia', documento: null, registroConselho: null, profissionalId: PROF } }),
      ID,
      10,
      false,
    );
    expect(conferirRespostaPortal('GET /portal/recibos/:id', r)).toEqual([]);
    expect('profissionalId' in r.emitente).toBe(false);
    expect(JSON.stringify(r)).not.toContain(PROF);
    expect(conferirRespostaPortal('GET /portal/recibos/:id', { ...r, emitente: { ...r.emitente, profissionalId: PROF } })).toEqual([
      '$.emitente.profissionalId: campo fora do contrato',
    ]);
  });
});

describe('convite (fragmento + OTP)', () => {
  it('POST /portal/convites/resgate: só canal e destino mascarado; confirmar devolve só o vínculo', () => {
    const d = desafioDoConvite('11987654321');
    expect(conferirRespostaPortal('POST /portal/convites/resgate', d)).toEqual([]);
    expect(d.destino).toBe('(**) *****-4321');
    expect(conferirRespostaPortal('POST /portal/convites/resgate/confirmar', { vinculoId: ID })).toEqual([]);
    expect(conferirRespostaPortal('POST /portal/convites/resgate', { ...d, telefone: '11987654321' })).toEqual(['$.telefone: campo fora do contrato']);
  });

  it('vínculos e sessão: "de quem" é o acesso (titular ou responsável)', () => {
    const vs = PORTAL_ACTING_AS.map((a) => vinculoParaPortal(ID, 'Clinica Ficticia', 'Ana', a));
    expect(conferirRespostaPortal('GET /portal/vinculos', vs)).toEqual([]);
    expect(conferirRespostaPortal('GET /portal/sessao', vs[1])).toEqual([]);
    expect(conferirRespostaPortal('POST /portal/sessao/vinculo', vs[0])).toEqual([]);
  });
});

describe('consentimento (texto do servidor)', () => {
  it('GET /portal/privacidade/consentimentos: sem eventos, com sim/nao/desfeito; IA só em escriba_ia', () => {
    for (const ultimo of [undefined, 'sim', 'nao', 'desfeito'] as const) {
      const itens = PORTAL_CONSENT_PURPOSES.map((f) => consentimentoParaPortal(f, ultimo ? { response: ultimo, createdAt: new Date(AGORA) } : undefined));
      expect(conferirRespostaPortal('GET /portal/privacidade/consentimentos', itens)).toEqual([]);
      for (const i of itens) {
        expect(i.titulo).toBe(CONSENTIMENTOS[i.finalidade].titulo);
        expect(i.explicacao).toBe(CONSENTIMENTOS[i.finalidade].explicacao);
        expect(i.versaoTexto).toBe(VERSAO_TEXTOS_CONSENTIMENTO);
        expect('estadoIa' in i).toBe(i.finalidade === 'escriba_ia');
      }
    }
  });

  it('responder/desfazer devolvem {resposta} em 3 estados; histórico confere', () => {
    for (const r of ['sim', 'nao', 'nao_respondido'] as const) {
      expect(conferirRespostaPortal('POST /portal/privacidade/consentimentos/:finalidade', { resposta: r })).toEqual([]);
      expect(conferirRespostaPortal('POST /portal/privacidade/consentimentos/:finalidade/desfazer', { resposta: r })).toEqual([]);
    }
    expect(
      conferirRespostaPortal('GET /portal/privacidade/consentimentos/:finalidade/historico', [
        { resposta: 'desfeito', em: new Date(AGORA).toISOString(), canal: 'portal', agindoComo: 'responsavel_legal', versaoTexto: VERSAO_TEXTOS_CONSENTIMENTO },
      ]),
    ).toEqual([]);
  });
});

describe('pedidos, dados e documentos', () => {
  it('pedido devolve o tipo canônico, protocolo e prazo do servidor', () => {
    const p = pedidoParaPortal(
      { id: ID, protocol: '20270201-ABCDEF01', kind: 'portabilidade', createdAt: new Date(AGORA), dueAt: new Date(AGORA + 15 * 24 * HORA), status: 'atendida' },
      'Resposta ficticia',
    );
    expect(conferirRespostaPortal('POST /portal/solicitacoes', p)).toEqual([]);
    expect(conferirRespostaPortal('GET /portal/solicitacoes', [p])).toEqual([]);
    expect(p).toMatchObject({ tipo: 'portabilidade', situacao: 'respondido' });
  });

  it('meus dados e documentos (vazio, indisponível)', () => {
    expect(
      conferirRespostaPortal('GET /portal/meus-dados', { rotulo: 'meus_dados', nome: 'Ana Ficticia', nomeSocial: null, telefone: null, cpfMascarado: null, nascimento: null }),
    ).toEqual([]);
    expect(conferirRespostaPortal('GET /portal/documentos', { itens: [], disponivel: false })).toEqual([]);
    expect(conferirRespostaPortal('GET /portal/documentos', { itens: [{}], disponivel: false })).not.toEqual([]);
  });

  it('C1: nascimento completo AAAA-MM-DD para titular e responsável; rótulo "dados do paciente" para o responsável', () => {
    const dados = { nome: 'Lia Ficticia', nomeSocial: null, telefone: null, cpf: '11122233396', nascimento: '2012-02-29' };
    const titular = meusDadosParaPortal('titular', dados);
    const resp = meusDadosParaPortal('responsavel_legal', dados);
    for (const d of [titular, resp]) {
      expect(conferirRespostaPortal('GET /portal/meus-dados', d)).toEqual([]);
      expect(d.nascimento).toBe('2012-02-29');
      expect(d.cpfMascarado).toBe('***.***.***-96');
    }
    expect(titular.rotulo).toBe('meus_dados');
    expect(resp.rotulo).toBe('dados_do_paciente');
    // Data guardada fora do formato não vira texto livre no contrato: sai null (falha fechada).
    expect(meusDadosParaPortal('titular', { ...dados, nascimento: '29/02/2012' }).nascimento).toBeNull();
  });

  it('C1: o contrato tipa nascimento como data (texto livre, data inexistente e só ano quebram)', () => {
    const base = { rotulo: 'dados_do_paciente', nome: 'Lia Ficticia', nomeSocial: null, telefone: null, cpfMascarado: null };
    expect(conferirRespostaPortal('GET /portal/meus-dados', { ...base, nascimento: '2012-02-29' })).toEqual([]);
    for (const n of ['29/02/2012', '2013-02-29', '2012', '2012-02-29T00:00:00Z', 20120229]) {
      expect(conferirRespostaPortal('GET /portal/meus-dados', { ...base, nascimento: n }), String(n)).toEqual(['$.nascimento: esperada data AAAA-MM-DD']);
    }
    expect(conferirRespostaPortal('GET /portal/meus-dados', { ...base, rotulo: 'seus_dados', nascimento: null })).toEqual([
      '$.rotulo: fora de [meus_dados, dados_do_paciente]',
    ]);
    // A correção leva a data proposta (opcional) no mesmo formato; o portal não tem rota que edite o cadastro.
    const corpo = CONTRATO_PORTAL['POST /portal/meus-dados/correcao'].corpo;
    expect(conferirForma(corpo, { detalhe: 'Data ficticia errada', nascimento: '2011-05-06' })).toEqual([]);
    expect(conferirForma(corpo, { detalhe: 'Data ficticia errada', nascimento: '06/05/2011' })).toEqual(['$.nascimento: esperada data AAAA-MM-DD']);
    for (const def of Object.values(CONTRATO_PORTAL)) {
      if (def.metodo === 'POST' && def.caminho !== '/portal/meus-dados/correcao') expect(JSON.stringify(def.corpo), def.caminho).not.toContain('nascimento');
    }
  });

  it('corpo de erro: só código estável', () => {
    expect(conferirForma(FormaErroDaApi, { statusCode: 409, message: 'Conflito', codigo: 'convite_invalido' })).toEqual([]);
  });
});

describe('nada clínico no contrato (titular e responsável usam os mesmos formatos)', () => {
  it('nenhuma resposta do contrato tem campo clínico proibido', () => {
    expect(CAMPOS_CLINICOS_PROIBIDOS.length).toBeGreaterThan(0);
    expect(camposClinicosNoContrato()).toEqual([]);
  });

  it('nenhuma rota recebe id de paciente ou de clínica', () => {
    for (const [nome, def] of Object.entries(CONTRATO_PORTAL)) {
      expect(def.caminho, nome).not.toMatch(/paciente|clinica|tenant/i);
      expect(JSON.stringify(def.corpo ?? {}), nome).not.toMatch(/pacienteId|tenantId|clinicaId/);
    }
  });

  it('caminhoPortal monta a URL só com os parâmetros da rota', () => {
    expect(caminhoPortal('POST /portal/consultas/:id/confirmar', { id: ID })).toBe(`/portal/consultas/${ID}/confirmar`);
    expect(() => caminhoPortal('GET /portal/recibos/:id')).toThrow();
  });
});

// ------------------------------------------------------------------ tipos (pegos pelo typecheck)
describe('tipos do contrato', () => {
  it('o tipo pega divergência (compila = ok)', () => {
    const recibo: RespostaPortal<'GET /portal/recibos'>[number] = { id: ID, numero: 1, data: '2027-01-01', valorCentavos: 100, forma: 'convenio', situacao: 'emitido' };
    // @ts-expect-error valor em reais (texto) não é centavos
    const errado: RespostaPortal<'GET /portal/recibos'>[number] = { ...recibo, valorCentavos: '1,00' };
    // @ts-expect-error forma do front antigo ('pix') não existe no backend
    const forma: RespostaPortal<'GET /portal/recibos'>[number]['forma'] = 'pix';
    // @ts-expect-error status do front antigo fora do vocabulário do backend
    const st: RespostaPortal<'GET /portal/consultas'>[number]['status'] = 'remarcado';
    const corpo: CorpoPortal<'POST /portal/solicitacoes'> = { tipo: 'ver_dados' };
    // @ts-expect-error corpo não aceita id de paciente
    const corpoErrado: CorpoPortal<'POST /portal/solicitacoes'> = { tipo: 'acesso', pacienteId: ID };
    const api: ApiPortal['GET /portal/sessao']['resposta']['agindoComo'] = 'responsavel_legal';
    const correcao: CorpoPortal<'POST /portal/meus-dados/correcao'> = { detalhe: 'x', nascimento: '2011-05-06' };
    // @ts-expect-error C3: profissionalId não existe no emitente do portal
    const prof: RespostaPortal<'GET /portal/recibos/:id'>['emitente']['profissionalId'] = null;
    // @ts-expect-error rótulo fora do vocabulário
    const rotulo: RespostaPortal<'GET /portal/meus-dados'>['rotulo'] = 'seus_dados';
    expect([recibo, errado, forma, st, corpo, corpoErrado, api, correcao, prof, rotulo]).toHaveLength(10);
  });
});
