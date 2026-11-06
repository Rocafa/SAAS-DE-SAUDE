'use client';

/**
 * Provedor do PORTAL DO PACIENTE. Não usa o provedor nem o contrato da clínica (veto B3): nada de lista
 * de pacientes, agenda da clínica ou usuário da equipe no navegador do paciente.
 *
 * "De quem" é o acesso (P3): ao abrir, pergunta ao servidor a sessão (`GET /portal/sessao`). Com mais de
 * um vínculo e nenhum escolhido (409 `escolher_vinculo`), mostra a escolha; sem vínculo (409
 * `sem_vinculo`), manda para o convite; vínculo inativo (403) e sessão vencida (401) têm tela própria.
 * Na troca de vínculo TODO o estado das telas é descartado (as telas remontam com a chave do vínculo).
 * Nada do portal vai para localStorage, sessionStorage ou cache (G3; §10h).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ErroPortal, mensagemDoErro, mensagemParaTela, type ClientePortal, type VinculoDaConta } from '@/lib/api/portal';
import { criarClientePortal, lerConfigPortal, type ModoPortal } from '@/lib/api/portal-selecionar';

interface ContextoPortal {
  api: ClientePortal;
  modo: ModoPortal;
  vinculo: VinculoDaConta;
  /** A conta tem mais de um vínculo (mostra "trocar"). */
  podeTrocar: boolean;
  trocar: () => void;
  versao: number;
  atualizar: () => void;
}

export type FaseDoPortal =
  | { fase: 'carregando' }
  | { fase: 'escolher'; vinculos: readonly VinculoDaConta[] }
  | { fase: 'sem_vinculo' }
  | { fase: 'sem_sessao' }
  | { fase: 'inativo'; mensagem: string }
  | { fase: 'erro'; mensagem: string }
  | { fase: 'pronto'; vinculo: VinculoDaConta };

const Ctx = createContext<ContextoPortal | null>(null);

function criar(): { api: ClientePortal; modo: ModoPortal } | { erro: string } {
  try {
    const config = lerConfigPortal();
    return { api: criarClientePortal(config), modo: config.modo };
  } catch (e) {
    return { erro: mensagemParaTela(e) };
  }
}

/** Erro → fase. 401, 403 de vínculo e 409 de vínculo mudam a tela inteira; o resto é erro comum. */
export function faseDoErro(e: unknown): FaseDoPortal | null {
  if (!(e instanceof ErroPortal)) return null;
  if (e.status === 401) return { fase: 'sem_sessao' };
  if (e.status === 409 && e.codigo === 'sem_vinculo') return { fase: 'sem_vinculo' };
  if (e.status === 403 && (e.codigo === 'vinculo_inativo' || e.codigo === 'janela_de_saida_encerrada')) {
    return { fase: 'inativo', mensagem: mensagemDoErro(e.status, e.codigo) };
  }
  return null;
}

export function PortalProvider({ children, telas }: { children: ReactNode; telas: (f: Exclude<FaseDoPortal, { fase: 'pronto' }>, acoes: AcoesDaFase) => ReactNode }) {
  const [criado] = useState(criar);
  const [fase, setFase] = useState<FaseDoPortal>(() => ('erro' in criado ? { fase: 'erro', mensagem: criado.erro } : { fase: 'carregando' }));
  const [podeTrocar, setPodeTrocar] = useState(false);
  const [versao, setVersao] = useState(0);
  const atualizar = useCallback(() => setVersao((v) => v + 1), []);
  const api = 'api' in criado ? criado.api : null;

  const abrir = useCallback(async () => {
    if (!api) return;
    setFase({ fase: 'carregando' });
    try {
      const vinculo = await api.sessao();
      setFase({ fase: 'pronto', vinculo });
      api.vinculos().then(
        (vs) => setPodeTrocar(vs.length > 1),
        () => setPodeTrocar(false),
      );
    } catch (e) {
      if (e instanceof ErroPortal && e.status === 409 && e.codigo === 'escolher_vinculo') {
        try {
          const vinculos = await api.vinculos();
          setPodeTrocar(vinculos.length > 1);
          setFase({ fase: 'escolher', vinculos });
        } catch (e2) {
          setFase(faseDoErro(e2) ?? { fase: 'erro', mensagem: mensagemParaTela(e2, 'Algo falhou.') });
        }
        return;
      }
      setFase(faseDoErro(e) ?? { fase: 'erro', mensagem: mensagemParaTela(e, 'Algo falhou.') });
    }
  }, [api]);

  useEffect(() => {
    void abrir();
  }, [abrir]);

  const trocar = useCallback(async () => {
    if (!api) return;
    setFase({ fase: 'carregando' });
    try {
      setFase({ fase: 'escolher', vinculos: await api.vinculos() });
    } catch (e) {
      setFase(faseDoErro(e) ?? { fase: 'erro', mensagem: mensagemParaTela(e, 'Algo falhou.') });
    }
  }, [api]);

  const escolher = useCallback(
    async (vinculoId: string) => {
      if (!api) return;
      setFase({ fase: 'carregando' });
      try {
        const vinculo = await api.escolherVinculo(vinculoId);
        setVersao(0);
        setFase({ fase: 'pronto', vinculo });
      } catch (e) {
        setFase(faseDoErro(e) ?? { fase: 'erro', mensagem: mensagemParaTela(e, 'Algo falhou.') });
      }
    },
    [api],
  );

  const vinculo = fase.fase === 'pronto' ? fase.vinculo : null;
  const valor = useMemo(
    () => (api && vinculo ? { api, modo: 'modo' in criado ? criado.modo : 'fake', vinculo, podeTrocar, trocar: () => void trocar(), versao, atualizar } : null),
    [api, criado, vinculo, podeTrocar, trocar, versao, atualizar],
  );

  if (fase.fase !== 'pronto' || !valor) {
    return <>{telas(fase.fase === 'pronto' ? { fase: 'carregando' } : fase, { escolher: (id) => void escolher(id), tentarDeNovo: () => void abrir() })}</>;
  }
  // A chave do vínculo remonta as telas: nada do vínculo anterior sobra em estado.
  return (
    <Ctx.Provider key={valor.vinculo.vinculoId} value={valor as ContextoPortal}>
      {children}
    </Ctx.Provider>
  );
}

export interface AcoesDaFase {
  escolher: (vinculoId: string) => void;
  tentarDeNovo: () => void;
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

export function useConsultaPortal<T>(carregar: (api: ClientePortal) => Promise<T>): EstadoPortal<T> {
  const { api, versao } = usePortal();
  const [tentativa, setTentativa] = useState(0);
  const [estado, setEstado] = useState<EstadoPortal<T>>({ estado: 'carregando' });
  useEffect(() => {
    let vivo = true;
    // Volta a "carregando" ao tentar de novo: sem isto, o "Tentar de novo" depois de um erro deixava
    // a mensagem de erro na tela até a nova resposta chegar, e nada dizia que a tentativa começou.
    // (Cópia proposital da regra do lado da clínica: o portal não importa nada de lá — R-47a.)
    setEstado((e) => (e.estado === 'pronto' ? e : { estado: 'carregando' }));
    carregar(api)
      .then((dados) => vivo && setEstado({ estado: 'pronto', dados }))
      .catch((e: unknown) =>
        vivo &&
        setEstado({ estado: 'erro', mensagem: mensagemParaTela(e, 'Algo falhou.'), tentarDeNovo: () => setTentativa((t) => t + 1) }),
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
