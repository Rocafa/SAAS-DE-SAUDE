import { describe, expect, it } from 'vitest';
import { PERMISSOES, type Perfil } from '../auth/perfis';
import {
  EVENTOS_DA_LINHA_DO_TEMPO,
  escopoDaLinhaDoTempo,
  nomeDaAncora,
  paraEvento,
  reais,
  type EventoDaLinhaDoTempo,
  type LinhaDeOrigem,
} from './linha-do-tempo-regras';

const EU = '11111111-1111-4111-8111-111111111111';
const OUTRO = '22222222-2222-4222-8222-222222222222';
const TIPOS_DO_FRONT = ['consulta', 'falta', 'cancelamento', 'recibo', 'anexo', 'cadastro'];

function linha(evento: EventoDaLinhaDoTempo, extra: Partial<LinhaDeOrigem> = {}): LinhaDeOrigem {
  return {
    evento,
    origemId: '33333333-3333-4333-8333-333333333333',
    chave: '2030-05-06 13:30:00.123456',
    inicio: '2030-05-06 17:00:00.000000',
    inicioAnterior: '2030-05-05 17:00:00.000000',
    profissionalNome: 'Prof Ficticio',
    profissionalSensivel: false,
    profissionalUsuarioId: OUTRO,
    compartimento: 'geral',
    autorUsuarioId: OUTRO,
    valorCentavos: 15000,
    numero: 12,
    ...extra,
  };
}

const escopo = (perfis: Perfil[], clinico = false) => escopoDaLinhaDoTempo(perfis, clinico);

describe('escopo por perfil', () => {
  it('recepção: agenda e financeiro com valores, nunca clínico (mesmo se o chamador errar o vínculo)', () => {
    expect(escopo(['recepcao'], true)).toEqual({ agenda: true, financeiro: true, valores: true, clinico: false });
  });
  it('financeiro: sem clínico', () => {
    expect(escopo(['financeiro'], true)).toMatchObject({ financeiro: true, valores: true, clinico: false });
  });
  it('admin não clínico: sem clínico', () => {
    expect(escopo(['admin'], true).clinico).toBe(false);
  });
  it('profissional: clínico só com vínculo; financeiro sem valores', () => {
    expect(escopo(['profissional'], false)).toEqual({ agenda: true, financeiro: true, valores: false, clinico: false });
    expect(escopo(['profissional'], true).clinico).toBe(true);
  });
  it('sem perfil: nada', () => {
    expect(escopo([], true)).toEqual({ agenda: false, financeiro: false, valores: false, clinico: false });
  });
});

describe('paraEvento', () => {
  it('todo evento tem tipo do front, data/hora no fuso da clínica e id opaco', () => {
    const tudo = escopo(['admin', 'profissional'], true);
    for (const ev of EVENTOS_DA_LINHA_DO_TEMPO) {
      const e = paraEvento(linha(ev), tudo, EU);
      expect(e, ev).not.toBeNull();
      expect(TIPOS_DO_FRONT).toContain(e?.tipo);
      expect(e).toMatchObject({ data: '2030-05-06', hora: '10:30', ocorridoEm: '2030-05-06T13:30:00.123Z', id: `${ev}:${linha(ev).origemId}` });
    }
  });

  it('evento clínico some para quem não tem escopo clínico', () => {
    for (const p of [['recepcao'], ['financeiro'], ['admin'], ['profissional']] as Perfil[][]) {
      expect(paraEvento(linha('atendimento_registrado'), escopo(p, false), EU)).toBeNull();
    }
  });

  it('atendimento é só metadado, com autor = profissional do atendimento', () => {
    const e = paraEvento(linha('atendimento_registrado'), escopo(['profissional'], true), EU);
    expect(e).toMatchObject({ categoria: 'clinico', texto: 'Atendimento registrado por Prof Ficticio em 06/05/2030', autor: 'Prof Ficticio' });
    expect(Object.keys(e ?? {}).sort()).toEqual(['autor', 'categoria', 'data', 'evento', 'hora', 'id', 'ocorridoEm', 'texto', 'tipo']);
  });

  it('psicologia: só o autor vê o atendimento', () => {
    const psi = linha('atendimento_registrado', { compartimento: 'psicologia', autorUsuarioId: OUTRO });
    expect(paraEvento(psi, escopo(['profissional'], true), EU)).toBeNull();
    expect(paraEvento(psi, escopo(['profissional'], true), OUTRO)).not.toBeNull();
  });

  it('valores e número do recibo só com financeiro:ler', () => {
    const pro = escopo(['profissional'], true);
    const rec = escopo(['recepcao']);
    expect(paraEvento(linha('pagamento_recebido'), pro, EU)?.texto).toBe('Pagamento recebido');
    expect(paraEvento(linha('pagamento_recebido'), rec, EU)?.texto).toBe('Pagamento recebido: R$ 150,00');
    expect(paraEvento(linha('recibo_emitido'), pro, EU)?.texto).toBe('Recibo emitido');
    expect(paraEvento(linha('recibo_emitido'), rec, EU)?.texto).toBe('Recibo nº 12 emitido');
    expect(paraEvento(linha('cobranca_registrada'), pro, EU)?.texto).not.toMatch(/R\$|\d/);
  });

  it('agenda e financeiro não levam autor (quem marcou/recebeu não é exposto em outra rota)', () => {
    const tudo = escopo(['admin', 'profissional'], true);
    for (const ev of EVENTOS_DA_LINHA_DO_TEMPO.filter((e) => e !== 'atendimento_registrado')) {
      expect(paraEvento(linha(ev), tudo, EU)?.autor, ev).toBeUndefined();
    }
  });

  it('profissional de área sensível: nome fora do texto da agenda, salvo para ele mesmo', () => {
    const l = linha('agenda_marcada', { profissionalSensivel: true, profissionalUsuarioId: OUTRO });
    expect(paraEvento(l, escopo(['recepcao']), EU)?.texto).toBe('Consulta marcada para 06/05/2030 às 14:00');
    expect(paraEvento(l, escopo(['profissional']), OUTRO)?.texto).toBe('Consulta marcada para 06/05/2030 às 14:00 com Prof Ficticio');
    expect(paraEvento(linha('agenda_faltou'), escopo(['recepcao']), EU)).toMatchObject({ tipo: 'falta', texto: 'Faltou à consulta com Prof Ficticio' });
    expect(paraEvento(linha('agenda_remarcada'), escopo(['recepcao']), EU)?.texto).toBe(
      'Consulta remarcada de 05/05/2030 14:00 para 06/05/2030 14:00 com Prof Ficticio',
    );
  });
});

describe('apoio', () => {
  it('reais', () => {
    expect(reais(0)).toBe('R$ 0,00');
    expect(reais(123456789)).toBe('R$ 1.234.567,89');
  });
  it('nome da âncora amarra evento e instante exato', () => {
    expect(nomeDaAncora({ evento: 'agenda_marcada', chave: '2030-05-06 13:30:00.123456' })).toBe('agenda_marcada|2030-05-06 13:30:00.123456');
  });
});

describe('matriz real', () => {
  it('linha_do_tempo:financeiro_resumo é dada aos quatro perfis da clínica (os que já recebiam)', () => {
    expect([...PERMISSOES['linha_do_tempo:financeiro_resumo']].sort()).toEqual(['admin', 'financeiro', 'profissional', 'recepcao']);
  });
});
