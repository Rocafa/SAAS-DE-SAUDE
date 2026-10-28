/**
 * Adaptador HTTP do portal com `fetch` simulado: URL, método, cabeçalhos, credenciais, corpo, conferência
 * do contrato e tratamento de erro (401/403/404/409/422/429/rede), sem dado pessoal em erro ou log.
 * Os dados são fictícios.
 */
import { conferirRespostaPortal } from '@plataforma/shared';
import { describe, expect, it, vi } from 'vitest';
import { ErroPortal } from './portal';
import { criarApiPortalHttp, STATUS_FORA_DO_CONTRATO } from './portal-http';
import { criarClientePortal, lerConfigPortal } from './portal-selecionar';

const TOKEN = `ptl_${'a'.repeat(43)}`;
const BASE = 'http://localhost:3333';

interface Chamada {
  url: string;
  init: RequestInit;
}

function simular(respostas: { status: number; corpo?: unknown; texto?: string }[]) {
  const chamadas: Chamada[] = [];
  const fila = [...respostas];
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    chamadas.push({ url: String(url), init: init ?? {} });
    const r = fila.shift() ?? { status: 500 };
    const corpo = r.texto ?? (r.corpo === undefined ? '' : JSON.stringify(r.corpo));
    return new Response(corpo, { status: r.status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, chamadas };
}

function api(respostas: { status: number; corpo?: unknown; texto?: string }[], aoDivergir?: (r: string, m: readonly string[]) => void) {
  const s = simular(respostas);
  return { api: criarApiPortalHttp({ baseUrl: `${BASE}/`, sessao: { tipo: 'dev', token: TOKEN }, fetch: s.fetch, ...(aoDivergir ? { aoDivergir } : {}) }), ...s };
}

const VINCULO = { vinculoId: 'v1', clinica: 'Clínica Exemplo (fictícia)', primeiroNome: 'Ana', agindoComo: 'responsavel_legal' };
const CONSULTA = { id: 'c1', data: '2026-11-03', hora: '09:00', profissional: 'Dra. Exemplo', status: 'agendado', podeConfirmar: true, podeCancelar: true };
const PEDIDO = { id: 'pd1', protocolo: '20261025-0000ABCD', tipo: 'correcao', abertoEm: '2026-10-25T12:00:00.000Z', prazo: '2026-11-09T12:00:00.000Z', situacao: 'aberto', resposta: null };

async function falha(p: Promise<unknown>): Promise<ErroPortal> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ErroPortal) return e;
    throw e;
  }
  throw new Error('era para falhar');
}

describe('adaptador HTTP do portal: requisição', () => {
  it('GET sem query, com a sessão do portal, sem cookie, sem cache e sem Referer', async () => {
    const { api: a, chamadas } = api([{ status: 200, corpo: [CONSULTA] }]);
    expect(await a.consultas()).toEqual([CONSULTA]);
    const [c] = chamadas;
    expect(c!.url).toBe(`${BASE}/portal/consultas`);
    expect(c!.init).toMatchObject({ method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer' });
    expect(c!.init.body).toBeUndefined();
    const h = c!.init.headers as Record<string, string>;
    expect(h.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(Object.keys(h).map((k) => k.toLowerCase())).not.toEqual(expect.arrayContaining(['x-tenant-id']));
    expect(Object.keys(h).some((k) => /tenant|paciente/i.test(k))).toBe(false);
  });

  it('POST com corpo JSON exato do contrato e id só na URL (codificado)', async () => {
    const { api: a, chamadas } = api([
      { status: 200, corpo: { status: 'confirmado' } },
      { status: 201, corpo: PEDIDO },
      { status: 201, corpo: { ...PEDIDO, tipo: 'acesso' } },
      { status: 200, corpo: { resposta: 'sim' } },
      { status: 200, corpo: VINCULO },
    ]);
    await a.confirmarConsulta('c/1');
    await a.pedirCorrecao({ detalhe: 'data errada', nascimento: '2018-05-10' });
    await a.abrirPedido('acesso', '  ');
    await a.responderConsentimento('escriba_ia', 'sim');
    await a.escolherVinculo('v1');
    expect(chamadas.map((c) => [c.init.method, c.url.slice(BASE.length), c.init.body])).toEqual([
      ['POST', '/portal/consultas/c%2F1/confirmar', '{}'],
      ['POST', '/portal/meus-dados/correcao', '{"detalhe":"data errada","nascimento":"2018-05-10"}'],
      ['POST', '/portal/solicitacoes', '{"tipo":"acesso"}'],
      ['POST', '/portal/privacidade/consentimentos/escriba_ia', '{"resposta":"sim"}'],
      ['POST', '/portal/sessao/vinculo', '{"vinculoId":"v1"}'],
    ]);
    for (const c of chamadas) expect((c.init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('convite: token só no corpo, nunca na URL', async () => {
    const { api: a, chamadas } = api([
      { status: 200, corpo: { canal: 'sms', destino: '(11) *****-0000' } },
      { status: 200, corpo: { vinculoId: 'v9' } },
    ]);
    await a.resgatarConvite('tok-secreto-ficticio');
    await a.confirmarConvite('tok-secreto-ficticio', '123456');
    for (const c of chamadas) expect(c.url).not.toContain('tok-secreto');
    expect(chamadas[1]!.init.body).toBe('{"token":"tok-secreto-ficticio","codigo":"123456"}');
  });

  it('sessão de cookie (D4) vai com credentials include e sem Authorization', async () => {
    const s = simular([{ status: 200, corpo: VINCULO }]);
    const a = criarApiPortalHttp({ baseUrl: BASE, sessao: { tipo: 'cookie' }, fetch: s.fetch });
    await a.sessao();
    expect(s.chamadas[0]!.init.credentials).toBe('include');
    expect((s.chamadas[0]!.init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('recusa token de dev fora do formato ptl_', () => {
    expect(() => criarApiPortalHttp({ baseUrl: BASE, sessao: { tipo: 'dev', token: 'abc' } })).toThrow(/ptl_/);
  });
});

describe('adaptador HTTP do portal: resposta e contrato', () => {
  it('resposta que confere o contrato passa', async () => {
    const { api: a } = api([{ status: 200, corpo: VINCULO }]);
    const v = await a.sessao();
    expect(conferirRespostaPortal('GET /portal/sessao', v)).toEqual([]);
  });

  it('campo fora do contrato (ex.: algo clínico) vira erro genérico; o aviso leva só rota e caminho, nunca o valor', async () => {
    const aoDivergir = vi.fn();
    const { api: a } = api([{ status: 200, corpo: [{ ...CONSULTA, especialidade: 'Psiquiatria (fictícia)' }] }], aoDivergir);
    const e = await falha(a.consultas());
    expect(e.status).toBe(STATUS_FORA_DO_CONTRATO);
    expect(e.message).not.toMatch(/Psiquiatria/);
    expect(aoDivergir).toHaveBeenCalledWith('GET /portal/consultas', ['$[0].especialidade: campo fora do contrato']);
    expect(JSON.stringify(aoDivergir.mock.calls)).not.toMatch(/Psiquiatria/);
  });

  it('valor em reais em vez de centavos é recusado', async () => {
    const { api: a } = api([{ status: 200, corpo: [{ id: 'r1', numero: 1, data: '2026-10-01', valorCentavos: 150.5, forma: 'pix_manual', situacao: 'emitido' }] }]);
    expect((await falha(a.recibos())).status).toBe(STATUS_FORA_DO_CONTRATO);
  });

  it('corpo que não é JSON vira erro genérico', async () => {
    const { api: a } = api([{ status: 200, texto: '<html>' }]);
    expect((await falha(a.vinculos())).status).toBe(STATUS_FORA_DO_CONTRATO);
  });

  it('status de sucesso diferente do contrato é erro (201 esperado no pedido)', async () => {
    const { api: a } = api([{ status: 200, corpo: PEDIDO }]);
    expect((await falha(a.abrirPedido('acesso'))).status).toBe(200);
  });
});

describe('adaptador HTTP do portal: erros', () => {
  it.each([
    [401, undefined, /sessão terminou/],
    [403, 'vinculo_inativo', /não vale mais/],
    [403, 'assinatura_bloqueia_escrita', /não está aceitando/],
    [404, undefined, /Não encontramos/],
    [409, 'escolher_vinculo', /Escolha de quem/],
    [409, 'sem_vinculo', /convite/],
    [409, 'prazo_de_cancelamento_encerrado', /prazo/],
    [409, 'consentimento_pelo_responsavel', /art\. 14/],
    [409, 'recibo_eliminado_por_retencao_fiscal', /prazo de guarda/],
    [422, undefined, /Confira/],
    [429, 'limite_diario_de_pedidos', /limite de pedidos/],
  ] as const)('%i %s → mensagem clara', async (status, codigo, re) => {
    const { api: a } = api([{ status, corpo: { statusCode: status, message: 'Maria Fictícia 000.000.000-00', error: 'X', ...(codigo ? { codigo } : {}) } }]);
    const e = await falha(a.cancelarConsulta('c1'));
    expect(e).toMatchObject({ status, codigo });
    expect(e.message).toMatch(re);
    // O `message` do servidor nunca chega à tela nem ao erro.
    expect(JSON.stringify({ ...e, m: e.message })).not.toMatch(/Maria|000\.000/);
  });

  it('400/422 trazem só os NOMES dos campos', async () => {
    const { api: a } = api([{ status: 422, corpo: { statusCode: 422, message: 'x', codigo: 'documento_nao_conferido', campos: ['nascimento', 'valor com espaço'] } }]);
    const e = await falha(a.pedirCorrecao({ detalhe: 'abc', nascimento: '2018-05-10' }));
    expect(e.campos).toEqual(['nascimento']);
  });

  it('código fora do formato é ignorado; corpo de erro não JSON também', async () => {
    const { api: a } = api([
      { status: 409, corpo: { statusCode: 409, message: 'x', codigo: '<script>' } },
      { status: 500, texto: 'Internal' },
    ]);
    expect((await falha(a.consultas())).codigo).toBeUndefined();
    expect((await falha(a.consultas())).status).toBe(500);
  });

  it('falha de rede vira erro genérico (status 0)', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof globalThis.fetch;
    const a = criarApiPortalHttp({ baseUrl: BASE, sessao: { tipo: 'dev', token: TOKEN }, fetch });
    const e = await falha(a.sessao());
    expect(e.status).toBe(0);
    expect(e.message).toMatch(/internet/);
  });
});

describe('seleção do adaptador do portal', () => {
  it('fake é o padrão', () => {
    expect(lerConfigPortal({})).toEqual({ modo: 'fake' });
    expect(lerConfigPortal({ NEXT_PUBLIC_PORTAL_MODO: ' ', NODE_ENV: 'production' })).toEqual({ modo: 'fake' });
  });

  it('http só em desenvolvimento até a D4, com origem válida e sessão fictícia ptl_', () => {
    const env = { NEXT_PUBLIC_PORTAL_MODO: 'http', NEXT_PUBLIC_API_ORIGIN: 'http://localhost:3333', NEXT_PUBLIC_PORTAL_SESSAO_DEV: TOKEN };
    expect(lerConfigPortal({ ...env, NODE_ENV: 'development' })).toEqual({ modo: 'http', origem: 'http://localhost:3333', tokenDev: TOKEN });
    expect(() => lerConfigPortal({ ...env, NODE_ENV: 'production' })).toThrow(/D4/);
    expect(() => lerConfigPortal({ ...env, NODE_ENV: 'test' })).toThrow(/D4/);
    expect(() => lerConfigPortal({ ...env, NODE_ENV: 'development', NEXT_PUBLIC_API_ORIGIN: 'https://*.exemplo.test' })).toThrow(/NEXT_PUBLIC_API_ORIGIN/);
    expect(() => lerConfigPortal({ ...env, NODE_ENV: 'development', NEXT_PUBLIC_PORTAL_SESSAO_DEV: '' })).toThrow(/SESSAO_DEV/);
    expect(() => lerConfigPortal({ NEXT_PUBLIC_PORTAL_MODO: 'outro' })).toThrow(/inválido/);
  });

  it('cria o adaptador certo para cada modo', async () => {
    const fake = criarClientePortal({ modo: 'fake' }, { fake: { agora: new Date(2026, 9, 12, 10) } });
    expect((await fake.sessao()).primeiroNome).toBe('Maria');
    const s = simular([{ status: 200, corpo: VINCULO }]);
    const http = criarClientePortal({ modo: 'http', origem: BASE, tokenDev: TOKEN }, { http: { fetch: s.fetch } });
    await http.sessao();
    expect(s.chamadas[0]!.url).toBe(`${BASE}/portal/sessao`);
  });
});
