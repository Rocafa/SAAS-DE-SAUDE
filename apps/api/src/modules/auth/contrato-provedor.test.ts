/**
 * Contrato de TODO provedor de sessão (R6 do parecer do #123, condição da D4). O adaptador real (Better Auth,
 * se confirmado) entra em `BANCADAS` e precisa passar nas mesmas regras que a sessão fictícia:
 * - sem sessão válida, `null` (401), inclusive com credencial adulterada ou depois do logout;
 * - clínica, usuário, perfis e `mfaEm` vêm SÓ da sessão do servidor: cabeçalho do cliente não muda nada;
 * - sem segundo fator, `mfaEm === null` (falha fechada); com fator, uma data que não está no futuro;
 * - sessões de usuários diferentes não se misturam.
 * O registro é tipado por `TIPOS_DE_PROVEDOR`: tipo novo na fábrica sem bancada aqui não compila.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AuthProvider, RequisicaoParaSessao } from './auth-context';
import { TIPOS_DE_PROVEDOR, type TipoDeProvedor } from './auth-provider.factory';
import { DevSessionProvider } from './dev-session.provider';
import { PERFIS, type Perfil } from './perfis';

type Cabecalhos = RequisicaoParaSessao['headers'];

/** O que cada provedor oferece ao contrato: criar uma sessão como o login faria e encerrá-la como o logout. */
interface BancadaDoProvedor {
  readonly provider: AuthProvider;
  sessao(d: { tenantId: string; userId: string; perfis: readonly Perfil[]; comFator: boolean }): Promise<Cabecalhos>;
  encerrar(c: Cabecalhos): Promise<void>;
  /**
   * Ganchos que só o provedor real tem (parecer do #128). Opcionais na sessão fictícia: ausentes viram it.todo,
   * para a lacuna ficar visível. Para qualquer tipo que não seja `dev`, são OBRIGATÓRIOS (R2 do parecer do #128).
   */
  readonly ganchos?: Partial<GanchosDoProvedorReal>;
}

interface GanchosDoProvedorReal {
  /** Troca a clínica ativa da sessão; devolve a credencial depois da troca. */
  trocarClinica(c: Cabecalhos, tenantId: string): Promise<Cabecalhos>;
  /** Troca os perfis do usuário na sessão; devolve a credencial depois da troca. */
  trocarPerfis(c: Cabecalhos, perfis: readonly Perfil[]): Promise<Cabecalhos>;
  /** Troca a senha; devolve a credencial em uso depois da troca (ou a mesma, se o provedor a invalida). */
  trocarSenha(c: Cabecalhos): Promise<Cabecalhos>;
  /** Passa pelo segundo fator de novo (step-up); devolve a credencial. */
  stepUp(c: Cabecalhos): Promise<Cabecalhos>;
  /** Faz a sessão expirar (relógio do provedor). */
  expirar(c: Cabecalhos): Promise<void>;
  /** Monta uma credencial como um atacante faria (claim não verificado, chave errada, alg none). */
  forjarCredencial(d: { tenantId: string; userId: string; perfis: readonly Perfil[] }): Promise<Cabecalhos>;
}

const GANCHOS: readonly (keyof GanchosDoProvedorReal)[] = ['trocarClinica', 'trocarPerfis', 'trocarSenha', 'stepUp', 'expirar', 'forjarCredencial'];

function bancadaDev(): BancadaDoProvedor {
  const provider = new DevSessionProvider('test');
  return {
    provider,
    sessao: (d) =>
      Promise.resolve({ authorization: `Bearer ${provider.criarSessao({ tenantId: d.tenantId, userId: d.userId, perfis: d.perfis, mfaEm: d.comFator ? new Date() : null })}` }),
    encerrar: (c) => {
      provider.encerrarSessao(String(c.authorization).replace(/^Bearer /, ''));
      return Promise.resolve();
    },
  };
}

const BANCADAS: Record<TipoDeProvedor, () => BancadaDoProvedor> = { dev: bancadaDev };

/** Troca o último caractere de cada valor (credencial adulterada, qualquer que seja o formato do provedor). */
function adulterar(c: Cabecalhos): Cabecalhos {
  const troca = (v: string): string => v.slice(0, -1) + (v.endsWith('A') ? 'B' : 'A');
  return Object.fromEntries(Object.entries(c).map(([k, v]) => [k, typeof v === 'string' ? troca(v) : Array.isArray(v) ? v.map(troca) : v]));
}

/** Cabeçalhos que um cliente malicioso mandaria para escolher clínica, usuário, perfil ou MFA. */
const FORJADOS = (outro: string): Cabecalhos => ({
  'x-tenant-id': outro,
  'x-clinica-id': outro,
  'x-user-id': outro,
  'x-perfis': 'admin',
  'x-roles': 'admin',
  'x-mfa-em': new Date().toISOString(),
  'x-mfa': 'true',
  'x-forwarded-user': outro,
});

it('todo tipo aceito pela fábrica tem bancada no contrato', () => {
  expect(Object.keys(BANCADAS).sort()).toEqual([...TIPOS_DE_PROVEDOR].sort());
});

it('R2 do parecer do #128: provedor que não é a sessão fictícia implementa todos os ganchos (it.todo não aprova a R6)', () => {
  const bancadas: Readonly<Record<string, () => BancadaDoProvedor>> = BANCADAS;
  for (const tipo of TIPOS_DE_PROVEDOR as readonly string[]) {
    if (tipo === 'dev') continue;
    const ganchos = bancadas[tipo]?.().ganchos ?? {};
    expect(GANCHOS.filter((g) => typeof ganchos[g] !== 'function'), tipo).toEqual([]);
  }
});

for (const tipo of TIPOS_DE_PROVEDOR) {
  describe(`contrato do provedor de sessão: ${tipo}`, () => {
    const nova = () => ({ tenantId: randomUUID(), userId: randomUUID() });

    it('sem credencial, credencial lixo ou adulterada: null', async () => {
      const b = BANCADAS[tipo]();
      expect(await b.provider.resolver({ headers: {} })).toBeNull();
      expect(await b.provider.resolver({ headers: { authorization: 'Bearer x', cookie: 'sessao=x' } })).toBeNull();
      const c = await b.sessao({ ...nova(), perfis: ['admin'], comFator: true });
      expect(await b.provider.resolver({ headers: adulterar(c) })).toBeNull();
    });

    it('sem segundo fator: mfaEm === null (falha fechada, nunca "agora")', async () => {
      const b = BANCADAS[tipo]();
      const c = await b.sessao({ ...nova(), perfis: ['recepcao'], comFator: false });
      const auth = await b.provider.resolver({ headers: c });
      expect(auth).not.toBeNull();
      expect(auth?.mfaEm).toBeNull();
    });

    it('com segundo fator: mfaEm é uma data real, que não está no futuro', async () => {
      const b = BANCADAS[tipo]();
      const c = await b.sessao({ ...nova(), perfis: ['profissional'], comFator: true });
      const auth = await b.provider.resolver({ headers: c });
      expect(auth?.mfaEm).toBeInstanceOf(Date);
      expect(Number.isNaN(auth?.mfaEm?.getTime())).toBe(false);
      expect(auth?.mfaEm?.getTime() ?? Infinity).toBeLessThanOrEqual(Date.now());
    });

    it('clínica, usuário, perfis e MFA vêm só da sessão: cabeçalhos forjados não mudam nada', async () => {
      const b = BANCADAS[tipo]();
      const d = nova();
      const semFator = await b.sessao({ ...d, perfis: ['recepcao'], comFator: false });
      const limpo = await b.provider.resolver({ headers: semFator });
      const forjado = await b.provider.resolver({ headers: { ...FORJADOS(randomUUID()), ...semFator } });
      expect(forjado).toEqual(limpo);
      expect(forjado).toMatchObject({ tenantId: d.tenantId, userId: d.userId, perfis: ['recepcao'], mfaEm: null });
      // Só cabeçalhos forjados, sem sessão: nada.
      expect(await b.provider.resolver({ headers: FORJADOS(d.tenantId) })).toBeNull();
    });

    it('perfis só da lista fechada', async () => {
      const b = BANCADAS[tipo]();
      const auth = await b.provider.resolver({ headers: await b.sessao({ ...nova(), perfis: ['admin', 'financeiro'], comFator: true }) });
      for (const p of auth?.perfis ?? ['vazio']) expect(PERFIS).toContain(p);
    });

    it('logout: a mesma credencial passa a valer null', async () => {
      const b = BANCADAS[tipo]();
      const c = await b.sessao({ ...nova(), perfis: ['admin'], comFator: true });
      expect(await b.provider.resolver({ headers: c })).not.toBeNull();
      await b.encerrar(c);
      expect(await b.provider.resolver({ headers: c })).toBeNull();
    });

    it('sessões de usuários e clínicas diferentes não se misturam', async () => {
      const b = BANCADAS[tipo]();
      const d1 = nova();
      const d2 = nova();
      const c1 = await b.sessao({ ...d1, perfis: ['admin'], comFator: true });
      const c2 = await b.sessao({ ...d2, perfis: ['recepcao'], comFator: false });
      expect(await b.provider.resolver({ headers: c1 })).toMatchObject({ tenantId: d1.tenantId, userId: d1.userId, perfis: ['admin'] });
      expect(await b.provider.resolver({ headers: c2 })).toMatchObject({ tenantId: d2.tenantId, userId: d2.userId, mfaEm: null });
    });

    // Casos que dependem dos ganchos do provedor real (R6): sem o gancho, ficam visíveis como pendentes.
    const ganchos = BANCADAS[tipo]().ganchos ?? {};
    const comGancho = (g: keyof GanchosDoProvedorReal, nome: string, fn: (b: BancadaDoProvedor, h: GanchosDoProvedorReal) => Promise<void>): void => {
      if (typeof ganchos[g] === 'function') {
        it(nome, async () => {
          const b = BANCADAS[tipo]();
          await fn(b, b.ganchos as GanchosDoProvedorReal);
        });
      } else it.todo(`${nome} (gancho ${g} só no provedor real, D4)`);
    };
    comGancho('trocarClinica', 'trocar de clínica zera o MFA', async (b, h) => {
      const c = await b.sessao({ ...nova(), perfis: ['admin'], comFator: true });
      expect((await b.provider.resolver({ headers: await h.trocarClinica(c, randomUUID()) }))?.mfaEm ?? null).toBeNull();
    });
    comGancho('trocarPerfis', 'trocar de perfil zera o MFA', async (b, h) => {
      const c = await b.sessao({ ...nova(), perfis: ['recepcao'], comFator: true });
      expect((await b.provider.resolver({ headers: await h.trocarPerfis(c, ['admin']) }))?.mfaEm ?? null).toBeNull();
    });
    comGancho('trocarSenha', 'trocar a senha zera o MFA (ou derruba a sessão)', async (b, h) => {
      const c = await b.sessao({ ...nova(), perfis: ['admin'], comFator: true });
      expect((await b.provider.resolver({ headers: await h.trocarSenha(c) }))?.mfaEm ?? null).toBeNull();
    });
    comGancho('stepUp', 'step-up atualiza o mfaEm para agora', async (b, h) => {
      const c = await b.sessao({ ...nova(), perfis: ['admin'], comFator: false });
      const antes = Date.now();
      const auth = await b.provider.resolver({ headers: await h.stepUp(c) });
      expect(auth?.mfaEm?.getTime() ?? 0).toBeGreaterThanOrEqual(antes - 1000);
      expect(auth?.mfaEm?.getTime() ?? Infinity).toBeLessThanOrEqual(Date.now());
    });
    comGancho('expirar', 'sessão expirada: null', async (b, h) => {
      const c = await b.sessao({ ...nova(), perfis: ['admin'], comFator: true });
      await h.expirar(c);
      expect(await b.provider.resolver({ headers: c })).toBeNull();
    });
    comGancho('forjarCredencial', 'credencial forjada (claim não verificado): null', async (b, h) => {
      expect(await b.provider.resolver({ headers: await h.forjarCredencial({ ...nova(), perfis: ['admin'] }) })).toBeNull();
    });
  });
}
