'use client';

import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { Botao } from '@/components/ui/botao';
import { Carregando, Erro, Vazio } from '@/components/ui/estados';
import { cn } from '@/lib/utils';
import { filtrarPorStatus, filtrarPorTexto, ordenarRegistros, paginarRegistros, type DirecaoOrdenacao } from './registros';

export interface ColunaRegistro<T> {
  id: string;
  titulo: string;
  celula: (registro: T) => ReactNode;
  valorOrdenacao?: (registro: T) => string | number;
}

export type EstadoTabela =
  | { estado: 'carregando' }
  | { estado: 'erro'; mensagem: string; tentarDeNovo: () => void }
  | { estado: 'pronto' };

interface TabelaRegistrosProps<T> {
  titulo: string;
  registros: readonly T[];
  colunas: readonly ColunaRegistro<T>[];
  obterId: (registro: T) => string;
  textoBusca: (registro: T) => string;
  busca: string;
  aoMudarBusca: (busca: string) => void;
  estado: EstadoTabela;
  vazio: { titulo: string; oQueFazer: string; acao?: ReactNode };
  filtrar?: (registros: T[], termo: string) => T[];
  buscaNoServidor?: boolean;
  opcoesStatus?: readonly { valor: string; rotulo: string }[];
  obterStatus?: (registro: T) => string;
  statusInicial?: string;
  porPagina?: number;
}

export function TabelaRegistros<T>({
  titulo,
  registros,
  colunas,
  obterId,
  textoBusca,
  busca,
  aoMudarBusca,
  estado,
  vazio,
  filtrar,
  buscaNoServidor = false,
  opcoesStatus,
  obterStatus = () => 'todos',
  statusInicial = 'todos',
  porPagina = 10,
}: TabelaRegistrosProps<T>) {
  const [status, setStatus] = useState(statusInicial);
  const [pagina, setPagina] = useState(1);
  const [ordenacao, setOrdenacao] = useState<{ colunaId: string; direcao: DirecaoOrdenacao } | null>(null);

  const filtrados = useMemo(() => {
    const porStatus = filtrarPorStatus(registros, status, obterStatus);
    const porTexto = buscaNoServidor ? porStatus : filtrar ? filtrar(porStatus, busca) : filtrarPorTexto(porStatus, busca, textoBusca);
    if (!ordenacao) return porTexto;
    const coluna = colunas.find((c) => c.id === ordenacao.colunaId);
    return coluna?.valorOrdenacao ? ordenarRegistros(porTexto, coluna.valorOrdenacao, ordenacao.direcao) : porTexto;
  }, [registros, status, obterStatus, buscaNoServidor, filtrar, busca, textoBusca, ordenacao, colunas]);
  const paginado = paginarRegistros(filtrados, pagina, porPagina);

  function mudarBusca(valor: string) {
    setPagina(1);
    aoMudarBusca(valor);
  }

  function mudarStatus(valor: string) {
    setPagina(1);
    setStatus(valor);
  }

  function limpar() {
    mudarStatus(statusInicial);
    mudarBusca('');
  }

  function alternarOrdenacao(colunaId: string) {
    setOrdenacao((atual) => ({
      colunaId,
      direcao: atual?.colunaId === colunaId && atual.direcao === 'ascendente' ? 'descendente' : 'ascendente',
    }));
  }

  function botaoOrdenacao(coluna: ColunaRegistro<T>, movel = false) {
    const ativa = ordenacao?.colunaId === coluna.id;
    return (
      <button
        key={coluna.id}
        type="button"
        aria-label={`Ordenar por ${coluna.titulo}`}
        aria-pressed={ativa}
        onClick={() => alternarOrdenacao(coluna.id)}
        className={cn('inline-flex min-h-12 items-center gap-2 font-bold', movel && 'rounded-md border-2 border-borda px-3')}
      >
        {coluna.titulo}
        {ativa ? (
          ordenacao.direcao === 'ascendente' ? <ArrowUp aria-hidden className="size-5" /> : <ArrowDown aria-hidden className="size-5" />
        ) : (
          <ArrowUpDown aria-hidden className="size-5" />
        )}
      </button>
    );
  }

  const semResultadoPorFiltro = busca.trim().length > 0 || status !== statusInicial;
  const totalRotulo = `${paginado.total} ${paginado.total === 1 ? 'registro' : 'registros'}`;

  return (
    <section aria-label={titulo}>
      <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-end">
        <div className="relative w-full max-w-xl">
          <label htmlFor="busca-pacientes" className="sr-only">
            Procurar paciente
          </label>
          <Search aria-hidden className="pointer-events-none absolute left-4 top-1/2 size-6 -translate-y-1/2" />
          <input
            id="busca-pacientes"
            type="search"
            value={busca}
            onChange={(event) => mudarBusca(event.target.value)}
            placeholder="Procurar paciente"
            autoComplete="off"
            className="min-h-14 w-full rounded-md border-2 border-borda-forte bg-fundo pl-12 pr-4 text-lg"
          />
        </div>
        {opcoesStatus && (
          <div className="flex flex-col gap-1">
            <label htmlFor="filtro-status" className="text-[0.95rem] font-bold">
              Status
            </label>
            <select
              id="filtro-status"
              aria-label="Filtrar por status"
              value={status}
              onChange={(event) => mudarStatus(event.target.value)}
              className="min-h-14 rounded-md border-2 border-borda-forte bg-fundo px-4"
            >
              {opcoesStatus.map((opcao) => (
                <option key={opcao.valor} value={opcao.valor}>
                  {opcao.rotulo}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {estado.estado === 'carregando' && <Carregando texto="Carregando registros…" />}
      {estado.estado === 'erro' && <Erro mensagem={estado.mensagem} tentarDeNovo={estado.tentarDeNovo} />}
      {estado.estado === 'pronto' && filtrados.length === 0 && (
        <Vazio
          titulo={semResultadoPorFiltro ? (busca.trim() ? `Ninguém encontrado com “${busca.trim()}”` : 'Nenhum registro neste filtro') : vazio.titulo}
          oQueFazer={
            semResultadoPorFiltro
              ? busca.trim()
                ? 'Confira a escrita ou procure pelo telefone. Você também pode limpar a busca e os filtros.'
                : 'Escolha outro status ou limpe a busca e os filtros.'
              : vazio.oQueFazer
          }
          acao={
            semResultadoPorFiltro ? (
              <Botao variante="contorno" onClick={limpar}>
                Limpar busca e filtros
              </Botao>
            ) : (
              vazio.acao
            )
          }
        />
      )}

      {estado.estado === 'pronto' && filtrados.length > 0 && (
        <>
          <div aria-label="Ordenar registros" className="mb-4 flex flex-wrap items-center gap-2 md:hidden">
            <span className="text-[0.95rem] font-bold">Ordenar:</span>
            {colunas.filter((coluna) => coluna.valorOrdenacao).map((coluna) => botaoOrdenacao(coluna, true))}
          </div>
          <table className="hidden w-full border-collapse md:table" aria-label={titulo}>
            <caption className="pb-3 text-left font-bold">{titulo}</caption>
            <thead>
              <tr className="border-b-2 border-borda-forte">
                {colunas.map((coluna) => {
                  const ativa = ordenacao?.colunaId === coluna.id;
                  return (
                    <th
                      key={coluna.id}
                      scope="col"
                      aria-sort={coluna.valorOrdenacao ? (ativa ? (ordenacao.direcao === 'ascendente' ? 'ascending' : 'descending') : 'none') : undefined}
                      className="p-3 text-left"
                    >
                      {coluna.valorOrdenacao ? botaoOrdenacao(coluna) : coluna.titulo}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {paginado.itens.map((registro) => (
                <tr key={obterId(registro)} data-registro-id={obterId(registro)} className="border-b border-borda align-top">
                  {colunas.map((coluna, indice) =>
                    indice === 0 ? (
                      <th key={coluna.id} scope="row" className="p-3 text-left font-normal">
                        {coluna.celula(registro)}
                      </th>
                    ) : (
                      <td key={coluna.id} className="p-3">
                        {coluna.celula(registro)}
                      </td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>

          <ul data-testid="cartoes-registros" aria-label={`${titulo} em cartões`} className="flex flex-col gap-3 md:hidden">
            {paginado.itens.map((registro) => (
              <li key={obterId(registro)} data-registro-id={obterId(registro)} className="rounded-md border-2 border-borda p-4">
                <dl className="flex flex-col gap-3">
                  {colunas.map((coluna, indice) => (
                    <div key={coluna.id} className="flex flex-wrap items-center justify-between gap-2">
                      <dt className="text-[0.95rem] font-bold text-texto-suave">{coluna.titulo}</dt>
                      <dd className={cn(indice === 0 && 'text-lg')}>{coluna.celula(registro)}</dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ul>

          <nav aria-label="Paginação" className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-borda pt-4">
            <Botao variante="contorno" disabled={paginado.pagina <= 1} onClick={() => setPagina(paginado.pagina - 1)}>
              <ChevronLeft aria-hidden />
              Página anterior
            </Botao>
            <p role="status" className="text-[0.95rem] text-texto-suave">
              Página {paginado.pagina} de {paginado.totalPaginas} · {paginado.total} {paginado.total === 1 ? 'paciente' : 'pacientes'}
            </p>
            <Botao variante="contorno" disabled={paginado.pagina >= paginado.totalPaginas} onClick={() => setPagina(paginado.pagina + 1)}>
              Próxima página
              <ChevronRight aria-hidden />
            </Botao>
          </nav>
          <span className="sr-only">{totalRotulo}</span>
        </>
      )}
    </section>
  );
}
