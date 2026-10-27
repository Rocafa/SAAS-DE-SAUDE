'use client';

/** Agenda: dia, semana, por profissional e lista de espera. */
import { CalendarPlus, ChevronLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { ListaEspera, VisaoDia, VisaoProfissional, VisaoSemana } from '@/components/app/agenda-visoes';
import { Titulo } from '@/components/app/estrutura';
import { Botao } from '@/components/ui/botao';
import { Carregando } from '@/components/ui/estados';
import { diasDaSemana } from '@/lib/agenda';
import { deIsoLocal, formatarDia, paraIsoLocal, somarDias } from '@/lib/ajudante/datas';
import { cn } from '@/lib/utils';

const VISOES = [
  { id: 'dia', rotulo: 'Dia' },
  { id: 'semana', rotulo: 'Semana' },
  { id: 'profissional', rotulo: 'Por profissional' },
  { id: 'espera', rotulo: 'Lista de espera' },
] as const;
type Visao = (typeof VISOES)[number]['id'];

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
  const verPedido = params.get('ver');
  const ver: Visao = VISOES.some((v) => v.id === verPedido) ? (verPedido as Visao) : 'dia';
  const passo = ver === 'semana' ? 7 : 1;
  const url = (d: string, v: Visao = ver) => `/agenda?ver=${v}&dia=${d}`;
  const ir = (n: number) => router.push(url(paraIsoLocal(somarDias(deIsoLocal(dia), n * passo))));

  const semana = diasDaSemana(dia);
  const titulo =
    ver === 'espera'
      ? 'Lista de espera'
      : ver === 'semana'
        ? `Semana de ${formatarDia(semana[0]!, new Date())} a ${formatarDia(semana[6]!, new Date())}`
        : `Agenda de ${formatarDia(dia, new Date())}`;

  return (
    <>
      <Titulo
        descricao={
          ver === 'dia' || ver === 'profissional'
            ? deIsoLocal(dia).toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })
            : undefined
        }
      >
        {titulo}
      </Titulo>

      <nav aria-label="Jeito de ver a agenda" className="mb-4 flex flex-wrap gap-2">
        {VISOES.map((v) => (
          <Link
            key={v.id}
            href={url(dia, v.id)}
            aria-current={ver === v.id ? 'page' : undefined}
            className={cn(
              'flex min-h-12 items-center rounded-md border-2 px-4 no-underline',
              ver === v.id ? 'border-borda-forte bg-principal font-bold text-principal-texto' : 'border-borda',
            )}
          >
            {v.rotulo}
          </Link>
        ))}
      </nav>

      {ver !== 'espera' && (
        <div className="mb-6 flex flex-wrap gap-2">
          <Botao variante="contorno" onClick={() => ir(-1)}>
            <ChevronLeft aria-hidden />
            {ver === 'semana' ? 'Semana anterior' : 'Dia anterior'}
          </Botao>
          <Botao variante="contorno" onClick={() => router.push(url(paraIsoLocal(new Date())))}>
            Hoje
          </Botao>
          <Botao variante="contorno" onClick={() => ir(1)}>
            {ver === 'semana' ? 'Próxima semana' : 'Próximo dia'}
            <ChevronRight aria-hidden />
          </Botao>
          <Botao asChild className="sm:ml-auto">
            <Link href="/agenda/marcar">
              <CalendarPlus aria-hidden />
              Marcar consulta
            </Link>
          </Botao>
          <Botao asChild variante="contorno">
            <Link href={`/agenda/marcar?encaixe=1&dia=${dia}`}>
              <CalendarPlus aria-hidden />
              Encaixe
            </Link>
          </Botao>
        </div>
      )}

      {ver === 'dia' && <VisaoDia dia={dia} />}
      {ver === 'semana' && <VisaoSemana dia={dia} />}
      {ver === 'profissional' && <VisaoProfissional dia={dia} />}
      {ver === 'espera' && <ListaEspera />}
    </>
  );
}
