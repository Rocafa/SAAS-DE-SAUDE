import { describe, expect, it } from 'vitest';
import { criarApiFake } from './api/fake';
import { CONSENTIMENTOS, DIREITOS, PRAZO_RESPOSTA_DIAS, permitido, prazoResposta, protocolo } from './portal';

const hoje = new Date(2026, 9, 12, 10);

describe('portal: regras', () => {
  it('"não respondido" vale como NÃO (ressalva R1 do Guardião)', () => {
    expect(permitido('sim')).toBe(true);
    expect(permitido('nao')).toBe(false);
    expect(permitido('nao_respondido')).toBe(false);
    expect(permitido(undefined)).toBe(false);
  });
  it('prazo de resposta e protocolo', () => {
    expect(PRAZO_RESPOSTA_DIAS).toBe(15);
    expect(prazoResposta('2026-10-12')).toBe('2026-10-27');
    expect(protocolo('2026-10-12', 7)).toBe('20261012-0007');
  });
  it('textos sem jargão jurídico nem técnico', () => {
    for (const t of [...DIREITOS.map((d) => d.titulo + d.explicacao), ...CONSENTIMENTOS.map((c) => c.titulo + c.explicacao)]) {
      expect(t).not.toMatch(/titular|controlador|tratamento de dados|tenant|registro de|submeter/i);
    }
  });
  it('apagar explica a guarda legal do prontuário', () => {
    expect(DIREITOS.find((d) => d.tipo === 'apagar')?.explicacao).toMatch(/prazo da lei/);
  });
});

describe('fake: consentimento e pedidos do paciente', () => {
  it('consentimento muda e o desfazer volta ao estado anterior, inclusive "não respondido"', async () => {
    const api = criarApiFake({ agora: hoje });
    expect((await api.listarConsentimentos('p01')).escriba_ia).toBe('nao_respondido');
    const anterior = await api.alterarConsentimento('p01', 'escriba_ia', 'sim');
    expect(anterior).toBe('nao_respondido');
    expect((await api.listarConsentimentos('p01')).escriba_ia).toBe('sim');
    await api.voltarConsentimento('p01', 'escriba_ia', anterior);
    expect((await api.listarConsentimentos('p01')).escriba_ia).toBe('nao_respondido');
  });
  it('pedido gera protocolo e prazo; correção exige dizer o que está errado', async () => {
    const api = criarApiFake({ agora: hoje });
    await expect(api.abrirPedidoTitular('p01', 'corrigir', '  ')).rejects.toThrow(/o que está errado/);
    const p = await api.abrirPedidoTitular('p01', 'baixar');
    expect(p).toMatchObject({ protocolo: '20261012-0001', prazo: '2026-10-27', situacao: 'aberto' });
    expect(p).not.toHaveProperty('pacienteId');
    expect(await api.listarPedidosTitular('p01')).toHaveLength(1);
    expect(await api.listarPedidosTitular('p02')).toHaveLength(0);
  });
});
