import { describe, expect, it } from 'vitest';
import {
  CAMPOS_CLINICOS_PROIBIDOS,
  CONTRATO_PORTAL,
  camposClinicosNoContrato,
  conferirRespostaPortal,
  caminhoPortal,
} from '../src/api-portal.js';
import { f } from '../src/forma.js';

describe('api-portal: contrato e campos clínicos', () => {
  it('CONTRATO_PORTAL tem rotas esperadas', () => {
    const rotas = Object.keys(CONTRATO_PORTAL);
    expect(rotas).toContain('GET /portal/vinculos');
    expect(rotas).toContain('GET /portal/sessao');
    expect(rotas).toContain('GET /portal/consultas');
    expect(rotas).toContain('POST /portal/consultas/:id/confirmar');
    expect(rotas.length).toBeGreaterThan(10);
  });

  it('toda rota tem resposta, método e erros definidos', () => {
    for (const [_rota, def] of Object.entries(CONTRATO_PORTAL)) {
      void _rota;
      expect(def.metodo).toMatch(/^(GET|POST)$/);
      expect(def.resposta).toBeDefined();
      expect(Array.isArray(def.erros)).toBe(true);
      expect(typeof def.noVinculo).toBe('boolean');
    }
  });

  it('CAMPOS_CLINICOS_PROIBIDOS não está vazio', () => {
    expect(CAMPOS_CLINICOS_PROIBIDOS.length).toBeGreaterThan(10);
    expect(CAMPOS_CLINICOS_PROIBIDOS).toContain('diagnostico');
    expect(CAMPOS_CLINICOS_PROIBIDOS).toContain('especialidade');
  });

  it('camposClinicosNoContrato retorna vazio para contrato oficial (sem campo clínico)', () => {
    const achados = camposClinicosNoContrato();
    expect(achados).toEqual([]);
  });

  it('camposClinicosNoContrato detecta campo proibido injetado (teste negativo)', () => {
    const contratoComCampoClinico = {
      'GET /teste': {
        metodo: 'GET' as const,
        caminho: '/teste',
        sucesso: 200 as const,
        corpo: null,
        noVinculo: false,
        resposta: f.obj({
          id: f.texto,
          diagnostico: f.texto,
        }),
        erros: [],
      },
    } as const;

    const achados = camposClinicosNoContrato(contratoComCampoClinico);
    expect(achados).toContain('diagnostico');
  });

  it('camposClinicosNoContrato detecta múltiplos campos proibidos', () => {
    const contratoComVarios = {
      'GET /teste1': {
        metodo: 'GET' as const,
        caminho: '/teste1',
        sucesso: 200 as const,
        corpo: null,
        noVinculo: false,
        resposta: f.obj({
          especialidade: f.texto,
          cid: f.texto,
        }),
        erros: [],
      },
      'GET /teste2': {
        metodo: 'GET' as const,
        caminho: '/teste2',
        sucesso: 200 as const,
        corpo: null,
        noVinculo: false,
        resposta: f.obj({
          diagnostico: f.texto,
        }),
        erros: [],
      },
    } as const;

    const achados = camposClinicosNoContrato(contratoComVarios);
    expect(achados.sort()).toEqual(['cid', 'diagnostico', 'especialidade']);
  });

  it('conferirRespostaPortal valida resposta contra rota', () => {
    const erros = conferirRespostaPortal('GET /portal/vinculos', [{ vinculoId: 'v1', clinica: 'c1', primeiroNome: 'Ana', agindoComo: 'titular' }]);
    expect(erros).toEqual([]);
  });

  it('conferirRespostaPortal detecta campo faltando na resposta', () => {
    const erros = conferirRespostaPortal('GET /portal/vinculos', [{ vinculoId: 'v1' }]);
    expect(erros.length).toBeGreaterThan(0);
    expect(erros.some((e) => e.includes('clinica'))).toBe(true);
  });

  it('caminhoPortal substitui parâmetros corretamente', () => {
    expect(caminhoPortal('POST /portal/consultas/:id/confirmar', { id: 'abc123' })).toBe('/portal/consultas/abc123/confirmar');
    expect(caminhoPortal('GET /portal/recibos/:id', { id: 'rec-456' })).toBe('/portal/recibos/rec-456');
  });

  it('caminhoPortal lança erro se parâmetro faltar', () => {
    expect(() => caminhoPortal('POST /portal/consultas/:id/confirmar', {})).toThrow('parâmetro ausente: id');
  });
});