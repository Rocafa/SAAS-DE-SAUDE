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
import { Controller, Get, Logger, UseGuards, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { AUTH_PROVIDER } from '../src/modules/auth/auth-context';
import { Permissao, SemRenovarSessao, SessaoGuard } from '../src/modules/auth/sessao.guard';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { conta, conviteAceito, doisFatores, recuperacao, sessao, usuario } from '../src/db/identidade';
import { tenants } from '../src/db/schema';
import { createDatabase, withTenant, type DatabaseHandle } from '../src/db/tenant-transaction';
import { CABECALHO_ORIGEM, criarAutenticacao, nomeDoCookie, type Autenticacao, type OpcoesDaAutenticacao } from '../src/modules/auth/better-auth/instancia';
import { MemoryRateLimitStore } from '../src/security/rate-limit-store';
import { ConflitoError, NaoEncontradoError } from '../src/common/erros-dominio';
import { ConvitesService, TETO_DIARIO_DE_CONVITES } from '../src/modules/auth/convites';
import { CredenciaisService } from '../src/modules/auth/credenciais';
import { TenantDatabase } from '../src/modules/tenancy/tenancy.module';
import { codigoErrado, codigoTotp, segredoDoUri } from './apoio-totp';
import { BetterAuthProvider, TETO_DIARIO_DE_RECUPERACOES } from '../src/modules/auth/better-auth/provedor';
import { zerarJanelasDoLog } from '../src/security/log-de-seguranca';
import { gerarHashDeSenha } from '../src/modules/auth/better-auth/senha';
import type { Perfil } from '../src/modules/auth/perfis';
import { executarContrato, type BancadaDoProvedor, type Cabecalhos, type SessaoDaBancada } from './apoio-contrato-provedor';
import { subirApi, type ApiDeTeste } from './apoio-api';

const SENHA = 'Senha-Ficticia-de-Teste-1';
const SENHA_NOVA = 'Senha-Ficticia-de-Teste-2';
/** Dublê da base de senhas vazadas (o teste não sai para a internet): só esta senha "vazou". */
const SENHA_VAZADA = 'Senha-Vazada-Ficticia-1';
const SENHA_ERRADA_TROCA = 'Senha-Errada-Ficticia-8';
const senhaVazadaFicticia = (s: string): Promise<boolean> => Promise.resolve(s === SENHA_VAZADA);
let api: ApiDeTeste;
let dbAuth: DatabaseHandle;
let auth: Autenticacao;
let provedor: BetterAuthProvider;

/** Store e segredo do bloqueio da bancada: os mesmos na instância e no provedor (o desbloqueio zera as mesmas chaves). */
const STORE_DA_BANCADA = new MemoryRateLimitStore();
const CHAVE_HMAC_DA_BANCADA = randomBytes(32);
const SEGREDO_DA_BANCADA = randomBytes(32).toString('base64');

beforeAll(async () => {
  api = await subirApi();
  const urlAuth = process.env.DATABASE_AUTH_URL;
  if (!urlAuth) throw new Error('DATABASE_AUTH_URL (papel app_auth) é obrigatória neste teste');
  dbAuth = createDatabase(urlAuth, { max: 2 });
  auth = criarAutenticacao({
    db: dbAuth.db,
    segredo: SEGREDO_DA_BANCADA,
    baseURL: 'http://localhost:3000',
    origensConfiaveis: ['http://localhost:3000'],
    producao: false,
    chaveHmac: CHAVE_HMAC_DA_BANCADA,
    store: STORE_DA_BANCADA,
    conferirSenhaVazada: senhaVazadaFicticia,
    fator: {
      aoVerificarMfa: (e) => provedor.aposMfaVerificado(e.sessaoId, e.userId, e.motivo),
      aoFalharMfa: (e) => provedor.aposMfaRecusado(e.sessaoId, e.userId, e.bloqueou),
      podeCadastrarFator: (id) => provedor.cadastroLiberado(id),
      aoBloquearFator: (userId) => provedor.avisarFatorBloqueado(userId),
    },
  });
  provedor = new BetterAuthProvider({
    auth,
    dbAuth: dbAuth.db,
    dbClinica: api.db.db,
    conferirSenhaVazada: senhaVazadaFicticia,
    bloqueio: { store: STORE_DA_BANCADA, chaveHmac: CHAVE_HMAC_DA_BANCADA },
    segredoDaInstancia: SEGREDO_DA_BANCADA,
  });
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
const SEM_FATOR: OpcoesDaAutenticacao['fator'] = { aoVerificarMfa: () => Promise.resolve(), aoFalharMfa: () => Promise.resolve(), podeCadastrarFator: () => Promise.resolve(false) };

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

/**
 * R8 do PR 3b: o cadastro do TOTP só vale numa sessão de cadastro pendente (aberta pelo convite ou pela recuperação).
 * As pessoas da bancada nascem direto no banco, então a bancada libera a sessão como o aceite faria.
 */
async function liberarCadastro(c: Cabecalhos): Promise<void> {
  await dbAuth.db.update(sessao).set({ cadastroPendenteAte: new Date(Date.now() + 15 * 60_000) }).where(eq(sessao.id, await sessaoId(c)));
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
  await liberarCadastro(c);
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

@Controller('teste-cookie')
@UseGuards(SessaoGuard)
class AlvoDoCookie {
  @Get('comum')
  @Permissao('pacientes:ler')
  comum(): { ok: true } {
    return { ok: true };
  }

  @Get('polling')
  @Permissao('pacientes:ler')
  @SemRenovarSessao()
  polling(): { ok: true } {
    return { ok: true };
  }
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
    await liberarCadastro(c);
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
    // Cadastro iniciado e não concluído: a sessão de cadastro não acessa nenhuma rota de negócio (R8).
    expect(await provedor.resolver({ headers: c })).toBeNull();
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

describe('PR 3a: sessão da pessoa sem clínica (desenho §14.1; R3 a R6 do parecer do desenho do PR 3)', () => {
  /** Pessoa com duas clínicas, logada e com TOTP aceito SEM clínica escolhida. */
  async function pessoaEmDuasClinicas() {
    const t1 = await api.novaClinica();
    const t2 = await api.novaClinica();
    const p = await novaPessoa(t1, ['admin']);
    await api.membro(t2, { userId: p.userId }, 'admin');
    const c = cookieDe(await entrar(p.email));
    return { ...p, t1, t2, c };
  }

  it('sessão da pessoa: sem clínica ativa o resolver devolve null, mas a sessão de pessoa existe; lista as duas clínicas com o nome', async () => {
    const { userId, t1, t2, c } = await pessoaEmDuasClinicas();
    expect(await provedor.resolver({ headers: c })).toBeNull();
    const pessoa = await provedor.sessaoDePessoa({ headers: c });
    expect(pessoa?.userId).toBe(userId);
    const clinicas = await provedor.clinicasDaPessoa(userId);
    expect(clinicas.map((x) => x.id).sort()).toEqual([t1, t2].sort());
    expect(clinicas.every((x) => typeof x.nome === 'string' && x.nome.length > 0)).toBe(true);
    expect(Object.keys(clinicas[0] ?? {}).sort()).toEqual(['id', 'nome']);
  });

  it('R4: TOTP sem clínica vale para a PRIMEIRA escolha em até 5 min (mfa_em na clínica escolhida e trilha nela), e nunca é lido como mfa_em', async () => {
    const { userId, t1, c } = await pessoaEmDuasClinicas();
    const s = await cadastrarFator(c, userId);
    // Ainda sem clínica: o MFA ficou guardado, não marcado.
    const id = await sessaoId(s);
    const [linha] = await dbAuth.db.select({ mfaEm: sessao.mfaEm, semClinica: sessao.mfaSemClinicaEm }).from(sessao).where(eq(sessao.id, id));
    expect(linha?.mfaEm).toBeNull();
    expect(linha?.semClinica).toBeInstanceOf(Date);
    const pessoa = await provedor.sessaoDePessoa({ headers: s });
    expect(await provedor.escolherClinica(pessoa ?? { sessaoId: '', userId: '' }, t1)).toBe(true);
    expect((await provedor.resolver({ headers: s }))?.mfaEm).toBeInstanceOf(Date);
    const [depois] = await dbAuth.db.select({ semClinica: sessao.mfaSemClinicaEm }).from(sessao).where(eq(sessao.id, id));
    expect(depois?.semClinica).toBeNull();
    expect(await trilhaDoFator(t1, userId)).toContain('login:mfa_verified');
  });

  it('R4: depois de 5 min, a escolha NÃO aproveita o TOTP; a segunda escolha também não', async () => {
    const { userId, t1, t2, c } = await pessoaEmDuasClinicas();
    const s = await cadastrarFator(c, userId);
    const id = await sessaoId(s);
    await dbAuth.db.update(sessao).set({ mfaSemClinicaEm: new Date(Date.now() - 6 * 60_000) }).where(eq(sessao.id, id));
    const pessoa = { sessaoId: id, userId };
    expect(await provedor.escolherClinica(pessoa, t1)).toBe(true);
    expect((await provedor.resolver({ headers: s }))?.mfaEm).toBeNull();
    // Dentro do prazo, mas já houve uma escolha: a segunda não aproveita.
    await dbAuth.db.update(sessao).set({ mfaSemClinicaEm: new Date() }).where(eq(sessao.id, id));
    expect(await provedor.escolherClinica(pessoa, t2)).toBe(true);
    expect((await provedor.resolver({ headers: s }))?.mfaEm).toBeNull();
  });

  it('R1 do código do 3a: duas escolhas de clínica AO MESMO TEMPO convertem o TOTP sem clínica uma vez só', async () => {
    const { userId, t1, t2, c } = await pessoaEmDuasClinicas();
    const s = await cadastrarFator(c, userId);
    const pessoa = { sessaoId: await sessaoId(s), userId };
    await Promise.all([provedor.escolherClinica(pessoa, t1), provedor.escolherClinica(pessoa, t2)]);
    const verificados = [...(await trilhaDoFator(t1, userId)), ...(await trilhaDoFator(t2, userId))].filter((x) => x === 'login:mfa_verified');
    expect(verificados).toHaveLength(1);
  });

  it('escolher clínica sem vínculo: false (a rota responde 404)', async () => {
    const { userId, c } = await pessoaEmDuasClinicas();
    const outra = await api.novaClinica();
    expect(await provedor.escolherClinica({ sessaoId: await sessaoId(c), userId }, outra)).toBe(false);
  });

  it('R20 e R6: a lista mostra só as sessões da pessoa, sem IP nem user-agent; encerrar sessão de OUTRA pessoa não apaga nada', async () => {
    const a = await pessoaEmDuasClinicas();
    const b = await pessoaEmDuasClinicas();
    const segunda = cookieDe(await entrar(a.email));
    const pa = { sessaoId: await sessaoId(a.c), userId: a.userId };
    const lista = await provedor.sessoesDaPessoa(pa);
    expect(lista).toHaveLength(2);
    expect(lista.filter((x) => x.atual)).toHaveLength(1);
    expect(JSON.stringify(lista)).not.toMatch(/ip|agente|userAgent|clinica/i);
    // B tenta encerrar uma sessão de A: nada acontece.
    const pb = { sessaoId: await sessaoId(b.c), userId: b.userId };
    expect(await provedor.encerrarSessaoDaPessoa(pb, await sessaoId(segunda))).toBe(false);
    expect(await provedor.sessoesDaPessoa(pa)).toHaveLength(2);
    // A encerra a própria segunda sessão.
    expect(await provedor.encerrarSessaoDaPessoa(pa, await sessaoId(segunda))).toBe(true);
    expect(await provedor.sessaoDePessoa({ headers: segunda })).toBeNull();
  });

  it('logout global: encerra todas as sessões da pessoa (inclusive a atual) e grava a trilha nas clínicas do vínculo', async () => {
    const a = await pessoaEmDuasClinicas();
    const segunda = cookieDe(await entrar(a.email));
    expect(await provedor.encerrarTodasDaPessoa({ sessaoId: await sessaoId(a.c), userId: a.userId })).toBe(2);
    expect(await provedor.sessaoDePessoa({ headers: a.c })).toBeNull();
    expect(await provedor.sessaoDePessoa({ headers: segunda })).toBeNull();
    for (const t of [a.t1, a.t2]) {
      const linhas = await withTenant(api.db.db, t as never, (tx) =>
        tx.execute<{ op: string }>(sql`select metadata->>'op' as op from audit_log where scope = 'session' and actor_id = ${a.userId}`),
      );
      expect(linhas.map((l) => l.op)).toContain('session_logout_global');
    }
  });

  it('R3: a sessão de pessoa aplica o prazo absoluto de 12 h (e apaga a sessão)', async () => {
    const a = await pessoaEmDuasClinicas();
    const id = await sessaoId(a.c);
    await dbAuth.db.update(sessao).set({ createdAt: new Date(Date.now() - 13 * 3_600_000) }).where(eq(sessao.id, id));
    expect(await provedor.sessaoDePessoa({ headers: a.c })).toBeNull();
    expect(await dbAuth.db.select().from(sessao).where(eq(sessao.id, id))).toEqual([]);
  });
});

describe('PR 3a: cookie renovado e polling sem renovar (pendência do #149; R19; R5 do desenho do PR 3)', () => {
  async function sessaoParaRenovar() {
    const tenantId = await api.novaClinica();
    const p = await novaPessoa(tenantId, ['admin']);
    const c = cookieDe(await entrar(p.email));
    await provedor.resolver({ headers: c });
    const id = await sessaoId(c);
    // 13 min de inatividade restantes: passou do updateAge (60 s), então a próxima leitura estende.
    const antes = new Date(Date.now() + 13 * 60_000);
    await dbAuth.db.update(sessao).set({ expiresAt: antes }).where(eq(sessao.id, id));
    return { c, id, antes };
  }

  it('rota de polling: 20 leituras não estendem a sessão e nenhum Set-Cookie sai', async () => {
    const { c, id, antes } = await sessaoParaRenovar();
    const cookies: string[] = [];
    for (let i = 0; i < 20; i++) await provedor.resolver({ headers: c, semRenovar: true, aoRenovarCookie: (x) => cookies.push(...x) });
    const [linha] = await dbAuth.db.select({ expira: sessao.expiresAt }).from(sessao).where(eq(sessao.id, id));
    expect(linha?.expira.getTime()).toBe(antes.getTime());
    expect(cookies).toEqual([]);
  });

  it('rota comum: a sessão estendida devolve SÓ o Set-Cookie da sessão, com o prazo novo', async () => {
    const { c, id, antes } = await sessaoParaRenovar();
    const cookies: string[] = [];
    expect(await provedor.resolver({ headers: c, aoRenovarCookie: (x) => cookies.push(...x) })).not.toBeNull();
    const [linha] = await dbAuth.db.select({ expira: sessao.expiresAt }).from(sessao).where(eq(sessao.id, id));
    expect(linha?.expira.getTime()).toBeGreaterThan(antes.getTime());
    expect(cookies.length).toBeGreaterThan(0);
    expect(cookies.every((x) => x.startsWith(`${nomeDoCookie(false)}=`))).toBe(true);
  });
});

describe('R4 do 3a: pela HTTP, a resposta leva SÓ o Set-Cookie da sessão; o polling não leva nenhum', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const ref = await Test.createTestingModule({
      controllers: [AlvoDoCookie],
      providers: [
        { provide: AUTH_PROVIDER, useValue: provedor },
        // O TenantDatabase fecha o handle no shutdown do app: um handle só deste teste, nunca o compartilhado.
        { provide: TenantDatabase, useValue: new TenantDatabase(createDatabase(process.env.DATABASE_URL ?? '', { max: 2 })) },
      ],
    }).compile();
    app = ref.createNestApplication({ logger: false });
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });

  async function sessaoParaRenovar(): Promise<{ cookie: string; id: string; antes: Date }> {
    const tenantId = await api.novaClinica();
    const p = await novaPessoa(tenantId, ['admin']);
    const c = cookieDe(await entrar(p.email));
    await provedor.resolver({ headers: c });
    const comFator = await cadastrarFator(c, p.userId);
    const id = await sessaoId(comFator);
    // Passou do updateAge (60 s): a próxima leitura numa rota comum estende a sessão.
    const antes = new Date(Date.now() + 13 * 60_000);
    await dbAuth.db.update(sessao).set({ expiresAt: antes }).where(eq(sessao.id, id));
    return { cookie: String((soSessao(comFator) as Record<string, string>)['cookie'] ?? ''), id, antes };
  }

  it('rota comum: 200 com um Set-Cookie só, o da sessão, HttpOnly, SameSite=Strict e Path=/', async () => {
    const { cookie, id, antes } = await sessaoParaRenovar();
    const r = await request(app.getHttpServer() as Server).get('/teste-cookie/comum').set('Cookie', cookie);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const setCookie = ([] as string[]).concat(r.headers['set-cookie'] ?? []);
    expect(setCookie).toHaveLength(1);
    expect(setCookie[0]).toMatch(new RegExp(`^${nomeDoCookie(false)}=`));
    expect(setCookie[0]).toMatch(/HttpOnly/i);
    expect(setCookie[0]).toMatch(/SameSite=Strict/i);
    expect(setCookie[0]).toMatch(/Path=\//);
    const [linha] = await dbAuth.db.select({ expira: sessao.expiresAt }).from(sessao).where(eq(sessao.id, id));
    expect(linha?.expira.getTime()).toBeGreaterThan(antes.getTime());
  });

  it('rota de polling: 200 sem nenhum Set-Cookie e sem estender a sessão', async () => {
    const { cookie, id, antes } = await sessaoParaRenovar();
    const r = await request(app.getHttpServer() as Server).get('/teste-cookie/polling').set('Cookie', cookie);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.headers['set-cookie']).toBeUndefined();
    const [linha] = await dbAuth.db.select({ expira: sessao.expiresAt }).from(sessao).where(eq(sessao.id, id));
    expect(linha?.expira.getTime()).toBe(antes.getTime());
  });
});

describe('PR 3a: expurgo diário do schema identidade (R11 do desenho, R7 do desenho do PR 3)', () => {
  it('apaga sessões vencidas e cadastros de TOTP não concluídos há mais de 24 h; mantém o resto', async () => {
    const tenantId = await api.novaClinica();
    const p = await novaPessoa(tenantId, ['admin']);
    const viva = cookieDe(await entrar(p.email));
    const vencida = cookieDe(await entrar(p.email));
    const idVencida = await sessaoId(vencida);
    const idViva = await sessaoId(viva);
    await dbAuth.db.update(sessao).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(sessao.id, idVencida));
    // Cadastro iniciado e abandonado há 2 dias.
    await liberarCadastro(viva);
    expect((await postar('/two-factor/enable', viva, { password: SENHA })).r.status).toBe(200);
    await dbAuth.db.update(doisFatores).set({ criadoEm: new Date(Date.now() - 48 * 3_600_000) }).where(eq(doisFatores.userId, p.userId));
    const r = await provedor.expurgarComoSistema();
    expect(r.sessoes).toBeGreaterThanOrEqual(1);
    expect(r.cadastrosNaoConcluidos).toBeGreaterThanOrEqual(1);
    expect(await dbAuth.db.select().from(sessao).where(eq(sessao.id, idVencida))).toEqual([]);
    expect(await dbAuth.db.select().from(sessao).where(eq(sessao.id, idViva))).toHaveLength(1);
    expect(await dbAuth.db.select().from(doisFatores).where(eq(doisFatores.userId, p.userId))).toEqual([]);
  });
});

describe('PR 3b: convite da equipe e cadastro do fator preso ao convite (§14.2; R1, R2, R8, R9 e R16)', () => {
  const convites = (): ConvitesService => new ConvitesService(new TenantDatabase(api.db), provedor);

  async function clinicaComAdmin() {
    const tenantId = await api.novaClinica();
    const adm = await api.membro(tenantId, api.sessao(tenantId, 'admin'), 'admin');
    const ctx = { tenantId, userId: adm.userId, roles: ['admin'] } as never;
    return { tenantId, adm, ctx };
  }

  const novoEmail = (): string => `convidado-${randomUUID().slice(0, 8)}@exemplo.test`;

  it('o convite não cria conta nem perfil (R2); a lista não traz e-mail; o aceite cria a conta e o vínculo, e a sessão só serve ao cadastro do TOTP (R8)', async () => {
    const { tenantId, ctx } = await clinicaComAdmin();
    const email = novoEmail();
    const c = await convites().criar(ctx, email, 'recepcao');
    expect(c.token).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(await dbAuth.db.select().from(usuario).where(eq(usuario.email, email))).toEqual([]);
    const lista = await convites().listar(ctx);
    expect(lista.map((x) => x.id)).toContain(c.conviteId);
    expect(JSON.stringify(lista)).not.toContain(email);
    // E-mail diferente do convidado: mesmo 404 de token inválido (R16).
    await expect(convites().aceitar({ token: c.token, email: novoEmail(), nome: 'Pessoa Ficticia', senha: SENHA, cabecalhos: new Headers() })).rejects.toBeInstanceOf(NaoEncontradoError);
    const cookies = await convites().aceitar({ token: c.token, email: email.toUpperCase(), nome: 'Pessoa Ficticia', senha: SENHA, cabecalhos: new Headers() });
    const sessaoNova = { cookie: (cookies[0] ?? '').split(';')[0] ?? '' };
    const [u] = await dbAuth.db.select().from(usuario).where(eq(usuario.email, email));
    expect(u?.clinicaDeOrigem).toBe(tenantId);
    expect(u?.conviteDeOrigem).toBe(c.conviteId);
    expect(await provedor.clinicasDoUsuario(u?.id ?? '')).toEqual([tenantId]);
    // Sessão de cadastro: nenhuma rota de negócio nem rota da pessoa, mas o cadastro do TOTP vale.
    expect(await provedor.resolver({ headers: sessaoNova })).toBeNull();
    expect(await provedor.sessaoDePessoa({ headers: sessaoNova })).toBeNull();
    const inicio = await postar('/two-factor/enable', sessaoNova, { password: SENHA });
    expect(inicio.r.status, JSON.stringify(inicio.json)).toBe(200);
    // Token de uso único.
    await expect(convites().aceitar({ token: c.token, email, nome: 'Outra', senha: SENHA, cabecalhos: new Headers() })).rejects.toBeInstanceOf(NaoEncontradoError);
  });

  it('R8: fora da sessão do convite, o cadastro do TOTP é recusado (quem tem só a senha não cadastra o próprio autenticador)', async () => {
    const tenantId = await api.novaClinica();
    const p = await novaPessoa(tenantId, ['admin']);
    const c = cookieDe(await entrar(p.email));
    const r = await postar('/two-factor/enable', c, { password: SENHA });
    expect(r.r.status).toBe(403);
    expect(r.json['code']).toBe('CADASTRO_SO_PELO_CONVITE');
  });

  it('conta já existente: o aceite pede login completo (3b-2) e não cria nada', async () => {
    const { tenantId, ctx } = await clinicaComAdmin();
    const ja = await novaPessoa(await api.novaClinica(), ['recepcao']);
    const c = await convites().criar(ctx, ja.email, 'recepcao');
    await expect(convites().aceitar({ token: c.token, email: ja.email, nome: 'X', senha: SENHA, cabecalhos: new Headers() })).rejects.toBeInstanceOf(ConflitoError);
    expect(await provedor.clinicasDoUsuario(ja.userId)).not.toContain(tenantId);
  });

  it('3b-2: conta existente aceita com senha E código TOTP; código errado ou conta sem fator não criam vínculo', async () => {
    const { tenantId, ctx } = await clinicaComAdmin();
    const origemClinica = await api.novaClinica();
    const ja = await novaPessoa(origemClinica, ['recepcao']);
    await cadastrarFator(cookieDe(await entrar(ja.email)), ja.userId);
    const c1 = await convites().criar(ctx, ja.email, 'recepcao');
    await expect(
      convites().aceitar({ token: c1.token, email: ja.email, senha: SENHA, codigo: codigoErrado(segredos.get(ja.userId)?.segredo ?? Buffer.alloc(0), 7), cabecalhos: new Headers() }),
    ).rejects.toBeInstanceOf(ConflitoError);
    expect(await provedor.clinicasDoUsuario(ja.userId)).not.toContain(tenantId);
    // Conferência sem abrir sessão: a pessoa entra depois, pelo login normal.
    expect(await convites().aceitar({ token: c1.token, email: ja.email, senha: SENHA, codigo: proximoCodigo(ja.userId), cabecalhos: new Headers() })).toEqual([]);
    expect(await provedor.clinicasDoUsuario(ja.userId)).toContain(tenantId);
    // Conta sem TOTP: recusada, sem vínculo e sem sessão viva.
    const semFator = await novaPessoa(await api.novaClinica(), ['recepcao']);
    const c2 = await convites().criar(ctx, semFator.email, 'recepcao');
    await expect(convites().aceitar({ token: c2.token, email: semFator.email, senha: SENHA, codigo: '123456', cabecalhos: new Headers() })).rejects.toBeInstanceOf(ConflitoError);
    expect(await provedor.clinicasDoUsuario(semFator.userId)).not.toContain(tenantId);
    expect(await dbAuth.db.select().from(sessao).where(eq(sessao.userId, semFator.userId))).toEqual([]);
  });

  it('quem convidou deixou de ser admin: o aceite não cria vínculo e a conta nova é desfeita', async () => {
    const { tenantId, adm, ctx } = await clinicaComAdmin();
    const outroAdm = await api.membro(tenantId, api.sessao(tenantId, 'admin'), 'admin');
    const email = novoEmail();
    const c = await convites().criar(ctx, email, 'recepcao');
    await api.http().delete(`/clinica/membros/${adm.userId}/admin`).set({ Authorization: outroAdm.Authorization }).expect(204);
    await expect(convites().aceitar({ token: c.token, email, nome: 'X', senha: SENHA, cabecalhos: new Headers() })).rejects.toBeInstanceOf(NaoEncontradoError);
    expect(await dbAuth.db.select().from(usuario).where(eq(usuario.email, email))).toEqual([]);
  });

  it('convite revogado não é aceito; senha vazada é recusada no aceite (R5 do #152)', async () => {
    const { ctx } = await clinicaComAdmin();
    const email = novoEmail();
    const c = await convites().criar(ctx, email, 'recepcao');
    await expect(convites().aceitar({ token: c.token, email, nome: 'X', senha: SENHA_VAZADA, cabecalhos: new Headers() })).rejects.toBeInstanceOf(ConflitoError);
    await convites().revogar(ctx, c.conviteId);
    await expect(convites().aceitar({ token: c.token, email, nome: 'X', senha: SENHA, cabecalhos: new Headers() })).rejects.toBeInstanceOf(NaoEncontradoError);
  });

  it('isolamento: a clínica B não lê nem altera o convite da clínica A (team_invites com RLS)', async () => {
    const a = await clinicaComAdmin();
    const b = await clinicaComAdmin();
    const c = await convites().criar(a.ctx, novoEmail(), 'recepcao');
    const vistos = await withTenant(api.db.db, b.tenantId, (tx) => tx.execute<{ id: string }>(sql`select id from team_invites where id = ${c.conviteId}`));
    expect([...vistos]).toEqual([]);
    const mudou = await withTenant(api.db.db, b.tenantId, (tx) =>
      tx.execute<{ id: string }>(sql`update team_invites set revoked_at = now(), revoked_by = ${b.adm.userId} where id = ${c.conviteId} returning id`),
    );
    expect([...mudou]).toEqual([]);
    await expect(convites().revogar(b.ctx, c.conviteId)).rejects.toBeInstanceOf(NaoEncontradoError);
    expect((await convites().listar(a.ctx)).map((x) => x.id)).toContain(c.conviteId);
  });

  it('R1 do código do 3b-1: conta abandonada por um aceite que falhou é reaproveitada pelo mesmo convite (o e-mail não fica preso)', async () => {
    const { tenantId, ctx } = await clinicaComAdmin();
    const email = novoEmail();
    const c = await convites().criar(ctx, email, 'recepcao');
    // Simula o resto de um aceite que falhou depois de criar a conta: inativa, sem senha, sem vínculo.
    const orfa = randomUUID();
    await dbAuth.db.insert(usuario).values({ id: orfa, name: 'Orfa', email, emailVerified: false, ativo: false, inativaPor: 'convite_desfeito', conviteDeOrigem: c.conviteId });
    await dbAuth.db.insert(conta).values({ id: randomUUID(), accountId: orfa, providerId: 'credential', userId: orfa, password: null });
    await convites().aceitar({ token: c.token, email, nome: 'Pessoa Ficticia', senha: SENHA, cabecalhos: new Headers() });
    expect(await provedor.clinicasDoUsuario(orfa)).toEqual([tenantId]);
    const [u] = await dbAuth.db.select({ ativo: usuario.ativo }).from(usuario).where(eq(usuario.id, orfa));
    expect(u?.ativo).toBe(true);
  });

  it('R9: teto diário de convites por admin', async () => {
    const { ctx } = await clinicaComAdmin();
    for (let i = 0; i < TETO_DIARIO_DE_CONVITES; i++) await convites().criar(ctx, novoEmail(), 'recepcao');
    await expect(convites().criar(ctx, novoEmail(), 'recepcao')).rejects.toBeInstanceOf(ConflitoError);
  });
});

describe('PR 3b-2: troca de senha e desbloqueio pelo admin (R16; R4 do #152)', () => {
  const credenciais = (): CredenciaisService => new CredenciaisService(new TenantDatabase(api.db), provedor);

  it('troca de senha: senha atual errada recusada; vazada recusada; a nova vale, a antiga não, e as outras sessões caem; trilha nas clínicas', async () => {
    const tenantId = await api.novaClinica();
    const p = await novaPessoa(tenantId, ['admin']);
    const c = cookieDe(await entrar(p.email));
    const outra = cookieDe(await entrar(p.email));
    await provedor.resolver({ headers: c });
    const base = { headers: c as Record<string, string>, userId: p.userId };
    await expect(credenciais().trocarSenha({ ...base, atual: SENHA_ERRADA_TROCA, nova: SENHA_NOVA })).rejects.toBeInstanceOf(ConflitoError);
    await expect(credenciais().trocarSenha({ ...base, atual: SENHA, nova: SENHA_VAZADA })).rejects.toBeInstanceOf(ConflitoError);
    const cookies = await credenciais().trocarSenha({ ...base, atual: SENHA, nova: SENHA_NOVA });
    expect(cookies.length).toBeGreaterThan(0);
    expect(await provedor.sessaoDePessoa({ headers: outra })).toBeNull();
    expect((await entrar(p.email)).status).not.toBe(200);
    expect((await entrar(p.email, SENHA_NOVA)).status).toBe(200);
    const linhas = await withTenant(api.db.db, tenantId, (tx) =>
      tx.execute<{ op: string }>(sql`select metadata->>'op' as op from audit_log where scope = 'session' and actor_id = ${p.userId}`),
    );
    expect(linhas.map((l) => l.op)).toContain('password_changed');
  });

  it('desbloqueio: o admin zera os contadores de quem é da clínica dele (a senha certa volta a entrar); de outra clínica, 404', async () => {
    const tenantId = await api.novaClinica();
    const adm = await api.membro(tenantId, api.sessao(tenantId, 'admin'), 'admin');
    const ctx = { tenantId, userId: adm.userId, roles: ['admin'] } as never;
    const p = await novaPessoa(tenantId, ['recepcao']);
    const origem = '5a1b2c3d4e5f6071';
    for (let i = 0; i < 5; i++) await postar('/sign-in/email', {}, { email: p.email, password: SENHA_ERRADA_TROCA }, origem);
    expect((await postar('/sign-in/email', {}, { email: p.email, password: SENHA }, '6a1b2c3d4e5f6071')).r.status).toBe(401);
    await credenciais().desbloquear(ctx, p.userId);
    expect((await postar('/sign-in/email', {}, { email: p.email, password: SENHA }, '6a1b2c3d4e5f6071')).r.status).toBe(200);
    const estranha = await novaPessoa(await api.novaClinica(), ['recepcao']);
    await expect(credenciais().desbloquear(ctx, estranha.userId)).rejects.toBeInstanceOf(NaoEncontradoError);
  });
});

describe('PR 3b-2: recuperação pelo admin (R17; R1, R15 e R16 do desenho do PR 3)', () => {
  const credenciais = (): CredenciaisService => new CredenciaisService(new TenantDatabase(api.db), provedor);

  async function membroComFator() {
    const tenantId = await api.novaClinica();
    const adm = await api.membro(tenantId, api.sessao(tenantId, 'admin'), 'admin');
    const ctx = { tenantId, userId: adm.userId, roles: ['admin'] } as never;
    const p = await novaPessoa(tenantId, ['recepcao']);
    await cadastrarFator(cookieDe(await entrar(p.email)), p.userId);
    return { tenantId, ctx, ...p };
  }

  it('senha: o token exige o código TOTP atual; código errado não troca nada; o certo troca a senha, derruba as sessões e o token não vale de novo', async () => {
    const m = await membroComFator();
    const sessaoAntiga = cookieDe(await entrar(m.email));
    const { token } = await credenciais().emitirRecuperacao(m.ctx, m.userId, 'senha', 'esqueceu_a_senha');
    const segredo = segredos.get(m.userId)?.segredo ?? Buffer.alloc(0);
    await expect(credenciais().usarRecuperacao({ token, codigo: codigoErrado(segredo, 11), senhaNova: SENHA_NOVA, cabecalhos: new Headers() })).rejects.toBeInstanceOf(ConflitoError);
    expect((await entrar(m.email)).status).toBe(200);
    await credenciais().usarRecuperacao({ token, codigo: proximoCodigo(m.userId), senhaNova: SENHA_NOVA, cabecalhos: new Headers() });
    expect((await entrar(m.email)).status).toBe(401);
    expect((await entrar(m.email, SENHA_NOVA)).status).toBe(200);
    expect(await provedor.sessaoDePessoa({ headers: sessaoAntiga })).toBeNull();
    await expect(credenciais().usarRecuperacao({ token, codigo: proximoCodigo(m.userId), senhaNova: SENHA_NOVA, cabecalhos: new Headers() })).rejects.toBeInstanceOf(NaoEncontradoError);
    const trilha = await withTenant(api.db.db, m.tenantId, (tx) =>
      tx.execute<{ op: string; reason: string | null }>(sql`select metadata->>'op' as op, metadata->>'reason' as reason from audit_log where scope = 'clinic_members' and metadata->>'op' like 'credential_recovery%'`),
    );
    expect(trilha.map((t) => t.op).sort()).toEqual(['credential_recovery_issued', 'credential_recovery_used']);
    expect(trilha.find((t) => t.op === 'credential_recovery_issued')?.reason).toBe('esqueceu_a_senha');
  });

  it('fator: o token exige a senha atual; o TOTP antigo sai e a sessão aberta só serve ao cadastro de um novo', async () => {
    const m = await membroComFator();
    const { token } = await credenciais().emitirRecuperacao(m.ctx, m.userId, 'fator', 'perdeu_o_aparelho');
    await expect(credenciais().usarRecuperacao({ token, senhaAtual: SENHA_ERRADA_TROCA, cabecalhos: new Headers() })).rejects.toBeInstanceOf(ConflitoError);
    expect(await dbAuth.db.select().from(doisFatores).where(eq(doisFatores.userId, m.userId))).toHaveLength(1);
    const cookies = await credenciais().usarRecuperacao({ token, senhaAtual: SENHA, cabecalhos: new Headers() });
    expect(await dbAuth.db.select().from(doisFatores).where(eq(doisFatores.userId, m.userId))).toEqual([]);
    const sessaoDeCadastro = { cookie: (cookies[0] ?? '').split(';')[0] ?? '' };
    expect(await provedor.resolver({ headers: sessaoDeCadastro })).toBeNull();
    expect((await postar('/two-factor/enable', sessaoDeCadastro, { password: SENHA })).r.status).toBe(200);
  });

  it('R8 do código do 3b-2: token vencido não vale; dois usos em paralelo, só um passa; 5 códigos errados bloqueiam até o certo', async () => {
    const m = await membroComFator();
    const vencido = await credenciais().emitirRecuperacao(m.ctx, m.userId, 'fator', 'perdeu_o_aparelho');
    await dbAuth.db
      .update(recuperacao)
      .set({ criadoEm: new Date(Date.now() - 20 * 60_000), expiraEm: new Date(Date.now() - 5 * 60_000) })
      .where(eq(recuperacao.usuarioId, m.userId));
    await expect(credenciais().usarRecuperacao({ token: vencido.token, senhaAtual: SENHA, cabecalhos: new Headers() })).rejects.toBeInstanceOf(NaoEncontradoError);
    const { token } = await credenciais().emitirRecuperacao(m.ctx, m.userId, 'fator', 'perdeu_o_aparelho');
    const usos = await Promise.allSettled([0, 1].map(() => credenciais().usarRecuperacao({ token, senhaAtual: SENHA, cabecalhos: new Headers() })));
    expect(usos.filter((u) => u.status === 'fulfilled')).toHaveLength(1);
    // Bloqueio: outra pessoa, recuperação de senha, 5 códigos errados e então o certo também recusado.
    const n = await membroComFator();
    const r = await credenciais().emitirRecuperacao(n.ctx, n.userId, 'senha', 'esqueceu_a_senha');
    const segredo = segredos.get(n.userId)?.segredo ?? Buffer.alloc(0);
    for (let k = 0; k < 5; k++) {
      await expect(credenciais().usarRecuperacao({ token: r.token, codigo: codigoErrado(segredo, 400 + k), senhaNova: SENHA_NOVA, cabecalhos: new Headers() })).rejects.toBeInstanceOf(ConflitoError);
    }
    await expect(credenciais().usarRecuperacao({ token: r.token, codigo: proximoCodigo(n.userId), senhaNova: SENHA_NOVA, cabecalhos: new Headers() })).rejects.toBeInstanceOf(ConflitoError);
    expect((await entrar(n.email)).status).toBe(200);
  });

  it('R2 do parecer do endurecimento: com o contador fora do ar, a recuperação recusa (indisponível) e não troca nada', async () => {
    const m = await membroComFator();
    const { token } = await credenciais().emitirRecuperacao(m.ctx, m.userId, 'fator', 'perdeu_o_aparelho');
    const quebrado = {
      hit: () => Promise.reject(new Error('fora')),
      peek: () => Promise.reject(new Error('fora')),
      release: () => Promise.reject(new Error('fora')),
      mode: () => 'compartilhado' as const,
      close: () => Promise.resolve(),
    };
    const semContador = new BetterAuthProvider({
      auth,
      dbAuth: dbAuth.db,
      dbClinica: api.db.db,
      conferirSenhaVazada: senhaVazadaFicticia,
      bloqueio: { store: quebrado, chaveHmac: CHAVE_HMAC_DA_BANCADA },
      segredoDaInstancia: SEGREDO_DA_BANCADA,
    });
    expect(await semContador.usarRecuperacao({ token, senhaAtual: SENHA, cabecalhos: new Headers() })).toBe('indisponivel');
    expect(await dbAuth.db.select().from(doisFatores).where(eq(doisFatores.userId, m.userId))).toHaveLength(1);
  });

  it('R1 do código do 3b-2: o uso da recuperação deixa linha (sem detalhe) também nas OUTRAS clínicas da pessoa', async () => {
    const m = await membroComFator();
    const outra = await api.novaClinica();
    await api.membro(outra, { userId: m.userId }, 'recepcao');
    const { token } = await credenciais().emitirRecuperacao(m.ctx, m.userId, 'fator', 'perdeu_o_aparelho');
    await credenciais().usarRecuperacao({ token, senhaAtual: SENHA, cabecalhos: new Headers() });
    const naOutra = await withTenant(api.db.db, outra, (tx) =>
      tx.execute<{ op: string; kind: string | null }>(sql`select metadata->>'op' as op, metadata->>'kind' as kind from audit_log where actor_id = ${m.userId} and metadata->>'op' = 'credential_changed'`),
    );
    expect(naOutra).toHaveLength(1);
    expect(naOutra[0]?.kind).toBeNull();
  });

  it('R16: o admin não emite recuperação para quem não tem vínculo ativo na clínica dele; motivo fora da lista não passa na rota', async () => {
    const m = await membroComFator();
    const estranha = await novaPessoa(await api.novaClinica(), ['recepcao']);
    await expect(credenciais().emitirRecuperacao(m.ctx, estranha.userId, 'senha', 'esqueceu_a_senha')).rejects.toBeInstanceOf(NaoEncontradoError);
  });
});

describe('PR 3b-3: desligamento, recontratação, anonimização e aviso de fator bloqueado (R10, R11, R18; R6 do #152)', () => {
  const convites = (): ConvitesService => new ConvitesService(new TenantDatabase(api.db), provedor);

  it('R10: revogar o último perfil numa clínica derruba só as sessões dela; sem vínculo em nenhuma, conta inativa e sem login; convite aceito reativa', async () => {
    const t1 = await api.novaClinica();
    const t2 = await api.novaClinica();
    const adm1 = await api.membro(t1, api.sessao(t1, 'admin'), 'admin');
    const adm2 = await api.membro(t2, api.sessao(t2, 'admin'), 'admin');
    const p = await novaPessoa(t1, ['recepcao']);
    await api.membro(t2, { userId: p.userId }, 'recepcao');
    // Sessões abertas antes do TOTP (depois dele, a senha sozinha não abre sessão).
    const em1 = cookieDe(await entrar(p.email, SENHA));
    const em2 = cookieDe(await entrar(p.email, SENHA));
    await cadastrarFator(cookieDe(await entrar(p.email)), p.userId);
    await dbAuth.db.update(sessao).set({ clinicaAtiva: t1 }).where(eq(sessao.id, await sessaoId(em1)));
    await dbAuth.db.update(sessao).set({ clinicaAtiva: t2 }).where(eq(sessao.id, await sessaoId(em2)));
    const id2 = await sessaoId(em2);
    await api.http().delete(`/clinica/membros/${p.userId}/recepcao`).set({ Authorization: adm1.Authorization }).expect(204);
    expect(await dbAuth.db.select().from(sessao).where(and(eq(sessao.userId, p.userId), eq(sessao.clinicaAtiva, t1)))).toEqual([]);
    expect(await dbAuth.db.select().from(sessao).where(eq(sessao.id, id2))).toHaveLength(1);
    await api.http().delete(`/clinica/membros/${p.userId}/recepcao`).set({ Authorization: adm2.Authorization }).expect(204);
    const [u] = await dbAuth.db.select({ ativo: usuario.ativo }).from(usuario).where(eq(usuario.id, p.userId));
    expect(u?.ativo).toBe(false);
    expect(await dbAuth.db.select().from(sessao).where(eq(sessao.userId, p.userId))).toEqual([]);
    expect((await entrar(p.email)).headers.getSetCookie().some((c) => c.startsWith(`${nomeDoCookie(false)}=`))).toBe(false);
    // Recontratação: convite aceito com senha e TOTP (sem abrir sessão) reativa a conta.
    const c = await convites().criar({ tenantId: t1, userId: adm1.userId, roles: ['admin'] } as never, p.email, 'recepcao');
    await convites().aceitar({ token: c.token, email: p.email, senha: SENHA, codigo: proximoCodigo(p.userId), cabecalhos: new Headers() });
    const [depois] = await dbAuth.db.select({ ativo: usuario.ativo }).from(usuario).where(eq(usuario.id, p.userId));
    expect(depois?.ativo).toBe(true);
    expect(await provedor.clinicasDoUsuario(p.userId)).toEqual([t1]);
  });

  it('R11 e R18: anonimizar mantém o id e apaga e-mail, nome, senha, TOTP e sessões; a pessoa não entra mais', async () => {
    const tenantId = await api.novaClinica();
    const p = await novaPessoa(tenantId, ['recepcao']);
    await cadastrarFator(cookieDe(await entrar(p.email)), p.userId);
    await provedor.anonimizarConta(p.userId);
    const [u] = await dbAuth.db.select().from(usuario).where(eq(usuario.id, p.userId));
    expect(u?.email).not.toBe(p.email);
    expect(u?.name).toBe('Conta anonimizada');
    expect(u?.ativo).toBe(false);
    expect(await dbAuth.db.select().from(doisFatores).where(eq(doisFatores.userId, p.userId))).toEqual([]);
    expect(await dbAuth.db.select().from(sessao).where(eq(sessao.userId, p.userId))).toEqual([]);
    expect((await entrar(p.email)).status).not.toBe(200);
    // R1 do código do 3b-3: a clínica conhece o id pelo prontuário, mas a conta anonimizada não recebe perfil.
    await expect(api.membro(tenantId, { userId: p.userId }, 'financeiro')).rejects.toThrow();
    const [depois] = await dbAuth.db.select({ ativo: usuario.ativo, motivo: usuario.inativaPor }).from(usuario).where(eq(usuario.id, p.userId));
    expect(depois).toEqual({ ativo: false, motivo: 'anonimizada' });
    // R3 do código do 3b-3: prova do atendimento na trilha da clínica.
    const prova = await withTenant(api.db.db, tenantId, (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from audit_log where actor_id = ${p.userId} and metadata->>'op' = 'account_anonymized'`));
    expect([...prova][0]?.n).toBe(1);
  });

  it('R6 do #152: o fator trancado por pessoa identificada vira aviso aos admins da clínica dela (1 por dia)', async () => {
    const tenantId = await api.novaClinica();
    const adm = await api.membro(tenantId, api.sessao(tenantId, 'admin'), 'admin');
    const p = await novaPessoa(tenantId, ['recepcao']);
    const s = await cadastrarFator(cookieDe(await entrar(p.email)), p.userId);
    const segredo = segredos.get(p.userId)?.segredo ?? Buffer.alloc(0);
    for (let k = 0; k < 5; k++) await postar('/two-factor/verify-totp', s, { code: codigoErrado(segredo, 300 + k) }, '7a1b2c3d4e5f6071');
    const alertas = await withTenant(api.db.db, tenantId, (tx) =>
      tx.execute<{ n: number }>(sql`select count(*)::int as n from audit_log where action = 'anomaly_alert' and actor_id = ${p.userId} and metadata->>'rule' = 'fator_bloqueado'`),
    );
    expect([...alertas][0]?.n).toBe(1);
    // A caixa de avisos tem RLS por destinatário: lida como o admin avisado.
    const avisos = await withTenant(
      api.db.db,
      tenantId,
      (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from clinical_notices where kind = 'alerta_anomalia' and anomaly_rule = 'fator_bloqueado'`),
      adm.userId,
    );
    expect([...avisos][0]?.n).toBeGreaterThanOrEqual(1);
  });
});

describe('Fila do 3b: retenção e tetos (ressalva 4 do 3c; R9 e R10 do 3b-2; R3 do 3b-1)', () => {
  const credenciais = (): CredenciaisService => new CredenciaisService(new TenantDatabase(api.db), provedor);
  const convites = (): ConvitesService => new ConvitesService(new TenantDatabase(api.db), provedor);

  it('veto do #173: conta desligada (com TOTP) há mais de 90 dias perde credencial e fator e libera o e-mail; a recontratação cria conta NOVA', async () => {
    const tenantId = await api.novaClinica();
    const adm = await api.membro(tenantId, api.sessao(tenantId, 'admin'), 'admin');
    const p = await novaPessoa(tenantId, ['recepcao']);
    await cadastrarFator(cookieDe(await entrar(p.email)), p.userId);
    await api.http().delete(`/clinica/membros/${p.userId}/recepcao`).set({ Authorization: adm.Authorization }).expect(204);
    await dbAuth.db.update(usuario).set({ inativaDesde: new Date(Date.now() - 91 * 24 * 3_600_000) }).where(eq(usuario.id, p.userId));
    expect((await provedor.expurgarComoSistema()).credenciaisDeInativas).toBeGreaterThanOrEqual(1);
    const [velha] = await dbAuth.db.select({ email: usuario.email, fator: usuario.twoFactorEnabled }).from(usuario).where(eq(usuario.id, p.userId));
    expect(velha).toEqual({ email: `desligada-${p.userId}@desligada.invalid`, fator: false });
    // Ressalvas 7 e 8 da reconferência: marca 'expurgada', nome fora (art. 16) e nenhuma concessão nova (42501).
    const [marca] = await dbAuth.db.select({ nome: usuario.name, motivo: usuario.inativaPor, ativo: usuario.ativo }).from(usuario).where(eq(usuario.id, p.userId));
    expect(marca).toEqual({ nome: 'Conta desligada', motivo: 'expurgada', ativo: false });
    await expect(api.membro(tenantId, { userId: p.userId }, 'financeiro')).rejects.toThrow();
    expect(await provedor.clinicasDoUsuario(p.userId)).toEqual([]);
    expect(await dbAuth.db.select().from(doisFatores).where(eq(doisFatores.userId, p.userId))).toEqual([]);
    // Segunda passada não reprocessa a mesma conta.
    const antes = (await provedor.expurgarComoSistema()).credenciaisDeInativas;
    expect(antes).toBe(0);
    const conv = await convites().criar({ tenantId, userId: adm.userId, roles: ['admin'] } as never, p.email, 'recepcao');
    await convites().aceitar({ token: conv.token, email: p.email, nome: 'Pessoa Ficticia', senha: SENHA_NOVA, cabecalhos: new Headers() });
    const [nova] = await dbAuth.db.select({ id: usuario.id }).from(usuario).where(eq(usuario.email, p.email));
    expect(nova?.id).toBeDefined();
    expect(nova?.id).not.toBe(p.userId);
    expect(await provedor.clinicasDoUsuario(nova?.id ?? '')).toEqual([tenantId]);
  });

  it('R9: senha atual errada na troca conta no bloqueio de login (5 erros travam a 6ª, mesmo certa)', async () => {
    const tenantId = await api.novaClinica();
    const p = await novaPessoa(tenantId, ['admin']);
    const c = cookieDe(await entrar(p.email));
    await provedor.resolver({ headers: c });
    const base = { headers: c as Record<string, string>, userId: p.userId };
    for (let k = 0; k < 5; k++) await expect(credenciais().trocarSenha({ ...base, atual: SENHA_ERRADA_TROCA, nova: SENHA_NOVA })).rejects.toBeInstanceOf(ConflitoError);
    await expect(credenciais().trocarSenha({ ...base, atual: SENHA, nova: SENHA_NOVA })).rejects.toBeInstanceOf(ConflitoError);
  });

  it('R10: token novo de recuperação invalida o anterior da mesma pessoa', async () => {
    const tenantId = await api.novaClinica();
    const adm = await api.membro(tenantId, api.sessao(tenantId, 'admin'), 'admin');
    const ctx = { tenantId, userId: adm.userId, roles: ['admin'] } as never;
    const p = await novaPessoa(tenantId, ['recepcao']);
    const primeiro = await credenciais().emitirRecuperacao(ctx, p.userId, 'fator', 'perdeu_o_aparelho');
    await credenciais().emitirRecuperacao(ctx, p.userId, 'fator', 'perdeu_o_aparelho');
    await expect(credenciais().usarRecuperacao({ token: primeiro.token, senhaAtual: SENHA, cabecalhos: new Headers() })).rejects.toBeInstanceOf(NaoEncontradoError);
  });

  it('ressalva 1 do #173: o desligamento grava inativa_desde, UPDATE sem mudança não zera a contagem e a recontratação limpa', async () => {
    const tenantId = await api.novaClinica();
    const adm = await api.membro(tenantId, api.sessao(tenantId, 'admin'), 'admin');
    const p = await novaPessoa(tenantId, ['recepcao']);
    const desde = async () => (await dbAuth.db.select({ d: usuario.inativaDesde }).from(usuario).where(eq(usuario.id, p.userId)))[0]?.d ?? null;
    expect(await desde()).toBeNull();
    await api.http().delete(`/clinica/membros/${p.userId}/recepcao`).set({ Authorization: adm.Authorization }).expect(204);
    const gravada = await desde();
    expect(gravada).toBeInstanceOf(Date);
    // Envelhece a data e grava ativo = false de novo: a contagem continua a mesma.
    const velha = new Date(Date.now() - 40 * 24 * 3_600_000);
    await dbAuth.db.update(usuario).set({ inativaDesde: velha }).where(eq(usuario.id, p.userId));
    await dbAuth.db.update(usuario).set({ ativo: false }).where(eq(usuario.id, p.userId));
    expect((await desde())?.getTime()).toBe(velha.getTime());
    // Recontratação antes dos 90 dias: a mesma conta volta a valer e a data some.
    await api.membro(tenantId, { userId: p.userId }, 'recepcao');
    const [u] = await dbAuth.db.select({ ativo: usuario.ativo, desde: usuario.inativaDesde }).from(usuario).where(eq(usuario.id, p.userId));
    expect(u).toEqual({ ativo: true, desde: null });
  });

  it('ressalvas 2 e 3 do #173: rajada de emissões não passa do teto; a seguinte dá 409, não deixa token e gera RECUPERACAO_TETO', async () => {
    const tenantId = await api.novaClinica();
    const adm = await api.membro(tenantId, api.sessao(tenantId, 'admin'), 'admin');
    const p = await novaPessoa(tenantId, ['recepcao']);
    const pedidos = Array.from({ length: TETO_DIARIO_DE_RECUPERACOES + 3 }, () =>
      provedor.emitirRecuperacao({ userId: p.userId, tipo: 'fator', clinicaId: tenantId, criadoPor: adm.userId }),
    );
    const r = await Promise.all(pedidos);
    expect(r.filter((x) => x !== 'teto')).toHaveLength(TETO_DIARIO_DE_RECUPERACOES);
    const contar = async () =>
      (await dbAuth.db.select({ n: sql<number>`count(*)::int` }).from(recuperacao).where(eq(recuperacao.criadoPor, adm.userId)))[0]?.n;
    expect(await contar()).toBe(TETO_DIARIO_DE_RECUPERACOES);
    zerarJanelasDoLog();
    const erro = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const ctx = { tenantId, userId: adm.userId, roles: ['admin'] } as never;
      await expect(credenciais().emitirRecuperacao(ctx, p.userId, 'fator', 'perdeu_o_aparelho')).rejects.toBeInstanceOf(ConflitoError);
      const eventos = erro.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('"evento":"RECUPERACAO_TETO"'));
      expect(eventos).toHaveLength(1);
      expect(eventos[0]).toContain(adm.userId);
    } finally {
      erro.mockRestore();
    }
    expect(await contar()).toBe(TETO_DIARIO_DE_RECUPERACOES);
  });

  it('ressalva 4 do #173: erro que não é de senha na troca não gasta tentativa do bloqueio', async () => {
    const tenantId = await api.novaClinica();
    const p = await novaPessoa(tenantId, ['admin']);
    const c = cookieDe(await entrar(p.email));
    await provedor.resolver({ headers: c });
    for (let k = 0; k < 6; k++) {
      expect(await provedor.trocarSenhaDaPessoa({ headers: c, userId: p.userId, atual: SENHA, nova: 'curta' })).toBe('senha_nova_invalida');
    }
    const r = await provedor.trocarSenhaDaPessoa({ headers: c, userId: p.userId, atual: SENHA, nova: SENHA_NOVA });
    expect(Array.isArray(r)).toBe(true);
  });

  it('ressalva 5 do #173: o token novo de uma clínica não invalida o pendente emitido por outra', async () => {
    const a = await api.novaClinica();
    const b = await api.novaClinica();
    const admA = await api.membro(a, api.sessao(a, 'admin'), 'admin');
    const admB = await api.membro(b, api.sessao(b, 'admin'), 'admin');
    const p = await novaPessoa(a, ['recepcao']);
    await api.membro(b, { userId: p.userId }, 'recepcao');
    const deA = await credenciais().emitirRecuperacao({ tenantId: a, userId: admA.userId, roles: ['admin'] } as never, p.userId, 'fator', 'perdeu_o_aparelho');
    await credenciais().emitirRecuperacao({ tenantId: b, userId: admB.userId, roles: ['admin'] } as never, p.userId, 'fator', 'perdeu_o_aparelho');
    const pendentes = await dbAuth.db
      .select({ clinica: recuperacao.clinicaId })
      .from(recuperacao)
      .where(and(eq(recuperacao.usuarioId, p.userId), sql`${recuperacao.usadoEm} is null`));
    expect(pendentes.map((x) => x.clinica).sort()).toEqual([a, b].sort());
    expect(await credenciais().usarRecuperacao({ token: deA.token, senhaAtual: SENHA, cabecalhos: new Headers() })).toBeInstanceOf(Array);
    // F2 do #175: usado o token de A, o pendente de B também cai.
    const depois = await dbAuth.db.select({ id: recuperacao.id }).from(recuperacao).where(and(eq(recuperacao.usuarioId, p.userId), sql`${recuperacao.usadoEm} is null`));
    expect(depois).toEqual([]);
  });

  it('R6 do 3b-1: rajada de convites do mesmo admin não passa do teto diário', async () => {
    const tenantId = await api.novaClinica();
    const adm = await api.membro(tenantId, api.sessao(tenantId, 'admin'), 'admin');
    const ctx = { tenantId, userId: adm.userId, roles: ['admin'] } as never;
    const r = await Promise.allSettled(
      Array.from({ length: TETO_DIARIO_DE_CONVITES + 3 }, (_, k) => convites().criar(ctx, `rajada-${k}-${randomUUID().slice(0, 6)}@exemplo.test`, 'recepcao')),
    );
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(TETO_DIARIO_DE_CONVITES);
    const n = await withTenant(api.db.db, tenantId, (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from team_invites`), adm.userId);
    expect([...n][0]?.n).toBe(TETO_DIARIO_DE_CONVITES);
  });

  it('R5 do 3b-3: conta ativa sem vínculo há mais de 1 dia vira inativa no expurgo; a recém-criada fica', async () => {
    const velha = randomUUID();
    const nova = randomUUID();
    const ontem = new Date(Date.now() - 2 * 24 * 3_600_000);
    await dbAuth.db.insert(usuario).values([
      { id: velha, name: 'Sem Vinculo Ficticia', email: `sem-vinculo-${velha.slice(0, 8)}@exemplo.test`, emailVerified: false, createdAt: ontem },
      { id: nova, name: 'Recem Ficticia', email: `recem-${nova.slice(0, 8)}@exemplo.test`, emailVerified: false },
    ]);
    expect((await provedor.expurgarComoSistema()).contasSemVinculo).toBeGreaterThanOrEqual(1);
    const linhas = await dbAuth.db.select({ id: usuario.id, ativo: usuario.ativo, motivo: usuario.inativaPor }).from(usuario).where(sql`${usuario.id} in (${velha}, ${nova})`);
    expect(linhas.find((l) => l.id === velha)).toEqual({ id: velha, ativo: false, motivo: 'sem_vinculo' });
    expect(linhas.find((l) => l.id === nova)).toEqual({ id: nova, ativo: true, motivo: null });
    const [desde] = await dbAuth.db.select({ d: usuario.inativaDesde }).from(usuario).where(eq(usuario.id, velha));
    expect(desde?.d).toBeInstanceOf(Date);
    expect(await dbAuth.db.select().from(sessao).where(eq(sessao.userId, velha))).toEqual([]);
  });

  it('G1 do #176: conta inativa por corrida mas COM vínculo é reativada e não perde a credencial no expurgo', async () => {
    const tenantId = await api.novaClinica();
    const p = await novaPessoa(tenantId, ['recepcao']);
    await dbAuth.db.update(usuario).set({ ativo: false, inativaPor: 'sem_vinculo' }).where(eq(usuario.id, p.userId));
    await dbAuth.db.update(usuario).set({ inativaDesde: new Date(Date.now() - 91 * 24 * 3_600_000) }).where(eq(usuario.id, p.userId));
    expect((await provedor.expurgarComoSistema()).contasReativadas).toBeGreaterThanOrEqual(1);
    const [u] = await dbAuth.db.select({ ativo: usuario.ativo, motivo: usuario.inativaPor, email: usuario.email }).from(usuario).where(eq(usuario.id, p.userId));
    expect(u).toEqual({ ativo: true, motivo: null, email: p.email });
    const [d] = await dbAuth.db.select({ d: usuario.inativaDesde }).from(usuario).where(eq(usuario.id, p.userId));
    expect(d?.d).toBeNull();
    const [c] = await dbAuth.db.select({ senha: conta.password }).from(conta).where(eq(conta.userId, p.userId));
    expect(c?.senha).not.toBeNull();
  });

  it('fila do 3b-3: anonimizar zera na hora o HMAC do e-mail do convite que a conta aceitou', async () => {
    const tenantId = await api.novaClinica();
    const adm = await api.membro(tenantId, api.sessao(tenantId, 'admin'), 'admin');
    const email = `anon-${randomUUID().slice(0, 8)}@exemplo.test`;
    const conv = await convites().criar({ tenantId, userId: adm.userId, roles: ['admin'] } as never, email, 'recepcao');
    await convites().aceitar({ token: conv.token, email, nome: 'Pessoa Ficticia', senha: SENHA_NOVA, cabecalhos: new Headers() });
    const [u] = await dbAuth.db.select({ id: usuario.id }).from(usuario).where(eq(usuario.email, email));
    await provedor.anonimizarConta(u?.id ?? '');
    const linhas = await withTenant(api.db.db, tenantId, (tx) => tx.execute<{ email_hmac: string }>(sql`select email_hmac from team_invites where id = ${conv.conviteId}`), adm.userId);
    expect([...linhas][0]?.email_hmac).toBe('0'.repeat(32));
  });

  it('G3 completa do #176: anonimizar zera o HMAC do convite aceito numa clínica de onde a pessoa já saiu', async () => {
    const origem = await api.novaClinica();
    const outra = await api.novaClinica();
    const admO = await api.membro(origem, api.sessao(origem, 'admin'), 'admin');
    const admX = await api.membro(outra, api.sessao(outra, 'admin'), 'admin');
    const email = `g3-${randomUUID().slice(0, 8)}@exemplo.test`;
    const c1 = await convites().criar({ tenantId: origem, userId: admO.userId, roles: ['admin'] } as never, email, 'recepcao');
    await convites().aceitar({ token: c1.token, email, nome: 'Pessoa Ficticia', senha: SENHA_NOVA, cabecalhos: new Headers() });
    const [u] = await dbAuth.db.select({ id: usuario.id }).from(usuario).where(eq(usuario.email, email));
    const userId = u?.id ?? '';
    // Segunda clínica: concede direto (o convite aceito nela é simulado na tabela) e depois desliga.
    await api.membro(outra, { userId }, 'recepcao');
    const c2 = await convites().criar({ tenantId: outra, userId: admX.userId, roles: ['admin'] } as never, `outro-${email}`, 'recepcao');
    await withTenant(api.db.db, outra, (tx) => tx.execute(sql`update team_invites set accepted_at = now(), accepted_user_id = ${userId} where id = ${c2.conviteId}`), admX.userId);
    await api.http().delete(`/clinica/membros/${userId}/recepcao`).set({ Authorization: admX.Authorization }).expect(204);
    await provedor.anonimizarConta(userId);
    const hmac = await withTenant(api.db.db, outra, (tx) => tx.execute<{ email_hmac: string }>(sql`select email_hmac from team_invites where id = ${c2.conviteId}`), admX.userId);
    expect([...hmac][0]?.email_hmac).toBe('0'.repeat(32));
    // V2 do #177: a clínica sem vínculo registra o descarte na trilha, com ator sistema (art. 37).
    const prova = await withTenant(api.db.db, outra, (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from audit_log where metadata->>'op' = 'invite_pseudonym_dropped' and metadata->>'user_id' = ${userId}`), admX.userId);
    expect([...prova][0]?.n).toBe(1);
    // V1 do #177: rodar de novo (com muitas clínicas na base) não lança e não grava trilha repetida.
    await provedor.anonimizarConta(userId);
    const de2 = await withTenant(api.db.db, outra, (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from audit_log where metadata->>'op' = 'invite_pseudonym_dropped' and metadata->>'user_id' = ${userId}`), admX.userId);
    expect([...de2][0]?.n).toBe(1);
    // V2 do #178: a clínica de onde a pessoa saiu passa pelo espelho e ele termina vazio.
    expect(await dbAuth.db.select().from(conviteAceito).where(eq(conviteAceito.usuarioId, userId))).toEqual([]);
  });

  it('V3 do #177: o espelho guarda as clínicas onde a conta aceitou convite (só ids) e a anonimização o esvazia', async () => {
    const tenantId = await api.novaClinica();
    const adm = await api.membro(tenantId, api.sessao(tenantId, 'admin'), 'admin');
    const email = `espelho-${randomUUID().slice(0, 8)}@exemplo.test`;
    const conv = await convites().criar({ tenantId, userId: adm.userId, roles: ['admin'] } as never, email, 'recepcao');
    await convites().aceitar({ token: conv.token, email, nome: 'Pessoa Ficticia', senha: SENHA_NOVA, cabecalhos: new Headers() });
    const [u] = await dbAuth.db.select({ id: usuario.id }).from(usuario).where(eq(usuario.email, email));
    const userId = u?.id ?? '';
    expect(await dbAuth.db.select({ c: conviteAceito.clinicaId }).from(conviteAceito).where(eq(conviteAceito.usuarioId, userId))).toEqual([{ c: tenantId }]);
    await provedor.anonimizarConta(userId);
    expect(await dbAuth.db.select().from(conviteAceito).where(eq(conviteAceito.usuarioId, userId))).toEqual([]);
  });

  it('V1 do #178: o descarte do HMAC em 30 dias tira a clínica do espelho; o app_user não lê o espelho', async () => {
    const tenantId = await api.novaClinica();
    const adm = await api.membro(tenantId, api.sessao(tenantId, 'admin'), 'admin');
    const email = `retencao-${randomUUID().slice(0, 8)}@exemplo.test`;
    const conv = await convites().criar({ tenantId, userId: adm.userId, roles: ['admin'] } as never, email, 'recepcao');
    await convites().aceitar({ token: conv.token, email, nome: 'Pessoa Ficticia', senha: SENHA_NOVA, cabecalhos: new Headers() });
    const [u] = await dbAuth.db.select({ id: usuario.id }).from(usuario).where(eq(usuario.email, email));
    const userId = u?.id ?? '';
    expect(await dbAuth.db.select().from(conviteAceito).where(eq(conviteAceito.usuarioId, userId))).toHaveLength(1);
    await withTenant(api.db.db, tenantId, (tx) => tx.execute(sql`update team_invites set accepted_at = now() - interval '31 days' where id = ${conv.conviteId}`), adm.userId);
    expect((await convites().descartarEncerradosComoSistema(tenantId)).descartados).toBeGreaterThanOrEqual(1);
    expect(await dbAuth.db.select().from(conviteAceito).where(eq(conviteAceito.usuarioId, userId))).toEqual([]);
    await expect(api.db.db.execute(sql`select clinica_id from identidade.convite_aceito limit 1`)).rejects.toThrow();
  });

  it('V2 do #178: se a clínica falha no meio da anonimização, o espelho fica para a nova tentativa', async () => {
    const origem = await api.novaClinica();
    const outra = await api.novaClinica();
    const admO = await api.membro(origem, api.sessao(origem, 'admin'), 'admin');
    const admX = await api.membro(outra, api.sessao(outra, 'admin'), 'admin');
    const email = `falha-${randomUUID().slice(0, 8)}@exemplo.test`;
    const c1 = await convites().criar({ tenantId: origem, userId: admO.userId, roles: ['admin'] } as never, email, 'recepcao');
    await convites().aceitar({ token: c1.token, email, nome: 'Pessoa Ficticia', senha: SENHA_NOVA, cabecalhos: new Headers() });
    const [u] = await dbAuth.db.select({ id: usuario.id }).from(usuario).where(eq(usuario.email, email));
    const userId = u?.id ?? '';
    await api.membro(outra, { userId }, 'recepcao');
    const c2 = await convites().criar({ tenantId: outra, userId: admX.userId, roles: ['admin'] } as never, `outro-${email}`, 'recepcao');
    await withTenant(api.db.db, outra, (tx) => tx.execute(sql`update team_invites set accepted_at = now(), accepted_user_id = ${userId} where id = ${c2.conviteId}`), admX.userId);
    await api.http().delete(`/clinica/membros/${userId}/recepcao`).set({ Authorization: admX.Authorization }).expect(204);
    // Provedor com o banco da clínica fora do ar.
    const falho = new BetterAuthProvider({
      auth,
      dbAuth: dbAuth.db,
      dbClinica: { transaction: () => Promise.reject(new Error('banco da clínica fora')) } as never,
      bloqueio: { store: STORE_DA_BANCADA, chaveHmac: CHAVE_HMAC_DA_BANCADA },
      segredoDaInstancia: SEGREDO_DA_BANCADA,
    });
    // A pessoa ainda tem vínculo na origem: a trilha dela falha também, então a anonimização inteira falha.
    await expect(falho.anonimizarConta(userId)).rejects.toThrow();
    expect((await dbAuth.db.select({ c: conviteAceito.clinicaId }).from(conviteAceito).where(eq(conviteAceito.usuarioId, userId))).map((x) => x.c)).toContain(outra);
    // Com o banco de volta, a nova tentativa completa.
    await provedor.anonimizarConta(userId);
    expect(await dbAuth.db.select().from(conviteAceito).where(eq(conviteAceito.usuarioId, userId))).toEqual([]);
  });

  it('R3 do 3a: clínica cancelada fora da janela de saída some da lista e da escolha; dentro da janela, fica', async () => {
    const fora = await api.novaClinica();
    const dentro = await api.novaClinica();
    const p = await novaPessoa(fora, ['recepcao']);
    await api.membro(dentro, { userId: p.userId }, 'recepcao');
    const dias = (n: number) => new Date(Date.now() - n * 24 * 3_600_000);
    await withTenant(api.db.db, fora, (tx) => tx.update(tenants).set({ subscriptionStatus: 'cancelled', cancelledAt: dias(200) }).where(eq(tenants.id, fora)), p.userId);
    await withTenant(api.db.db, dentro, (tx) => tx.update(tenants).set({ subscriptionStatus: 'cancelled', cancelledAt: dias(10) }).where(eq(tenants.id, dentro)), p.userId);
    expect((await provedor.clinicasDaPessoa(p.userId)).map((c) => c.id)).toEqual([dentro]);
    const c = cookieDe(await entrar(p.email));
    const pessoa = await provedor.sessaoDePessoa({ headers: c });
    if (!pessoa) throw new Error('sem sessão');
    expect(await provedor.escolherClinica(pessoa, fora)).toBe(false);
    expect(await provedor.escolherClinica(pessoa, dentro)).toBe(true);
  });

  it('R5 do 3a: a troca de sessão no fim do cadastro do fator sai como LOGIN_OK com motivo cadastro_do_fator', async () => {
    const tenantId = await api.novaClinica();
    const p = await novaPessoa(tenantId, ['recepcao']);
    const c = cookieDe(await entrar(p.email));
    zerarJanelasDoLog();
    const aviso = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      await cadastrarFator(c, p.userId);
      const logins = aviso.mock.calls.map((x) => String(x[0])).filter((l) => l.includes('"evento":"LOGIN_OK"') && l.includes(p.userId));
      expect(logins).toHaveLength(1);
      expect(logins[0]).toContain('"motivo":"cadastro_do_fator"');
      // H2 da reconferência do #176: o login em duas etapas de quem já tem TOTP sai como login (sem motivo).
      aviso.mockClear();
      zerarJanelasDoLog();
      const senha = await postar('/sign-in/email', {}, { email: p.email, password: SENHA });
      expect((await postar('/two-factor/verify-totp', senha.cabecalhos, { code: proximoCodigo(p.userId) })).r.status).toBe(200);
      const linhas = aviso.mock.calls.map((x) => String(x[0])).filter((l) => l.includes(p.userId));
      expect(linhas.filter((l) => l.includes('"evento":"LOGIN_SENHA_OK"'))).toHaveLength(1);
      const ok = linhas.filter((l) => l.includes('"evento":"LOGIN_OK"'));
      expect(ok).toHaveLength(1);
      expect(ok[0]).not.toContain('"motivo"');
    } finally {
      aviso.mockRestore();
    }
  });

  it('R3 do 3b-1: convite encerrado há mais de 30 dias perde o HMAC do e-mail; o pendente fica', async () => {
    const tenantId = await api.novaClinica();
    const adm = await api.membro(tenantId, api.sessao(tenantId, 'admin'), 'admin');
    const ctx = { tenantId, userId: adm.userId, roles: ['admin'] } as never;
    const velho = await convites().criar(ctx, `velho-${randomUUID().slice(0, 6)}@exemplo.test`, 'recepcao');
    const novo = await convites().criar(ctx, `novo-${randomUUID().slice(0, 6)}@exemplo.test`, 'recepcao');
    await convites().revogar(ctx, velho.conviteId);
    await withTenant(api.db.db, tenantId, (tx) =>
      tx.execute(sql`update team_invites set revoked_at = now() - interval '31 days', created_at = now() - interval '33 days', expires_at = now() - interval '31 days' where id = ${velho.conviteId}`),
      adm.userId,
    );
    expect((await convites().descartarEncerradosComoSistema(tenantId)).descartados).toBe(1);
    const linhas = await withTenant(api.db.db, tenantId, (tx) => tx.execute<{ id: string; email_hmac: string }>(sql`select id, email_hmac from team_invites`));
    expect(linhas.find((l) => l.id === velho.conviteId)?.email_hmac).toBe('0'.repeat(32));
    expect(linhas.find((l) => l.id === novo.conviteId)?.email_hmac).not.toBe('0'.repeat(32));
  });
});

async function sequencial<T>(tarefas: (() => Promise<T>)[]): Promise<T[]> {
  const saida: T[] = [];
  for (const t of tarefas) saida.push(await t());
  return saida;
}
