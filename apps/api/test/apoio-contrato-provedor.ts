/**
 * Contrato de TODO provedor de sessão (R6 do parecer do #123; #128). A suíte vive aqui para rodar em dois lugares:
 * - `src/modules/auth/contrato-provedor.test.ts`: sessão fictícia (`dev`), sem banco;
 * - `test/contrato-provedor-better-auth.rls.test.ts`: provedor real (`better-auth`), com banco (D4).
 *
 * Regras: sem credencial válida, adulterada ou depois do logout → null; clínica, usuário, perfis e `mfaEm` só da
 * sessão do servidor (cabeçalho forjado não muda nada); sem fator → `mfaEm === null`; com fator → data não futura;
 * sessões não se misturam. Os 6 ganchos (troca de clínica, de perfis, de senha, step-up, expiração e credencial
 * forjada) são OBRIGATÓRIOS para qualquer provedor que não seja `dev` (R2 do parecer do #128).
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AuthProvider, RequisicaoParaSessao } from '../src/modules/auth/auth-context';
import { PERFIS, type Perfil } from '../src/modules/auth/perfis';

export type Cabecalhos = RequisicaoParaSessao['headers'];

/** Uma sessão criada pela bancada: a credencial e os ids REAIS (o provedor real cria clínica e usuário de verdade). */
export interface SessaoDaBancada {
  readonly cabecalhos: Cabecalhos;
  readonly tenantId: string;
  readonly userId: string;
}

export interface BancadaDoProvedor {
  readonly provider: AuthProvider;
  /** Cria uma sessão como o login faria, numa clínica nova, com os perfis pedidos e com ou sem o segundo fator. */
  sessao(d: { perfis: readonly Perfil[]; comFator: boolean }): Promise<SessaoDaBancada>;
  encerrar(c: Cabecalhos): Promise<void>;
  readonly ganchos?: Partial<GanchosDoProvedorReal>;
}

export interface GanchosDoProvedorReal {
  /** Troca a clínica ativa da sessão para OUTRA clínica em que o usuário tem vínculo; devolve a credencial. */
  trocarClinica(s: SessaoDaBancada): Promise<Cabecalhos>;
  /** Troca os perfis do usuário (no banco, para o provedor real); devolve a credencial. */
  trocarPerfis(s: SessaoDaBancada, perfis: readonly Perfil[]): Promise<Cabecalhos>;
  /** Troca a senha; devolve a credencial em uso depois da troca (ou a mesma, se o provedor a invalida). */
  trocarSenha(s: SessaoDaBancada): Promise<Cabecalhos>;
  /** Passa pelo segundo fator de novo (step-up); devolve a credencial. */
  stepUp(s: SessaoDaBancada): Promise<Cabecalhos>;
  /** Faz a sessão expirar (relógio do provedor). */
  expirar(s: SessaoDaBancada): Promise<void>;
  /** Monta uma credencial como um atacante faria (sem passar pelo login). */
  forjarCredencial(): Promise<Cabecalhos>;
}

export const GANCHOS: readonly (keyof GanchosDoProvedorReal)[] = ['trocarClinica', 'trocarPerfis', 'trocarSenha', 'stepUp', 'expirar', 'forjarCredencial'];

/** Troca o último caractere de cada valor (credencial adulterada, qualquer que seja o formato do provedor). */
export function adulterar(c: Cabecalhos): Cabecalhos {
  const troca = (v: string): string => v.slice(0, -1) + (v.endsWith('A') ? 'B' : 'A');
  return Object.fromEntries(Object.entries(c).map(([k, v]) => [k, typeof v === 'string' ? troca(v) : Array.isArray(v) ? v.map(troca) : v]));
}

/** Cabeçalhos que um cliente malicioso mandaria para escolher clínica, usuário, perfil ou MFA. */
export const FORJADOS = (outro: string): Cabecalhos => ({
  'x-tenant-id': outro,
  'x-clinica-id': outro,
  'x-user-id': outro,
  'x-perfis': 'admin',
  'x-roles': 'admin',
  'x-mfa-em': new Date().toISOString(),
  'x-mfa': 'true',
  'x-forwarded-user': outro,
  'x-plataforma-origem': 'ffffffffffffffff',
});

export function executarContrato(tipo: string, fabrica: () => Promise<BancadaDoProvedor>): void {
  describe(`contrato do provedor de sessão: ${tipo}`, () => {
    if (tipo !== 'dev') {
      it('R2 do parecer do #128: implementa os 6 ganchos (it.todo não aprova a R6)', async () => {
        const ganchos = (await fabrica()).ganchos ?? {};
        expect(GANCHOS.filter((g) => typeof ganchos[g] !== 'function')).toEqual([]);
      });
    }

    it('sem credencial, credencial lixo ou adulterada: null', async () => {
      const b = await fabrica();
      expect(await b.provider.resolver({ headers: {} })).toBeNull();
      expect(await b.provider.resolver({ headers: { authorization: 'Bearer x', cookie: 'sessao=x; __Host-sessao=x' } })).toBeNull();
      const s = await b.sessao({ perfis: ['admin'], comFator: true });
      expect(await b.provider.resolver({ headers: adulterar(s.cabecalhos) })).toBeNull();
    });

    it('sem segundo fator: mfaEm === null (falha fechada, nunca "agora")', async () => {
      const b = await fabrica();
      const s = await b.sessao({ perfis: ['recepcao'], comFator: false });
      const auth = await b.provider.resolver({ headers: s.cabecalhos });
      expect(auth).not.toBeNull();
      expect(auth?.mfaEm).toBeNull();
    });

    it('com segundo fator: mfaEm é uma data real, que não está no futuro', async () => {
      const b = await fabrica();
      const s = await b.sessao({ perfis: ['profissional'], comFator: true });
      const auth = await b.provider.resolver({ headers: s.cabecalhos });
      expect(auth?.mfaEm).toBeInstanceOf(Date);
      expect(Number.isNaN(auth?.mfaEm?.getTime())).toBe(false);
      expect(auth?.mfaEm?.getTime() ?? Infinity).toBeLessThanOrEqual(Date.now());
    });

    it('clínica, usuário, perfis e MFA vêm só da sessão: cabeçalhos forjados não mudam nada', async () => {
      const b = await fabrica();
      const s = await b.sessao({ perfis: ['recepcao'], comFator: false });
      const limpo = await b.provider.resolver({ headers: s.cabecalhos });
      const forjado = await b.provider.resolver({ headers: { ...FORJADOS(randomUUID()), ...s.cabecalhos } });
      expect(forjado).toEqual(limpo);
      expect(forjado).toMatchObject({ tenantId: s.tenantId, userId: s.userId, perfis: ['recepcao'], mfaEm: null });
      expect(await b.provider.resolver({ headers: FORJADOS(s.tenantId) })).toBeNull();
    });

    it('perfis só da lista fechada', async () => {
      const b = await fabrica();
      const s = await b.sessao({ perfis: ['admin', 'financeiro'], comFator: true });
      const auth = await b.provider.resolver({ headers: s.cabecalhos });
      expect(auth?.perfis.length ?? 0).toBeGreaterThan(0);
      for (const p of auth?.perfis ?? []) expect(PERFIS).toContain(p);
    });

    it('logout: a mesma credencial passa a valer null', async () => {
      const b = await fabrica();
      const s = await b.sessao({ perfis: ['admin'], comFator: true });
      expect(await b.provider.resolver({ headers: s.cabecalhos })).not.toBeNull();
      await b.encerrar(s.cabecalhos);
      expect(await b.provider.resolver({ headers: s.cabecalhos })).toBeNull();
    });

    it('sessões de usuários e clínicas diferentes não se misturam', async () => {
      const b = await fabrica();
      const s1 = await b.sessao({ perfis: ['admin'], comFator: true });
      const s2 = await b.sessao({ perfis: ['recepcao'], comFator: false });
      expect(await b.provider.resolver({ headers: s1.cabecalhos })).toMatchObject({ tenantId: s1.tenantId, userId: s1.userId, perfis: ['admin'] });
      expect(await b.provider.resolver({ headers: s2.cabecalhos })).toMatchObject({ tenantId: s2.tenantId, userId: s2.userId, mfaEm: null });
    });

    // Ganchos: obrigatórios fora do `dev` (conferido acima); na sessão fictícia, ausentes viram it.todo visível.
    const comGancho = (g: keyof GanchosDoProvedorReal, nome: string, fn: (b: BancadaDoProvedor, h: GanchosDoProvedorReal) => Promise<void>): void => {
      it(nome, async (ctx) => {
        const b = await fabrica();
        if (typeof b.ganchos?.[g] !== 'function') {
          if (tipo === 'dev') return ctx.skip();
          throw new Error(`gancho ${g} ausente`);
        }
        await fn(b, b.ganchos as GanchosDoProvedorReal);
      });
    };
    comGancho('trocarClinica', 'trocar de clínica zera o MFA', async (b, h) => {
      const s = await b.sessao({ perfis: ['admin'], comFator: true });
      expect((await b.provider.resolver({ headers: await h.trocarClinica(s) }))?.mfaEm ?? null).toBeNull();
    });
    comGancho('trocarPerfis', 'trocar de perfil zera o MFA', async (b, h) => {
      const s = await b.sessao({ perfis: ['recepcao'], comFator: true });
      expect((await b.provider.resolver({ headers: await h.trocarPerfis(s, ['recepcao', 'admin']) }))?.mfaEm ?? null).toBeNull();
    });
    comGancho('trocarSenha', 'trocar a senha zera o MFA (ou derruba a sessão)', async (b, h) => {
      const s = await b.sessao({ perfis: ['admin'], comFator: true });
      expect((await b.provider.resolver({ headers: await h.trocarSenha(s) }))?.mfaEm ?? null).toBeNull();
    });
    comGancho('stepUp', 'step-up atualiza o mfaEm para agora', async (b, h) => {
      const s = await b.sessao({ perfis: ['admin'], comFator: false });
      const antes = Date.now();
      const auth = await b.provider.resolver({ headers: await h.stepUp(s) });
      expect(auth?.mfaEm?.getTime() ?? 0).toBeGreaterThanOrEqual(antes - 1000);
      expect(auth?.mfaEm?.getTime() ?? Infinity).toBeLessThanOrEqual(Date.now());
    });
    comGancho('expirar', 'sessão expirada: null', async (b, h) => {
      const s = await b.sessao({ perfis: ['admin'], comFator: true });
      await h.expirar(s);
      expect(await b.provider.resolver({ headers: s.cabecalhos })).toBeNull();
    });
    comGancho('forjarCredencial', 'credencial forjada (sem passar pelo login): null', async (b, h) => {
      expect(await b.provider.resolver({ headers: await h.forjarCredencial() })).toBeNull();
    });
  });
}
