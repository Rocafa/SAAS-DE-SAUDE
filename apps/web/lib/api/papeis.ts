import type { Papel } from './tipos';

/**
 * Quem pode o que, do lado do cliente. Mesma ideia de `podeConferirDocumento`: o predicado vive aqui,
 * o adaptador falso o aplica e a tela o repete — a API real decide de novo e responde 403. A tela
 * nunca é a única guardiã.
 */
export function ehAdmin(papel: Papel): boolean {
  return papel === 'admin';
}

/**
 * Responsável técnico (RT) da clínica: quem aprova a exportação total (G2, R9 da revisão de 12/10).
 * É um atributo da pessoa, não um papel de acesso: o RT pode ser admin (o autônomo) ou só profissional.
 */
export function ehResponsavelTecnico(usuario: { responsavelTecnico?: boolean } | null | undefined): boolean {
  return usuario?.responsavelTecnico === true;
}
