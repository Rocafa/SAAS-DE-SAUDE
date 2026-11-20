import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FichaRegistro } from './ficha-registro';
import { TabelaRegistros } from './tabela-registros';

const colunas = [
  { id: 'nome', titulo: 'Nome', celula: (r: { id: string; nome: string }) => r.nome, valorOrdenacao: (r: { id: string; nome: string }) => r.nome },
];

describe('TabelaRegistros — HTML estático', () => {
  it('usa caption, headers com escopo e estado de ordenação acessível', () => {
    const html = renderToStaticMarkup(
      <TabelaRegistros
        titulo="Lista de pacientes"
        registros={[{ id: 'p01', nome: 'Maria Silva' }]}
        colunas={colunas}
        obterId={(r) => r.id}
        textoBusca={(r) => r.nome}
        busca=""
        aoMudarBusca={() => undefined}
        estado={{ estado: 'pronto' }}
        vazio={{ titulo: 'Nenhum paciente', oQueFazer: 'Cadastre o primeiro.' }}
      />,
    );
    expect(html).toContain('<caption class=');
    expect(html).toContain('Lista de pacientes</caption>');
    expect(html).toContain('scope="col"');
    expect(html).toContain('scope="row"');
    expect(html).toContain('aria-sort="none"');
    expect(html).toContain('<label for="busca-pacientes"');
  });

  it('reutiliza Carregando, Vazio e Erro em vez de esconder falhas', () => {
    const base = {
      titulo: 'Lista de pacientes',
      registros: [],
      colunas,
      obterId: (r: { id: string; nome: string }) => r.id,
      textoBusca: (r: { id: string; nome: string }) => r.nome,
      busca: '',
      aoMudarBusca: () => undefined,
      vazio: { titulo: 'Nenhum paciente', oQueFazer: 'Cadastre o primeiro.' },
    };
    expect(renderToStaticMarkup(<TabelaRegistros {...base} estado={{ estado: 'carregando' }} />)).toContain('Carregando registros');
    expect(renderToStaticMarkup(<TabelaRegistros {...base} estado={{ estado: 'pronto' }} />)).toContain('Cadastre o primeiro.');
    expect(
      renderToStaticMarkup(
        <TabelaRegistros {...base} estado={{ estado: 'erro', mensagem: 'Falha de rede.', tentarDeNovo: () => undefined }} />,
      ),
    ).toContain('Tentar de novo');
  });

  it('distingue base só com inativos de base sem nenhum cadastro', () => {
    const html = renderToStaticMarkup(
      <TabelaRegistros
        titulo="Lista de pacientes"
        registros={[{ id: 'p27', nome: 'Miguel Freitas', status: 'inativo' }]}
        colunas={[{ id: 'nome', titulo: 'Nome', celula: (r: { id: string; nome: string; status: string }) => r.nome }]}
        obterId={(r) => r.id}
        textoBusca={(r) => r.nome}
        busca=""
        aoMudarBusca={() => undefined}
        estado={{ estado: 'pronto' }}
        opcoesStatus={[{ valor: 'ativo', rotulo: 'Ativos' }, { valor: 'inativo', rotulo: 'Inativos' }, { valor: 'todos', rotulo: 'Todos' }]}
        obterStatus={(r) => r.status}
        statusInicial="ativo"
        vazio={{ titulo: 'Nenhum paciente cadastrado ainda', oQueFazer: 'Cadastre o primeiro.' }}
      />,
    );
    expect(html).toContain('Nenhum registro neste filtro');
    expect(html).toContain('Mostrar todos');
    expect(html).not.toContain('Nenhum paciente cadastrado ainda');
  });
});

describe('FichaRegistro — HTML estático', () => {
  it('liga abas às URLs e marca somente a seção atual', () => {
    const html = renderToStaticMarkup(
      <FichaRegistro
        nome="Maria Silva"
        descricao="Ficha do paciente"
        status={<span>Ativo</span>}
        metadados={<dl><dt>Telefone</dt><dd>(11) 90000-0001</dd></dl>}
        acaoPrincipal={<a href="/agenda/marcar">Marcar consulta</a>}
        acoesSecundarias={<button type="button">Inativar paciente</button>}
        voltar={{ href: '/pacientes', rotulo: 'Voltar para Pacientes' }}
        abas={[
          { id: 'visao-geral', rotulo: 'Visão geral', href: '/pacientes/p01' },
          { id: 'agenda', rotulo: 'Agenda', href: '/pacientes/p01?aba=agenda' },
        ]}
        abaAtual="agenda"
      >
        <section>Próximas consultas</section>
      </FichaRegistro>,
    );
    expect(html).toContain('<article');
    expect(html).toContain('<h1');
    expect(html).toContain('Maria Silva');
    expect(html).toContain('Voltar para Pacientes');
    expect(html).toContain('aria-label="Seções da ficha"');
    expect(html).toContain('id="aba-agenda"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('id="painel-agenda"');
    expect(html).toContain('aria-labelledby="aba-agenda"');
    expect(html).toContain('Próximas consultas');
  });
});
