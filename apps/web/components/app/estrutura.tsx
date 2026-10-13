'use client';

/**
 * Estrutura da área logada: no computador, menu lateral fixo com 6 itens; no celular, barra
 * inferior com 4 itens + "Mais". Ícone sempre acompanhado de texto, nada escondido em hover.
 */
import { CalendarDays, Home, Menu, Stethoscope, Users, Wallet } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { SemInternet } from '@/components/ui/estados';
import type { Alvo } from '@/lib/ajudante/catalogo';
import { cn } from '@/lib/utils';
import { useDados, useOnline } from './dados';

interface ItemMenu {
  rotulo: string;
  rota: string;
  icone: typeof Home;
  alvo: Alvo;
  celular: boolean;
}

const MENU: ItemMenu[] = [
  { rotulo: 'Hoje', rota: '/inicio', icone: Home, alvo: 'menu-inicio', celular: true },
  { rotulo: 'Agenda', rota: '/agenda', icone: CalendarDays, alvo: 'menu-agenda', celular: true },
  { rotulo: 'Pacientes', rota: '/pacientes', icone: Users, alvo: 'menu-pacientes', celular: true },
  { rotulo: 'Atendimento', rota: '/atendimento', icone: Stethoscope, alvo: 'menu-atendimento', celular: true },
  { rotulo: 'Financeiro', rota: '/financeiro', icone: Wallet, alvo: 'menu-financeiro', celular: false },
  { rotulo: 'Mais', rota: '/mais', icone: Menu, alvo: 'menu-mais', celular: true },
];

function ativo(pathname: string, rota: string) {
  return pathname === rota || pathname.startsWith(`${rota}/`);
}

export function Estrutura({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const online = useOnline();
  const { usuario } = useDados();

  return (
    <div className="min-h-dvh md:pl-64">
      <a
        href="#conteudo"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[80] focus:rounded-md focus:bg-fundo focus:p-3 focus:font-bold"
      >
        Pular para o conteúdo
      </a>

      <nav
        aria-label="Menu principal"
        className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col gap-1 border-r-2 border-borda bg-superficie p-3 md:flex"
      >
        <p className="px-3 pb-4 pt-2 text-lg font-bold leading-tight">
          {usuario?.clinica ?? 'Clínica'}
          <span className="block text-[0.9rem] font-normal text-texto-suave">{usuario?.nome ?? ' '}</span>
        </p>
        {MENU.map((m) => {
          const Icone = m.icone;
          const eh = ativo(pathname, m.rota);
          return (
            <Link
              key={m.rota}
              href={m.rota}
              data-assist-id={m.alvo}
              aria-current={eh ? 'page' : undefined}
              className={cn(
                'flex min-h-14 items-center gap-3 rounded-md border-2 px-3 text-lg no-underline',
                eh ? 'border-borda-forte bg-fundo font-bold' : 'border-transparent hover:border-borda',
              )}
            >
              <Icone aria-hidden className={cn('size-6', eh && 'stroke-[2.75]')} />
              {m.rotulo}
            </Link>
          );
        })}
      </nav>

      <div className="flex min-h-dvh flex-col pb-28 md:pb-24">
        {!online && <SemInternet />}
        <p className="border-b-2 border-borda bg-superficie-2 px-4 py-2 text-center text-[0.95rem] font-bold">
          Demonstração com pacientes fictícios. Nenhum dado é real nem é gravado de verdade.
        </p>
        <main id="conteudo" tabIndex={-1} className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 md:px-8">
          {children}
        </main>
      </div>

      <nav
        aria-label="Menu principal"
        className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t-2 border-borda-forte bg-fundo md:hidden"
      >
        {MENU.filter((m) => m.celular).map((m) => {
          const Icone = m.icone;
          const eh = ativo(pathname, m.rota);
          return (
            <Link
              key={m.rota}
              href={m.rota}
              data-assist-id={m.alvo}
              aria-current={eh ? 'page' : undefined}
              className={cn(
                'flex min-h-16 flex-col items-center justify-center gap-0.5 border-t-4 text-[0.8rem] leading-tight no-underline',
                eh ? 'border-borda-forte font-bold' : 'border-transparent',
              )}
            >
              <Icone aria-hidden className={cn('size-6', eh && 'stroke-[2.75]')} />
              {m.rotulo}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

export function Titulo({ children, descricao }: { children: ReactNode; descricao?: ReactNode }) {
  return (
    <header className="mb-6">
      <h1 className="text-[1.75rem] font-bold leading-tight md:text-[2rem]">{children}</h1>
      {descricao && <p className="mt-1 text-texto-suave">{descricao}</p>}
    </header>
  );
}
