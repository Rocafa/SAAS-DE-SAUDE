import { describe, expect, it } from 'vitest';
import { criarApiFake } from './api/fake';
import { MODELOS, diasPorExtenso, ehRestrito, faltasParaAssinar, modeloDoProfissional, textoAtestado, textoDeclaracao, validarCid } from './prontuario';

describe('modelos por nicho', () => {
  it('escolhe pelo profissional', () => {
    expect(modeloDoProfissional({ especialidade: 'Fisioterapia' })).toBe('fisio');
    expect(modeloDoProfissional({ especialidade: 'Terapia ocupacional' })).toBe('to');
    expect(modeloDoProfissional({ especialidade: 'Psicologia' })).toBe('psicologia');
  });
  it('só psicologia é compartimento sigiloso', () => {
    expect(ehRestrito('psicologia')).toBe(true);
    expect(ehRestrito('fisio')).toBe(false);
  });
  it('todo modelo tem pelo menos um campo obrigatório e rótulos sem jargão', () => {
    for (const m of Object.values(MODELOS)) {
      expect(m.campos.some((c) => c.obrigatorio)).toBe(true);
      for (const c of m.campos) expect(c.rotulo).not.toMatch(/registro|entidade|submeter|tenant/i);
    }
  });
  it('faltas para assinar dizem o campo', () => {
    expect(faltasParaAssinar('fisio', {})).toEqual(['Falta preencher “Como o paciente chegou hoje”.', 'Falta preencher “O que foi feito na sessão”.']);
    expect(faltasParaAssinar('fisio', { queixa: 'x', conduta: 'y' })).toEqual([]);
    expect(faltasParaAssinar('fisio', { queixa: '   ', conduta: 'y' })).toHaveLength(1);
  });
});

describe('documentos', () => {
  it('dias por extenso e limite', () => {
    expect(diasPorExtenso(1)).toBe('1 (um) dia');
    expect(diasPorExtenso(3)).toBe('3 (três) dias');
    expect(() => diasPorExtenso(0)).toThrow();
    expect(() => diasPorExtenso(16)).toThrow(/INSS/);
  });
  it('atestado só leva o CID com autorização', () => {
    const base = { paciente: 'Maria Silva', profissional: 'Dra. X', registro: 'R', data: '12 de outubro de 2026', dias: 2, cid: 'm54.5' };
    expect(textoAtestado({ ...base, autorizouCid: false })).not.toContain('CID');
    expect(textoAtestado({ ...base, autorizouCid: true })).toContain('CID: M54.5');
    expect(textoAtestado({ ...base, autorizouCid: false })).toContain('2 (dois) dias');
  });
  it('declaração de comparecimento', () => {
    expect(textoDeclaracao({ paciente: 'Ana', data: '12 de outubro de 2026', inicio: '09:00', fim: '10:00' })).toBe(
      'Declaro, para os devidos fins, que Ana compareceu a atendimento nesta clínica em 12 de outubro de 2026, das 09:00 às 10:00.',
    );
  });
  it('CID no formato', () => {
    expect(validarCid('')).toBeNull();
    expect(validarCid('M54.5')).toBeNull();
    expect(validarCid('dor nas costas')).toMatch(/formato/);
  });
});

describe('fake: registro clínico', () => {
  const agora = new Date(2026, 9, 12, 10);

  it('psicologia fica ilegível para quem não é o autor', async () => {
    const api = criarApiFake({ agora });
    const comoRecepcao = await api.listarRegistros('p04');
    const psi = comoRecepcao.find((r) => r.restrito)!;
    expect(psi.campos).toEqual({});
    await api.entrarComo('u3');
    const comoPsicologo = await api.listarRegistros('p04');
    expect(Object.keys(comoPsicologo.find((r) => r.restrito)!.campos).length).toBeGreaterThan(0);
  });

  it('só o profissional do atendimento escreve e assina; assinado não muda', async () => {
    const api = criarApiFake({ agora });
    const ag = (await api.listarAgendamentos({ de: '2026-10-12', ate: '2026-10-12', profissionalId: 'pr1' })).find((a) => a.status === 'chegou')!;
    await expect(api.salvarRascunho(ag.id, { queixa: 'x' })).rejects.toThrow(/Só o profissional/);
    await api.entrarComo('u2');
    const r = await api.salvarRascunho(ag.id, { queixa: 'Chegou bem' });
    await expect(api.assinarRegistro(r.id)).rejects.toThrow(/O que foi feito na sessão/);
    await api.salvarRascunho(ag.id, { queixa: 'Chegou bem', conduta: 'Exercícios' });
    const assinado = await api.assinarRegistro(r.id);
    expect(assinado.status).toBe('assinado');
    expect((await api.listarAgendamentos()).find((a) => a.id === ag.id)?.status).toBe('atendido');
    await expect(api.salvarRascunho(ag.id, { queixa: 'mudei' })).rejects.toThrow(/adendo/);
    const comAdendo = await api.adicionarAdendo(r.id, 'Esqueci: orientei gelo.');
    expect(comAdendo.adendos).toHaveLength(1);
    expect(comAdendo.campos.queixa).toBe('Chegou bem');
  });
});
