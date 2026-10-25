'use client';

/**
 * Resgate do convite do paciente (P4 do parecer de 24/10; §10h):
 * 1. o token chega no `#fragmento` do link (nunca na query: o servidor recusa com 400 e a query vai para
 *    log/Referer). É lido de `location.hash` e APAGADO na hora com `history.replaceState`; fica só na
 *    memória deste componente. A página manda `Referrer-Policy: no-referrer`;
 * 2. `POST /portal/convites/resgate {token}` → o código vai ao telefone DO CADASTRO (quem resgata não
 *    informa destino); a tela mostra só o destino mascarado;
 * 3. `POST /portal/convites/resgate/confirmar {token, codigo}` → vínculo criado e escolhido na sessão.
 * Qualquer falha do convite mostra a MESMA mensagem. O resgate exige a sessão do portal (entrar → resgatar).
 * Nada daqui vai para log, console, analytics ou armazenamento do navegador.
 */
import { KeyRound, MessageSquare } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { Botao } from '@/components/ui/botao';
import { ErroPortal, mensagemDoErro, type ClientePortal } from '@/lib/api/portal';
import { CODIGO_CONVITE_DEMONSTRACAO, TOKEN_CONVITE_DEMONSTRACAO } from '@/lib/api/portal-fake';
import { criarClientePortal, lerConfigPortal, type ModoPortal } from '@/lib/api/portal-selecionar';

const CAMPO = 'min-h-14 w-full rounded-md border-2 border-borda-forte bg-fundo px-4 text-lg';
const FALHA_DO_CONVITE = mensagemDoErro(409, 'convite_invalido');

/** Tira o token do fragmento (`#<token>` ou `#convite=<token>`). Nunca olha a query. */
export function tokenDoFragmento(hash: string): string {
  const bruto = hash.replace(/^#/, '');
  const valor = bruto.startsWith('convite=') ? bruto.slice('convite='.length) : bruto;
  try {
    return decodeURIComponent(valor).trim();
  } catch {
    return '';
  }
}

/** Mensagem da tela: falha do convite é sempre a mesma; só sessão e limite têm texto próprio. */
export function mensagemDoResgate(e: unknown): { texto: string; entrar: boolean } {
  if (e instanceof ErroPortal && e.status === 401) return { texto: 'Para usar o convite, entre primeiro no portal.', entrar: true };
  if (e instanceof ErroPortal && e.status === 429) return { texto: mensagemDoErro(429), entrar: false };
  return { texto: FALHA_DO_CONVITE, entrar: false };
}

export function ResgateDoConvite() {
  const router = useRouter();
  const [cliente] = useState<{ api: ClientePortal; modo: ModoPortal } | null>(() => {
    try {
      const config = lerConfigPortal();
      return { api: criarClientePortal(config), modo: config.modo };
    } catch {
      return null;
    }
  });
  const [token, setToken] = useState('');
  const [etapa, setEtapa] = useState<'token' | 'codigo'>('token');
  const [destino, setDestino] = useState('');
  const [codigo, setCodigo] = useState('');
  const [erro, setErro] = useState<{ texto: string; entrar: boolean } | null>(null);
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    const doLink = tokenDoFragmento(window.location.hash);
    // Apaga o token da barra de endereço e do histórico antes de qualquer outra coisa.
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
    if (doLink) setToken(doLink);
  }, []);

  async function resgatar(e: FormEvent) {
    e.preventDefault();
    if (!cliente || !token.trim()) return setErro({ texto: 'Digite o código do convite que a clínica mandou.', entrar: false });
    setEnviando(true);
    try {
      const desafio = await cliente.api.resgatarConvite(token.trim());
      setDestino(desafio.destino);
      setErro(null);
      setEtapa('codigo');
    } catch (err) {
      setErro(mensagemDoResgate(err));
    } finally {
      setEnviando(false);
    }
  }

  async function confirmar(e: FormEvent) {
    e.preventDefault();
    if (!cliente) return;
    if (!/^\d{6}$/.test(codigo.replace(/\s/g, ''))) return setErro({ texto: 'O código tem 6 números.', entrar: false });
    setEnviando(true);
    try {
      await cliente.api.confirmarConvite(token.trim(), codigo.replace(/\s/g, ''));
      setToken('');
      router.push('/portal');
    } catch (err) {
      setErro(mensagemDoResgate(err));
    } finally {
      setEnviando(false);
    }
  }

  const aviso = erro && (
    <div role="alert" className="flex flex-col gap-2 font-bold">
      <p>⚠ {erro.texto}</p>
      {erro.entrar && (
        <Link href="/portal/entrar" className="underline">
          Entrar no portal
        </Link>
      )}
    </div>
  );

  if (!cliente) return <p role="alert">O portal não está disponível agora.</p>;

  return etapa === 'token' ? (
    <form onSubmit={resgatar} noValidate className="flex flex-col gap-4">
      <h1 className="text-[1.75rem] font-bold">Convite do portal</h1>
      <p>A clínica mandou um convite para você acessar o portal. Vamos mandar um código para o celular que está no cadastro.</p>
      {cliente.modo === 'fake' && <p className="text-texto-suave">Demonstração: o código do convite é “{TOKEN_CONVITE_DEMONSTRACAO}”.</p>}
      <label htmlFor="convite-token" className="font-bold">
        Código do convite
      </label>
      <input
        id="convite-token"
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={token}
        onChange={(e) => setToken(e.target.value)}
        className={CAMPO}
      />
      {token && <p className="text-texto-suave">O código do link já foi preenchido.</p>}
      {aviso}
      <Botao type="submit" tamanho="grande" disabled={enviando}>
        <MessageSquare aria-hidden />
        Mandar código para o celular
      </Botao>
    </form>
  ) : (
    <form onSubmit={confirmar} noValidate className="flex flex-col gap-4">
      <h1 className="text-[1.75rem] font-bold">Digite o código</h1>
      <p>Mandamos 6 números para {destino}.</p>
      {cliente.modo === 'fake' && <p className="text-texto-suave">Demonstração: o código é {CODIGO_CONVITE_DEMONSTRACAO}.</p>}
      <label htmlFor="convite-codigo" className="font-bold">
        Código
      </label>
      <input
        id="convite-codigo"
        inputMode="numeric"
        autoComplete="one-time-code"
        value={codigo}
        onChange={(e) => setCodigo(e.target.value)}
        className={CAMPO}
      />
      {aviso}
      <Botao type="submit" tamanho="grande" disabled={enviando}>
        <KeyRound aria-hidden />
        Confirmar
      </Botao>
    </form>
  );
}
