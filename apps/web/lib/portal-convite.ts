/**
 * Regras do resgate do convite do portal (P4 do parecer de 24/10; §10h), sem React e sem DOM, para
 * dar para testar (R4 do parecer do #75). A tela é `components/portal/resgate-convite.tsx`.
 * - o token chega no `#fragmento` (nunca na query) e é APAGADO da barra/histórico na hora;
 * - qualquer falha do convite (404, 409, 422, 500...) mostra a MESMA frase: não revela se o convite
 *   existe, já foi usado ou é de outra pessoa;
 * - o OTP tem 6 números.
 */
import { ErroPortal, mensagemDoErro } from './api/portal';

export const FALHA_DO_CONVITE = mensagemDoErro(409, 'convite_invalido');

/** Tira o token do fragmento (`#<token>` ou `#convite=<token>`). Nunca olha a query. */
export function tokenDoFragmento(hash: string): string {
  const bruto = hash.replace(/^#/, '');
  const valor = bruto.startsWith('convite=') ? bruto.slice('convite='.length) : bruto;
  try {
    return decodeURIComponent(valor).trim();
  } catch {
    return '';
  }
}

/** Lê o token do fragmento e o apaga da barra de endereço e do histórico (mantém só o caminho). */
export function tirarTokenDaBarra(local: { hash: string; pathname: string }, historico: Pick<History, 'replaceState'>): string {
  const token = tokenDoFragmento(local.hash);
  if (local.hash) historico.replaceState(null, '', local.pathname);
  return token;
}

/** OTP: só dígitos, 6 números (espaços ignorados). `null` se inválido. */
export function codigoDoOtp(digitado: string): string | null {
  const c = digitado.replace(/\s/g, '');
  return /^\d{6}$/.test(c) ? c : null;
}

/** Mensagem da tela: falha do convite é sempre a mesma; só sessão (401) e limite (429) têm texto próprio. */
export function mensagemDoResgate(e: unknown): { texto: string; entrar: boolean } {
  if (e instanceof ErroPortal && e.status === 401) return { texto: 'Para usar o convite, entre primeiro no portal.', entrar: true };
  if (e instanceof ErroPortal && e.status === 429) return { texto: mensagemDoErro(429), entrar: false };
  return { texto: FALHA_DO_CONVITE, entrar: false };
}
