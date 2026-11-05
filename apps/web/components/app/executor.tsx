'use client';

/**
 * Executor do Ajudante: "Fazer por mim" opera o PRÓPRIO app (navega, rola até o campo, preenche)
 * com um cursor visível e narração curta; "Me mostra como" destaca passo a passo onde clicar.
 * Só mexe no nosso app, dentro do navegador. Para no botão de confirmar: quem grava é a pessoa.
 */
import { ArrowRight, MousePointer2, Square, Undo2 } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Botao } from '@/components/ui/botao';
import type { Passo } from '@/lib/ajudante/acoes';
import type { Alvo } from '@/lib/ajudante/catalogo';

export type Modo = 'fazer' | 'mostrar';

interface Execucao {
  titulo: string;
  modo: Modo;
  passos: Passo[];
  indice: number;
  narracao: string;
  terminou: boolean;
  rotaInicial: string;
}

interface ContextoExecutor {
  executar: (titulo: string, passos: Passo[], modo: Modo) => void;
}

const Ctx = createContext<ContextoExecutor>({ executar: () => undefined });

export function useExecutor() {
  return useContext(Ctx);
}

const EVENTO_PREENCHER = 'ajudante:preencher';
const EVENTO_LIMPAR = 'ajudante:limpar';

/** O formulário recebe o valor que o Ajudante preencheu, e limpa quando a pessoa aperta "Desfazer". */
export function usePreenchimento(alvo: Alvo, aplicar: (valor: string) => void, limpar?: () => void) {
  const ref = useRef({ aplicar, limpar });
  ref.current = { aplicar, limpar };
  useEffect(() => {
    const ouvir = (e: Event) => {
      const d = (e as CustomEvent<{ alvo: string; valor: string }>).detail;
      if (d.alvo === alvo) ref.current.aplicar(d.valor);
    };
    const zerar = () => ref.current.limpar?.();
    window.addEventListener(EVENTO_PREENCHER, ouvir);
    window.addEventListener(EVENTO_LIMPAR, zerar);
    return () => {
      window.removeEventListener(EVENTO_PREENCHER, ouvir);
      window.removeEventListener(EVENTO_LIMPAR, zerar);
    };
  }, [alvo]);
}

function seletor(alvo: string, chave?: string) {
  return `[data-assist-id="${alvo}"]${chave ? `[data-assist-chave="${CSS.escape(chave)}"]` : ''}`;
}

function visivel(el: Element): el is HTMLElement {
  return el instanceof HTMLElement && el.getClientRects().length > 0;
}

function acharVisivel(alvo: string, chave?: string): HTMLElement | null {
  return Array.from(document.querySelectorAll(seletor(alvo, chave))).find(visivel) ?? null;
}

async function esperarElemento(alvo: string, chave: string | undefined, sinal: { parar: boolean }, ms = 5000) {
  const fim = Date.now() + ms;
  while (Date.now() < fim && !sinal.parar) {
    const el = acharVisivel(alvo, chave);
    if (el) return el;
    await pausa(50);
  }
  return null;
}

function pausa(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function limparDestaques() {
  document.querySelectorAll('[data-ajudante-destaque]').forEach((el) => el.removeAttribute('data-ajudante-destaque'));
}

const semMovimento = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function ExecutorProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [exec, setExec] = useState<Execucao | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  // O painel de narração fica do lado oposto ao alvo, para nunca cobrir o botão destacado.
  const [painelEmCima, setPainelEmCima] = useState(false);
  const sinal = useRef({ parar: false });

  const apontar = useCallback(async (el: HTMLElement) => {
    el.scrollIntoView({ block: 'center', behavior: semMovimento() ? 'auto' : 'smooth' });
    await pausa(semMovimento() ? 50 : 350);
    const r = el.getBoundingClientRect();
    setCursor({ x: r.left + Math.min(r.width / 2, 60), y: r.top + r.height / 2 });
    setPainelEmCima(r.top + r.height / 2 > window.innerHeight / 2);
    await pausa(semMovimento() ? 50 : 450);
  }, []);

  const narrar = useCallback((indice: number, narracao: string, terminou = false) => {
    setExec((e) => (e ? { ...e, indice, narracao, terminou } : e));
  }, []);

  /** Faz um passo. No modo "mostrar", só destaca e devolve. */
  const fazerPasso = useCallback(
    async (passo: Passo, i: number, modo: Modo): Promise<boolean> => {
      limparDestaques();
      narrar(i, passo.narracao);
      if (passo.tipo === 'navegar') {
        if (passo.alvo) {
          const menu = acharVisivel(passo.alvo);
          if (menu) {
            menu.setAttribute('data-ajudante-destaque', 'true');
            await apontar(menu);
            if (modo === 'mostrar') return true;
          }
        }
        if (modo === 'mostrar') return true;
        router.push(passo.rota);
        await pausa(250);
        return true;
      }
      const chave = 'chave' in passo ? passo.chave : undefined;
      const el = await esperarElemento(passo.alvo, chave, sinal.current);
      if (!el) {
        narrar(i, 'Não achei esse lugar na tela. Feche o Ajudante e tente de novo.', true);
        return false;
      }
      el.setAttribute('data-ajudante-destaque', 'true');
      await apontar(el);
      if (modo === 'mostrar') {
        if (passo.tipo === 'preencher') narrar(i, `Aqui você escolhe: ${passo.rotuloValor}`);
        return true;
      }
      if (passo.tipo === 'preencher') {
        window.dispatchEvent(new CustomEvent(EVENTO_PREENCHER, { detail: { alvo: passo.alvo, valor: passo.valor } }));
        await pausa(semMovimento() ? 50 : 500);
        el.removeAttribute('data-ajudante-destaque');
      } else if (passo.tipo === 'destacar') {
        await pausa(semMovimento() ? 50 : 700);
      } else if (passo.tipo === 'confirmar') {
        el.focus({ preventScroll: true });
      }
      return true;
    },
    [apontar, narrar, router],
  );

  const executar = useCallback(
    (titulo: string, passos: Passo[], modo: Modo) => {
      sinal.current = { parar: false };
      const rotaInicial = window.location.pathname + window.location.search;
      setExec({ titulo, modo, passos, indice: 0, narracao: '', terminou: false, rotaInicial });
      if (modo === 'mostrar') {
        void fazerPasso(passos[0]!, 0, 'mostrar');
        return;
      }
      void (async () => {
        for (let i = 0; i < passos.length; i++) {
          if (sinal.current.parar) return;
          const ok = await fazerPasso(passos[i]!, i, 'fazer');
          if (!ok) return;
        }
        const ultimo = passos.at(-1)!;
        narrar(
          passos.length - 1,
          ultimo.tipo === 'confirmar' ? `${ultimo.narracao} Nada foi gravado ainda.` : 'Pronto.',
          true,
        );
        setCursor(null);
      })();
    },
    [fazerPasso, narrar],
  );

  const proximo = useCallback(async () => {
    if (!exec) return;
    const atual = exec.passos[exec.indice]!;
    if (atual.tipo === 'navegar') {
      router.push(atual.rota);
      await pausa(250);
    }
    const i = exec.indice + 1;
    if (i >= exec.passos.length) {
      limparDestaques();
      setCursor(null);
      narrar(exec.indice, 'Fim do passo a passo. Agora é com você.', true);
      return;
    }
    await fazerPasso(exec.passos[i]!, i, 'mostrar');
    if (i === exec.passos.length - 1) narrar(i, exec.passos[i]!.narracao, true);
  }, [exec, fazerPasso, narrar, router]);

  const parar = useCallback(() => {
    sinal.current.parar = true;
    limparDestaques();
    setCursor(null);
    setExec(null);
  }, []);

  const desfazer = useCallback(() => {
    if (!exec) return;
    window.dispatchEvent(new Event(EVENTO_LIMPAR));
    router.push(exec.rotaInicial);
    parar();
  }, [exec, parar, router]);

  // Clicar no botão destacado (ou mudar de tela por conta própria) encerra o destaque.
  useEffect(() => {
    if (!exec?.terminou) return;
    const ao = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (t?.closest('[data-ajudante-destaque="true"]')) parar();
    };
    document.addEventListener('click', ao, true);
    return () => document.removeEventListener('click', ao, true);
  }, [exec?.terminou, parar]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && exec && parar();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [exec, parar]);

  void pathname;

  return (
    <Ctx.Provider value={{ executar }}>
      {children}
      {cursor && (
        <div
          aria-hidden
          data-ajudante-cursor
          className="pointer-events-none fixed left-0 top-0 z-[70] transition-transform duration-500 ease-out"
          style={{ transform: `translate(${cursor.x}px, ${cursor.y}px)` }}
        >
          <MousePointer2 className="size-10 fill-black stroke-white stroke-[1.5] drop-shadow-[0_0_2px_#fff]" />
        </div>
      )}
      {exec && (
        <div
          role="region"
          aria-label="Ajudante trabalhando"
          className={`fixed inset-x-3 z-[60] mx-auto flex max-w-2xl flex-col gap-3 rounded-lg border-[3px] border-borda-forte bg-fundo p-4 shadow-[0_6px_0_0_var(--texto)] ${
            painelEmCima ? 'top-3' : 'bottom-24 md:bottom-6'
          }`}
        >
          <p className="text-[0.95rem] font-bold uppercase tracking-wide">
            {exec.modo === 'fazer' ? 'Ajudante fazendo por você' : 'Ajudante mostrando como'} · passo {exec.indice + 1} de{' '}
            {exec.passos.length}
          </p>
          <p role="status" aria-live="assertive" className="text-lg" data-testid="narracao-ajudante">
            {exec.narracao || exec.titulo}
          </p>
          <div className="flex flex-wrap gap-2">
            {exec.modo === 'mostrar' && !exec.terminou && (
              <Botao onClick={proximo}>
                <ArrowRight aria-hidden />
                Próximo passo
              </Botao>
            )}
            {exec.modo === 'fazer' && exec.terminou && (
              <Botao variante="contorno" onClick={desfazer}>
                <Undo2 aria-hidden />
                Desfazer o que o Ajudante preencheu
              </Botao>
            )}
            <Botao variante="suave" onClick={parar}>
              <Square aria-hidden />
              {exec.terminou ? 'Fechar' : 'Parar'}
            </Botao>
          </div>
        </div>
      )}
    </Ctx.Provider>
  );
}
