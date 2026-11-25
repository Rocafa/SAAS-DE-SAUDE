import { EntradaInvalidaError, ehDataValida, ehHoraValida, exigirObjeto, Validador } from '../../common/validacao';
import { SCHEDULE_BLOCK_REASONS, type ScheduleBlockReason } from '../../db/schema';
import { MAXIMO_JANELAS, type JanelaDaGrade } from './disponibilidade-regras';

/** Janela máxima de uma listagem de bloqueios (dias). */
export const JANELA_MAXIMA_BLOQUEIOS_DIAS = 400;
/** Anos aceitos para feriados (o feriado de 20/11 é nacional desde 2024: Lei 14.759/2023). */
export const ANO_MINIMO = 2024;
export const ANO_MAXIMO = 2100;

export interface NovoBloqueio {
  /** Ausente = clínica inteira. */
  readonly profissionalId?: string;
  readonly dataInicio: string;
  readonly horaInicio: string;
  /** Fim EXCLUSIVO; sem horaFim, o bloqueio vai até o fim do dia `dataFim` (inclusive). */
  readonly dataFim: string;
  readonly horaFim?: string;
  readonly motivo: ScheduleBlockReason;
}

export interface FiltroBloqueios {
  readonly de: string;
  readonly ate: string;
  readonly profissionalId?: string;
}

function janela(bruto: unknown): JanelaDaGrade | null {
  if (typeof bruto !== 'object' || bruto === null || Array.isArray(bruto)) return null;
  const v = new Validador(exigirObjeto(bruto, ['diaSemana', 'inicio', 'fim', 'minutos']));
  const diaSemana = v.inteiro('diaSemana', { min: 0, max: 6, obrigatorio: true });
  const inicio = v.texto('inicio', { max: 5, obrigatorio: true });
  const fim = v.texto('fim', { max: 5, obrigatorio: true });
  const minutos = v.inteiro('minutos', { min: 5, max: 480, obrigatorio: true });
  if (inicio !== undefined && !ehHoraValida(inicio)) v.falhar('inicio');
  if (fim !== undefined && !ehHoraValida(fim)) v.falhar('fim');
  try {
    v.concluir();
  } catch {
    return null;
  }
  return { diaSemana: diaSemana as number, inicio, fim, minutos: minutos as number };
}

/** PUT /agenda/grade/:profissionalId: `{ janelas: [{ diaSemana, inicio, fim, minutos }] }` (lista vazia limpa a grade). */
export function validarGrade(corpo: unknown): JanelaDaGrade[] {
  const entrada = exigirObjeto(corpo, ['janelas']);
  const bruto = entrada['janelas'];
  if (!Array.isArray(bruto) || bruto.length > MAXIMO_JANELAS) throw new EntradaInvalidaError(['janelas']);
  const janelas: JanelaDaGrade[] = [];
  for (const b of bruto) {
    const j = janela(b);
    if (!j) throw new EntradaInvalidaError(['janelas']);
    janelas.push(j);
  }
  return janelas;
}

export function validarFiltroGrade(query: unknown): string {
  const v = new Validador(exigirObjeto(query ?? {}, ['profissionalId']));
  const profissionalId = v.uuid('profissionalId', true);
  v.concluir();
  return profissionalId as string;
}

export function validarNovoBloqueio(corpo: unknown): NovoBloqueio {
  const v = new Validador(exigirObjeto(corpo, ['profissionalId', 'dataInicio', 'horaInicio', 'dataFim', 'horaFim', 'motivo']));
  const profissionalId = v.uuid('profissionalId', false);
  const dataInicio = v.texto('dataInicio', { max: 10, obrigatorio: true });
  const horaInicio = v.texto('horaInicio', { max: 5 }) ?? '00:00';
  const dataFim = v.texto('dataFim', { max: 10, obrigatorio: true });
  const horaFim = v.texto('horaFim', { max: 5 });
  const motivo = v.umDe('motivo', SCHEDULE_BLOCK_REASONS, true);
  if (dataInicio !== undefined && !ehDataValida(dataInicio)) v.falhar('dataInicio');
  if (dataFim !== undefined && !ehDataValida(dataFim)) v.falhar('dataFim');
  if (!ehHoraValida(horaInicio)) v.falhar('horaInicio');
  if (horaFim !== undefined && !ehHoraValida(horaFim)) v.falhar('horaFim');
  v.concluir();
  return {
    ...(profissionalId ? { profissionalId } : {}),
    dataInicio,
    horaInicio,
    dataFim,
    ...(horaFim !== undefined ? { horaFim } : {}),
    motivo: motivo as ScheduleBlockReason,
  };
}

export function validarFiltroBloqueios(query: unknown): FiltroBloqueios {
  const v = new Validador(exigirObjeto(query ?? {}, ['de', 'ate', 'profissionalId']));
  const de = v.texto('de', { max: 10, obrigatorio: true });
  const ate = v.texto('ate', { max: 10, obrigatorio: true });
  const profissionalId = v.uuid('profissionalId', false);
  if (de !== undefined && !ehDataValida(de)) v.falhar('de');
  if (ate !== undefined && !ehDataValida(ate)) v.falhar('ate');
  if (de && ate && ehDataValida(de) && ehDataValida(ate)) {
    const dias = (Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / 86_400_000;
    if (dias < 0 || dias > JANELA_MAXIMA_BLOQUEIOS_DIAS) v.falhar('ate');
  }
  v.concluir();
  return { de, ate, ...(profissionalId ? { profissionalId } : {}) };
}

export function validarAno(entrada: unknown): number {
  const v = new Validador(exigirObjeto(entrada ?? {}, ['ano']));
  const ano = typeof (entrada as Record<string, unknown> | null)?.['ano'] === 'string'
    ? v.inteiroDeTexto('ano', { min: ANO_MINIMO, max: ANO_MAXIMO, padrao: ANO_MINIMO })
    : v.inteiro('ano', { min: ANO_MINIMO, max: ANO_MAXIMO, obrigatorio: true });
  v.concluir();
  return ano as number;
}

export function validarNovoFeriado(corpo: unknown): { data: string; nome: string } {
  const v = new Validador(exigirObjeto(corpo, ['data', 'nome']));
  const data = v.texto('data', { max: 10, obrigatorio: true });
  const nome = v.texto('nome', { max: 60, obrigatorio: true });
  if (data !== undefined && !ehDataValida(data)) v.falhar('data');
  v.concluir();
  return { data, nome };
}
