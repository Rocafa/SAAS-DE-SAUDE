/**
 * Regras puras da Agenda e do cadastro de pacientes (sem tela, testadas no Vitest).
 */
import { deIsoLocal, paraIsoLocal, somarDias } from './ajudante/datas';
import type { Agendamento, Profissional } from './api/tipos';

/** Os 7 dias (segunda a domingo) da semana que contém `iso`. */
export function diasDaSemana(iso: string): string[] {
  const d = deIsoLocal(iso);
  const desdeSegunda = (d.getDay() + 6) % 7;
  const segunda = somarDias(d, -desdeSegunda);
  return Array.from({ length: 7 }, (_, i) => paraIsoLocal(somarDias(segunda, i)));
}

/** Datas de uma série de sessões recorrentes (ex.: toda semana, 10 vezes). */
export function datasDaSerie(inicio: string, intervaloDias: number, vezes: number): string[] {
  if (vezes < 1 || vezes > 52) throw new Error('Escolha de 1 a 52 sessões.');
  if (![7, 14].includes(intervaloDias)) throw new Error('Repetição aceita: toda semana ou a cada 2 semanas.');
  const base = deIsoLocal(inicio);
  return Array.from({ length: vezes }, (_, i) => paraIsoLocal(somarDias(base, i * intervaloDias)));
}

const ATIVOS = new Set(['agendado', 'confirmado', 'chegou', 'em_atendimento']);

/**
 * Horário já ocupado? Profissional que atende mais de um paciente ao mesmo tempo (fisio) pode
 * receber até `limiteSimultaneo`; os outros só um.
 */
export function conflito(
  existentes: Agendamento[],
  novo: { profissionalId: string; data: string; hora: string; ignorarId?: string },
  profissional: Profissional | undefined,
): Agendamento | null {
  const mesmos = existentes.filter(
    (a) =>
      a.id !== novo.ignorarId &&
      a.profissionalId === novo.profissionalId &&
      a.data === novo.data &&
      a.hora === novo.hora &&
      ATIVOS.has(a.status),
  );
  const limite = profissional?.limiteSimultaneo ?? 1;
  return mesmos.length >= limite ? mesmos[0]! : null;
}

/** Agrupa por horário: o que tem mais de um no mesmo horário com o mesmo profissional é atendimento simultâneo. */
export function porHorario(ags: Agendamento[]): { hora: string; itens: Agendamento[] }[] {
  const mapa = new Map<string, Agendamento[]>();
  for (const a of [...ags].sort((x, y) => x.hora.localeCompare(y.hora))) {
    mapa.set(a.hora, [...(mapa.get(a.hora) ?? []), a]);
  }
  return [...mapa].map(([hora, itens]) => ({ hora, itens }));
}

export function simultaneos(ags: Agendamento[], a: Agendamento): number {
  return ags.filter(
    (x) => x.profissionalId === a.profissionalId && x.data === a.data && x.hora === a.hora && ATIVOS.has(x.status),
  ).length;
}

// ---- cadastro ----

export function validarNome(nome: string): string | null {
  const n = nome.trim();
  if (!n) return 'Falta o nome. Digite nome e sobrenome.';
  if (n.split(/\s+/).length < 2) return 'Digite também o sobrenome.';
  return null;
}

export function validarTelefone(tel: string): string | null {
  const d = tel.replace(/\D/g, '');
  if (!d) return 'Falta o telefone. Digite com DDD.';
  if (d.length < 10) return 'Telefone curto. Digite com DDD, ex.: 11 91234-5678.';
  if (d.length > 11) return 'Telefone com números demais. Digite só DDD e número.';
  return null;
}

export function formatarTelefone(tel: string): string {
  const d = tel.replace(/\D/g, '');
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return tel.trim();
}

/** CPF é opcional; se vier, precisa ter os 11 dígitos e os dígitos verificadores certos. */
export function validarCpf(cpf: string): string | null {
  const d = cpf.replace(/\D/g, '');
  if (!d) return null;
  if (d.length !== 11) return 'O CPF tem 11 números. Confira ou deixe em branco.';
  if (/^(\d)\1{10}$/.test(d)) return 'CPF com número errado. Confira os 11 números.';
  const dv = (base: string, peso: number) => {
    const soma = [...base].reduce((s, n, i) => s + Number(n) * (peso - i), 0);
    const r = (soma * 10) % 11;
    return r === 10 ? 0 : r;
  };
  if (dv(d.slice(0, 9), 10) !== Number(d[9]) || dv(d.slice(0, 10), 11) !== Number(d[10])) {
    return 'CPF com número errado. Confira os 11 números.';
  }
  return null;
}

export function formatarCpf(cpf: string): string {
  const d = cpf.replace(/\D/g, '');
  return d.length === 11 ? `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}` : '';
}

/** Menor de idade precisa de responsável. */
export function idade(nascimento: string, hoje: Date): number {
  const n = deIsoLocal(nascimento);
  let anos = hoje.getFullYear() - n.getFullYear();
  if (hoje.getMonth() < n.getMonth() || (hoje.getMonth() === n.getMonth() && hoje.getDate() < n.getDate())) anos--;
  return anos;
}
