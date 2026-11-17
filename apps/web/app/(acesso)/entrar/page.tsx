'use client';

import { KeyRound, LogIn } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Botao } from '@/components/ui/botao';
import { validarCodigo, validarEmail } from '@/lib/conta';
import { CAMPO } from '@/components/ui/formulario';


export default function PaginaEntrar() {
  const router = useRouter();
  const [etapa, setEtapa] = useState<'senha' | 'codigo'>('senha');
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [codigo, setCodigo] = useState('');
  const [erro, setErro] = useState('');

  function entrar(e: FormEvent) {
    e.preventDefault();
    const ee = validarEmail(email);
    if (ee) return setErro(ee);
    if (!senha) return setErro('Falta a senha.');
    setErro('');
    setEtapa('codigo');
  }
  function confirmar(e: FormEvent) {
    e.preventDefault();
    const ec = validarCodigo(codigo);
    if (ec) return setErro(ec);
    if (codigo.replace(/\s/g, '') !== '123456') return setErro('Código não confere. Ele muda a cada 30 segundos: digite o que aparece agora.');
    router.push('/escolher-clinica');
  }

  return etapa === 'senha' ? (
    <form onSubmit={entrar} noValidate className="flex flex-col gap-4">
      <h1 className="text-[1.75rem] font-bold">Entrar</h1>
      <label htmlFor="e-email" className="font-bold">
        E-mail
      </label>
      <input id="e-email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} className={CAMPO} />
      <label htmlFor="e-senha" className="font-bold">
        Senha
      </label>
      <input id="e-senha" type="password" autoComplete="current-password" value={senha} onChange={(e) => setSenha(e.target.value)} className={CAMPO} />
      {erro && <p role="alert" className="font-bold">⚠ {erro}</p>}
      <Botao type="submit" tamanho="grande">
        <LogIn aria-hidden />
        Entrar
      </Botao>
      <Link href="/esqueci-senha" className="flex min-h-12 items-center">
        Esqueci a senha
      </Link>
      <p className="text-texto-suave">Primeiro acesso? Use o link do convite que chegou no seu e-mail.</p>
    </form>
  ) : (
    <form onSubmit={confirmar} noValidate className="flex flex-col gap-4">
      <h1 className="text-[1.75rem] font-bold">Confirme que é você</h1>
      <p>Abra o aplicativo autenticador no seu celular e digite o código de 6 números.</p>
      <label htmlFor="e-codigo" className="font-bold">
        Código
      </label>
      <input id="e-codigo" inputMode="numeric" autoComplete="one-time-code" value={codigo} onChange={(e) => setCodigo(e.target.value)} className={CAMPO} />
      {erro && <p role="alert" className="font-bold">⚠ {erro}</p>}
      <Botao type="submit" tamanho="grande">
        <KeyRound aria-hidden />
        Confirmar
      </Botao>
      <Botao variante="suave" onClick={() => setEtapa('senha')}>
        Voltar
      </Botao>
    </form>
  );
}
