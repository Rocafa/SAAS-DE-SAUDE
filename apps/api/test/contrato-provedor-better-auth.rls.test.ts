/**
 * Contrato do provedor de sessão (#128) com o provedor REAL (D4: Better Auth), contra o banco. A bancada cria
 * clínica, pessoa e credencial de verdade, entra pela biblioteca e implementa os 6 ganchos pelas funções do provedor
 * (R13 do parecer do desenho). Também confere o que o desenho promete: cookie, campos nossos protegidos, papel
 * app_auth isolado, função de clínicas e prazo absoluto. PR 2: o `stepUp` e a sessão com fator passam pelo TOTP
 * DE VERDADE (cadastro e verificação pela HTTP da biblioteca), mais bloqueio 5/15, reuso de código e eventos do fator.
 * Dados fictícios.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { conta, doisFatores, sessao, usuario } from '../src/db/identidade';
import { auditLog } from '../src/db/schema';
import { createDatabase, withTenant, type DatabaseHandle } from '../src/db/tenant-transaction';
import { CABECALHO_ORIGEM, criarAutenticacao, nomeDoCookie, type Autenticacao, type OpcoesDaAutenticacao } from '../src/modules/auth/better-auth/instancia';
import { MemoryRateLimitStore } from '../src/security/rate-limit-store';
import { codigoErrado, codigoTotp, segredoDoUri } from './apoio-totp';
import { BetterAuthProvider } from '../src/modules/auth/better-auth/provedor';
import { gerarHashDeSenha } from '../src/modules/auth/better-auth/senha';
import type { Perfil } from '../src/modules/auth/perfis';
import { executarContrato, type BancadaDoProvedor, type Cabecalhos, type SessaoDaBancada } from './apoio-contrato-provedor';
import { subirApi, type ApiDeTeste } from './apoio-api';

const SENHA = 'Senha-Ficticia-de-Teste-1';
const SENHA_NOVA = 'Senha-Ficticia-de-Teste-2';
/** Dublê da base de senhas vazadas (o teste não sai para a internet): só esta senha "vazou". */
const SENHA_VAZADA = 'Senha-Vazada-Ficticia-1';
const senhaVazadaFicticia = (s: string): Promise<boolean> => Promise.resolve(s === SENHA_VAZADA);
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
    store: new MemoryRateLimitStore(),
    conferirSenhaVazada: senhaVazadaFicticia,
    fator: {
      aoVerificarMfa: (e) => provedor.aposMfaVerificado(e.sessaoId, e.userId, e.motivo),
      aoFalharMfa: (e) => provedor.aposMfaRecusado(e.sessaoId, e.userId, e.bloqueou),
    },
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

/** Ganchos do fator que não fazem nada (instâncias extras da bancada). */
const SEM_FATOR: OpcoesDaAutenticacao['fator'] = { aoVerificarMfa: () => Promise.resolve(), aoFalharMfa: () => Promise.resolve() };

/** Junta os cookies vivos de uma resposta aos de antes (o que o navegador faria). */
function juntarCookies(antes: Cabecalhos, r: Response): Cabecalhos {
  const jarro = new Map<string, string>();
  for (const par of String(antes.cookie ?? '').split(/;\s*/).filter(Boolean)) jarro.set(par.split('=')[0] ?? '', par);
  for (const c of r.headers.getSetCookie()) {
    const par = c.split(';')[0] ?? '';
    const nome = par.split('=')[0] ?? '';
    if (/max-age=0/i.test(c) || par.endsWith('=')) jarro.delete(nome);
    else jarro.set(nome, par);
  }
  return jarro.size ? { cookie: [...jarro.values()].join('; ') } : {};
}

type Postado = { r: Response; json: Record<string, unknown>; cabecalhos: Cabecalhos };

/** POST pela HTTP da biblioteca, como a montagem entrega: Origin da allowlist e a origem já em HMAC. */
async function postar(caminho: string, c: Cabecalhos, corpo: Record<string, unknown>, origem = 'a1b2c3d4e5f60718'): Promise<Postado> {
  const r = await auth.handler(
    new Request(`http://localhost:3000/api/auth${caminho}`, {
      method: 'POST',
      headers: { origin: 'http://localhost:3000', 'content-type': 'application/json', [CABECALHO_ORIGEM]: origem, ...(c.cookie ? { cookie: String(c.cookie) } : {}) },
      body: JSON.stringify(corpo),
    }),
  );
  const texto = await r.clone().text();
  return { r, json: texto ? (JSON.parse(texto) as Record<string, unknown>) : {}, cabecalhos: juntarCookies(c, r) };
}

/** Só o cookie de sessão (sem o desafio do login em duas etapas). */
function soSessao(c: Cabecalhos): Cabecalhos {
  const par = String(c.cookie ?? '').split('; ').find((x) => x.startsWith(`${nomeDoCookie(false)}=`));
  if (!par) throw new Error('sem cookie de sessão');
  return { cookie: par };
}

/** Segredo do TOTP por pessoa e quantas verificações já fez (para não repetir código no período: 0, +1, -1). */
const segredos = new Map<string, { segredo: Buffer; usos: number }>();
/** Senha atual por pessoa (o gancho trocarSenha muda). */
const senhas = new Map<string, string>();
const DESLOCAMENTOS = [0, 1, -1] as const;

function proximoCodigo(userId: string): string {
  const s = segredos.get(userId);
  if (!s) throw new Error('pessoa sem TOTP cadastrado');
  const d = DESLOCAMENTOS[s.usos % DESLOCAMENTOS.length] ?? 0;
  s.usos++;
  return codigoTotp(s.segredo, d);
}

/** Cadastro real do TOTP (senha + primeiro código). A biblioteca troca a sessão: devolve o cookie novo. */
async function cadastrarFator(c: Cabecalhos, userId: string, senha = SENHA): Promise<Cabecalhos> {
  const inicio = await postar('/two-factor/enable', c, { password: senha });
  expect(inicio.r.status, JSON.stringify(inicio.json)).toBe(200);
  segredos.set(userId, { segredo: segredoDoUri(String(inicio.json['totpURI'])), usos: 0 });
  const fim = await postar('/two-factor/verify-totp', inicio.cabecalhos, { code: proximoCodigo(userId) });
  expect(fim.r.status, JSON.stringify(fim.json)).toBe(200);
  return soSessao(fim.cabecalhos);
}

/** Reverificação real com sessão aberta (step-up). */
async function reverificar(c: Cabecalhos, userId: string): Promise<Response> {
  return (await postar('/two-factor/verify-totp', c, { code: proximoCodigo(userId) })).r;
}

async function trilhaDoFator(tenantId: string, userId: string): Promise<string[]> {
  const linhas = await withTenant(api.db.db, tenantId as never, (tx) =>
    tx.execute<{ action: string; op: string }>(sql`select action, metadata->>'op' as op from audit_log where scope = 'mfa' and actor_id = ${userId} order by seq`),
  );
  return linhas.map((l) => `${l.action}:${l.op}`);
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
      // PR 2: MFA pelo TOTP de verdade (cadastro + primeiro código), não mais pela função interna.
      const comCodigo = comFator ? await cadastrarFator(cabecalhos, userId) : cabecalhos;
      return { cabecalhos: comCodigo, tenantId, userId };
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
        senhas.set(s.userId, SENHA_NOVA);
        const nova = r.headers.getSetCookie().find((c) => c.startsWith(`${nomeDoCookie(false)}=`));
        return nova ? { cookie: nova.split(';')[0] as string } : s.cabecalhos;
      },
      stepUp: async (s) => {
        // Sem TOTP ainda: o cadastro já marca o MFA. Com TOTP: reverificação com a sessão aberta.
        if (!segredos.has(s.userId)) return cadastrarFator(s.cabecalhos, s.userId, senhas.get(s.userId) ?? SENHA);
        expect((await reverificar(s.cabecalhos, s.userId)).status).toBe(200);
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

  it('R8 do parecer do código: em modo produção TODO Set-Cookie é Secure, HttpOnly, SameSite=Strict, Path=/ e sem Domain; a sessão sai exatamente como __Host-sessao', async () => {
    const prod = criarAutenticacao({
      db: dbAuth.db,
      segredo: randomBytes(32).toString('base64'),
      baseURL: 'https://api.exemplo.test',
      origensConfiaveis: ['https://app.exemplo.test'],
      producao: true,
      chaveHmac: randomBytes(32),
      store: new MemoryRateLimitStore(),
      conferirSenhaVazada: senhaVazadaFicticia,
      fator: SEM_FATOR,
    });
    const tenantId = await api.novaClinica();
    const { email } = await novaPessoa(tenantId, ['recepcao']);
    const r = await prod.api.signInEmail({ body: { email, password: SENHA, rememberMe: false }, asResponse: true });
    expect(r.status).toBe(200);
    const cookies = r.headers.getSetCookie();
    expect(cookies.length).toBeGreaterThan(0);
    for (const c of cookies) {
      expect(c, c.split('=')[0]).toMatch(/;\s*Secure/i);
      expect(c, c.split('=')[0]).toMatch(/HttpOnly/i);
      expect(c, c.split('=')[0]).toMatch(/SameSite=Strict/i);
      expect(c, c.split('=')[0]).toMatch(/Path=\//i);
      expect(c, c.split('=')[0]).not.toMatch(/Domain=/i);
      expect(c.startsWith('__Secure-__Host')).toBe(false);
    }
    expect(cookies.some((c) => c.startsWith('__Host-sessao='))).toBe(true);
  });

  it('conta inativa não abre sessão (o gancho recusa antes de criar)', async () => {
    const tenantId = await api.novaClinica();
    const { userId, email } = await novaPessoa(tenantId, ['recepcao']);
    await dbAuth.db.update(usuario).set({ ativo: false }).where(eq(usuario.id, userId));
    const r = await entrar(email);
    expect(r.headers.getSetCookie().some((c) => c.startsWith(`${nomeDoCookie(false)}=`))).toBe(false);
    expect(await dbAuth.db.select().from(sessao).where(eq(sessao.userId, userId))).toEqual([]);
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

  it('R7: o espelho de vínculos devolve só as clínicas com vínculo ativo de sessão; o app_user não lê o espelho', async () => {
    const t1 = await api.novaClinica();
    const t2 = await api.novaClinica();
    const { userId } = await novaPessoa(t1, ['recepcao']);
    await api.membro(t2, { userId }, 'psicologo');
    expect(await provedor.clinicasDoUsuario(userId)).toEqual([t1]);
    await expect(api.db.db.execute(sql`select clinica_id from identidade.vinculo limit 1`)).rejects.toThrow();
    // Revogado: some do espelho (o trigger acompanha a revogação).
    const adm = await api.membro(t1, api.sessao(t1, 'admin'), 'admin');
    await api.http().delete(`/clinica/membros/${userId}/recepcao`).set({ Authorization: adm.Authorization }).expect(204);
    expect(await provedor.clinicasDoUsuario(userId)).toEqual([]);
  });

  it('o logout deixa linha na trilha da clínica, não só no log de segurança', async () => {
    const tenantId = await api.novaClinica();
    const { userId, email } = await novaPessoa(tenantId, ['recepcao']);
    const c = cookieDe(await entrar(email));
    expect(await provedor.resolver({ headers: c })).toMatchObject({ tenantId, userId });
    await provedor.encerrar(await sessaoId(c), 'logout', userId);
    const linhas = await withTenant(api.db.db, tenantId, (tx) =>
      tx
        .select({ action: auditLog.action, metadata: auditLog.metadata })
        .from(auditLog)
        .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.actorId, userId), eq(auditLog.scope, 'session'))),
    );
    // A trilha é a prova; o log de segurança é para alarmar. O fim da sessão tem de aparecer na trilha da clínica.
    const ops = linhas.map((l) => (l.metadata as { op?: string }).op);
    expect(new Set(ops)).toEqual(new Set(['session_tenant_selected', 'session_ended']));
    expect(linhas.find((l) => (l.metadata as { op?: string }).op === 'session_ended')?.metadata).toMatchObject({
      op: 'session_ended',
      reason: 'logout',
    });
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

describe('PR 2: TOTP, bloqueio 5/15 e eventos do fator (R5 e R6 do #123)', () => {
  const SENHA_ERRADA = 'Senha-Errada-Ficticia-9';

  async function pessoaLogada(perfis: Perfil[] = ['admin']) {
    const tenantId = await api.novaClinica();
    const p = await novaPessoa(tenantId, perfis);
    const c = cookieDe(await entrar(p.email));
    await provedor.resolver({ headers: c });
    return { ...p, tenantId, c };
  }

  it('cadastro: senha errada recusada; o URI volta sem códigos de reserva; o segredo fica cifrado; o primeiro código troca a sessão, grava mfa_em e a trilha', async () => {
    const { userId, tenantId, c } = await pessoaLogada();
    expect((await postar('/two-factor/enable', c, { password: SENHA_ERRADA })).r.status).toBe(400);
    const inicio = await postar('/two-factor/enable', c, { password: SENHA });
    expect(inicio.r.status).toBe(200);
    expect(Object.keys(inicio.json).sort()).toEqual(['method', 'totpURI']);
    const uri = String(inicio.json['totpURI']);
    expect(uri).toMatch(/^otpauth:\/\/totp\/Plataforma%20Saude:/);
    const segredo = segredoDoUri(uri);
    const [linha] = await dbAuth.db.select().from(doisFatores).where(eq(doisFatores.userId, userId));
    expect(linha?.verified).toBe(false);
    expect(linha?.secret).not.toContain(new URL(uri).searchParams.get('secret') ?? '-');
    expect(linha?.secret).not.toContain(segredo.toString('utf8'));
    // Cadastro iniciado e não concluído: ainda sem MFA.
    expect((await provedor.resolver({ headers: c }))?.mfaEm).toBeNull();
    const fim = await postar('/two-factor/verify-totp', c, { code: codigoTotp(segredo) });
    expect(fim.r.status).toBe(200);
    const nova = soSessao(fim.cabecalhos);
    expect(nova.cookie).not.toBe(c.cookie);
    expect((await provedor.resolver({ headers: nova }))?.mfaEm).toBeInstanceOf(Date);
    const [u] = await dbAuth.db.select({ ativo: usuario.twoFactorEnabled }).from(usuario).where(eq(usuario.id, userId));
    expect(u?.ativo).toBe(true);
    // A senha errada do cadastro também fica na trilha (falha do fator com sessão aberta).
    expect(await trilhaDoFator(tenantId, userId)).toEqual(['login_failed:mfa_failed', 'login:mfa_enrolled', 'login:mfa_verified']);
  });

  it('login com TOTP: a senha certa não abre sessão (só o desafio); "lembrar este aparelho" é recusado; o código abre a sessão já com mfa_em', async () => {
    const { userId, email, c } = await pessoaLogada();
    await cadastrarFator(c, userId);
    const senha = await postar('/sign-in/email', {}, { email, password: SENHA });
    expect(senha.r.status).toBe(200);
    expect(senha.json['twoFactorRedirect']).toBe(true);
    expect(String(senha.cabecalhos.cookie ?? '')).not.toContain(`${nomeDoCookie(false)}=`);
    expect((await postar('/two-factor/verify-totp', senha.cabecalhos, { code: proximoCodigo(userId), trustDevice: true })).r.status).toBe(400);
    const ok = await postar('/two-factor/verify-totp', senha.cabecalhos, { code: proximoCodigo(userId) });
    expect(ok.r.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.r.headers.getSetCookie().some((x) => /trust_device=[^;]/.test(x))).toBe(false);
    expect((await provedor.resolver({ headers: soSessao(ok.cabecalhos) }))?.mfaEm).toBeInstanceOf(Date);
  });

  it('código já apresentado não vale de novo, mesmo dentro da janela (RFC 6238 §5.2)', async () => {
    const { userId, c } = await pessoaLogada();
    const s = await cadastrarFator(c, userId);
    const segredo = segredos.get(userId)?.segredo ?? Buffer.alloc(0);
    const repetido = await postar('/two-factor/verify-totp', s, { code: codigoTotp(segredo, 0) });
    expect(repetido.r.status).toBe(401);
    expect(repetido.json['code']).toBe('INVALID_CODE');
  });

  it('bloqueio do fator: 5 códigos errados em 15 min travam a reverificação, mesmo com o código certo; a trilha guarda as falhas e o bloqueio', async () => {
    const { userId, tenantId, c } = await pessoaLogada();
    const s = await cadastrarFator(c, userId);
    const segredo = segredos.get(userId)?.segredo ?? Buffer.alloc(0);
    for (let i = 0; i < 5; i++) {
      expect((await postar('/two-factor/verify-totp', s, { code: codigoErrado(segredo, i) }, 'd1b2c3d4e5f60718')).r.status).toBe(401);
    }
    const certo = await postar('/two-factor/verify-totp', s, { code: proximoCodigo(userId) }, 'd1b2c3d4e5f60718');
    expect(certo.r.status).toBe(429);
    expect(certo.json['code']).toBe('ACCOUNT_TEMPORARILY_LOCKED');
    const trilha = await trilhaDoFator(tenantId, userId);
    expect(trilha.filter((x) => x === 'login_failed:mfa_failed')).toHaveLength(5);
    expect(trilha.filter((x) => x === 'login_failed:mfa_locked')).toHaveLength(1);
  });

  it('R1 do parecer: 20 códigos errados AO MESMO TEMPO; no máximo 5 chegam à conferência e o código certo depois recebe 429', async () => {
    const { userId, tenantId, c } = await pessoaLogada();
    const s = await cadastrarFator(c, userId);
    const segredo = segredos.get(userId)?.segredo ?? Buffer.alloc(0);
    const rajada = await Promise.all(
      Array.from({ length: 20 }, (_, i) => postar('/two-factor/verify-totp', s, { code: codigoErrado(segredo, 100 + i) }, '0a1b2c3d4e5f6071')),
    );
    const status = rajada.map((x) => x.r.status);
    expect(status.filter((x) => x === 401).length).toBeLessThanOrEqual(5);
    expect(status.filter((x) => x === 429).length).toBeGreaterThanOrEqual(15);
    // Só as que chegaram à conferência geram linha de falha na trilha.
    expect((await trilhaDoFator(tenantId, userId)).filter((x) => x === 'login_failed:mfa_failed').length).toBeLessThanOrEqual(5);
    const certo = await postar('/two-factor/verify-totp', s, { code: proximoCodigo(userId) }, '0a1b2c3d4e5f6071');
    expect(certo.r.status).toBe(429);
  });

  it('R1 do parecer: o acerto devolve a reserva (4 erros + 1 acerto não travam a próxima tentativa)', async () => {
    const { userId, c } = await pessoaLogada();
    const s = await cadastrarFator(c, userId);
    const segredo = segredos.get(userId)?.segredo ?? Buffer.alloc(0);
    for (let i = 0; i < 4; i++) expect((await postar('/two-factor/verify-totp', s, { code: codigoErrado(segredo, 200 + i) }, '1a1b2c3d4e5f6071')).r.status).toBe(401);
    expect((await reverificar(s, userId)).status).toBe(200);
    expect((await reverificar(s, userId)).status).toBe(200);
  });

  it('R13 do parecer: tentativa barrada não soma no outro contador (e-mail travado não tranca a origem; origem travada não tranca os e-mails)', async () => {
    const tenantId = await api.novaClinica();
    const [insistente, colega, outra] = await Promise.all([0, 1, 2].map(() => novaPessoa(tenantId, ['recepcao'])));
    const origem = '2a1b2c3d4e5f6071';
    // E-mail travado (5 falhas) e mais 30 tentativas insistindo nele: a origem continua livre para o colega.
    for (let i = 0; i < 35; i++) await postar('/sign-in/email', {}, { email: insistente?.email, password: SENHA_ERRADA }, origem);
    expect((await postar('/sign-in/email', {}, { email: colega?.email, password: SENHA }, origem)).r.status).toBe(200);
    // Origem travada (30 falhas em e-mails distintos): a senha certa barrada nela não soma no e-mail da pessoa.
    const origemTravada = '3a1b2c3d4e5f6071';
    for (let i = 0; i < 30; i++) await postar('/sign-in/email', {}, { email: `fantasma-${i}-${randomUUID().slice(0, 6)}@exemplo.test`, password: SENHA_ERRADA }, origemTravada);
    for (let i = 0; i < 6; i++) expect((await postar('/sign-in/email', {}, { email: outra?.email, password: SENHA }, origemTravada)).r.status).toBe(401);
    expect((await postar('/sign-in/email', {}, { email: outra?.email, password: SENHA }, '4a1b2c3d4e5f6071')).r.status).toBe(200);
  }, 60_000);

  it('R12 do parecer: o cadastro aceita só TOTP com o emissor nosso', async () => {
    const { c } = await pessoaLogada();
    expect((await postar('/two-factor/enable', c, { password: SENHA, method: 'otp' })).r.status).toBe(400);
    expect((await postar('/two-factor/enable', c, { password: SENHA, issuer: 'Banco Ficticio' })).r.status).toBe(400);
  });

  it('bloqueio do login: depois de 5 senhas erradas, até a senha certa recebe a MESMA resposta da senha errada; e-mail inexistente idem', async () => {
    const { email } = await pessoaLogada();
    const origem = 'e1b2c3d4e5f60718';
    const errada = await postar('/sign-in/email', {}, { email, password: SENHA_ERRADA }, origem);
    expect(errada.r.status).toBe(401);
    for (let i = 0; i < 4; i++) await postar('/sign-in/email', {}, { email: i % 2 ? email.toUpperCase() : email, password: SENHA_ERRADA }, origem);
    const certa = await postar('/sign-in/email', {}, { email, password: SENHA }, origem);
    expect(certa.r.status).toBe(errada.r.status);
    expect(certa.json).toEqual(errada.json);
    expect(String(certa.cabecalhos.cookie ?? '')).not.toContain(`${nomeDoCookie(false)}=`);
    const fantasma = `nao-existe-${randomUUID().slice(0, 8)}@exemplo.test`;
    for (let i = 0; i < 5; i++) await postar('/sign-in/email', {}, { email: fantasma, password: SENHA_ERRADA }, 'f1b2c3d4e5f60718');
    const outra = await postar('/sign-in/email', {}, { email: fantasma, password: SENHA_ERRADA }, 'f1b2c3d4e5f60718');
    expect(outra.r.status).toBe(errada.r.status);
    expect(outra.json).toEqual(errada.json);
  });

  it('R15: senha nova que aparece na base de vazadas é recusada na troca; a senha atual continua valendo', async () => {
    const { email, c } = await pessoaLogada();
    // Chamada interna: o erro do gancho `before` sobe como exceção (pela HTTP vira a resposta 400).
    await expect(
      auth.api.changePassword({
        body: { currentPassword: SENHA, newPassword: SENHA_VAZADA, revokeOtherSessions: true },
        headers: new Headers(c as Record<string, string>),
      }),
    ).rejects.toMatchObject({ statusCode: 400, body: { code: 'PASSWORD_COMPROMISED' } });
    expect((await entrar(email)).status).toBe(200);
  });

  it('R15: o tempo da recusa é equivalente para conta existente, inexistente e bloqueada (mesmo custo de hash)', async () => {
    const tenantId = await api.novaClinica();
    const existentes = await Promise.all([0, 1, 2, 3, 4].map(() => novaPessoa(tenantId, ['recepcao'])));
    const medir = async (email: string, origem: string): Promise<number> => {
      const t0 = performance.now();
      await postar('/sign-in/email', {}, { email, password: SENHA_ERRADA }, origem);
      return performance.now() - t0;
    };
    const mediana = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
    const tExistente = mediana(await sequencial(existentes.map((p, i) => () => medir(p.email, `aa00000000000${i}0`))));
    const tInexistente = mediana(await sequencial([0, 1, 2, 3, 4].map((i) => () => medir(`fantasma-${i}-${randomUUID().slice(0, 6)}@exemplo.test`, `bb00000000000${i}0`))));
    const bloqueada = existentes[0]?.email ?? '';
    for (let i = 0; i < 5; i++) await medir(bloqueada, 'cc00000000000000');
    const tBloqueada = mediana(await sequencial([0, 1, 2, 3, 4].map(() => () => medir(bloqueada, 'cc00000000000000'))));
    // Sem o hash de mentira, a conta inexistente e a bloqueada responderiam dezenas de vezes mais rápido.
    for (const t of [tInexistente, tBloqueada]) {
      expect(t / tExistente, `existente ${tExistente.toFixed(0)} ms x ${t.toFixed(0)} ms`).toBeGreaterThan(1 / 3);
      expect(t / tExistente, `existente ${tExistente.toFixed(0)} ms x ${t.toFixed(0)} ms`).toBeLessThan(3);
    }
  }, 60_000);
});

async function sequencial<T>(tarefas: (() => Promise<T>)[]): Promise<T[]> {
  const saida: T[] = [];
  for (const t of tarefas) saida.push(await t());
  return saida;
}
