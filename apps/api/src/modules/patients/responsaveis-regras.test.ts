import { describe, expect, it } from 'vitest';
import { temPermissao } from '../auth/perfis';
import {
  faixaDoPedidoDeSigilo,
  faixaEtariaEm,
  idadeEm,
  informacaoClinica,
  menorEm,
  pedidoDeSigiloDoVinculo,
  pendenciasDoCadastro,
  REGRA_INFORMACAO_CLINICA,
  tipoRepresentaPaciente,
  vigenteEm,
} from './responsaveis-regras';
import { validarAlteracaoVinculo, validarEncerramento, validarNovoVinculo, validarPedidoDeSigilo } from './responsaveis.validation';

const HOJE = '2030-06-15';
/** Decisão do profissional tomada HOJE. */
const marca = { tipo: 'pai_mae' as const, recebeInformacaoClinica: true, desde: '2020-01-01', ate: null, decididaEm: HOJE };

describe('vigência [desde, ate)', () => {
  it('fim exclusivo e sem fim', () => {
    expect(vigenteEm({ desde: '2030-01-01', ate: null }, HOJE)).toBe(true);
    expect(vigenteEm({ desde: '2030-01-01', ate: HOJE }, HOJE)).toBe(false);
    expect(vigenteEm({ desde: '2030-01-01', ate: '2030-06-16' }, HOJE)).toBe(true);
    expect(vigenteEm({ desde: '2030-06-16', ate: null }, HOJE)).toBe(false);
  });
});

describe('maioridade (CC art. 5º) e informação clínica', () => {
  it('idade completa no dia do aniversário', () => {
    expect(idadeEm('2012-06-15', HOJE)).toBe(18);
    expect(idadeEm('2012-06-16', HOJE)).toBe(17);
    expect(idadeEm(null, HOJE)).toBeNull();
    expect(menorEm('2012-06-16', HOJE)).toBe(true);
    expect(menorEm('2012-06-15', HOJE)).toBe(false);
    expect(menorEm(null, HOJE)).toBeNull();
  });

  it('menor com marca e vínculo vigente: permitida; aos 18 cai sozinha; curatela sobrevive', () => {
    expect(informacaoClinica(marca, '2012-06-16', HOJE)).toEqual({ permitida: true, motivo: 'permitida' });
    expect(informacaoClinica(marca, '2012-06-15', HOJE)).toEqual({ permitida: false, motivo: 'paciente_maior_de_idade' });
    expect(informacaoClinica({ ...marca, tipo: 'curador' }, '1980-01-01', HOJE).permitida).toBe(true);
    expect(informacaoClinica({ ...marca, tipo: 'representante' }, '1980-01-01', HOJE).permitida).toBe(false);
  });

  it('0055: apoiador recebe só com a marca, a decisão do profissional e a autorização do paciente (B1); não representa', () => {
    expect(informacaoClinica({ ...marca, tipo: 'apoiador', autorizadoPeloPaciente: true }, '1980-01-01', HOJE)).toEqual({ permitida: true, motivo: 'permitida' });
    expect(informacaoClinica({ ...marca, tipo: 'apoiador' }, '1980-01-01', HOJE)).toEqual({ permitida: false, motivo: 'sem_autorizacao_do_paciente' });
    expect(informacaoClinica({ ...marca, tipo: 'apoiador', autorizadoPeloPaciente: false }, '1980-01-01', HOJE).motivo).toBe('sem_autorizacao_do_paciente');
    expect(informacaoClinica({ ...marca, tipo: 'apoiador', autorizadoPeloPaciente: true, ate: HOJE }, '1980-01-01', HOJE).motivo).toBe('vinculo_nao_vigente');
    expect(informacaoClinica({ ...marca, tipo: 'apoiador', decididaEm: null }, '1980-01-01', HOJE).motivo).toBe('sem_decisao_do_profissional');
    expect(informacaoClinica({ ...marca, tipo: 'apoiador', recebeInformacaoClinica: false }, '1980-01-01', HOJE).motivo).toBe('marca_desligada');
    expect(tipoRepresentaPaciente('apoiador')).toBe(false);
    for (const t of ['pai_mae', 'tutor', 'curador', 'representante'] as const) expect(tipoRepresentaPaciente(t), t).toBe(true);
  });

  it('sem marca, fora da vigência ou sem nascimento: negada', () => {
    expect(informacaoClinica({ ...marca, recebeInformacaoClinica: false }, '2020-01-01', HOJE).motivo).toBe('marca_desligada');
    expect(informacaoClinica({ ...marca, ate: HOJE }, '2020-01-01', HOJE).motivo).toBe('vinculo_nao_vigente');
    expect(informacaoClinica({ ...marca, ate: HOJE, tipo: 'curador' }, '1980-01-01', HOJE).motivo).toBe('vinculo_nao_vigente');
    expect(informacaoClinica(marca, null, HOJE).motivo).toBe('sem_data_de_nascimento');
  });

  it('emancipação encerra a menoridade (CC art. 5º, par. único)', () => {
    expect(menorEm('2014-01-01', HOJE, '2030-06-01')).toBe(false);
    expect(menorEm('2014-01-01', HOJE, '2030-07-01')).toBe(true);
    expect(informacaoClinica(marca, '2014-01-01', HOJE, '2030-06-01').motivo).toBe('paciente_emancipado');
    expect(faixaEtariaEm('2014-01-01', HOJE, '2030-06-01')).toBe('adulto');
  });

  it('faixas: até 11 vale a decisão; 12–17 só decisão tomada já na adolescência (padrão protetor); sem decisão, nunca', () => {
    expect(REGRA_INFORMACAO_CLINICA).toEqual({ idadeInicioAdolescencia: 12, adolescenteCompartilhaComDecisaoAnterior: false });
    expect(faixaEtariaEm('2018-06-16', HOJE)).toBe('crianca'); // 11 anos
    expect(faixaEtariaEm('2018-06-15', HOJE)).toBe('adolescente'); // 12 hoje
    // Criança: decisão de anos atrás vale.
    expect(informacaoClinica({ ...marca, decididaEm: '2025-01-01' }, '2020-01-01', HOJE).permitida).toBe(true);
    // Fez 12 hoje: a decisão tomada aos 11 deixa de valer; a tomada hoje vale.
    expect(informacaoClinica({ ...marca, decididaEm: '2030-06-14' }, '2018-06-15', HOJE)).toEqual({ permitida: false, motivo: 'adolescente_requer_nova_decisao' });
    expect(informacaoClinica({ ...marca, decididaEm: HOJE }, '2018-06-15', HOJE).permitida).toBe(true);
    // Regra configurável: aceitar decisão anterior.
    expect(informacaoClinica({ ...marca, decididaEm: '2025-01-01' }, '2016-01-01', HOJE, null, { idadeInicioAdolescencia: 12, adolescenteCompartilhaComDecisaoAnterior: true }).permitida).toBe(true);
    // Sem decisão registrada (nunca automático), inclusive curatela.
    expect(informacaoClinica({ ...marca, decididaEm: null }, '2025-01-01', HOJE).motivo).toBe('sem_decisao_do_profissional');
    expect(informacaoClinica({ ...marca, tipo: 'curador', decididaEm: null }, '1980-01-01', HOJE).permitida).toBe(false);
    expect(pendenciasDoCadastro(true, [{ desde: '2020-01-01', ate: null, pagador: true, motivoInformacaoClinica: 'adolescente_requer_nova_decisao' }], HOJE)).toEqual([
      'revisar_informacao_clinica_adolescente',
    ]);
  });

  it('pendências do cadastro só para menor', () => {
    expect(pendenciasDoCadastro(true, [], HOJE)).toEqual(['menor_sem_responsavel_vigente', 'menor_sem_pagador_vigente']);
    expect(pendenciasDoCadastro(true, [{ desde: '2020-01-01', ate: null, pagador: false }], HOJE)).toEqual(['menor_sem_pagador_vigente']);
    expect(pendenciasDoCadastro(true, [{ desde: '2020-01-01', ate: null, pagador: true }], HOJE)).toEqual([]);
    expect(pendenciasDoCadastro(true, [{ desde: '2020-01-01', ate: HOJE, pagador: true }], HOJE)).toHaveLength(2);
    expect(pendenciasDoCadastro(false, [], HOJE)).toEqual([]);
    expect(pendenciasDoCadastro(null, [], HOJE)).toEqual([]);
  });
});

describe('validação', () => {
  it('ou pessoa nova ou responsavelId; tipo do enum; data não futura', () => {
    expect(validarNovoVinculo({ nome: 'Resp Ficticio', tipo: 'pai_mae' }, HOJE)).toMatchObject({ pessoa: { nome: 'Resp Ficticio' }, pagador: false });
    expect(() => validarNovoVinculo({ tipo: 'pai_mae' }, HOJE)).toThrow();
    expect(() => validarNovoVinculo({ nome: 'Resp', responsavelId: '00000000-0000-4000-8000-000000000000', tipo: 'tutor' }, HOJE)).toThrow();
    expect(() => validarNovoVinculo({ nome: 'Resp Ficticio', tipo: 'avo' }, HOJE)).toThrow();
    expect(() => validarNovoVinculo({ nome: 'Resp Ficticio', tipo: 'tutor', desde: '2030-06-16' }, HOJE)).toThrow();
    expect(() => validarNovoVinculo({ nome: 'Resp Ficticio', tipo: 'tutor', cpf: '11111111111' }, HOJE)).toThrow();
    expect(() => validarNovoVinculo({ nome: 'Resp Ficticio', tipo: 'tutor', tenantId: 'x' }, HOJE)).toThrow();
    expect(() => validarEncerramento({ motivo: 'maioridade', ate: '2030-06-16' }, HOJE)).toThrow();
    expect(validarEncerramento({ motivo: 'maioridade' }, HOJE)).toEqual({ motivo: 'maioridade' });
  });

  it('0055: apoiador exige termo e limites; campos do apoio só no apoiador; confirmação só para pai/mãe e tutor', () => {
    const apoio = { apoioReferencia: 'Termo ficticio 1', apoioEscopo: 'Limites ficticios' };
    expect(validarNovoVinculo({ nome: 'Apoiador Ficticio', tipo: 'apoiador', ...apoio }, HOJE)).toMatchObject({
      tipo: 'apoiador',
      curatela: { referencia: 'Termo ficticio 1', escopo: 'Limites ficticios' },
    });
    expect(() => validarNovoVinculo({ nome: 'Apoiador Ficticio', tipo: 'apoiador' }, HOJE)).toThrow();
    expect(() => validarNovoVinculo({ nome: 'Apoiador Ficticio', tipo: 'apoiador', apoioReferencia: 'Termo ficticio 1' }, HOJE)).toThrow();
    expect(() => validarNovoVinculo({ nome: 'Resp Ficticio', tipo: 'curador', curatelaReferencia: 'Proc 1', curatelaEscopo: 'Escopo', ...apoio }, HOJE)).toThrow();
    expect(validarNovoVinculo({ nome: 'Resp Ficticio', tipo: 'pai_mae', confirmaPacienteMaior: true }, HOJE)).toMatchObject({ confirmaPacienteMaior: true });
    expect(validarNovoVinculo({ nome: 'Resp Ficticio', tipo: 'tutor' }, HOJE)).toMatchObject({ confirmaPacienteMaior: false });
    expect(() => validarNovoVinculo({ nome: 'Resp Ficticio', tipo: 'representante', confirmaPacienteMaior: true }, HOJE)).toThrow();
    // B1: autorização do paciente só no apoiador, só `true` e só com a marca ligada.
    const liga = { recebeInformacaoClinica: true, justificativa: 'Paciente autorizou por escrito (ficticio)' };
    expect(validarNovoVinculo({ nome: 'Apoiador Ficticio', tipo: 'apoiador', ...apoio, ...liga, autorizacaoDoPaciente: true }, HOJE)).toMatchObject({ autorizacaoDoPaciente: true });
    expect(() => validarNovoVinculo({ nome: 'Apoiador Ficticio', tipo: 'apoiador', ...apoio, autorizacaoDoPaciente: true }, HOJE)).toThrow();
    expect(() => validarNovoVinculo({ nome: 'Apoiador Ficticio', tipo: 'apoiador', ...apoio, ...liga, autorizacaoDoPaciente: false }, HOJE)).toThrow();
    expect(() => validarNovoVinculo({ nome: 'Resp Ficticio', tipo: 'pai_mae', ...liga, autorizacaoDoPaciente: true }, HOJE)).toThrow();
  });

  it('recepção cadastra, mas não liga informação clínica', () => {
    expect(temPermissao(['recepcao'], 'responsaveis:escrever')).toBe(true);
    expect(temPermissao(['recepcao'], 'responsaveis:liberar_informacao_clinica')).toBe(false);
    expect(temPermissao(['financeiro'], 'responsaveis:ler')).toBe(true);
    expect(temPermissao(['financeiro'], 'responsaveis:escrever')).toBe(false);
    expect(temPermissao(['profissional'], 'responsaveis:liberar_informacao_clinica')).toBe(true);
    // A2 do #67: admin sem perfil clínico não liga a informação clínica.
    expect(temPermissao(['admin'], 'responsaveis:liberar_informacao_clinica')).toBe(false);
  });
});

describe('0056 (A1 b/c do #67): escopo e pedido de sigilo do adolescente', () => {
  // Adolescente de 14 anos em HOJE, decisão tomada já na adolescência.
  const TEEN = '2016-03-01';
  const decisao = { ...marca, decisaoInstante: '2030-06-15T12:00:00.000Z' };
  it('sem pedido vigente: a marca vale como antes', () => {
    expect(informacaoClinica({ ...decisao, sigiloPedidoEm: null }, TEEN, HOJE)).toEqual({ permitida: true, motivo: 'permitida' });
  });
  it('pedido vigente: negada, salvo decisão POSTERIOR que o supere por risco', () => {
    const pedido = '2030-06-15T10:00:00.000Z';
    expect(informacaoClinica({ ...decisao, sigiloPedidoEm: pedido }, TEEN, HOJE).motivo).toBe('sigilo_pedido_pelo_adolescente');
    expect(informacaoClinica({ ...decisao, sigiloPedidoEm: pedido, superaSigiloPorRisco: true }, TEEN, HOJE)).toEqual({ permitida: true, motivo: 'permitida' });
    // Exceção por risco tomada ANTES do pedido não vale contra ele.
    expect(informacaoClinica({ ...decisao, sigiloPedidoEm: '2030-06-15T13:00:00.000Z', superaSigiloPorRisco: true }, TEEN, HOJE).motivo).toBe('sigilo_pedido_pelo_adolescente');
    // Sem o instante da decisão não há como provar que ela é posterior: continua negada.
    expect(informacaoClinica({ ...decisao, decisaoInstante: null, sigiloPedidoEm: pedido, superaSigiloPorRisco: true }, TEEN, HOJE).motivo).toBe('sigilo_pedido_pelo_adolescente');
  });
  it('aos 18 anos o motivo é a maioridade, não o pedido', () => {
    expect(informacaoClinica({ ...decisao, sigiloPedidoEm: '2030-01-01T00:00:00.000Z' }, '2012-06-15', HOJE).motivo).toBe('paciente_maior_de_idade');
  });
  it('pedido só para adolescente com nascimento e não emancipado', () => {
    expect(faixaDoPedidoDeSigilo(TEEN, HOJE, null)).toBe('ok');
    expect(faixaDoPedidoDeSigilo('2020-01-01', HOJE, null)).toBe('sigilo_so_para_adolescente');
    expect(faixaDoPedidoDeSigilo('1990-01-01', HOJE, null)).toBe('sigilo_so_para_adolescente');
    expect(faixaDoPedidoDeSigilo('2013-01-01', HOJE, '2030-01-01')).toBe('sigilo_so_para_adolescente');
    expect(faixaDoPedidoDeSigilo(null, HOJE, null)).toBe('nascimento_nao_informado');
  });
  it('pedido que alcança o vínculo: o de todos ou o da pessoa do vínculo, o mais recente', () => {
    const pedidos = [
      { responsavelId: 'a', em: '2030-01-02T00:00:00.000Z' },
      { responsavelId: null, em: '2030-01-01T00:00:00.000Z' },
    ];
    expect(pedidoDeSigiloDoVinculo(pedidos, 'a')).toBe('2030-01-02T00:00:00.000Z');
    expect(pedidoDeSigiloDoVinculo(pedidos, 'b')).toBe('2030-01-01T00:00:00.000Z');
    expect(pedidoDeSigiloDoVinculo([{ responsavelId: 'a', em: '2030-01-02T00:00:00.000Z' }], 'b')).toBeNull();
  });
  it('validação: escopo e exceção por risco só com a marca ligada; ligada sem escopo = essencial', () => {
    const liga = { recebeInformacaoClinica: true, justificativa: 'Avaliacao ficticia do profissional' };
    expect(validarNovoVinculo({ nome: 'Resp Ficticio', tipo: 'pai_mae', ...liga }, HOJE)).toMatchObject({ escopoInformacao: 'essencial' });
    expect(validarNovoVinculo({ nome: 'Resp Ficticio', tipo: 'pai_mae', ...liga, escopoInformacao: 'integral', superaSigiloPorRisco: true }, HOJE)).toMatchObject({
      escopoInformacao: 'integral',
      superaSigiloPorRisco: true,
    });
    expect(validarNovoVinculo({ nome: 'Resp Ficticio', tipo: 'pai_mae' }, HOJE)).not.toHaveProperty('escopoInformacao');
    expect(() => validarNovoVinculo({ nome: 'Resp Ficticio', tipo: 'pai_mae', escopoInformacao: 'essencial' }, HOJE)).toThrow();
    expect(() => validarNovoVinculo({ nome: 'Resp Ficticio', tipo: 'pai_mae', ...liga, escopoInformacao: 'tudo' }, HOJE)).toThrow();
    expect(() => validarNovoVinculo({ nome: 'Resp Ficticio', tipo: 'pai_mae', ...liga, superaSigiloPorRisco: false }, HOJE)).toThrow();
    expect(() => validarAlteracaoVinculo({ superaSigiloPorRisco: true })).toThrow();
    expect(validarAlteracaoVinculo({ ...liga, escopoInformacao: 'integral' })).toMatchObject({ escopoInformacao: 'integral' });
    expect(validarPedidoDeSigilo({})).toEqual({});
    expect(validarPedidoDeSigilo({ vinculoId: '00000000-0000-4000-8000-000000000000' })).toEqual({ vinculoId: '00000000-0000-4000-8000-000000000000' });
    expect(() => validarPedidoDeSigilo({ vinculoId: 'x' })).toThrow();
    expect(() => validarPedidoDeSigilo({ motivo: 'texto' })).toThrow();
  });
});
