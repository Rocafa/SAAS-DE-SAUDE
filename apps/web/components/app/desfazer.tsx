'use client';

/**
 * Aviso no rodapé com "Desfazer" para toda ação reversível. Fica 10 segundos na tela
 * (tempo de leitura para quem não tem pressa com tecnologia) e não some com o mouse em cima.
 */
import { Check, Undo2, X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Botao } from '@/components/ui/botao';

interface Aviso {
  id: number;
  texto: string;
  desfazer?: () => void | Promise<void>;
}

const Ctx = createContext<(a: Omit<Aviso, 'id'>) => void>(() => undefined);

export function useAviso() {
  return useContext(Ctx);
}

export function AvisosProvider({ children }: { children: ReactNode }) {
  const [aviso, setAviso] = useState<Aviso | null>(null);
  const [pausado, setPausado] = useState(false);
  const seq = useRef(0);

  const avisar = useCallback((a: Omit<Aviso, 'id'>) => setAviso({ ...a, id: ++seq.current }), []);

  useEffect(() => {
    if (!aviso || pausado) return;
    const t = setTimeout(() => setAviso(null), 10_000);
    return () => clearTimeout(t);
  }, [aviso, pausado]);

  return (
    <Ctx.Provider value={avisar}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex justify-center px-4 md:bottom-6">
        {aviso && (
          <div
            role="status"
            onMouseEnter={() => setPausado(true)}
            onMouseLeave={() => setPausado(false)}
            onFocus={() => setPausado(true)}
            onBlur={() => setPausado(false)}
            className="pointer-events-auto flex w-full max-w-xl flex-wrap items-center gap-3 rounded-lg border-[3px] border-borda-forte bg-fundo p-3 shadow-[0_6px_0_0_var(--texto)]"
          >
            <Check aria-hidden className="size-6 shrink-0" />
            <span className="min-w-40 flex-1 font-bold">{aviso.texto}</span>
            {aviso.desfazer && (
              <Botao
                variante="contorno"
                tamanho="pequeno"
                onClick={async () => {
                  const d = aviso.desfazer!;
                  setAviso(null);
                  await d();
                  avisar({ texto: 'Pronto, desfeito.' });
                }}
              >
                <Undo2 aria-hidden />
                Desfazer
              </Botao>
            )}
            <Botao variante="suave" tamanho="pequeno" onClick={() => setAviso(null)}>
              <X aria-hidden />
              Fechar
            </Botao>
          </div>
        )}
      </div>
    </Ctx.Provider>
  );
}
