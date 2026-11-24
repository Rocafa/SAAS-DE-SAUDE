import { describe, expect, it, vi } from 'vitest';
import { TrocaRecusada } from '../modules/auth/better-auth/troca-do-admin';
import { EntregaPendente, FalhaDoSsm } from './parametros-ssm';
import { executarComando, parametroDaEntrega, parametroDoPedido, type DependenciasDoComando } from './trocar-admin-unico';

// Dados fictícios.
const PEDIDO = '7d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const CLINICA = '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f';
const USUARIO = '0b6f2c4e-1d2a-4f3b-8c5d-6e7f8a9b0c1d';
const OPERADOR_A = '11111111-2222-4333-8444-555555555555';
const OPERADOR_B = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const EMAIL_FICTICIO = 'conta.nova.ficticia@exemplo.test';
const TOKEN_FICTICIO = 'token-ficticio-de-teste-0123456789abcdef';
const ENV = { CONFIRMA_TROCA: PEDIDO } as NodeJS.ProcessEnv;
const VIVA_VOZ = '2026-11-24T12:00:00Z';
const PEDIR = ['--fase', 'pedir', '--pedido', PEDIDO, '--clinica', CLINICA, '--usuario', USUARIO, '--chamado', 'SUP-77', '--contrato', 'CTR-9', '--motivo', 'perdeu_senha_e_fator', '--operador', OPERADOR_A, '--viva-voz', VIVA_VOZ];
const EMITIR = ['--fase', 'emitir', '--pedido', PEDIDO, '--chamado', 'SUP-77', '--operador', OPERADOR_B, '--viva-voz', VIVA_VOZ];
const CANCELAR = ['--fase', 'cancelar', '--pedido', PEDIDO, '--chamado', 'SUP-77', '--operador', OPERADOR_B, '--por', 'contrato'];

type Fn = ReturnType<typeof vi.fn>;
type Dubles = DependenciasDoComando & { pedir: Fn; emitir: Fn; cancelar: Fn; parametros: { ler: Fn; gravar: Fn; apagar: Fn } };

function deps(over: Partial<Record<'pedir' | 'emitir' | 'cancelar' | 'ler' | 'gravar' | 'apagar', Fn>> = {}): Dubles {
  return {
    parametros: {
      ler: over.ler ?? vi.fn(() => Promise.resolve(JSON.stringify({ email: EMAIL_FICTICIO }))),
      gravar: over.gravar ?? vi.fn(() => Promise.resolve()),
      apagar: over.apagar ?? vi.fn(() => Promise.resolve()),
    },
    pedir: over.pedir ?? vi.fn(() => Promise.resolve({ liberaEm: '2026-11-26T12:00:00.000Z', sessoesDerrubadas: 0 })),
    emitir:
      over.emitir ??
      vi.fn(async (_e: unknown, guardar: (t: string) => Promise<void>) => {
        await guardar(TOKEN_FICTICIO);
        return { tipo: 'ativacao', clinicaId: CLINICA, expiraEm: '2026-11-27T12:00:00.000Z' };
      }),
    cancelar: over.cancelar ?? vi.fn(() => Promise.resolve({ clinicaId: CLINICA })),
  } as never;
}

describe('comando da troca do admin único (B13): pedir', () => {
  it('lê o e-mail só do parâmetro, apaga o parâmetro e não imprime e-mail, operador nem chamado', async () => {
    const d = deps();
    const saida = await executarComando(PEDIR, ENV, d);
    expect(saida).toEqual({ codigo: 'ok', linha: `ok ${PEDIDO} libera=2026-11-26T12:00:00.000Z sessoes=0` });
    expect(d.parametros.ler).toHaveBeenCalledWith(parametroDoPedido(PEDIDO));
    expect(d.parametros.apagar).toHaveBeenCalledWith(parametroDoPedido(PEDIDO));
    expect(d.pedir.mock.calls[0]?.[0]).toEqual({
      pedido: PEDIDO,
      clinicaId: CLINICA,
      usuarioAntigo: USUARIO,
      chamado: 'SUP-77',
      contrato: 'CTR-9',
      motivo: 'perdeu_senha_e_fator',
      operador: OPERADOR_A,
      vivaVoz: VIVA_VOZ,
      suspenderContaAntiga: false,
      email: EMAIL_FICTICIO,
    });
    for (const proibido of [EMAIL_FICTICIO, OPERADOR_A, 'SUP-']) expect(saida.linha).not.toContain(proibido);
  });

  it('P2: --suspender-conta-antiga chega à função só no pedir; nas outras fases é uso incorreto', async () => {
    const d = deps();
    expect((await executarComando([...PEDIR, '--suspender-conta-antiga'], ENV, d)).codigo).toBe('ok');
    expect(d.pedir.mock.calls[0]?.[0]).toMatchObject({ suspenderContaAntiga: true });
    expect((await executarComando([...EMITIR, '--suspender-conta-antiga'], ENV, deps())).codigo).toBe('uso_incorreto');
  });

  it('recusa da função (teto, outro admin, viva voz): o código fixo, e o parâmetro sai mesmo assim', async () => {
    for (const codigo of ['teto', 'ha_outro_admin', 'viva_voz_ausente', 'email_em_uso'] as const) {
      const d = deps({ pedir: vi.fn(() => Promise.reject(new TrocaRecusada(codigo))) });
      expect(await executarComando(PEDIR, ENV, d)).toEqual({ codigo, linha: codigo });
      expect(d.parametros.apagar).toHaveBeenCalledWith(parametroDoPedido(PEDIDO));
    }
  });

  it('parâmetro ausente, com chave a mais ou que não é JSON: nada roda', async () => {
    expect((await executarComando(PEDIR, ENV, deps({ ler: vi.fn(() => Promise.resolve(null)) }))).codigo).toBe('parametro_ausente');
    for (const bruto of ['{"email":"x@exemplo.test","nome":"Fulano Ficticio"}', 'nao-json', '[]']) {
      const d = deps({ ler: vi.fn(() => Promise.resolve(bruto)) });
      expect((await executarComando(PEDIR, ENV, d)).codigo).toBe('parametro_invalido');
      expect(d.pedir).not.toHaveBeenCalled();
      expect(d.parametros.apagar).toHaveBeenCalled();
    }
  });

  it('erro do driver vira `erro`, sem a mensagem', async () => {
    const d = deps({ pedir: vi.fn(() => Promise.reject(new Error('relation x does not exist: conta.nova.ficticia@exemplo.test'))) });
    expect(await executarComando(PEDIR, ENV, d)).toEqual({ codigo: 'erro', linha: 'erro' });
  });
});

describe('comando da troca do admin único (B13): emitir e cancelar', () => {
  it('emitir: token só no parâmetro de entrega; a linha não leva o token', async () => {
    const d = deps();
    const saida = await executarComando(EMITIR, ENV, d);
    expect(saida).toEqual({ codigo: 'ok', linha: `ok ${PEDIDO} ativacao expira=2026-11-27T12:00:00.000Z` });
    expect(d.parametros.gravar).toHaveBeenCalledWith(parametroDaEntrega(PEDIDO), TOKEN_FICTICIO);
    expect(d.parametros.apagar).not.toHaveBeenCalled();
    expect(saida.linha).not.toContain(TOKEN_FICTICIO);
    expect(d.emitir.mock.calls[0]?.[0]).toEqual({ pedido: PEDIDO, chamado: 'SUP-77', operador: OPERADOR_B, vivaVoz: VIVA_VOZ });
  });

  it('R4: mesmo_operador sai como código fixo, sem gravar nada', async () => {
    const d = deps({ emitir: vi.fn(() => Promise.reject(new TrocaRecusada('mesmo_operador'))) });
    expect(await executarComando(EMITIR, ENV, d)).toEqual({ codigo: 'mesmo_operador', linha: 'mesmo_operador' });
    expect(d.parametros.gravar).not.toHaveBeenCalled();
  });

  it('falha depois de gravar a entrega: a entrega desta rodada é apagada; entrega pendente de antes não', async () => {
    const depoisDeGravar = vi.fn(async (_e: unknown, guardar: (t: string) => Promise<void>) => {
      await guardar(TOKEN_FICTICIO);
      throw new Error('trilha recusada');
    });
    const d = deps({ emitir: depoisDeGravar });
    expect((await executarComando(EMITIR, ENV, d)).codigo).toBe('erro');
    expect(d.parametros.apagar).toHaveBeenCalledWith(parametroDaEntrega(PEDIDO));

    const pendente = deps({ gravar: vi.fn(() => Promise.reject(new EntregaPendente())) });
    expect((await executarComando(EMITIR, ENV, pendente)).codigo).toBe('entrega_pendente');
    expect(pendente.parametros.apagar).not.toHaveBeenCalled();

    const ssmFora = deps({ gravar: vi.fn(() => Promise.reject(new FalhaDoSsm('gravar'))) });
    expect((await executarComando(EMITIR, ENV, ssmFora)).codigo).toBe('erro');
    expect(ssmFora.parametros.apagar).toHaveBeenCalledWith(parametroDaEntrega(PEDIDO));
  });

  it('cancelar: chega à função com quem pediu; recusa vira código fixo', async () => {
    const d = deps();
    expect(await executarComando(CANCELAR, ENV, d)).toEqual({ codigo: 'ok', linha: `ok ${PEDIDO} cancelada` });
    expect(d.cancelar.mock.calls[0]?.[0]).toEqual({ pedido: PEDIDO, chamado: 'SUP-77', operador: OPERADOR_B, por: 'contrato' });
    const encerrada = deps({ cancelar: vi.fn(() => Promise.reject(new TrocaRecusada('troca_encerrada'))) });
    expect((await executarComando(CANCELAR, ENV, encerrada)).codigo).toBe('troca_encerrada');
  });
});

describe('comando da troca do admin único (B13): uso e trava', () => {
  it('trava com outro uuid (ou ausente) recusa ANTES de qualquer leitura ou escrita', async () => {
    for (const env of [{ CONFIRMA_TROCA: USUARIO }, {}] as NodeJS.ProcessEnv[]) {
      for (const argv of [PEDIR, EMITIR, CANCELAR]) {
        const d = deps();
        expect(await executarComando(argv, env, d)).toEqual({ codigo: 'trava_incorreta', linha: 'trava_incorreta' });
        expect(d.parametros.ler).not.toHaveBeenCalled();
        expect(d.pedir).not.toHaveBeenCalled();
        expect(d.emitir).not.toHaveBeenCalled();
        expect(d.cancelar).not.toHaveBeenCalled();
      }
    }
  });

  it('fase desconhecida, flag de outra fase, faltando, repetida ou sem valor: uso_incorreto', async () => {
    for (const argv of [
      ['--fase', 'concluir', '--pedido', PEDIDO],
      [...EMITIR, '--clinica', CLINICA],
      EMITIR.slice(0, 6),
      [...CANCELAR, '--por', 'dpo'],
      [...PEDIR.slice(0, -1)],
      PEDIR.map((x) => (x === PEDIDO ? 'nao-e-uuid' : x)),
    ]) {
      const d = deps();
      expect((await executarComando(argv, ENV, d)).codigo, argv.join(' ')).toBe('uso_incorreto');
      expect(d.pedir).not.toHaveBeenCalled();
      expect(d.emitir).not.toHaveBeenCalled();
    }
  });
});
