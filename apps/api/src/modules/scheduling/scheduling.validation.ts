import { ehDataValida, ehHoraValida, exigirObjeto, Validador } from '../../common/validacao';
import { STATUS_FRONT, type StatusFront } from './agenda-regras';

/** Janela máxima de uma listagem (dia, semana ou mês): a agenda nunca vem inteira (front-r8 R1). */
export const JANELA_MAXIMA_DIAS = 31;
/** Teto de linhas por listagem, mesmo dentro da janela. */
export const MAXIMO_AGENDAMENTOS = 1000;

export interface FiltroAgenda {
  readonly de: string;
  readonly ate: string;
  readonly profissionalId?: string;
  readonly pacienteId?: string;
}

export interface NovoAgendamento {
  readonly pacienteId: string;
  readonly profissionalId: string;
  readonly tipoId: string;
  readonly data: string;
  readonly hora: string;
  readonly encaixe: boolean;
}

export interface NovoProfissional {
  readonly nome: string;
  readonly especialidade: string;
  readonly capacidade: number;
  readonly usuarioId?: string;
}

export interface NovoTipoAtendimento {
  readonly nome: string;
  readonly minutos: number;
  readonly capacidade: number;
}

function dataEHora(v: Validador): { data: string | undefined; hora: string | undefined } {
  const data = v.texto('data', { max: 10, obrigatorio: true });
  const hora = v.texto('hora', { max: 5, obrigatorio: true });
  if (data !== undefined && !ehDataValida(data)) v.falhar('data');
  if (hora !== undefined && !ehHoraValida(hora)) v.falhar('hora');
  return { data, hora };
}

function diasEntre(de: string, ate: string): number {
  return (Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / 86_400_000;
}

export function validarFiltroAgenda(query: unknown): FiltroAgenda {
  const v = new Validador(exigirObjeto(query ?? {}, ['de', 'ate', 'profissionalId', 'pacienteId']));
  const de = v.texto('de', { max: 10, obrigatorio: true });
  const ate = v.texto('ate', { max: 10, obrigatorio: true });
  const profissionalId = v.uuid('profissionalId', false);
  const pacienteId = v.uuid('pacienteId', false);
  if (de !== undefined && !ehDataValida(de)) v.falhar('de');
  if (ate !== undefined && !ehDataValida(ate)) v.falhar('ate');
  if (de && ate && ehDataValida(de) && ehDataValida(ate)) {
    const dias = diasEntre(de, ate);
    if (dias < 0 || dias >= JANELA_MAXIMA_DIAS) v.falhar('ate');
  }
  v.concluir();
  return {
    de: de,
    ate: ate,
    ...(profissionalId ? { profissionalId } : {}),
    ...(pacienteId ? { pacienteId } : {}),
  };
}

export function validarNovoAgendamento(corpo: unknown): NovoAgendamento {
  const v = new Validador(exigirObjeto(corpo, ['pacienteId', 'profissionalId', 'tipoId', 'data', 'hora', 'encaixe']));
  const pacienteId = v.uuid('pacienteId', true);
  const profissionalId = v.uuid('profissionalId', true);
  const tipoId = v.uuid('tipoId', true);
  const { data, hora } = dataEHora(v);
  const encaixe = v.booleano('encaixe') ?? false;
  v.concluir();
  return {
    pacienteId: pacienteId as string,
    profissionalId: profissionalId as string,
    tipoId: tipoId as string,
    data: data as string,
    hora: hora as string,
    encaixe,
  };
}

export function validarRemarcacao(corpo: unknown): { data: string; hora: string } {
  const v = new Validador(exigirObjeto(corpo, ['data', 'hora']));
  const { data, hora } = dataEHora(v);
  v.concluir();
  return { data: data as string, hora: hora as string };
}

export function validarStatus(corpo: unknown): StatusFront {
  const v = new Validador(exigirObjeto(corpo, ['status']));
  const status = v.umDe('status', STATUS_FRONT, true);
  v.concluir();
  return status as StatusFront;
}

export function validarNovoProfissional(corpo: unknown): NovoProfissional {
  const v = new Validador(exigirObjeto(corpo, ['nome', 'especialidade', 'capacidade', 'usuarioId']));
  const nome = v.texto('nome', { max: 200, obrigatorio: true });
  const especialidade = v.texto('especialidade', { max: 100, obrigatorio: true });
  const capacidade = v.inteiro('capacidade', { min: 1, max: 20 }) ?? 1;
  const usuarioId = v.uuid('usuarioId', false);
  v.concluir();
  return { nome: nome, especialidade: especialidade, capacidade, ...(usuarioId ? { usuarioId } : {}) };
}

export function validarNovoTipo(corpo: unknown): NovoTipoAtendimento {
  const v = new Validador(exigirObjeto(corpo, ['nome', 'minutos', 'capacidade']));
  const nome = v.texto('nome', { max: 100, obrigatorio: true });
  const minutos = v.inteiro('minutos', { min: 5, max: 480, obrigatorio: true });
  const capacidade = v.inteiro('capacidade', { min: 1, max: 20 }) ?? 1;
  v.concluir();
  return { nome: nome, minutos: minutos as number, capacidade };
}
