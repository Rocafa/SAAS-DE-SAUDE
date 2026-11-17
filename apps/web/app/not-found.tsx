import Link from 'next/link';
import { Botao } from '@/components/ui/botao';

export default function NaoEncontrada() {
  return (
    <main id="conteudo" className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-4">
      <p className="text-[0.95rem] font-bold uppercase tracking-wide text-texto-suave">Erro 404</p>
      <h1 className="text-[1.75rem] font-bold">Não achamos esta página</h1>
      <p className="text-lg">O endereço pode estar errado ou a página mudou de lugar. Use os botões abaixo para voltar.</p>
      <Botao asChild tamanho="grande">
        <Link href="/inicio">Voltar para Hoje</Link>
      </Botao>
      <Botao asChild variante="contorno">
        <Link href="/ajuda">Abrir a Ajuda</Link>
      </Botao>
    </main>
  );
}
