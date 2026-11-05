/**
 * Regras puras do Financeiro, das Guias de convênio e dos Relatórios (sem tela, testadas no Vitest).
 */
import { deIsoLocal, paraIsoLocal, somarDias } from './ajudante/datas';
import type { Agendamento, Guia, Recibo } from './api/tipos';

export type Forma = Recibo['forma'];

export const NOME_FORMA: Record<Forma, string> = { dinheiro: 'Dinheiro', cartao: 'Cartão', pix: 'Pix' };

export function totalPorForma(recibos: Recibo[]): Record<Forma, number> & { total: number } {
  const t = { dinheiro: 0, cartao: 0, pix: 0, total: 0 };
  for (const r of recibos) {
    t[r.forma] += r.valor;
    t.total += r.valor;
  }
  return t;
}

/** Atendimentos feitos que ainda não têm pagamento registrado. */
export function aReceber(ags: Agendamento[], recibos: Recibo[]): Agendamento[] {
  const pagos = new Set(recibos.map((r) => r.agendamentoId));
  return ags.filter((a) => a.status === 'atendido' && !pagos.has(a.id)).sort((x, y) => (x.data + x.hora).localeCompare(y.data + y.hora));
}

/** Avisos da guia em linguagem simples. Vazio quando está tudo certo. */
export function alertasGuia(g: Guia, hoje: Date): string[] {
  const out: string[] = [];
  const restam = g.sessoesAutorizadas - g.sessoesUsadas;
  const dias = Math.round((deIsoLocal(g.validade).getTime() - deIsoLocal(paraIsoLocal(hoje)).getTime()) / 864e5);
  if (dias < 0) out.push('Guia vencida. Peça uma nova autorização ao convênio.');
  else if (dias <= 7) out.push(`${dias === 0 ? 'Vence hoje' : dias === 1 ? 'Vence amanhã' : `Vence em ${dias} dias`}. Peça a renovação.`);
  if (restam <= 0) out.push('Todas as sessões autorizadas já foram usadas.');
  else if (restam <= 2) out.push(`Só ${restam === 1 ? 'resta 1 sessão' : `restam ${restam} sessões`}. Peça mais ao convênio.`);
  return out;
}

export interface ResumoPeriodo {
  atendimentos: number;
  faltas: number;
  /** % de faltas sobre consultas que deveriam ter acontecido (atendidas + faltas). */
  taxaFaltas: number;
  recebido: number;
  porDia: { data: string; atendimentos: number; faltas: number; recebido: number }[];
}

export function resumoPeriodo(ags: Agendamento[], recibos: Recibo[], de: string, ate: string): ResumoPeriodo {
  const porDia: ResumoPeriodo['porDia'] = [];
  for (let d = deIsoLocal(de); paraIsoLocal(d) <= ate; d = somarDias(d, 1)) {
    const iso = paraIsoLocal(d);
    porDia.push({
      data: iso,
      atendimentos: ags.filter((a) => a.data === iso && a.status === 'atendido').length,
      faltas: ags.filter((a) => a.data === iso && a.status === 'faltou').length,
      recebido: recibos.filter((r) => r.data === iso).reduce((s, r) => s + r.valor, 0),
    });
  }
  const atendimentos = porDia.reduce((s, x) => s + x.atendimentos, 0);
  const faltas = porDia.reduce((s, x) => s + x.faltas, 0);
  return {
    atendimentos,
    faltas,
    taxaFaltas: atendimentos + faltas ? Math.round((faltas / (atendimentos + faltas)) * 100) : 0,
    recebido: porDia.reduce((s, x) => s + x.recebido, 0),
    porDia,
  };
}

export function periodo(nome: '7dias' | '30dias' | 'mes', hoje: Date): { de: string; ate: string } {
  const ate = paraIsoLocal(hoje);
  if (nome === 'mes') return { de: paraIsoLocal(new Date(hoje.getFullYear(), hoje.getMonth(), 1)), ate };
  return { de: paraIsoLocal(somarDias(hoje, nome === '7dias' ? -6 : -29)), ate };
}
