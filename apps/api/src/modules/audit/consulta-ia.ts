import { ehDataValida, exigirObjeto, Validador } from '../../common/validacao';
import { AI_TASKS, type AiTask } from '../ai/llm-provider';
import { toCsv } from '../exports/csv';
import { decodificarCursor, LIMITE_MAXIMO, LIMITE_PADRAO, PERIODO_MAXIMO_DIAS } from './consulta-trilha';

export const LIMITE_PADRAO_IA = LIMITE_PADRAO;

const COLUNAS_CSV = [
  'em',
  'finalidade',
  'usuarioId',
  'pacienteId',
  'profissionalId',
  'modelo',
  'versaoModelo',
  'promptHash',
  'saidaHash',
  'tokensEntrada',
  'tokensCache',
  'tokensSaida',
  'latenciaMs',
  'revisaoHumana',
  'decisao',
  'revisadoEm',
  'revisorId',
  'saidaFinalHash',
  'chaveHash',
  'id',
  'usoId',
] as const;

export interface FiltroIa {
  readonly de?: string;
  readonly ate?: string;
  readonly profissionalId?: string;
  readonly finalidade?: AiTask;
  readonly limite: number;
  readonly cursor?: string;
}

export interface LinhaAuditoriaIaDto {
  readonly id: string;
  readonly usoId: string;
  readonly em: string;
  readonly finalidade: AiTask;
  readonly usuarioId: string;
  readonly pacienteId: string | null;
  readonly profissionalId: string | null;
  readonly modelo: string | null;
  readonly versaoModelo: string | null;
  readonly promptHash: string | null;
  readonly saidaHash: string | null;
  readonly tokensEntrada: number | null;
  readonly tokensCache: number | null;
  readonly tokensSaida: number | null;
  readonly latenciaMs: number | null;
  readonly revisaoHumana: boolean;
  readonly decisao: string | null;
  readonly revisadoEm: string | null;
  readonly revisorId: string | null;
  readonly saidaFinalHash: string | null;
  /**
   * `hash_key_id` da linha: os três hashes são HMAC-SHA256 da clínica (veto do Guardião no #227),
   * só conferíveis por quem tem a chave; sem ela não servem para dicionário nem ligam clínicas.
   */
  readonly chaveHash: string | null;
}

/** Query fechada: somente datas, UUID, finalidade conhecida e paginação; nenhum texto livre na URL. */
export function validarFiltroIa(query: unknown): FiltroIa {
  const v = new Validador(exigirObjeto(query ?? {}, ['de', 'ate', 'profissionalId', 'finalidade', 'limite', 'cursor']));
  const de = v.texto('de', { max: 10 });
  const ate = v.texto('ate', { max: 10 });
  const profissionalId = v.uuid('profissionalId', false);
  const finalidade = v.umDe('finalidade', AI_TASKS, false);
  const limite = v.inteiroDeTexto('limite', { min: 1, max: LIMITE_MAXIMO, padrao: LIMITE_PADRAO_IA });
  const cursorTexto = v.texto('cursor', { max: 200 });
  if (de !== undefined && !ehDataValida(de)) v.falhar('de');
  if (ate !== undefined && !ehDataValida(ate)) v.falhar('ate');
  if (de !== undefined && ate !== undefined && ehDataValida(de) && ehDataValida(ate)) {
    if (de > ate) v.falhar('ate');
    else if ((Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / 86_400_000 >= PERIODO_MAXIMO_DIAS) {
      v.falhar('ate');
    }
  }
  const cursor = cursorTexto === undefined ? undefined : decodificarCursor(cursorTexto);
  if (cursor === null) v.falhar('cursor');
  v.concluir();
  return {
    limite,
    ...(de ? { de } : {}),
    ...(ate ? { ate } : {}),
    ...(profissionalId ? { profissionalId } : {}),
    ...(finalidade ? { finalidade } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

/** Projeta somente metadados já pseudonimizados; o helper comum aplica RFC 4180, BOM e defesa contra fórmula. */
export function paraCsvAuditoriaIa(linhas: readonly LinhaAuditoriaIaDto[]): string {
  return toCsv(
    COLUNAS_CSV,
    linhas.map((l) => [
      l.em,
      l.finalidade,
      l.usuarioId,
      l.pacienteId,
      l.profissionalId,
      l.modelo,
      l.versaoModelo,
      l.promptHash,
      l.saidaHash,
      l.tokensEntrada,
      l.tokensCache,
      l.tokensSaida,
      l.latenciaMs,
      l.revisaoHumana ? 'true' : 'false',
      l.decisao,
      l.revisadoEm,
      l.revisorId,
      l.saidaFinalHash,
      l.chaveHash,
      l.id,
      l.usoId,
    ]),
  );
}
