'use client';

import { RotateCcw } from 'lucide-react';
import { Botao } from '@/components/ui/botao';

/** Erro inesperado: mensagem simples, sem detalhe técnico (que pode conter dado de paciente). */
export default function ErroGeral({ reset }: { error: Error; reset: () => void }) {
  return (
    <main id="conteudo" className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-4">
      <h1 className="text-[1.75rem] font-bold">Algo deu errado nesta tela</h1>
      <p className="text-lg">Nada do que já estava salvo foi perdido. Tente de novo; se continuar, chame o suporte no chat.</p>
      <Botao tamanho="grande" onClick={reset}>
        <RotateCcw aria-hidden />
        Tentar de novo
      </Botao>
    </main>
  );
}
