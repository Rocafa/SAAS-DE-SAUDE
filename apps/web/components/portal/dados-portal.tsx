'use client';

/**
 * Provedor do PORTAL DO PACIENTE. Não usa o provedor nem o contrato da clínica (veto B3):
 * nada de lista de pacientes, agenda da clínica ou usuário da equipe no navegador do paciente.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ApiPortal } from '@/lib/api/portal';
import { criarApiPortalFake } from '@/lib/api/portal-fake';

interface ContextoPortal {
  api: ApiPortal;
  versao: number;
  atualizar: () => void;
}

const Ctx = createContext<ContextoPortal | null>(null);

export function PortalProvider({ children }: { children: ReactNode }) {
  const [api] = useState<ApiPortal>(() => criarApiPortalFake());
  const [versao, setVersao] = useState(0);
  const atualizar = useCallback(() => setVersao((v) => v + 1), []);
  const valor = useMemo(() => ({ api, versao, atualizar }), [api, versao, atualizar]);
  return <Ctx.Provider value={valor}>{children}</Ctx.Provider>;
}

export function usePortal(): ContextoPortal {
  const c = useContext(Ctx);
  if (!c) throw new Error('usePortal fora do PortalProvider');
  return c;
}

export type EstadoPortal<T> =
  | { estado: 'carregando' }
  | { estado: 'erro'; mensagem: string; tentarDeNovo: () => void }
  | { estado: 'pronto'; dados: T };

export function useConsultaPortal<T>(carregar: (api: ApiPortal) => Promise<T>): EstadoPortal<T> {
  const { api, versao } = usePortal();
  const [tentativa, setTentativa] = useState(0);
  const [estado, setEstado] = useState<EstadoPortal<T>>({ estado: 'carregando' });
  useEffect(() => {
    let vivo = true;
    carregar(api)
      .then((dados) => vivo && setEstado({ estado: 'pronto', dados }))
      .catch((e: unknown) =>
        vivo &&
        setEstado({ estado: 'erro', mensagem: e instanceof Error ? e.message : 'Algo falhou.', tentarDeNovo: () => setTentativa((t) => t + 1) }),
      );
    return () => {
      vivo = false;
    };
    // `carregar` muda a cada render; recarrega quando os dados mudam ou ao tentar de novo.
  }, [api, versao, tentativa]);
  return estado;
}

export function useOnlinePortal(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const f = () => setOnline(navigator.onLine);
    f();
    window.addEventListener('online', f);
    window.addEventListener('offline', f);
    return () => {
      window.removeEventListener('online', f);
      window.removeEventListener('offline', f);
    };
  }, []);
  return online;
}
