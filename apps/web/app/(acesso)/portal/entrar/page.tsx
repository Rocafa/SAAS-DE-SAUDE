'use client';

/** Entrada do paciente no portal: celular e código por mensagem (aguarda D4; código 123456). */
import { MessageSquare } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Botao } from '@/components/ui/botao';
import { validarTelefone } from '@/lib/agenda';
import { validarCodigo } from '@/lib/conta';
import { CAMPO } from '@/components/ui/formulario';


export default function PortalEntrar() {
  const router = useRouter();
  const [etapa, setEtapa] = useState<'celular' | 'codigo'>('celular');
  const [cel, setCel] = useState('');
  const [codigo, setCodigo] = useState('');
  const [erro, setErro] = useState('');
  function enviar(e: FormEvent) {
    e.preventDefault();
    const et = validarTelefone(cel);
    if (et) return setErro(et);
    setErro('');
    setEtapa('codigo');
  }
  function entrar(e: FormEvent) {
    e.preventDefault();
    const ec = validarCodigo(codigo);
    if (ec) return setErro(ec.replace('no aplicativo autenticador do seu celular', 'na mensagem que mandamos'));
    if (codigo.trim() !== '123456') return setErro('Código não confere. Confira a última mensagem que chegou.');
    router.push('/portal');
  }
  return etapa === 'celular' ? (
    <form onSubmit={enviar} noValidate className="flex flex-col gap-4">
      <h1 className="text-[1.75rem] font-bold">Portal do paciente</h1>
      <p>Veja suas consultas, documentos e seus direitos. Mandamos um código para o seu celular.</p>
      <label htmlFor="p-cel" className="font-bold">
        Seu celular com DDD
      </label>
      <input id="p-cel" type="tel" inputMode="tel" autoComplete="tel" value={cel} onChange={(e) => setCel(e.target.value)} className={CAMPO} />
      {erro && <p role="alert" className="font-bold">⚠ {erro}</p>}
      <Botao type="submit" tamanho="grande">
        <MessageSquare aria-hidden />
        Mandar código
      </Botao>
    </form>
  ) : (
    <form onSubmit={entrar} noValidate className="flex flex-col gap-4">
      <h1 className="text-[1.75rem] font-bold">Digite o código</h1>
      <p>Mandamos 6 números para o seu celular. Ele vale 10 minutos.</p>
      <label htmlFor="p-cod" className="font-bold">
        Código
      </label>
      <input id="p-cod" inputMode="numeric" autoComplete="one-time-code" value={codigo} onChange={(e) => setCodigo(e.target.value)} className={CAMPO} />
      {erro && <p role="alert" className="font-bold">⚠ {erro}</p>}
      <Botao type="submit" tamanho="grande">
        Entrar
      </Botao>
      <Botao variante="suave" onClick={() => setEtapa('celular')}>
        Mudar o número
      </Botao>
    </form>
  );
}
