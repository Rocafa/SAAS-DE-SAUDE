'use client';

/** Portal: meus dados. Mudanças viram pedido de correção para a clínica conferir. */
import { PenLine } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useConsulta, useDados } from '@/components/app/dados';
import { useAviso } from '@/components/app/desfazer';
import { Botao } from '@/components/ui/botao';
import { Carregando, Erro } from '@/components/ui/estados';
import { cpfMascarado } from '@/lib/ajudante/busca';
import { formatarDia } from '@/lib/ajudante/datas';
import { PACIENTE_PORTAL } from '@/lib/portal';

export default function PortalDados() {
  const { api } = useDados();
  const avisar = useAviso();
  const consulta = useConsulta((a) => a.obterPaciente(PACIENTE_PORTAL));
  const [corrigindo, setCorrigindo] = useState(false);
  const [texto, setTexto] = useState('');
  const [erro, setErro] = useState('');
  if (consulta.estado === 'carregando') return <Carregando />;
  if (consulta.estado === 'erro') return <Erro mensagem={consulta.mensagem} tentarDeNovo={consulta.tentarDeNovo} />;
  const p = consulta.dados;
  if (!p) return null;

  async function pedir(e: FormEvent) {
    e.preventDefault();
    try {
      const r = await api.abrirPedidoTitular(PACIENTE_PORTAL, 'corrigir', texto);
      setCorrigindo(false);
      setTexto('');
      setErro('');
      avisar({ texto: `Pedido enviado à clínica. Protocolo ${r.protocolo}. Resposta até ${formatarDia(r.prazo, new Date())}.` });
    } catch (err) {
      setErro(err instanceof Error ? err.message : 'Não deu para enviar.');
    }
  }

  const linhas: [string, string][] = [
    ['Nome', p.nomeSocial ?? p.nome],
    ...(p.nomeSocial ? ([['Nome de registro', p.nome]] as [string, string][]) : []),
    ['Telefone', p.telefone],
    ['CPF', cpfMascarado(p.cpf)],
  ];

  return (
    <>
      <h1 className="mb-1 text-[1.75rem] font-bold">Meus dados</h1>
      <p className="mb-6 text-texto-suave">O que a clínica tem guardado sobre você para o atendimento.</p>
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
          <label htmlFor="correcao" className="font-bold">
            O que está errado e como deve ficar?
          </label>
          <textarea id="correcao" rows={3} value={texto} onChange={(e) => setTexto(e.target.value)} className="rounded-md border-2 border-borda-forte bg-fundo p-3 text-lg" />
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
