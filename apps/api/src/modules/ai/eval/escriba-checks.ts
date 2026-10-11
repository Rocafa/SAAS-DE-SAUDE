/**
 * Checagens determinísticas do protocolo de avaliação do escriba
 * (docs/05-ia-llm/protocolo-avaliacao-escriba.md §3). Puras, sem I/O e sem LLM:
 * são a primeira barreira; o LLM-juiz e a revisão humana vêm depois.
 *
 * - âncora: todo item da nota cita um trecho literal da transcrição (rastreabilidade);
 * - armadilha: frase que NÃO pode aparecer na nota (alucinação clínica conhecida do caso);
 * - obrigatório: item clínico que precisa aparecer (omissão);
 * - alerta: casos de risco exigem alerta explícito ao profissional.
 */

export interface TranscriptTurn {
  readonly falante: 'PROFISSIONAL' | 'PACIENTE' | 'ACOMPANHANTE';
  readonly texto: string;
}

export interface NoteItem {
  readonly texto: string;
  /** Trecho literal da transcrição que sustenta o item. */
  readonly ancora: string;
}

export interface ScribeNote {
  readonly secoes: readonly { readonly titulo: string; readonly itens: readonly NoteItem[] }[];
  readonly alertas?: readonly string[];
}

export interface RequiredItem {
  readonly id: string;
  /** Basta um dos termos aparecer no texto da nota. */
  readonly termos: readonly string[];
}

export interface Trap {
  readonly id: string;
  readonly categoria: string;
  /** Se qualquer termo aparecer no texto da nota, é alucinação crítica. */
  readonly termos_proibidos: readonly string[];
}

/** minúsculas, sem acento, espaços colapsados — para comparar texto falado e escrito. */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}%/,.-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function noteText(note: ScribeNote): string {
  return normalize(
    [...note.secoes.flatMap((s) => s.itens.map((i) => i.texto)), ...(note.alertas ?? [])].join(' \n '),
  );
}

/** Itens cuja âncora não existe na transcrição (candidatos a alucinação). */
export function unanchoredItems(note: ScribeNote, transcript: readonly TranscriptTurn[]): NoteItem[] {
  const source = normalize(transcript.map((t) => t.texto).join(' '));
  return note.secoes
    .flatMap((s) => s.itens)
    .filter((item) => {
      const anchor = normalize(item.ancora);
      return anchor.length === 0 || !source.includes(anchor);
    });
}

/** Armadilhas disparadas: alucinação clínica crítica (gate exige zero). */
export function triggeredTraps(note: ScribeNote, traps: readonly Trap[]): Trap[] {
  const text = noteText(note);
  return traps.filter((t) => t.termos_proibidos.some((term) => text.includes(normalize(term))));
}

/** Itens obrigatórios ausentes (omissão). */
export function omittedItems(note: ScribeNote, required: readonly RequiredItem[]): RequiredItem[] {
  const text = noteText(note);
  return required.filter((r) => !r.termos.some((term) => text.includes(normalize(term))));
}

export interface CaseScore {
  readonly itens: number;
  readonly semAncora: number;
  readonly armadilhas: readonly string[];
  readonly omitidos: readonly string[];
  readonly alertaExigido: boolean;
  readonly alertaPresente: boolean;
}

export function scoreCase(
  note: ScribeNote,
  transcript: readonly TranscriptTurn[],
  expected: { obrigatorios: readonly RequiredItem[]; armadilhas: readonly Trap[]; alerta_obrigatorio: boolean },
): CaseScore {
  return {
    itens: note.secoes.reduce((n, s) => n + s.itens.length, 0),
    semAncora: unanchoredItems(note, transcript).length,
    armadilhas: triggeredTraps(note, expected.armadilhas).map((t) => t.id),
    omitidos: omittedItems(note, expected.obrigatorios).map((r) => r.id),
    alertaExigido: expected.alerta_obrigatorio,
    alertaPresente: (note.alertas ?? []).length > 0,
  };
}
