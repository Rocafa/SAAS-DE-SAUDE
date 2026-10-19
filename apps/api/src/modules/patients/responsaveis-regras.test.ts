import { describe, expect, it } from 'vitest';
import { temPermissao } from '../auth/perfis';
import { idadeEm, informacaoClinica, menorEm, pendenciasDoCadastro, vigenteEm } from './responsaveis-regras';
import { validarEncerramento, validarNovoVinculo } from './responsaveis.validation';

const HOJE = '2030-06-15';
const marca = { tipo: 'pai_mae' as const, recebeInformacaoClinica: true, desde: '2020-01-01', ate: null };

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

  it('sem marca, fora da vigência ou sem nascimento: negada', () => {
    expect(informacaoClinica({ ...marca, recebeInformacaoClinica: false }, '2020-01-01', HOJE).motivo).toBe('marca_desligada');
    expect(informacaoClinica({ ...marca, ate: HOJE }, '2020-01-01', HOJE).motivo).toBe('vinculo_nao_vigente');
    expect(informacaoClinica({ ...marca, ate: HOJE, tipo: 'curador' }, '1980-01-01', HOJE).motivo).toBe('vinculo_nao_vigente');
    expect(informacaoClinica(marca, null, HOJE).motivo).toBe('sem_data_de_nascimento');
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

  it('recepção cadastra, mas não liga informação clínica', () => {
    expect(temPermissao(['recepcao'], 'responsaveis:escrever')).toBe(true);
    expect(temPermissao(['recepcao'], 'responsaveis:liberar_informacao_clinica')).toBe(false);
    expect(temPermissao(['financeiro'], 'responsaveis:ler')).toBe(true);
    expect(temPermissao(['financeiro'], 'responsaveis:escrever')).toBe(false);
    expect(temPermissao(['profissional'], 'responsaveis:liberar_informacao_clinica')).toBe(true);
  });
});
