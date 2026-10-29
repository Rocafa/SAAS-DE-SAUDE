'use client';

/**
 * Corrigir telefone e data de nascimento na ficha (PATCH /pacientes/:id, rodada 19+).
 * Reduzir a idade de quem tem 12 anos ou mais pede "Conferi o documento original" (C1-b′), e só o
 * administrador ou o profissional pode marcar (0053). A tela avisa antes; a API decide de qualquer forma.
 * Nada de log: os valores ficam só no estado do formulário.
 */
import { PencilLine, Save } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { useDados } from '@/components/app/dados';
import { textoDoErro, useAviso } from '@/components/app/desfazer';
import { Botao } from '@/components/ui/botao';
import { paraIsoLocal } from '@/lib/ajudante/datas';
import { formatarTelefone, validarTelefone } from '@/lib/agenda';
import { mudancaDeNascimentoExigeDocumento, podeConferirDocumento } from '@/lib/api/nascimento';
import type { AlteracaoPaciente, Paciente } from '@/lib/api/tipos';

const CAMPO = 'min-h-14 w-full rounded-md border-2 border-borda-forte bg-fundo px-4 text-lg';

export function CorrigirDados({ paciente }: { paciente: Paciente }) {
  const { api, usuario, atualizar } = useDados();
  const avisar = useAviso();
  const id = useId();
  const [aberto, setAberto] = useState(false);
  const [telefone, setTelefone] = useState(paciente.telefone);
  const [nascimento, setNascimento] = useState(paciente.nascimento);
  const [conferi, setConferi] = useState(false);
  const [erro, setErro] = useState('');
  const [enviando, setEnviando] = useState(false);

  const hoje = paraIsoLocal(new Date());
  const nascimentoMudou = nascimento !== paciente.nascimento;
  const exigeDocumento = nascimentoMudou && mudancaDeNascimentoExigeDocumento(paciente.nascimento || null, nascimento || null, hoje);
  const podeConferir = podeConferirDocumento(usuario?.papel ?? 'recepcao');

  function abrir() {
    setTelefone(paciente.telefone);
    setNascimento(paciente.nascimento);
    setConferi(false);
    setErro('');
    setAberto(true);
  }

  async function salvar(e: FormEvent) {
    e.preventDefault();
    const dados: AlteracaoPaciente = {};
    if (telefone !== paciente.telefone) {
      const et = validarTelefone(telefone);
      if (et) return setErro(et);
      dados.telefone = formatarTelefone(telefone);
    }
    if (nascimentoMudou) {
      if (nascimento && nascimento > hoje) return setErro('A data de nascimento está no futuro. Confira o ano.');
      if (exigeDocumento && !podeConferir) {
        return setErro('Essa mudança precisa do documento original conferido pelo administrador ou pelo profissional. Peça a um deles.');
      }
      if (exigeDocumento && !conferi) return setErro('Marque “Conferi o documento original” depois de ver o documento do paciente.');
      dados.nascimento = nascimento || null;
      if (exigeDocumento) dados.documentoConferido = true;
    }
    if (dados.telefone === undefined && dados.nascimento === undefined) return setErro('Nada mudou. Confira os dados e tente de novo.');
    setEnviando(true);
    setErro('');
    try {
      await api.alterarPaciente(paciente.id, dados);
      setAberto(false);
      atualizar();
      avisar({ texto: 'Dados do paciente corrigidos.' });
    } catch (err) {
      setErro(textoDoErro(err));
    } finally {
      setEnviando(false);
    }
  }

  if (!paciente.ativo) return null;
  if (!aberto) {
    return (
      <Botao variante="contorno" onClick={abrir} data-testid="corrigir-dados">
        <PencilLine aria-hidden />
        Corrigir telefone ou nascimento
      </Botao>
    );
  }
  return (
    <form onSubmit={salvar} noValidate aria-label="Corrigir dados do paciente" className="flex max-w-xl flex-col gap-4 rounded-md border-2 border-borda-forte p-4">
      {erro && (
        <p role="alert" className="rounded-md border-[3px] border-borda-forte p-3 font-bold">
          {erro}
        </p>
      )}
      <div className="flex flex-col gap-2">
        <label htmlFor={`${id}-tel`} className="text-lg font-bold">
          Telefone (com DDD)
        </label>
        <input id={`${id}-tel`} type="tel" inputMode="tel" value={telefone} onChange={(e) => setTelefone(e.target.value)} className={CAMPO} />
      </div>
      <div className="flex flex-col gap-2">
        <label htmlFor={`${id}-nasc`} className="text-lg font-bold">
          Data de nascimento
        </label>
        <input id={`${id}-nasc`} type="date" value={nascimento} max={hoje} onChange={(e) => setNascimento(e.target.value)} className={CAMPO} />
      </div>
      {exigeDocumento &&
        (podeConferir ? (
          <label className="flex items-start gap-3 text-lg">
            <input type="checkbox" checked={conferi} onChange={(e) => setConferi(e.target.checked)} className="mt-1 size-6" />
            <span>
              <strong>Conferi o documento original</strong> (RG, certidão ou outro documento oficial). A nova data deixa o paciente mais
              novo e muda o que ele e os responsáveis veem no portal.
            </span>
          </label>
        ) : (
          <p className="rounded-md border-2 border-dashed border-borda p-3">
            Essa mudança deixa o paciente mais novo e precisa do documento original conferido pelo administrador ou pelo profissional.
          </p>
        ))}
      <div className="flex flex-wrap gap-2">
        <Botao type="submit" disabled={enviando}>
          <Save aria-hidden />
          {enviando ? 'Salvando…' : 'Salvar correção'}
        </Botao>
        <Botao type="button" variante="suave" onClick={() => setAberto(false)}>
          Desistir
        </Botao>
      </div>
    </form>
  );
}
