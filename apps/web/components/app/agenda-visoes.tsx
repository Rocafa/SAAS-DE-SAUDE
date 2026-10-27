'use client';

/**
 * Visões da Agenda: dia (com check-in e status), semana (remarcar arrastando OU pelo botão),
 * por profissional e lista de espera. Toda mudança tem "Desfazer".
 */
import { CalendarClock, CalendarPlus, DoorOpen, Hourglass, Play, Trash2, UserX, Users, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState, type DragEvent, type FormEvent, type ReactNode } from 'react';
import { Botao } from '@/components/ui/botao';
import { Carregando, Erro, Status, Vazio } from '@/components/ui/estados';
import { conflito, diasDaSemana, porHorario, simultaneos } from '@/lib/agenda';
import { acharPacientes } from '@/lib/ajudante/busca';
import { deIsoLocal, formatarDia, paraIsoLocal } from '@/lib/ajudante/datas';
import { nomeExibido, type Agendamento, type Paciente, type Profissional, type StatusAgendamento } from '@/lib/api/tipos';
import { cn } from '@/lib/utils';
import { useConsulta, useDados } from './dados';
import { useAcao, useAviso } from './desfazer';

interface Base {
  ags: Agendamento[];
  pacientes: Map<string, Paciente>;
  profissionais: Profissional[];
}

function useBase(de: string, ate: string) {
  return useConsulta<Base>(
    async (a) => {
      const [ags, pacientes, profissionais] = await Promise.all([
        a.listarAgendamentos({ de, ate }),
        a.listarPacientes(),
        a.listarProfissionais(),
      ]);
      return { ags, pacientes: new Map(pacientes.map((p) => [p.id, p])), profissionais };
    },
    [de, ate],
  );
}

function useAcoesStatus() {
  const { api, atualizar } = useDados();
  const avisar = useAviso();
  const acao = useAcao();
  return (a: Agendamento, status: StatusAgendamento, texto: string) =>
    acao(async () => {
      const anterior = await api.alterarStatus(a.id, status);
      atualizar();
      avisar({
        texto,
        desfazer: async () => {
          await api.alterarStatus(a.id, anterior);
          atualizar();
        },
      });
    });
}

function nomeDe(base: Base, a: Agendamento) {
  const p = base.pacientes.get(a.pacienteId);
  return p ? nomeExibido(p) : 'Paciente';
}

function Cartao({ base, a, compacto = false }: { base: Base; a: Agendamento; compacto?: boolean }) {
  const mudar = useAcoesStatus();
  const [cancelar, setCancelar] = useState(false);
  const nome = nomeDe(base, a);
  const prof = base.profissionais.find((p) => p.id === a.profissionalId);
  const juntos = simultaneos(base.ags, a);
  const aberto = a.status === 'agendado' || a.status === 'confirmado';
  return (
    <div className="flex flex-col gap-2 rounded-md border-2 border-borda bg-fundo p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-lg font-bold tabular-nums">{a.hora}</span>
        <Link href={`/pacientes/${a.pacienteId}`} className="text-lg font-bold">
          {nome}
        </Link>
        <Status status={a.status} />
      </div>
      <p className="text-[0.95rem] text-texto-suave">
        {prof?.nome}
        {a.encaixe ? ' · encaixe' : ''}
        {a.serieId ? ' · sessão recorrente' : ''}
        {a.pacoteId ? ' · pacote' : ''}
      </p>
      {juntos > 1 && (
        <p className="flex items-center gap-2 text-[0.95rem] font-bold">
          <Users aria-hidden className="size-5" />
          {juntos} pacientes ao mesmo tempo com {prof?.nome.split(' ').slice(0, 2).join(' ')}
        </p>
      )}
      {!compacto && cancelar ? (
        <div role="alertdialog" aria-label="Confirmar cancelamento" className="flex flex-col gap-2 rounded-md border-[3px] border-borda-forte p-3">
          <p className="font-bold">
            Cancelar a consulta de {nome} {formatarDia(a.data, new Date())} às {a.hora}?
          </p>
          <div className="flex flex-wrap gap-2">
            <Botao
              variante="perigo"
              tamanho="pequeno"
              autoFocus
              onClick={() => {
                setCancelar(false);
                void mudar(a, 'cancelado', `Consulta de ${nome} cancelada.`);
              }}
            >
              <XCircle aria-hidden />
              Sim, cancelar
            </Botao>
            <Botao variante="suave" tamanho="pequeno" onClick={() => setCancelar(false)}>
              Não, manter
            </Botao>
          </div>
        </div>
      ) : (
        !compacto && (
          <div className="flex flex-wrap gap-2">
            {aberto && (
              <Botao variante="contorno" tamanho="pequeno" onClick={() => mudar(a, 'chegou', `${nome} chegou.`)}>
                <DoorOpen aria-hidden />
                Chegou
              </Botao>
            )}
            {(a.status === 'chegou' || aberto) && (
              <Botao variante="contorno" tamanho="pequeno" onClick={() => mudar(a, 'em_atendimento', `Atendimento de ${nome} começou.`)}>
                <Play aria-hidden />
                Atender
              </Botao>
            )}
            {aberto && (
              <Botao variante="suave" tamanho="pequeno" onClick={() => mudar(a, 'faltou', `Falta de ${nome} registrada.`)}>
                <UserX aria-hidden />
                Faltou
              </Botao>
            )}
            {aberto && (
              <Botao asChild variante="suave" tamanho="pequeno">
                <Link href={`/agenda/marcar?remarcar=${a.id}`}>
                  <CalendarClock aria-hidden />
                  Remarcar
                </Link>
              </Botao>
            )}
            {aberto && (
              <Botao variante="suave" tamanho="pequeno" onClick={() => setCancelar(true)}>
                <XCircle aria-hidden />
                Cancelar
              </Botao>
            )}
          </div>
        )
      )}
    </div>
  );
}

function Estados({ consulta, children }: { consulta: ReturnType<typeof useBase>; children: (b: Base) => ReactNode }) {
  if (consulta.estado === 'carregando') return <Carregando />;
  if (consulta.estado === 'erro') return <Erro mensagem={consulta.mensagem} tentarDeNovo={consulta.tentarDeNovo} />;
  return <>{children(consulta.dados)}</>;
}

export function VisaoDia({ dia }: { dia: string }) {
  const consulta = useBase(dia, dia);
  const titulo = formatarDia(dia, new Date());
  return (
    <section data-assist-id="agenda-dia" aria-label={`Consultas de ${titulo}`}>
      <Estados consulta={consulta}>
        {(base) =>
          base.ags.length === 0 ? (
            <Vazio titulo={`Nenhuma consulta ${titulo === 'hoje' ? 'hoje' : `em ${titulo}`}`} oQueFazer="Aperte “Marcar consulta” para encher este dia." />
          ) : (
            <ol className="flex flex-col gap-4">
              {porHorario(base.ags).map((g) => (
                <li key={g.hora} className="flex flex-col gap-2">
                  <h3 className="text-[0.95rem] font-bold uppercase tracking-wide text-texto-suave">{g.hora}</h3>
                  {g.itens.map((a) => (
                    <Cartao key={a.id} base={base} a={a} />
                  ))}
                </li>
              ))}
            </ol>
          )
        }
      </Estados>
    </section>
  );
}

export function VisaoSemana({ dia }: { dia: string }) {
  const dias = useMemo(() => diasDaSemana(dia), [dia]);
  const consulta = useBase(dias[0]!, dias[6]!);
  const { api, atualizar } = useDados();
  const avisar = useAviso();
  const acao = useAcao();
  const [sobre, setSobre] = useState<string | null>(null);
  const hoje = paraIsoLocal(new Date());

  async function mover(base: Base, id: string, novoDia: string) {
    const a = base.ags.find((x) => x.id === id);
    if (!a || a.data === novoDia) return;
    if (novoDia < hoje) {
      avisar({ texto: 'Esse dia já passou. Arraste para hoje ou um dia depois.' });
      return;
    }
    await acao(async () => {
      const todos = await api.listarAgendamentos({ de: novoDia, ate: novoDia });
      const ocupado = conflito(todos, { profissionalId: a.profissionalId, data: novoDia, hora: a.hora, ignorarId: a.id }, base.profissionais.find((p) => p.id === a.profissionalId));
      if (ocupado) {
        avisar({ texto: `Horário das ${a.hora} já ocupado nesse dia. Use “Remarcar” para escolher outro horário.` });
        return;
      }
      const anterior = await api.remarcarAgendamento(a.id, novoDia, a.hora);
      atualizar();
      avisar({
        texto: `${nomeDe(base, a)} passou para ${formatarDia(novoDia, new Date())} às ${a.hora}.`,
        desfazer: async () => {
          await api.remarcarAgendamento(a.id, anterior.data, anterior.hora);
          atualizar();
        },
      });
    });
  }

  return (
    <Estados consulta={consulta}>
      {(base) => (
        <>
          <p className="mb-3 text-texto-suave">
            Para remarcar, arraste a consulta para outro dia (no computador) ou aperte nela e use “Remarcar”.
          </p>
          <div className="grid gap-3 lg:grid-cols-7">
            {dias.map((d) => {
              const doDia = base.ags.filter((a) => a.data === d && a.status !== 'cancelado');
              const nomeDia = deIsoLocal(d).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });
              return (
                <section
                  key={d}
                  aria-label={nomeDia}
                  data-dia={d}
                  onDragOver={(e: DragEvent) => {
                    e.preventDefault();
                    setSobre(d);
                  }}
                  onDragLeave={() => setSobre((s) => (s === d ? null : s))}
                  onDrop={(e: DragEvent) => {
                    e.preventDefault();
                    setSobre(null);
                    void mover(base, e.dataTransfer.getData('text/plain'), d);
                  }}
                  className={cn(
                    'flex min-h-28 flex-col gap-2 rounded-md border-2 p-2',
                    d === hoje ? 'border-borda-forte' : 'border-borda',
                    sobre === d && 'border-[3px] border-dashed border-borda-forte bg-superficie-2',
                  )}
                >
                  <h3 className={cn('text-[0.95rem] capitalize', d === hoje ? 'font-bold' : '')}>
                    {nomeDia}
                    {d === hoje ? ' (hoje)' : ''}
                  </h3>
                  {doDia.length === 0 && <p className="text-[0.9rem] text-texto-suave">Livre</p>}
                  {doDia.map((a) => (
                    <details
                      key={a.id}
                      draggable={a.status === 'agendado' || a.status === 'confirmado'}
                      onDragStart={(e) => e.dataTransfer.setData('text/plain', a.id)}
                      data-agendamento={a.id}
                      className="rounded-md border-2 border-borda bg-superficie open:bg-fundo"
                    >
                      <summary className="flex min-h-12 cursor-pointer list-none flex-col justify-center px-2 py-1 text-[0.9rem]">
                        <span className="font-bold tabular-nums">{a.hora}</span>
                        <span className="leading-tight">{nomeDe(base, a)}</span>
                      </summary>
                      <div className="p-2">
                        <Cartao base={base} a={a} />
                      </div>
                    </details>
                  ))}
                </section>
              );
            })}
          </div>
        </>
      )}
    </Estados>
  );
}

export function VisaoProfissional({ dia }: { dia: string }) {
  const consulta = useBase(dia, dia);
  return (
    <Estados consulta={consulta}>
      {(base) => (
        <div className="grid gap-4 lg:grid-cols-3">
          {base.profissionais.map((p) => {
            const deles = base.ags.filter((a) => a.profissionalId === p.id);
            return (
              <section key={p.id} aria-labelledby={`prof-${p.id}`} className="flex flex-col gap-2">
                <h3 id={`prof-${p.id}`} className="text-lg font-bold">
                  {p.nome}
                  <span className="block text-[0.95rem] font-normal text-texto-suave">
                    {p.especialidade}
                    {(p.limiteSimultaneo ?? 1) > 1 ? ` · atende até ${p.limiteSimultaneo} ao mesmo tempo` : ''}
                  </span>
                </h3>
                {deles.length === 0 ? (
                  <Vazio titulo="Agenda livre" oQueFazer="Nenhuma consulta neste dia." />
                ) : (
                  deles.map((a) => <Cartao key={a.id} base={base} a={a} />)
                )}
              </section>
            );
          })}
        </div>
      )}
    </Estados>
  );
}

export function ListaEspera() {
  const { api, atualizar, pacientes } = useDados();
  const avisar = useAviso();
  const consulta = useConsulta((a) => a.listarEspera());
  const [busca, setBusca] = useState('');
  const [pacienteId, setPacienteId] = useState('');
  const [preferencia, setPreferencia] = useState('');
  const [erro, setErro] = useState('');
  const porId = useMemo(() => new Map(pacientes.map((p) => [p.id, p])), [pacientes]);
  const sugestoes = busca.trim() && !pacienteId ? acharPacientes(busca, pacientes.filter((p) => p.ativo)).slice(0, 5) : [];

  async function adicionar(e: FormEvent) {
    e.preventDefault();
    if (!pacienteId) {
      setErro('Falta o paciente. Digite o nome e escolha na lista.');
      return;
    }
    const item = await api.adicionarEspera(pacienteId, preferencia);
    setPacienteId('');
    setBusca('');
    setPreferencia('');
    setErro('');
    atualizar();
    avisar({
      texto: 'Colocado na lista de espera.',
      desfazer: async () => {
        await api.removerEspera(item.id);
        atualizar();
      },
    });
  }

  async function tirar(id: string) {
    const item = await api.removerEspera(id);
    atualizar();
    if (item)
      avisar({
        texto: 'Tirado da lista de espera.',
        desfazer: async () => {
          await api.devolverEspera(item);
          atualizar();
        },
      });
  }

  return (
    <div className="grid gap-8 lg:grid-cols-2">
      <section aria-labelledby="t-espera">
        <h2 id="t-espera" className="mb-3 flex items-center gap-2 text-xl font-bold">
          <Hourglass aria-hidden className="size-6" />
          Esperando vaga
        </h2>
        {consulta.estado === 'carregando' && <Carregando />}
        {consulta.estado === 'erro' && <Erro mensagem={consulta.mensagem} tentarDeNovo={consulta.tentarDeNovo} />}
        {consulta.estado === 'pronto' &&
          (consulta.dados.length === 0 ? (
            <Vazio titulo="Ninguém esperando" oQueFazer="Quando um paciente quiser um horário que não tem, coloque aqui ao lado." />
          ) : (
            <ul className="flex flex-col gap-2">
              {consulta.dados.map((e) => {
                const p = porId.get(e.pacienteId);
                return (
                  <li key={e.id} className="flex flex-col gap-2 rounded-md border-2 border-borda p-3">
                    <p className="text-lg font-bold">{p ? nomeExibido(p) : 'Paciente'}</p>
                    <p>{e.preferencia}</p>
                    <p className="text-[0.95rem] text-texto-suave">Na lista desde {formatarDia(e.criadoEm, new Date())}</p>
                    <div className="flex flex-wrap gap-2">
                      <Botao asChild tamanho="pequeno">
                        <Link href={`/agenda/marcar?paciente=${e.pacienteId}&espera=${e.id}`}>
                          <CalendarPlus aria-hidden />
                          Marcar horário
                        </Link>
                      </Botao>
                      <Botao variante="suave" tamanho="pequeno" onClick={() => tirar(e.id)}>
                        <Trash2 aria-hidden />
                        Tirar da lista
                      </Botao>
                    </div>
                  </li>
                );
              })}
            </ul>
          ))}
      </section>
      <section aria-labelledby="t-por">
        <h2 id="t-por" className="mb-3 text-xl font-bold">
          Colocar na lista de espera
        </h2>
        <form onSubmit={adicionar} noValidate className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <label htmlFor="espera-paciente" className="font-bold">
              Paciente
            </label>
            <input
              id="espera-paciente"
              value={pacienteId ? nomeExibido(porId.get(pacienteId)!) : busca}
              onChange={(e) => {
                setPacienteId('');
                setBusca(e.target.value);
              }}
              placeholder="Digite o nome"
              autoComplete="off"
              aria-invalid={!!erro}
              aria-describedby={erro ? 'espera-erro' : undefined}
              className="min-h-14 rounded-md border-2 border-borda-forte bg-fundo px-4 text-lg"
            />
            {sugestoes.map(({ paciente }) => (
              <button
                key={paciente.id}
                type="button"
                onClick={() => setPacienteId(paciente.id)}
                className="min-h-12 rounded-md border-2 border-borda px-3 text-left font-bold"
              >
                {nomeExibido(paciente)}
              </button>
            ))}
            {erro && (
              <p id="espera-erro" className="font-bold">
                ⚠ {erro}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <label htmlFor="espera-preferencia" className="font-bold">
              Que horário serve? (opcional)
            </label>
            <input
              id="espera-preferencia"
              value={preferencia}
              onChange={(e) => setPreferencia(e.target.value)}
              placeholder="Ex.: terça de manhã"
              className="min-h-14 rounded-md border-2 border-borda-forte bg-fundo px-4 text-lg"
            />
          </div>
          <Botao type="submit" className="self-start">
            <Hourglass aria-hidden />
            Colocar na espera
          </Botao>
        </form>
      </section>
    </div>
  );
}
