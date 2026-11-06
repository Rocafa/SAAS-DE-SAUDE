/**
 * Classe única do campo de formulário. Altura mínima de 56 px (alvo de toque), borda forte e letra
 * de 18 px: a mesma régua do E2E, que reprova qualquer controle com menos de 48 px. Era copiada em
 * nove telas — mudar o alvo de toque ou o contraste exigia acertar as nove, e quem esquecesse uma
 * não veria diferença no CI.
 */
export const CAMPO = 'min-h-14 w-full rounded-md border-2 border-borda-forte bg-fundo px-4 text-lg';
