'use client';

/** Agenda do dia (versão do PR 1). Semana, por profissional, arrastar e lista de espera chegam no PR 2. */
import { CalendarPlus, ChevronLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { useConsulta } from '@/components/app/dados';
import { Titulo } from '@/components/app/estrutura';
import { Botao } from '@/components/ui/botao';
import { Carregando, Erro, Status, Vazio } from '@/components/ui/estados';
import { deIsoLocal, formatarDia, paraIsoLocal, somarDias } from '@/lib/ajudante/datas';
import { nomeExibido } from '@/lib/api/tipos';

export default function PaginaAgenda() {
  return (
    <Suspense fallback={<Carregando />}>
      <Agenda />
    </Suspense>
  );
}

function Agenda() {
  const router = useRouter();
  const params = useSearchParams();
  const pedido = params.get('dia');
  const dia = pedido && /^\d{4}-\d{2}-\d{2}$/.test(pedido) ? pedido : paraIsoLocal(new Date());
  const consulta = useConsulta(
    async (a) => {
      const [ags, pacientes, profissionais] = await Promise.all([
        a.listarAgendamentos({ de: dia, ate: dia }),
        a.listarPacientes(),
        a.listarProfissionais(),
      ]);
      return { ags, pacientes: new Map(pacientes.map((p) => [p.id, p])), profissionais: new Map(profissionais.map((p) => [p.id, p])) };
    },
    [dia],
  );
  const ir = (d: number) => router.push(`/agenda?dia=${paraIsoLocal(somarDias(deIsoLocal(dia), d))}`);
  const titulo = formatarDia(dia, new Date());

  return (
    <>
      <Titulo descricao={deIsoLocal(dia).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })}>
        Agenda de {titulo}
      </Titulo>
      <div className="mb-6 flex flex-wrap gap-2">
        <Botao variante="contorno" onClick={() => ir(-1)}>
          <ChevronLeft aria-hidden />
          Dia anterior
        </Botao>
        <Botao variante="contorno" onClick={() => router.push('/agenda')}>
          Hoje
        </Botao>
        <Botao variante="contorno" onClick={() => ir(1)}>
          Próximo dia
          <ChevronRight aria-hidden />
        </Botao>
        <Botao asChild className="sm:ml-auto">
          <Link href="/agenda/marcar">
            <CalendarPlus aria-hidden />
            Marcar consulta
          </Link>
        </Botao>
      </div>
      <section data-assist-id="agenda-dia" aria-label={`Consultas de ${titulo}`}>
        {consulta.estado === 'carregando' && <Carregando />}
        {consulta.estado === 'erro' && <Erro mensagem={consulta.mensagem} tentarDeNovo={consulta.tentarDeNovo} />}
        {consulta.estado === 'pronto' &&
          (consulta.dados.ags.length === 0 ? (
            <Vazio titulo={`Nenhuma consulta ${titulo === 'hoje' ? 'hoje' : `em ${titulo}`}`} oQueFazer="Aperte “Marcar consulta” para encher este dia." />
          ) : (
            <ul className="flex flex-col gap-2">
              {consulta.dados.ags.map((a) => {
                const p = consulta.dados.pacientes.get(a.pacienteId);
                return (
                  <li key={a.id} className="flex flex-wrap items-center gap-3 rounded-md border-2 border-borda p-3">
                    <span className="w-16 text-lg font-bold tabular-nums">{a.hora}</span>
                    <span className="flex min-w-40 flex-1 flex-col">
                      <Link href={`/pacientes/${a.pacienteId}`} className="text-lg font-bold">
                        {p ? nomeExibido(p) : 'Paciente'}
                      </Link>
                      <span className="text-[0.95rem] text-texto-suave">{consulta.dados.profissionais.get(a.profissionalId)?.nome}</span>
                    </span>
                    <Status status={a.status} />
                  </li>
                );
              })}
            </ul>
          ))}
      </section>
    </>
  );
}
