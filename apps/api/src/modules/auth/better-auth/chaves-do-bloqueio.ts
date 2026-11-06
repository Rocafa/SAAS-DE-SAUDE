/**
 * Chave dos contadores de bloqueio (D4): HMAC com o segredo do rate limit, nunca o e-mail ou o id em claro. A proteção
 * (`protecao.ts`) conta e o desbloqueio pelo admin (PR 3b-2, R4 do #152) zera com a MESMA função.
 */
import { createHmac } from 'node:crypto';

export type TipoDeContador = 'login' | 'login-origem' | 'fator' | 'fator-origem' | 'totp-usado';

export function chaveDoBloqueio(chaveHmac: Uint8Array, tipo: TipoDeContador, valor: string): string {
  return `bl:v1:${tipo}:${createHmac('sha256', chaveHmac).update(`${tipo}:${valor}`).digest('hex').slice(0, 32)}`;
}
