'use client';

/**
 * Portal: dados do cadastro. Nada se edita aqui: toda mudança (inclusive a data de nascimento) vira pedido
 * de correção para a clínica conferir (`POST /portal/meus-dados/correcao`; P7/C1). O responsável legal vê
 * "Dados de <primeiro nome>", nunca "seus dados": o cadastro é do paciente.
 */
import { PenLine } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useAviso } from '@/components/app/desfazer';
import { useConsultaPortal, usePortal } from '@/components/portal/dados-portal';
import { Botao } from '@/components/ui/botao';
import { Carregando, Erro } from '@/components/ui/estados';
import { paraIsoLocal } from '@/lib/ajudante/datas';
import { mensagemParaTela } from '@/lib/api/portal';
import { dataBr, prazoBr, tituloDosDados, validarCorrecao } from '@/lib/portal';

const CAMPO = 'rounded-md border-2 border-borda-forte bg-fundo p-3 text-lg';

export default function PortalDados() {
  const { api, vinculo } = usePortal();
  const avisar = useAviso();
  const consulta = useConsultaPortal((a) => a.meusDados());
  const [corrigindo, setCorrigindo] = useState(false);
  const [texto, setTexto] = useState('');
  const [nascimento, setNascimento] = useState('');
  const [erro, setErro] = useState('');
  if (consulta.estado === 'carregando') return <Carregando />;
  if (consulta.estado === 'erro') return <Erro mensagem={consulta.mensagem} tentarDeNovo={consulta.tentarDeNovo} />;
  const d = consulta.dados;
  const doPaciente = d.rotulo === 'dados_do_paciente';

  async function pedir(e: FormEvent) {
    e.preventDefault();
    const hoje = paraIsoLocal(new Date());
    const invalido = validarCorrecao(texto, nascimento || undefined, hoje);
    if (invalido) return setErro(invalido);
    try {
      const r = await api.pedirCorrecao(nascimento ? { detalhe: texto.trim(), nascimento } : { detalhe: texto.trim() });
      setCorrigindo(false);
      setTexto('');
      setNascimento('');
      setErro('');
      avisar({ texto: `Pedido enviado à clínica. Protocolo ${r.protocolo}. Resposta até ${prazoBr(r.prazo)}.` });
    } catch (err) {
      setErro(mensagemParaTela(err, 'Não deu para enviar.'));
    }
  }

  const naoInformado = 'Não informado';
  const linhas: [string, string][] = [
    ['Nome', d.nomeSocial ?? d.nome],
    ...(d.nomeSocial ? ([['Nome de registro', d.nome]] as [string, string][]) : []),
    ['Data de nascimento', d.nascimento ? dataBr(d.nascimento) : naoInformado],
    ['Telefone', d.telefone ?? naoInformado],
    ['CPF', d.cpfMascarado ?? naoInformado],
  ];

  return (
    <>
      <h1 className="mb-1 text-[1.75rem] font-bold">{tituloDosDados(d.rotulo, vinculo.primeiroNome)}</h1>
      <p className="mb-6 text-texto-suave">
        {doPaciente
          ? `Dados do paciente: o que a clínica tem guardado sobre ${vinculo.primeiroNome} para o atendimento.`
          : 'O que a clínica tem guardado sobre você para o atendimento.'}
      </p>
      <dl className="mb-6 flex flex-col gap-3">
        {linhas.map(([t, v]) => (
          <div key={t} className="rounded-md border-2 border-borda p-3">
            <dt className="text-[0.95rem] font-bold text-texto-suave">{t}</dt>
            <dd className="text-lg">{v}</dd>
          </div>
        ))}
      </dl>
      {corrigindo ? (
        <form onSubmit={pedir} noValidate className="flex flex-col gap-3">
          <p>A clínica confere o pedido antes de mudar o cadastro. Para mudar a data de nascimento, ela pode pedir um documento.</p>
          <label htmlFor="correcao" className="font-bold">
            O que está errado e como deve ficar?
          </label>
          <textarea id="correcao" rows={3} value={texto} onChange={(e) => setTexto(e.target.value)} className={CAMPO} />
          <label htmlFor="correcao-nascimento" className="font-bold">
            Data de nascimento certa (só se estiver errada)
          </label>
          <input id="correcao-nascimento" type="date" min="1900-01-01" value={nascimento} onChange={(e) => setNascimento(e.target.value)} className={CAMPO} />
          {erro && <p role="alert" className="font-bold">⚠ {erro}</p>}
          <div className="flex flex-wrap gap-2">
            <Botao type="submit">Enviar pedido de correção</Botao>
            <Botao variante="suave" onClick={() => setCorrigindo(false)}>
              Voltar
            </Botao>
          </div>
        </form>
      ) : (
        <Botao variante="contorno" tamanho="grande" onClick={() => setCorrigindo(true)}>
          <PenLine aria-hidden />
          Corrigir um dado
        </Botao>
      )}
    </>
  );
}
