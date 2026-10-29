'use client';

/**
 * Financeiro: recebido hoje, contas a receber (com "Receber"), pacotes e saldo, atalho para recibos.
 * Pix automático é placeholder (decisão D5): por enquanto o Pix é registrado à mão.
 */
import { Banknote, CreditCard, HandCoins, Package, QrCode, Receipt } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { useConsulta, useDados } from '@/components/app/dados';
import { useAviso } from '@/components/app/desfazer';
import { Titulo } from '@/components/app/estrutura';
import { Botao } from '@/components/ui/botao';
import { Carregando, Erro, Vazio } from '@/components/ui/estados';
import { formatarDia, paraIsoLocal } from '@/lib/ajudante/datas';
import { nomeExibido, type Agendamento } from '@/lib/api/tipos';
import { NOME_FORMA, aReceber, totalPorForma, type Forma } from '@/lib/financeiro';
import { reais } from '@/lib/utils';

const ICONE_FORMA: Record<Forma, typeof Banknote> = { dinheiro: Banknote, cartao: CreditCard, pix: QrCode };

export default function PaginaFinanceiro() {
  const { api, atualizar } = useDados();
  const avisar = useAviso();
  const hoje = paraIsoLocal(new Date());
  const [recebendo, setRecebendo] = useState<string | null>(null);
  const consulta = useConsulta(async (a) => {
    const [ags, recibos, pacientes, pacotes, tipos] = await Promise.all([
      a.listarAgendamentos({ ate: hoje }),
      a.listarRecibos(),
      a.listarPacientes(),
      a.listarPacotes(),
      a.listarTiposAtendimento(),
    ]);
    return { ags, recibos, pacientes: new Map(pacientes.map((p) => [p.id, p])), pacotes, tipos: new Map(tipos.map((t) => [t.id, t])) };
  }, [hoje]);

  if (consulta.estado === 'carregando') return <Carregando />;
  if (consulta.estado === 'erro') return <Erro mensagem={consulta.mensagem} tentarDeNovo={consulta.tentarDeNovo} />;
  const { ags, recibos, pacientes, pacotes, tipos } = consulta.dados;
  const deHoje = recibos.filter((r) => r.data === hoje);
  const totais = totalPorForma(deHoje);
  const pendentes = aReceber(ags, recibos);
  const nome = (id: string) => {
    const p = pacientes.get(id);
    return p ? nomeExibido(p) : 'Paciente';
  };

  async function receber(a: Agendamento, forma: Forma) {
    const r = await api.registrarPagamento(a.id, forma);
    setRecebendo(null);
    atualizar();
    avisar({
      texto: `Recebido ${reais(r.valor)} de ${nome(a.pacienteId)} (${NOME_FORMA[forma]}).`,
      desfazer: async () => {
        await api.removerRecibo(r.id);
        atualizar();
      },
    });
  }

  return (
    <>
      <Titulo descricao="O que entrou hoje e o que ainda falta receber.">Financeiro</Titulo>

      <section aria-labelledby="t-hoje" className="mb-8">
        <h2 id="t-hoje" className="mb-3 flex items-center gap-2 text-xl font-bold">
          <HandCoins aria-hidden className="size-6" />
          Recebido hoje
        </h2>
        <dl className="grid gap-3 sm:grid-cols-4">
          <div className="rounded-md border-[3px] border-borda-forte p-4">
            <dt className="font-bold">Total</dt>
            <dd className="text-[1.75rem] font-bold tabular-nums" data-testid="total-hoje">
              {reais(totais.total)}
            </dd>
          </div>
          {(['dinheiro', 'cartao', 'pix'] as const).map((f) => {
            const Icone = ICONE_FORMA[f];
            return (
              <div key={f} className="rounded-md border-2 border-borda p-4">
                <dt className="flex items-center gap-2">
                  <Icone aria-hidden className="size-5" />
                  {NOME_FORMA[f]}
                </dt>
                <dd className="text-xl font-bold tabular-nums">{reais(totais[f])}</dd>
              </div>
            );
          })}
        </dl>
        <p className="mt-3 flex items-start gap-2 rounded-md border-2 border-dashed border-borda p-3">
          <QrCode aria-hidden className="mt-0.5 size-6 shrink-0" />
          Pix com QR Code e baixa automática: em breve. Por enquanto, quando o paciente pagar por Pix, registre aqui como “Pix”.
        </p>
      </section>

      <section aria-labelledby="t-receber" className="mb-8">
        <h2 id="t-receber" className="mb-3 flex items-center gap-2 text-xl font-bold">
          <Banknote aria-hidden className="size-6" />
          A receber ({pendentes.length})
        </h2>
        {pendentes.length === 0 ? (
          <Vazio titulo="Nada a receber" oQueFazer="Todos os atendimentos feitos já estão pagos." />
        ) : (
          <ul className="flex flex-col gap-2">
            {pendentes.map((a) => (
              <li key={a.id} className="flex flex-col gap-3 rounded-md border-2 border-borda p-3">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="flex-1 text-lg font-bold">{nome(a.pacienteId)}</span>
                  <span className="text-texto-suave">
                    {formatarDia(a.data, new Date())} · {tipos.get(a.tipoId)?.nome}
                  </span>
                  <span className="text-lg font-bold tabular-nums">{reais(tipos.get(a.tipoId)?.valor ?? 0)}</span>
                </div>
                {recebendo === a.id ? (
                  <div className="flex flex-wrap items-center gap-2" role="group" aria-label={`Como ${nome(a.pacienteId)} pagou`}>
                    <span className="font-bold">Como pagou?</span>
                    {(['dinheiro', 'cartao', 'pix'] as const).map((f) => {
                      const Icone = ICONE_FORMA[f];
                      return (
                        <Botao key={f} variante="contorno" tamanho="pequeno" onClick={() => receber(a, f)}>
                          <Icone aria-hidden />
                          {NOME_FORMA[f]}
                        </Botao>
                      );
                    })}
                    <Botao variante="suave" tamanho="pequeno" onClick={() => setRecebendo(null)}>
                      Voltar
                    </Botao>
                  </div>
                ) : (
                  <Botao tamanho="pequeno" onClick={() => setRecebendo(a.id)} className="self-start">
                    <HandCoins aria-hidden />
                    Receber
                  </Botao>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="t-pacotes" className="mb-8" id="pacotes">
        <h2 id="t-pacotes" className="mb-3 flex items-center gap-2 text-xl font-bold">
          <Package aria-hidden className="size-6" />
          Pacotes e saldo de sessões
        </h2>
        {pacotes.length === 0 ? (
          <Vazio titulo="Nenhum pacote" oQueFazer="Pacotes são criados ao marcar sessões recorrentes (Agenda › Marcar › Mais opções)." />
        ) : (
          <ul className="flex flex-col gap-2">
            {pacotes.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center gap-3 rounded-md border-2 border-borda p-3">
                <span className="flex-1">
                  <Link href={`/pacientes/${k.pacienteId}`} className="font-bold">
                    {nome(k.pacienteId)}
                  </Link>{' '}
                  · {k.nome}
                </span>
                <span>
                  Saldo: <strong>{k.total - k.usadas}</strong> de {k.total}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Botao asChild variante="contorno">
        <Link href="/financeiro/recibos">
          <Receipt aria-hidden />
          Ver todos os recibos
        </Link>
      </Botao>
    </>
  );
}
