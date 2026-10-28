import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Botao } from '@/components/ui/botao';
import { PAGINAS } from '@/lib/ajudante/catalogo';

/** Telas dos próximos pacotes. Só rotas conhecidas; o resto é 404. */
const PACOTE: Record<string, string> = {
  configuracoes: 'PR 5',
  ajuda: 'PR 5',
};

export default async function EmConstrucao({ params }: { params: Promise<{ secao: string[] }> }) {
  const { secao } = await params;
  const raiz = secao[0] ?? '';
  const pacote = PACOTE[raiz];
  if (!pacote) notFound();
  const rota = `/${secao.join('/')}`;
  const titulo = PAGINAS.find((p) => p.rota === rota)?.titulo ?? PAGINAS.find((p) => p.rota === `/${raiz}`)?.titulo ?? 'Esta tela';
  return (
    <div className="flex max-w-xl flex-col gap-4">
      <h1 className="text-[2rem] font-bold">{titulo}</h1>
      <p className="rounded-md border-2 border-dashed border-borda p-4">
        Esta tela chega no próximo pacote ({pacote}). Enquanto isso, o Ajudante já sabe o caminho até aqui.
      </p>
      <Botao asChild variante="contorno" className="self-start">
        <Link href="/inicio">Voltar para Hoje</Link>
      </Botao>
    </div>
  );
}
