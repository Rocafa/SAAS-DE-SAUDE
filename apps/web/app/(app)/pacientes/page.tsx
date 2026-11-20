'use client';

/** Lista de pacientes: busca, cadastro e inativos (escondidos por padrão). */
import { UserPlus } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useMemo, useState } from 'react';
import { AvisoTruncado } from '@/components/app/aviso-truncado';
import { useConsulta, useDados } from '@/components/app/dados';
import { useAtrasado } from '@/components/app/use-atrasado';
import { CabecalhoPagina } from '@/components/crm/cabecalho-pagina';
import { SeloStatus } from '@/components/crm/selo-status';
import { TabelaRegistros, type ColunaRegistro } from '@/components/crm/tabela-registros';
import { Botao } from '@/components/ui/botao';
import { acharPacientes } from '@/lib/ajudante/busca';
import { nomeExibido, type Paciente } from '@/lib/api/tipos';
import { ATRASO_BUSCA_MS, TERMO_MINIMO } from '@/lib/selecao-paciente';

const COLUNAS: ColunaRegistro<Paciente>[] = [
  {
    id: 'nome',
    titulo: 'Nome',
    celula: (paciente) => (
      <Link href={`/pacientes/${paciente.id}`} data-registro-nome className="inline-flex min-h-12 items-center font-bold underline">
        {nomeExibido(paciente)}
      </Link>
    ),
    valorOrdenacao: (paciente) => nomeExibido(paciente),
  },
  {
    id: 'telefone',
    titulo: 'Telefone',
    celula: (paciente) => <span className="whitespace-nowrap">{paciente.telefone}</span>,
    valorOrdenacao: (paciente) => paciente.telefone,
  },
  {
    id: 'status',
    titulo: 'Status',
    celula: (paciente) => <SeloStatus texto={paciente.ativo ? 'Ativo' : 'Inativo'} aparencia={paciente.ativo ? 'normal' : 'inativo'} />,
    valorOrdenacao: (paciente) => (paciente.ativo ? 'Ativo' : 'Inativo'),
  },
];

const OPCOES_STATUS = [
  { valor: 'ativo', rotulo: 'Ativos' },
  { valor: 'inativo', rotulo: 'Inativos' },
  { valor: 'todos', rotulo: 'Todos' },
] as const;

export default function PaginaPacientes() {
  const { api } = useDados();
  const [busca, setBusca] = useState('');
  // Modo http: a busca vai ao servidor, que a registra na auditoria (sem o termo). Fake: local.
  const termo = useAtrasado(busca.trim(), ATRASO_BUSCA_MS);
  const noServidor = Boolean(api.buscarPacientes) && termo.length >= TERMO_MINIMO;
  const consulta = useConsulta(
    (a) => (noServidor && a.buscarPacientes ? a.buscarPacientes(termo) : a.listarPacientes()),
    [noServidor ? termo : ''],
  );
  const registros = useMemo(() => {
    if (consulta.estado !== 'pronto') return [];
    if (noServidor || busca.trim()) return consulta.dados;
    return [...consulta.dados].sort((a, b) => nomeExibido(a).localeCompare(nomeExibido(b)));
  }, [consulta, busca, noServidor]);
  const filtrar = useCallback(
    (lista: Paciente[], termoBusca: string) =>
      termoBusca.trim() ? acharPacientes(termoBusca, lista).map((resultado) => resultado.paciente) : lista,
    [],
  );
  const textoBusca = useCallback((paciente: Paciente) => `${paciente.nome} ${paciente.nomeSocial ?? ''} ${paciente.telefone}`, []);

  return (
    <>
      <CabecalhoPagina
        titulo="Pacientes"
        descricao="Procure pelo nome, nome social, telefone ou final do CPF."
        acaoPrincipal={
          <Botao asChild tamanho="grande">
            <Link href="/pacientes/novo">
              <UserPlus aria-hidden />
              Cadastrar paciente
            </Link>
          </Botao>
        }
      />
      {consulta.estado === 'pronto' && <AvisoTruncado truncado={consulta.dados.truncado} />}
      <TabelaRegistros
        titulo="Lista de pacientes"
        registros={registros}
        colunas={COLUNAS}
        obterId={(paciente) => paciente.id}
        textoBusca={textoBusca}
        busca={busca}
        aoMudarBusca={setBusca}
        estado={consulta}
        rotuloBusca="Procurar paciente"
        ajudaBusca="Confira a escrita ou procure pelo telefone. Você também pode limpar a busca e os filtros."
        rotuloRegistros={{ singular: 'paciente', plural: 'pacientes' }}
        filtrar={filtrar}
        buscaNoServidor={noServidor}
        opcoesStatus={OPCOES_STATUS}
        obterStatus={(paciente) => (paciente.ativo ? 'ativo' : 'inativo')}
        statusInicial="ativo"
        vazio={{
          titulo: 'Nenhum paciente cadastrado ainda',
          oQueFazer: 'Cadastre o primeiro paciente ou traga os dados do sistema antigo.',
        }}
      />
    </>
  );
}
