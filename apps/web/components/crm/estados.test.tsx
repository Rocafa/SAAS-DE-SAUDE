import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Carregando, Erro, Vazio } from '@/components/ui/estados';
import type { EventoLinhaTempo } from '@/lib/api/tipos';
import { CabecalhoPagina } from './cabecalho-pagina';
import { LinhaDoTempo } from './linha-do-tempo';
import { SeloStatus } from './selo-status';

describe('CabecalhoPagina', () => {
  it('mantém título, descrição, status, ação principal e menu de ações secundárias', () => {
    const html = renderToStaticMarkup(
      <CabecalhoPagina
        titulo="Pacientes"
        descricao="Cadastro e acompanhamento."
        status={<span>27 ativos</span>}
        acaoPrincipal={<a href="/pacientes/novo">Cadastrar paciente</a>}
        acoesSecundarias={<button type="button">Exportar lista</button>}
      />,
    );
    expect(html).toContain('<h1');
    expect(html).toContain('Pacientes');
    expect(html).toContain('Cadastro e acompanhamento.');
    expect(html).toContain('27 ativos');
    expect(html).toContain('href="/pacientes/novo"');
    expect(html).toContain('<details');
    expect(html).toContain('Mais ações');
    expect(html).toContain('Exportar lista');
  });
});

describe('SeloStatus', () => {
  it('reutiliza o Status de agendamento e sempre mostra texto', () => {
    const html = renderToStaticMarkup(<SeloStatus status="confirmado" />);
    expect(html).toContain('Confirmado');
    expect(html).toContain('<svg');
  });

  it('diferencia situação textual sem depender de cor', () => {
    const ativo = renderToStaticMarkup(<SeloStatus texto="Ativo" />);
    const inativo = renderToStaticMarkup(<SeloStatus texto="Inativo" aparencia="inativo" />);
    expect(ativo).toContain('Ativo');
    expect(inativo).toContain('Inativo');
    expect(inativo).toContain('line-through');
  });
});

describe('estados obrigatórios reutilizados', () => {
  it('carregando usa região viva e explica o que está acontecendo', () => {
    const html = renderToStaticMarkup(<Carregando texto="Carregando pacientes…" />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('Carregando pacientes…');
  });

  it('vazio informa a próxima ação', () => {
    const html = renderToStaticMarkup(
      <Vazio titulo="Ninguém encontrado" oQueFazer="Confira a busca." acao={<button type="button">Limpar busca</button>} />,
    );
    expect(html).toContain('Ninguém encontrado');
    expect(html).toContain('Confira a busca.');
    expect(html).toContain('Limpar busca');
  });

  it('erro mantém a mensagem real e Tentar de novo', () => {
    const html = renderToStaticMarkup(<Erro mensagem="Não conseguimos falar com o servidor." tentarDeNovo={() => undefined} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('Não conseguimos falar com o servidor.');
    expect(html).toContain('Tentar de novo');
  });
});

describe('LinhaDoTempo', () => {
  const eventos: EventoLinhaTempo[] = [
    {
      data: '2026-10-13',
      hora: '08:00',
      tipo: 'consulta',
      texto: 'Atendimento com Dra. Beatriz Nogueira',
      autor: 'Histórico da agenda (demonstração)',
    },
  ];

  it('mostra data semântica, tipo, autor e descrição administrativa', () => {
    const html = renderToStaticMarkup(<LinhaDoTempo eventos={eventos} agora={new Date('2026-10-13T12:00:00-03:00')} />);
    expect(html).toContain('dateTime="2026-10-13T08:00"');
    expect(html).toContain('hoje');
    expect(html).toContain('Consulta');
    expect(html).toContain('Autor: Histórico da agenda (demonstração)');
    expect(html).toContain('Atendimento com Dra. Beatriz Nogueira');
    expect(html).toContain('<ol');
  });

  it('não inventa autor quando a origem não informa um', () => {
    const html = renderToStaticMarkup(
      <LinhaDoTempo eventos={[{ data: '2026-10-01', tipo: 'cadastro', texto: 'Cadastro criado' }]} agora={new Date('2026-10-13T12:00:00-03:00')} />,
    );
    expect(html).toContain('Cadastro');
    expect(html).toContain('Cadastro criado');
    expect(html).not.toContain('Autor');
  });

  it('usa o estado vazio existente quando ainda não há histórico', () => {
    const html = renderToStaticMarkup(<LinhaDoTempo eventos={[]} />);
    expect(html).toContain('Ainda sem histórico');
    expect(html).toContain('Consultas, faltas, pagamentos e anexos aparecem aqui');
  });
});
