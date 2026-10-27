'use client';

/**
 * Provedor da camada de dados. Adaptador escolhido por `NEXT_PUBLIC_API_MODO` (lib/api/selecionar.ts):
 * `fake` (padrão, dados fictícios em memória) ou `http` (pacientes e agenda na API real).
 * `?demo=erro|vazio|lento` na URL mostra os estados de tela para revisão (só no fake).
 *
 * No modo http, o retrato em memória segue a ressalva R1 do parecer front-r8: projeção mínima de
 * pacientes (`paraIndice`), agenda só na janela −30/+90 dias, e tudo é limpo em 401 (sessão
 * terminou), na troca de usuário ou de clínica e em `limpar()` (sair). Nada vai para storage.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { paraIsoLocal, somarDias } from '@/lib/ajudante/datas';
import type { ApiClinica } from '@/lib/api/cliente';
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
}

const Ctx = createContext<ContextoDados | null>(null);

function lerSimulacao(): 'erro' | 'vazio' | 'lento' | undefined {
  if (typeof window === 'undefined') return undefined;
  const v = new URLSearchParams(window.location.search).get('demo');
  return v === 'erro' || v === 'vazio' || v === 'lento' ? v : undefined;
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

  const limpar = useCallback(() => {
    usuarioRef.current = null;
    setUsuario(null);
    setPacientes([]);
    setAgendamentos([]);
  }, []);

  const [api] = useState<ApiClinica>(() => {
    const simular = lerSimulacao();
    return criarApi(config, { fake: simular ? { simular } : {}, http: { aoPerderSessao: limpar } });
  });

  useEffect(() => {
    let vivo = true;
    const http = config.modo === 'http';
    const hoje = new Date();
    const janela = http
      ? { de: paraIsoLocal(somarDias(hoje, -JANELA_PADRAO.antes)), ate: paraIsoLocal(somarDias(hoje, JANELA_PADRAO.depois)) }
      : {};
    Promise.all([api.usuarioAtual(), api.listarPacientes(), api.listarAgendamentos(janela)])
      .then(([u, p, a]) => {
        if (!vivo) return;
        if (!mesmaSessao(usuarioRef.current, u)) limpar();
        usuarioRef.current = u;
        setUsuario(u);
        setPacientes(http ? p.map(paraIndice) : p);
        setAgendamentos(a);
      })
      .catch(() => {
        /* cada tela mostra o próprio erro com "Tentar de novo"; em 401 o adaptador já chamou limpar() */
      });
    return () => {
      vivo = false;
    };
  }, [api, config.modo, versao, limpar]);

  const atualizar = useCallback(() => setVersao((v) => v + 1), []);
  const valor = useMemo(
    () => ({ api, modo: config.modo, usuario, pacientes, agendamentos, versao, atualizar, limpar }),
    [api, config.modo, usuario, pacientes, agendamentos, versao, atualizar, limpar],
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
          mensagem: e instanceof Error ? e.message : 'Algo falhou.',
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
