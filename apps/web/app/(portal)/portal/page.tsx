'use client';

/** Portal: minhas consultas, com "Confirmar presença" e "Não vou conseguir ir". */
import { CheckCircle2, MessageCircle, XCircle } from 'lucide-react';
import { useState } from 'react';
import { useConsulta, useDados } from '@/components/app/dados';
import { useAviso } from '@/components/app/desfazer';
import { Botao } from '@/components/ui/botao';
import { Carregando, Erro, Status, Vazio } from '@/components/ui/estados';
import { formatarDia, paraIsoLocal } from '@/lib/ajudante/datas';
import { nomeExibido, type Agendamento } from '@/lib/api/tipos';
import { PACIENTE_PORTAL } from '@/lib/portal';

export default function PortalConsultas() {
  const { api, atualizar } = useDados();
  const avisar = useAviso();
  const [cancelando, setCancelando] = useState<string | null>(null);
  const hoje = paraIsoLocal(new Date());
  const consulta = useConsulta(async (a) => {
    const [p, ags, profs] = await Promise.all([a.obterPaciente(PACIENTE_PORTAL), a.listarAgendamentos({ pacienteId: PACIENTE_PORTAL, de: hoje }), a.listarProfissionais()]);
    return { p, ags: ags.filter((x) => x.status !== 'cancelado'), profs: new Map(profs.map((x) => [x.id, x])) };
  }, [hoje]);
  if (consulta.estado === 'carregando') return <Carregando />;
  if (consulta.estado === 'erro') return <Erro mensagem={consulta.mensagem} tentarDeNovo={consulta.tentarDeNovo} />;
  const { p, ags, profs } = consulta.dados;

  async function mudar(a: Agendamento, status: 'confirmado' | 'cancelado', texto: string) {
    const anterior = await api.alterarStatus(a.id, status);
    setCancelando(null);
    atualizar();
    avisar({
      texto,
      desfazer: async () => {
        await api.alterarStatus(a.id, anterior);
        atualizar();
      },
    });
  }

  return (
    <>
      <h1 className="mb-1 text-[1.75rem] font-bold">Olá, {p ? nomeExibido(p).split(' ')[0] : ''}</h1>
      <p className="mb-6 text-texto-suave">Suas próximas consultas.</p>
      {ags.length === 0 ? (
        <Vazio titulo="Nenhuma consulta marcada" oQueFazer="Para marcar, fale com a clínica pelo WhatsApp ou pelo telefone." />
      ) : (
        <ul className="flex flex-col gap-3">
          {ags.map((a) => (
            <li key={a.id} className="flex flex-col gap-3 rounded-md border-2 border-borda p-4">
              <p className="text-xl font-bold">
                {formatarDia(a.data, new Date())} às {a.hora}
              </p>
              <p>{profs.get(a.profissionalId)?.nome}</p>
              <Status status={a.status} />
              {cancelando === a.id ? (
                <div role="alertdialog" aria-label="Confirmar" className="flex flex-col gap-2 rounded-md border-[3px] border-borda-forte p-3">
                  <p className="font-bold">Avisar a clínica que você não vai?</p>
                  <p>O horário fica livre para outra pessoa. Para marcar outro dia, fale com a clínica.</p>
                  <div className="flex flex-wrap gap-2">
                    <Botao variante="perigo" onClick={() => mudar(a, 'cancelado', 'Pronto, a clínica foi avisada.')}>
                      Sim, não vou
                    </Botao>
                    <Botao variante="suave" onClick={() => setCancelando(null)}>
                      Voltar
                    </Botao>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-2 sm:flex-row">
                  {a.status === 'agendado' && (
                    <Botao tamanho="grande" onClick={() => mudar(a, 'confirmado', 'Presença confirmada. Até lá!')}>
                      <CheckCircle2 aria-hidden />
                      Confirmar presença
                    </Botao>
                  )}
                  <Botao variante="contorno" tamanho="grande" onClick={() => setCancelando(a.id)}>
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
