/**
 * Ordem da escolha de clínica (ALTA do parecer do #149): a trilha grava ANTES de a sessão ganhar a clínica ativa.
 * Se a trilha falhar, a sessão fica sem clínica (sem acesso) e o log de segurança alarma. Bancos falsos, sem rede.
 */
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Autenticacao } from './instancia';
import { zerarJanelasDoLog } from '../../../security/log-de-seguranca';
import { BetterAuthProvider } from './provedor';

const SESSAO = 'sessao-ficticia-1';
const USER = '22222222-2222-4222-8222-222222222222';
const CLINICA = '11111111-1111-4111-8111-111111111111';

/** Encadeamento do Drizzle (`.from().where()...`) que resolve em `resultado` quando aguardado. */
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

function montar(opcoes: { trilhaFora: boolean }) {
  const ordem: string[] = [];
  const dbAuth = {
    // resolver: sessão sem clínica ativa, conta ativa, criada agora.
    select: () => cadeia([{ criadaEm: new Date(), clinicaAtiva: null, mfaEm: null, perfisNoMfa: null, usuarioId: USER, ativo: true }]),
    selectDistinct: () => cadeia([{ clinicaId: CLINICA }]),
    update: () => {
      ordem.push('clinica_ativa');
      return cadeia(undefined);
    },
    delete: () => cadeia(undefined),
    // Troca atômica da clínica (R1 do parecer do 3a): uma instrução só, devolvendo o valor anterior.
    execute: () => {
      ordem.push('clinica_ativa');
      return Promise.resolve([{ clinica_antes: null, sem_clinica_antes: null }]);
    },
  };
  const dbClinica = {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      if (opcoes.trilhaFora) throw new Error('banco da trilha fora');
      const tx = {
        execute: () => Promise.resolve(undefined),
        insert: () => {
          ordem.push('trilha');
          return cadeia(undefined);
        },
        select: () => cadeia([{ role: 'admin' }]),
      };
      return fn(tx);
    },
  };
  const auth = { api: { getSession: () => Promise.resolve({ session: { id: SESSAO } }) } } as unknown as Autenticacao;
  const provedor = new BetterAuthProvider({ auth, dbAuth: dbAuth as never, dbClinica: dbClinica as never });
  // H3 do #176: a regra da clínica cancelada lê `tenants`; aqui a clínica está liberada.
  vi.spyOn(provedor as unknown as { clinicaLiberada: () => Promise<{ nome: string }> }, 'clinicaLiberada').mockResolvedValue({ nome: 'Clinica Ficticia' });
  return { provedor, ordem };
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

describe('definirClinica: trilha antes da clínica ativa', () => {
  it('caminho feliz: a linha da trilha grava antes de a sessão ganhar a clínica', async () => {
    const { provedor, ordem } = montar({ trilhaFora: false });
    expect(await provedor.definirClinica(SESSAO, USER, CLINICA)).toBe(true);
    expect(ordem).toEqual(['trilha', 'clinica_ativa']);
  });

  it('trilha fora: a sessão NÃO ganha a clínica, devolve false e alarma TRILHA_NAO_GRAVADA', async () => {
    const eventos = capturarEventos();
    const { provedor, ordem } = montar({ trilhaFora: true });
    expect(await provedor.definirClinica(SESSAO, USER, CLINICA)).toBe(false);
    expect(ordem).not.toContain('clinica_ativa');
    expect(eventos().some((e) => e['evento'] === 'TRILHA_NAO_GRAVADA' && e['motivo'] === 'escolha_de_clinica' && e['userId'] === USER)).toBe(true);
  });

  it('resolver com clínica única e trilha fora: sem contexto (sem acesso), não segue com a clínica que não gravou', async () => {
    capturarEventos();
    const { provedor, ordem } = montar({ trilhaFora: true });
    expect(await provedor.resolver({ headers: {} })).toBeNull();
    expect(ordem).not.toContain('clinica_ativa');
  });

  it('trilha fora e requisições seguidas: um alarme por sessão a cada minuto, não um por requisição', async () => {
    const eventos = capturarEventos();
    const { provedor } = montar({ trilhaFora: true });
    for (let i = 0; i < 5; i++) expect(await provedor.definirClinica(SESSAO, USER, CLINICA)).toBe(false);
    expect(eventos().filter((e) => e['evento'] === 'TRILHA_NAO_GRAVADA')).toHaveLength(1);
  });
});

/**
 * Ressalva do parecer da resolução 3a × #168: trilha fora × TOTP feito sem clínica (R4 do desenho do PR 3). Sessão com
 * estado no banco falso: `execute` faz a troca atômica (devolve o valor anterior e zera `mfa_sem_clinica_em`).
 */
function montarComTotp(agora: Date) {
  const estado = { trilhaFora: true, clinicaAtiva: null as string | null, mfaSemClinicaEm: new Date(agora.getTime() - 60_000) as Date | null };
  const dbAuth = {
    selectDistinct: () => cadeia([{ clinicaId: CLINICA }]),
    execute: () => {
      const antes = { clinica_antes: estado.clinicaAtiva, sem_clinica_antes: estado.mfaSemClinicaEm };
      estado.clinicaAtiva = CLINICA;
      estado.mfaSemClinicaEm = null;
      return Promise.resolve([antes]);
    },
  };
  const dbClinica = {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      if (estado.trilhaFora) throw new Error('banco da trilha fora');
      return fn({ execute: () => Promise.resolve(undefined), insert: () => cadeia(undefined) });
    },
  };
  const auth = { api: { getSession: () => Promise.resolve(null) } } as unknown as Autenticacao;
  const provedor = new BetterAuthProvider({ auth, dbAuth: dbAuth as never, dbClinica: dbClinica as never, agora: () => agora });
  // H3 do #176: a regra da clínica cancelada lê `tenants`; aqui a clínica está liberada.
  vi.spyOn(provedor as unknown as { clinicaLiberada: () => Promise<{ nome: string }> }, 'clinicaLiberada').mockResolvedValue({ nome: 'Clinica Ficticia' });
  const marcarMfa = vi.spyOn(provedor, 'marcarMfa').mockResolvedValue(true);
  const comFator = provedor as unknown as { trilhaDoFator: (...a: unknown[]) => Promise<void> };
  const trilhaDoFator = vi.spyOn(comFator, 'trilhaDoFator').mockResolvedValue(undefined);
  return { provedor, estado, marcarMfa, trilhaDoFator };
}

describe('definirClinica: trilha fora × TOTP feito sem clínica', () => {
  it('(a) trilha fora: o TOTP sem clínica continua guardado e nenhum MFA é marcado', async () => {
    capturarEventos();
    const { provedor, estado, marcarMfa, trilhaDoFator } = montarComTotp(new Date());
    const guardado = estado.mfaSemClinicaEm;
    expect(await provedor.definirClinica(SESSAO, USER, CLINICA)).toBe(false);
    expect(estado.clinicaAtiva).toBeNull();
    expect(estado.mfaSemClinicaEm).toBe(guardado);
    expect(marcarMfa).not.toHaveBeenCalled();
    expect(trilhaDoFator).not.toHaveBeenCalled();
  });

  it('(b) a trilha volta dentro dos 5 min: a escolha aproveita o TOTP uma vez só e zera o campo', async () => {
    capturarEventos();
    const { provedor, estado, marcarMfa, trilhaDoFator } = montarComTotp(new Date());
    expect(await provedor.definirClinica(SESSAO, USER, CLINICA)).toBe(false);
    estado.trilhaFora = false;
    expect(await provedor.definirClinica(SESSAO, USER, CLINICA)).toBe(true);
    expect(estado.mfaSemClinicaEm).toBeNull();
    expect(marcarMfa).toHaveBeenCalledTimes(1);
    expect(trilhaDoFator).toHaveBeenCalledWith(CLINICA, USER, ['mfa_verified'], expect.anything());
    // Segunda escolha: o TOTP já foi gasto.
    expect(await provedor.definirClinica(SESSAO, USER, CLINICA)).toBe(true);
    expect(marcarMfa).toHaveBeenCalledTimes(1);
  });
});
