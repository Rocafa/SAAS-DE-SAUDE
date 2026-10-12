import type { ReactNode } from 'react';

/** Telas de acesso (sem login). Fluxo de mentira até a decisão de autenticação (D4). */
export default function LayoutAcesso({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <p className="border-b-2 border-borda bg-superficie-2 px-4 py-2 text-center text-[0.95rem] font-bold">
        Aguarda a decisão de login (D4): este acesso é de demonstração. Qualquer e-mail entra; o código é 123456.
      </p>
      <main id="conteudo" className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-10">
        <p className="mb-6 text-center text-xl font-bold">Plataforma Saúde</p>
        {children}
      </main>
    </div>
  );
}
