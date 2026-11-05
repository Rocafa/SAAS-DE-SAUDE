'use client';

/**
 * Cadastro de paciente: só nome e telefone são obrigatórios. Menor de idade pede responsável.
 * Cada erro diz o que fazer.
 */
import { UserPlus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useDados } from '@/components/app/dados';
import { textoDoErro, useAviso } from '@/components/app/desfazer';
import { Titulo } from '@/components/app/estrutura';
import { Botao } from '@/components/ui/botao';
import { paraIsoLocal } from '@/lib/ajudante/datas';
import { formatarCpf, formatarTelefone, idade, validarCpf, validarNome, validarTelefone } from '@/lib/agenda';

const CAMPO =
  'min-h-14 w-full rounded-md border-2 border-borda-forte bg-fundo px-4 text-lg aria-[invalid=true]:border-[3px] aria-[invalid=true]:border-dashed';

type Campo = 'nome' | 'telefone' | 'cpf' | 'nascimento' | 'respNome' | 'respTelefone';

export default function PaginaNovoPaciente() {
  const router = useRouter();
  const { api, atualizar } = useDados();
  const avisar = useAviso();
  const [v, setV] = useState<Record<Campo | 'nomeSocial' | 'respParentesco', string>>({
    nome: '',
    nomeSocial: '',
    telefone: '',
    cpf: '',
    nascimento: '',
    respNome: '',
    respParentesco: 'Mãe',
    respTelefone: '',
  });
  const [erros, setErros] = useState<Partial<Record<Campo, string>>>({});
  const [enviando, setEnviando] = useState(false);
  const [erroGeral, setErroGeral] = useState('');
  const menor = v.nascimento ? idade(v.nascimento, new Date()) < 18 : false;
  const mudar = (c: keyof typeof v) => (e: { target: { value: string } }) => setV((x) => ({ ...x, [c]: e.target.value }));

  async function enviar(e: FormEvent) {
    e.preventDefault();
    const n: Partial<Record<Campo, string>> = {};
    const en = validarNome(v.nome);
    if (en) n.nome = en;
    const et = validarTelefone(v.telefone);
    if (et) n.telefone = et;
    const ec = validarCpf(v.cpf);
    if (ec) n.cpf = ec;
    if (v.nascimento && v.nascimento > paraIsoLocal(new Date())) n.nascimento = 'A data de nascimento está no futuro. Confira o ano.';
    if (menor) {
      if (!v.respNome.trim()) n.respNome = 'Paciente menor de idade: falta o nome do responsável.';
      const er = validarTelefone(v.respTelefone);
      if (er) n.respTelefone = er;
    }
    setErros(n);
    const primeiro = Object.keys(n)[0];
    if (primeiro) {
      document.getElementById(`campo-${primeiro}`)?.focus();
      return;
    }
    setEnviando(true);
    setErroGeral('');
    let p: Awaited<ReturnType<typeof api.criarPaciente>>;
    try {
      p = await api.criarPaciente({
        nome: v.nome,
        nomeSocial: v.nomeSocial,
        telefone: formatarTelefone(v.telefone),
        cpf: formatarCpf(v.cpf),
        nascimento: v.nascimento,
        ...(menor ? { responsavel: { nome: v.respNome.trim(), parentesco: v.respParentesco, telefone: formatarTelefone(v.respTelefone) } } : {}),
      });
    } catch (err) {
      // A API recusou (perfil, assinatura, limite…): mensagem pronta do adaptador, sem dado pessoal.
      setErroGeral(textoDoErro(err));
      setEnviando(false);
      return;
    }
    atualizar();
    avisar({
      texto: `${p.nomeSocial ?? p.nome} cadastrado.`,
      desfazer: async () => {
        await api.removerPaciente(p.id);
        atualizar();
        router.push('/pacientes');
      },
    });
    router.push(`/pacientes/${p.id}`);
  }

  const campo = (c: Campo, rotulo: string, extra: Record<string, unknown> = {}, dica?: string) => (
    <div className="flex flex-col gap-2">
      <label htmlFor={`campo-${c}`} className="text-lg font-bold">
        {rotulo}
      </label>
      {dica && <p className="text-texto-suave" id={`dica-${c}`}>{dica}</p>}
      <input
        id={`campo-${c}`}
        value={v[c]}
        onChange={mudar(c)}
        aria-invalid={!!erros[c]}
        aria-describedby={[dica ? `dica-${c}` : '', erros[c] ? `erro-${c}` : ''].filter(Boolean).join(' ') || undefined}
        className={CAMPO}
        {...extra}
      />
      {erros[c] && (
        <p id={`erro-${c}`} className="font-bold">
          ⚠ {erros[c]}
        </p>
      )}
    </div>
  );

  return (
    <>
      <Titulo descricao="Só o nome e o telefone são obrigatórios. O resto dá para completar depois.">Cadastrar paciente</Titulo>
      <form onSubmit={enviar} noValidate className="flex max-w-xl flex-col gap-6">
        {erroGeral && (
          <p role="alert" className="rounded-md border-[3px] border-borda-forte p-3 font-bold">
            {erroGeral}
          </p>
        )}
        {campo('nome', 'Nome completo (de registro)', { autoComplete: 'off' })}
        <div className="flex flex-col gap-2">
          <label htmlFor="campo-nomeSocial" className="text-lg font-bold">
            Nome social (opcional)
          </label>
          <p className="text-texto-suave" id="dica-social">
            Se a pessoa usa outro nome, escreva aqui. É ele que aparece no sistema.
          </p>
          <input id="campo-nomeSocial" value={v.nomeSocial} onChange={mudar('nomeSocial')} aria-describedby="dica-social" className={CAMPO} />
        </div>
        {campo('telefone', 'Telefone (com DDD)', { type: 'tel', inputMode: 'tel', placeholder: '(11) 91234-5678' })}
        {campo('nascimento', 'Data de nascimento (opcional)', { type: 'date' })}
        {campo('cpf', 'CPF (opcional)', { inputMode: 'numeric', autoComplete: 'off' }, 'Só se precisar para recibo ou convênio.')}

        {menor && (
          <fieldset className="flex flex-col gap-4 rounded-md border-2 border-borda-forte p-4">
            <legend className="px-2 text-lg font-bold">Responsável (paciente menor de idade)</legend>
            {campo('respNome', 'Nome do responsável')}
            <div className="flex flex-col gap-2">
              <label htmlFor="campo-respParentesco" className="font-bold">
                Parentesco
              </label>
              <select id="campo-respParentesco" value={v.respParentesco} onChange={mudar('respParentesco')} className={CAMPO}>
                {['Mãe', 'Pai', 'Avó', 'Avô', 'Tutor legal', 'Outro'].map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </div>
            {campo('respTelefone', 'Telefone do responsável', { type: 'tel', inputMode: 'tel' })}
          </fieldset>
        )}

        <Botao type="submit" tamanho="grande" disabled={enviando} data-testid="salvar-paciente">
          <UserPlus aria-hidden />
          {enviando ? 'Salvando…' : 'Cadastrar paciente'}
        </Botao>
      </form>
    </>
  );
}
