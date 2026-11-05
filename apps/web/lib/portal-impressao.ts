/**
 * Impressão do recibo no portal (R2 do parecer do #75). A folha tem nome, CPF e profissional: ela só
 * existe enquanto a impressão acontece e sai da página por QUALQUER um destes sinais, o que vier
 * primeiro: `afterprint`, fim do `matchMedia('print')` ou o limite de tempo (reserva para quando o
 * navegador não avisa). Sem estado global: a janela é injetada para dar para testar sem DOM.
 */

/** Reserva: depois disso a folha sai da página mesmo sem aviso do navegador. */
export const LIMITE_FOLHA_MS = 60_000;

/** Atraso para o React montar a folha antes de abrir a impressão. */
export const ATRASO_IMPRESSAO_MS = 50;

type Ouvinte = (e: { matches: boolean }) => void;

export interface ConsultaDeMidia {
  readonly matches: boolean;
  addEventListener(tipo: 'change', fn: Ouvinte): void;
  removeEventListener(tipo: 'change', fn: Ouvinte): void;
}

export interface JanelaDeImpressao {
  print(): void;
  addEventListener(tipo: 'afterprint', fn: () => void): void;
  removeEventListener(tipo: 'afterprint', fn: () => void): void;
  matchMedia?(consulta: string): ConsultaDeMidia;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

/**
 * Abre a impressão e chama `limpar` UMA vez quando ela termina (ou no limite). Devolve a função de
 * desmontagem (para o `useEffect`), que tira todos os ouvintes e timers sem chamar `limpar`.
 */
export function imprimirELimpar(janela: JanelaDeImpressao, limpar: () => void, limiteMs = LIMITE_FOLHA_MS): () => void {
  let feito = false;
  const midia = janela.matchMedia?.('print');

  const desmontar = () => {
    janela.removeEventListener('afterprint', terminar);
    midia?.removeEventListener('change', aoMudarMidia);
    janela.clearTimeout(tImprimir);
    janela.clearTimeout(tLimite);
  };
  function terminar() {
    if (feito) return;
    feito = true;
    desmontar();
    limpar();
  }
  function aoMudarMidia(e: { matches: boolean }) {
    // `matches` volta a false quando a pré-visualização/impressão fecha.
    if (!e.matches) terminar();
  }

  janela.addEventListener('afterprint', terminar);
  midia?.addEventListener('change', aoMudarMidia);
  const tImprimir = janela.setTimeout(() => janela.print(), ATRASO_IMPRESSAO_MS);
  const tLimite = janela.setTimeout(terminar, limiteMs);
  return desmontar;
}
