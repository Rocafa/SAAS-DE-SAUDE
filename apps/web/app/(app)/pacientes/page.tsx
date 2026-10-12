'use client';

/** Lista de pacientes (versão do PR 1). Cadastro, linha do tempo e anexos chegam no PR 2. */
import { Search, UserRound } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useConsulta } from '@/components/app/dados';
import { Titulo } from '@/components/app/estrutura';
import { Carregando, Erro, Vazio } from '@/components/ui/estados';
import { acharPacientes } from '@/lib/ajudante/busca';
import { nomeExibido } from '@/lib/api/tipos';

export default function PaginaPacientes() {
  const consulta = useConsulta((a) => a.listarPacientes());
  const [busca, setBusca] = useState('');
  const lista = useMemo(() => {
    if (consulta.estado !== 'pronto') return [];
    const todos = consulta.dados;
    return busca.trim() ? acharPacientes(busca, todos).map((x) => x.paciente) : [...todos].sort((a, b) => nomeExibido(a).localeCompare(nomeExibido(b)));
  }, [consulta, busca]);

  return (
    <>
      <Titulo descricao="Procure pelo nome, nome social, telefone ou final do CPF.">Pacientes</Titulo>
      <div className="relative mb-6 max-w-xl">
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
