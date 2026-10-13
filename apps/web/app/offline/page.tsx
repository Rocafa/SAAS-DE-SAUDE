import { WifiOff } from 'lucide-react';

/** Tela que o service worker mostra quando não há internet. Sem dado nenhum. */
export default function PaginaSemConexao() {
  return (
    <main id="conteudo" className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-4">
      <WifiOff aria-hidden className="size-12" />
      <h1 className="text-[1.75rem] font-bold">Sem conexão com a internet</h1>
      <p className="text-lg">Confira o Wi-Fi ou os dados do celular. Quando a internet voltar, a tela abre sozinha.</p>
      <a href="/inicio" className="flex min-h-14 items-center justify-center rounded-md border-2 border-borda-forte px-5 text-lg font-bold no-underline">
        Tentar de novo
      </a>
    </main>
  );
}
