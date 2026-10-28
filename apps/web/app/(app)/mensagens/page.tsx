'use client';

/**
 * Mensagens: PRÉVIA da caixa do WhatsApp (chega no M2). Nada é enviado nem recebido de verdade;
 * conversas fictícias. Campo de resposta desligado.
 */
import { MessageCircle, Send } from 'lucide-react';
import { useState } from 'react';
import { useConsulta, useDados } from '@/components/app/dados';
import { Titulo } from '@/components/app/estrutura';
import { Botao } from '@/components/ui/botao';
import { Carregando, Erro, Vazio } from '@/components/ui/estados';
import { nomeExibido } from '@/lib/api/tipos';
import { cn } from '@/lib/utils';

export default function PaginaMensagens() {
  const { pacientes } = useDados();
  const consulta = useConsulta((a) => a.listarConversas());
  const [aberta, setAberta] = useState<string | null>(null);
  const porId = new Map(pacientes.map((p) => [p.id, p]));
  const nome = (id: string) => {
    const p = porId.get(id);
    return p ? nomeExibido(p) : 'Paciente';
  };

  return (
    <>
      <Titulo descricao="As conversas de WhatsApp da clínica num lugar só.">Mensagens</Titulo>
      <p className="mb-6 flex items-start gap-2 rounded-md border-2 border-dashed border-borda p-3 font-bold">
        <MessageCircle aria-hidden className="mt-0.5 size-6 shrink-0" />
        Prévia: o WhatsApp entra numa próxima etapa. Aqui nada é enviado nem recebido de verdade, e as conversas são fictícias.
      </p>
      {consulta.estado === 'carregando' && <Carregando />}
      {consulta.estado === 'erro' && <Erro mensagem={consulta.mensagem} tentarDeNovo={consulta.tentarDeNovo} />}
      {consulta.estado === 'pronto' &&
        (consulta.dados.length === 0 ? (
          <Vazio titulo="Nenhuma conversa" oQueFazer="Quando os pacientes mandarem mensagem, elas aparecem aqui." />
        ) : (
          <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
            <ul aria-label="Conversas" className="flex flex-col gap-2">
              {consulta.dados.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    aria-pressed={aberta === c.id}
                    onClick={() => setAberta(c.id)}
                    className={cn('flex min-h-16 w-full flex-col rounded-md border-2 px-3 py-2 text-left', aberta === c.id ? 'border-borda-forte bg-superficie-2' : 'border-borda')}
                  >
                    <span className="flex items-center justify-between gap-2 font-bold">
                      {nome(c.pacienteId)}
                      {c.naoLidas > 0 && (
                        <span className="rounded-full bg-principal px-2 text-[0.85rem] text-principal-texto">
                          {c.naoLidas} {c.naoLidas === 1 ? 'nova' : 'novas'}
                        </span>
                      )}
                    </span>
                    <span className="truncate text-[0.95rem] text-texto-suave">{c.mensagens.at(-1)?.texto}</span>
                  </button>
                </li>
              ))}
            </ul>
            {(() => {
              const c = consulta.dados.find((x) => x.id === aberta);
              if (!c) return <Vazio titulo="Escolha uma conversa" oQueFazer="Aperte num nome ao lado para ler as mensagens." />;
              return (
                <section aria-label={`Conversa com ${nome(c.pacienteId)}`} className="flex flex-col gap-3 rounded-md border-2 border-borda p-3">
                  <h2 className="text-lg font-bold">{nome(c.pacienteId)}</h2>
                  <ol className="flex flex-col gap-2">
                    {c.mensagens.map((m, i) => (
                      <li
                        key={i}
                        className={cn(
                          'max-w-[85%] rounded-lg px-3 py-2',
                          m.de === 'clinica' ? 'self-end bg-principal text-principal-texto' : 'self-start border-2 border-borda bg-fundo',
                        )}
                      >
                        <span className="sr-only">{m.de === 'clinica' ? 'Clínica: ' : 'Paciente: '}</span>
                        {m.texto}
                        <span className="block text-right text-[0.85rem] opacity-90">{m.hora}</span>
                      </li>
                    ))}
                  </ol>
                  <div className="flex gap-2">
                    <label htmlFor="resposta" className="sr-only">
                      Resposta
                    </label>
                    <input id="resposta" disabled placeholder="Responder (em breve)" className="min-h-14 flex-1 rounded-md border-2 border-borda bg-superficie px-4 text-lg" />
                    <Botao disabled>
                      <Send aria-hidden />
                      Enviar
                    </Botao>
                  </div>
                </section>
              );
            })()}
          </div>
        ))}
    </>
  );
}
