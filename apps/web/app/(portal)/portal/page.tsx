'use client';

/** Portal: minhas consultas, com "Confirmar presença" e "Não vou conseguir ir". */
import { CheckCircle2, MessageCircle, XCircle } from 'lucide-react';
import { useState } from 'react';
import { useAviso } from '@/components/app/desfazer';
import { useConsultaPortal, usePortal } from '@/components/portal/dados-portal';
import { Botao } from '@/components/ui/botao';
import { Carregando, Erro, Status, Vazio } from '@/components/ui/estados';
import { formatarDia } from '@/lib/ajudante/datas';
import type { ConsultaPortal } from '@/lib/api/portal';

export default function PortalConsultas() {
  const { api, atualizar } = usePortal();
  const avisar = useAviso();
  const [cancelando, setCancelando] = useState<string | null>(null);
  const [erro, setErro] = useState('');
  const consulta = useConsultaPortal(async (a) => ({ nome: await a.primeiroNome(), ags: (await a.minhasConsultas()).filter((x) => x.status !== 'cancelado') }));
  if (consulta.estado === 'carregando') return <Carregando />;
  if (consulta.estado === 'erro') return <Erro mensagem={consulta.mensagem} tentarDeNovo={consulta.tentarDeNovo} />;
  const { nome, ags } = consulta.dados;

  async function responder(c: ConsultaPortal, acao: 'confirmar' | 'ausencia', texto: string) {
    try {
      if (acao === 'confirmar') await api.confirmarPresenca(c.id);
      else await api.avisarAusencia(c.id);
      setCancelando(null);
      setErro('');
      atualizar();
      avisar({
        texto,
        desfazer: async () => {
          await api.desfazerResposta(c.id);
          atualizar();
        },
      });
    } catch (e) {
      setErro(e instanceof Error ? e.message : 'Não deu certo. Tente de novo.');
    }
  }

  return (
    <>
      <h1 className="mb-1 text-[1.75rem] font-bold">Olá, {nome}</h1>
      <p className="mb-6 text-texto-suave">Suas próximas consultas.</p>
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
                  <p className="font-bold">Avisar a clínica que você não vai?</p>
                  <p>O horário fica livre para outra pessoa. Para marcar outro dia, fale com a clínica.</p>
                  <div className="flex flex-wrap gap-2">
                    <Botao variante="perigo" onClick={() => responder(c, 'ausencia', 'Pronto, a clínica foi avisada.')}>
                      Sim, não vou
                    </Botao>
                    <Botao variante="suave" onClick={() => setCancelando(null)}>
                      Voltar
                    </Botao>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-2 sm:flex-row">
                  {c.status === 'agendado' && (
                    <Botao tamanho="grande" onClick={() => responder(c, 'confirmar', 'Presença confirmada. Até lá!')}>
                      <CheckCircle2 aria-hidden />
                      Confirmar presença
                    </Botao>
                  )}
                  <Botao variante="contorno" tamanho="grande" onClick={() => setCancelando(c.id)}>
                    <XCircle aria-hidden />
                    Não vou conseguir ir
                  </Botao>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-6 flex items-start gap-2 rounded-md border-2 border-dashed border-borda p-3">
        <MessageCircle aria-hidden className="mt-0.5 size-6 shrink-0" />
        Para marcar ou trocar o horário, fale com a clínica pelo WhatsApp: (11) 3000-0000 (fictício).
      </p>
    </>
  );
}
