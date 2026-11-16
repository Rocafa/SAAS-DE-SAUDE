import { describe, expect, it, vi } from 'vitest';
import type { TenantId } from '@plataforma/shared';
import { ProvisionamentoRecusado } from '../modules/auth/better-auth/provisionamento';
import { executarComando, parametroDaEntrega, parametroDoPedido, type DependenciasDoComando, type ParametrosSeguros } from './provisionar-clinica';

// Dados fictícios.
const PEDIDO = '0b6f2c4e-1d2a-4f3b-8c5d-6e7f8a9b0c1d';
const CLINICA = '11111111-2222-4333-8444-555555555555' as TenantId;
const EMAIL = 'fundadora.ficticia@exemplo.test';
const NOME = 'Consultorio Ficticio';
const TOKEN = 'tokenFicticioDeTesteNaoUsarEmLugarNenhum0123';
const ARGS = ['--pedido', PEDIDO, '--contrato', 'CTR-42'];
const ENV = { CONFIRMA_PROVISIONAMENTO: PEDIDO } as NodeJS.ProcessEnv;

function ssm(inicial: Record<string, string> = { [parametroDoPedido(PEDIDO)]: JSON.stringify({ email: EMAIL, clinica: NOME }) }) {
  const valores = new Map(Object.entries(inicial));
  return {
    valores,
    ler: vi.fn<ParametrosSeguros['ler']>((n) => Promise.resolve(valores.get(n) ?? null)),
    gravar: vi.fn<ParametrosSeguros['gravar']>((n, v) => {
      valores.set(n, v);
      return Promise.resolve();
    }),
    apagar: vi.fn<ParametrosSeguros['apagar']>((n) => {
      valores.delete(n);
      return Promise.resolve();
    }),
  };
}

const provisionarFeliz: DependenciasDoComando['provisionar'] = async (_e, guardar) => {
  await guardar(TOKEN);
  return { clinicaId: CLINICA, pedido: PEDIDO, contaExistente: false };
};

function deps(parametros = ssm(), provisionar: DependenciasDoComando['provisionar'] = provisionarFeliz) {
  return { parametros, provisionar: vi.fn<DependenciasDoComando['provisionar']>(provisionar) };
}

function semDadoPessoal(linha: string): void {
  expect(linha).not.toContain('@');
  expect(linha).not.toContain(EMAIL);
  expect(linha).not.toContain(NOME);
  expect(linha).not.toContain(TOKEN);
}

describe('comando de provisionamento da clínica (B11; R3, R8 e R9 do parecer de 16/11)', () => {
  it('caminho feliz: uma linha só, token no parâmetro de entrega e parâmetro do e-mail apagado', async () => {
    const d = deps();
    const saida = await executarComando(ARGS, ENV, d);
    expect(saida).toEqual({ codigo: 'ok', linha: `ok ${CLINICA} ${PEDIDO}` });
    semDadoPessoal(saida.linha);
    expect(d.provisionar).toHaveBeenCalledWith({ pedido: PEDIDO, contrato: 'CTR-42', email: EMAIL, nomeDaClinica: NOME }, expect.any(Function));
    expect(d.parametros.valores.get(parametroDaEntrega(PEDIDO))).toBe(TOKEN);
    expect(d.parametros.valores.has(parametroDoPedido(PEDIDO))).toBe(false);
  });

  it('trava com outro uuid (ou ausente) recusa ANTES de ler o parâmetro ou escrever', async () => {
    for (const env of [{ CONFIRMA_PROVISIONAMENTO: CLINICA }, {}] as NodeJS.ProcessEnv[]) {
      const d = deps();
      expect(await executarComando(ARGS, env, d)).toEqual({ codigo: 'trava_incorreta', linha: 'trava_incorreta' });
      expect(d.parametros.ler).not.toHaveBeenCalled();
      expect(d.parametros.apagar).not.toHaveBeenCalled();
      expect(d.provisionar).not.toHaveBeenCalled();
    }
  });

  it('argumento faltando, repetido, desconhecido ou pedido fora do formato: uso_incorreto', async () => {
    for (const argv of [ARGS.slice(0, 2), [...ARGS, '--pedido', PEDIDO], [...ARGS, '--email', EMAIL], ['--pedido', 'nao-e-uuid', '--contrato', 'CTR-1']]) {
      const d = deps();
      expect((await executarComando(argv, { CONFIRMA_PROVISIONAMENTO: argv[1] }, d)).codigo).toBe('uso_incorreto');
      expect(d.provisionar).not.toHaveBeenCalled();
    }
  });

  it('contrato fora de CTR-<n>: contrato_invalido, sem tocar no SSM', async () => {
    for (const contrato of ['CTR-', 'CTR-12345678', 'ctr-1', 'CTR-1 ', 'LGPD-1']) {
      const d = deps();
      expect(await executarComando(['--pedido', PEDIDO, '--contrato', contrato], ENV, d)).toEqual({ codigo: 'contrato_invalido', linha: 'contrato_invalido' });
      expect(d.parametros.ler).not.toHaveBeenCalled();
    }
  });

  it('parâmetro ausente: parametro_ausente, sem provisionar', async () => {
    const d = deps(ssm({}));
    expect(await executarComando(ARGS, ENV, d)).toEqual({ codigo: 'parametro_ausente', linha: 'parametro_ausente' });
    expect(d.provisionar).not.toHaveBeenCalled();
  });

  it('parâmetro mal formado: parametro_invalido, sem ecoar o conteúdo, e o parâmetro é apagado', async () => {
    for (const valor of [EMAIL, '[]', JSON.stringify({ email: EMAIL }), JSON.stringify({ email: EMAIL, clinica: NOME, cpf: '000' })]) {
      const d = deps(ssm({ [parametroDoPedido(PEDIDO)]: valor }));
      const saida = await executarComando(ARGS, ENV, d);
      expect(saida).toEqual({ codigo: 'parametro_invalido', linha: 'parametro_invalido' });
      semDadoPessoal(saida.linha);
      expect(d.parametros.apagar).toHaveBeenCalledWith(parametroDoPedido(PEDIDO));
    }
  });

  it('recusa da função vira o código fixo, e o parâmetro é apagado também na falha (R9)', async () => {
    for (const codigo of ['ja_provisionado', 'conta_inativa', 'parametro_invalido', 'contrato_invalido'] as const) {
      const d = deps(ssm(), () => Promise.reject(new ProvisionamentoRecusado(codigo)));
      expect(await executarComando(ARGS, ENV, d)).toEqual({ codigo, linha: codigo });
      expect(d.parametros.valores.has(parametroDoPedido(PEDIDO))).toBe(false);
      expect(d.parametros.valores.has(parametroDaEntrega(PEDIDO))).toBe(false);
    }
  });

  it('erro do driver: erro_parcial_rodar_de_novo, sem a mensagem, e o parâmetro é apagado', async () => {
    const d = deps(ssm(), () => Promise.reject(new Error(`duplicate key value: email=${EMAIL} token=${TOKEN}`)));
    const saida = await executarComando(ARGS, ENV, d);
    expect(saida).toEqual({ codigo: 'erro_parcial_rodar_de_novo', linha: 'erro_parcial_rodar_de_novo' });
    semDadoPessoal(saida.linha);
    expect(d.parametros.apagar).toHaveBeenCalledWith(parametroDoPedido(PEDIDO));
  });

  it('falha ao gravar a entrega: erro_parcial_rodar_de_novo (a função desfaz a linha) e o e-mail é apagado', async () => {
    const p = ssm();
    p.gravar.mockRejectedValue(new Error('AccessDenied'));
    const d = deps(p);
    expect((await executarComando(ARGS, ENV, d)).codigo).toBe('erro_parcial_rodar_de_novo');
    expect(p.valores.has(parametroDoPedido(PEDIDO))).toBe(false);
  });

  it('falha ao apagar o parâmetro do e-mail não sai como ok', async () => {
    const p = ssm();
    p.apagar.mockRejectedValue(new Error('Throttling'));
    expect((await executarComando(ARGS, ENV, deps(p))).codigo).toBe('erro_parcial_rodar_de_novo');
  });
});
