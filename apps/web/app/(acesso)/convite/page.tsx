'use client';

/** Primeiro acesso por convite: nome, senha (regras visíveis antes de errar) e autenticador (MFA). */
import { Check, KeyRound, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Botao } from '@/components/ui/botao';
import { REGRAS_SENHA, errosSenha, validarCodigo } from '@/lib/conta';
import { CAMPO } from '@/components/ui/formulario';


export default function PaginaConvite() {
  const router = useRouter();
  const [etapa, setEtapa] = useState<'senha' | 'mfa'>('senha');
  const [nome, setNome] = useState('');
  const [senha, setSenha] = useState('');
  const [conf, setConf] = useState('');
  const [codigo, setCodigo] = useState('');
  const [erros, setErros] = useState<string[]>([]);

  function criar(e: FormEvent) {
    e.preventDefault();
    const es = [...(nome.trim() ? [] : ['Falta o seu nome.']), ...errosSenha(senha, conf)];
    setErros(es);
    if (!es.length) setEtapa('mfa');
  }
  function ativar(e: FormEvent) {
    e.preventDefault();
    const ec = validarCodigo(codigo);
    if (ec) return setErros([ec]);
    if (codigo.trim() !== '123456') return setErros(['Código não confere. Digite o que aparece agora no aplicativo.']);
    router.push('/primeiros-passos');
  }

  return etapa === 'senha' ? (
    <form onSubmit={criar} noValidate className="flex flex-col gap-4">
      <h1 className="text-[1.75rem] font-bold">Bem-vindo à Clínica Demonstração</h1>
      <p>Você foi convidado. Falta só criar sua senha.</p>
      <label htmlFor="c-nome" className="font-bold">
        Seu nome
      </label>
      <input id="c-nome" autoComplete="name" value={nome} onChange={(e) => setNome(e.target.value)} className={CAMPO} />
      <label htmlFor="c-senha" className="font-bold">
        Crie uma senha
      </label>
      <input id="c-senha" type="password" autoComplete="new-password" aria-describedby="regras" value={senha} onChange={(e) => setSenha(e.target.value)} className={CAMPO} />
      <ul id="regras" className="flex flex-col gap-1">
        {REGRAS_SENHA.map((r) => {
          const ok = r.ok(senha);
          return (
            <li key={r.id} className={`flex items-center gap-2 ${ok ? 'font-bold' : ''}`}>
              {ok ? <Check aria-hidden className="size-5" /> : <X aria-hidden className="size-5" />}
              {r.texto}
              <span className="sr-only">{ok ? ' (feito)' : ' (falta)'}</span>
            </li>
          );
        })}
      </ul>
      <label htmlFor="c-conf" className="font-bold">
        Digite a senha de novo
      </label>
      <input id="c-conf" type="password" autoComplete="new-password" value={conf} onChange={(e) => setConf(e.target.value)} className={CAMPO} />
      {erros.length > 0 && (
        <div role="alert" className="font-bold">
          <ul>
            {erros.map((x) => (
              <li key={x}>⚠ {x}</li>
            ))}
          </ul>
        </div>
      )}
      <Botao type="submit" tamanho="grande">
        Criar senha
      </Botao>
    </form>
  ) : (
    <form onSubmit={ativar} noValidate className="flex flex-col gap-4">
      <h1 className="text-[1.75rem] font-bold">Proteja sua conta</h1>
      <ol className="list-decimal pl-6">
        <li>Instale um aplicativo autenticador no celular (ex.: o do Google ou da Microsoft).</li>
        <li>No aplicativo, escolha “adicionar conta” e aponte a câmera para o código da tela (aqui, na demonstração, não precisa).</li>
        <li>Digite o código de 6 números que aparece.</li>
      </ol>
      <label htmlFor="c-codigo" className="font-bold">
        Código
      </label>
      <input id="c-codigo" inputMode="numeric" autoComplete="one-time-code" value={codigo} onChange={(e) => setCodigo(e.target.value)} className={CAMPO} />
      {erros.length > 0 && <p role="alert" className="font-bold">⚠ {erros[0]}</p>}
      <Botao type="submit" tamanho="grande">
        <KeyRound aria-hidden />
        Ativar e entrar
      </Botao>
    </form>
  );
}
