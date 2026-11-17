'use client';

/**
 * Portal: direitos (LGPD art. 18) e consentimentos. O texto do consentimento é o do SERVIDOR (título,
 * explicação e versão: é o que o hash do evento prova, R15/P6). Protocolo e prazo do pedido também vêm
 * do servidor (P8). Consentimento em 3 estados: "ainda não respondido" vale como NÃO (R1).
 */
import { PenLine, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { useAviso } from '@/components/app/desfazer';
import { useConsultaPortal, usePortal } from '@/components/portal/dados-portal';
import { Botao } from '@/components/ui/botao';
import { Carregando, Erro } from '@/components/ui/estados';
import { mensagemParaTela, type PortalTipoDePedido } from '@/lib/api/portal';
import { PRAZO_RESPOSTA_DIAS, TEXTO_RESPOSTA, direitosDoVinculo, mensagemNoVinculo, prazoBr, tituloDoPedido } from '@/lib/portal';
import { cn } from '@/lib/utils';

export default function PortalDireitos() {
  const { api, atualizar, vinculo } = usePortal();
  const avisar = useAviso();
  const consulta = useConsultaPortal(async (a) => {
    const [cons, pedidos] = await Promise.all([a.consentimentos(), a.pedidos()]);
    return { cons, pedidos };
  });
  const [confirmando, setConfirmando] = useState<PortalTipoDePedido | null>(null);
  const [erro, setErro] = useState('');
  if (consulta.estado === 'carregando') return <Carregando />;
  if (consulta.estado === 'erro') return <Erro mensagem={consulta.mensagem} tentarDeNovo={consulta.tentarDeNovo} />;
  const { cons, pedidos } = consulta.dados;
  const responsavel = vinculo.agindoComo === 'responsavel_legal';
  // R1 (#75): no modo responsável os textos falam do paciente representado, não "de mim".
  const paciente = responsavel ? vinculo.primeiroNome : undefined;

  async function responder(finalidade: string, r: 'sim' | 'nao') {
    try {
      // Consentimento é histórico: responder e desfazer gravam eventos novos (R15).
      await api.responderConsentimento(finalidade, r);
      setErro('');
      atualizar();
      avisar({
        texto: r === 'sim' ? 'Autorização registrada.' : 'Pronto, não autorizado.',
        desfazer: async () => {
          try {
            await api.desfazerConsentimento(finalidade);
          } catch (e) {
            setErro(mensagemParaTela(e, 'Não deu para desfazer.'));
          }
          atualizar();
        },
      });
    } catch (e) {
      setErro(mensagemParaTela(e, 'Não deu para registrar.'));
    }
  }

  async function pedir(tipo: PortalTipoDePedido) {
    try {
      const r = await api.abrirPedido(tipo);
      setConfirmando(null);
      setErro('');
      atualizar();
      avisar({ texto: `Pedido enviado. Protocolo ${r.protocolo}. A clínica responde até ${prazoBr(r.prazo)}.` });
    } catch (e) {
      setConfirmando(null);
      setErro(mensagemParaTela(e, 'Não deu para enviar.'));
    }
  }

  return (
    <>
      <h1 className="mb-1 text-[1.75rem] font-bold">{responsavel ? `Direitos de ${vinculo.primeiroNome}` : 'Meus direitos'}</h1>
      <p className="mb-6 text-texto-suave">
        {responsavel ? `Os dados de ${vinculo.primeiroNome} são dele(a).` : 'Seus dados são seus.'} A clínica cuida deles e responde aos pedidos em até{' '}
        {PRAZO_RESPOSTA_DIAS} dias.
      </p>
      {erro && (
        <p role="alert" className="mb-4 font-bold">
          ⚠ {mensagemNoVinculo(erro, responsavel)}
        </p>
      )}

      <section aria-labelledby="t-aut" className="mb-8">
        <h2 id="t-aut" className="mb-3 text-xl font-bold">
          {responsavel ? `O que você autoriza por ${vinculo.primeiroNome}` : 'O que você autoriza'}
        </h2>
        <ul className="flex flex-col gap-3">
          {cons.map((c) => (
            <li key={c.finalidade} className="flex flex-col gap-2 rounded-md border-2 border-borda p-3">
              <p className="font-bold">{c.titulo}</p>
              <p className="text-texto-suave">{c.explicacao}</p>
              <p className={cn(c.resposta === 'sim' ? 'font-bold' : '', c.resposta === 'nao_respondido' ? 'italic' : '')} data-testid={`consentimento-${c.finalidade}`}>
                {TEXTO_RESPOSTA[c.resposta]}
              </p>
              <div role="group" aria-label={c.titulo} className="flex flex-wrap gap-2">
                <Botao variante={c.resposta === 'sim' ? 'principal' : 'contorno'} tamanho="pequeno" aria-pressed={c.resposta === 'sim'} onClick={() => responder(c.finalidade, 'sim')}>
                  Autorizo
                </Botao>
                <Botao variante={c.resposta === 'nao' ? 'principal' : 'contorno'} tamanho="pequeno" aria-pressed={c.resposta === 'nao'} onClick={() => responder(c.finalidade, 'nao')}>
                  Não autorizo
                </Botao>
              </div>
              <p className="text-[0.85rem] text-texto-suave">Versão do texto: {c.versaoTexto}</p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="t-pedidos" className="mb-8">
        <h2 id="t-pedidos" className="mb-3 text-xl font-bold">
          Fazer um pedido
        </h2>
        <ul className="flex flex-col gap-3">
          {direitosDoVinculo(paciente).map((d) => (
            <li key={d.tipo} className="flex flex-col gap-2 rounded-md border-2 border-borda p-3">
              <p className="font-bold">{d.titulo}</p>
              <p className="text-texto-suave">{d.explicacao}</p>
              {d.tipo === 'correcao' ? (
                <Botao asChild variante="contorno" tamanho="pequeno" className="self-start">
                  <Link href="/portal/dados">
                    <PenLine aria-hidden />
                    Pedir correção
                  </Link>
                </Botao>
              ) : confirmando === d.tipo ? (
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
          Pedidos feitos
        </h2>
        {pedidos.length === 0 ? (
          <p className="text-texto-suave">Nenhum pedido feito ainda.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {pedidos.map((p) => (
              <li key={p.id} className="flex flex-col gap-1 rounded-md border-2 border-borda p-3">
                <span>
                  <strong>Protocolo {p.protocolo}</strong> · {tituloDoPedido(p.tipo, paciente)} ·{' '}
                  {p.situacao === 'respondido' ? 'respondido' : `resposta até ${prazoBr(p.prazo)}`}
                </span>
                {p.resposta && <span>Resposta da clínica: {p.resposta}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
