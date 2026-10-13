'use client';

/**
 * O AJUDANTE: botão grande no canto inferior direito de toda tela logada. Abre também com
 * Ctrl/Cmd+K e com a tecla "/".
 *
 * PRIVACIDADE: o texto digitado fica só na memória desta tela. Não vai para log, analytics,
 * console, armazenamento do navegador nem rede (teste em lib/privacidade.test.ts).
 * Voz DESLIGADA nesta fase: a API de voz do Chrome manda o áudio para servidores do Google.
 */
import * as Dialog from '@radix-ui/react-dialog';
import { Command } from 'cmdk';
import {
  ArrowLeft,
  BookOpen,
  CalendarDays,
  FileText,
  Hand,
  Mic,
  Settings,
  Sparkles,
  User,
  Wand2,
  X,
  Zap,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Botao } from '@/components/ui/botao';
import { acharAcao } from '@/lib/ajudante/acoes';
import { buscar, type Grupo, type Resultado } from '@/lib/ajudante/busca';
import type { Artigo } from '@/lib/ajudante/catalogo';
import { ehPerfilClinico } from '@/lib/prontuario';
import { useDados } from './dados';
import { useExecutor } from './executor';

/** Interface pronta para um reconhecimento de voz LOCAL (no aparelho). Nenhum implementado ainda. */
export interface ReconhecimentoVozLocal {
  disponivel(): boolean;
  ouvir(): Promise<string>;
}

const ICONE_GRUPO: Record<Grupo, typeof Zap> = {
  Fazer: Zap,
  Pacientes: User,
  Agenda: CalendarDays,
  Páginas: FileText,
  Configurações: Settings,
  Ajuda: BookOpen,
};

const SUGESTOES = [
  'agenda de amanhã',
  'quem falta confirmar',
  'marcar consulta para João quinta às 14h',
  'remarcar a Ana para sexta',
  'imprimir recibo da última consulta da Maria',
  'como cancelo uma consulta',
];

function campoDeTexto(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName);
}

export function Ajudante() {
  const router = useRouter();
  const { pacientes, agendamentos, usuario } = useDados();
  const { executar } = useExecutor();
  const [aberto, setAberto] = useState(false);
  const [texto, setTexto] = useState('');
  const [escolhido, setEscolhido] = useState<Resultado | null>(null);
  const [artigo, setArtigo] = useState<Artigo | null>(null);

  useEffect(() => {
    const atalho = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setAberto((a) => !a);
      } else if (e.key === '/' && !campoDeTexto(e.target) && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setAberto(true);
      }
    };
    window.addEventListener('keydown', atalho);
    return () => window.removeEventListener('keydown', atalho);
  }, []);

  const fechar = useCallback(() => {
    setAberto(false);
    setTexto('');
    setEscolhido(null);
    setArtigo(null);
  }, []);

  const grupos = useMemo(
    () =>
      buscar(texto, {
        pacientes,
        agendamentos,
        agora: new Date(),
        // Quem atende (inclusive admin que é profissional) usa as ações clínicas; os demais, não.
        papel: ehPerfilClinico(usuario) ? 'profissional' : (usuario?.papel ?? 'recepcao'),
      }),
    [texto, pacientes, agendamentos, usuario],
  );

  const escolher = (r: Resultado) => {
    if (r.artigo) return setArtigo(r.artigo);
    if (r.acaoId) return setEscolhido(r);
    if (r.rota) {
      fechar();
      router.push(r.rota);
    }
  };

  const rodar = (modo: 'fazer' | 'mostrar') => {
    if (!escolhido?.acaoId) return;
    const passos = acharAcao(escolhido.acaoId).handler(escolhido.params ?? {});
    const titulo = escolhido.titulo;
    fechar();
    // Espera o diálogo fechar para o cursor andar pela tela de verdade.
    setTimeout(() => executar(titulo, passos, modo), 60);
  };

  return (
    <>
      <Botao
        tamanho="grande"
        onClick={() => setAberto(true)}
        aria-keyshortcuts="Control+K Meta+K /"
        className="fixed bottom-24 right-4 z-40 rounded-full shadow-[0_0_0_4px_var(--fundo),0_6px_0_4px_var(--texto)] md:bottom-6 md:right-6"
        data-testid="abrir-ajudante"
      >
        <Sparkles aria-hidden />
        Ajudante
      </Botao>

      <Dialog.Root open={aberto} onOpenChange={(a) => (a ? setAberto(true) : fechar())}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
          <Dialog.Content
            aria-describedby="ajudante-dica"
            className="fixed inset-x-0 top-0 z-50 mx-auto flex max-h-[100dvh] w-full max-w-2xl flex-col overflow-hidden border-[3px] border-borda-forte bg-fundo md:top-[8vh] md:max-h-[84vh] md:rounded-xl"
          >
            <div className="flex items-center justify-between gap-2 border-b-2 border-borda px-4 py-3">
              <Dialog.Title className="flex items-center gap-2 text-xl font-bold">
                <Sparkles aria-hidden className="size-6" />
                Ajudante
              </Dialog.Title>
              <Dialog.Close asChild>
                <Botao variante="suave" tamanho="pequeno">
                  <X aria-hidden />
                  Fechar
                </Botao>
              </Dialog.Close>
            </div>

            {artigo ? (
              <ArtigoAjuda artigo={artigo} voltar={() => setArtigo(null)} />
            ) : escolhido ? (
              <EscolherModo resultado={escolhido} rodar={rodar} voltar={() => setEscolhido(null)} />
            ) : (
              <Command shouldFilter={false} loop label="O que você precisa?" className="flex min-h-0 flex-1 flex-col">
                <div className="flex items-center gap-2 border-b-2 border-borda p-3">
                  <Command.Input
                    autoFocus
                    value={texto}
                    onValueChange={setTexto}
                    placeholder="Escreva o que precisa. Ex.: agenda de amanhã"
                    aria-label="O que você precisa?"
                    autoComplete="off"
                    spellCheck={false}
                    className="min-h-14 flex-1 rounded-md border-2 border-borda-forte bg-fundo px-4 text-lg placeholder:text-texto-suave"
                  />
                  <Botao
                    variante="suave"
                    tamanho="pequeno"
                    className="hidden sm:inline-flex"
                    disabled
                    title="Voz desligada por enquanto, para proteger os dados dos pacientes"
                  >
                    <Mic aria-hidden />
                    Falar (em breve)
                  </Botao>
                </div>
                <p id="ajudante-dica" className="px-4 pt-2 text-[0.95rem] text-texto-suave">
                  Use as setas ↑ ↓ e Enter. O Ajudante nunca grava nada sozinho. Voz desligada por enquanto.
                </p>
                <Command.List label="Resultados" className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
                  {!texto && (
                    <Command.Group heading="Experimente escrever" className={CLASSE_GRUPO}>
                      {SUGESTOES.map((s) => (
                        <Command.Item key={s} value={`sugestao-${s}`} onSelect={() => setTexto(s)} className={CLASSE_ITEM}>
                          <Wand2 aria-hidden className="size-6 shrink-0" />
                          <span>{s}</span>
                        </Command.Item>
                      ))}
                    </Command.Group>
                  )}
                  {texto && grupos.length === 0 && (
                    <Command.Empty className="p-4">
                      <p className="font-bold">Não achei nada com “{texto}”.</p>
                      <p className="text-texto-suave">
                        Tente só o primeiro nome, o telefone ou uma palavra como “agenda”, “recibo” ou “pacientes”.
                      </p>
                    </Command.Empty>
                  )}
                  {grupos.map((g) => {
                    const Icone = ICONE_GRUPO[g.grupo];
                    return (
                      <Command.Group key={g.grupo} heading={g.grupo} className={CLASSE_GRUPO}>
                        {g.itens.map((r) => (
                          <Command.Item key={r.id} value={r.id} onSelect={() => escolher(r)} className={CLASSE_ITEM}>
                            <Icone aria-hidden className="size-6 shrink-0" />
                            <span className="flex min-w-0 flex-col">
                              <span className="font-bold">{r.titulo}</span>
                              {r.detalhe && <span className="text-[0.95rem] text-texto-suave">{r.detalhe}</span>}
                              {r.requiresConfirm && (
                                <span className="mt-1 self-start rounded-sm border-2 border-borda px-2 text-[0.85rem] font-bold">
                                  pede sua confirmação
                                </span>
                              )}
                            </span>
                          </Command.Item>
                        ))}
                      </Command.Group>
                    );
                  })}
                </Command.List>
              </Command>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}

const CLASSE_GRUPO =
  'pt-3 [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[0.9rem] [&_[cmdk-group-heading]]:font-bold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-texto-suave';

const CLASSE_ITEM =
  'flex min-h-14 cursor-pointer items-center gap-3 rounded-md border-2 border-transparent px-3 py-2 data-[selected=true]:border-borda-forte data-[selected=true]:bg-superficie-2';

function EscolherModo({
  resultado,
  rodar,
  voltar,
}: {
  resultado: Resultado;
  rodar: (m: 'fazer' | 'mostrar') => void;
  voltar: () => void;
}) {
  return (
    <div className="flex flex-col gap-4 p-4">
      <p className="text-xl font-bold">{resultado.titulo}</p>
      {resultado.detalhe && <p className="text-texto-suave">{resultado.detalhe}</p>}
      {resultado.requiresConfirm && (
        <p className="rounded-md border-2 border-dashed border-borda p-3">
          O Ajudante abre a tela e preenche. <strong>Quem confirma é você</strong>: ele para no botão de confirmar.
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Botao tamanho="grande" autoFocus onClick={() => rodar('fazer')} data-testid="fazer-por-mim">
          <Wand2 aria-hidden />
          Fazer por mim
        </Botao>
        <Botao tamanho="grande" variante="contorno" onClick={() => rodar('mostrar')}>
          <Hand aria-hidden />
          Me mostra como
        </Botao>
      </div>
      <Botao variante="suave" onClick={voltar} className="self-start">
        <ArrowLeft aria-hidden />
        Voltar
      </Botao>
    </div>
  );
}

function ArtigoAjuda({ artigo, voltar }: { artigo: Artigo; voltar: () => void }) {
  return (
    <div className="flex flex-col gap-4 overflow-y-auto p-4">
      <h2 className="text-xl font-bold">{artigo.titulo}</h2>
      <ol className="flex flex-col gap-3">
        {artigo.passos.map((p, i) => (
          <li key={p} className="flex gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full border-2 border-borda-forte font-bold">
              {i + 1}
            </span>
            <span className="pt-1">{p}</span>
          </li>
        ))}
      </ol>
      <Botao variante="suave" onClick={voltar} className="self-start" autoFocus>
        <ArrowLeft aria-hidden />
        Voltar
      </Botao>
    </div>
  );
}
