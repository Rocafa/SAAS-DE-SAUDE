import { describe, expect, it, vi } from 'vitest';
import { RecuperacaoPeloSuporteRecusada } from '../modules/auth/better-auth/recuperacao-pelo-suporte';
import { EntregaPendente, FalhaDoSsm } from './parametros-ssm';
import { executarComando, parametroDaEntrega, type DependenciasDoComando } from './recuperar-admin-unico';

const CLINICA = '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f';
const USUARIO = '0b6f2c4e-1d2a-4f3b-8c5d-6e7f8a9b0c1d';
const OPERADOR = '11111111-2222-4333-8444-555555555555';
const ARGS = ['--clinica', CLINICA, '--usuario', USUARIO, '--chamado', 'SUP-42', '--operador', OPERADOR, '--motivo', 'perdeu_o_aparelho'];
const ENV = { CONFIRMA_RECUPERACAO: USUARIO } as NodeJS.ProcessEnv;
const TOKEN_FICTICIO = 'token-ficticio-de-teste-0123456789abcdef';
const EXPIRA = '2026-11-18T12:00:00.000Z';

type Dubles = DependenciasDoComando & { emitir: ReturnType<typeof vi.fn>; parametros: { gravar: ReturnType<typeof vi.fn>; apagar: ReturnType<typeof vi.fn> } };

function deps(over: Partial<DependenciasDoComando> = {}): Dubles {
  return {
    parametros: { gravar: vi.fn(() => Promise.resolve()), apagar: vi.fn(() => Promise.resolve()) },
    emitir: vi.fn(async (_p: unknown, guardar: (t: string) => Promise<void>) => {
      await guardar(TOKEN_FICTICIO);
      return { expiraEm: EXPIRA, sessoesDerrubadas: 0 };
    }),
    ...over,
  } as never;
}

describe('comando da recuperação do fator do admin único (B12, R3, R4, R5 e R7 do parecer de 16/11)', () => {
  it('caminho feliz: token só no parâmetro de entrega; a linha tem o uuid, o vencimento e a contagem, sem o token', async () => {
    const d = deps();
    const saida = await executarComando(ARGS, ENV, d);
    expect(saida).toEqual({ codigo: 'ok', linha: `ok ${USUARIO} expira=${EXPIRA} sessoes=0` });
    expect(d.parametros.gravar).toHaveBeenCalledWith(parametroDaEntrega(USUARIO), TOKEN_FICTICIO);
    expect(d.parametros.apagar).not.toHaveBeenCalled();
    expect(saida.linha).not.toContain(TOKEN_FICTICIO);
    expect(saida.linha).not.toContain(OPERADOR);
    expect(saida.linha).not.toContain('SUP-');
    expect(d.emitir.mock.calls[0]?.[0]).toEqual({ clinicaId: CLINICA, usuarioId: USUARIO, chamado: 'SUP-42', operador: OPERADOR, motivo: 'perdeu_o_aparelho', derrubarSessoes: false });
  });

  it('--derrubar-sessoes em qualquer posição chega à função', async () => {
    for (const argv of [[...ARGS, '--derrubar-sessoes'], ['--derrubar-sessoes', ...ARGS]]) {
      const d = deps();
      expect((await executarComando(argv, ENV, d)).codigo).toBe('ok');
      expect(d.emitir.mock.calls[0]?.[0]).toMatchObject({ derrubarSessoes: true });
    }
  });

  it('trava com outro uuid (ou ausente) recusa ANTES de qualquer escrita', async () => {
    for (const env of [{ CONFIRMA_RECUPERACAO: OPERADOR }, {}] as NodeJS.ProcessEnv[]) {
      const d = deps();
      expect(await executarComando(ARGS, env, d)).toEqual({ codigo: 'trava_incorreta', linha: 'trava_incorreta' });
      expect(d.emitir).not.toHaveBeenCalled();
      expect(d.parametros.gravar).not.toHaveBeenCalled();
    }
  });

  it('argumento faltando, repetido, desconhecido ou sem valor: uso_incorreto, sem escrever', async () => {
    for (const argv of [
      ARGS.slice(0, 8),
      [...ARGS, '--usuario', USUARIO],
      [...ARGS, '--nome', 'x'],
      [...ARGS, '--derrubar-sessoes', '--derrubar-sessoes'],
      ['--clinica', '--usuario', USUARIO, ...ARGS.slice(4)],
      ARGS.map((a) => (a === USUARIO ? 'nao-e-uuid' : a)),
    ]) {
      const d = deps();
      expect((await executarComando(argv, { CONFIRMA_RECUPERACAO: 'nao-e-uuid', ...ENV }, d)).codigo).toBe('uso_incorreto');
      expect(d.emitir).not.toHaveBeenCalled();
    }
  });

  it('recusa da função vira o código fixo e nada fica no SSM', async () => {
    for (const codigo of ['ha_outro_admin', 'nao_e_admin', 'teto', 'chamado_invalido', 'conta_inativa', 'derrubar_sessoes_obrigatorio'] as const) {
      const d = deps({ emitir: vi.fn(() => Promise.reject(new RecuperacaoPeloSuporteRecusada(codigo))) });
      expect(await executarComando(ARGS, ENV, d)).toEqual({ codigo, linha: codigo });
      expect(d.parametros.gravar).not.toHaveBeenCalled();
      // Recusa não apaga a entrega pendente de uma rodada anterior.
      expect(d.parametros.apagar).not.toHaveBeenCalled();
    }
  });

  it('falha depois de gravar o token: apaga o parâmetro e sai com erro, sem a mensagem do driver', async () => {
    const d = deps({
      emitir: vi.fn(async (_p: unknown, guardar: (t: string) => Promise<void>) => {
        await guardar(TOKEN_FICTICIO);
        throw new Error('insert or update on table "audit_log": pessoa@exemplo.test');
      }),
    });
    const saida = await executarComando(ARGS, ENV, d);
    expect(saida).toEqual({ codigo: 'erro', linha: 'erro' });
    expect(saida.linha).not.toContain('@');
    expect(d.parametros.apagar).toHaveBeenCalledWith(parametroDaEntrega(USUARIO));
  });

  it('entrega pendente de rodada anterior: entrega_pendente e o parâmetro anterior NÃO é apagado', async () => {
    const d = deps();
    d.parametros.gravar.mockRejectedValueOnce(new EntregaPendente());
    expect(await executarComando(ARGS, ENV, d)).toEqual({ codigo: 'entrega_pendente', linha: 'entrega_pendente' });
    expect(d.parametros.apagar).not.toHaveBeenCalled();
  });

  it('falha ambígua do SSM ao gravar (pode ter gravado): apaga o parâmetro desta rodada e sai com erro', async () => {
    const d = deps();
    d.parametros.gravar.mockRejectedValueOnce(new FalhaDoSsm('gravar'));
    expect(await executarComando(ARGS, ENV, d)).toEqual({ codigo: 'erro', linha: 'erro' });
    expect(d.parametros.apagar).toHaveBeenCalledWith(parametroDaEntrega(USUARIO));
  });

  it('SSM fora ao apagar: continua erro (código fixo)', async () => {
    const d = deps({
      emitir: vi.fn(async (_p: unknown, guardar: (t: string) => Promise<void>) => {
        await guardar(TOKEN_FICTICIO);
        throw new Error('falha');
      }),
    });
    d.parametros.apagar.mockRejectedValueOnce(new Error('AccessDenied arn:aws:ssm:...'));
    expect(await executarComando(ARGS, ENV, d)).toEqual({ codigo: 'erro', linha: 'erro' });
  });
});
