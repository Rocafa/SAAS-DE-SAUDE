/**
 * Parecer do #173: o expurgo de 90 dias apaga dado pessoal (senha, TOTP, nome e e-mail) e devolvia só a contagem —
 * nada na trilha, e o art. 37 da LGPD pede a prova. A linha vai na clínica de ORIGEM da conta (0067). Bancos falsos.
 */
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Autenticacao } from './instancia';
import { zerarJanelasDoLog } from '../../../security/log-de-seguranca';
import { BetterAuthProvider } from './provedor';

const USER = '22222222-2222-4222-8222-222222222222';
const CLINICA = '11111111-1111-4111-8111-111111111111';

/** Encadeamento do Drizzle que resolve em `resultado` quando aguardado. */
function cadeia(resultado: unknown): unknown {
  const alvo: Record<string | symbol, unknown> = {};
  const p: unknown = new Proxy(alvo, {
    get: (_t, prop) =>
      prop === 'then'
        ? (ok: (v: unknown) => unknown, erro: (e: unknown) => unknown) => Promise.resolve(resultado).then(ok, erro)
        : () => p,
  });
  return p;
}

function capturarEventos(): () => Record<string, unknown>[] {
  const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  return () =>
    error.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.startsWith('{"tipo":"seguranca"'))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
}

afterEach(() => {
  vi.restoreAllMocks();
  zerarJanelasDoLog();
});

const auth = { api: { getSession: () => Promise.resolve(null) } } as unknown as Autenticacao;

function montar(opcoes: { clinicaDeOrigem: string | null; trilhaFora: boolean }) {
  const trilhas: string[] = [];
  // Na ordem do `expurgarComoSistema`: o 1º select pega candidatas a desligamento (nenhuma), o 2º as inativas de 90 dias.
  const selects: unknown[][] = [[], [{ id: USER, clinicaDeOrigem: opcoes.clinicaDeOrigem }]];
  const dbAuth = {
    delete: () => cadeia([]),
    update: () => cadeia([]),
    select: () => cadeia(selects.shift() ?? []),
    transaction: (fn: (t: unknown) => Promise<unknown>) =>
      fn({
        // O UPDATE da marca `expurgada` tem de achar a linha para o expurgo seguir.
        update: () => cadeia([{ id: USER }]),
        delete: () => cadeia([]),
      }),
  };
  const dbClinica = {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        execute: () => Promise.resolve(undefined),
        insert: () => {
          if (opcoes.trilhaFora) throw new Error('trilha recusada');
          trilhas.push(String(opcoes.clinicaDeOrigem));
          return cadeia(undefined);
        },
      }),
  };
  const provedor = new BetterAuthProvider({ auth, dbAuth: dbAuth as never, dbClinica: dbClinica as never });
  return { provedor, trilhas };
}

describe('expurgo de 90 dias: trilha na clínica de origem', () => {
  it('com clínica de origem: a trilha grava lá e nada alarma', async () => {
    const eventos = capturarEventos();
    const { provedor, trilhas } = montar({ clinicaDeOrigem: CLINICA, trilhaFora: false });
    const r = await provedor.expurgarComoSistema();
    expect(r.credenciaisDeInativas).toBe(1);
    expect(r.expurgosSemTrilha).toBe(0);
    expect(trilhas).toEqual([CLINICA]);
    expect(eventos().some((e) => e['evento'] === 'TRILHA_NAO_GRAVADA')).toBe(false);
  });

  it('trilha fora: o expurgo acontece (reter seria pior) e alarma TRILHA_NAO_GRAVADA com a contagem', async () => {
    const eventos = capturarEventos();
    const { provedor } = montar({ clinicaDeOrigem: CLINICA, trilhaFora: true });
    const r = await provedor.expurgarComoSistema();
    expect(r.credenciaisDeInativas).toBe(1);
    expect(r.expurgosSemTrilha).toBe(1);
    const linhas = eventos().filter((e) => e['evento'] === 'TRILHA_NAO_GRAVADA' && e['motivo'] === 'expurgo_de_credencial');
    expect(linhas.some((e) => e['userId'] === USER)).toBe(true);
    expect(linhas.some((e) => e['contagem'] === 1)).toBe(true);
  });

  it('conta anterior à 0067 (sem clínica de origem): não há trilha de clínica possível, e o evento conta o caso', async () => {
    const eventos = capturarEventos();
    const { provedor, trilhas } = montar({ clinicaDeOrigem: null, trilhaFora: false });
    const r = await provedor.expurgarComoSistema();
    expect(r.expurgosSemTrilha).toBe(1);
    expect(trilhas).toEqual([]);
    expect(eventos().some((e) => e['motivo'] === 'expurgo_de_credencial')).toBe(true);
  });
});
