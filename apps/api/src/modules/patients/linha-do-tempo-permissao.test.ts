/**
 * Parecer do Guardião no #246: o resumo financeiro da linha do tempo depende da permissão explícita
 * `linha_do_tempo:financeiro_resumo`, não de "ter algum perfil". Aqui a matriz é trocada (mock) para provar que um
 * perfil SEM a permissão não vê evento financeiro nem de recibo, mesmo continuando a ver a agenda.
 */
import { describe, expect, it, vi } from 'vitest';
import { PERMISSOES } from '../auth/perfis';
import { escopoDaLinhaDoTempo, paraEvento } from './linha-do-tempo-regras';

// vi.mock é içado para antes dos imports: as regras já carregam a matriz trocada.

vi.mock('../auth/perfis', async (original) => {
  const real: typeof import('../auth/perfis') = await original();
  const PERMISSOES = { ...real.PERMISSOES, 'linha_do_tempo:financeiro_resumo': ['admin', 'financeiro'] };
  return {
    ...real,
    PERMISSOES,
    temPermissao: (perfis: readonly string[], p: keyof typeof PERMISSOES) =>
      perfis.some((x) => (PERMISSOES[p] as readonly string[]).includes(x)),
  };
});


const linha = (evento: 'pagamento_recebido' | 'recibo_emitido' | 'agenda_marcada') => ({
  evento,
  origemId: '33333333-3333-4333-8333-333333333333',
  chave: '2030-05-06 13:30:00.000000',
  inicio: '2030-05-06 17:00:00.000000',
  inicioAnterior: null,
  profissionalNome: 'Prof Ficticio',
  profissionalSensivel: false,
  profissionalUsuarioId: null,
  compartimento: null,
  autorUsuarioId: null,
  valorCentavos: 100,
  numero: 1,
});

describe('linha_do_tempo:financeiro_resumo', () => {
  it('perfil sem a permissão não vê financeiro nem recibo (a agenda continua)', () => {
    expect(PERMISSOES['linha_do_tempo:financeiro_resumo']).not.toContain('profissional');
    const escopo = escopoDaLinhaDoTempo(['profissional'], true);
    expect(escopo.financeiro).toBe(false);
    expect(paraEvento(linha('pagamento_recebido'), escopo, 'u')).toBeNull();
    expect(paraEvento(linha('recibo_emitido'), escopo, 'u')).toBeNull();
    expect(paraEvento(linha('agenda_marcada'), escopo, 'u')).not.toBeNull();
  });

  it('perfil com a permissão vê', () => {
    expect(escopoDaLinhaDoTempo(['financeiro'], false).financeiro).toBe(true);
  });
});
