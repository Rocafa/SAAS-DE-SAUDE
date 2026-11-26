import { ehDataValida, ehHoraValida, exigirObjeto, Validador, type Entrada } from '../../common/validacao';
import { WAITLIST_PERIODS, type WaitlistPeriod } from '../../db/schema';
import { diaDaSemana, normalizarDias, OBSERVACAO_MAX, periodoDaHora } from './lista-espera-regras';
import { validarNovoAgendamento, type NovoAgendamento } from './scheduling.validation';

export interface NovoItemEspera {
  readonly pacienteId: string;
  readonly profissionalId?: string;
  readonly dias: readonly number[];
  readonly periodo: WaitlistPeriod | null;
  /** Curta e administrativa (até OBSERVACAO_MAX); nunca dado clínico. Gravada só cifrada. */
  readonly observacao: string | null;
}

/** Filtro da listagem: "candidatos compatíveis" com uma vaga (profissional, dia e período), em ordem de entrada. */
export interface FiltroEspera {
  readonly profissionalId?: string;
  readonly dia?: number;
  readonly periodo?: WaitlistPeriod;
}

/** Motivos que a rota DELETE aceita (`agendado` só pela rota de marcar). */
export const MOTIVOS_DE_RETIRADA = ['retirado', 'desistencia'] as const;
export type MotivoDeRetirada = (typeof MOTIVOS_DE_RETIRADA)[number];

/** Dias da semana: lista de inteiros 0–6 (domingo = 0), no máximo 7. */
function dias(v: Validador, entrada: Entrada): number[] {
  if (!v.tem('dias')) return [];
  const valor = entrada['dias'];
  if (!Array.isArray(valor) || valor.length > 7 || !valor.every((d) => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6)) {
    v.falhar('dias');
    return [];
  }
  return normalizarDias(valor as number[]);
}

/**
 * Corpo do POST /espera. `preferencia` (texto livre do contrato do fake) é aceito como sinônimo da observação,
 * com o mesmo limite; mandar os dois é erro.
 */
export function validarNovoItemEspera(corpo: unknown): NovoItemEspera {
  const entrada = exigirObjeto(corpo, ['pacienteId', 'profissionalId', 'dias', 'periodo', 'observacao', 'preferencia']);
  const v = new Validador(entrada);
  const pacienteId = v.uuid('pacienteId', true);
  const profissionalId = v.uuid('profissionalId', false);
  const ds = dias(v, entrada);
  const periodo = v.umDe('periodo', WAITLIST_PERIODS, false) ?? null;
  // Texto vazio (o front manda '' quando nada foi digitado) vale como "sem observação".
  const vazio = (campo: string) => typeof entrada[campo] === 'string' && entrada[campo].trim() === '';
  const observacao = vazio('observacao') ? undefined : v.texto('observacao', { max: OBSERVACAO_MAX });
  const preferencia = vazio('preferencia') ? undefined : v.texto('preferencia', { max: OBSERVACAO_MAX });
  if (observacao !== undefined && preferencia !== undefined) v.falhar('preferencia');
  v.concluir();
  return {
    pacienteId: pacienteId as string,
    ...(profissionalId ? { profissionalId } : {}),
    dias: ds,
    periodo,
    observacao: observacao ?? preferencia ?? null,
  };
}

/** Query do GET /espera: `profissionalId`, e a vaga por `data` (AAAA-MM-DD) e/ou `hora` (HH:MM) no fuso da clínica. */
export function validarFiltroEspera(query: unknown): FiltroEspera {
  const v = new Validador(exigirObjeto(query ?? {}, ['profissionalId', 'data', 'hora']));
  const profissionalId = v.uuid('profissionalId', false);
  const data = v.texto('data', { max: 10 });
  const hora = v.texto('hora', { max: 5 });
  if (data !== undefined && !ehDataValida(data)) v.falhar('data');
  if (hora !== undefined && !ehHoraValida(hora)) v.falhar('hora');
  v.concluir();
  return {
    ...(profissionalId ? { profissionalId } : {}),
    ...(data !== undefined ? { dia: diaDaSemana(data) } : {}),
    ...(hora !== undefined ? { periodo: periodoDaHora(hora) } : {}),
  };
}

/** Query do DELETE /espera/:id: `motivo` opcional (padrão `retirado`). */
export function validarRetirada(query: unknown): MotivoDeRetirada {
  const v = new Validador(exigirObjeto(query ?? {}, ['motivo']));
  const motivo = v.umDe('motivo', MOTIVOS_DE_RETIRADA, false) ?? 'retirado';
  v.concluir();
  return motivo;
}

/**
 * Corpo do POST /espera/:id/marcar: o do POST /agendamentos SEM `pacienteId` (vem do item). `profissionalId`
 * omitido usa o do item (409 `espera_sem_profissional` se o item não tiver).
 */
export function validarMarcacaoDaEspera(corpo: unknown): Omit<NovoAgendamento, 'pacienteId' | 'profissionalId'> & { readonly profissionalId?: string } {
  const entrada = exigirObjeto(corpo, ['profissionalId', 'tipoId', 'data', 'hora', 'encaixe']);
  // Mesmas regras do POST /agendamentos; o paciente e, se faltar, o profissional entram depois (marcadores válidos).
  const MARCADOR = '00000000-0000-4000-8000-000000000000';
  const temProfissional = entrada['profissionalId'] !== undefined;
  const dados = validarNovoAgendamento({ ...entrada, pacienteId: MARCADOR, ...(temProfissional ? {} : { profissionalId: MARCADOR }) });
  return {
    tipoId: dados.tipoId,
    data: dados.data,
    hora: dados.hora,
    encaixe: dados.encaixe,
    ...(temProfissional ? { profissionalId: dados.profissionalId } : {}),
  };
}
