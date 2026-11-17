import { describe, expect, it } from 'vitest';
import { criarApiFake } from '../api/fake';
import { distancia, normalizar, notaTexto } from '../texto';
import { ACOES, acharAcao, acoesPermitidas } from './acoes';
import { ALVOS } from './catalogo';
import { acharPacientes, buscar, cpfMascarado, type IndiceBusca } from './busca';

const agora = new Date(2026, 9, 12, 10, 0);

async function indice(papel: IndiceBusca['papel'] = 'admin'): Promise<IndiceBusca> {
  const api = criarApiFake({ agora });
  return { pacientes: await api.listarPacientes(), agendamentos: await api.listarAgendamentos(), agora, papel };
}

const titulos = (g: ReturnType<typeof buscar>, grupo: string) => g.find((x) => x.grupo === grupo)?.itens.map((i) => i.titulo) ?? [];

describe('texto: sem acento, sem maiúscula, com erro de digitação', () => {
  it('normaliza acento e caixa', () => {
    expect(normalizar('JOÃO')).toBe('joao');
    expect(normalizar('joaõ')).toBe('joao');
    expect(normalizar('  Ana-Paula  ')).toBe('ana paula');
  });
  it('distância conta troca de letras vizinhas como 1 erro', () => {
    expect(distancia('jaoo', 'joao')).toBe(1);
    expect(distancia('mraia', 'maria')).toBe(1);
    expect(distancia('silva', 'silva')).toBe(0);
  });
  it('nota exige todas as palavras', () => {
    expect(notaTexto('maria silva', 'Maria Silva')).toBeGreaterThan(0);
    expect(notaTexto('maria pereira', 'Maria Silva')).toBe(0);
  });
});

describe('busca de pacientes', () => {
  it.each(['joao', 'joão', 'JOÃO', 'joaõ', 'jaoo', 'Joao Pereira', 'pereira'])('"%s" acha João Pereira', async (q) => {
    const { pacientes } = await indice();
    expect(acharPacientes(q, pacientes)[0]?.paciente.nome).toBe('João Pereira');
  });

  it('erro de digitação em nome comprido', async () => {
    const { pacientes } = await indice();
    expect(acharPacientes('fernada almieda', pacientes)[0]?.paciente.nome).toBe('Fernanda Almeida');
  });

  it('acha pelo nome social e mostra o nome social', async () => {
    const i = await indice();
    expect(acharPacientes('alice', i.pacientes)[0]?.paciente.nomeSocial).toBe('Alice Prado');
    expect(titulos(buscar('alice', i), 'Pacientes')[0]).toBe('Alice Prado');
  });

  it('acha pelo telefone e pelos últimos dígitos do CPF', async () => {
    const { pacientes } = await indice();
    expect(acharPacientes('90000-0004', pacientes)[0]?.paciente.nome).toBe('Pedro Santos');
    expect(acharPacientes('(11) 90000-0004', pacientes)[0]?.paciente.nome).toBe('Pedro Santos');
    const cpf = pacientes.find((p) => p.nome === 'Ana Souza')!.cpf;
    expect(acharPacientes(cpf.slice(-6), pacientes).map((x) => x.paciente.nome)).toContain('Ana Souza');
  });

  it('acerto bom esconde parecidos fracos ("joao" não traz Joana nem Alice)', async () => {
    const { pacientes } = await indice();
    const nomes = acharPacientes('joao', pacientes).map((x) => x.paciente.nome);
    expect(nomes).toEqual(['João Pereira']);
  });

  it('dois dígitos não bastam (evita listar todo mundo)', async () => {
    const { pacientes } = await indice();
    expect(acharPacientes('00', pacientes)).toHaveLength(0);
  });

  it('CPF aparece mascarado no resultado', async () => {
    const i = await indice();
    const g = buscar('maria silva', i);
    const detalhe = g.find((x) => x.grupo === 'Pacientes')!.itens[0]!.detalhe!;
    expect(detalhe).toContain('***.***.');
    expect(cpfMascarado('000.000.001-37')).toBe('***.***.001-37');
  });
});

describe('busca universal', () => {
  it('"maria silva" leva à ficha', async () => {
    const g = buscar('maria silva', await indice());
    expect(g[0]?.grupo).toBe('Pacientes');
    expect(g[0]?.itens[0]).toMatchObject({ titulo: 'Maria Silva', rota: '/pacientes/p01' });
  });

  it('"agenda de amanhã" abre a agenda no dia seguinte', async () => {
    const g = buscar('agenda de amanhã', await indice());
    expect(g[0]?.itens[0]).toMatchObject({ grupo: 'Fazer', acaoId: 'ver_agenda', params: { data: '2026-10-13' } });
  });

  it('"quem falta confirmar" vira lista filtrada', async () => {
    const g = buscar('quem falta confirmar', await indice());
    expect(g[0]?.itens[0]).toMatchObject({ acaoId: 'listar', params: { lista: 'falta_confirmar' } });
  });

  it('"recibo" acha a página de recibos', async () => {
    expect(titulos(buscar('recibo', await indice()), 'Páginas')).toContain('Recibos');
  });

  it('"como cancelo uma consulta" mostra o passo a passo primeiro', async () => {
    const g = buscar('como cancelo uma consulta', await indice());
    expect(g[0]?.grupo).toBe('Ajuda');
    expect(g[0]?.itens[0]?.artigo?.id).toBe('como-cancelar');
    expect(g[0]?.itens[0]?.artigo?.passos.length).toBeGreaterThan(1);
  });

  it('configurações aparecem por sinônimo', async () => {
    expect(titulos(buscar('lgpd', await indice()), 'Configurações')).toContain('Privacidade e LGPD');
    expect(titulos(buscar('cancelar plano', await indice()), 'Configurações')).toContain('Plano e assinatura');
  });

  it('"marcar consulta para João quinta às 14h" vira ação com tudo preenchido e confirmação', async () => {
    const g = buscar('marcar consulta para João quinta às 14h', await indice());
    const acao = g[0]!.itens[0]!;
    expect(acao).toMatchObject({
      grupo: 'Fazer',
      acaoId: 'marcar_consulta',
      requiresConfirm: true,
      params: { pacienteId: 'p02', nomePaciente: 'João Pereira', data: '2026-10-15', hora: '14:00' },
    });
    expect(acao.titulo).toContain('João Pereira');
    expect(acao.titulo).toContain('quinta, 15/10');
  });

  it('nome ambíguo oferece as opções', async () => {
    const g = buscar('marcar ana sexta 9h', await indice());
    const nomes = g[0]!.itens.map((i) => i.params?.nomePaciente);
    expect(nomes).toEqual(expect.arrayContaining(['Ana Souza', 'Ana Paula Costa']));
  });

  it('"remarcar a Ana para sexta" usa a próxima consulta da Ana', async () => {
    const g = buscar('remarcar a Ana Souza para sexta', await indice());
    expect(g[0]?.itens[0]).toMatchObject({ acaoId: 'remarcar_consulta', params: { agendamentoId: 'a15', data: '2026-10-16' } });
  });

  it('"imprimir recibo da última consulta da Maria" vai para o recibo', async () => {
    const g = buscar('imprimir recibo da última consulta da Maria Silva', await indice());
    expect(g[0]?.itens[0]).toMatchObject({ acaoId: 'imprimir_recibo', params: { pacienteId: 'p01' } });
  });

  it('B2: só perfil clínico recebe "fazer atestado"', async () => {
    expect(buscar('atestado para Maria Silva', await indice('recepcao')).find((g) => g.grupo === 'Fazer')).toBeUndefined();
    expect(buscar('atestado para Maria Silva', await indice('admin')).find((g) => g.grupo === 'Fazer')).toBeUndefined();
    expect(buscar('atestado para Maria Silva', await indice('profissional'))[0]?.itens[0]?.titulo).toMatch(/atestado/i);
  });

  it('administrador não clínico não recebe a ação de abrir prontuário', async () => {
    expect(buscar('abrir prontuário do Pedro', await indice('admin')).find((x) => x.grupo === 'Fazer')).toBeUndefined();
  });

  it('recepção não recebe a ação de abrir prontuário', async () => {
    const g = buscar('abrir prontuário do Pedro', await indice('recepcao'));
    expect(g.find((x) => x.grupo === 'Fazer')).toBeUndefined();
  });

  it('responde em menos de 150 ms com os dados de demonstração', async () => {
    const i = await indice();
    const frases = ['maria', 'jaoo', 'marcar consulta para João quinta às 14h', 'como cancelo uma consulta', '0004', 'agenda de amanhã'];
    const t0 = performance.now();
    for (const f of frases) buscar(f, i);
    expect((performance.now() - t0) / frases.length).toBeLessThan(150);
  });
});

describe('registro de ações', () => {
  it('ids únicos', () => {
    const ids = ACOES.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('toda ação que grava termina em "confirmar" e nenhuma outra tem "confirmar"', () => {
    const p = { pacienteId: 'p01', nomePaciente: 'Maria Silva', agendamentoId: 'a01', data: '2026-10-15', hora: '14:00' };
    for (const a of ACOES) {
      const passos = a.handler(p);
      expect(passos.length).toBeGreaterThan(0);
      const temConfirmar = passos.some((x) => x.tipo === 'confirmar');
      expect(temConfirmar, a.id).toBe(a.requiresConfirm);
      if (a.requiresConfirm) expect(passos.at(-1)!.tipo, a.id).toBe('confirmar');
    }
  });

  it('todos os alvos existem na lista de data-assist-id', () => {
    for (const a of ACOES) {
      for (const passo of a.handler({ pacienteId: 'p01', nomePaciente: 'X', data: '2026-10-15', hora: '14:00', agendamentoId: 'a1' })) {
        if ('alvo' in passo && passo.alvo) expect(ALVOS).toContain(passo.alvo);
      }
    }
  });

  it('marcar sem dia e hora destaca os campos para a pessoa escolher', () => {
    const passos = acharAcao('marcar_consulta').handler({});
    expect(passos.filter((p) => p.tipo === 'destacar').map((p) => p.alvo)).toEqual(['marcar-dia', 'marcar-hora']);
  });

  it('permissões por papel', () => {
    expect(acoesPermitidas('recepcao').map((a) => a.id)).not.toContain('abrir_prontuario');
    expect(acoesPermitidas('admin').map((a) => a.id)).not.toContain('abrir_prontuario');
    expect(acoesPermitidas('profissional').map((a) => a.id)).toContain('abrir_prontuario');
  });

  it('acharAcao recusa id desconhecido', () => {
    expect(() => acharAcao('apagar_tudo')).toThrow();
  });
});
