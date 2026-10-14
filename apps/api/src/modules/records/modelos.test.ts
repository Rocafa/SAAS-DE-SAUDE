import { describe, expect, it } from 'vitest';
import { EntradaInvalidaError } from '../../common/validacao';
import { faltasParaFinalizar, MAX_TEXTO_CLINICO, modeloPelaEspecialidade, validarConteudo } from './modelos';
import { hashDaFinalizacao, podeVerConteudo } from './prontuario-regras';

function campos(fn: () => unknown): string[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof EntradaInvalidaError) return [...e.campos];
    throw e;
  }
  return [];
}

describe('modelos de registro por nicho', () => {
  it('fisio aceita textos com quebra de linha, medidas e plano de sessões; normaliza e descarta vazios', () => {
    const c = validarConteudo('fisio', {
      queixa: '  Dor ao subir escada\r\nPiora a noite ',
      avaliacao: '',
      medidas: [
        { tipo: 'eva', valor: 7 },
        { tipo: 'goniometria', rotulo: 'flexao de joelho D', valor: 95.5 },
        { tipo: 'forca', valor: 4 },
      ],
      planoDeSessoes: { totalSessoes: 10, metas: [{ descricao: 'Marcha sem apoio', progresso: 30 }] },
    });
    expect(c).toEqual({
      queixa: 'Dor ao subir escada\nPiora a noite',
      medidas: [
        { tipo: 'eva', valor: 7 },
        { tipo: 'goniometria', rotulo: 'flexao de joelho D', valor: 95.5 },
        { tipo: 'forca', valor: 4 },
      ],
      planoDeSessoes: { totalSessoes: 10, metas: [{ descricao: 'Marcha sem apoio', progresso: 30 }] },
    });
  });

  it('recusa chave desconhecida, campo de outro nicho e não objeto (sem eco do valor)', () => {
    expect(campos(() => validarConteudo('fisio', { tema: 'x' }))).toEqual(['campo_desconhecido']);
    expect(campos(() => validarConteudo('psicologia', { medidas: [] }))).toEqual(['campo_desconhecido']);
    expect(campos(() => validarConteudo('fisio', 'texto solto'))).toEqual(['conteudo']);
    expect(campos(() => validarConteudo('fisio', [1]))).toEqual(['conteudo']);
  });

  it('faixas das medidas: EVA 0–10 inteiro, goniometria com rótulo, força MRC 0–5, tipo desconhecido', () => {
    expect(campos(() => validarConteudo('fisio', { medidas: [{ tipo: 'eva', valor: 11 }] }))).toEqual(['conteudo.medidas.0.valor']);
    expect(campos(() => validarConteudo('fisio', { medidas: [{ tipo: 'eva', valor: 2.5 }] }))).toEqual(['conteudo.medidas.0.valor']);
    expect(campos(() => validarConteudo('fisio', { medidas: [{ tipo: 'goniometria', valor: 90 }] }))).toEqual(['conteudo.medidas.0.rotulo']);
    expect(campos(() => validarConteudo('to', { medidas: [{ tipo: 'forca', valor: 6 }] }))).toEqual(['conteudo.medidas.0.valor']);
    expect(campos(() => validarConteudo('fisio', { medidas: [{ tipo: 'peso', valor: 1 }] }))).toEqual(['conteudo.medidas.0.tipo']);
    expect(campos(() => validarConteudo('fisio', { medidas: [{ tipo: 'eva', valor: 1, extra: 1 }] }))).toEqual(['conteudo.medidas.0']);
    expect(campos(() => validarConteudo('fisio', { medidas: Array.from({ length: 51 }, () => ({ tipo: 'eva', valor: 1 })) }))).toEqual([
      'conteudo.medidas',
    ]);
  });

  it('plano de sessões: total 1–200, frequência 1–7, metas com progresso 0–100', () => {
    expect(campos(() => validarConteudo('fisio', { planoDeSessoes: { totalSessoes: 0, metas: [] } }))).toEqual([
      'conteudo.planoDeSessoes.totalSessoes',
    ]);
    expect(
      campos(() => validarConteudo('psicologia', { planoDeSessoes: { totalSessoes: 12, frequenciaSemanal: 8, metas: [{ descricao: 'x', progresso: 101 }] } })),
    ).toEqual(['conteudo.planoDeSessoes.frequenciaSemanal', 'conteudo.planoDeSessoes.metas.0.progresso']);
  });

  it('texto: limite de tamanho e caracteres de controle (tabulação e quebra de linha passam)', () => {
    expect(campos(() => validarConteudo('psicologia', { tema: 'a'.repeat(MAX_TEXTO_CLINICO + 1) }))).toEqual(['conteudo.tema']);
    expect(campos(() => validarConteudo('psicologia', { tema: 'a\u0007b' }))).toEqual(['conteudo.tema']);
    expect(validarConteudo('psicologia', { tema: 'a\tb\nc' })).toEqual({ tema: 'a\tb\nc' });
  });

  it('finalização cobra os obrigatórios de cada modelo', () => {
    expect(faltasParaFinalizar('fisio', { queixa: 'x' })).toEqual(['conduta']);
    expect(faltasParaFinalizar('to', { queixa: 'x', conduta: 'y' })).toEqual([]);
    expect(faltasParaFinalizar('psicologia', {})).toEqual(['tema', 'evolucao']);
  });

  it('modelo padrão pela especialidade', () => {
    expect(modeloPelaEspecialidade('Psicóloga clínica')).toBe('psicologia');
    expect(modeloPelaEspecialidade('Terapia Ocupacional')).toBe('to');
    expect(modeloPelaEspecialidade('TO')).toBe('to');
    expect(modeloPelaEspecialidade('Fisioterapia')).toBe('fisio');
  });
});

describe('regras do prontuário', () => {
  const psi = { compartment: 'psicologia' as const, authorUserId: 'autor' };
  it('compartimento de psicologia: restrito ao autor por padrão; prontuário único abre para quem tem vínculo', () => {
    expect(podeVerConteudo(psi, 'autor', 'restrito_ao_autor')).toBe(true);
    expect(podeVerConteudo(psi, 'outro', 'restrito_ao_autor')).toBe(false);
    expect(podeVerConteudo(psi, 'outro', 'prontuario_unico')).toBe(true);
    expect(podeVerConteudo({ compartment: 'geral', authorUserId: 'autor' }, 'outro', 'restrito_ao_autor')).toBe(true);
  });

  it('hash da finalização: determinístico e sensível a qualquer campo', () => {
    const base = {
      tenantId: 't',
      encounterId: 'e',
      versionId: 'v',
      version: 2,
      template: 'fisio',
      templateVersion: 1,
      contentEnc: 'v1:a:b:c:d',
      signedAt: new Date('2026-10-14T12:00:00Z'),
      signedBy: 'u',
    };
    const h = hashDaFinalizacao(base);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashDaFinalizacao({ ...base })).toBe(h);
    expect(hashDaFinalizacao({ ...base, contentEnc: 'v1:a:b:c:e' })).not.toBe(h);
    expect(hashDaFinalizacao({ ...base, version: 3 })).not.toBe(h);
  });
});
