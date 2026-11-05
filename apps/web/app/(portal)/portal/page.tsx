'use client';

/**
 * Portal: próximas consultas. Os botões seguem `podeConfirmar`/`podeCancelar` do SERVIDOR (P5), nunca o
 * status calculado aqui. Confirmar tem "Desfazer" (desfaz só a confirmação); cancelar não tem, porque o
 * servidor não "descancela": para remarcar, fale com a clínica.
 */
import { CheckCircle2, MessageCircle, XCircle } from 'lucide-react';
import { useState } from 'react';
import { useAviso } from '@/components/app/desfazer';
import { useConsultaPortal, usePortal } from '@/components/portal/dados-portal';
import { Botao } from '@/components/ui/botao';
import { Carregando, Erro, Status, Vazio } from '@/components/ui/estados';
import { formatarDia } from '@/lib/ajudante/datas';
import { mensagemParaTela, type ConsultaPortal } from '@/lib/api/portal';

export default function PortalConsultas() {
  const { api, atualizar, vinculo } = usePortal();
  const avisar = useAviso();
  const [cancelando, setCancelando] = useState<string | null>(null);
  const [erro, setErro] = useState('');
  const consulta = useConsultaPortal((a) => a.consultas());
  if (consulta.estado === 'carregando') return <Carregando />;
  if (consulta.estado === 'erro') return <Erro mensagem={consulta.mensagem} tentarDeNovo={consulta.tentarDeNovo} />;
  const ags = consulta.dados;
  const responsavel = vinculo.agindoComo === 'responsavel_legal';

  async function confirmar(c: ConsultaPortal) {
    try {
      await api.confirmarConsulta(c.id);
      setErro('');
      atualizar();
      avisar({
        texto: 'Presença confirmada. Até lá!',
        desfazer: async () => {
          try {
            await api.desfazerConfirmacao(c.id);
          } catch (e) {
            setErro(mensagemParaTela(e, 'Não deu para desfazer.'));
          }
          atualizar();
        },
      });
    } catch (e) {
      setErro(mensagemParaTela(e, 'Não deu certo. Tente de novo.'));
      atualizar();
    }
  }

  async function cancelar(c: ConsultaPortal) {
    try {
      await api.cancelarConsulta(c.id);
      setCancelando(null);
      setErro('');
      atualizar();
      avisar({ texto: 'Pronto, a clínica foi avisada. Para marcar outro dia, fale com a clínica.' });
    } catch (e) {
      setCancelando(null);
      setErro(mensagemParaTela(e, 'Não deu certo. Tente de novo.'));
      atualizar();
    }
  }

  return (
    <>
      <h1 className="mb-1 text-[1.75rem] font-bold">{responsavel ? 'Olá' : `Olá, ${vinculo.primeiroNome}`}</h1>
      <p className="mb-6 text-texto-suave">{responsavel ? `Próximas consultas de ${vinculo.primeiroNome}.` : 'Suas próximas consultas.'}</p>
      {erro && (
        <p role="alert" className="mb-4 font-bold">
          ⚠ {erro}
        </p>
      )}
      {ags.length === 0 ? (
        <Vazio titulo="Nenhuma consulta marcada" oQueFazer="Para marcar, fale com a clínica pelo WhatsApp ou pelo telefone." />
      ) : (
        <ul className="flex flex-col gap-3">
          {ags.map((c) => (
            <li key={c.id} className="flex flex-col gap-3 rounded-md border-2 border-borda p-4">
              <p className="text-xl font-bold">
                {formatarDia(c.data, new Date())} às {c.hora}
              </p>
              <p>{c.profissional}</p>
              <Status status={c.status} />
              {cancelando === c.id ? (
                <div role="alertdialog" aria-label="Confirmar" className="flex flex-col gap-2 rounded-md border-[3px] border-borda-forte p-3">
                  <p className="font-bold">Avisar a clínica que {responsavel ? `${vinculo.primeiroNome} não vai` : 'você não vai'}?</p>
                  <p>O horário fica livre para outra pessoa e não dá para desfazer por aqui. Para marcar outro dia, fale com a clínica.</p>
                  <div className="flex flex-wrap gap-2">
                    <Botao variante="perigo" onClick={() => cancelar(c)}>
                      Sim, não vou
                    </Botao>
                    <Botao variante="suave" onClick={() => setCancelando(null)}>
                      Voltar
                    </Botao>
                  </div>
                </div>
              ) : (
                (c.podeConfirmar || c.podeCancelar) && (
                  <div className="flex flex-col gap-2 sm:flex-row">
                    {c.podeConfirmar && (
                      <Botao tamanho="grande" onClick={() => confirmar(c)}>
                        <CheckCircle2 aria-hidden />
                        Confirmar presença
                      </Botao>
                    )}
                    {c.podeCancelar && (
                      <Botao variante="contorno" tamanho="grande" onClick={() => setCancelando(c.id)}>
                        <XCircle aria-hidden />
                        Não vou conseguir ir
                      </Botao>
                    )}
                  </div>
                )
              )}
              {c.status === 'cancelado' && <p className="text-texto-suave">Para remarcar, fale com a clínica.</p>}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-6 flex items-start gap-2 rounded-md border-2 border-dashed border-borda p-3">
        <MessageCircle aria-hidden className="mt-0.5 size-6 shrink-0" />
        Para marcar ou trocar o horário, fale com a clínica pelo WhatsApp ou pelo telefone.
      </p>
    </>
  );
}
