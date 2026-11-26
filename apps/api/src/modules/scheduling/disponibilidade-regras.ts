import { noFusoDaClinica } from './agenda-regras';

/**
 * Regras puras de disponibilidade da agenda (HU-AGD-001 e HU-AGD-003, migração 0100): grade semanal, bloqueios e
 * feriados. Tudo no fuso da clínica (agenda-regras.ts).
 *
 * Decisões (documentadas no PR):
 * - Profissional SEM nenhuma janela de grade ativa: a grade não restringe (agenda livre, como antes da 0100). A grade
 *   passa a valer quando a clínica configura a primeira janela; assim nenhuma clínica fica sem agenda no dia do deploy.
 * - Encaixe (`is_walk_in`) IGNORA a grade (e a capacidade, como já fazia): encaixe é justamente o atendimento fora do
 *   horário regular. NÃO ignora bloqueio nem feriado: o profissional de férias ou a clínica fechada não atendem; para
 *   abrir num feriado, a clínica remove o feriado.
 * - Ordem dos códigos: feriado, depois bloqueio, depois grade (o motivo mais forte primeiro).
 */

/** Uma janela de atendimento: dia da semana (0 = domingo) e horas HH:MM no fuso da clínica. */
export interface JanelaDaGrade {
  readonly diaSemana: number;
  readonly inicio: string;
  readonly fim: string;
  /** Duração padrão do horário oferecido nesta janela. */
  readonly minutos: number;
}

export type MotivoIndisponivel = 'feriado' | 'horario_bloqueado' | 'fora_da_grade';

/** Teto de janelas por profissional (7 dias x 6 turnos). */
export const MAXIMO_JANELAS = 42;

/** Dia da semana (0 = domingo) de uma data de calendário AAAA-MM-DD. */
export function diaDaSemana(data: string): number {
  return new Date(`${data}T00:00:00Z`).getUTCDay();
}

/** 'HH:MM' ou 'HH:MM:SS' -> minutos desde 00:00. */
export function minutosDoDia(hora: string): number {
  const [h, m] = hora.split(':');
  return Number(h) * 60 + Number(m);
}

/**
 * Janelas válidas: início antes do fim e sem sobreposição no mesmo dia (janelas encostadas, 08–12 e 12–14, valem).
 * Devolve o código do erro ou null.
 */
export function problemaNasJanelas(janelas: readonly JanelaDaGrade[]): 'janela_invalida' | 'janelas_sobrepostas' | null {
  for (const j of janelas) if (minutosDoDia(j.fim) <= minutosDoDia(j.inicio)) return 'janela_invalida';
  for (let i = 0; i < janelas.length; i++) {
    for (let k = i + 1; k < janelas.length; k++) {
      const a = janelas[i] as JanelaDaGrade;
      const b = janelas[k] as JanelaDaGrade;
      if (a.diaSemana !== b.diaSemana) continue;
      if (minutosDoDia(a.inicio) < minutosDoDia(b.fim) && minutosDoDia(b.inicio) < minutosDoDia(a.fim)) return 'janelas_sobrepostas';
    }
  }
  return null;
}

/**
 * O horário [inicio, fim) cabe INTEIRO numa janela do dia da semana do início? Horário que atravessa a meia-noite só
 * cabe se terminar exatamente às 00:00 (não acontece com janelas até 23:59).
 */
export function dentroDaGrade(janelas: readonly JanelaDaGrade[], inicio: Date, fim: Date): boolean {
  const ini = noFusoDaClinica(inicio);
  const dia = diaDaSemana(ini.data);
  const iniMin = minutosDoDia(ini.hora);
  const fimMin = iniMin + Math.round((fim.getTime() - inicio.getTime()) / 60_000);
  return janelas.some((j) => j.diaSemana === dia && minutosDoDia(j.inicio) <= iniMin && fimMin <= minutosDoDia(j.fim));
}

/** Datas (fuso da clínica) que o horário [inicio, fim) toca: a do início e, se atravessar a meia-noite, a do fim. */
export function datasDoHorario(inicio: Date, fim: Date): string[] {
  const a = noFusoDaClinica(inicio).data;
  const b = noFusoDaClinica(new Date(Math.max(inicio.getTime(), fim.getTime() - 1))).data;
  return a === b ? [a] : [a, b];
}

/** Junta o que o banco respondeu no motivo do 409 (ou null, se o horário está disponível). */
export function motivoIndisponivel(e: {
  readonly feriado: boolean;
  readonly bloqueado: boolean;
  readonly janelas: readonly JanelaDaGrade[];
  readonly encaixe: boolean;
  readonly inicio: Date;
  readonly fim: Date;
}): MotivoIndisponivel | null {
  if (e.feriado) return 'feriado';
  if (e.bloqueado) return 'horario_bloqueado';
  if (e.encaixe || e.janelas.length === 0) return null;
  return dentroDaGrade(e.janelas, e.inicio, e.fim) ? null : 'fora_da_grade';
}

/** Domingo de Páscoa (algoritmo anônimo gregoriano), AAAA-MM-DD. */
export function domingoDePascoa(ano: number): string {
  const a = ano % 19;
  const b = Math.floor(ano / 100);
  const c = ano % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

function somarDias(data: string, dias: number): string {
  return new Date(Date.parse(`${data}T00:00:00Z`) + dias * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Feriados nacionais (Lei 662/1949 com as alterações, Lei 6.802/1980, Lei 14.759/2023 e a Paixão de Cristo da lista
 * anual do governo federal). Carnaval e Corpus Christi são ponto facultativo: a clínica cadastra se fechar.
 * Feriados estaduais e municipais: a clínica cadastra.
 */
export function feriadosNacionais(ano: number): { data: string; nome: string }[] {
  const fixos: [string, string][] = [
    ['01-01', 'Confraternização Universal'],
    ['04-21', 'Tiradentes'],
    ['05-01', 'Dia do Trabalho'],
    ['09-07', 'Independência do Brasil'],
    ['10-12', 'Nossa Senhora Aparecida'],
    ['11-02', 'Finados'],
    ['11-15', 'Proclamação da República'],
    ['11-20', 'Dia Nacional de Zumbi e da Consciência Negra'],
    ['12-25', 'Natal'],
  ];
  const lista = fixos.map(([md, nome]) => ({ data: `${ano}-${md}`, nome }));
  lista.push({ data: somarDias(domingoDePascoa(ano), -2), nome: 'Paixão de Cristo' });
  return lista.sort((x, y) => x.data.localeCompare(y.data));
}
