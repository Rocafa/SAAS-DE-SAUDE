import { ehDataValida, ehHoraValida, exigirObjeto, Validador, type Entrada } from '../../common/validacao';
import { MAXIMO_DIAS_DA_SERIE, MAXIMO_SESSOES_DA_SERIE, type RegraDaSerie } from './series-regras';

export interface NovaSerie extends RegraDaSerie {
  readonly pacienteId: string;
  readonly profissionalId: string;
  readonly tipoId: string;
  readonly pacoteId?: string;
  /** HH:MM no fuso da clínica. */
  readonly hora: string;
  /** Duração de cada sessão; sem ela, a do tipo de atendimento. */
  readonly minutos?: number;
}

export interface FiltroSeries {
  readonly pacienteId?: string;
  readonly profissionalId?: string;
  readonly pacoteId?: string;
}

function diasEntre(de: string, ate: string): number {
  return Math.round((Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / 86_400_000);
}

/** Dias da semana: 1 a 7 inteiros 0–6 (domingo = 0), sem repetição; devolve em ordem. */
function dias(v: Validador, entrada: Entrada): number[] {
  const valor = entrada['dias'];
  if (
    !Array.isArray(valor) ||
    valor.length < 1 ||
    valor.length > 7 ||
    !valor.every((d) => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6) ||
    new Set(valor).size !== valor.length
  ) {
    v.falhar('dias');
    return [];
  }
  return [...(valor as number[])].sort((a, b) => a - b);
}

function data(v: Validador, campo: string, obrigatorio: boolean): string | undefined {
  const d = obrigatorio ? v.texto(campo, { max: 10, obrigatorio: true }) : v.texto(campo, { max: 10 });
  if (d !== undefined && !ehDataValida(d)) v.falhar(campo);
  return d;
}

/**
 * Corpo do POST /series. Exatamente um de `sessoes` (1–100) e `dataFinal` (até 366 dias depois da inicial).
 * `intervaloSemanas`: 1 (semanal, padrão) a 4. `minutos` opcional (5–480; padrão: a duração do tipo).
 */
export function validarNovaSerie(corpo: unknown): NovaSerie {
  const entrada = exigirObjeto(corpo, [
    'pacienteId',
    'profissionalId',
    'tipoId',
    'pacoteId',
    'dias',
    'intervaloSemanas',
    'hora',
    'minutos',
    'dataInicial',
    'sessoes',
    'dataFinal',
  ]);
  const v = new Validador(entrada);
  const pacienteId = v.uuid('pacienteId', true);
  const profissionalId = v.uuid('profissionalId', true);
  const tipoId = v.uuid('tipoId', true);
  const pacoteId = v.uuid('pacoteId', false);
  const ds = dias(v, entrada);
  const intervaloSemanas = v.inteiro('intervaloSemanas', { min: 1, max: 4 }) ?? 1;
  const hora = v.texto('hora', { max: 5, obrigatorio: true });
  if (hora !== undefined && !ehHoraValida(hora)) v.falhar('hora');
  const minutos = v.inteiro('minutos', { min: 5, max: 480 });
  const dataInicial = data(v, 'dataInicial', true);
  const sessoes = v.inteiro('sessoes', { min: 1, max: MAXIMO_SESSOES_DA_SERIE });
  const dataFinal = data(v, 'dataFinal', false);
  if ((sessoes === undefined) === (dataFinal === undefined)) v.falhar(v.tem('sessoes') ? 'dataFinal' : 'sessoes');
  if (dataInicial && dataFinal && ehDataValida(dataInicial) && ehDataValida(dataFinal)) {
    const n = diasEntre(dataInicial, dataFinal);
    if (n < 0 || n > MAXIMO_DIAS_DA_SERIE) v.falhar('dataFinal');
  }
  v.concluir();
  return {
    pacienteId: pacienteId as string,
    profissionalId: profissionalId as string,
    tipoId: tipoId as string,
    ...(pacoteId ? { pacoteId } : {}),
    dias: ds,
    intervaloSemanas,
    hora: hora,
    ...(minutos !== undefined ? { minutos } : {}),
    dataInicial: dataInicial as string,
    ...(sessoes !== undefined ? { sessoes } : {}),
    ...(dataFinal !== undefined ? { dataFinal } : {}),
  };
}

/** Corpo do POST /series/:id/cancelar: `aPartirDe` (AAAA-MM-DD, no calendário da clínica). */
export function validarCancelamentoDeSerie(corpo: unknown): { aPartirDe: string } {
  const v = new Validador(exigirObjeto(corpo, ['aPartirDe']));
  const aPartirDe = data(v, 'aPartirDe', true);
  v.concluir();
  return { aPartirDe: aPartirDe as string };
}

export function validarFiltroSeries(query: unknown): FiltroSeries {
  const v = new Validador(exigirObjeto(query ?? {}, ['pacienteId', 'profissionalId', 'pacoteId']));
  const pacienteId = v.uuid('pacienteId', false);
  const profissionalId = v.uuid('profissionalId', false);
  const pacoteId = v.uuid('pacoteId', false);
  v.concluir();
  return {
    ...(pacienteId ? { pacienteId } : {}),
    ...(profissionalId ? { profissionalId } : {}),
    ...(pacoteId ? { pacoteId } : {}),
  };
}
