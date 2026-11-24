'use client';

import { ChevronDown, MoreHorizontal } from 'lucide-react';
import { useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { variantesBotao } from '@/components/ui/botao';
import { cn } from '@/lib/utils';

interface CabecalhoPaginaProps {
  titulo: string;
  descricao?: ReactNode;
  status?: ReactNode;
  acaoPrincipal?: ReactNode;
  acoesSecundarias?: ReactNode;
}

function MenuAcoes({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);

  function fecharComTeclado(event: KeyboardEvent<HTMLDetailsElement>) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    ref.current?.removeAttribute('open');
    ref.current?.querySelector('summary')?.focus();
  }

  function fecharDepoisDaAcao(event: MouseEvent<HTMLDetailsElement>) {
    if ((event.target as HTMLElement).closest('a, button')) ref.current?.removeAttribute('open');
  }

  return (
    <details ref={ref} className="relative" onKeyDown={fecharComTeclado} onClick={fecharDepoisDaAcao}>
      <summary className={cn(variantesBotao({ variante: 'contorno' }), 'cursor-pointer list-none [&::-webkit-details-marker]:hidden')}>
        <MoreHorizontal aria-hidden />
        Mais ações
        <ChevronDown aria-hidden className="size-5" />
      </summary>
      <div className="absolute right-0 z-40 mt-2 flex w-64 flex-col gap-2 rounded-md border-2 border-borda-forte bg-fundo p-2 [&_a]:w-full [&_button]:w-full">
        {children}
      </div>
    </details>
  );
}

export function CabecalhoPagina({ titulo, descricao, status, acaoPrincipal, acoesSecundarias }: CabecalhoPaginaProps) {
  return (
    <header className="mb-8 flex flex-col gap-5 border-b border-borda pb-6 md:flex-row md:items-start md:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-[1.75rem] font-bold leading-tight md:text-[2rem]">{titulo}</h1>
          {status}
        </div>
        {descricao && <div className="mt-1 max-w-2xl text-texto-suave">{descricao}</div>}
      </div>
      {(acaoPrincipal || acoesSecundarias) && (
        <div className="flex shrink-0 flex-wrap items-start gap-2">
          {acaoPrincipal}
          {acoesSecundarias && <MenuAcoes>{acoesSecundarias}</MenuAcoes>}
        </div>
      )}
    </header>
  );
}
