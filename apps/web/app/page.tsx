import Link from 'next/link';
import { Botao } from '@/components/ui/botao';

export default function HomePage() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-5 px-4 py-16">
      <h1 className="text-[2rem] font-bold leading-tight">Plataforma Saúde</h1>
      <p className="text-lg">
        Gestão para clínicas e consultórios: agenda, prontuário, financeiro e muito mais, com LGPD desde o desenho.
      </p>
      <p className="text-texto-suave">Ambiente de demonstração, com pacientes fictícios.</p>
      <div className="flex flex-wrap gap-3">
        <Botao asChild tamanho="grande">
          <Link href="/inicio">Abrir a demonstração</Link>
        </Botao>
        <Botao asChild tamanho="grande" variante="contorno">
          <Link href="/entrar">Entrar</Link>
        </Botao>
      </div>
    </main>
  );
}
