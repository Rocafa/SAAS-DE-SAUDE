'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound, useParams } from 'next/navigation';
import { SECOES } from '@/components/app/configuracoes';
import { Titulo } from '@/components/app/estrutura';
import { Botao } from '@/components/ui/botao';

export default function PaginaSecao() {
  const { secao } = useParams<{ secao: string }>();
  const s = SECOES[secao];
  if (!s) notFound();
  const { Componente } = s;
  return (
    <>
      <Botao asChild variante="suave" tamanho="pequeno" className="mb-4">
        <Link href="/configuracoes">
          <ArrowLeft aria-hidden />
          Configurações
        </Link>
      </Botao>
      <Titulo descricao={s.descricao}>{s.titulo}</Titulo>
      <Componente />
    </>
  );
}
