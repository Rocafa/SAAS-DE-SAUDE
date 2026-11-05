'use client';

import { ChevronRight, UserCog } from 'lucide-react';
import Link from 'next/link';
import { useConsulta, useDados } from '@/components/app/dados';
import { Titulo } from '@/components/app/estrutura';
import { cn } from '@/lib/utils';
import { PAGINAS } from '@/lib/ajudante/catalogo';

const FORA = new Set(['inicio', 'mais', 'marcar', 'espera', 'pacotes']);

function TrocarUsuario() {
  const { usuario, entrarComo } = useDados();
  const consulta = useConsulta((a) => a.usuariosDemo());
  if (consulta.estado !== 'pronto') return null;
  return (
    <section aria-labelledby="t-demo" className="mb-8 rounded-md border-2 border-dashed border-borda p-4">
      <h2 id="t-demo" className="mb-1 flex items-center gap-2 text-xl font-bold">
        <UserCog aria-hidden className="size-6" />
        Demonstração: entrar como
      </h2>
      <p className="mb-3 text-texto-suave">Troque de usuário para ver o que cada um pode fazer. Só existe na demonstração.</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {consulta.dados.map((u) => (
          <button
            key={u.id}
            type="button"
            aria-pressed={usuario?.id === u.id}
            onClick={() => entrarComo(u.id)}
            className={cn('min-h-14 rounded-md border-2 px-4 text-left', usuario?.id === u.id ? 'border-borda-forte bg-principal font-bold text-principal-texto' : 'border-borda')}
          >
            {u.nome}
          </button>
        ))}
      </div>
    </section>
  );
}

export default function PaginaMais() {
  const grupos = ['Páginas', 'Configurações'] as const;
  // Só na demonstração: `entrarComo` e `usuariosDemo` vêm do adaptador falso mesmo no modo http
  // (`criarApi` junta os dois), então deixar o trocador na tela viraria troca de papel pelo cliente.
  const { modo } = useDados();
  return (
    <>
      <Titulo descricao="Tudo o que não cabe no menu. Ou aperte “Ajudante” e escreva o que procura.">Mais opções</Titulo>
      {modo === 'fake' && <TrocarUsuario />}
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
