'use client';

/**
 * Portal: meus direitos (LGPD art. 18) e consentimentos. Cada pedido gera protocolo e prazo.
 * Consentimento em 3 estados: "ainda não respondido" vale como NÃO (ressalva R1 do Guardião).
 */
import { ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useConsulta, useDados } from '@/components/app/dados';
import { useAviso } from '@/components/app/desfazer';
import { Botao } from '@/components/ui/botao';
import { Carregando, Erro } from '@/components/ui/estados';
import { formatarDia } from '@/lib/ajudante/datas';
import { CONSENTIMENTOS, DIREITOS, PACIENTE_PORTAL, PRAZO_RESPOSTA_DIAS, type Resposta } from '@/lib/portal';
import { cn } from '@/lib/utils';

const TEXTO_RESPOSTA: Record<Resposta, string> = { sim: 'Você aceitou', nao: 'Você recusou', nao_respondido: 'Ainda não respondido (vale como não)' };

export default function PortalDireitos() {
  const { api, atualizar } = useDados();
  const avisar = useAviso();
  const consulta = useConsulta(async (a) => {
    const [cons, pedidos] = await Promise.all([a.listarConsentimentos(PACIENTE_PORTAL), a.listarPedidosTitular(PACIENTE_PORTAL)]);
    return { cons, pedidos };
  });
  const [confirmando, setConfirmando] = useState<string | null>(null);
  if (consulta.estado === 'carregando') return <Carregando />;
  if (consulta.estado === 'erro') return <Erro mensagem={consulta.mensagem} tentarDeNovo={consulta.tentarDeNovo} />;
  const { cons, pedidos } = consulta.dados;

  async function responder(id: string, r: 'sim' | 'nao') {
    const anterior = await api.alterarConsentimento(PACIENTE_PORTAL, id, r);
    atualizar();
    avisar({
      texto: r === 'sim' ? 'Autorização registrada.' : 'Pronto, não autorizado.',
      desfazer: async () => {
        await api.voltarConsentimento(PACIENTE_PORTAL, id, anterior);
        atualizar();
      },
    });
  }

  async function pedir(tipo: (typeof DIREITOS)[number]['tipo']) {
    const r = await api.abrirPedidoTitular(PACIENTE_PORTAL, tipo);
    setConfirmando(null);
    atualizar();
    avisar({ texto: `Pedido enviado. Protocolo ${r.protocolo}. A clínica responde até ${formatarDia(r.prazo, new Date())}.` });
  }

  return (
    <>
      <h1 className="mb-1 text-[1.75rem] font-bold">Meus direitos</h1>
      <p className="mb-6 text-texto-suave">
        Seus dados são seus. A clínica cuida deles e responde aos seus pedidos em até {PRAZO_RESPOSTA_DIAS} dias.
      </p>

      <section aria-labelledby="t-aut" className="mb-8">
        <h2 id="t-aut" className="mb-3 text-xl font-bold">
          O que você autoriza
        </h2>
        <ul className="flex flex-col gap-3">
          {CONSENTIMENTOS.map((c) => {
            const r = cons[c.id] ?? 'nao_respondido';
            return (
              <li key={c.id} className="flex flex-col gap-2 rounded-md border-2 border-borda p-3">
                <p className="font-bold">{c.titulo}</p>
                <p className="text-texto-suave">{c.explicacao}</p>
                <p className={cn(r === 'sim' ? 'font-bold' : '', r === 'nao_respondido' ? 'italic' : '')} data-testid={`consentimento-${c.id}`}>
                  {TEXTO_RESPOSTA[r]}
                </p>
                <div role="group" aria-label={c.titulo} className="flex flex-wrap gap-2">
                  <Botao variante={r === 'sim' ? 'principal' : 'contorno'} tamanho="pequeno" aria-pressed={r === 'sim'} onClick={() => responder(c.id, 'sim')}>
                    Autorizo
                  </Botao>
                  <Botao variante={r === 'nao' ? 'principal' : 'contorno'} tamanho="pequeno" aria-pressed={r === 'nao'} onClick={() => responder(c.id, 'nao')}>
                    Não autorizo
                  </Botao>
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="t-pedidos" className="mb-8">
        <h2 id="t-pedidos" className="mb-3 text-xl font-bold">
          Fazer um pedido
        </h2>
        <ul className="flex flex-col gap-3">
          {DIREITOS.map((d) => (
            <li key={d.tipo} className="flex flex-col gap-2 rounded-md border-2 border-borda p-3">
              <p className="font-bold">{d.titulo}</p>
              <p className="text-texto-suave">{d.explicacao}</p>
              {confirmando === d.tipo ? (
                <div role="alertdialog" aria-label="Confirmar pedido" className="flex flex-wrap items-center gap-2">
                  <span className="font-bold">Enviar este pedido à clínica?</span>
                  <Botao tamanho="pequeno" onClick={() => pedir(d.tipo)}>
                    Sim, enviar
                  </Botao>
                  <Botao variante="suave" tamanho="pequeno" onClick={() => setConfirmando(null)}>
                    Voltar
                  </Botao>
                </div>
              ) : (
                <Botao variante="contorno" tamanho="pequeno" className="self-start" onClick={() => setConfirmando(d.tipo)}>
                  <ShieldCheck aria-hidden />
                  Pedir
                </Botao>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="t-meus">
        <h2 id="t-meus" className="mb-3 text-xl font-bold">
          Meus pedidos
        </h2>
        {pedidos.length === 0 ? (
          <p className="text-texto-suave">Você ainda não fez nenhum pedido.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {pedidos.map((p) => (
              <li key={p.protocolo} className="rounded-md border-2 border-borda p-3">
                <strong>Protocolo {p.protocolo}</strong> · {DIREITOS.find((d) => d.tipo === p.tipo)?.titulo} · resposta até {formatarDia(p.prazo, new Date())}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
