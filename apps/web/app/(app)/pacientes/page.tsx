'use client';

/** Lista de pacientes: busca, cadastro e inativos (escondidos por padrão). */
import { Search, UserPlus, UserRound } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useConsulta, useDados } from '@/components/app/dados';
import { Titulo } from '@/components/app/estrutura';
import { Botao } from '@/components/ui/botao';
import { Carregando, Erro, Vazio } from '@/components/ui/estados';
import { acharPacientes } from '@/lib/ajudante/busca';
import { nomeExibido } from '@/lib/api/tipos';

/** Espera a pessoa parar de digitar antes de buscar no servidor (modo http). */
function useAtrasado(valor: string, ms: number): string {
  const [v, setV] = useState(valor);
  useEffect(() => {
    const t = setTimeout(() => setV(valor), ms);
    return () => clearTimeout(t);
  }, [valor, ms]);
  return v;
}

export default function PaginaPacientes() {
  const { api } = useDados();
  const [busca, setBusca] = useState('');
  const [verInativos, setVerInativos] = useState(false);
  // Modo http: a busca vai ao servidor, que a registra na auditoria (sem o termo). Fake: local.
  const termo = useAtrasado(busca.trim(), 350);
  const noServidor = Boolean(api.buscarPacientes) && termo.length >= 2;
  const consulta = useConsulta(
    (a) => (noServidor && a.buscarPacientes ? a.buscarPacientes(termo) : a.listarPacientes()),
    [noServidor ? termo : ''],
  );
  const lista = useMemo(() => {
    if (consulta.estado !== 'pronto') return [];
    const todos = consulta.dados.filter((p) => verInativos || p.ativo);
    if (noServidor) return todos;
    return busca.trim() ? acharPacientes(busca, todos).map((x) => x.paciente) : [...todos].sort((a, b) => nomeExibido(a).localeCompare(nomeExibido(b)));
  }, [consulta, busca, verInativos, noServidor]);

  return (
    <>
      <Titulo descricao="Procure pelo nome, nome social, telefone ou final do CPF.">Pacientes</Titulo>
      <Botao asChild tamanho="grande" className="mb-6">
        <Link href="/pacientes/novo">
          <UserPlus aria-hidden />
          Cadastrar paciente
        </Link>
      </Botao>
      <div className="relative mb-3 max-w-xl">
        <label htmlFor="busca-pacientes" className="sr-only">
          Procurar paciente
        </label>
        <Search aria-hidden className="pointer-events-none absolute left-4 top-1/2 size-6 -translate-y-1/2" />
        <input
          id="busca-pacientes"
          type="search"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder="Procurar paciente"
          autoComplete="off"
          className="min-h-14 w-full rounded-md border-2 border-borda-forte bg-fundo pl-12 pr-4 text-lg"
        />
      </div>
      <label className="mb-6 flex min-h-12 items-center gap-3">
        <input type="checkbox" checked={verInativos} onChange={(e) => setVerInativos(e.target.checked)} className="size-6 accent-[var(--texto)]" />
        Mostrar também os inativos
      </label>
      {consulta.estado === 'carregando' && <Carregando />}
      {consulta.estado === 'erro' && <Erro mensagem={consulta.mensagem} tentarDeNovo={consulta.tentarDeNovo} />}
      {consulta.estado === 'pronto' &&
        (lista.length === 0 ? (
          <Vazio
            titulo={busca ? `Ninguém encontrado com “${busca}”` : 'Nenhum paciente cadastrado ainda'}
            oQueFazer={busca ? 'Confira a escrita ou procure pelo telefone.' : 'Cadastre o primeiro paciente ou traga os dados do sistema antigo.'}
          />
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {lista.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/pacientes/${p.id}`}
                  className="flex min-h-16 items-center gap-3 rounded-md border-2 border-borda p-3 no-underline hover:border-borda-forte"
                >
                  <UserRound aria-hidden className="size-6 shrink-0" />
                  <span className="flex flex-col">
                    <span className="text-lg font-bold underline">{nomeExibido(p)}</span>
                    <span className="text-[0.95rem] text-texto-suave">
                      {p.telefone}
                      {p.ativo ? '' : ' · Inativo'}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ))}
    </>
  );
}
