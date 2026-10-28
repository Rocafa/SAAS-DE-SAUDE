'use client';

/**
 * Portal do paciente: celular primeiro, 4 itens no menu, letra grande. Usa SÓ o contrato do portal
 * (ApiPortal, veto B3): nada da clínica no navegador do paciente. Sem Ajudante da equipe e sem
 * analytics com identificação (metricas-produto.md: superfície de paciente não leva user_hash).
 */
import { CalendarDays, FileText, ShieldCheck, UserRound } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { AvisosProvider } from '@/components/app/desfazer';
import { PortalProvider, useOnlinePortal } from '@/components/portal/dados-portal';
import { SemInternet } from '@/components/ui/estados';
import { cn } from '@/lib/utils';

const MENU = [
  { rotulo: 'Consultas', rota: '/portal', icone: CalendarDays },
  { rotulo: 'Documentos', rota: '/portal/documentos', icone: FileText },
  { rotulo: 'Meus dados', rota: '/portal/dados', icone: UserRound },
  { rotulo: 'Meus direitos', rota: '/portal/direitos', icone: ShieldCheck },
];

function Estrutura({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const online = useOnlinePortal();
  return (
    <div className="min-h-dvh pb-28 md:pb-10">
      {!online && <SemInternet />}
      <p className="border-b-2 border-borda bg-superficie-2 px-4 py-2 text-center text-[0.95rem] font-bold">
        Portal do paciente · demonstração com dados fictícios
      </p>
      <header className="mx-auto flex w-full max-w-3xl items-center justify-between px-4 pt-4">
        <p className="text-lg font-bold">Clínica Demonstração</p>
      </header>
      <nav aria-label="Menu do portal" className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t-2 border-borda-forte bg-fundo md:static md:mx-auto md:mt-4 md:flex md:max-w-3xl md:gap-2 md:border-0 md:px-4">
        {MENU.map((m) => {
          const Icone = m.icone;
          const ativo = m.rota === '/portal' ? pathname === '/portal' : pathname.startsWith(m.rota);
          return (
            <Link
              key={m.rota}
              href={m.rota}
              aria-current={ativo ? 'page' : undefined}
              className={cn(
                'flex min-h-16 flex-col items-center justify-center gap-0.5 border-t-4 text-[0.8rem] leading-tight no-underline md:min-h-12 md:flex-row md:gap-2 md:rounded-md md:border-2 md:px-4 md:text-base',
                ativo ? 'border-borda-forte font-bold' : 'border-transparent md:border-borda',
              )}
            >
              <Icone aria-hidden className="size-6" />
              {m.rotulo}
            </Link>
          );
        })}
      </nav>
      <main id="conteudo" className="mx-auto w-full max-w-3xl px-4 py-6">
        {children}
      </main>
    </div>
  );
}

export default function LayoutPortal({ children }: { children: ReactNode }) {
  return (
    <PortalProvider>
      <AvisosProvider>
        <Estrutura>{children}</Estrutura>
      </AvisosProvider>
    </PortalProvider>
  );
}
