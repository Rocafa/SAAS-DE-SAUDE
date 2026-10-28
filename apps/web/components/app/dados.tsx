'use client';

/**
 * Provedor da camada de dados. Adaptador escolhido por `NEXT_PUBLIC_API_MODO` (lib/api/selecionar.ts):
 * `fake` (padrão, dados fictícios em memória) ou `http` (pacientes e agenda na API real).
 * `?demo=erro|vazio|lento` na URL mostra os estados de tela para revisão (só no fake).
 *
 * No modo http há dois retratos em memória, nenhum em storage:
 * - o do provedor (ressalva R1 do parecer front-r8): projeção mínima de pacientes (`paraIndice`) e
 *   agenda só na janela −30/+90 dias, para a busca instantânea do Ajudante;
 * - o do adaptador (`lib/api/http.ts`): a lista de pacientes guardada por até 5 min, amarrada à chave
 *   usuário + clínica do `GET /sessao`. O adaptador confere a sessão antes de devolver a lista e
 *   descarta se mudou (o cookie vale para todas as abas: outra aba pode ter trocado de clínica).
 * Os dois são apagados em `limpar()` (sair, trocar de clínica), em 401 e em qualquer mudança de sessão.
 * A cada carga o provedor pergunta a sessão PRIMEIRO; se mudou, limpa tudo e só então lista (veto B1
 * do #76: uma lista obtida antes da comparação nunca é gravada).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { paraIsoLocal, somarDias } from '@/lib/ajudante/datas';
import type { ApiClinica } from '@/lib/api/cliente';
import { textoDoErro } from '@/components/app/desfazer';
import { JANELA_PADRAO } from '@/lib/api/http';
import { criarApi, lerConfigApi, paraIndice, type ModoApi } from '@/lib/api/selecionar';
import type { Agendamento, Paciente, Usuario } from '@/lib/api/tipos';

interface ContextoDados {
  api: ApiClinica;
  modo: ModoApi;
  usuario: Usuario | null;
  /** Retrato em memória para a busca instantânea do Ajudante. */
  pacientes: Paciente[];
  agendamentos: Agendamento[];
  versao: number;
  /** Chame depois de gravar algo para as telas recarregarem. */
  atualizar: () => void;
  /** Apaga o retrato em memória (sair, trocar de clínica). */
  limpar: () => void;
  /** Só na demonstração: trocar de usuário para ver as permissões. */
  entrarComo: (id: string) => Promise<void>;
}

const Ctx = createContext<ContextoDados | null>(null);

function lerSimulacao(): 'erro' | 'vazio' | 'lento' | 'lista_mudou' | undefined {
  if (typeof window === 'undefined') return undefined;
  const v = new URLSearchParams(window.location.search).get('demo');
  return v === 'erro' || v === 'vazio' || v === 'lento' || v === 'lista_mudou' ? v : undefined;
}

/** Mesma pessoa na mesma clínica? Se não, o retrato anterior não pode sobreviver. */
function mesmaSessao(a: Usuario | null, b: Usuario): boolean {
  return a === null || (a.id === b.id && a.clinicaId === b.clinicaId);
}

export function DadosProvider({ children }: { children: ReactNode }) {
  const [config] = useState(() => lerConfigApi());
  const [versao, setVersao] = useState(0);
  const [usuario, setUsuario] = useState<Usuario | null>(null);
  const [pacientes, setPacientes] = useState<Paciente[]>([]);
  const [agendamentos, setAgendamentos] = useState<Agendamento[]>([]);
  const usuarioRef = useRef<Usuario | null>(null);
  const apiRef = useRef<ApiClinica | null>(null);

  const limpar = useCallback(() => {
    apiRef.current?.esquecerCache?.();
    usuarioRef.current = null;
    setUsuario(null);
    setPacientes([]);
    setAgendamentos([]);
  }, []);

  const [api] = useState<ApiClinica>(() => {
    const simular = lerSimulacao();
    return criarApi(config, { fake: simular ? { simular } : {}, http: { aoPerderSessao: limpar } });
  });
  apiRef.current = api;

  useEffect(() => {
    let vivo = true;
    const http = config.modo === 'http';
    const hoje = new Date();
    const janela = http
      ? { de: paraIsoLocal(somarDias(hoje, -JANELA_PADRAO.antes)), ate: paraIsoLocal(somarDias(hoje, JANELA_PADRAO.depois)) }
      : {};
    (async () => {
      // Sessão primeiro: se mudou (outra aba trocou de clínica ou de usuário), limpa antes de listar.
      const u = await api.usuarioAtual();
      if (!vivo) return;
      if (!mesmaSessao(usuarioRef.current, u)) limpar();
      usuarioRef.current = u;
      setUsuario(u);
      const [p, a] = await Promise.all([api.listarPacientes(), api.listarAgendamentos(janela)]);
      // Só grava se a sessão ainda é a mesma da comparação acima.
      if (!vivo || usuarioRef.current !== u) return;
      setPacientes(http ? p.map(paraIndice) : p);
      setAgendamentos(a);
    })()
      .catch(() => {
        /* cada tela mostra o próprio erro com "Tentar de novo"; em 401 o adaptador já chamou limpar() */
      });
    return () => {
      vivo = false;
    };
  }, [api, config.modo, versao, limpar]);

  const atualizar = useCallback(() => setVersao((v) => v + 1), []);
  const entrarComo = useCallback(
    async (id: string) => {
      await api.entrarComo(id);
      atualizar();
    },
    [api, atualizar],
  );
  const valor = useMemo(
    () => ({ api, modo: config.modo, usuario, pacientes, agendamentos, versao, atualizar, limpar, entrarComo }),
    [api, config.modo, usuario, pacientes, agendamentos, versao, atualizar, limpar, entrarComo],
  );
  return <Ctx.Provider value={valor}>{children}</Ctx.Provider>;
}

export function useDados(): ContextoDados {
  const c = useContext(Ctx);
  if (!c) throw new Error('useDados fora do DadosProvider');
  return c;
}

export type EstadoConsulta<T> =
  | { estado: 'carregando' }
  | { estado: 'erro'; mensagem: string; tentarDeNovo: () => void }
  | { estado: 'pronto'; dados: T };

/** Carrega dados com os estados de tela (carregando, erro com "Tentar de novo", pronto). */
export function useConsulta<T>(carregar: (api: ApiClinica) => Promise<T>, deps: unknown[] = []): EstadoConsulta<T> {
  const { api, versao } = useDados();
  const [tentativa, setTentativa] = useState(0);
  const [estado, setEstado] = useState<EstadoConsulta<T>>({ estado: 'carregando' });
  useEffect(() => {
    let vivo = true;
    setEstado((e) => (e.estado === 'pronto' ? e : { estado: 'carregando' }));
    carregar(api)
      .then((dados) => vivo && setEstado({ estado: 'pronto', dados }))
      .catch((e: unknown) =>
        vivo &&
        setEstado({
          estado: 'erro',
          mensagem: textoDoErro(e, 'Algo falhou.'),
          tentarDeNovo: () => setTentativa((t) => t + 1),
        }),
      );
    return () => {
      vivo = false;
    };
  }, [api, versao, tentativa, ...deps]);
  return estado;
}

export function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const atualizar = () => setOnline(navigator.onLine);
    atualizar();
    window.addEventListener('online', atualizar);
    window.addEventListener('offline', atualizar);
    return () => {
      window.removeEventListener('online', atualizar);
      window.removeEventListener('offline', atualizar);
    };
  }, []);
  return online;
}
