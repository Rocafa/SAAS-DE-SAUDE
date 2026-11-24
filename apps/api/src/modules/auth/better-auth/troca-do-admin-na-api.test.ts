/**
 * Troca do admin único (B13), lado da API, com bancos falsos: ressalvas 1 e 3 do parecer do Guardião sobre o código
 * (#239). O caminho no banco está em test/troca-do-admin-unico.rls.test.ts. Dados fictícios.
 */
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ativacaoDoFundador, recuperacao, sessao, trocaDoAdmin } from '../../../db/identidade';
import { zerarJanelasDoLog } from '../../../security/log-de-seguranca';
import { aoLoginCompletoDaConta, contestarTrocaDoAdmin } from './troca-do-admin-na-api';

const PEDIDO = '7d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const CLINICA = '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f';
const ANTIGO = '0b6f2c4e-1d2a-4f3b-8c5d-6e7f8a9b0c1d';
const NOVO = '3e4f5a6b-7c8d-4e9f-8a0b-1c2d3e4f5a6b';

/** Encadeamento do Drizzle que resolve em `resultado` quando aguardado. */
function cadeia(resultado: unknown): unknown {
  const p: unknown = new Proxy(
    {},
    {
      get: (_t, prop) =>
        prop === 'then' ? (ok: (v: unknown) => unknown, erro: (e: unknown) => unknown) => Promise.resolve(resultado).then(ok, erro) : () => p,
    },
  );
  return p;
}

function capturarEventos(): () => Record<string, unknown>[] {
  const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  return () =>
    [...error.mock.calls, ...warn.mock.calls]
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('{"tipo":"seguranca"'))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
}

afterEach(() => {
  vi.restoreAllMocks();
  zerarJanelasDoLog();
});

const trocaLida = { id: PEDIDO, clinicaId: CLINICA, chamado: 'SUP-77', estado: 'ativada', usuarioNovo: NOVO };

describe('ressalva 1 do #239: login completo da conta antiga com a troca ativada', () => {
  it('suspende e, na mesma transação, invalida a ativação e o fator da conta nova e derruba as sessões dela', async () => {
    const eventos = capturarEventos();
    const mexidas: unknown[] = [];
    const ta = {
      update: (tabela: unknown) => {
        mexidas.push(['update', tabela]);
        return cadeia(tabela === trocaDoAdmin ? [{ id: PEDIDO }] : []);
      },
      delete: (tabela: unknown) => {
        mexidas.push(['delete', tabela]);
        return cadeia([]);
      },
    };
    const dbAuth = { select: () => cadeia([trocaLida]), transaction: (fn: (t: unknown) => Promise<unknown>) => fn(ta) };
    await aoLoginCompletoDaConta({ dbAuth: dbAuth as never, dbClinica: {} as never }, ANTIGO);
    expect(mexidas).toEqual([
      ['update', trocaDoAdmin],
      ['update', ativacaoDoFundador],
      ['update', recuperacao],
      ['delete', sessao],
    ]);
    expect(eventos().filter((e) => e['evento'] === 'TROCA_DO_ADMIN_SUSPENSA')).toHaveLength(1);
  });

  it('a troca já mudou (outra requisição): nada de tokens, sessões nem evento', async () => {
    const eventos = capturarEventos();
    const mexidas: unknown[] = [];
    const ta = {
      update: (tabela: unknown) => {
        mexidas.push(tabela);
        return cadeia([]);
      },
      delete: (tabela: unknown) => {
        mexidas.push(tabela);
        return cadeia([]);
      },
    };
    const dbAuth = { select: () => cadeia([trocaLida]), transaction: (fn: (t: unknown) => Promise<unknown>) => fn(ta) };
    await aoLoginCompletoDaConta({ dbAuth: dbAuth as never, dbClinica: {} as never }, ANTIGO);
    expect(mexidas).toEqual([trocaDoAdmin]);
    expect(eventos().some((e) => e['evento'] === 'TROCA_DO_ADMIN_SUSPENSA')).toBe(false);
  });
});

describe('ressalva 3 do #239: contestação gravada na clínica e perdida na identidade', () => {
  const ta = { update: () => cadeia([{ id: PEDIDO }]) };
  const dbClinica = {
    transaction: (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ execute: () => Promise.resolve(undefined), select: () => cadeia([]), insert: () => cadeia(undefined) }),
  };

  it('a clínica confirmou e o COMMIT da identidade falhou: TRILHA_NAO_GRAVADA (crítico) e o erro sobe', async () => {
    const eventos = capturarEventos();
    const dbAuth = {
      select: () => cadeia([{ ...trocaLida, estado: 'aguardando' }]),
      transaction: async (fn: (t: unknown) => Promise<unknown>) => {
        await fn(ta);
        throw new Error('commit da identidade falhou');
      },
    };
    await expect(contestarTrocaDoAdmin({ dbAuth: dbAuth as never, dbClinica: dbClinica as never }, ANTIGO)).rejects.toThrow('commit da identidade falhou');
    const alarme = eventos().filter((e) => e['evento'] === 'TRILHA_NAO_GRAVADA');
    expect(alarme).toHaveLength(1);
    expect(alarme[0]).toMatchObject({ severidade: 'critico', motivo: 'contestacao_da_troca', tenantId: CLINICA, userId: ANTIGO, chamado: 'SUP-77', pedido: PEDIDO });
    expect(eventos().some((e) => e['evento'] === 'TROCA_DO_ADMIN_CONTESTADA')).toBe(false);
  });

  it('a clínica recusou antes: sem TRILHA_NAO_GRAVADA (nada ficou gravado em lugar nenhum)', async () => {
    const eventos = capturarEventos();
    const clinicaFora = { transaction: () => Promise.reject(new Error('trilha recusada')) };
    const dbAuth = { select: () => cadeia([{ ...trocaLida, estado: 'aguardando' }]), transaction: (fn: (t: unknown) => Promise<unknown>) => fn(ta) };
    await expect(contestarTrocaDoAdmin({ dbAuth: dbAuth as never, dbClinica: clinicaFora as never }, ANTIGO)).rejects.toThrow('trilha recusada');
    expect(eventos().some((e) => e['evento'] === 'TRILHA_NAO_GRAVADA')).toBe(false);
  });
});
