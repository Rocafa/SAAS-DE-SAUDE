'use client';

/** Ajuda: "Como faço…", com os mesmos artigos que o Ajudante encontra. */
import { BookOpen, ChevronDown, LifeBuoy, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Titulo } from '@/components/app/estrutura';
import { Vazio } from '@/components/ui/estados';
import { ARTIGOS } from '@/lib/ajudante/catalogo';
import { notaTexto } from '@/lib/texto';

export default function PaginaAjuda() {
  const [busca, setBusca] = useState('');
  const [aberto, setAberto] = useState<string | null>(null);
  const lista = useMemo(() => {
    if (!busca.trim()) return ARTIGOS;
    return ARTIGOS.filter((a) => [a.titulo, ...a.perguntas, ...a.passos].some((t) => notaTexto(busca, t) > 0));
  }, [busca]);

  return (
    <>
      <Titulo descricao="Passo a passo das tarefas do dia a dia. Dica: o botão Ajudante também faz por você.">Como faço…</Titulo>
      <div className="relative mb-6 max-w-xl">
        <label htmlFor="ajuda-busca" className="sr-only">
          Procurar na ajuda
        </label>
        <Search aria-hidden className="pointer-events-none absolute left-4 top-1/2 size-6 -translate-y-1/2" />
        <input
          id="ajuda-busca"
          type="search"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder="Ex.: cancelar consulta"
          className="min-h-14 w-full rounded-md border-2 border-borda-forte bg-fundo pl-12 pr-4 text-lg"
        />
      </div>
      {lista.length === 0 ? (
        <Vazio titulo={`Nada sobre “${busca}”`} oQueFazer="Tente outra palavra ou fale com o suporte no chat." />
      ) : (
        <ul className="flex flex-col gap-2">
          {lista.map((a) => (
            <li key={a.id} className="rounded-md border-2 border-borda">
              <button
                type="button"
                aria-expanded={aberto === a.id}
                aria-controls={`art-${a.id}`}
                onClick={() => setAberto((x) => (x === a.id ? null : a.id))}
                className="flex min-h-14 w-full items-center gap-3 px-4 text-left text-lg font-bold"
              >
                <BookOpen aria-hidden className="size-6 shrink-0" />
                <span className="flex-1">{a.titulo}</span>
                <ChevronDown aria-hidden className={`size-6 ${aberto === a.id ? 'rotate-180' : ''}`} />
              </button>
              {aberto === a.id && (
                <ol id={`art-${a.id}`} className="flex flex-col gap-3 border-t-2 border-borda p-4">
                  {a.passos.map((p, i) => (
                    <li key={p} className="flex gap-3">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-full border-2 border-borda-forte font-bold">{i + 1}</span>
                      <span className="pt-1">{p}</span>
                    </li>
                  ))}
                </ol>
              )}
            </li>
          ))}
        </ul>
      )}
      <section aria-labelledby="t-suporte" className="mt-8 flex items-start gap-3 rounded-md border-2 border-dashed border-borda p-4">
        <LifeBuoy aria-hidden className="mt-1 size-6 shrink-0" />
        <div>
          <h2 id="t-suporte" className="text-lg font-bold">
            Ainda com dúvida?
          </h2>
          <p>Chat com o suporte em horário comercial: 9 de cada 10 chamados respondidos em até 15 minutos (em breve).</p>
        </div>
      </section>
    </>
  );
}
