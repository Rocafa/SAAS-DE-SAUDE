'use client';

import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { SECOES } from '@/components/app/configuracoes';
import { Titulo } from '@/components/app/estrutura';

export default function PaginaConfiguracoes() {
  return (
    <>
      <Titulo descricao="Ajustes da clínica. Para sair do sistema, veja “Plano e assinatura”: cancelar é aqui mesmo, sem ligação.">Configurações</Titulo>
      <ul className="grid gap-2 sm:grid-cols-2">
        {Object.entries(SECOES).map(([id, s]) => (
          <li key={id}>
            <Link href={`/configuracoes/${id}`} className="flex min-h-20 items-center justify-between gap-3 rounded-md border-2 border-borda p-4 no-underline hover:border-borda-forte">
              <span className="flex flex-col">
                <span className="text-lg font-bold underline">{s.titulo}</span>
                <span className="text-texto-suave">{s.descricao}</span>
              </span>
              <ChevronRight aria-hidden className="size-6 shrink-0" />
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
