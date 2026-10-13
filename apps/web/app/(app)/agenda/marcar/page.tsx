'use client';

/**
 * Marcar consulta na forma rápida: 3 campos (paciente, dia, horário). Profissional e tipo ficam em
 * "Mais opções" com padrão já escolhido. Também serve para remarcar (?remarcar=<id>) e encaixe (?encaixe=1).
 */
import { CalendarCheck, ChevronDown, Search, UserRound, X } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { useConsulta, useDados } from '@/components/app/dados';
import { useAviso } from '@/components/app/desfazer';
import { Titulo } from '@/components/app/estrutura';
import { usePreenchimento } from '@/components/app/executor';
import { Botao } from '@/components/ui/botao';
import { Carregando, Erro } from '@/components/ui/estados';
import { acharPacientes } from '@/lib/ajudante/busca';
import { formatarDia, paraIsoLocal } from '@/lib/ajudante/datas';
import { nomeExibido, type Paciente } from '@/lib/api/tipos';

export default function PaginaMarcar() {
  return (
    <Suspense fallback={<Carregando />}>
      <FormularioMarcar />
    </Suspense>
  );
}

type Erros = Partial<Record<'paciente' | 'dia' | 'hora' | 'geral', string>>;

const CAMPO =
  'min-h-14 w-full rounded-md border-2 border-borda-forte bg-fundo px-4 text-lg aria-[invalid=true]:border-[3px] aria-[invalid=true]:border-dashed';

function FormularioMarcar() {
  const router = useRouter();
  const params = useSearchParams();
  const remarcarId = params.get('remarcar');
  const encaixe = params.get('encaixe') === '1';
  const { api, atualizar } = useDados();
  const avisar = useAviso();
  const ids = { paciente: useId(), dia: useId(), hora: useId(), prof: useId(), tipo: useId() };

  const consulta = useConsulta(
    async (a) => {
      const [pacientes, profissionais, tipos, agendamentos] = await Promise.all([
        a.listarPacientes(),
        a.listarProfissionais(),
        a.listarTiposAtendimento(),
        remarcarId ? a.listarAgendamentos() : Promise.resolve([]),
      ]);
      return { pacientes, profissionais, tipos, original: agendamentos.find((x) => x.id === remarcarId) ?? null };
    },
    [remarcarId],
  );

  const [pacienteId, setPacienteId] = useState('');
  const [busca, setBusca] = useState('');
  const [dia, setDia] = useState('');
  const [hora, setHora] = useState('');
  const [profissionalId, setProfissionalId] = useState('pr1');
  const [tipoId, setTipoId] = useState('t1');
  const [maisOpcoes, setMaisOpcoes] = useState(false);
  const [erros, setErros] = useState<Erros>({});
  const [enviando, setEnviando] = useState(false);

  const original = consulta.estado === 'pronto' ? consulta.dados.original : null;
  const pacienteDaUrl = params.get('paciente');
  useEffect(() => {
    if (pacienteDaUrl) setPacienteId(pacienteDaUrl);
  }, [pacienteDaUrl]);
  useEffect(() => {
    if (!original) return;
    setPacienteId(original.pacienteId);
    setProfissionalId(original.profissionalId);
    setTipoId(original.tipoId);
  }, [original]);

  usePreenchimento('marcar-paciente', (v) => {
    setPacienteId(v);
    setErros((e) => ({ ...e, paciente: undefined }));
  }, () => {
    if (!remarcarId) setPacienteId('');
    setBusca('');
  });
  usePreenchimento('marcar-dia', (v) => setDia(v), () => setDia(''));
  usePreenchimento('marcar-hora', (v) => setHora(v), () => setHora(''));

  const pacientes = consulta.estado === 'pronto' ? consulta.dados.pacientes : [];
  const escolhido: Paciente | undefined = pacientes.find((p) => p.id === pacienteId);
  const sugestoes = useMemo(
    () => (busca.trim() ? acharPacientes(busca, pacientes.filter((p) => p.ativo)).slice(0, 6).map((x) => x.paciente) : []),
    [busca, pacientes],
  );

  if (consulta.estado === 'carregando') return <Carregando />;
  if (consulta.estado === 'erro') return <Erro mensagem={consulta.mensagem} tentarDeNovo={consulta.tentarDeNovo} />;
  const { profissionais, tipos } = consulta.dados;
  if (remarcarId && !original) {
    return <Erro mensagem="Não achamos essa consulta. Ela pode ter sido cancelada." tentarDeNovo={() => router.refresh()} />;
  }

  async function enviar(e: FormEvent) {
    e.preventDefault();
    const novos: Erros = {};
    if (!pacienteId) novos.paciente = 'Falta o paciente. Digite o nome e escolha na lista.';
    if (!dia) novos.dia = 'Falta o dia. Escolha no calendário.';
    else if (dia < paraIsoLocal(new Date())) novos.dia = 'Esse dia já passou. Escolha hoje ou um dia depois.';
    if (!hora) novos.hora = 'Falta o horário. Digite como 14:00.';
    setErros(novos);
    if (Object.keys(novos).length) {
      document.getElementById(novos.paciente ? ids.paciente : novos.dia ? ids.dia : ids.hora)?.focus();
      return;
    }
    setEnviando(true);
    try {
      const nome = escolhido ? nomeExibido(escolhido) : 'Paciente';
      const quando = `${formatarDia(dia, new Date())} às ${hora}`;
      if (remarcarId) {
        const anterior = await api.remarcarAgendamento(remarcarId, dia, hora);
        avisar({
          texto: `Consulta de ${nome} remarcada para ${quando}.`,
          desfazer: async () => {
            await api.remarcarAgendamento(remarcarId, anterior.data, anterior.hora);
            atualizar();
          },
        });
      } else {
        const novo = await api.criarAgendamento({ pacienteId, data: dia, hora, profissionalId, tipoId, encaixe });
        avisar({
          texto: `Consulta marcada: ${nome}, ${quando}.`,
          desfazer: async () => {
            await api.removerAgendamento(novo.id);
            atualizar();
          },
        });
      }
      atualizar();
      router.push(`/agenda?dia=${dia}`);
    } catch (err) {
      setErros({ geral: err instanceof Error ? err.message : 'Não deu para marcar. Tente de novo.' });
      setEnviando(false);
    }
  }

  return (
    <>
      <Titulo descricao={remarcarId ? 'Escolha o novo dia e o novo horário.' : 'Três passos: quem, que dia e que horas.'}>
        {remarcarId ? 'Remarcar consulta' : encaixe ? 'Fazer encaixe' : 'Marcar consulta'}
      </Titulo>
      <form onSubmit={enviar} noValidate className="flex max-w-xl flex-col gap-6">
        {erros.geral && (
          <p role="alert" className="rounded-md border-[3px] border-borda-forte p-3 font-bold">
            {erros.geral}
          </p>
        )}

        <div className="flex flex-col gap-2" data-assist-id="marcar-paciente">
          <label htmlFor={ids.paciente} className="text-lg font-bold">
            1. Paciente
          </label>
          {escolhido ? (
            <div className="flex min-h-14 items-center gap-3 rounded-md border-2 border-borda-forte bg-superficie px-4">
              <UserRound aria-hidden className="size-6" />
              <span className="flex-1 text-lg font-bold" id={ids.paciente} tabIndex={-1} data-testid="paciente-escolhido">
                {nomeExibido(escolhido)}
              </span>
              {!remarcarId && (
                <Botao variante="suave" tamanho="pequeno" onClick={() => setPacienteId('')}>
                  <X aria-hidden />
                  Trocar
                </Botao>
              )}
            </div>
          ) : (
            <>
              <div className="relative">
                <Search aria-hidden className="pointer-events-none absolute left-4 top-1/2 size-6 -translate-y-1/2" />
                <input
                  id={ids.paciente}
                  value={busca}
                  onChange={(e) => setBusca(e.target.value)}
                  placeholder="Digite o nome ou o telefone"
                  autoComplete="off"
                  aria-invalid={!!erros.paciente}
                  aria-describedby={erros.paciente ? `${ids.paciente}-erro` : undefined}
                  className={`${CAMPO} pl-12`}
                />
              </div>
              {sugestoes.length > 0 && (
                <ul aria-label="Pacientes encontrados" className="flex flex-col gap-1">
                  {sugestoes.map((p) => (
                    <li key={p.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setPacienteId(p.id);
                          setBusca('');
                          setErros((e) => ({ ...e, paciente: undefined }));
                        }}
                        className="flex min-h-12 w-full items-center gap-3 rounded-md border-2 border-borda px-3 text-left hover:border-borda-forte"
                      >
                        <UserRound aria-hidden className="size-5" />
                        <span className="font-bold">{nomeExibido(p)}</span>
                        <span className="text-texto-suave">{p.telefone}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {busca.trim() && sugestoes.length === 0 && (
                <p className="text-texto-suave">Ninguém com esse nome. Confira a escrita ou cadastre o paciente em Pacientes.</p>
              )}
            </>
          )}
          {erros.paciente && (
            <p id={`${ids.paciente}-erro`} className="font-bold">
              ⚠ {erros.paciente}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor={ids.dia} className="text-lg font-bold">
            2. Dia
          </label>
          <input
            id={ids.dia}
            type="date"
            value={dia}
            min={paraIsoLocal(new Date())}
            onChange={(e) => setDia(e.target.value)}
            data-assist-id="marcar-dia"
            aria-invalid={!!erros.dia}
            aria-describedby={erros.dia ? `${ids.dia}-erro` : undefined}
            className={CAMPO}
          />
          {dia && <p className="text-texto-suave">{formatarDia(dia, new Date())}</p>}
          {erros.dia && (
            <p id={`${ids.dia}-erro`} className="font-bold">
              ⚠ {erros.dia}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor={ids.hora} className="text-lg font-bold">
            3. Horário
          </label>
          <input
            id={ids.hora}
            type="time"
            step={900}
            value={hora}
            onChange={(e) => setHora(e.target.value)}
            data-assist-id="marcar-hora"
            aria-invalid={!!erros.hora}
            aria-describedby={erros.hora ? `${ids.hora}-erro` : undefined}
            className={CAMPO}
          />
          {erros.hora && (
            <p id={`${ids.hora}-erro`} className="font-bold">
              ⚠ {erros.hora}
            </p>
          )}
        </div>

        {!remarcarId && (
          <div className="flex flex-col gap-3">
            <Botao variante="suave" aria-expanded={maisOpcoes} onClick={() => setMaisOpcoes((m) => !m)} className="self-start">
              <ChevronDown aria-hidden className={maisOpcoes ? 'rotate-180' : ''} />
              Mais opções (profissional e tipo)
            </Botao>
            {maisOpcoes && (
              <div className="grid gap-4 rounded-md border-2 border-borda p-4 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <label htmlFor={ids.prof} className="font-bold">
                    Com quem
                  </label>
                  <select id={ids.prof} value={profissionalId} onChange={(e) => setProfissionalId(e.target.value)} className={CAMPO}>
                    {profissionais.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.nome} ({p.especialidade})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-2">
                  <label htmlFor={ids.tipo} className="font-bold">
                    Tipo de atendimento
                  </label>
                  <select id={ids.tipo} value={tipoId} onChange={(e) => setTipoId(e.target.value)} className={CAMPO}>
                    {tipos.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.nome} · {t.minutos} min
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}
          </div>
        )}

        <Botao type="submit" tamanho="grande" disabled={enviando} data-assist-id="marcar-confirmar" data-testid="confirmar-consulta">
          <CalendarCheck aria-hidden />
          {enviando ? 'Gravando…' : remarcarId ? 'Confirmar nova data' : 'Confirmar consulta'}
        </Botao>
      </form>
    </>
  );
}
