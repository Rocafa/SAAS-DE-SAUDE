/**
 * Adaptador HTTP do PORTAL DO PACIENTE, tipado pelo contrato único `ApiPortal` (`@plataforma/shared`;
 * §10h de docs/04-arquitetura/api-dominio.md). Não importa nada da clínica (R-47a): nem o fake, nem o
 * contrato, nem o cliente HTTP dela.
 *
 * Sessão PRÓPRIA do portal (nunca a da clínica):
 * - `{ tipo: 'dev', token }`: a sessão fictícia do backend (`Authorization: Bearer ptl_…`), que só existe
 *   com a API em development/test. O token fica só na memória deste adaptador (nada de localStorage,
 *   sessionStorage ou cookie legível) e vai com `credentials: 'omit'`.
 * - `{ tipo: 'cookie' }`: reservado para a D4 (cookie HttpOnly/Secure/SameSite=Strict do portal, CSRF nos
 *   POST). Vai com `credentials: 'include'`, e só para a origem do portal. `selecionar` ainda o recusa.
 *
 * Toda resposta passa pela conferência ESTRITA do contrato (`conferirRespostaPortal`). Divergência vira
 * erro genérico na tela; quem chama pode registrar a ROTA e as mensagens (caminho e tipo esperado, nunca o
 * valor). Nenhum dado pessoal vai para log ou console: este arquivo não escreve em nenhum dos dois.
 */
import {
  CONTRATO_PORTAL,
  caminhoPortal,
  conferirRespostaPortal,
  type ApiPortal,
  type CorpoPortal,
  type RotaPortal,
} from '@plataforma/shared';
import { ErroPortal, type ClientePortal } from './portal';

export type SessaoPortalHttp = { tipo: 'dev'; token: string } | { tipo: 'cookie' };

export interface OpcoesPortalHttp {
  /** Origem da API (esquema://host[:porta]), a mesma liberada no `connect-src` da CSP. */
  baseUrl: string;
  sessao: SessaoPortalHttp;
  fetch?: typeof fetch;
  /** Teto de cada chamada, cabeçalhos e corpo juntos (padrão: 10 s). */
  timeoutMs?: number;
  /** Chamado quando a resposta foge do contrato: só a rota e as mensagens (sem valores). */
  aoDivergir?: (rota: RotaPortal, mensagens: readonly string[]) => void;
}

/** Status de "contrato quebrado": tratado como erro genérico (o servidor respondeu algo inesperado). */
export const STATUS_FORA_DO_CONTRATO = 502;

/** Corpo da rota: conferido com `satisfies` em cada chamada, onde o tipo é concreto. */
type C<K extends RotaPortal> = CorpoPortal<K>;

const TOKEN_DEV_RE = /^ptl_[A-Za-z0-9_-]{43}$/;

export function criarApiPortalHttp(opcoes: OpcoesPortalHttp): ClientePortal {
  const base = opcoes.baseUrl.replace(/\/+$/, '');
  const doFetch = opcoes.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  if (opcoes.sessao.tipo === 'dev' && !TOKEN_DEV_RE.test(opcoes.sessao.token)) {
    throw new Error('Sessão de desenvolvimento do portal inválida (esperado ptl_ + 43 caracteres).');
  }
  const sessao = opcoes.sessao;
  const timeoutMs = opcoes.timeoutMs ?? 10_000;

  async function chamar<R extends RotaPortal>(
    rota: R,
    params: Readonly<Record<string, string>> = {},
    corpo?: unknown,
  ): Promise<ApiPortal[R]['resposta']> {
    const def = CONTRATO_PORTAL[rota];
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (sessao.tipo === 'dev') headers.Authorization = `Bearer ${sessao.token}`;
    const init: RequestInit = {
      method: def.metodo,
      headers,
      credentials: sessao.tipo === 'cookie' ? 'include' : 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    };
    if (def.metodo === 'POST') {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(corpo ?? {});
    }
    // O portal é a tela do paciente: sem teto, um servidor que aceita a conexão e não responde deixa
    // a tela carregando para sempre, sem erro e sem "tentar de novo". O relógio cobre também a
    // leitura do corpo, porque o servidor pode travar depois dos cabeçalhos.
    const controle = new AbortController();
    const relogio = setTimeout(() => controle.abort(), timeoutMs);
    init.signal = controle.signal;
    try {
      return await chamarSemRelogio(rota, params, init, def);
    } finally {
      clearTimeout(relogio);
    }
  }

  async function chamarSemRelogio<R extends RotaPortal>(
    rota: R,
    params: Readonly<Record<string, string>>,
    init: RequestInit,
    def: (typeof CONTRATO_PORTAL)[R],
  ): Promise<ApiPortal[R]['resposta']> {
    let resp: Response;
    try {
      // GET sem query (o backend recusa com 400): o caminho sai só do contrato e dos ids de URL.
      resp = await doFetch(`${base}${caminhoPortal(rota, params)}`, init);
    } catch {
      throw new ErroPortal(0);
    }
    if (resp.status !== def.sucesso) throw await erroDaResposta(resp);
    let dados: unknown;
    try {
      dados = await resp.json();
    } catch {
      // Corpo interrompido pelo relógio é falha de rede, não contrato quebrado.
      if (init.signal?.aborted) throw new ErroPortal(0);
      opcoes.aoDivergir?.(rota, ['$: corpo não é JSON']);
      throw new ErroPortal(STATUS_FORA_DO_CONTRATO);
    }
    const divergencias = conferirRespostaPortal(rota, dados);
    if (divergencias.length > 0) {
      opcoes.aoDivergir?.(rota, divergencias);
      throw new ErroPortal(STATUS_FORA_DO_CONTRATO);
    }
    return dados as ApiPortal[R]['resposta'];
  }

  return {
    vinculos: () => chamar('GET /portal/vinculos'),
    escolherVinculo: (vinculoId) => chamar('POST /portal/sessao/vinculo', {}, { vinculoId } satisfies C<'POST /portal/sessao/vinculo'>),
    sessao: () => chamar('GET /portal/sessao'),
    resgatarConvite: (token) => chamar('POST /portal/convites/resgate', {}, { token } satisfies C<'POST /portal/convites/resgate'>),
    confirmarConvite: (token, codigo) =>
      chamar('POST /portal/convites/resgate/confirmar', {}, { token, codigo } satisfies C<'POST /portal/convites/resgate/confirmar'>),
    consultas: () => chamar('GET /portal/consultas'),
    confirmarConsulta: (id) => chamar('POST /portal/consultas/:id/confirmar', { id }, {}),
    desfazerConfirmacao: (id) => chamar('POST /portal/consultas/:id/desfazer-confirmacao', { id }, {}),
    cancelarConsulta: (id) => chamar('POST /portal/consultas/:id/cancelar', { id }, {}),
    recibos: () => chamar('GET /portal/recibos'),
    recibo: (id) => chamar('GET /portal/recibos/:id', { id }),
    documentos: () => chamar('GET /portal/documentos'),
    meusDados: () => chamar('GET /portal/meus-dados'),
    pedirCorrecao: ({ detalhe, nascimento }) =>
      chamar('POST /portal/meus-dados/correcao', {}, (nascimento ? { detalhe, nascimento } : { detalhe }) satisfies C<'POST /portal/meus-dados/correcao'>),
    pedidos: () => chamar('GET /portal/solicitacoes'),
    abrirPedido: (tipo, detalhe) =>
      chamar('POST /portal/solicitacoes', {}, (detalhe?.trim() ? { tipo, detalhe } : { tipo }) satisfies C<'POST /portal/solicitacoes'>),
    consentimentos: () => chamar('GET /portal/privacidade/consentimentos'),
    responderConsentimento: (finalidade, resposta) =>
      chamar('POST /portal/privacidade/consentimentos/:finalidade', { finalidade }, { resposta } satisfies C<'POST /portal/privacidade/consentimentos/:finalidade'>),
    desfazerConsentimento: (finalidade) => chamar('POST /portal/privacidade/consentimentos/:finalidade/desfazer', { finalidade }, {}),
    historicoConsentimento: (finalidade) => chamar('GET /portal/privacidade/consentimentos/:finalidade/historico', { finalidade }),
  };
}

/**
 * Erro HTTP → `ErroPortal`. Do corpo (forma `ErroDaApi`) só se aproveitam `codigo` e `campos` (nomes,
 * filtrados por formato); `message` e o resto são descartados, nunca vão para log.
 */
async function erroDaResposta(resp: Response): Promise<ErroPortal> {
  let corpo: unknown;
  try {
    corpo = await resp.json();
  } catch {
    corpo = undefined;
  }
  if (typeof corpo !== 'object' || corpo === null || Array.isArray(corpo)) return new ErroPortal(resp.status);
  // Lê só os dois campos de `ErroDaApi` que importam (o Nest pode mandar outros, como `error`).
  const { codigo, campos } = corpo as Record<string, unknown>;
  return new ErroPortal(
    resp.status,
    typeof codigo === 'string' && /^[a-z_]{1,64}$/.test(codigo) ? codigo : undefined,
    Array.isArray(campos) ? campos.filter((c): c is string => typeof c === 'string' && /^[A-Za-z0-9_.]{1,64}$/.test(c)) : [],
  );
}
