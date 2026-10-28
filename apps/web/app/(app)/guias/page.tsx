'use client';

/** Guias de convênio: controle simples (M1, sem XML TISS). Avisa vencimento e sessões acabando. */
import { AlertTriangle, ClipboardList, Plus } from 'lucide-react';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { useConsulta, useDados } from '@/components/app/dados';
import { useAviso } from '@/components/app/desfazer';
import { Titulo } from '@/components/app/estrutura';
import { Botao } from '@/components/ui/botao';
import { Carregando, Erro, Vazio } from '@/components/ui/estados';
import { formatarDia, paraIsoLocal } from '@/lib/ajudante/datas';
import { nomeExibido } from '@/lib/api/tipos';
import { alertasGuia } from '@/lib/financeiro';

const CAMPO = 'min-h-14 w-full rounded-md border-2 border-borda-forte bg-fundo px-4 text-lg';

export default function PaginaGuias() {
  const { api, atualizar, pacientes } = useDados();
  const avisar = useAviso();
  const consulta = useConsulta((a) => a.listarGuias());
  const [aberto, setAberto] = useState(false);
  const [f, setF] = useState({ pacienteId: '', convenio: '', numero: '', sessoes: '10', validade: '' });
  const [erro, setErro] = useState('');
  const porId = new Map(pacientes.map((p) => [p.id, p]));
  const ativos = [...pacientes].filter((p) => p.ativo).sort((a, b) => nomeExibido(a).localeCompare(nomeExibido(b)));

  async function salvar(e: FormEvent) {
    e.preventDefault();
    if (!f.validade) return setErro('Falta a validade. Ela está no papel da guia.');
    if (f.validade < paraIsoLocal(new Date())) return setErro('Essa validade já passou. Confira a data na guia.');
    try {
      const g = await api.criarGuia({ pacienteId: f.pacienteId, convenio: f.convenio, numero: f.numero, sessoesAutorizadas: Number(f.sessoes), validade: f.validade });
      setErro('');
      setAberto(false);
      setF({ pacienteId: '', convenio: '', numero: '', sessoes: '10', validade: '' });
      atualizar();
      avisar({
        texto: 'Guia cadastrada.',
        desfazer: async () => {
          await api.removerGuia(g.id);
          atualizar();
        },
      });
    } catch (err) {
      setErro(err instanceof Error ? err.message : 'Não deu para salvar.');
    }
  }

  const campo = (id: keyof typeof f, rotulo: string, extra: Record<string, unknown> = {}) => (
    <div className="flex flex-col gap-2">
      <label htmlFor={`guia-${id}`} className="font-bold">
        {rotulo}
      </label>
      <input id={`guia-${id}`} value={f[id]} onChange={(e) => setF((x) => ({ ...x, [id]: e.target.value }))} className={CAMPO} {...extra} />
    </div>
  );

  return (
    <>
      <Titulo descricao="Autorizações do convênio: quantas sessões e até quando. O envio eletrônico (TISS) entra na Fase 2.">Guias de convênio</Titulo>
      {!aberto ? (
        <Botao tamanho="grande" onClick={() => setAberto(true)} className="mb-6">
          <Plus aria-hidden />
          Cadastrar guia
        </Botao>
      ) : (
        <form onSubmit={salvar} noValidate className="mb-8 grid max-w-2xl gap-4 rounded-md border-2 border-borda-forte p-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2 sm:col-span-2">
            <label htmlFor="guia-paciente" className="font-bold">
              Paciente
            </label>
            <select id="guia-paciente" value={f.pacienteId} onChange={(e) => setF((x) => ({ ...x, pacienteId: e.target.value }))} className={CAMPO}>
              <option value="">Escolha o paciente</option>
              {ativos.map((p) => (
                <option key={p.id} value={p.id}>
                  {nomeExibido(p)}
                </option>
              ))}
            </select>
          </div>
          {campo('convenio', 'Convênio')}
          {campo('numero', 'Número da guia', { inputMode: 'numeric' })}
          {campo('sessoes', 'Sessões autorizadas', { type: 'number', inputMode: 'numeric', min: 1 })}
          {campo('validade', 'Válida até', { type: 'date' })}
          {erro && (
            <p role="alert" className="font-bold sm:col-span-2">
              ⚠ {erro}
            </p>
          )}
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <Botao type="submit">Salvar guia</Botao>
            <Botao variante="suave" onClick={() => setAberto(false)}>
              Cancelar
            </Botao>
          </div>
        </form>
      )}

      {consulta.estado === 'carregando' && <Carregando />}
      {consulta.estado === 'erro' && <Erro mensagem={consulta.mensagem} tentarDeNovo={consulta.tentarDeNovo} />}
      {consulta.estado === 'pronto' &&
        (consulta.dados.length === 0 ? (
          <Vazio titulo="Nenhuma guia cadastrada" oQueFazer="Cadastre a guia quando o paciente trouxer a autorização do convênio." />
        ) : (
          <ul className="flex flex-col gap-2">
            {consulta.dados.map((g) => {
              const p = porId.get(g.pacienteId);
              const alertas = alertasGuia(g, new Date());
              return (
                <li key={g.id} className={`flex flex-col gap-2 rounded-md p-3 ${alertas.length ? 'border-[3px] border-borda-forte' : 'border-2 border-borda'}`}>
                  <div className="flex flex-wrap items-center gap-3">
                    <ClipboardList aria-hidden className="size-6" />
                    <Link href={`/pacientes/${g.pacienteId}`} className="text-lg font-bold">
                      {p ? nomeExibido(p) : 'Paciente'}
                    </Link>
                    <span className="text-texto-suave">
                      {g.convenio} · guia nº {g.numero}
                    </span>
                  </div>
                  <p>
                    Sessões: <strong>{g.sessoesUsadas}</strong> usadas de {g.sessoesAutorizadas} · válida até {formatarDia(g.validade, new Date())}
                  </p>
                  {alertas.map((t) => (
                    <p key={t} className="flex items-center gap-2 font-bold">
                      <AlertTriangle aria-hidden className="size-5" />
                      {t}
                    </p>
                  ))}
                </li>
              );
            })}
          </ul>
        ))}
    </>
  );
}
