import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { CabecalhoPagina } from './cabecalho-pagina';

interface FichaRegistroProps {
  nome: string;
  descricao?: ReactNode;
  status?: ReactNode;
  metadados?: ReactNode;
  acaoPrincipal?: ReactNode;
  acoesSecundarias?: ReactNode;
  voltar: { href: string; rotulo: string };
  abas: readonly { id: string; rotulo: string; href: string }[];
  abaAtual: string;
  children: ReactNode;
}

export function FichaRegistro({
  nome,
  descricao,
  status,
  metadados,
  acaoPrincipal,
  acoesSecundarias,
  voltar,
  abas,
  abaAtual,
  children,
}: FichaRegistroProps) {
  const atual = abas.find((aba) => aba.id === abaAtual) ?? abas[0]!;
  return (
    <article>
      <Link href={voltar.href} className="mb-4 inline-flex min-h-12 items-center gap-2 font-bold">
        <ArrowLeft aria-hidden className="size-5" />
        {voltar.rotulo}
      </Link>
      <CabecalhoPagina
        titulo={nome}
        descricao={descricao}
        status={status}
        acaoPrincipal={acaoPrincipal}
        acoesSecundarias={acoesSecundarias}
      />
      {metadados && <div className="-mt-3 mb-6">{metadados}</div>}
      <nav aria-label="Seções da ficha" className="mb-8 flex gap-1 overflow-x-auto border-b-2 border-borda">
        {abas.map((aba) => {
          const ativa = aba.id === atual.id;
          return (
            <Link
              key={aba.id}
              id={`aba-${aba.id}`}
              href={aba.href}
              aria-current={ativa ? 'page' : undefined}
              className={cn(
                '-mb-[2px] inline-flex min-h-12 shrink-0 items-center border-b-4 px-4 font-bold no-underline',
                ativa ? 'border-borda-forte bg-superficie' : 'border-transparent hover:border-borda',
              )}
            >
              {aba.rotulo}
            </Link>
          );
        })}
      </nav>
      <div id={`painel-${atual.id}`} role="region" aria-labelledby={`aba-${atual.id}`} tabIndex={0}>
        {children}
      </div>
    </article>
  );
}
