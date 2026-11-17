/**
 * Ativação do fundador da clínica provisionada (B11, PR 2; R2, R4, R5, R7, R8 e R9 do parecer do Guardião de
 * 16/11/2026; C2 e C3 do parecer do #195), contra o banco: `app_auth` para o schema identidade e `app_user` (RLS) para
 * a clínica, com o provedor real (Better Auth) e o TOTP de verdade. Dados fictícios.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { TenantId } from '@plataforma/shared';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConflitoError, NaoEncontradoError } from '../src/common/erros-dominio';
import { ativacaoDoFundador, conta, sessao, usuario } from '../src/db/identidade';
import { auditLog, clinicMembers, tenants } from '../src/db/schema';
import { createDatabase, withTenant, type DatabaseHandle } from '../src/db/tenant-transaction';
import { SYSTEM_ACTOR_ID } from '../src/modules/audit/audit-log';
import { AtivacaoService } from '../src/modules/auth/ativacao';
import { CABECALHO_ORIGEM, criarAutenticacao, nomeDoCookie, type Autenticacao } from '../src/modules/auth/better-auth/instancia';
import { chaveDoBloqueio } from '../src/modules/auth/better-auth/chaves-do-bloqueio';
import { JANELA_DE_BLOQUEIO_MS, TETO_DE_FALHAS_POR_ORIGEM } from '../src/modules/auth/better-auth/protecao';
import { BetterAuthProvider, TETO_DE_FALHAS_DA_ATIVACAO } from '../src/modules/auth/better-auth/provedor';
import { clinicaDoPedido, provisionarClinica, type BancosDoProvisionamento, type PedidoDeProvisionamento } from '../src/modules/auth/better-auth/provisionamento';
import { gerarHashDeSenha } from '../src/modules/auth/better-auth/senha';
import { MemoryRateLimitStore, type RateLimitStore } from '../src/security/rate-limit-store';
import { zerarJanelasDoLog } from '../src/security/log-de-seguranca';
import { codigoErrado, codigoTotp, segredoDoUri } from './apoio-totp';
import { subirApi, type ApiDeTeste } from './apoio-api';

const SENHA = 'Senha-Ficticia-de-Teste-1';
const SENHA_VAZADA = 'Senha-Vazada-Ficticia-1';
const senhaVazadaFicticia = (s: string): Promise<boolean> => Promise.resolve(s === SENHA_VAZADA);
const STORE = new MemoryRateLimitStore();
const CHAVE_DO_BLOQUEIO = randomBytes(32);
const CHAVE_DO_EMAIL = randomBytes(32);
const SEGREDO = randomBytes(32).toString('base64');

let api: ApiDeTeste;
let dbAuth: DatabaseHandle;
let auth: Autenticacao;
let provedor: BetterAuthProvider;
let bancos: BancosDoProvisionamento;

function novoProvedor(store: RateLimitStore = STORE): BetterAuthProvider {
  return new BetterAuthProvider({
    auth,
    dbAuth: dbAuth.db,
    dbClinica: api.db.db,
    conferirSenhaVazada: senhaVazadaFicticia,
    bloqueio: { store, chaveHmac: CHAVE_DO_BLOQUEIO },
    segredoDaInstancia: SEGREDO,
    chaveDoEmailDaAtivacao: CHAVE_DO_EMAIL,
  });
}

beforeAll(async () => {
  api = await subirApi();
  const urlAuth = process.env.DATABASE_AUTH_URL;
  if (!urlAuth) throw new Error('DATABASE_AUTH_URL (papel app_auth) é obrigatória neste teste');
  dbAuth = createDatabase(urlAuth, { max: 2 });
  bancos = { dbAuth: dbAuth.db, dbClinica: api.db.db };
  auth = criarAutenticacao({
    db: dbAuth.db,
    segredo: SEGREDO,
    baseURL: 'http://localhost:3000',
    origensConfiaveis: ['http://localhost:3000'],
    producao: false,
    chaveHmac: CHAVE_DO_BLOQUEIO,
    chaveDoUserAgent: randomBytes(32),
    store: STORE,
    conferirSenhaVazada: senhaVazadaFicticia,
    fator: {
      aoVerificarMfa: (e) => provedor.aposMfaVerificado(e.sessaoId, e.userId, e.motivo),
      aoFalharMfa: (e) => provedor.aposMfaRecusado(e.sessaoId, e.userId, e.bloqueou),
      podeCadastrarFator: (id) => provedor.cadastroLiberado(id),
      aoBloquearFator: (userId) => provedor.avisarFatorBloqueado(userId),
    },
  });
  provedor = novoProvedor();
}, 120_000);

afterAll(async () => {
  await dbAuth?.close();
  await api?.fechar();
});

type Cabecalhos = Record<string, string>;
const ativacao = (p: BetterAuthProvider = provedor): AtivacaoService => new AtivacaoService(p);

/** Origem já em HMAC (como o controller entrega), distinta por teste para o contador por origem não se misturar. */
function cabecalhos(): Headers {
  return new Headers({ [CABECALHO_ORIGEM]: randomBytes(8).toString('hex') });
}

let seq = 0;
function pedidoFicticio(over: Partial<PedidoDeProvisionamento> = {}): PedidoDeProvisionamento {
  seq += 1;
  return { pedido: randomUUID(), contrato: `CTR-${700 + seq}`, email: `fundador.${randomUUID().slice(0, 8)}@exemplo.test`, nomeDaClinica: `Clinica Ficticia Ativacao ${seq}`, ...over };
}

async function provisionar(p: PedidoDeProvisionamento): Promise<{ token: string; clinicaId: TenantId; usuarioId: string }> {
  const tokens: string[] = [];
  const r = await provisionarClinica(bancos, p, (t) => Promise.resolve(void tokens.push(t)), { chaveDoEmail: CHAVE_DO_EMAIL });
  const [linha] = await dbAuth.db.select({ usuarioId: ativacaoDoFundador.usuarioId }).from(ativacaoDoFundador).where(eq(ativacaoDoFundador.id, p.pedido));
  return { token: tokens[0]!, clinicaId: r.clinicaId, usuarioId: linha!.usuarioId };
}

async function linhaDa(pedido: string) {
  const [l] = await dbAuth.db.select().from(ativacaoDoFundador).where(eq(ativacaoDoFundador.id, pedido));
  return l;
}

async function postar(caminho: string, c: Cabecalhos, corpo: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown>; cookies: Cabecalhos }> {
  const r = await auth.handler(
    new Request(`http://localhost:3000/api/auth${caminho}`, {
      method: 'POST',
      headers: { origin: 'http://localhost:3000', 'content-type': 'application/json', [CABECALHO_ORIGEM]: 'a1b2c3d4e5f60718', ...(c.cookie ? { cookie: c.cookie } : {}) },
      body: JSON.stringify(corpo),
    }),
  );
  const texto = await r.text();
  // Junta os cookies vivos aos de antes, como o navegador faria.
  const jarro = new Map<string, string>();
  for (const par of String(c.cookie ?? '').split(/;\s*/).filter(Boolean)) jarro.set(par.split('=')[0] ?? '', par);
  for (const bruto of r.headers.getSetCookie()) {
    const par = bruto.split(';')[0] ?? '';
    const nome = par.split('=')[0] ?? '';
    if (/max-age=0/i.test(bruto) || par.endsWith('=')) jarro.delete(nome);
    else jarro.set(nome, par);
  }
  const cookies: Cabecalhos = jarro.size ? { cookie: [...jarro.values()].join('; ') } : {};
  return { status: r.status, json: texto ? (JSON.parse(texto) as Record<string, unknown>) : {}, cookies };
}

function cookieDeSessao(setCookies: string[]): Cabecalhos {
  const bruto = setCookies.find((c) => c.startsWith(`${nomeDoCookie(false)}=`));
  if (!bruto) throw new Error('sem cookie de sessão');
  return { cookie: bruto.split(';')[0] ?? '' };
}

async function entrar(email: string): Promise<Cabecalhos> {
  const r = await auth.api.signInEmail({ body: { email, password: SENHA }, asResponse: true });
  return cookieDeSessao(r.headers.getSetCookie());
}

/** Pessoa fictícia que já trabalha em outra clínica, com senha e TOTP cadastrado de verdade. */
async function pessoaComFator(): Promise<{ userId: string; email: string; segredo: Buffer; usados: Set<number>; tenantId: TenantId }> {
  const tenantId = await api.novaClinica();
  const userId = randomUUID();
  const email = `pessoa.${userId.slice(0, 8)}@exemplo.test`;
  await dbAuth.db.insert(usuario).values({ id: userId, name: 'Pessoa Ficticia', email, emailVerified: true });
  await dbAuth.db.insert(conta).values({ id: randomUUID(), accountId: userId, providerId: 'credential', userId, password: await gerarHashDeSenha(SENHA) });
  await api.membro(tenantId, { userId }, 'recepcao');
  const c = await entrar(email);
  const s = await auth.api.getSession({ headers: new Headers(c) });
  await dbAuth.db.update(sessao).set({ cadastroPendenteAte: new Date(Date.now() + 15 * 60_000) }).where(eq(sessao.id, s!.session.id));
  const inicio = await postar('/two-factor/enable', c, { password: SENHA });
  expect(inicio.status, JSON.stringify(inicio.json)).toBe(200);
  const segredo = segredoDoUri(String(inicio.json['totpURI']));
  const periodo = Math.floor(Date.now() / 30_000);
  const fim = await postar('/two-factor/verify-totp', inicio.cookies, { code: codigoTotp(segredo, 0) });
  expect(fim.status, JSON.stringify(fim.json)).toBe(200);
  return { userId, email, segredo, usados: new Set([periodo]), tenantId };
}

/** Código ainda não apresentado (a marca de reuso recusa o mesmo período duas vezes). */
function codigoLivre(p: { segredo: Buffer; usados: Set<number> }): string {
  const periodo = Math.floor(Date.now() / 30_000);
  const d = [0, 1].find((x) => !p.usados.has(periodo + x));
  if (d === undefined) throw new Error('sem código livre neste período');
  p.usados.add(periodo + d);
  return codigoTotp(p.segredo, d);
}

async function eventosDurante(fn: () => Promise<unknown>): Promise<string[]> {
  zerarJanelasDoLog();
  const aviso = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  const erro = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  try {
    await fn();
    return [...aviso.mock.calls, ...erro.mock.calls].map((c) => String(c[0])).filter((l) => l.includes('"tipo":"seguranca"'));
  } finally {
    aviso.mockRestore();
    erro.mockRestore();
  }
}

async function trilha(clinicaId: TenantId) {
  return withTenant(api.db.db, clinicaId, (tx) =>
    tx.select({ ator: auditLog.actorId, tipo: auditLog.actorKind, scope: auditLog.scope, meta: auditLog.metadata }).from(auditLog).where(eq(auditLog.tenantId, clinicaId)).orderBy(sql`seq`),
  );
}

describe('B11 PR 2: trilha do provisionamento com ator sistema (R7; C2 do #195)', () => {
  it('tenant_create e member_found saem com ator sistema e metadata fechada, sem operador nem fundador como ator', async () => {
    const p = pedidoFicticio();
    const { clinicaId, usuarioId } = await provisionar(p);
    const linhas = await trilha(clinicaId);
    const criacao = linhas.find((l) => l.meta['op'] === 'tenant_create');
    const fundacao = linhas.find((l) => l.meta['op'] === 'member_found');
    expect(criacao).toMatchObject({ ator: SYSTEM_ACTOR_ID, tipo: 'sistema', scope: 'tenants' });
    expect(criacao?.meta).toEqual({ op: 'tenant_create', via: 'provisionamento', contract: p.contrato });
    expect(fundacao).toMatchObject({ ator: SYSTEM_ACTOR_ID, tipo: 'sistema', scope: 'clinic_members' });
    expect(Object.keys(fundacao?.meta ?? {}).sort()).toEqual(['admins_avisados', 'contract', 'member_id', 'op', 'role', 'user_id', 'via']);
    expect(fundacao?.meta).toMatchObject({ user_id: usuarioId, role: 'admin', via: 'provisionamento', contract: p.contrato });
    // Ninguém além do sistema age na fundação; o fundador ainda não é ator de nada.
    expect(linhas.every((l) => l.ator === SYSTEM_ACTOR_ID)).toBe(true);
    const [membro] = await withTenant(api.db.db, clinicaId, (tx) => tx.select().from(clinicMembers).where(eq(clinicMembers.tenantId, clinicaId)));
    expect(membro).toMatchObject({ userId: usuarioId, role: 'admin', grantedBy: SYSTEM_ACTOR_ID });
  });

  it('0078: a sessão de sistema não funda clínica sem a trilha do provisionamento (sem via, sem contrato ou de outra pessoa)', async () => {
    const fundar = (meta: Record<string, string>, membroDe?: string) => {
      const id = randomUUID() as TenantId;
      const fundador = randomUUID();
      return withTenant(api.db.db, id, async (tx) => {
        await tx.insert(tenants).values({ id, displayName: 'Clinica Ficticia Forjada', founderUserId: fundador });
        await tx.insert(auditLog).values({ tenantId: id, actorId: SYSTEM_ACTOR_ID, actorKind: 'sistema', action: 'create', scope: 'tenants', metadata: { op: 'tenant_create', ...meta } });
        const [m] = await tx.insert(clinicMembers).values({ tenantId: id, userId: membroDe ?? fundador, role: 'admin', grantedBy: SYSTEM_ACTOR_ID }).returning();
        await tx.insert(auditLog).values({
          tenantId: id,
          actorId: SYSTEM_ACTOR_ID,
          actorKind: 'sistema',
          action: 'permission_change',
          scope: 'clinic_members',
          metadata: { op: 'member_found', member_id: m!.id, user_id: membroDe ?? fundador, role: 'admin', ...meta },
        });
      });
    };
    // T1 do parecer de 17/11: conferir o código e a regra, não "qualquer erro".
    const errosPg = async (p: Promise<unknown>) => {
      const e: unknown = await p.then(
        () => undefined,
        (x: unknown) => x,
      );
      const out: { code: unknown; message: string }[] = [];
      for (let x: unknown = e; x instanceof Error; x = x.cause) out.push({ code: (x as { code?: unknown }).code, message: x.message });
      return out;
    };
    const pelaTrilha = (erros: { code: unknown; message: string }[]) => erros.some((x) => x.code === '42501' && /sem a trilha/.test(x.message));
    for (const meta of [{}, { via: 'provisionamento' }, { via: 'runbook', contract: 'CTR-1' }]) {
      const erros = await errosPg(fundar(meta));
      expect(pelaTrilha(erros), JSON.stringify(meta)).toBe(true);
    }
    // Membro diferente do fundador: a recusa vem do clinic_members_guard (0022), antes da trilha.
    expect((await errosPg(fundar({ via: 'provisionamento', contract: 'CTR-1' }, randomUUID()))).some((x) => x.code === '42501')).toBe(true);
    // O caminho completo passa (prova de que as recusas acima são pela trilha, não por outra regra).
    await fundar({ via: 'provisionamento', contract: 'CTR-1' });
    // Fora da fundação, a sessão de sistema continua sem conceder perfil.
    const outra = await api.novaClinica();
    const semFundacao = await errosPg(
      withTenant(api.db.db, outra, (tx) => tx.insert(clinicMembers).values({ tenantId: outra, userId: randomUUID(), role: 'admin', grantedBy: SYSTEM_ACTOR_ID })),
    );
    expect(semFundacao.some((x) => x.code === '42501')).toBe(true);
  });
});

describe('B11 PR 2: POST /ativacao/usar (R2, R4, R5, R8 e R9)', () => {
  it('fundador novo: token + e-mail + nome + senha criam a conta reservada; a sessão só serve ao TOTP (enable 200); fora dela, 403 (R8)', async () => {
    const p = pedidoFicticio();
    const { token, clinicaId, usuarioId } = await provisionar(p);
    let cookies: string[] = [];
    const eventos = await eventosDurante(async () => {
      cookies = await ativacao().usar({ token, email: p.email.toUpperCase(), nome: 'Fundadora Ficticia', senha: SENHA, cabecalhos: cabecalhos() });
    });
    const sessaoDeCadastro = cookieDeSessao(cookies);
    const [u] = await dbAuth.db.select().from(usuario).where(eq(usuario.id, usuarioId));
    expect(u).toMatchObject({ email: p.email, ativo: true, clinicaDeOrigem: clinicaId });
    expect(await linhaDa(p.pedido)).toMatchObject({ emailHmac: '0'.repeat(32) });
    expect((await linhaDa(p.pedido))?.usadoEm).not.toBeNull();
    // Sessão de cadastro: nenhuma rota de negócio, mas o cadastro do TOTP vale.
    expect(await provedor.resolver({ headers: sessaoDeCadastro })).toBeNull();
    expect((await postar('/two-factor/enable', sessaoDeCadastro, { password: SENHA })).status).toBe(200);
    // Sem o token (só a senha, numa sessão comum): 403 CADASTRO_SO_PELO_CONVITE.
    const semToken = await postar('/two-factor/enable', await entrar(p.email), { password: SENHA });
    expect(semToken.status).toBe(403);
    expect(semToken.json['code']).toBe('CADASTRO_SO_PELO_CONVITE');

    // Trilha: founder_activated com o FUNDADOR como ator e metadata fechada.
    const ativado = (await trilha(clinicaId)).filter((l) => l.meta['op'] === 'founder_activated');
    expect(ativado).toHaveLength(1);
    expect(ativado[0]).toMatchObject({ ator: usuarioId, tipo: 'usuario_clinica', scope: 'tenants.founder' });
    expect(ativado[0]?.meta).toEqual({ op: 'founder_activated', user_id: usuarioId, contract: p.contrato, account: 'new' });
    // Evento da lista fechada, sem e-mail, nome nem token.
    const doFundador = eventos.filter((l) => l.includes('"evento":"FUNDADOR_ATIVADO"'));
    expect(doFundador).toHaveLength(1);
    expect(JSON.parse(doFundador[0]!)).toMatchObject({ tenantId: clinicaId, userId: usuarioId, pedido: p.pedido, contrato: p.contrato, motivo: 'conta_nova' });
    expect(eventos.join('\n')).not.toContain(token);
    expect(eventos.join('\n')).not.toContain('@exemplo.test');
    expect(eventos.join('\n')).not.toContain('Fundadora');
    expect(eventos.join('\n')).not.toContain('[invalido]');
    // Uso único.
    await expect(ativacao().usar({ token, email: p.email, nome: 'Outra', senha: SENHA, cabecalhos: cabecalhos() })).rejects.toBeInstanceOf(NaoEncontradoError);
  });

  it('fundador com conta existente: exige senha E código TOTP, não abre sessão de cadastro e só então a clínica aparece', async () => {
    const pessoa = await pessoaComFator();
    const p = pedidoFicticio({ email: pessoa.email });
    const { token, clinicaId } = await provisionar(p);
    // Sem código: pede login completo, sem consumir.
    await expect(ativacao().usar({ token, email: pessoa.email, senha: SENHA, cabecalhos: cabecalhos() })).rejects.toMatchObject({ codigo: 'conta_existente_exige_login' });
    // Código errado: recusado, sem consumir.
    await expect(ativacao().usar({ token, email: pessoa.email, senha: SENHA, codigo: codigoErrado(pessoa.segredo, 3), cabecalhos: cabecalhos() })).rejects.toMatchObject({ codigo: 'credenciais_invalidas' });
    expect((await linhaDa(p.pedido))?.usadoEm).toBeNull();
    expect((await provedor.clinicasDaPessoa(pessoa.userId)).map((c) => c.id)).not.toContain(clinicaId);

    const antes = await dbAuth.db.select({ id: sessao.id }).from(sessao).where(eq(sessao.userId, pessoa.userId));
    expect(await ativacao().usar({ token, email: pessoa.email, senha: SENHA, codigo: codigoLivre(pessoa), cabecalhos: cabecalhos() })).toEqual([]);
    const depois = await dbAuth.db.select({ id: sessao.id }).from(sessao).where(eq(sessao.userId, pessoa.userId));
    expect(depois.length).toBe(antes.length);
    expect(await dbAuth.db.select().from(sessao).where(and(eq(sessao.userId, pessoa.userId), isNotNull(sessao.cadastroPendenteAte)))).toEqual([]);
    expect((await provedor.clinicasDaPessoa(pessoa.userId)).map((c) => c.id)).toContain(clinicaId);
    const ativado = (await trilha(clinicaId)).find((l) => l.meta['op'] === 'founder_activated');
    expect(ativado).toMatchObject({ ator: pessoa.userId, tipo: 'usuario_clinica' });
    expect(ativado?.meta).toMatchObject({ account: 'existing' });
  });

  it('e-mail errado: o mesmo 404; a 5ª falha invalida o token (ATIVACAO_BLOQUEADA) e nem o e-mail certo o usa depois', async () => {
    const p = pedidoFicticio();
    const { token } = await provisionar(p);
    const origem = cabecalhos();
    const errado = { token, email: `outra.${randomUUID().slice(0, 8)}@exemplo.test`, nome: 'X', senha: SENHA };
    for (let k = 1; k < TETO_DE_FALHAS_DA_ATIVACAO; k++) {
      await expect(ativacao().usar({ ...errado, cabecalhos: origem })).rejects.toBeInstanceOf(NaoEncontradoError);
      expect((await linhaDa(p.pedido))?.falhas).toBe(k);
    }
    const eventos = await eventosDurante(() => expect(ativacao().usar({ ...errado, cabecalhos: origem })).rejects.toBeInstanceOf(NaoEncontradoError));
    expect(eventos.some((l) => l.includes('"evento":"ATIVACAO_BLOQUEADA"') && l.includes(`"pedido":"${p.pedido}"`))).toBe(true);
    expect(eventos.join('\n')).not.toContain('@exemplo.test');
    const linha = await linhaDa(p.pedido);
    expect(linha).toMatchObject({ falhas: TETO_DE_FALHAS_DA_ATIVACAO, emailHmac: '0'.repeat(32), usadoEm: null });
    await expect(ativacao().usar({ token, email: p.email, nome: 'Fundadora Ficticia', senha: SENHA, cabecalhos: cabecalhos() })).rejects.toBeInstanceOf(NaoEncontradoError);
    // Entrada mal formada não gasta tentativa (nem conta como falha de e-mail).
    const q = pedidoFicticio();
    const outro = await provisionar(q);
    await expect(ativacao().usar({ token: outro.token, email: 'sem-arroba', nome: 'X', senha: SENHA, cabecalhos: cabecalhos() })).rejects.toBeInstanceOf(ConflitoError);
    await expect(ativacao().usar({ token: outro.token, email: q.email, nome: 'X', senha: 'curta', cabecalhos: cabecalhos() })).rejects.toBeInstanceOf(ConflitoError);
    expect((await linhaDa(q.pedido))?.falhas).toBe(0);
  });

  it('token inexistente, vencido ou usado: o mesmo 404 (nada de 410)', async () => {
    const respostas: unknown[] = [];
    const tentar = async (token: string, email: string): Promise<void> => {
      respostas.push(await ativacao().usar({ token, email, nome: 'Fundadora Ficticia', senha: SENHA, cabecalhos: cabecalhos() }).catch((e: unknown) => e));
    };
    const p = pedidoFicticio();
    await tentar(randomBytes(32).toString('base64url'), p.email);
    // Vencido: a linha volta no tempo (o CHECK de 72 h continua valendo).
    const v = await provisionar(p);
    await dbAuth.db
      .update(ativacaoDoFundador)
      .set({ criadoEm: new Date(Date.now() - 80 * 3600_000), expiraEm: new Date(Date.now() - 10 * 3600_000) })
      .where(eq(ativacaoDoFundador.id, p.pedido));
    await tentar(v.token, p.email);
    // Usado.
    const q = pedidoFicticio();
    const u = await provisionar(q);
    await ativacao().usar({ token: u.token, email: q.email, nome: 'Fundadora Ficticia', senha: SENHA, cabecalhos: cabecalhos() });
    await tentar(u.token, q.email);
    expect(respostas).toHaveLength(3);
    for (const r of respostas) {
      expect(r).toBeInstanceOf(NaoEncontradoError);
      expect((r as Error).message).toBe((respostas[0] as Error).message);
    }
    expect(await dbAuth.db.select().from(usuario).where(eq(usuario.id, v.usuarioId))).toEqual([]);
  });

  it('R5: senha vazada é recusada e NÃO consome o token; a senha boa ativa em seguida', async () => {
    const p = pedidoFicticio();
    const { token, usuarioId } = await provisionar(p);
    await expect(ativacao().usar({ token, email: p.email, nome: 'Fundadora Ficticia', senha: SENHA_VAZADA, cabecalhos: cabecalhos() })).rejects.toMatchObject({
      codigo: 'senha_vazada',
    });
    expect(await linhaDa(p.pedido)).toMatchObject({ usadoEm: null, falhas: 0 });
    expect(await dbAuth.db.select().from(usuario).where(eq(usuario.id, usuarioId))).toEqual([]);
    expect(await ativacao().usar({ token, email: p.email, nome: 'Fundadora Ficticia', senha: SENHA, cabecalhos: cabecalhos() })).not.toEqual([]);
  });

  it('R4: contador fora do ar = 503 (falha fechada, BLOQUEIO_INDISPONIVEL) e nada muda', async () => {
    const p = pedidoFicticio();
    const { token, usuarioId } = await provisionar(p);
    const quebrado = {
      hit: () => Promise.reject(new Error('fora')),
      peek: () => Promise.reject(new Error('fora')),
      release: () => Promise.reject(new Error('fora')),
      mode: () => 'compartilhado' as const,
      close: () => Promise.resolve(),
    };
    const eventos = await eventosDurante(() =>
      expect(ativacao(novoProvedor(quebrado)).usar({ token, email: p.email, nome: 'Fundadora Ficticia', senha: SENHA, cabecalhos: cabecalhos() })).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      ),
    );
    expect(eventos.some((l) => l.includes('"evento":"BLOQUEIO_INDISPONIVEL"') && l.includes('"motivo":"bloqueio_da_ativacao"'))).toBe(true);
    expect(await linhaDa(p.pedido)).toMatchObject({ usadoEm: null, falhas: 0 });
    expect(await dbAuth.db.select().from(usuario).where(eq(usuario.id, usuarioId))).toEqual([]);
  });

  it('dois usos ao mesmo tempo: só um passa (consumo atômico)', async () => {
    const p = pedidoFicticio();
    const { token, clinicaId } = await provisionar(p);
    const usos = await Promise.allSettled([0, 1].map(() => ativacao().usar({ token, email: p.email, nome: 'Fundadora Ficticia', senha: SENHA, cabecalhos: cabecalhos() })));
    expect(usos.filter((u) => u.status === 'fulfilled')).toHaveLength(1);
    // T1: o perdedor recusou com o 404 da regra (não erro de pool nem 23505 sem tratamento), e a fundação ativou uma vez.
    const perdedor = usos.find((u) => u.status === 'rejected');
    expect(perdedor?.status === 'rejected' ? perdedor.reason : undefined).toBeInstanceOf(NaoEncontradoError);
    const ativacoes = await withTenant(api.db.db, clinicaId, (tx) =>
      tx.select({ id: auditLog.id }).from(auditLog).where(sql`${auditLog.metadata}->>'op' = 'founder_activated'`),
    );
    expect(ativacoes).toHaveLength(1);
  });
});

describe('B11 PR 2: clínica ativada não recebe token novo (C3 do #195)', () => {
  it('repetir o pedido depois da ativação, mesmo com a linha expurgada, dá ja_provisionado e não emite token', async () => {
    const p = pedidoFicticio();
    const { token, clinicaId } = await provisionar(p);
    await ativacao().usar({ token, email: p.email, nome: 'Fundadora Ficticia', senha: SENHA, cabecalhos: cabecalhos() });
    // Expurgo de 30 dias (PR 3): a linha usada some. O app_auth não apaga; a bancada usa o papel de operação.
    const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_MIGRATOR_URL;
    if (!url) throw new Error('DATABASE_ADMIN_URL ou DATABASE_MIGRATOR_URL é obrigatória para simular o expurgo');
    const op = createDatabase(url, { max: 1 });
    try {
      await op.db.delete(ativacaoDoFundador).where(eq(ativacaoDoFundador.id, p.pedido));
    } finally {
      await op.close();
    }
    expect(await linhaDa(p.pedido)).toBeUndefined();
    const tokens: string[] = [];
    await expect(provisionarClinica(bancos, p, (t) => Promise.resolve(void tokens.push(t)), { chaveDoEmail: CHAVE_DO_EMAIL })).rejects.toMatchObject({ codigo: 'ja_provisionado' });
    expect(tokens).toEqual([]);
    expect(await linhaDa(p.pedido)).toBeUndefined();
    expect(clinicaDoPedido(p.pedido)).toBe(clinicaId);
  });
});

/**
 * Mexe na clínica como o operador faria fora do fluxo (revogar o fundador, trocar o fundador). O runtime não consegue
 * (gatilhos 0022/0047): superusuário do container efêmero, gatilhos desligados só nesta transação, só no teste.
 */
async function comoOperador(fn: (t: postgres.TransactionSql) => Promise<unknown>): Promise<void> {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) throw new Error('DATABASE_ADMIN_URL é obrigatória para simular a revogação ou a troca do fundador');
  const adm = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    await adm.begin(async (t) => {
      await t`set local session_replication_role = replica`;
      await fn(t);
    });
  } finally {
    await adm.end();
  }
}

async function ativacoesNaTrilha(clinicaId: TenantId): Promise<number> {
  return (await trilha(clinicaId)).filter((l) => l.meta['op'] === 'founder_activated').length;
}

/** Captura a rejeição para conferir a classe e o status, sem `rejects.toThrow()` genérico. */
function recusa(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => undefined,
    (x: unknown) => x,
  );
}

describe('T2 do parecer de 17/11: casos de recusa da ativação e resíduo da C1', () => {
  it('fundador revogado ou trocado antes da ativação (FundadorNaoConfere): 404, conta nova não criada, token não consumido', async () => {
    type Mexida = (c: { clinicaId: TenantId; usuarioId: string }) => (t: postgres.TransactionSql) => Promise<unknown>;
    const casos: { nome: string; mexer: Mexida }[] = [
      {
        nome: 'revogado',
        mexer: (c) => (t) =>
          t`update clinic_members set revoked_at = now(), revoked_by = ${c.usuarioId}::uuid where tenant_id = ${c.clinicaId}::uuid and user_id = ${c.usuarioId}::uuid`,
      },
      { nome: 'trocado', mexer: (c) => (t) => t`update tenants set founder_user_id = ${randomUUID()}::uuid where id = ${c.clinicaId}::uuid` },
    ];
    for (const caso of casos) {
      const p = pedidoFicticio();
      const c = await provisionar(p);
      await comoOperador(caso.mexer(c));
      const antes = await linhaDa(p.pedido);
      let erro: unknown;
      const eventos = await eventosDurante(async () => {
        erro = await recusa(ativacao().usar({ token: c.token, email: p.email, nome: 'Fundadora Ficticia', senha: SENHA, cabecalhos: cabecalhos() }));
      });
      expect(erro, caso.nome).toBeInstanceOf(NaoEncontradoError);
      expect((erro as NaoEncontradoError).getStatus(), caso.nome).toBe(404);
      expect(eventos.some((l) => l.includes('"evento":"ATIVACAO_FALHOU"') && l.includes('"motivo":"fundador_nao_confere"')), caso.nome).toBe(true);
      // A transação do app_auth desfez tudo: sem conta, sem credencial, token intacto e sem founder_activated.
      expect(await dbAuth.db.select().from(usuario).where(eq(usuario.id, c.usuarioId)), caso.nome).toEqual([]);
      expect(await dbAuth.db.select().from(conta).where(eq(conta.userId, c.usuarioId)), caso.nome).toEqual([]);
      expect(await linhaDa(p.pedido), caso.nome).toEqual(antes);
      expect(antes, caso.nome).toMatchObject({ usadoEm: null, falhas: 0 });
      expect(await ativacoesNaTrilha(c.clinicaId), caso.nome).toBe(0);
    }
  });

  it('conta existente cujo login resolve para OUTRA conta (login.userId !== usuarioId reservado): 404, sem consumo e sem acesso', async () => {
    const fundadora = await pessoaComFator();
    const outra = await pessoaComFator();
    const emailOriginal = fundadora.email;
    const p = pedidoFicticio({ email: emailOriginal });
    const { token, clinicaId, usuarioId } = await provisionar(p);
    expect(usuarioId).toBe(fundadora.userId);
    // Depois do provisionamento, o e-mail da fundadora passa para a OUTRA conta (troca de e-mail fora do fluxo).
    await dbAuth.db.update(usuario).set({ email: `trocado.${randomUUID().slice(0, 8)}@exemplo.test` }).where(eq(usuario.id, fundadora.userId));
    await dbAuth.db.update(usuario).set({ email: emailOriginal }).where(eq(usuario.id, outra.userId));
    let erro: unknown;
    const eventos = await eventosDurante(async () => {
      // Token e e-mail conferem; senha e código são os da OUTRA conta, que o login resolve pelo e-mail.
      erro = await recusa(ativacao().usar({ token, email: emailOriginal, senha: SENHA, codigo: codigoLivre(outra), cabecalhos: cabecalhos() }));
    });
    expect(erro).toBeInstanceOf(NaoEncontradoError);
    expect(eventos.some((l) => l.includes('"evento":"ATIVACAO_FALHOU"') && l.includes('"motivo":"fundador_nao_confere"'))).toBe(true);
    expect(await linhaDa(p.pedido)).toMatchObject({ usadoEm: null, falhas: 0 });
    expect(await ativacoesNaTrilha(clinicaId)).toBe(0);
    // Nem a outra conta (nunca vinculada) nem a fundadora (ativação pendente) veem a clínica.
    expect((await provedor.clinicasDaPessoa(outra.userId)).map((c) => c.id)).toEqual([outra.tenantId]);
    expect((await provedor.clinicasDaPessoa(fundadora.userId)).map((c) => c.id)).not.toContain(clinicaId);
    expect(await provedor.clinicasDoUsuario(outra.userId)).toEqual([outra.tenantId]);
  });

  it('contador por origem no teto: 404 sem tocar a linha, mesmo com o e-mail certo; a reserva barrada é devolvida', async () => {
    const p = pedidoFicticio();
    const { token, usuarioId } = await provisionar(p);
    const origem = randomBytes(8).toString('hex');
    const chave = chaveDoBloqueio(CHAVE_DO_BLOQUEIO, 'ativacao-origem', origem);
    for (let k = 0; k < TETO_DE_FALHAS_POR_ORIGEM; k++) await STORE.hit(chave, JANELA_DE_BLOQUEIO_MS);
    expect(await STORE.peek(chave, JANELA_DE_BLOQUEIO_MS)).toBe(TETO_DE_FALHAS_POR_ORIGEM);
    const antes = await linhaDa(p.pedido);
    const tentar = (email: string) =>
      recusa(ativacao().usar({ token, email, nome: 'Fundadora Ficticia', senha: SENHA, cabecalhos: new Headers({ [CABECALHO_ORIGEM]: origem }) }));
    let certo: unknown;
    let errado: unknown;
    const eventos = await eventosDurante(async () => {
      certo = await tentar(p.email);
      errado = await tentar(`outra.${randomUUID().slice(0, 8)}@exemplo.test`);
    });
    expect(certo).toBeInstanceOf(NaoEncontradoError);
    expect(errado).toBeInstanceOf(NaoEncontradoError);
    expect(eventos.filter((l) => l.includes('"evento":"ATIVACAO_FALHOU"') && l.includes('"motivo":"bloqueio_da_ativacao"'))).toHaveLength(2);
    expect(eventos.some((l) => l.includes('"motivo":"email_diferente"') || l.includes('"motivo":"token_invalido"'))).toBe(false);
    // A linha nem foi lida para escrita: falhas, HMAC e uso iguais; nenhuma conta criada.
    expect(antes).toMatchObject({ falhas: 0, usadoEm: null });
    expect(await linhaDa(p.pedido)).toEqual(antes);
    expect(await dbAuth.db.select().from(usuario).where(eq(usuario.id, usuarioId))).toEqual([]);
    expect(await STORE.peek(chave, JANELA_DE_BLOQUEIO_MS)).toBe(TETO_DE_FALHAS_POR_ORIGEM);
  });

  it('C1 depois do bloqueio na 5ª falha: a conta existente continua sem ver nem escolher a clínica', async () => {
    const pessoa = await pessoaComFator();
    const p = pedidoFicticio({ email: pessoa.email });
    const { token, clinicaId } = await provisionar(p);
    const origem = cabecalhos();
    const errado = { token, email: `outra.${randomUUID().slice(0, 8)}@exemplo.test`, senha: SENHA };
    for (let k = 0; k < TETO_DE_FALHAS_DA_ATIVACAO; k++) {
      expect(await recusa(ativacao().usar({ ...errado, cabecalhos: origem }))).toBeInstanceOf(NaoEncontradoError);
    }
    expect(await linhaDa(p.pedido)).toMatchObject({ falhas: TETO_DE_FALHAS_DA_ATIVACAO, usadoEm: null, emailHmac: '0'.repeat(32) });
    // A pessoa é admin no banco desde o provisionamento, mas a clínica fica fora da lista, da escolha automática e da escolha.
    expect((await provedor.clinicasDaPessoa(pessoa.userId)).map((c) => c.id)).toEqual([pessoa.tenantId]);
    expect(await provedor.clinicasDoUsuario(pessoa.userId)).toEqual([pessoa.tenantId]);
    expect(await provedor.definirClinica(randomUUID(), pessoa.userId, clinicaId)).toBe(false);
    // Nem o login completo com o e-mail certo destrava depois do bloqueio.
    expect(await recusa(ativacao().usar({ token, email: pessoa.email, senha: SENHA, codigo: codigoLivre(pessoa), cabecalhos: cabecalhos() }))).toBeInstanceOf(NaoEncontradoError);
    expect((await provedor.clinicasDaPessoa(pessoa.userId)).map((c) => c.id)).not.toContain(clinicaId);
    expect(await ativacoesNaTrilha(clinicaId)).toBe(0);
  });

  it('resíduo da C1: pessoa com uma clínica e uma ativação pendente mantém a escolha automática (clinicasDoUsuario)', async () => {
    // Conta existente sem TOTP (o login abre a sessão direto), vinculada a uma clínica só.
    const tenantId = await api.novaClinica();
    const userId = randomUUID();
    const email = `pessoa.${userId.slice(0, 8)}@exemplo.test`;
    await dbAuth.db.insert(usuario).values({ id: userId, name: 'Pessoa Ficticia', email, emailVerified: true });
    await dbAuth.db.insert(conta).values({ id: randomUUID(), accountId: userId, providerId: 'credential', userId, password: await gerarHashDeSenha(SENHA) });
    await api.membro(tenantId, { userId }, 'recepcao');
    const p = pedidoFicticio({ email });
    const { clinicaId } = await provisionar(p);
    expect(clinicaId).not.toBe(tenantId);
    // O vínculo de admin na nova já existe; ainda assim só a antiga conta para a escolha automática.
    expect(await provedor.clinicasDoUsuario(userId)).toEqual([tenantId]);
    expect((await provedor.clinicasDaPessoa(userId)).map((c) => c.id)).toEqual([tenantId]);
    const ctx = await provedor.resolver({ headers: await entrar(email) });
    expect(ctx).toMatchObject({ tenantId, userId });
    expect(ctx?.perfis).toEqual(['recepcao']);
  });
});
