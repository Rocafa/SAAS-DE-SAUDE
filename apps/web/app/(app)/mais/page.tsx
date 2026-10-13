'use client';

import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { Titulo } from '@/components/app/estrutura';
import { PAGINAS } from '@/lib/ajudante/catalogo';

const FORA = new Set(['inicio', 'mais', 'marcar', 'espera', 'pacotes']);

export default function PaginaMais() {
  const grupos = ['Páginas', 'Configurações'] as const;
  return (
    <>
      <Titulo descricao="Tudo o que não cabe no menu. Ou aperte “Ajudante” e escreva o que procura.">Mais opções</Titulo>
      {grupos.map((g) => (
        <section key={g} aria-labelledby={`t-${g}`} className="mb-8">
          <h2 id={`t-${g}`} className="mb-3 text-xl font-bold">
            {g}
          </h2>
          <ul className="grid gap-2 sm:grid-cols-2">
            {PAGINAS.filter((p) => p.grupo === g && !FORA.has(p.id)).map((p) => (
              <li key={p.id}>
                <Link href={p.rota} className="flex min-h-14 items-center justify-between gap-3 rounded-md border-2 border-borda px-4 text-lg font-bold">
                  {p.titulo}
                  <ChevronRight aria-hidden className="size-6" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
