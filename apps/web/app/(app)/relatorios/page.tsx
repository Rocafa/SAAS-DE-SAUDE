'use client';

/**
 * Relatórios básicos: atendimentos, faltas e recebido no período. Gráfico em cinza (atendidos em
 * preto, faltas listradas) e a mesma informação em tabela, para leitor de tela.
 */
import { BarChart3 } from 'lucide-react';
import { useState } from 'react';
import { useConsulta } from '@/components/app/dados';
import { Titulo } from '@/components/app/estrutura';
import { Carregando, Erro, Vazio } from '@/components/ui/estados';
import { deIsoLocal } from '@/lib/ajudante/datas';
import { periodo, resumoPeriodo } from '@/lib/financeiro';
import { cn, reais } from '@/lib/utils';

const PERIODOS = [
  { id: '7dias', rotulo: 'Últimos 7 dias' },
  { id: '30dias', rotulo: 'Últimos 30 dias' },
  { id: 'mes', rotulo: 'Este mês' },
] as const;
type Periodo = (typeof PERIODOS)[number]['id'];

const LISTRADO = 'repeating-linear-gradient(45deg, var(--texto) 0 3px, transparent 3px 7px)';

export default function PaginaRelatorios() {
  const [p, setP] = useState<Periodo>('30dias');
  const { de, ate } = periodo(p, new Date());
  const consulta = useConsulta(
    async (a) => {
      const [ags, recibos] = await Promise.all([a.listarAgendamentos({ de, ate }), a.listarRecibos()]);
      return resumoPeriodo(ags, recibos.filter((r) => r.data >= de && r.data <= ate), de, ate);
    },
    [de, ate],
  );
  const dia = (iso: string) => deIsoLocal(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });

  return (
    <>
      <Titulo descricao="Quanto se atendeu, quantos faltaram e quanto entrou.">Relatórios</Titulo>
      <div role="group" aria-label="Período" className="mb-6 flex flex-wrap gap-2">
        {PERIODOS.map((x) => (
          <button
            key={x.id}
            type="button"
            aria-pressed={p === x.id}
            onClick={() => setP(x.id)}
            className={cn('min-h-12 rounded-md border-2 px-4', p === x.id ? 'border-borda-forte bg-principal font-bold text-principal-texto' : 'border-borda')}
          >
            {x.rotulo}
          </button>
        ))}
      </div>
      {consulta.estado === 'carregando' && <Carregando />}
      {consulta.estado === 'erro' && <Erro mensagem={consulta.mensagem} tentarDeNovo={consulta.tentarDeNovo} />}
      {consulta.estado === 'pronto' &&
        (() => {
          const r = consulta.dados;
          if (r.atendimentos + r.faltas === 0 && r.recebido === 0)
            return <Vazio titulo="Sem movimento no período" oQueFazer="Escolha um período maior." />;
          const max = Math.max(1, ...r.porDia.map((d) => d.atendimentos + d.faltas));
          const comMovimento = r.porDia.filter((d) => d.atendimentos + d.faltas > 0);
          return (
            <>
              <dl className="mb-8 grid gap-3 sm:grid-cols-4">
                {[
                  ['Atendimentos', String(r.atendimentos)],
                  ['Faltas', String(r.faltas)],
                  ['Taxa de faltas', `${r.taxaFaltas}%`],
                  ['Recebido', reais(r.recebido)],
                ].map(([t, v]) => (
                  <div key={t} className="rounded-md border-2 border-borda p-4">
                    <dt>{t}</dt>
                    <dd className="text-[1.75rem] font-bold tabular-nums" data-testid={`kpi-${t}`}>
                      {v}
                    </dd>
                  </div>
                ))}
              </dl>

              <section aria-labelledby="t-grafico" className="mb-8">
                <h2 id="t-grafico" className="mb-3 flex items-center gap-2 text-xl font-bold">
                  <BarChart3 aria-hidden className="size-6" />
                  Atendimentos e faltas por dia
                </h2>
                <p className="mb-3 flex flex-wrap gap-4 text-[0.95rem]">
                  <span className="flex items-center gap-2">
                    <span aria-hidden className="inline-block size-4 bg-principal" /> Atendidos
                  </span>
                  <span className="flex items-center gap-2">
                    <span aria-hidden className="inline-block size-4 border-2 border-borda-forte" style={{ background: LISTRADO }} /> Faltas
                  </span>
                </p>
                <div
                  role="img"
                  aria-label={`Gráfico: ${r.atendimentos} atendimentos e ${r.faltas} faltas no período. Detalhes na tabela abaixo.`}
                  className="flex h-48 items-end gap-[2px] border-b-2 border-l-2 border-borda-forte px-1"
                >
                  {r.porDia.map((d) => (
                    <div key={d.data} className="flex h-full min-w-0 flex-1 flex-col justify-end">
                      {d.faltas > 0 && <div className="border-2 border-b-0 border-borda-forte" style={{ height: `${(d.faltas / max) * 100}%`, background: LISTRADO }} />}
                      {d.atendimentos > 0 && <div className="bg-principal" style={{ height: `${(d.atendimentos / max) * 100}%` }} />}
                    </div>
                  ))}
                </div>
                <p className="mt-1 flex justify-between text-[0.9rem] text-texto-suave">
                  <span>{dia(r.porDia[0]!.data)}</span>
                  <span>{dia(r.porDia.at(-1)!.data)}</span>
                </p>
              </section>

              <section aria-labelledby="t-tabela">
                <h2 id="t-tabela" className="mb-3 text-xl font-bold">
                  Dia a dia
                </h2>
                <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Tabela dia a dia (role para os lados se precisar)">
                  <table className="w-full border-collapse text-left">
                    <thead>
                      <tr className="border-b-2 border-borda-forte">
                        <th className="p-2">Dia</th>
                        <th className="p-2 text-right">Atendidos</th>
                        <th className="p-2 text-right">Faltas</th>
                        <th className="p-2 text-right">Recebido</th>
                      </tr>
                    </thead>
                    <tbody>
                      {comMovimento.map((d) => (
                        <tr key={d.data} className="border-b border-borda">
                          <td className="p-2">{dia(d.data)}</td>
                          <td className="p-2 text-right tabular-nums">{d.atendimentos}</td>
                          <td className="p-2 text-right tabular-nums">{d.faltas}</td>
                          <td className="p-2 text-right tabular-nums">{reais(d.recebido)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          );
        })()}
    </>
  );
}
