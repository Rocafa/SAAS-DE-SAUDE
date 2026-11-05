/**
 * Paginação por cursor opaco e assinado (R5 do parecer PR #76). Vale para `GET /pacientes` e
 * `POST /pacientes/busca`.
 *
 * - Primeira página: sem `cursor` (e sem `pagina`, ou `pagina=1`).
 * - Páginas seguintes: `cursor` = `proximoCursor` da resposta anterior, com o MESMO filtro
 *   (`situacao`, `limite` e, na busca, o mesmo `busca`). `pagina` > 1 sem cursor = 400 `pagina`.
 * - O cursor vale só para a mesma sessão (clínica + usuário) e por 10 minutos. Cursor de outra sessão,
 *   de outro filtro, vencido ou adulterado = 409 `cursor_invalido`, sem dados: o cliente descarta o que
 *   já juntou e recomeça da primeira página (conferindo a sessão).
 * - O cursor é opaco: o cliente não deve abrir nem montar. Não leva dado pessoal (só ids técnicos).
 */

/** Código do 409 de cursor recusado. */
export const CURSOR_INVALIDO = 'cursor_invalido' as const;

export interface PaginaPorCursor<T> {
  readonly itens: readonly T[];
  /** Número da página devolvida (1 na primeira). Informativo: a navegação é pelo cursor. */
  readonly pagina: number;
  readonly limite: number;
  readonly temMais: boolean;
  /** Cursor da próxima página; `null` quando `temMais` é false. */
  readonly proximoCursor: string | null;
}
