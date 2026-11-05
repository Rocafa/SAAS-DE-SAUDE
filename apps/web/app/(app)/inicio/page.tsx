'use client';

import { CalendarPlus, CheckCircle2, Clock, DoorOpen, ListChecks, Phone, UserCheck, XCircle } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useDados, useConsulta } from '@/components/app/dados';
import { useAcao, useAviso } from '@/components/app/desfazer';
import { Titulo } from '@/components/app/estrutura';
import { Botao } from '@/components/ui/botao';
import { Carregando, Erro, Status, Vazio } from '@/components/ui/estados';
import { paraIsoLocal } from '@/lib/ajudante/datas';
import type { Agendamento, Paciente, Profissional, StatusAgendamento } from '@/lib/api/tipos';
import { nomeExibido } from '@/lib/api/tipos';

interface DadosHoje {
  hoje: Agendamento[];
  pacientes: Map<string, Paciente>;
  profissionais: Map<string, Profissional>;
  pendencias: { id: string; texto: string; rota: string }[];
}

export default function PaginaInicio() {
  const { api, atualizar } = useDados();
  const avisar = useAviso();
  const acao = useAcao();
  const agora = new Date();
  const dia = paraIsoLocal(agora);
  const consulta = useConsulta<DadosHoje>(async (a) => {
    const [hoje, pacientes, profissionais, pendencias] = await Promise.all([
      a.listarAgendamentos({ de: dia, ate: dia }),
      a.listarPacientes(),
      a.listarProfissionais(),
      a.pendenciasDoDia(dia),
    ]);
    return {
      hoje,
      pacientes: new Map(pacientes.map((p) => [p.id, p])),
      profissionais: new Map(profissionais.map((p) => [p.id, p])),
      pendencias,
    };
  }, [dia]);

  function mudarStatus(a: Agendamento, status: StatusAgendamento, texto: string) {
    return acao(async () => {
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

  return (
    <>
      <Titulo descricao={agora.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })}>
        Hoje
      </Titulo>

      <Botao asChild tamanho="grande" className="mb-8 w-full sm:w-auto">
        <Link href="/agenda/marcar" data-assist-id="inicio-marcar">
          <CalendarPlus aria-hidden />
          Marcar consulta
        </Link>
      </Botao>

      {consulta.estado === 'carregando' && <Carregando texto="Carregando o dia…" />}
      {consulta.estado === 'erro' && <Erro mensagem={consulta.mensagem} tentarDeNovo={consulta.tentarDeNovo} />}
      {consulta.estado === 'pronto' && (
        <ConteudoHoje
          dados={consulta.dados}
          aoChegar={(a, nome) => mudarStatus(a, 'chegou', `${nome} chegou.`)}
          aoConfirmar={(a, nome) => mudarStatus(a, 'confirmado', `Presença de ${nome} confirmada.`)}
        />
      )}
    </>
  );
}

function ConteudoHoje({
  dados,
  aoChegar,
  aoConfirmar,
}: {
  dados: DadosHoje;
  aoChegar: (a: Agendamento, nome: string) => void;
  aoConfirmar: (a: Agendamento, nome: string) => void;
}) {
  const { hoje, pacientes, profissionais, pendencias } = dados;
  const nome = (a: Agendamento) => {
    const p = pacientes.get(a.pacienteId);
    return p ? nomeExibido(p) : 'Paciente';
  };
  const proximos = hoje.filter((a) => a.status === 'agendado' || a.status === 'confirmado');
  const chegaram = hoje.filter((a) => a.status === 'chegou' || a.status === 'em_atendimento');
  const faltaConfirmar = hoje.filter((a) => a.status === 'agendado');
  const faltas = hoje.filter((a) => a.status === 'faltou');

  if (hoje.length === 0) {
    return (
      <Vazio
        titulo="Nenhuma consulta marcada para hoje"
        oQueFazer="Aperte “Marcar consulta” para colocar o primeiro paciente do dia."
      />
    );
  }

  const linha = (a: Agendamento, extra?: ReactNode) => (
    <li key={a.id} className="flex flex-wrap items-center gap-3 rounded-md border-2 border-borda p-3">
      <span className="w-16 text-lg font-bold tabular-nums">{a.hora}</span>
      <span className="flex min-w-40 flex-1 flex-col">
        <Link href={`/pacientes/${a.pacienteId}`} className="text-lg font-bold">
          {nome(a)}
        </Link>
        <span className="text-[0.95rem] text-texto-suave">
          {profissionais.get(a.profissionalId)?.nome}
          {a.encaixe ? ' · encaixe' : ''}
        </span>
      </span>
      <Status status={a.status} />
      {extra}
    </li>
  );

  return (
    <div className="grid gap-8 lg:grid-cols-2">
      <section aria-labelledby="t-proximos" className="lg:col-span-2">
        <h2 id="t-proximos" className="mb-3 flex items-center gap-2 text-xl font-bold">
          <Clock aria-hidden className="size-6" />
          Próximos atendimentos
        </h2>
        {proximos.length === 0 ? (
          <Vazio titulo="Ninguém mais para hoje" oQueFazer="Todos já foram atendidos ou chegaram." />
        ) : (
          <ul className="flex flex-col gap-2">
            {proximos.map((a) =>
              linha(
                a,
                <Botao
                  variante="contorno"
                  tamanho="pequeno"
                  data-assist-id="chegada"
                  data-assist-chave={a.id}
                  onClick={() => aoChegar(a, nome(a))}
                >
                  <UserCheck aria-hidden />
                  Chegou
                </Botao>,
              ),
            )}
          </ul>
        )}
      </section>

      <section aria-labelledby="t-chegaram" data-assist-id="inicio-chegaram" id="quem-chegou">
        <h2 id="t-chegaram" className="mb-3 flex items-center gap-2 text-xl font-bold">
          <DoorOpen aria-hidden className="size-6" />
          Quem já chegou ({chegaram.length})
        </h2>
        {chegaram.length === 0 ? (
          <Vazio titulo="Sala de espera vazia" oQueFazer="Quando alguém chegar, aperte “Chegou” ao lado do nome." />
        ) : (
          <ul className="flex flex-col gap-2">{chegaram.map((a) => linha(a))}</ul>
        )}
      </section>

      <section aria-labelledby="t-confirmar" data-assist-id="inicio-falta-confirmar" id="falta-confirmar">
        <h2 id="t-confirmar" className="mb-3 flex items-center gap-2 text-xl font-bold">
          <Phone aria-hidden className="size-6" />
          Falta confirmar ({faltaConfirmar.length})
        </h2>
        {faltaConfirmar.length === 0 ? (
          <Vazio titulo="Todos confirmaram" oQueFazer="Nada a fazer aqui por enquanto." />
        ) : (
          <ul className="flex flex-col gap-2">
            {faltaConfirmar.map((a) =>
              linha(
                a,
                <Botao variante="suave" tamanho="pequeno" onClick={() => aoConfirmar(a, nome(a))}>
                  <CheckCircle2 aria-hidden />
                  Confirmou
                </Botao>,
              ),
            )}
          </ul>
        )}
      </section>

      <section aria-labelledby="t-pendencias">
        <h2 id="t-pendencias" className="mb-3 flex items-center gap-2 text-xl font-bold">
          <ListChecks aria-hidden className="size-6" />
          Pendências do dia
        </h2>
        {pendencias.length === 0 ? (
          <Vazio titulo="Sem pendências" oQueFazer="Tudo em dia." />
        ) : (
          <ul className="flex flex-col gap-2">
            {pendencias.map((p) => (
              <li key={p.id}>
                <Link href={p.rota} className="flex min-h-12 items-center rounded-md border-2 border-borda px-3 font-bold">
                  {p.texto}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="t-faltas" data-assist-id="inicio-faltas" id="faltas">
        <h2 id="t-faltas" className="mb-3 flex items-center gap-2 text-xl font-bold">
          <XCircle aria-hidden className="size-6" />
          Faltaram hoje ({faltas.length})
        </h2>
        {faltas.length === 0 ? (
          <Vazio titulo="Nenhuma falta hoje" oQueFazer="Ótimo." />
        ) : (
          <ul className="flex flex-col gap-2">{faltas.map((a) => linha(a))}</ul>
        )}
      </section>
    </div>
  );
}
