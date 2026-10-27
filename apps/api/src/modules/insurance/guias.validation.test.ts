import { describe, expect, it } from 'vitest';
import { EntradaInvalidaError } from '../../common/validacao';
import { LIMIARES_GUIA } from './guias-regras';
import {
  validarAlteracaoConvenio,
  validarAlteracaoGuia,
  validarAssinatura,
  validarConsumoGuia,
  validarFiltroGuias,
  validarFiltroRelatorio,
  validarLimiares,
  validarNovaGuia,
  validarNovoConvenio,
  validarNovoPacote,
  validarQueryVazia,
} from './guias.validation';

const P = '11111111-1111-4111-8111-111111111111';
const C = '22222222-2222-4222-8222-222222222222';

function campos(fn: () => unknown): readonly string[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof EntradaInvalidaError) return e.campos;
    throw e;
  }
  throw new Error('era esperado erro de validação');
}

describe('convênio', () => {
  it('aceita o cadastro rápido e aplica padrões', () => {
    expect(validarNovoConvenio({ nome: ' Operadora X ', valorSessaoCentavos: 4500, exigeSenha: true, exigeAssinatura: true })).toEqual({
      nome: 'Operadora X',
      valorSessaoCentavos: 4500,
      exigeSenha: true,
      exigeAssinatura: true,
    });
    expect(validarNovoConvenio({ nome: 'Y' })).toEqual({ nome: 'Y', exigeSenha: false, exigeAssinatura: false });
  });

  it('recusa ANS fora de 6 dígitos, valor negativo, chave desconhecida e tenantId', () => {
    expect(campos(() => validarNovoConvenio({ nome: 'X', registroAns: '12345' }))).toEqual(['registroAns']);
    expect(campos(() => validarNovoConvenio({ nome: 'X', valorSessaoCentavos: -1 }))).toEqual(['valorSessaoCentavos']);
    expect(campos(() => validarNovoConvenio({ nome: 'X', tenantId: P }))).toEqual(['campo_desconhecido']);
  });

  it('PATCH aceita null para limpar e exige ao menos um campo', () => {
    expect(validarAlteracaoConvenio({ registroAns: null, valorSessaoCentavos: null })).toEqual({ registroAns: null, valorSessaoCentavos: null });
    expect(campos(() => validarAlteracaoConvenio({}))).toEqual(['corpo']);
  });
});

describe('guia', () => {
  const ok = { pacienteId: P, convenioId: C, numero: '123.456-7', sessoesAutorizadas: 10, validade: '2026-12-31' };

  it('aceita guia completa', () => {
    expect(validarNovaGuia({ ...ok, senha: 'AB12', carteirinha: '0001 2345', emissao: '2026-10-01' })).toMatchObject({
      numero: '123.456-7',
      senha: 'AB12',
      carteirinha: '0001 2345',
    });
  });

  it('recusa número com caractere estranho, sessões fora da faixa e validade antes da emissão', () => {
    expect(campos(() => validarNovaGuia({ ...ok, numero: '12<script>' }))).toEqual(['numero']);
    expect(campos(() => validarNovaGuia({ ...ok, sessoesAutorizadas: 0 }))).toEqual(['sessoesAutorizadas']);
    expect(campos(() => validarNovaGuia({ ...ok, emissao: '2027-01-01' }))).toEqual(['validade']);
    expect(campos(() => validarNovaGuia({ ...ok, validade: '2026-02-30' }))).toEqual(['validade']);
  });

  it('PATCH: null limpa senha/carteirinha; número não é alterável', () => {
    expect(validarAlteracaoGuia({ senha: null })).toEqual({ senha: null });
    expect(campos(() => validarAlteracaoGuia({ numero: '1' }))).toEqual(['campo_desconhecido']);
  });

  it('número, senha e carteirinha na URL dão dado_na_url', () => {
    for (const k of ['numero', 'senha', 'carteirinha', 'busca']) {
      expect(campos(() => validarFiltroGuias({ [k]: '123' }))).toEqual(['dado_na_url']);
      expect(campos(() => validarQueryVazia({ [k]: '123' }))).toEqual(['dado_na_url']);
    }
    expect(validarFiltroGuias({ pacienteId: P })).toEqual({ pacienteId: P, situacao: 'ativas', pagina: 1, limite: 50 });
    expect(campos(() => validarFiltroGuias({ limite: '101' }))).toEqual(['limite']);
  });

  it('consumo: override só com código conhecido', () => {
    expect(validarConsumoGuia({ agendamentoId: P, overrideMotivo: 'decisao_da_clinica' })).toEqual({
      agendamentoId: P,
      override: 'decisao_da_clinica',
    });
    expect(campos(() => validarConsumoGuia({ agendamentoId: P, overrideMotivo: 'porque sim' }))).toEqual(['overrideMotivo']);
  });

  it('assinatura: meio do enum e rótulo de dispositivo restrito', () => {
    expect(validarAssinatura({ meio: 'tela', dispositivo: 'tablet-recepcao-1' })).toEqual({ meio: 'tela', dispositivo: 'tablet-recepcao-1' });
    expect(validarAssinatura({ meio: 'papel' })).toEqual({ meio: 'papel', dispositivo: null });
    expect(campos(() => validarAssinatura({ meio: 'biometria' }))).toEqual(['meio']);
    expect(campos(() => validarAssinatura({ meio: 'tela', dispositivo: 'fulano@x.com' }))).toEqual(['dispositivo']);
  });
});

describe('relatório, limiares e pacote', () => {
  it('relatório: janela de até 31 dias e ordem das datas', () => {
    expect(validarFiltroRelatorio({ de: '2026-09-01', ate: '2026-10-01' })).toEqual({ de: '2026-09-01', ate: '2026-10-01' });
    expect(campos(() => validarFiltroRelatorio({ de: '2026-09-01', ate: '2026-10-02' }))).toEqual(['ate']);
    expect(campos(() => validarFiltroRelatorio({ de: '2026-09-02', ate: '2026-09-01' }))).toEqual(['ate']);
  });

  it('limiares com padrão e faixa', () => {
    expect(validarLimiares({}, LIMIARES_GUIA)).toEqual(LIMIARES_GUIA);
    expect(validarLimiares({ diasVencimento: '15', sessoesRestantes: '2' }, LIMIARES_GUIA)).toEqual({ diasVencimento: 15, sessoesRestantes: 2 });
    expect(campos(() => validarLimiares({ diasVencimento: '91' }, LIMIARES_GUIA))).toEqual(['diasVencimento']);
  });

  it('pacote', () => {
    expect(validarNovoPacote({ pacienteId: P, nome: 'Pilates', total: 10 })).toEqual({ pacienteId: P, nome: 'Pilates', total: 10 });
    expect(campos(() => validarNovoPacote({ pacienteId: P, nome: 'Pilates', total: 201 }))).toEqual(['total']);
  });
});
