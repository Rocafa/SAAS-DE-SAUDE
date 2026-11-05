import { describe, expect, it } from 'vitest';
import { EntradaInvalidaError } from '../../common/validacao';
import {
  descricaoEhNeutraOuAceita,
  normalizarTextoParaChecagem,
  dinheiroEsperado,
  menorDeIdadeEm,
  pendenciasDoItem,
  pendenciasDoRecibo,
  situacaoDaCobranca,
  totaisZerados,
} from './financeiro-regras';
import {
  validarConfiguracao,
  validarFiltroContasAReceber,
  validarLoteReceitaSaude,
  validarNovaCobranca,
  validarRecebimento,
} from './financeiro.validation';

function campos(fn: () => unknown): readonly string[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof EntradaInvalidaError) return [...e.campos].sort();
    throw e;
  }
  return [];
}

describe('texto neutro do recibo', () => {
  it('aceita textos neutros e recusa CID e termos de diagnóstico/condição', () => {
    for (const ok of ['Atendimento', 'Atendimento em saude', 'Consulta', 'Sessao de fisioterapia']) expect(descricaoEhNeutraOuAceita(ok)).toBe(true);
    for (const ruim of ['Sessao F32', 'cid 10', 'Diagnóstico', 'Transtorno de ansiedade', 'Tratamento de depressão', 'Terapia TEA', 'Sindrome X'])
      expect(descricaoEhNeutraOuAceita(ruim)).toBe(false);
  });

  it('R4 do #65: contornos comuns também são recusados; textos neutros seguem aceitos', () => {
    for (const ruim of ['Sessao F 32', 'Sessao F-32', 'TDAH', 'Transt. bipolar', 'Esquizofrenia', 'Terapia TOC', 'Gestante', 'Pre-natal', 'Alcool'])
      expect(descricaoEhNeutraOuAceita(ruim), ruim).toBe(false);
    for (const ok of ['Atendimento', 'Pacote de 10 sessoes', 'Sessao de fonoaudiologia', 'Consulta de retorno', 'Avaliacao inicial'])
      expect(descricaoEhNeutraOuAceita(ok), ok).toBe(true);
  });

  it('R16 do #65: normaliza (NFKC, invisíveis, caixa, separadores) antes de checar o CID', () => {
    const ruins = [
      'Sessao f 32',
      'Sessao F/32',
      'Sessao F_32',
      'Sessao f-32',
      'Sessao F\u{200B}32', // espaço de largura zero
      'Sessao F\u{200D}3\u{200C}2', // ZWJ e ZWNJ
      'Sessao F\u{AD}32', // hífen suave
      'Sessao F\u{FEFF}32', // BOM
      'Sessao \u{FF26}\u{FF13}\u{FF12}', // F32 em largura total
      'Sessao F\u{A0}32', // espaço sem quebra
      'Sessao F\u{3164}32', // preenchedor Hangul
      'Sessao F - 3 2',
      'Sessao f84.0',
      'Sessao F 84 . 0',
      'De\u{200B}press\u{E3}o',
      'Transt\u{AD}orno',
      'Depressa\u{303}o', // til combinante
    ];
    for (const ruim of ruins) expect(descricaoEhNeutraOuAceita(ruim), JSON.stringify(ruim)).toBe(false);
    for (const ok of ['Pacote de 10 sessoes', 'Pacote 2 x 10 sessoes', 'Sessao 1 de 10', 'Atendimento 2026', 'Consulta - retorno'])
      expect(descricaoEhNeutraOuAceita(ok), ok).toBe(true);
    expect(normalizarTextoParaChecagem('F\u{200B} 32\u{A0}')).toBe('F 32');
  });

  it('configuração: texto ruim volta só o nome do campo; CNPJ normalizado', () => {
    expect(campos(() => validarConfiguracao({ descricaoRecibo: 'Sessao F84.0' }))).toEqual(['descricaoRecibo']);
    expect(validarConfiguracao({ emitenteCnpj: '00.000.000/0001-91' })).toEqual({ emitenteCnpj: '00000000000191' });
    expect(campos(() => validarConfiguracao({}))).toEqual(['corpo']);
  });
});

describe('cobrança e recebimento', () => {
  it('situação calculada', () => {
    expect(situacaoDaCobranca({ status: 'open', amountCents: 100, paidCents: 0 })).toBe('aberta');
    expect(situacaoDaCobranca({ status: 'open', amountCents: 100, paidCents: 40 })).toBe('parcial');
    expect(situacaoDaCobranca({ status: 'open', amountCents: 100, paidCents: 100 })).toBe('paga');
    expect(situacaoDaCobranca({ status: 'cancelled', amountCents: 100, paidCents: 0 })).toBe('cancelada');
  });

  it('exatamente um alvo, valor inteiro em centavos, CPF do pagador com DV', () => {
    const id = '00000000-0000-4000-8000-000000000001';
    expect(campos(() => validarNovaCobranca({ valorCentavos: 100 }))).toEqual(['alvo']);
    expect(campos(() => validarNovaCobranca({ agendamentoId: id, valorCentavos: 10.5 }))).toEqual(['valorCentavos']);
    expect(campos(() => validarNovaCobranca({ agendamentoId: id, valorCentavos: 0 }))).toEqual(['valorCentavos']);
    expect(campos(() => validarNovaCobranca({ agendamentoId: id, valorCentavos: 1, pagador: { nome: 'X Y', cpf: '11111111111' } }))).toEqual(['pagador']);
    expect(campos(() => validarNovaCobranca({ agendamentoId: id, valorCentavos: 1, tenantId: id }))).toEqual(['campo_desconhecido']);
  });

  it('forma do front é aceita e traduzida', () => {
    expect(validarRecebimento({ forma: 'pix' }).forma).toBe('pix_manual');
    expect(validarRecebimento({ forma: 'cartao' }).forma).toBe('cartao_credito');
    expect(campos(() => validarRecebimento({ forma: 'boleto' }))).toEqual(['forma']);
  });
});

describe('janelas e URL', () => {
  it('contas a receber: até 31 dias e sem dado pessoal na query', () => {
    expect(validarFiltroContasAReceber({ de: '2031-01-01', ate: '2031-01-31' }).situacao).toBe('em_aberto');
    expect(campos(() => validarFiltroContasAReceber({ de: '2031-01-01', ate: '2031-02-01' }))).toEqual(['ate']);
    expect(campos(() => validarFiltroContasAReceber({ de: '2031-01-01', ate: '2031-01-02', nome: 'Fulano' }))).toEqual(['dado_na_url']);
    expect(campos(() => validarLoteReceitaSaude({ profissionalId: 'x', de: '2031-01-02', ate: '2031-01-01' }))).toEqual(['ate', 'profissionalId']);
  });
});

describe('caixa e recibo', () => {
  it('dinheiro esperado = troco + recebido em dinheiro − estornado em dinheiro (outras formas não contam)', () => {
    const r = { ...totaisZerados(), dinheiro: 1700, cartao_credito: 500 };
    const e = { ...totaisZerados(), dinheiro: 1000 };
    expect(dinheiroEsperado(2000, r, e)).toBe(2700);
  });

  it('pendências: documento do emitente e CPFs faltando', () => {
    const base = {
      emitente: { tipo: 'pf' as const, nome: 'P', documento: null, registroConselho: null, profissionalId: 'x' },
      pagador: { nome: 'A', cpf: null },
      beneficiario: { nome: 'A', cpf: '00000000191' },
      valorCentavos: 1,
      forma: 'pix_manual' as const,
      dataPagamento: '2031-01-01',
      descricao: 'Atendimento',
    };
    expect(pendenciasDoRecibo(base)).toEqual(['cpf_do_profissional', 'cpf_do_pagador']);
    // R1 do 2º parecer do #67: pagador congelado anulado depois (cadastro errado).
    expect(pendenciasDoRecibo(base, false, true)).toEqual(['pagador_anulado', 'cpf_do_profissional', 'cpf_do_pagador']);
    expect(pendenciasDoItem({ pagador: { nome: 'A', cpf: '00000000191' }, beneficiario: base.beneficiario }, false, true)).toEqual(['pagador_anulado']);
  });
});

describe('R3 do #65: paciente menor', () => {
  it('idade na data do pagamento, com aniversário; sem data não presume', () => {
    expect(menorDeIdadeEm('2010-06-15', '2028-06-14')).toBe(true);
    expect(menorDeIdadeEm('2010-06-15', '2028-06-15')).toBe(false);
    expect(menorDeIdadeEm(null, '2028-06-15')).toBe(false);
    expect(menorDeIdadeEm('lixo', '2028-06-15')).toBe(false);
  });
});
