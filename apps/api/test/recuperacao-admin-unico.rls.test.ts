/**
 * Recuperação do fator do admin único pelo suporte (B12; resposta 2 e 3, R2, R4, R5 e R6 do parecer do Guardião de
 * 16/11/2026), contra o banco: `app_auth` para o schema identidade e `app_user` (RLS) para a clínica. O USO do token
 * (a pessoa ainda admin) está na bancada do provedor (`contrato-provedor-better-auth.rls.test.ts`). Dados fictícios.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { TenantId } from '@plataforma/shared';
import { Logger } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { recuperacao, sessao, usuario } from '../src/db/identidade';
import { createDatabase, withTenant, type DatabaseHandle } from '../src/db/tenant-transaction';
import { SYSTEM_ACTOR_ID } from '../src/modules/audit/audit-log';
import {
  emitirRecuperacaoPeloSuporte,
  type BancosDaRecuperacaoPeloSuporte,
  type PedidoDeRecuperacaoPeloSuporte,
} from '../src/modules/auth/better-auth/recuperacao-pelo-suporte';
import { zerarJanelasDoLog } from '../src/security/log-de-seguranca';
import { subirApi, type ApiDeTeste } from './apoio-api';

let api: ApiDeTeste;
let dbAuth: DatabaseHandle;
let bancos: BancosDaRecuperacaoPeloSuporte;
const OPERADOR_FICTICIO = '11111111-2222-4333-8444-555555555555';

beforeAll(async () => {
  api = await subirApi();
  const urlAuth = process.env.DATABASE_AUTH_URL;
  if (!urlAuth) throw new Error('DATABASE_AUTH_URL (papel app_auth) é obrigatória neste teste');
  dbAuth = createDatabase(urlAuth, { max: 2 });
  bancos = { dbAuth: dbAuth.db, dbClinica: api.db.db };
});

afterAll(async () => {
  await dbAuth?.close();
  await api?.fechar();
});

let seq = 0;

/** Conta fictícia no schema identidade, com ou sem fator verificado, e os perfis na clínica. */
async function pessoa(tenantId: TenantId, fator: boolean, ...perfis: ('admin' | 'recepcao')[]): Promise<string> {
  const id = randomUUID();
  await dbAuth.db.insert(usuario).values({ id, name: 'Pessoa Ficticia', email: `admin.ficticio.${id.slice(0, 8)}@exemplo.test`, emailVerified: true, twoFactorEnabled: fator });
  await api.membro(tenantId, { userId: id }, ...perfis);
  return id;
}

function pedido(clinicaId: string, usuarioId: string, over: Partial<PedidoDeRecuperacaoPeloSuporte> = {}): PedidoDeRecuperacaoPeloSuporte {
  seq += 1;
  return { clinicaId, usuarioId, chamado: `SUP-${1000 + seq}`, operador: OPERADOR_FICTICIO, motivo: 'perdeu_o_aparelho', derrubarSessoes: false, ...over };
}

function guarda(): { tokens: string[]; guardar: (t: string) => Promise<void> } {
  const tokens: string[] = [];
  return { tokens, guardar: (t) => Promise.resolve(void tokens.push(t)) };
}

async function trilha(tenantId: TenantId, usuarioId: string) {
  return [
    ...(await withTenant(api.db.db, tenantId, (tx) =>
      tx.execute<{ ator: string; tipo: string | null; meta: Record<string, unknown> }>(
        sql`select actor_id as ator, actor_kind as tipo, metadata as meta from audit_log
            where metadata->>'op' = 'credential_recovery_issued' and metadata->>'user_id' = ${usuarioId}`,
      ),
    )),
  ];
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

describe('B12: emissão da recuperação do fator pelo suporte', () => {
  it('emite token de fator, origem suporte, 24 h, ator sistema e só o hash; trilha com ator sistema e metadata fechada, sem o operador', async () => {
    const tenantId = await api.novaClinica();
    const admin = await pessoa(tenantId, true, 'admin');
    const g = guarda();
    const p = pedido(tenantId, admin);
    const eventos = await eventosDurante(() => emitirRecuperacaoPeloSuporte(bancos, p, g.guardar));
    expect(g.tokens).toHaveLength(1);
    const token = g.tokens[0]!;

    const [linha] = await dbAuth.db.select().from(recuperacao).where(eq(recuperacao.usuarioId, admin));
    expect(linha).toMatchObject({
      tipo: 'fator',
      origem: 'suporte',
      chamado: p.chamado,
      clinicaId: tenantId,
      criadoPor: SYSTEM_ACTOR_ID,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      usadoEm: null,
    });
    expect(linha!.expiraEm.getTime() - linha!.criadoEm.getTime()).toBe(24 * 3600_000);
    expect(JSON.stringify(linha)).not.toContain(token);
    expect(JSON.stringify(linha)).not.toContain(OPERADOR_FICTICIO);

    const prova = await trilha(tenantId, admin);
    expect(prova).toHaveLength(1);
    expect(prova[0]?.tipo).toBe('sistema');
    expect(prova[0]?.ator).toBe(SYSTEM_ACTOR_ID);
    expect(prova[0]?.meta).toEqual({ op: 'credential_recovery_issued', user_id: admin, kind: 'fator', reason: 'perdeu_o_aparelho', via: 'suporte', ticket: p.chamado });
    // Nenhum operador em nenhuma linha da trilha da clínica.
    const tudo = await withTenant(api.db.db, tenantId, (tx) => tx.execute(sql`select actor_id, metadata from audit_log where tenant_id = ${tenantId}`));
    expect(JSON.stringify([...tudo])).not.toContain(OPERADOR_FICTICIO);

    // Evento da lista fechada, com o operador e o chamado, alarme imediato; nenhum dado pessoal nem o token.
    const doSuporte = eventos.filter((l) => l.includes('"evento":"RECUPERACAO_PELO_SUPORTE"'));
    expect(doSuporte).toHaveLength(1);
    const ev = JSON.parse(doSuporte[0]!) as Record<string, unknown>;
    expect(ev).toMatchObject({ alarme: 'imediato', motivo: 'recuperacao_pelo_suporte', tenantId, userId: admin, chamado: p.chamado, operador: OPERADOR_FICTICIO });
    expect(eventos.join('\n')).not.toContain(token);
    expect(eventos.join('\n')).not.toContain('@exemplo.test');
    expect(eventos.join('\n')).not.toContain('[invalido]');
  });

  it('outro admin ativo COM fator verificado: recusa ha_outro_admin, sem token, sem trilha; sem fator, não conta', async () => {
    const tenantId = await api.novaClinica();
    const admin = await pessoa(tenantId, true, 'admin');
    const outro = await pessoa(tenantId, true, 'admin');
    const g = guarda();
    await expect(emitirRecuperacaoPeloSuporte(bancos, pedido(tenantId, admin), g.guardar)).rejects.toMatchObject({ codigo: 'ha_outro_admin' });
    expect(g.tokens).toEqual([]);
    expect(await dbAuth.db.select().from(recuperacao).where(eq(recuperacao.usuarioId, admin))).toEqual([]);
    expect(await trilha(tenantId, admin)).toEqual([]);

    // O outro admin perde o fator: o admin passa a ser o único com fator, e a emissão segue.
    await dbAuth.db.update(usuario).set({ twoFactorEnabled: false }).where(eq(usuario.id, outro));
    await emitirRecuperacaoPeloSuporte(bancos, pedido(tenantId, admin), g.guardar);
    expect(g.tokens).toHaveLength(1);
  });

  it('não admin, clínica inexistente, conta inativa, chamado fora do formato e invasão sem derrubar sessões: recusas fixas', async () => {
    const tenantId = await api.novaClinica();
    const recepcao = await pessoa(tenantId, true, 'recepcao');
    const g = guarda();
    await expect(emitirRecuperacaoPeloSuporte(bancos, pedido(tenantId, recepcao), g.guardar)).rejects.toMatchObject({ codigo: 'nao_e_admin' });
    await expect(emitirRecuperacaoPeloSuporte(bancos, pedido(randomUUID(), recepcao), g.guardar)).rejects.toMatchObject({ codigo: 'clinica_nao_encontrada' });
    const inativo = await pessoa(tenantId, true, 'admin');
    await dbAuth.db.update(usuario).set({ ativo: false }).where(eq(usuario.id, inativo));
    await expect(emitirRecuperacaoPeloSuporte(bancos, pedido(tenantId, inativo), g.guardar)).rejects.toMatchObject({ codigo: 'conta_inativa' });
    const admin = await pessoa(tenantId, false, 'admin');
    await expect(emitirRecuperacaoPeloSuporte(bancos, pedido(tenantId, admin, { chamado: 'LGPD-1' }), g.guardar)).rejects.toMatchObject({ codigo: 'chamado_invalido' });
    await expect(emitirRecuperacaoPeloSuporte(bancos, pedido(tenantId, admin, { motivo: 'suspeita_de_invasao' }), g.guardar)).rejects.toMatchObject({
      codigo: 'derrubar_sessoes_obrigatorio',
    });
    expect(g.tokens).toEqual([]);
  });

  it('teto: um por clínica em 30 dias e dois por pessoa em 12 meses; o teto alarma e não deixa trilha', async () => {
    const t1 = await api.novaClinica();
    const admin = await pessoa(t1, true, 'admin');
    const g = guarda();
    await emitirRecuperacaoPeloSuporte(bancos, pedido(t1, admin), g.guardar);
    let eventos = await eventosDurante(() => expect(emitirRecuperacaoPeloSuporte(bancos, pedido(t1, admin), g.guardar)).rejects.toMatchObject({ codigo: 'teto' }));
    expect(eventos.some((l) => l.includes('"evento":"RECUPERACAO_TETO"') && l.includes('"motivo":"teto_do_suporte"'))).toBe(true);
    expect(g.tokens).toHaveLength(1);
    expect(await trilha(t1, admin)).toHaveLength(1);

    // Por pessoa: a mesma pessoa admin única em outras clínicas. A segunda passa; a terceira bate no teto de 12 meses.
    const t2 = await api.novaClinica();
    const t3 = await api.novaClinica();
    await api.membro(t2, { userId: admin }, 'admin');
    await api.membro(t3, { userId: admin }, 'admin');
    await emitirRecuperacaoPeloSuporte(bancos, pedido(t2, admin), g.guardar);
    eventos = await eventosDurante(() => expect(emitirRecuperacaoPeloSuporte(bancos, pedido(t3, admin), g.guardar)).rejects.toMatchObject({ codigo: 'teto' }));
    expect(eventos.some((l) => l.includes('"evento":"RECUPERACAO_TETO"'))).toBe(true);
    expect(g.tokens).toHaveLength(2);
    expect(await trilha(t3, admin)).toEqual([]);
  });

  it('o token novo invalida os pendentes da pessoa; --derrubar-sessoes apaga as sessões na emissão', async () => {
    const tenantId = await api.novaClinica();
    const admin = await pessoa(tenantId, true, 'admin');
    const antigo = randomUUID();
    await dbAuth.db.insert(recuperacao).values({
      id: antigo,
      usuarioId: admin,
      tipo: 'senha',
      tokenHash: createHash('sha256').update(`ficticio-${antigo}`).digest('hex'),
      clinicaId: tenantId,
      criadoPor: randomUUID(),
      expiraEm: new Date(Date.now() + 10 * 60_000),
    });
    await dbAuth.db.insert(sessao).values({ id: randomUUID(), token: `sessao-ficticia-${antigo}`, userId: admin, expiresAt: new Date(Date.now() + 3600_000) });
    const r = await emitirRecuperacaoPeloSuporte(bancos, pedido(tenantId, admin, { motivo: 'suspeita_de_invasao', derrubarSessoes: true }), guarda().guardar);
    expect(r.sessoesDerrubadas).toBe(1);
    expect(await dbAuth.db.select().from(sessao).where(eq(sessao.userId, admin))).toEqual([]);
    const [velho] = await dbAuth.db.select({ usadoEm: recuperacao.usadoEm }).from(recuperacao).where(eq(recuperacao.id, antigo));
    expect(velho?.usadoEm).not.toBeNull();
  });

  it('falha ao guardar o token: nem linha nem trilha ficam', async () => {
    const tenantId = await api.novaClinica();
    const admin = await pessoa(tenantId, true, 'admin');
    await expect(emitirRecuperacaoPeloSuporte(bancos, pedido(tenantId, admin), () => Promise.reject(new Error('ssm fora')))).rejects.toThrow('ssm fora');
    expect(await dbAuth.db.select().from(recuperacao).where(eq(recuperacao.usuarioId, admin))).toEqual([]);
    expect(await trilha(tenantId, admin)).toEqual([]);
  });
});

describe('B12: CHECKs da 0077 (R2(d) do parecer)', () => {
  const base = (over: Record<string, unknown>) => ({
    id: randomUUID(),
    usuarioId: randomUUID(),
    tipo: 'fator' as const,
    tokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
    clinicaId: randomUUID(),
    criadoPor: SYSTEM_ACTOR_ID,
    expiraEm: sql`now() + interval '1 hour'`,
    ...over,
  });

  async function inserir(over: Record<string, unknown>): Promise<void> {
    const id = randomUUID();
    await dbAuth.db.insert(usuario).values({ id, name: 'Pessoa Ficticia', email: `check.${id.slice(0, 8)}@exemplo.test`, emailVerified: true });
    await dbAuth.db.insert(recuperacao).values(base({ usuarioId: id, ...over }) as never);
  }

  it('origem suporte sem chamado, com chamado fora do formato, de senha, com outro emissor ou acima de 24 h: o banco recusa', async () => {
    await expect(inserir({ origem: 'suporte' })).rejects.toThrow();
    await expect(inserir({ origem: 'suporte', chamado: 'LGPD-1' })).rejects.toThrow();
    await expect(inserir({ origem: 'suporte', chamado: 'SUP-1', tipo: 'senha' })).rejects.toThrow();
    await expect(inserir({ origem: 'suporte', chamado: 'SUP-1', criadoPor: randomUUID() })).rejects.toThrow();
    await expect(inserir({ origem: 'suporte', chamado: 'SUP-1', expiraEm: sql`now() + interval '25 hours'` })).rejects.toThrow();
    await expect(inserir({ origem: 'admin', chamado: 'SUP-1', expiraEm: sql`now() + interval '10 minutes'` })).rejects.toThrow();
    // Origem admin segue com o teto de 15 min da 0068.
    await expect(inserir({ origem: 'admin', expiraEm: sql`now() + interval '1 hour'` })).rejects.toThrow();
    await inserir({ origem: 'suporte', chamado: 'SUP-1', expiraEm: sql`now() + interval '24 hours'` });
    await inserir({ expiraEm: sql`now() + interval '15 minutes'` });
  });

  it('linhas sem origem explícita são do admin (padrão)', async () => {
    const id = randomUUID();
    await dbAuth.db.insert(usuario).values({ id, name: 'Pessoa Ficticia', email: `padrao.${id.slice(0, 8)}@exemplo.test`, emailVerified: true });
    await dbAuth.db.insert(recuperacao).values(base({ usuarioId: id, criadoPor: randomUUID(), expiraEm: sql`now() + interval '15 minutes'` }) as never);
    const [l] = await dbAuth.db.select({ origem: recuperacao.origem, chamado: recuperacao.chamado }).from(recuperacao).where(and(eq(recuperacao.usuarioId, id)));
    expect(l).toEqual({ origem: 'admin', chamado: null });
  });
});
