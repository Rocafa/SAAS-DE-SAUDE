/**
 * Aviso fixo da troca do admin único (B13): apresentação (sem navegador), adaptador HTTP com fetch simulado e o fake
 * da demonstração. Minimização: nada do e-mail novo nem de quem pediu; o adaptador não envia clínica. Dados fictícios.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { criarApiFake } from '@/lib/api/fake';
import { criarApiHttp, ErroApi, MENSAGENS, mensagemDeErro } from '@/lib/api/http';
import { AvisoTrocaDoAdminVisao, dataDoFimDaJanela, textoDaJanela } from './aviso-troca-do-admin';

const AGORA = new Date('2026-11-24T12:00:00.000Z');
const EM_JANELA = { liberaEm: '2026-11-26T15:00:00.000Z', suspensa: false };

describe('AvisoTrocaDoAdminVisao', () => {
  it('mostra o pedido, o fim da janela (horário de Brasília) e o botão "Não fui eu", sem botão de fechar', () => {
    const html = renderToStaticMarkup(<AvisoTrocaDoAdminVisao troca={EM_JANELA} agora={AGORA} etapa="aviso" />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('Foi pedida a troca do administrador desta clínica');
    expect(html).toContain('termina em 26/11/2026 às 12:00 (horário de Brasília)');
    expect(html).toContain('Não fui eu');
    expect(html).not.toMatch(/Fechar|Dispensar|aria-label="Fechar"/);
    // Nada de quem pediu nem do e-mail novo.
    expect(html).not.toMatch(/@|e-mail novo|SUP-/);
  });

  it('confirmação antes de contestar: "Sim, não fui eu" e "Voltar"; enviando desliga os dois', () => {
    const confirmar = renderToStaticMarkup(<AvisoTrocaDoAdminVisao troca={EM_JANELA} agora={AGORA} etapa="confirmar" />);
    expect(confirmar).toContain('Confirma que você não pediu essa troca?');
    expect(confirmar).toContain('Sim, não fui eu');
    expect(confirmar).toContain('Voltar');
    expect(confirmar).not.toContain('>Não fui eu<');
    const enviando = renderToStaticMarkup(<AvisoTrocaDoAdminVisao troca={EM_JANELA} agora={AGORA} etapa="enviando" />);
    expect(enviando).toContain('Enviando…');
    expect(enviando.match(/disabled=""/g)).toHaveLength(2);
  });

  it('contestada: só a confirmação do que aconteceu; erro aparece em alerta', () => {
    const feito = renderToStaticMarkup(<AvisoTrocaDoAdminVisao troca={EM_JANELA} agora={AGORA} etapa="contestada" />);
    expect(feito).toContain('você contestou o pedido e a troca parou');
    expect(feito).not.toContain('Não fui eu');
    const comErro = renderToStaticMarkup(<AvisoTrocaDoAdminVisao troca={EM_JANELA} agora={AGORA} etapa="confirmar" erro={MENSAGENS.mfaRecente} />);
    expect(comErro).toContain('entre de novo com a senha e o código');
  });

  it('texto da janela: aberta, encerrada (ainda sem conclusão) e suspensa', () => {
    expect(dataDoFimDaJanela(EM_JANELA.liberaEm)).toBe('26/11/2026 às 12:00');
    expect(textoDaJanela(EM_JANELA, AGORA)).toMatch(/termina em/);
    expect(textoDaJanela(EM_JANELA, new Date('2026-11-27T00:00:00.000Z'))).toMatch(/terminou em .* ainda não foi concluída/);
    expect(textoDaJanela({ ...EM_JANELA, suspensa: true }, AGORA)).toMatch(/parado até a revisão/);
  });
});

describe('adaptador HTTP da troca do admin', () => {
  const BASE = 'http://127.0.0.1:3333';
  function simular(responder: (metodo: string, caminho: string, corpo: unknown, init: RequestInit) => Response) {
    const chamadas: { metodo: string; caminho: string; url: string; corpo: unknown; headers: Record<string, string> }[] = [];
    const fetch = vi.fn((entrada: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(entrada));
      const metodo = init.method ?? 'GET';
      const corpo = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      chamadas.push({ metodo, caminho: url.pathname, url: url.toString(), corpo, headers: (init.headers ?? {}) as Record<string, string> });
      return Promise.resolve(responder(metodo, url.pathname, corpo, init));
    });
    return { chamadas, api: criarApiHttp({ baseUrl: BASE, fetch: fetch as unknown as typeof globalThis.fetch }) };
  }
  const json = (status: number, corpo: unknown) => new Response(corpo === undefined ? null : JSON.stringify(corpo), { status, headers: { 'Content-Type': 'application/json' } });

  it('GET /sessao/troca-do-admin: só os dois campos do contrato chegam à tela; sem clínica na ida', async () => {
    const s = simular(() => json(200, { troca: { ...EM_JANELA, chamado: 'SUP-1', email: 'x@exemplo.test' } }));
    expect(await s.api.trocaDoAdminEmJanela()).toEqual(EM_JANELA);
    expect(s.chamadas).toHaveLength(1);
    expect(s.chamadas[0]).toMatchObject({ metodo: 'GET', caminho: '/sessao/troca-do-admin', url: `${BASE}/sessao/troca-do-admin` });
    expect(JSON.stringify(s.chamadas[0]!.headers).toLowerCase()).not.toMatch(/tenant|clinica/);
  });

  it('sem troca: null; resposta fora do contrato: erro sem dado', async () => {
    expect(await simular(() => json(200, { troca: null })).api.trocaDoAdminEmJanela()).toBeNull();
    await expect(simular(() => json(200, { troca: { liberaEm: 'ontem', suspensa: false } })).api.trocaDoAdminEmJanela()).rejects.toMatchObject({
      codigo: 'resposta_invalida',
    });
  });

  it('"Não fui eu": POST /sessao/troca-do-admin/contestar com corpo vazio; MFA vencido vira a mensagem de entrar de novo', async () => {
    const s = simular(() => new Response(null, { status: 204 }));
    await s.api.contestarTrocaDoAdmin();
    expect(s.chamadas[0]).toMatchObject({ metodo: 'POST', caminho: '/sessao/troca-do-admin/contestar', corpo: {} });
    const mfa = simular(() => json(403, { statusCode: 403, codigo: 'mfa_recente_obrigatorio' }));
    await expect(mfa.api.contestarTrocaDoAdmin()).rejects.toMatchObject({ status: 403, codigo: 'mfa_recente_obrigatorio', message: MENSAGENS.mfaRecente });
    expect(mensagemDeErro(404, {})).toBeInstanceOf(ErroApi);
  });
});

describe('fake da demonstração', () => {
  it('sem a opção, ninguém vê troca', async () => {
    expect(await criarApiFake({ agora: AGORA }).trocaDoAdminEmJanela()).toBeNull();
  });

  it('com a troca simulada, só a administradora (conta antiga) vê; contestar encerra e não repete', async () => {
    const api = criarApiFake({ agora: AGORA, trocaDoAdmin: 'em_janela' });
    const t = await api.trocaDoAdminEmJanela();
    expect(t).toEqual({ liberaEm: new Date(AGORA.getTime() + 36 * 3_600_000).toISOString(), suspensa: false });
    // Outro membro da clínica (recepção) não vê nem contesta.
    await api.entrarComo('u4');
    expect(await api.trocaDoAdminEmJanela()).toBeNull();
    await expect(api.contestarTrocaDoAdmin()).rejects.toMatchObject({ status: 404 });
    // Outra admin (não é a conta antiga) também não.
    await api.entrarComo('u5');
    expect(await api.trocaDoAdminEmJanela()).toBeNull();
    await api.entrarComo('u1');
    await api.contestarTrocaDoAdmin();
    expect(await api.trocaDoAdminEmJanela()).toBeNull();
    await expect(api.contestarTrocaDoAdmin()).rejects.toMatchObject({ status: 404 });
  });

  it('troca suspensa simulada', async () => {
    expect((await criarApiFake({ agora: AGORA, trocaDoAdmin: 'suspensa' }).trocaDoAdminEmJanela())?.suspensa).toBe(true);
  });
});
