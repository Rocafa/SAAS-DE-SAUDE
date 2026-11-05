/**
 * Senha vazada (R15 do parecer do desenho da D4): toda senha NOVA (troca, reset, definição) é conferida contra a base
 * pública de senhas vazadas por k-anonimato. Sai da API só o PREFIXO de 5 caracteres hexadecimais do SHA-1 da senha
 * (um entre ~1 milhão de baldes, cada um com centenas de sufixos); a comparação do resto é feita aqui. Nem a senha nem
 * o hash completo saem. O pedido vai com `Add-Padding`, para o tamanho da resposta não revelar o balde.
 *
 * Indisponível (rede, prazo de 2 s, resposta estranha): a troca SEGUE sem a conferência e o log de segurança alarma.
 * Falhar fechado impediria a troca de senha (inclusive a forçada pelo admin) por causa de um serviço de terceiro.
 */
import { createHash } from 'node:crypto';

/** true = a senha aparece na base de vazadas. Lança erro se não deu para conferir. */
export type ConferirSenhaVazada = (senha: string) => Promise<boolean>;

export const URL_DA_BASE = 'https://api.pwnedpasswords.com/range/';
export const PRAZO_DA_CONFERENCIA_MS = 2_000;

export function conferidorPorKAnonimato(o: { readonly buscar?: typeof fetch; readonly prazoMs?: number } = {}): ConferirSenhaVazada {
  const buscar = o.buscar ?? fetch;
  const prazoMs = o.prazoMs ?? PRAZO_DA_CONFERENCIA_MS;
  return async (senha) => {
    const hash = createHash('sha1').update(senha, 'utf8').digest('hex').toUpperCase();
    const prefixo = hash.slice(0, 5);
    const sufixo = hash.slice(5);
    const r = await buscar(`${URL_DA_BASE}${prefixo}`, {
      headers: { 'Add-Padding': 'true', 'User-Agent': 'plataforma-saude-conferencia-de-senha' },
      signal: AbortSignal.timeout(prazoMs),
      redirect: 'error',
    });
    if (!r.ok) throw new Error(`base de senhas vazadas respondeu ${r.status}`);
    const corpo = await r.text();
    for (const linha of corpo.split('\n')) {
      const [suf, contagem] = linha.trim().split(':');
      // Linhas de enchimento (Add-Padding) vêm com contagem 0.
      if (suf === sufixo && Number(contagem) > 0) return true;
    }
    return false;
  };
}
