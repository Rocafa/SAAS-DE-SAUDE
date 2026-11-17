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
import { MENSAGEM_GENERICA, mensagemParaTela, type ClientePortal } from '@/lib/api/portal';
import { CODIGO_CONVITE_DEMONSTRACAO, TOKEN_CONVITE_DEMONSTRACAO } from '@/lib/api/portal-fake';
import { criarClientePortal, lerConfigPortal, type ModoPortal } from '@/lib/api/portal-selecionar';
import { codigoDoOtp, mensagemDoResgate, tirarTokenDaBarra } from '@/lib/portal-convite';
import { CAMPO } from '@/components/ui/formulario';


export function ResgateDoConvite() {
  const router = useRouter();
  const [criado] = useState<{ api: ClientePortal; modo: ModoPortal } | { erro: string }>(() => {
    try {
      const config = lerConfigPortal();
      return { api: criarClientePortal(config), modo: config.modo };
    } catch (e) {
      // R3 (#75): detalhe de configuração só em desenvolvimento; fora dele, frase genérica.
      return { erro: mensagemParaTela(e) };
    }
  });
  const cliente = 'api' in criado ? criado : null;
  const [token, setToken] = useState('');
  const [etapa, setEtapa] = useState<'token' | 'codigo'>('token');
  const [destino, setDestino] = useState('');
  const [codigo, setCodigo] = useState('');
  const [erro, setErro] = useState<{ texto: string; entrar: boolean } | null>(null);
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    // Apaga o token da barra de endereço e do histórico antes de qualquer outra coisa.
    const doLink = tirarTokenDaBarra(window.location, window.history);
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
    const otp = codigoDoOtp(codigo);
    if (!otp) return setErro({ texto: 'O código tem 6 números.', entrar: false });
    setEnviando(true);
    try {
      await cliente.api.confirmarConvite(token.trim(), otp);
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

  if (!cliente) return <p role="alert">{'erro' in criado ? criado.erro : MENSAGEM_GENERICA}</p>;

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
