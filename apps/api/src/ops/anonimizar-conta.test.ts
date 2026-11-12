import { describe, expect, it, vi } from 'vitest';
import { AnonimizacaoRecusada } from '../modules/auth/better-auth/anonimizacao';
import { executarComando, type DependenciasDoComando } from './anonimizar-conta';

const USUARIO = '0b6f2c4e-1d2a-4f3b-8c5d-6e7f8a9b0c1d';
const OPERADOR = '11111111-2222-4333-8444-555555555555';
const ARGS = ['--usuario', USUARIO, '--chamado', 'LGPD-12', '--operador', OPERADOR];
const ENV = { CONFIRMA_ANONIMIZACAO: USUARIO } as NodeJS.ProcessEnv;

function deps(over: Partial<DependenciasDoComando> = {}): DependenciasDoComando & { anonimizar: ReturnType<typeof vi.fn> } {
  return {
    anonimizar: vi.fn(() => Promise.resolve({ repetida: false, clinicas: 2 })),
    conferir: vi.fn(() => Promise.resolve([])),
    ...over,
  } as never;
}

describe('comando de anonimização (B10, R4 e R8 do parecer de 12/11)', () => {
  it('caminho feliz: uma linha só, com o uuid e a contagem', async () => {
    expect(await executarComando(ARGS, ENV, deps())).toEqual({ codigo: 'ok', linha: `ok ${USUARIO} clinicas=2` });
  });

  it('repetição sai como ok, marcada', async () => {
    const d = deps({ anonimizar: vi.fn(() => Promise.resolve({ repetida: true, clinicas: 1 })) });
    expect((await executarComando(ARGS, ENV, d)).linha).toBe(`ok ${USUARIO} clinicas=1 repetida`);
  });

  it('trava com outro uuid (ou ausente) recusa ANTES de qualquer escrita', async () => {
    for (const env of [{ CONFIRMA_ANONIMIZACAO: OPERADOR }, {}] as NodeJS.ProcessEnv[]) {
      const d = deps();
      expect(await executarComando(ARGS, env, d)).toEqual({ codigo: 'trava_incorreta', linha: 'trava_incorreta' });
      expect(d.anonimizar).not.toHaveBeenCalled();
    }
  });

  it('argumento faltando, repetido ou desconhecido: uso_incorreto, sem escrever', async () => {
    for (const argv of [ARGS.slice(0, 4), [...ARGS, '--usuario', USUARIO], [...ARGS.slice(0, 4), '--nome', 'x']]) {
      const d = deps();
      expect((await executarComando(argv, ENV, d)).codigo).toBe('uso_incorreto');
      expect(d.anonimizar).not.toHaveBeenCalled();
    }
  });

  it('recusa da função vira o código fixo; erro do driver nunca aparece na saída', async () => {
    const recusada = deps({ anonimizar: vi.fn(() => Promise.reject(new AnonimizacaoRecusada('nao_encontrada'))) });
    expect(await executarComando(ARGS, ENV, recusada)).toEqual({ codigo: 'nao_encontrada', linha: 'nao_encontrada' });
    const driver = deps({ anonimizar: vi.fn(() => Promise.reject(new Error('duplicate key value: email=pessoa@exemplo.test'))) });
    const saida = await executarComando(ARGS, ENV, driver);
    expect(saida).toEqual({ codigo: 'erro_inesperado', linha: 'erro_inesperado' });
    expect(saida.linha).not.toContain('@');
  });

  it('conferência no banco com falta: não imprime ok', async () => {
    const d = deps({ conferir: vi.fn(() => Promise.resolve(['sessoes'])) });
    expect(await executarComando(ARGS, ENV, d)).toEqual({ codigo: 'conferencia_falhou', linha: 'conferencia_falhou' });
  });
});
