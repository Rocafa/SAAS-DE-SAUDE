'use client';

import { Mail } from 'lucide-react';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Botao } from '@/components/ui/botao';
import { validarEmail } from '@/lib/conta';

export default function PaginaEsqueciSenha() {
  const [email, setEmail] = useState('');
  const [erro, setErro] = useState('');
  const [enviado, setEnviado] = useState(false);
  function enviar(e: FormEvent) {
    e.preventDefault();
    const ee = validarEmail(email);
    if (ee) return setErro(ee);
    setErro('');
    setEnviado(true);
  }
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-[1.75rem] font-bold">Esqueci a senha</h1>
      {enviado ? (
        // Mesma resposta exista ou não o e-mail: não revela quem tem conta.
        <p role="status" className="rounded-md border-2 border-borda-forte p-3">
          Se esse e-mail estiver cadastrado, chega um link em alguns minutos. Ele vale 30 minutos. Confira também o lixo eletrônico.
        </p>
      ) : (
        <form onSubmit={enviar} noValidate className="flex flex-col gap-4">
          <label htmlFor="s-email" className="font-bold">
            Seu e-mail
          </label>
          <input id="s-email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} className="min-h-14 w-full rounded-md border-2 border-borda-forte bg-fundo px-4 text-lg" />
          {erro && <p role="alert" className="font-bold">⚠ {erro}</p>}
          <Botao type="submit" tamanho="grande">
            <Mail aria-hidden />
            Mandar link para criar nova senha
          </Botao>
        </form>
      )}
      <Link href="/entrar" className="flex min-h-12 items-center">
        Voltar para entrar
      </Link>
    </div>
  );
}
