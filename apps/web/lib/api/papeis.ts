import type { Papel, PedidoExportacao, Usuario } from './tipos';

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

/**
 * A tela mostra o botão de aprovar a exportação a esta pessoa? Espelha o contrato de `aprovarExportacao`
 * (o servidor decide de novo): `rt` → o RT; `admin` → outro admin, nunca quem pediu; `autoaprovacao` → o RT que pediu.
 */
export function podeAprovarExportacao(
  usuario: Pick<Usuario, 'id' | 'papel' | 'responsavelTecnico'> | null | undefined,
  pedido: Pick<PedidoExportacao, 'pedidoPor' | 'confirmacao' | 'status'> | null | undefined,
): boolean {
  if (!usuario || pedido?.status !== 'aguardando_rt') return false;
  if (pedido.confirmacao === 'rt') return ehResponsavelTecnico(usuario);
  if (pedido.confirmacao === 'admin') return ehAdmin(usuario.papel) && usuario.id !== pedido.pedidoPor;
  return ehResponsavelTecnico(usuario) && usuario.id === pedido.pedidoPor;
}
