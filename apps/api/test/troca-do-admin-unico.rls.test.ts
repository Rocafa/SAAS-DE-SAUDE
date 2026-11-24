/**
 * Troca do admin único que perdeu senha e fator (B13; parecer do Guardião de 24/11/2026, R1 a R5), contra o banco: a
 * tarefa com o papel `app_provisionamento` (0080 + 0082), a API com `app_auth` (identidade) e `app_user` (clínica, RLS),
 * o provedor real (Better Auth) e o TOTP de verdade. A janela de 48 h é "envelhecida" pelo papel administrativo do CI
 * (só nas duas colunas de hora, com os triggers desligados na transação). Dados fictícios.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { TenantId, UserId } from '@plataforma/shared';
import { Logger } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NaoEncontradoError } from '../src/common/erros-dominio';
import { ativacaoDoFundador, sessao, trocaDoAdmin, usuario } from '../src/db/identidade';
import { auditLog, clinicMembers } from '../src/db/schema';
import { createDatabase, withTenant, type DatabaseHandle } from '../src/db/tenant-transaction';
import { SYSTEM_ACTOR_ID } from '../src/modules/audit/audit-log';
import { AtivacaoService } from '../src/modules/auth/ativacao';
import { CABECALHO_ORIGEM, criarAutenticacao, nomeDoCookie, type Autenticacao } from '../src/modules/auth/better-auth/instancia';
import { BetterAuthProvider } from '../src/modules/auth/better-auth/provedor';
import { cancelarTrocaDoAdmin, emitirTrocaDoAdmin, pedirTrocaDoAdmin, type PedidoDeTroca } from '../src/modules/auth/better-auth/troca-do-admin';
import { concluirTrocasPendentes } from '../src/modules/auth/better-auth/troca-do-admin-na-api';
import { MembrosService } from '../src/modules/auth/membros';
import { MemoryRateLimitStore } from '../src/security/rate-limit-store';
import { zerarJanelasDoLog } from '../src/security/log-de-seguranca';
import { codigoTotp, segredoDoUri } from './apoio-totp';
import { subirApi, type ApiDeTeste } from './apoio-api';

const SENHA = 'Senha-Ficticia-de-Teste-1';
const STORE = new MemoryRateLimitStore();
const CHAVE_DO_BLOQUEIO = randomBytes(32);
const CHAVE_DO_EMAIL = randomBytes(32);
const SEGREDO = randomBytes(32).toString('base64');
const OPERADOR_A = '11111111-2222-4333-8444-555555555555';
const OPERADOR_B = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const ZEROS = '0'.repeat(32);

let api: ApiDeTeste;
let dbAuth: DatabaseHandle;
let dbProv: DatabaseHandle;
let admin: postgres.Sql;
let auth: Autenticacao;
let provedor: BetterAuthProvider;

beforeAll(async () => {
  api = await subirApi();
  const urlAuth = process.env.DATABASE_AUTH_URL;
  const urlProv = process.env.DATABASE_PROVISIONAMENTO_URL;
  const urlAdmin = process.env.DATABASE_ADMIN_URL;
  if (!urlAuth || !urlProv || !urlAdmin) throw new Error('DATABASE_AUTH_URL, DATABASE_PROVISIONAMENTO_URL e DATABASE_ADMIN_URL são obrigatórias neste teste');
  dbAuth = createDatabase(urlAuth, { max: 2 });
  // A tarefa usa só o papel dedicado (0080/0082), uma conexão.
  dbProv = createDatabase(urlProv, { max: 1 });
  admin = postgres(urlAdmin, { max: 1, onnotice: () => undefined });
  auth = criarAutenticacao({
    db: dbAuth.db,
    segredo: SEGREDO,
    baseURL: 'http://localhost:3000',
    origensConfiaveis: ['http://localhost:3000'],
    producao: false,
    chaveHmac: CHAVE_DO_BLOQUEIO,
    chaveDoUserAgent: randomBytes(32),
    store: STORE,
    conferirSenhaVazada: () => Promise.resolve(false),
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
    bloqueio: { store: STORE, chaveHmac: CHAVE_DO_BLOQUEIO },
    segredoDaInstancia: SEGREDO,
    chaveDoEmailDaAtivacao: CHAVE_DO_EMAIL,
  });
}, 120_000);

afterAll(async () => {
  await admin?.end({ timeout: 5 });
  await dbProv?.close();
  await dbAuth?.close();
  await api?.fechar();
});

type Cabecalhos = Record<string, string>;

async function postar(caminho: string, c: Cabecalhos, corpo: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown>; cookies: Cabecalhos }> {
  const r = await auth.handler(
    new Request(`http://localhost:3000/api/auth${caminho}`, {
      method: 'POST',
      headers: { origin: 'http://localhost:3000', 'content-type': 'application/json', [CABECALHO_ORIGEM]: 'b1c2d3e4f5a60718', ...(c.cookie ? { cookie: c.cookie } : {}) },
      body: JSON.stringify(corpo),
    }),
  );
  const texto = await r.text();
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

const evento = (eventos: string[], nome: string) => eventos.filter((l) => l.includes(`"evento":"${nome}"`)).map((l) => JSON.parse(l) as Record<string, unknown>);

/** Códigos e mensagens do erro e das causas (o driver embrulha o do Postgres). */
async function errosPg(p: Promise<unknown>): Promise<{ code: unknown; message: string }[]> {
  const e: unknown = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  const out: { code: unknown; message: string }[] = [];
  for (let x: unknown = e; x instanceof Error; x = x.cause) out.push({ code: (x as { code?: unknown }).code, message: x.message });
  return out;
}
const recusou42501 = (erros: { code: unknown; message: string }[], regra?: RegExp) => erros.some((x) => x.code === '42501' && (!regra || regra.test(x.message)));
const codigo = async (p: Promise<unknown>) => ((await p.then(() => null, (e: unknown) => e)) as { codigo?: string } | null)?.codigo;

/** Conta fictícia com fator (marcado) e perfis na clínica. */
async function contaComFator(tenantId: TenantId, ...perfis: ('admin' | 'recepcao')[]): Promise<string> {
  const id = randomUUID();
  await dbAuth.db.insert(usuario).values({ id, name: 'Admin Ficticio', email: `admin.ficticio.${id.slice(0, 8)}@exemplo.test`, emailVerified: true, twoFactorEnabled: true });
  await api.membro(tenantId, { userId: id }, ...perfis);
  return id;
}

let seq = 0;
function pedidoFicticio(clinicaId: string, usuarioAntigo: string, over: Partial<PedidoDeTroca> = {}): PedidoDeTroca {
  seq += 1;
  return {
    pedido: randomUUID(),
    clinicaId,
    usuarioAntigo,
    chamado: `SUP-${3000 + seq}`,
    contrato: `CTR-${3000 + seq}`,
    motivo: 'perdeu_senha_e_fator',
    operador: OPERADOR_A,
    vivaVoz: new Date().toISOString(),
    suspenderContaAntiga: false,
    email: `conta.nova.${randomUUID().slice(0, 8)}@exemplo.test`,
    ...over,
  };
}

const pedir = (p: PedidoDeTroca) => pedirTrocaDoAdmin(dbProv.db, p, { chaveDoEmail: CHAVE_DO_EMAIL });

/** Envelhece a janela (as duas horas juntas, o CHECK segue valendo) pelo papel administrativo, sem triggers. */
async function liberar(pedido: string): Promise<void> {
  await admin.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    await tx`update identidade.troca_do_admin set pedido_em = pedido_em - interval '49 hours', libera_em = libera_em - interval '49 hours' where id = ${pedido}`;
  });
}

async function emitir(p: PedidoDeTroca, operador = OPERADOR_B): Promise<string> {
  const tokens: string[] = [];
  await emitirTrocaDoAdmin(dbProv.db, { pedido: p.pedido, chamado: p.chamado, operador, vivaVoz: new Date().toISOString() }, (t) => Promise.resolve(void tokens.push(t)));
  return tokens[0]!;
}

async function troca(pedido: string) {
  const [t] = await dbAuth.db.select().from(trocaDoAdmin).where(eq(trocaDoAdmin.id, pedido));
  return t!;
}

async function membros(clinicaId: string, userId: string) {
  return withTenant(api.db.db, clinicaId as TenantId, (tx) =>
    tx.select().from(clinicMembers).where(and(eq(clinicMembers.tenantId, clinicaId), eq(clinicMembers.userId, userId))),
  );
}

async function trilha(clinicaId: string) {
  return withTenant(api.db.db, clinicaId as TenantId, (tx) =>
    tx.select({ ator: auditLog.actorId, tipo: auditLog.actorKind, meta: auditLog.metadata }).from(auditLog).where(eq(auditLog.tenantId, clinicaId)).orderBy(sql`seq`),
  );
}

const ativacao = () => new AtivacaoService(provedor);

/** Ativa a conta nova pelo token e devolve a sessão de cadastro (só serve ao TOTP). */
async function ativar(token: string, email: string): Promise<Cabecalhos> {
  const cookies = await ativacao().usar({ token, email, nome: 'Admin Novo Ficticio', senha: SENHA, cabecalhos: new Headers({ [CABECALHO_ORIGEM]: randomBytes(8).toString('hex') }) });
  return cookieDeSessao(cookies);
}

/** Cadastro do TOTP na sessão de cadastro: o `verify-totp` aceito chama o gancho que conclui a troca (R1). */
async function confirmarTotp(cadastro: Cabecalhos): Promise<void> {
  const inicio = await postar('/two-factor/enable', cadastro, { password: SENHA });
  expect(inicio.status, JSON.stringify(inicio.json)).toBe(200);
  const fim = await postar('/two-factor/verify-totp', inicio.cookies, { code: codigoTotp(segredoDoUri(String(inicio.json['totpURI'])), 0) });
  expect(fim.status, JSON.stringify(fim.json)).toBe(200);
}

describe('B13: caminho feliz (pedir, janela, emitir, ativar, TOTP e conclusão)', () => {
  it('o vínculo antigo só cai na confirmação do TOTP; trilha com ator sistema (sem operador) e depois a conta nova', async () => {
    const clinicaId = await api.novaClinica();
    const antigo = await contaComFator(clinicaId, 'admin', 'recepcao');
    const p = pedidoFicticio(clinicaId, antigo);
    const noPedido = await eventosDurante(() => pedir(p));
    const t0 = await troca(p.pedido);
    expect(t0).toMatchObject({ estado: 'aguardando', usuarioAntigo: antigo, operadorPedido: OPERADOR_A, chamado: p.chamado, reemissoes: 0 });
    expect(t0.emailHmac).not.toBe(ZEROS);
    expect(t0.liberaEm.getTime() - t0.pedidoEm.getTime()).toBe(48 * 3600_000);
    expect(evento(noPedido, 'TROCA_DO_ADMIN_PEDIDA')[0]).toMatchObject({ tenantId: clinicaId, userId: antigo, operador: OPERADOR_A, chamado: p.chamado, pedido: p.pedido });

    // Janela aberta: nada sai.
    expect(await codigo(emitir(p))).toBe('janela_aberta');
    await liberar(p.pedido);
    const token = await emitir(p);
    const t1 = await troca(p.pedido);
    expect(t1).toMatchObject({ estado: 'emitida', emailHmac: ZEROS });
    const [linha] = await dbAuth.db.select().from(ativacaoDoFundador).where(eq(ativacaoDoFundador.trocaId, p.pedido));
    expect(linha).toMatchObject({ origem: 'troca', chamado: p.chamado, usuarioId: t1.usuarioNovo, contaExistente: false, usadoEm: null });
    expect(linha!.expiraEm.getTime() - linha!.criadoEm.getTime()).toBe(24 * 3600_000);
    // Só admin para a conta nova (P8), pelo sentinela; a antiga segue admin.
    expect((await membros(clinicaId, t1.usuarioNovo)).map((m) => [m.role, m.grantedBy, m.revokedAt])).toEqual([['admin', SYSTEM_ACTOR_ID, null]]);
    expect((await membros(clinicaId, antigo)).every((m) => m.revokedAt === null)).toBe(true);

    // Ativação: a conta nova nasce; NADA da conta antiga muda (R1).
    const cadastro = await ativar(token, p.email);
    expect((await troca(p.pedido)).estado).toBe('ativada');
    const [nova] = await dbAuth.db.select().from(usuario).where(eq(usuario.id, t1.usuarioNovo));
    expect(nova).toMatchObject({ email: p.email, ativo: true, twoFactorEnabled: false });
    expect((await membros(clinicaId, antigo)).every((m) => m.revokedAt === null)).toBe(true);

    // TOTP confirmado: conclusão.
    const naConclusao = await eventosDurante(() => confirmarTotp(cadastro));
    expect(await troca(p.pedido)).toMatchObject({ estado: 'concluida', encerradaPor: 'sistema' });
    const antigos = await membros(clinicaId, antigo);
    expect(antigos).toHaveLength(2);
    expect(antigos.every((m) => m.revokedBy === t1.usuarioNovo && m.revokedAt !== null)).toBe(true);
    // Sem vínculo em nenhuma clínica: `substituida` (R5), sem sessão.
    const [velha] = await dbAuth.db.select().from(usuario).where(eq(usuario.id, antigo));
    expect(velha).toMatchObject({ ativo: false, inativaPor: 'substituida' });
    expect(await dbAuth.db.select().from(sessao).where(eq(sessao.userId, antigo))).toEqual([]);
    expect(evento(naConclusao, 'ADMIN_SUBSTITUIDO')[0]).toMatchObject({ tenantId: clinicaId, userId: t1.usuarioNovo, chamado: p.chamado, pedido: p.pedido });

    const linhas = await trilha(clinicaId);
    const op = (nome: string) => linhas.filter((l) => l.meta['op'] === nome);
    expect(op('admin_replacement_requested')[0]).toMatchObject({ ator: SYSTEM_ACTOR_ID, tipo: 'sistema' });
    expect(op('admin_replacement_requested')[0]?.meta).toEqual({ op: 'admin_replacement_requested', user_id: antigo, reason: 'perdeu_senha_e_fator', via: 'suporte', ticket: p.chamado, window_hours: 48 });
    const concessao = op('member_grant').find((l) => l.meta['user_id'] === t1.usuarioNovo);
    expect(concessao).toMatchObject({ ator: SYSTEM_ACTOR_ID, tipo: 'sistema' });
    expect(concessao?.meta).toMatchObject({ role: 'admin', via: 'troca_do_admin', ticket: p.chamado });
    const revogacoes = op('member_revoke').filter((l) => l.meta['user_id'] === antigo);
    expect(revogacoes).toHaveLength(2);
    expect(revogacoes.every((l) => l.ator === t1.usuarioNovo && l.meta['via'] === 'troca_do_admin')).toBe(true);
    expect(op('admin_replaced')[0]).toMatchObject({ ator: t1.usuarioNovo });
    expect(op('admin_replaced')[0]?.meta).toEqual({ op: 'admin_replaced', user_id: t1.usuarioNovo, replaces: antigo, ticket: p.chamado });
    // R4: nenhum operador em linha nenhuma da trilha da clínica; nenhum e-mail nem token.
    const tudo = JSON.stringify(linhas);
    for (const proibido of [OPERADOR_A, OPERADOR_B, p.email, token]) expect(tudo).not.toContain(proibido);
    // Uso único do token.
    await expect(ativacao().usar({ token, email: p.email, nome: 'Outra', senha: SENHA, cabecalhos: new Headers() })).rejects.toBeInstanceOf(NaoEncontradoError);
  });
});

describe('B13: R1, sem TOTP confirmado nada se conclui', () => {
  it('troca ativada: a conta antiga segue admin; o job não conclui; o UPDATE direto para concluida sai 42501', async () => {
    const clinicaId = await api.novaClinica();
    const antigo = await contaComFator(clinicaId, 'admin');
    const p = pedidoFicticio(clinicaId, antigo);
    await pedir(p);
    await liberar(p.pedido);
    await ativar(await emitir(p), p.email);
    expect((await troca(p.pedido)).estado).toBe('ativada');
    expect(await concluirTrocasPendentes({ dbAuth: dbAuth.db, dbClinica: api.db.db })).toBe(0);
    const erros = await errosPg(dbAuth.db.update(trocaDoAdmin).set({ estado: 'concluida', encerradaPor: 'sistema' }).where(eq(trocaDoAdmin.id, p.pedido)));
    expect(recusou42501(erros, /sem o TOTP/)).toBe(true);
    expect((await troca(p.pedido)).estado).toBe('ativada');
    expect((await membros(clinicaId, antigo)).every((m) => m.revokedAt === null)).toBe(true);
    const [velha] = await dbAuth.db.select({ ativo: usuario.ativo }).from(usuario).where(eq(usuario.id, antigo));
    expect(velha?.ativo).toBe(true);
  });
});

describe('B13: cancelamento e "não fui eu"', () => {
  it('contestação pela conta antiga na janela: contestada, crítico, e a emissão não sai mais', async () => {
    const clinicaId = await api.novaClinica();
    const antigo = await contaComFator(clinicaId, 'admin');
    const p = pedidoFicticio(clinicaId, antigo);
    await pedir(p);
    const eventos = await eventosDurante(async () => expect(await provedor.contestarTrocaDoAdmin(antigo)).toBe(true));
    expect(await troca(p.pedido)).toMatchObject({ estado: 'contestada', encerradaPor: 'titular', emailHmac: ZEROS });
    expect(evento(eventos, 'TROCA_DO_ADMIN_CONTESTADA')[0]).toMatchObject({ severidade: 'critico', tenantId: clinicaId, userId: antigo, chamado: p.chamado });
    const contestou = (await trilha(clinicaId)).find((l) => l.meta['op'] === 'admin_replacement_contested');
    expect(contestou).toMatchObject({ ator: antigo });
    expect(contestou?.meta).toEqual({ op: 'admin_replacement_contested', ticket: p.chamado });
    await liberar(p.pedido);
    expect(await codigo(emitir(p))).toBe('troca_encerrada');
    expect(await provedor.contestarTrocaDoAdmin(antigo)).toBe(false);
  });

  it('cancelamento pelo contrato depois da emissão: token invalidado, vínculo inerte revogado pelo sentinela, trilha', async () => {
    const clinicaId = await api.novaClinica();
    const antigo = await contaComFator(clinicaId, 'admin');
    const p = pedidoFicticio(clinicaId, antigo);
    await pedir(p);
    await liberar(p.pedido);
    const token = await emitir(p);
    const { usuarioNovo } = await troca(p.pedido);
    await cancelarTrocaDoAdmin(dbProv.db, { pedido: p.pedido, chamado: p.chamado, operador: OPERADOR_B, por: 'contrato' });
    expect(await troca(p.pedido)).toMatchObject({ estado: 'cancelada', encerradaPor: 'contrato' });
    expect(await dbAuth.db.select().from(ativacaoDoFundador).where(and(eq(ativacaoDoFundador.trocaId, p.pedido), isNull(ativacaoDoFundador.usadoEm)))).toEqual([]);
    expect((await membros(clinicaId, usuarioNovo)).map((m) => m.revokedBy)).toEqual([SYSTEM_ACTOR_ID]);
    const cancelou = (await trilha(clinicaId)).find((l) => l.meta['op'] === 'admin_replacement_cancelled');
    expect(cancelou?.meta).toEqual({ op: 'admin_replacement_cancelled', ticket: p.chamado, by: 'contrato' });
    await expect(ativacao().usar({ token, email: p.email, nome: 'Admin Novo Ficticio', senha: SENHA, cabecalhos: new Headers() })).rejects.toBeInstanceOf(NaoEncontradoError);
    expect(await codigo(cancelarTrocaDoAdmin(dbProv.db, { pedido: p.pedido, chamado: p.chamado, operador: OPERADOR_B, por: 'dpo' }))).toBe('troca_encerrada');
  });
});

describe('B13: login completo da conta antiga na janela suspende a troca', () => {
  it('TOTP aceito da conta antiga: troca suspensa (crítico), e a emissão para', async () => {
    const clinicaId = await api.novaClinica();
    const antigo = await contaComFator(clinicaId, 'admin');
    const p = pedidoFicticio(clinicaId, antigo);
    await pedir(p);
    const eventos = await eventosDurante(() => provedor.aposMfaVerificado(randomUUID(), antigo, 'login_em_duas_etapas'));
    expect(await troca(p.pedido)).toMatchObject({ estado: 'suspensa', encerradaPor: 'login_da_conta_antiga' });
    expect(evento(eventos, 'TROCA_DO_ADMIN_SUSPENSA')[0]).toMatchObject({ severidade: 'critico', userId: antigo, tenantId: clinicaId, pedido: p.pedido });
    await liberar(p.pedido);
    expect(await codigo(emitir(p))).toBe('troca_suspensa');
    expect(await membros(clinicaId, (await troca(p.pedido)).usuarioNovo)).toEqual([]);
  });
});

describe('B13: R4, quem pediu não emite', () => {
  it('mesmo_operador: nada é concedido nem emitido', async () => {
    const clinicaId = await api.novaClinica();
    const antigo = await contaComFator(clinicaId, 'admin');
    const p = pedidoFicticio(clinicaId, antigo);
    await pedir(p);
    await liberar(p.pedido);
    expect(await codigo(emitir(p, OPERADOR_A))).toBe('mesmo_operador');
    const t = await troca(p.pedido);
    expect(t.estado).toBe('aguardando');
    expect(await membros(clinicaId, t.usuarioNovo)).toEqual([]);
    expect(await dbAuth.db.select().from(ativacaoDoFundador).where(eq(ativacaoDoFundador.trocaId, p.pedido))).toEqual([]);
  });
});

describe('B13: R3, o trigger de transições e o nascimento da conta nova', () => {
  it('transição fora do grafo, coluna fixa, papel errado ou pedido nascendo fora de aguardando: 42501', async () => {
    const clinicaId = await api.novaClinica();
    const antigo = await contaComFator(clinicaId, 'admin');
    const p = pedidoFicticio(clinicaId, antigo);
    await pedir(p);
    const mudar = (db: DatabaseHandle, set: Partial<typeof trocaDoAdmin.$inferInsert>) => errosPg(db.db.update(trocaDoAdmin).set(set).where(eq(trocaDoAdmin.id, p.pedido)));
    // aguardando -> ativada/concluida: fora do grafo.
    expect(recusou42501(await mudar(dbAuth, { estado: 'ativada' }), /transição/)).toBe(true);
    expect(recusou42501(await mudar(dbAuth, { estado: 'concluida', encerradaPor: 'sistema' }), /transição/)).toBe(true);
    // Emissão pela API: só a tarefa emite.
    expect(recusou42501(await mudar(dbAuth, { estado: 'emitida' }), /emissão só pela tarefa/)).toBe(true);
    // Emissão pela tarefa antes da janela: recusada pelo banco também.
    expect(recusou42501(await mudar(dbProv, { estado: 'emitida' }), /depois da janela/)).toBe(true);
    // Coluna fixa (o chamado) não muda.
    expect(recusou42501(await errosPg(admin`update identidade.troca_do_admin set chamado = 'SUP-1' where id = ${p.pedido}`), /só o estado muda/)).toBe(true);
    // Encerramento sem quem encerrou.
    expect(recusou42501(await mudar(dbProv, { estado: 'cancelada' }), /sem quem encerrou/)).toBe(true);
    await mudar(dbProv, { estado: 'cancelada', encerradaPor: 'dpo' });
    expect((await troca(p.pedido)).estado).toBe('cancelada');
    // Final: nada sai dele.
    expect(recusou42501(await mudar(dbProv, { estado: 'aguardando' }), /transição/)).toBe(true);
    // O pedido nasce aguardando (nem a tarefa grava uma troca já concluída).
    const forjada = errosPg(
      dbProv.db.insert(trocaDoAdmin).values({
        id: randomUUID(),
        clinicaId,
        usuarioAntigo: randomUUID(),
        usuarioNovo: randomUUID(),
        operadorPedido: OPERADOR_A,
        emailHmac: 'a'.repeat(32),
        motivo: 'perdeu_senha_e_fator',
        chamado: 'SUP-9',
        contrato: 'CTR-9',
        liberaEm: sql`now() + interval '48 hours'`,
        estado: 'concluida',
      }),
    );
    expect(recusou42501(await forjada, /nasce aguardando/)).toBe(true);
  });

  it('a conta com o uuid reservado não nasce por outro caminho (INSERT avulso pela autenticação): 42501', async () => {
    const clinicaId = await api.novaClinica();
    const antigo = await contaComFator(clinicaId, 'admin');
    const p = pedidoFicticio(clinicaId, antigo);
    await pedir(p);
    const { usuarioNovo } = await troca(p.pedido);
    const inserir = () =>
      errosPg(dbAuth.db.insert(usuario).values({ id: usuarioNovo, name: 'Conta Forjada Ficticia', email: `forjada.${randomUUID().slice(0, 8)}@exemplo.test`, emailVerified: false }));
    expect(recusou42501(await inserir(), /só nasce na ativação/)).toBe(true);
    // Nem depois da emissão (token vivo, troca emitida).
    await liberar(p.pedido);
    await emitir(p);
    expect(recusou42501(await inserir(), /só nasce na ativação/)).toBe(true);
    expect(await dbAuth.db.select().from(usuario).where(eq(usuario.id, usuarioNovo))).toEqual([]);
  });
});

describe('B13: R5, a conta substituída', () => {
  it('login completo depois da conclusão: alarme crítico e trilha; no último vínculo vira substituida e não recebe perfil', async () => {
    const clinicaId = await api.novaClinica();
    const outra = await api.novaClinica();
    const antigo = await contaComFator(clinicaId, 'admin');
    // A conta antiga também trabalha em outra clínica (P4: lá nada muda, e ninguém é avisado).
    await api.membro(outra, { userId: antigo }, 'recepcao');
    const p = pedidoFicticio(clinicaId, antigo);
    await pedir(p);
    await liberar(p.pedido);
    await confirmarTotp(await ativar(await emitir(p), p.email));
    expect((await troca(p.pedido)).estado).toBe('concluida');
    const [ainda] = await dbAuth.db.select({ ativo: usuario.ativo, inativaPor: usuario.inativaPor }).from(usuario).where(eq(usuario.id, antigo));
    expect(ainda).toEqual({ ativo: true, inativaPor: null });
    expect((await membros(outra, antigo)).every((m) => m.revokedAt === null)).toBe(true);

    const eventos = await eventosDurante(() => provedor.aposMfaVerificado(randomUUID(), antigo, 'login_em_duas_etapas'));
    expect(evento(eventos, 'CONTA_SUBSTITUIDA_ENTROU')[0]).toMatchObject({ severidade: 'critico', alarme: 'imediato', userId: antigo, tenantId: clinicaId, pedido: p.pedido });
    const alarme = (await trilha(clinicaId)).find((l) => l.meta['op'] === 'replaced_account_login');
    expect(alarme).toMatchObject({ ator: SYSTEM_ACTOR_ID, tipo: 'sistema' });
    expect(alarme?.meta).toEqual({ op: 'replaced_account_login', user_id: antigo, ticket: p.chamado });

    // O último vínculo cai na outra clínica: `substituida` (nunca `sem_vinculo`) e nenhuma concessão a reativa.
    const fundadorDaOutra = { tenantId: outra, userId: api.fundador(outra) as UserId, roles: ['admin'] };
    await api.app.get(MembrosService).revogar(fundadorDaOutra, antigo, 'recepcao');
    const [depois] = await dbAuth.db.select({ ativo: usuario.ativo, inativaPor: usuario.inativaPor }).from(usuario).where(eq(usuario.id, antigo));
    expect(depois).toEqual({ ativo: false, inativaPor: 'substituida' });
    const erros = await errosPg(api.app.get(MembrosService).conceder(fundadorDaOutra, antigo, 'recepcao'));
    expect(recusou42501(erros, /conta encerrada/)).toBe(true);
  });
});
