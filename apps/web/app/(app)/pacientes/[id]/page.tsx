'use client';

/**
 * Ficha do paciente (versão do PR 1): nome social em destaque, responsáveis, próximas consultas
 * (remarcar/cancelar), prontuário (chega no PR 3) e recibos.
 */
import { Archive, CalendarClock, CalendarPlus, FileText, History, Package, Paperclip, Phone, Printer, Receipt, RotateCcw, ShieldAlert, Users, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useConsulta, useDados } from '@/components/app/dados';
import { CorrigirDados } from '@/components/app/corrigir-dados';
import { useAcao, useAviso } from '@/components/app/desfazer';
import { Botao } from '@/components/ui/botao';
import { Carregando, Erro, Status, Vazio } from '@/components/ui/estados';
import { cpfMascarado } from '@/lib/ajudante/busca';
import { formatarDia, paraIsoLocal } from '@/lib/ajudante/datas';
import { nomeExibido, type Agendamento } from '@/lib/api/tipos';
import { reais } from '@/lib/utils';

export default function PaginaFicha() {
  const { id } = useParams<{ id: string }>();
  const { api, atualizar } = useDados();
  const avisar = useAviso();
  const acao = useAcao();
  const [cancelando, setCancelando] = useState<string | null>(null);
  const [inativando, setInativando] = useState(false);
  const [motivo, setMotivo] = useState('Terminou o tratamento');
  const consulta = useConsulta(
    async (a) => {
      const [paciente, ags, recibos, profissionais, linha, anexos, pacotes] = await Promise.all([
        a.obterPaciente(id),
        a.listarAgendamentos({ pacienteId: id }),
        a.listarRecibos(id),
        a.listarProfissionais(),
        a.linhaDoTempo(id),
        a.listarAnexos(id),
        a.listarPacotes(id),
      ]);
      return { paciente, ags, recibos, linha, anexos, pacotes, profissionais: new Map(profissionais.map((p) => [p.id, p])) };
    },
    [id],
  );

  if (consulta.estado === 'carregando') return <Carregando texto="Abrindo a ficha…" />;
  if (consulta.estado === 'erro') return <Erro mensagem={consulta.mensagem} tentarDeNovo={consulta.tentarDeNovo} />;
  const { paciente, ags, recibos, profissionais, linha, anexos, pacotes } = consulta.dados;
  if (!paciente) {
    return (
      <Vazio
        titulo="Paciente não encontrado"
        oQueFazer="Ele pode ter sido inativado. Volte para a lista de Pacientes e procure de novo."
        acao={
          <Botao asChild variante="contorno">
            <Link href="/pacientes">Ir para Pacientes</Link>
          </Botao>
        }
      />
    );
  }

  const hoje = paraIsoLocal(new Date());
  const proximas = ags.filter((a) => a.data >= hoje && (a.status === 'agendado' || a.status === 'confirmado'));
  const nome = nomeExibido(paciente);

  const cancelar = (a: Agendamento) =>
    acao(async () => {
      const anterior = await api.alterarStatus(a.id, 'cancelado');
      setCancelando(null);
      atualizar();
      avisar({
        texto: `Consulta de ${formatarDia(a.data, new Date())} às ${a.hora} cancelada.`,
        desfazer: async () => {
          await api.alterarStatus(a.id, anterior);
          atualizar();
        },
      });
    });

  const inativar = () =>
    acao(async () => {
      await api.inativarPaciente(id, motivo);
      setInativando(false);
      atualizar();
      avisar({
        texto: `${nome} inativado. O prontuário continua guardado.`,
        desfazer: async () => {
          await api.reativarPaciente(id);
          atualizar();
        },
      });
    });

  const reativar = () =>
    acao(async () => {
      await api.reativarPaciente(id);
      atualizar();
      avisar({ texto: `${nome} está ativo de novo.` });
    });

  return (
    <article className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <p className="text-[0.95rem] font-bold uppercase tracking-wide text-texto-suave">Ficha do paciente · fictício</p>
        <h1 className="text-[2rem] font-bold leading-tight">{nome}</h1>
        {paciente.nomeSocial && (
          <p className="text-texto-suave">
            Nome social. Nome de registro: {paciente.nome} (use só em documentos oficiais).
          </p>
        )}
        {!paciente.ativo && (
          <p className="flex items-center gap-2 rounded-md border-2 border-dashed border-borda p-2 font-bold">
            <ShieldAlert aria-hidden className="size-6" />
            Inativo desde {paciente.inativacao ? formatarDia(paciente.inativacao.data, new Date()) : '—'}
            {paciente.inativacao ? ` (${paciente.inativacao.motivo})` : ''}. O prontuário continua guardado pelo prazo legal.
          </p>
        )}
        <dl className="mt-2 grid gap-x-8 gap-y-1 sm:grid-cols-2">
          <div className="flex items-center gap-2">
            <Phone aria-hidden className="size-5" />
            <dt className="sr-only">Telefone</dt>
            <dd>{paciente.telefone}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="font-bold">CPF</dt>
            <dd>{cpfMascarado(paciente.cpf)}</dd>
          </div>
        </dl>
        <div className="mt-3 flex flex-wrap gap-2">
          <Botao asChild>
            <Link href={`/agenda/marcar?paciente=${paciente.id}`}>
              <CalendarPlus aria-hidden />
              Marcar consulta
            </Link>
          </Botao>
        </div>
        <div className="mt-2">
          <CorrigirDados key={`${paciente.id}-${paciente.telefone}-${paciente.nascimento}`} paciente={paciente} />
        </div>
      </header>

      {paciente.responsaveis.length > 0 && (
        <section aria-labelledby="t-resp">
          <h2 id="t-resp" className="mb-3 flex items-center gap-2 text-xl font-bold">
            <Users aria-hidden className="size-6" />
            Responsáveis
          </h2>
          <ul className="flex flex-col gap-2">
            {paciente.responsaveis.map((r) => (
              <li key={r.nome} className="rounded-md border-2 border-borda p-3">
                <strong>{r.nome}</strong> ({r.parentesco}) · {r.telefone}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="t-proximas" data-assist-id="ficha-proximas">
        <h2 id="t-proximas" className="mb-3 flex items-center gap-2 text-xl font-bold">
          <CalendarClock aria-hidden className="size-6" />
          Próximas consultas
        </h2>
        {proximas.length === 0 ? (
          <Vazio titulo="Nenhuma consulta marcada" oQueFazer="Aperte “Marcar consulta” lá em cima." />
        ) : (
          <ul className="flex flex-col gap-2">
            {proximas.map((a) => (
              <li key={a.id} className="flex flex-col gap-3 rounded-md border-2 border-borda p-3">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-lg font-bold">
                    {formatarDia(a.data, new Date())} às {a.hora}
                  </span>
                  <span className="text-texto-suave">{profissionais.get(a.profissionalId)?.nome}</span>
                  <Status status={a.status} />
                </div>
                {cancelando === a.id ? (
                  <div role="alertdialog" aria-label="Confirmar cancelamento" className="flex flex-col gap-3 rounded-md border-[3px] border-borda-forte p-3">
                    <p className="font-bold">Cancelar a consulta de {nome} {formatarDia(a.data, new Date())} às {a.hora}?</p>
                    <p className="text-texto-suave">Você ainda pode desfazer logo depois.</p>
                    <div className="flex flex-wrap gap-2">
                      <Botao variante="perigo" onClick={() => cancelar(a)} autoFocus>
                        <XCircle aria-hidden />
                        Sim, cancelar
                      </Botao>
                      <Botao variante="suave" onClick={() => setCancelando(null)}>
                        Não, manter
                      </Botao>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <Botao asChild variante="contorno" tamanho="pequeno">
                      <Link href={`/agenda/marcar?remarcar=${a.id}`}>
                        <CalendarClock aria-hidden />
                        Remarcar
                      </Link>
                    </Botao>
                    <Botao
                      variante="contorno"
                      tamanho="pequeno"
                      data-assist-id="ficha-cancelar"
                      data-assist-chave={a.id}
                      onClick={() => setCancelando(a.id)}
                    >
                      <XCircle aria-hidden />
                      Cancelar
                    </Botao>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {pacotes.length > 0 && (
        <section aria-labelledby="t-pacotes">
          <h2 id="t-pacotes" className="mb-3 flex items-center gap-2 text-xl font-bold">
            <Package aria-hidden className="size-6" />
            Pacotes de sessões
          </h2>
          <ul className="flex flex-col gap-2">
            {pacotes.map((k) => (
              <li key={k.id} className="flex flex-col gap-2 rounded-md border-2 border-borda p-3">
                <p className="font-bold">{k.nome}</p>
                <p>
                  Usadas <strong>{k.usadas}</strong> de {k.total}. Saldo: <strong>{k.total - k.usadas} sessões</strong>.
                </p>
                <div
                  role="meter"
                  aria-label={`Sessões usadas de ${k.nome}`}
                  aria-valuemin={0}
                  aria-valuemax={k.total}
                  aria-valuenow={k.usadas}
                  className="h-4 overflow-hidden rounded-sm border-2 border-borda-forte"
                >
                  <div className="h-full bg-principal" style={{ width: `${(k.usadas / k.total) * 100}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="t-pront" data-assist-id="ficha-prontuario">
        <h2 id="t-pront" className="mb-3 flex items-center gap-2 text-xl font-bold">
          <FileText aria-hidden className="size-6" />
          Prontuário
        </h2>
        <Vazio
          titulo="A tela de atendimento chega no próximo pacote"
          oQueFazer="Evolução por modelo (fisio/TO e psicologia), histórico e assinatura entram no PR 3."
        />
      </section>

      <section aria-labelledby="t-recibos" data-assist-id="ficha-recibos">
        <h2 id="t-recibos" className="mb-3 flex items-center gap-2 text-xl font-bold">
          <Receipt aria-hidden className="size-6" />
          Recibos
        </h2>
        {recibos.length === 0 ? (
          <Vazio titulo="Nenhum recibo ainda" oQueFazer="O recibo aparece aqui quando um atendimento é pago." />
        ) : (
          <ul className="flex flex-col gap-2">
            {recibos.map((r, i) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 rounded-md border-2 border-borda p-3">
                <span className="flex-1">
                  <strong>{formatarDia(r.data, new Date())}</strong> · {reais(r.valor)} ·{' '}
                  {r.forma === 'pix' ? 'Pix' : r.forma === 'cartao' ? 'Cartão' : 'Dinheiro'}
                </span>
                <Botao
                  variante="contorno"
                  tamanho="pequeno"
                  onClick={() => window.print()}
                  {...(i === 0 ? { 'data-assist-id': 'ficha-imprimir-recibo' } : {})}
                >
                  <Printer aria-hidden />
                  Imprimir
                </Botao>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="t-anexos">
        <h2 id="t-anexos" className="mb-3 flex items-center gap-2 text-xl font-bold">
          <Paperclip aria-hidden className="size-6" />
          Anexos
        </h2>
        {anexos.length === 0 ? (
          <Vazio titulo="Nenhum anexo" oQueFazer="Exames e documentos do paciente aparecem aqui." />
        ) : (
          <ul className="flex flex-col gap-2">
            {anexos.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center gap-3 rounded-md border-2 border-borda p-3">
                <Paperclip aria-hidden className="size-5" />
                <span className="flex-1 font-bold">{x.nome}</span>
                <span className="text-texto-suave">{formatarDia(x.data, new Date())}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-texto-suave">Enviar arquivo chega junto com a API real (guardado cifrado, só para a clínica).</p>
      </section>

      <section aria-labelledby="t-linha">
        <h2 id="t-linha" className="mb-3 flex items-center gap-2 text-xl font-bold">
          <History aria-hidden className="size-6" />
          Linha do tempo
        </h2>
        {linha.length === 0 ? (
          <Vazio titulo="Ainda sem histórico" oQueFazer="Consultas, faltas, pagamentos e anexos aparecem aqui, do mais novo para o mais antigo." />
        ) : (
          <ol className="flex flex-col border-l-[3px] border-borda-forte pl-4">
            {linha.map((ev, i) => (
              <li key={`${ev.data}-${i}`} className="relative pb-4">
                <span aria-hidden className="absolute -left-[1.6rem] top-1.5 size-4 rounded-full border-[3px] border-borda-forte bg-fundo" />
                <p className="text-[0.95rem] font-bold">
                  {formatarDia(ev.data, new Date())}
                  {ev.hora ? ` às ${ev.hora}` : ''}
                </p>
                <p className={ev.tipo === 'falta' || ev.tipo === 'cancelamento' ? 'italic' : ''}>{ev.texto}</p>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section aria-labelledby="t-inativar" className="rounded-md border-2 border-dashed border-borda p-4">
        <h2 id="t-inativar" className="mb-2 flex items-center gap-2 text-xl font-bold">
          <Archive aria-hidden className="size-6" />
          {paciente.ativo ? 'Inativar paciente' : 'Paciente inativo'}
        </h2>
        {paciente.ativo ? (
          inativando ? (
            <div role="alertdialog" aria-label="Confirmar inativação" className="flex flex-col gap-3">
              <p>
                <strong>O prontuário não é apagado.</strong> Ele fica guardado pelo prazo legal do conselho (ex.: CFM 20 anos, CFP 5
                anos) e continua disponível para consulta e exportação. As consultas futuras deste paciente serão canceladas.
              </p>
              <label htmlFor="motivo" className="font-bold">
                Motivo
              </label>
              <select id="motivo" value={motivo} onChange={(e) => setMotivo(e.target.value)} className="min-h-14 rounded-md border-2 border-borda-forte bg-fundo px-4 text-lg">
                {['Terminou o tratamento', 'Mudou de clínica', 'Mudou de cidade', 'Pediu para sair', 'Outro'].map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
              <div className="flex flex-wrap gap-2">
                <Botao variante="perigo" onClick={inativar}>
                  <Archive aria-hidden />
                  Sim, inativar
                </Botao>
                <Botao variante="suave" onClick={() => setInativando(false)}>
                  Não, manter ativo
                </Botao>
              </div>
            </div>
          ) : (
            <>
              <p className="mb-3 text-texto-suave">Use quando o paciente não vem mais. Nada é apagado.</p>
              <Botao variante="contorno" onClick={() => setInativando(true)}>
                <Archive aria-hidden />
                Inativar paciente
              </Botao>
            </>
          )
        ) : (
          <Botao variante="contorno" onClick={reativar}>
            <RotateCcw aria-hidden />
            Reativar paciente
          </Botao>
        )}
      </section>
    </article>
  );
}
