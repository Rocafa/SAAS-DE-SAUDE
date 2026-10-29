import { describe, expect, it } from 'vitest';
import { temPermissao } from '../auth/perfis';
import { faixaEtariaEm, idadeEm, informacaoClinica, menorEm, pendenciasDoCadastro, REGRA_INFORMACAO_CLINICA, tipoRepresentaPaciente, vigenteEm } from './responsaveis-regras';
import { validarEncerramento, validarNovoVinculo } from './responsaveis.validation';

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

  it('0055: apoiador recebe só com a marca e a decisão do profissional; não representa', () => {
    expect(informacaoClinica({ ...marca, tipo: 'apoiador' }, '1980-01-01', HOJE).permitida).toBe(true);
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
