import { ehDataValida, exigirObjeto, Validador } from '../../common/validacao';
import { AI_TASKS, type AiTask } from '../ai/llm-provider';
import { toCsv } from '../exports/csv';
import { decodificarCursor, LIMITE_MAXIMO, LIMITE_PADRAO, PERIODO_MAXIMO_DIAS } from './consulta-trilha';
import {
  SCOPE_IA_RESULTADO,
  SCOPE_IA_REVISAO,
  SCOPE_IA_TENTATIVA,
  STATUS_RESULTADO_IA,
  type StatusResultadoIa,
} from './registro-ia';

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
  'status',
  'motivo',
  'resultadoEm',
  'revisaoHumana',
  'decisao',
  'revisadoEm',
  'revisorId',
  'saidaFinalHash',
  'chaveHash',
  'chaveHashSaida',
  'chaveHashFinal',
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
  /** Chave do HMAC da saída (linha `ai_result`); igual à da tentativa salvo rotação no meio. */
  readonly chaveHashSaida: string | null;
  /** Chave do HMAC do texto final (linha `ai_review` editada). */
  readonly chaveHashFinal: string | null;
  /** Status do resultado; `sem_resultado` = a tentativa foi gravada e o resultado não (falha da trilha). */
  readonly status: StatusResultadoIa | 'sem_resultado';
  /** Por que o resultado é erro sem ter vindo do provedor (ex.: `mac_indisponivel`). */
  readonly motivo: string | null;
  readonly resultadoEm: string | null;
}

/** Linha crua da trilha (`audit_log`) de um evento de IA, como o SELECT sob RLS devolve. */
export interface EventoTrilhaIa {
  readonly id: string;
  readonly createdAt: Date | string;
  readonly actorId: string;
  readonly scope: string;
  readonly metadata: Record<string, unknown>;
}

const texto = (m: Record<string, unknown> | undefined, k: string): string | null => {
  const v = m?.[k];
  return typeof v === 'string' && v ? v : null;
};
const numero = (m: Record<string, unknown> | undefined, k: string): number | null => {
  const v = m?.[k];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};
const iso = (d: Date | string): string => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());

/**
 * Junta os eventos de cada uso (item 3 do veto do Guardião no #227): uma linha por TENTATIVA
 * (`ai_attempt`), com o `ai_result` e o `ai_review` do mesmo `use_id`. Tentativa sem resultado
 * aparece como `sem_resultado`, nunca some. Resultado ou revisão sem tentativa não geram linha (não
 * há o que atribuir). Ordem: tentativa mais recente primeiro.
 */
export function juntarEventosIa(eventos: readonly EventoTrilhaIa[]): LinhaAuditoriaIaDto[] {
  const porUso = new Map<string, { tentativa?: EventoTrilhaIa; resultado?: EventoTrilhaIa; revisao?: EventoTrilhaIa }>();
  for (const e of eventos) {
    const uso = texto(e.metadata, 'use_id');
    if (!uso) continue;
    const g = porUso.get(uso) ?? {};
    // Só o primeiro de cada tipo vale (a revisão é única por desenho; o resto seria anomalia).
    if (e.scope === SCOPE_IA_TENTATIVA) g.tentativa ??= e;
    else if (e.scope === SCOPE_IA_RESULTADO) g.resultado ??= e;
    else if (e.scope === SCOPE_IA_REVISAO) g.revisao ??= e;
    else continue;
    porUso.set(uso, g);
  }
  const linhas: { ordem: [number, string]; dto: LinhaAuditoriaIaDto }[] = [];
  for (const [usoId, { tentativa, resultado, revisao }] of porUso) {
    if (!tentativa) continue;
    const t = tentativa.metadata;
    const r = resultado?.metadata;
    const v = revisao?.metadata;
    const status = texto(r, 'status');
    linhas.push({
      ordem: [new Date(tentativa.createdAt).getTime(), tentativa.id],
      dto: {
        id: tentativa.id,
        usoId,
        em: iso(tentativa.createdAt),
        finalidade: (texto(t, 'task') ?? 'escriba') as AiTask,
        usuarioId: tentativa.actorId,
        pacienteId: texto(t, 'patient_id'),
        profissionalId: texto(t, 'professional_id'),
        modelo: texto(r, 'model') ?? texto(t, 'model'),
        versaoModelo: texto(r, 'model_version') ?? texto(t, 'model_version'),
        promptHash: texto(t, 'prompt_hash'),
        saidaHash: texto(r, 'output_hash'),
        tokensEntrada: numero(r, 'input_tokens'),
        tokensCache: numero(r, 'cached_input_tokens'),
        tokensSaida: numero(r, 'output_tokens'),
        latenciaMs: numero(r, 'latency_ms'),
        revisaoHumana: v?.['human_reviewed'] === true,
        decisao: texto(v, 'decision') ?? texto(r, 'decision'),
        revisadoEm: revisao ? iso(revisao.createdAt) : null,
        revisorId: texto(v, 'reviewer_id'),
        saidaFinalHash: texto(v, 'final_output_hash'),
        chaveHash: texto(t, 'hash_key_id'),
        chaveHashSaida: texto(r, 'hash_key_id'),
        chaveHashFinal: texto(v, 'hash_key_id'),
        status: (STATUS_RESULTADO_IA as readonly string[]).includes(status ?? '') ? (status as StatusResultadoIa) : 'sem_resultado',
        motivo: texto(r, 'motivo'),
        resultadoEm: resultado ? iso(resultado.createdAt) : null,
      },
    });
  }
  linhas.sort((a, b) => b.ordem[0] - a.ordem[0] || (a.ordem[1] < b.ordem[1] ? 1 : a.ordem[1] > b.ordem[1] ? -1 : 0));
  return linhas.map((l) => l.dto);
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
      l.status,
      l.motivo,
      l.resultadoEm,
      l.revisaoHumana ? 'true' : 'false',
      l.decisao,
      l.revisadoEm,
      l.revisorId,
      l.saidaFinalHash,
      l.chaveHash,
      l.chaveHashSaida,
      l.chaveHashFinal,
      l.id,
      l.usoId,
    ]),
  );
}
