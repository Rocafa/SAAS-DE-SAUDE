/**
 * Contrato do provedor de sessão (#128) com o provedor REAL (D4: Better Auth), contra o banco. A bancada cria
 * clínica, pessoa e credencial de verdade, entra pela biblioteca e implementa os 6 ganchos pelas funções do provedor
 * (R13 do parecer do desenho). Também confere o que o desenho promete: cookie, campos nossos protegidos, papel
 * app_auth isolado, função de clínicas e prazo absoluto. Dados fictícios.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { conta, sessao, usuario } from '../src/db/identidade';
import { createDatabase, type DatabaseHandle } from '../src/db/tenant-transaction';
import { criarAutenticacao, nomeDoCookie, type Autenticacao } from '../src/modules/auth/better-auth/instancia';
import { BetterAuthProvider } from '../src/modules/auth/better-auth/provedor';
import { gerarHashDeSenha } from '../src/modules/auth/better-auth/senha';
import type { Perfil } from '../src/modules/auth/perfis';
import { executarContrato, type BancadaDoProvedor, type Cabecalhos, type SessaoDaBancada } from './apoio-contrato-provedor';
import { subirApi, type ApiDeTeste } from './apoio-api';

const SENHA = 'Senha-Ficticia-de-Teste-1';
const SENHA_NOVA = 'Senha-Ficticia-de-Teste-2';
let api: ApiDeTeste;
let dbAuth: DatabaseHandle;
let auth: Autenticacao;
let provedor: BetterAuthProvider;

beforeAll(async () => {
  api = await subirApi();
  const urlAuth = process.env.DATABASE_AUTH_URL;
  if (!urlAuth) throw new Error('DATABASE_AUTH_URL (papel app_auth) é obrigatória neste teste');
  dbAuth = createDatabase(urlAuth, { max: 2 });
  auth = criarAutenticacao({
    db: dbAuth.db,
    segredo: randomBytes(32).toString('base64'),
    baseURL: 'http://localhost:3000',
    origensConfiaveis: ['http://localhost:3000'],
    producao: false,
    chaveHmac: randomBytes(32),
  });
  provedor = new BetterAuthProvider({ auth, dbAuth: dbAuth.db, dbClinica: api.db.db });
}, 120_000);

afterAll(async () => {
  await dbAuth?.close();
  await api?.fechar();
});

/** `cookie: sessao=...` a partir do Set-Cookie da biblioteca. */
function cookieDe(resposta: Response): Cabecalhos {
  const bruto = resposta.headers.getSetCookie().find((c) => c.startsWith(`${nomeDoCookie(false)}=`));
  if (!bruto) throw new Error('login não devolveu o cookie de sessão');
  return { cookie: bruto.split(';')[0] };
}

async function sessaoId(c: Cabecalhos): Promise<string> {
  const s = await auth.api.getSession({ headers: new Headers(c as Record<string, string>) });
  if (!s) throw new Error('sessão não encontrada');
  return s.session.id;
}

async function novaPessoa(tenantId: string, perfis: readonly Perfil[]): Promise<{ userId: string; email: string }> {
  const userId = randomUUID();
  const email = `pessoa-${userId.slice(0, 8)}@exemplo.test`;
  await dbAuth.db.insert(usuario).values({ id: userId, name: 'Pessoa Ficticia', email, emailVerified: true });
  await dbAuth.db.insert(conta).values({ id: randomUUID(), accountId: userId, providerId: 'credential', userId, password: await gerarHashDeSenha(SENHA) });
  await api.membro(tenantId as never, { userId }, ...perfis);
  return { userId, email };
}

async function entrar(email: string, senha = SENHA): Promise<Response> {
  return auth.api.signInEmail({ body: { email, password: senha }, asResponse: true });
}

function bancada(): Promise<BancadaDoProvedor> {
  return Promise.resolve({
    provider: provedor,
    sessao: async ({ perfis, comFator }): Promise<SessaoDaBancada> => {
      const tenantId = await api.novaClinica();
      const { userId, email } = await novaPessoa(tenantId, perfis);
      const cabecalhos = cookieDe(await entrar(email));
      // Primeira resolução escolhe a clínica (única) e grava session_tenant_selected.
      await provedor.resolver({ headers: cabecalhos });
      if (comFator) await provedor.marcarMfa(await sessaoId(cabecalhos));
      return { cabecalhos, tenantId, userId };
    },
    encerrar: async (c) => {
      await auth.api.signOut({ headers: new Headers(c as Record<string, string>) });
    },
    ganchos: {
      trocarClinica: async (s) => {
        const outra = await api.novaClinica();
        await api.membro(outra, { userId: s.userId }, 'admin');
        expect(await provedor.definirClinica(await sessaoId(s.cabecalhos), s.userId, outra)).toBe(true);
        return s.cabecalhos;
      },
      trocarPerfis: async (s, perfis) => {
        await api.membro(s.tenantId as never, { userId: s.userId }, ...perfis.filter((p) => p !== 'recepcao'));
        return s.cabecalhos;
      },
      trocarSenha: async (s) => {
        const r = await auth.api.changePassword({
          body: { currentPassword: SENHA, newPassword: SENHA_NOVA, revokeOtherSessions: true },
          headers: new Headers(s.cabecalhos as Record<string, string>),
          asResponse: true,
        });
        expect(r.status).toBe(200);
        const nova = r.headers.getSetCookie().find((c) => c.startsWith(`${nomeDoCookie(false)}=`));
        return nova ? { cookie: nova.split(';')[0] as string } : s.cabecalhos;
      },
      stepUp: async (s) => {
        expect(await provedor.marcarMfa(await sessaoId(s.cabecalhos))).toBe(true);
        return s.cabecalhos;
      },
      expirar: async (s) => {
        await dbAuth.db.update(sessao).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(sessao.id, await sessaoId(s.cabecalhos)));
      },
      forjarCredencial: () => Promise.resolve({ cookie: `${nomeDoCookie(false)}=${randomBytes(24).toString('base64url')}.${randomBytes(32).toString('base64url')}` }),
    },
  });
}

executarContrato('better-auth', bancada);

describe('Better Auth: o que o desenho promete (R1, R3, R5, R7, R8 do parecer)', () => {
  it('R8: cookie de sessão HttpOnly, SameSite=Strict e Path=/ (em dev/test sem __Host-; em produção com __Host- e Secure)', async () => {
    const tenantId = await api.novaClinica();
    const { email } = await novaPessoa(tenantId, ['recepcao']);
    const r = await entrar(email);
    const cookie = r.headers.getSetCookie().find((c) => c.startsWith(`${nomeDoCookie(false)}=`)) ?? '';
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\//i);
    expect(cookie).not.toMatch(/Domain=/i);
    expect(nomeDoCookie(true)).toBe('__Host-sessao');
  });

  it('senha errada: sem cookie de sessão e sem dizer se a conta existe (mesmo status para e-mail inexistente)', async () => {
    const tenantId = await api.novaClinica();
    const { email } = await novaPessoa(tenantId, ['recepcao']);
    const errada = await entrar(email, 'Senha-Errada-Ficticia-9');
    const inexistente = await entrar(`nao-existe-${randomUUID().slice(0, 8)}@exemplo.test`, 'Senha-Errada-Ficticia-9');
    expect(errada.status).toBe(inexistente.status);
    expect(errada.headers.getSetCookie().some((c) => c.startsWith(`${nomeDoCookie(false)}=`))).toBe(false);
  });

  it('R5: os campos nossos (clínica ativa, MFA) não saem na resposta da biblioteca', async () => {
    const tenantId = await api.novaClinica();
    const { email } = await novaPessoa(tenantId, ['admin']);
    const c = cookieDe(await entrar(email));
    await provedor.resolver({ headers: c });
    const s = await auth.api.getSession({ headers: new Headers(c as Record<string, string>) });
    expect(JSON.stringify(s)).not.toMatch(/clinicaAtiva|mfaEm|perfisNoMfa/);
  });

  it('R3: sessão com mais de 12 h é recusada e APAGADA, mesmo dentro da inatividade', async () => {
    const tenantId = await api.novaClinica();
    const { email } = await novaPessoa(tenantId, ['admin']);
    const c = cookieDe(await entrar(email));
    const id = await sessaoId(c);
    await dbAuth.db.update(sessao).set({ createdAt: new Date(Date.now() - 13 * 60 * 60 * 1000) }).where(eq(sessao.id, id));
    expect(await provedor.resolver({ headers: c })).toBeNull();
    expect(await dbAuth.db.select().from(sessao).where(eq(sessao.id, id))).toEqual([]);
  });

  it('R10: a sessão guarda o user-agent só em HMAC', async () => {
    const tenantId = await api.novaClinica();
    const { email } = await novaPessoa(tenantId, ['admin']);
    const r = await auth.api.signInEmail({ body: { email, password: SENHA }, headers: new Headers({ 'user-agent': 'Navegador-Ficticio/1.0' }), asResponse: true });
    const [linha] = await dbAuth.db.select({ ua: sessao.userAgent }).from(sessao).where(eq(sessao.id, await sessaoId(cookieDe(r))));
    expect(linha?.ua).toMatch(/^[0-9a-f]{16}$/);
  });

  it('R1: o app_user (rotas de negócio) não lê o schema identidade', async () => {
    await expect(api.db.db.execute(sql`select token from identidade.sessao limit 1`)).rejects.toThrow();
  });

  it('R7: a função de clínicas devolve só as clínicas com vínculo ativo; o app_user não pode chamá-la', async () => {
    const t1 = await api.novaClinica();
    const t2 = await api.novaClinica();
    const { userId } = await novaPessoa(t1, ['recepcao']);
    await api.membro(t2, { userId }, 'psicologo');
    expect(await provedor.clinicasDoUsuario(userId)).toEqual([t1]);
    await expect(api.db.db.execute(sql`select app_clinicas_do_usuario(${userId}::uuid)`)).rejects.toThrow();
  });

  it('R6: sem vínculo ativo, a sessão vale null e perde a clínica', async () => {
    const tenantId = await api.novaClinica();
    const admin = await api.membro(tenantId, api.sessao(tenantId, 'admin'), 'admin');
    const { userId, email } = await novaPessoa(tenantId, ['recepcao']);
    const c = cookieDe(await entrar(email));
    expect(await provedor.resolver({ headers: c })).toMatchObject({ tenantId, userId });
    await api.http().delete(`/clinica/membros/${userId}/recepcao`).set({ Authorization: admin.Authorization }).expect(204);
    expect(await provedor.resolver({ headers: c })).toBeNull();
  });
});
