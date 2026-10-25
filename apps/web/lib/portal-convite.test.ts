/**
 * Resgate do convite do portal (R4 do parecer do #75): token do fragmento, apagado da barra, OTP e a
 * MESMA frase para 404/409/422/500. Tokens e telefones são fictícios.
 */
import { describe, expect, it, vi } from 'vitest';
import { ErroPortal, mensagemDoErro } from './api/portal';
import { criarApiPortalHttp } from './api/portal-http';
import { codigoDoOtp, FALHA_DO_CONVITE, mensagemDoResgate, tirarTokenDaBarra, tokenDoFragmento } from './portal-convite';

const TOKEN_CONVITE = 'cvt_ficticio_0001';
const SESSAO = `ptl_${'b'.repeat(43)}`;

describe('token do convite: só do fragmento', () => {
  it('lê #<token> e #convite=<token>, com decodificação e sem espaços', () => {
    expect(tokenDoFragmento(`#${TOKEN_CONVITE}`)).toBe(TOKEN_CONVITE);
    expect(tokenDoFragmento(`#convite=${TOKEN_CONVITE}`)).toBe(TOKEN_CONVITE);
    expect(tokenDoFragmento('#convite=abc%2Bdef%20')).toBe('abc+def');
    expect(tokenDoFragmento('')).toBe('');
  });
  it('%-encoding inválido dá token vazio (sem exceção)', () => {
    expect(tokenDoFragmento('#convite=%E0%A4%A')).toBe('');
    expect(tokenDoFragmento('#%')).toBe('');
  });
  it('query ?token= é ignorada: só o hash entra', () => {
    const historico = { replaceState: vi.fn() };
    const local = { hash: '', pathname: '/portal/convite', search: `?token=${TOKEN_CONVITE}`, href: `http://localhost/portal/convite?token=${TOKEN_CONVITE}` };
    expect(tirarTokenDaBarra(local, historico)).toBe('');
    expect(historico.replaceState).not.toHaveBeenCalled();
  });
  it('apaga o token da barra e do histórico, mantendo só o caminho (sem query nem hash)', () => {
    const historico = { replaceState: vi.fn() };
    expect(tirarTokenDaBarra({ hash: `#convite=${TOKEN_CONVITE}`, pathname: '/portal/convite' }, historico)).toBe(TOKEN_CONVITE);
    expect(historico.replaceState).toHaveBeenCalledExactlyOnceWith(null, '', '/portal/convite');
  });
  it('apaga o fragmento mesmo quando ele é inválido', () => {
    const historico = { replaceState: vi.fn() };
    expect(tirarTokenDaBarra({ hash: '#%', pathname: '/portal/convite' }, historico)).toBe('');
    expect(historico.replaceState).toHaveBeenCalledOnce();
  });
});

describe('OTP do convite', () => {
  it('6 números, espaços ignorados', () => {
    expect(codigoDoOtp('123 456')).toBe('123456');
    expect(codigoDoOtp(' 654321 ')).toBe('654321');
  });
  it('recusa menos ou mais de 6, letras e vazio', () => {
    for (const c of ['12345', '1234567', '12a456', '', '      ']) expect(codigoDoOtp(c)).toBeNull();
  });
});

describe('mensagem do resgate: mesma frase para qualquer falha do convite', () => {
  it('404, 409, 422 e 500 mostram a mesma frase, sem dizer o motivo', () => {
    const textos = [new ErroPortal(404), new ErroPortal(409, 'convite_invalido'), new ErroPortal(422, undefined, ['token']), new ErroPortal(500), new Error('rede')].map(
      (e) => mensagemDoResgate(e),
    );
    for (const t of textos) expect(t).toEqual({ texto: FALHA_DO_CONVITE, entrar: false });
    expect(FALHA_DO_CONVITE).toBe(mensagemDoErro(409, 'convite_invalido'));
    expect(FALHA_DO_CONVITE).not.toMatch(/não existe|expirad|usado|outra pessoa/i);
  });
  it('401 pede para entrar; 429 fala do limite', () => {
    expect(mensagemDoResgate(new ErroPortal(401))).toEqual({ texto: 'Para usar o convite, entre primeiro no portal.', entrar: true });
    expect(mensagemDoResgate(new ErroPortal(429, 'limite_por_usuario')).texto).toBe(mensagemDoErro(429));
  });
});

describe('fluxo pelo adaptador HTTP (fetch simulado)', () => {
  function api(respostas: { status: number; corpo?: unknown }[]) {
    const chamadas: { url: string; init: RequestInit }[] = [];
    const fila = [...respostas];
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      chamadas.push({ url: String(url), init: init ?? {} });
      const r = fila.shift() ?? { status: 500 };
      return new Response(r.corpo === undefined ? '' : JSON.stringify(r.corpo), { status: r.status, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof globalThis.fetch;
    return { a: criarApiPortalHttp({ baseUrl: 'http://localhost:3333', sessao: { tipo: 'dev', token: SESSAO }, fetch }), chamadas };
  }
  async function falha(p: Promise<unknown>): Promise<unknown> {
    try {
      await p;
    } catch (e) {
      return e;
    }
    throw new Error('era para falhar');
  }

  it('token do fragmento vai no CORPO (nunca na URL); o OTP confirma o vínculo', async () => {
    const { a, chamadas } = api([
      { status: 200, corpo: { canal: 'sms', destino: '(11) *****-0001' } },
      { status: 200, corpo: { vinculoId: 'v-ficticio' } },
    ]);
    const token = tirarTokenDaBarra({ hash: `#convite=${TOKEN_CONVITE}`, pathname: '/portal/convite' }, { replaceState: vi.fn() });
    expect(await a.resgatarConvite(token)).toEqual({ canal: 'sms', destino: '(11) *****-0001' });
    expect(await a.confirmarConvite(token, codigoDoOtp('123 456')!)).toEqual({ vinculoId: 'v-ficticio' });
    expect(chamadas.map((c) => c.url)).toEqual(['http://localhost:3333/portal/convites/resgate', 'http://localhost:3333/portal/convites/resgate/confirmar']);
    for (const c of chamadas) {
      expect(c.url).not.toContain(TOKEN_CONVITE);
      expect(c.init).toMatchObject({ method: 'POST', referrerPolicy: 'no-referrer' });
    }
    expect(JSON.parse(String(chamadas[0]!.init.body))).toEqual({ token: TOKEN_CONVITE });
    expect(JSON.parse(String(chamadas[1]!.init.body))).toEqual({ token: TOKEN_CONVITE, codigo: '123456' });
  });

  it.each([
    [404, { codigo: 'nao_encontrado' }],
    [409, { codigo: 'convite_invalido' }],
    [422, { codigo: 'validacao', campos: ['token'] }],
  ])('%i no resgate ou na confirmação → mesma frase na tela', async (status, corpo) => {
    const { a } = api([
      { status, corpo },
      { status, corpo },
    ]);
    const e1 = await falha(a.resgatarConvite(TOKEN_CONVITE));
    const e2 = await falha(a.confirmarConvite(TOKEN_CONVITE, '123456'));
    expect(mensagemDoResgate(e1)).toEqual({ texto: FALHA_DO_CONVITE, entrar: false });
    expect(mensagemDoResgate(e2)).toEqual({ texto: FALHA_DO_CONVITE, entrar: false });
    expect(mensagemDoResgate(e1).texto).not.toContain(TOKEN_CONVITE);
  });
});
