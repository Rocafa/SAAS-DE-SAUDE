'use client';

/**
 * Provedor da camada de dados. Hoje usa o adaptador FAKE (dados fictícios em memória).
 * `?demo=erro|vazio|lento` na URL mostra os estados de tela para revisão.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ApiClinica } from '@/lib/api/cliente';
import { criarApiFake } from '@/lib/api/fake';
import type { Agendamento, Paciente, Usuario } from '@/lib/api/tipos';

interface ContextoDados {
  api: ApiClinica;
  usuario: Usuario | null;
  /** Retrato em memória para a busca instantânea do Ajudante. */
  pacientes: Paciente[];
  agendamentos: Agendamento[];
  versao: number;
  /** Chame depois de gravar algo para as telas recarregarem. */
  atualizar: () => void;
}

const Ctx = createContext<ContextoDados | null>(null);

function lerSimulacao(): 'erro' | 'vazio' | 'lento' | undefined {
  if (typeof window === 'undefined') return undefined;
  const v = new URLSearchParams(window.location.search).get('demo');
  return v === 'erro' || v === 'vazio' || v === 'lento' ? v : undefined;
}

export function DadosProvider({ children }: { children: ReactNode }) {
  const [api] = useState<ApiClinica>(() => {
    const simular = lerSimulacao();
    return criarApiFake(simular ? { simular } : {});
  });
  const [versao, setVersao] = useState(0);
  const [usuario, setUsuario] = useState<Usuario | null>(null);
  const [pacientes, setPacientes] = useState<Paciente[]>([]);
  const [agendamentos, setAgendamentos] = useState<Agendamento[]>([]);

  useEffect(() => {
    let vivo = true;
    Promise.all([api.usuarioAtual(), api.listarPacientes(), api.listarAgendamentos()])
      .then(([u, p, a]) => {
        if (!vivo) return;
        setUsuario(u);
        setPacientes(p);
        setAgendamentos(a);
      })
      .catch(() => {
        /* cada tela mostra o próprio erro com "Tentar de novo" */
      });
    return () => {
      vivo = false;
    };
  }, [api, versao]);

  const atualizar = useCallback(() => setVersao((v) => v + 1), []);
  const valor = useMemo(
    () => ({ api, usuario, pacientes, agendamentos, versao, atualizar }),
    [api, usuario, pacientes, agendamentos, versao, atualizar],
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
