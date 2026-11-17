import { Lock } from 'lucide-react';
import Link from 'next/link';
import { Botao } from '@/components/ui/botao';
import { TEMPO_SESSAO_MINUTOS } from '@/lib/conta';

export default function SessaoExpirada() {
  return (
    <div className="flex flex-col gap-4">
      <Lock aria-hidden className="size-10" />
      <h1 className="text-[1.75rem] font-bold">Você saiu por segurança</h1>
      <p className="text-lg">
        Depois de {TEMPO_SESSAO_MINUTOS} minutos sem uso, o sistema sai sozinho para proteger os dados dos pacientes. O que você estava escrevendo ficou guardado
        como rascunho.
      </p>
      <Botao asChild tamanho="grande">
        <Link href="/entrar">Entrar de novo</Link>
      </Botao>
    </div>
  );
}
