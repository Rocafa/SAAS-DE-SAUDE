import type { Papel } from './tipos';

/**
 * Quem pode o que, do lado do cliente. Mesma ideia de `podeConferirDocumento`: o predicado vive aqui,
 * o adaptador falso o aplica e a tela o repete — a API real decide de novo e responde 403. A tela
 * nunca é a única guardiã.
 */
export function ehAdmin(papel: Papel): boolean {
  return papel === 'admin';
}
