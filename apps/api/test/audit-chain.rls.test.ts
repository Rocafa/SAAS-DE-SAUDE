/**
 * Auditoria encadeada por clínica (S6, migração 0005) contra Postgres REAL.
 * - a cadeia nasce no banco, sem corrida mesmo com transações concorrentes;
 * - clínicas têm cadeias independentes e isoladas pelo RLS;
 * - adulterar, apagar e reordenar linhas é detectado pelo verificador.
 * A adulteração é feita pelo papel DONO da tabela (app_migrator), desligando de propósito o RLS
 * forçado e o trigger append-only — o pior caso: alguém com acesso privilegiado ao banco.
 * Pré-requisitos: migrações aplicadas, DATABASE_URL (app_user) e DATABASE_MIGRATOR_URL. Dados fictícios.
 */
import { AuditAction, type RequestContext, type TenantId, type UserId } from '@plataforma/shared';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tenants } from '../src/db/schema';
import { createDatabase, withTenant, type DatabaseHandle } from '../src/db/tenant-transaction';
import { auditChainHead, GENESIS_HASH, verifyAuditChain, type ChainAnchor } from '../src/modules/audit/audit-chain';
import { recordAudit } from '../src/modules/audit/audit-log';
import { AuditMetadataRejectedError, assertAuditMetadata } from '../src/modules/audit/audit-metadata';
import { METADATA_ACEITO, METADATA_RECUSADO } from '../src/modules/audit/audit-metadata.cases';

const url = process.env.DATABASE_URL;
const migratorUrl = process.env.DATABASE_MIGRATOR_URL;
if (!url || !migratorUrl) throw new Error('DATABASE_URL e DATABASE_MIGRATOR_URL são obrigatórias para este teste');

let h: DatabaseHandle;
let owner: postgres.Sql;

const ctxFor = (tenantId: TenantId): RequestContext => ({ tenantId, userId: randomUUID() as UserId, roles: ['gestor'] });

async function novaClinica(n = 0): Promise<RequestContext> {
  const ctx = ctxFor(randomUUID() as TenantId);
  await withTenant(h.db, ctx.tenantId, async (tx) => {
    await tx.insert(tenants).values({ id: ctx.tenantId, displayName: `Clinica Ficticia ${ctx.tenantId.slice(0, 8)}` });
  });
  for (let i = 1; i <= n; i++) {
    await withTenant(h.db, ctx.tenantId, (tx) =>
      recordAudit(tx, ctx, { action: 'read', scope: 'patients', metadata: { count: i } }),
    );
  }
  return ctx;
}

const verificar = (ctx: RequestContext, anchor?: ChainAnchor) =>
  withTenant(h.db, ctx.tenantId, (tx) => verifyAuditChain(tx, ctx.tenantId, anchor ? { anchor } : {}));

const problemas = async (ctx: RequestContext, anchor?: ChainAnchor) =>
  (await verificar(ctx, anchor)).problems.map((p) => `${p.kind}@${p.seq}`);

/** Adulteração privilegiada: dono da tabela, sem RLS forçado e sem o trigger append-only. */
async function adulterar(comando: (tx: postgres.TransactionSql) => Promise<unknown>): Promise<void> {
  await owner.begin(async (tx) => {
    await tx`alter table audit_log no force row level security`;
    await tx`alter table audit_log disable trigger audit_log_no_update_delete`;
    await comando(tx);
    await tx`alter table audit_log enable trigger audit_log_no_update_delete`;
    await tx`alter table audit_log force row level security`;
  });
}

async function errorText(p: Promise<unknown>): Promise<string> {
  const err: unknown = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, 'era esperado erro').toBeDefined();
  let text = '';
  for (let e: unknown = err; e instanceof Error; e = e.cause) text += ` ${e.message}`;
  return text;
}

beforeAll(() => {
  h = createDatabase(url, { max: 6 });
  owner = postgres(migratorUrl, { max: 1, onnotice: () => undefined });
});

afterAll(async () => {
  await h?.close();
  await owner?.end({ timeout: 5 });
});

describe('cadeia de auditoria (0005)', () => {
  it('cada linha nova recebe seq, prev_hash e hash; cadeia íntegra verifica', async () => {
    const ctx = await novaClinica(5);
    const linhas = await withTenant(h.db, ctx.tenantId, (tx) =>
      tx.execute<{ seq: string; prev_hash: string; hash: string }>(
        sql`select seq::text as seq, prev_hash, hash from audit_log where tenant_id = ${ctx.tenantId} order by seq`,
      ),
    );
    expect(linhas.map((l) => l.seq)).toEqual(['1', '2', '3', '4', '5']);
    expect(linhas[0]?.prev_hash).toBe(GENESIS_HASH);
    for (let i = 1; i < linhas.length; i++) expect(linhas[i]?.prev_hash).toBe(linhas[i - 1]?.hash);
    const relatorio = await verificar(ctx);
    expect(relatorio).toMatchObject({ ok: true, checked: 5, legacy: 0 });
    const head = await withTenant(h.db, ctx.tenantId, (tx) => auditChainHead(tx, ctx.tenantId));
    expect(head).toEqual(relatorio.head);
  });

  it('sem corrida: 30 transações concorrentes da mesma clínica formam uma cadeia contínua', async () => {
    const ctx = await novaClinica();
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        withTenant(h.db, ctx.tenantId, (tx) =>
          recordAudit(tx, ctx, { action: 'create', scope: 'patients', metadata: { count: i } }),
        ),
      ),
    );
    expect(await verificar(ctx)).toMatchObject({ ok: true, checked: 30, head: { seq: 30 } });
  });

  it('rollback não deixa buraco: o elo só existe se a transação confirmar', async () => {
    const ctx = await novaClinica(2);
    await withTenant(h.db, ctx.tenantId, async (tx) => {
      await recordAudit(tx, ctx, { action: 'read', scope: 'patients' });
      throw new Error('desfaz');
    }).catch(() => undefined);
    await withTenant(h.db, ctx.tenantId, (tx) => recordAudit(tx, ctx, { action: 'read', scope: 'patients' }));
    expect(await verificar(ctx)).toMatchObject({ ok: true, checked: 3 });
  });

  it('clínicas têm cadeias independentes e uma não vê a da outra', async () => {
    const a = await novaClinica(3);
    const b = await novaClinica(2);
    expect(await verificar(a)).toMatchObject({ ok: true, checked: 3 });
    expect(await verificar(b)).toMatchObject({ ok: true, checked: 2 });
    const cadeiaDeAVistaPorB = await withTenant(h.db, b.tenantId, (tx) => verifyAuditChain(tx, a.tenantId));
    expect(cadeiaDeAVistaPorB.checked).toBe(0);
  });

  it('o runtime não define os elos nem grava na cadeia de outra clínica', async () => {
    const a = await novaClinica(1);
    const b = await novaClinica(1);
    const forjado = await errorText(
      withTenant(h.db, a.tenantId, (tx) =>
        tx.execute(sql`insert into audit_log (tenant_id, actor_id, action, scope, seq, prev_hash, hash)
          values (${a.tenantId}, ${a.userId}, 'read', 'patients', 99, ${GENESIS_HASH}, ${GENESIS_HASH})`),
      ),
    );
    expect(forjado).toMatch(/definidos pelo banco/);
    const outra = await errorText(
      withTenant(h.db, a.tenantId, (tx) => recordAudit(tx, { ...a, tenantId: b.tenantId }, { action: 'read', scope: 'x' })),
    );
    expect(outra).toMatch(/row-level security/);
    expect(await verificar(b)).toMatchObject({ ok: true, checked: 1 });
  });
});

describe('adulteração privilegiada é detectada', () => {
  it('ADULTERAR metadados de uma linha', async () => {
    const ctx = await novaClinica(5);
    await adulterar(
      (tx) => tx`update audit_log set metadata = '{"count": 999}' where tenant_id = ${ctx.tenantId} and seq = 2`,
    );
    expect(await problemas(ctx)).toEqual(['hash_mismatch@2']);
  });

  it('adulterar a ação, o autor ou a data também', async () => {
    const ctx = await novaClinica(5);
    await adulterar(async (tx) => {
      await tx`update audit_log set action = 'export' where tenant_id = ${ctx.tenantId} and seq = 1`;
      await tx`update audit_log set actor_id = gen_random_uuid() where tenant_id = ${ctx.tenantId} and seq = 3`;
      await tx`update audit_log set created_at = created_at - interval '1 day' where tenant_id = ${ctx.tenantId} and seq = 5`;
    });
    expect(await problemas(ctx)).toEqual(['hash_mismatch@1', 'hash_mismatch@3', 'hash_mismatch@5']);
  });

  it('adulterar e recalcular o hash da linha quebra o elo da seguinte', async () => {
    const ctx = await novaClinica(5);
    await adulterar(async (tx) => {
      await tx`update audit_log set scope = 'tenant.full_export' where tenant_id = ${ctx.tenantId} and seq = 3`;
      await tx`update audit_log a set hash = encode(sha256(convert_to(audit_log_canonical(a), 'UTF8')), 'hex')
               where tenant_id = ${ctx.tenantId} and seq = 3`;
    });
    expect(await problemas(ctx)).toEqual(['broken_link@4']);
  });

  it('APAGAR uma linha do meio', async () => {
    const ctx = await novaClinica(5);
    await adulterar((tx) => tx`delete from audit_log where tenant_id = ${ctx.tenantId} and seq = 3`);
    expect(await problemas(ctx)).toEqual(['gap@4', 'broken_link@4']);
  });

  it('REORDENAR (trocar a posição de duas linhas)', async () => {
    const ctx = await novaClinica(5);
    await adulterar(async (tx) => {
      await tx`update audit_log set seq = 1000 where tenant_id = ${ctx.tenantId} and seq = 2`;
      await tx`update audit_log set seq = 2 where tenant_id = ${ctx.tenantId} and seq = 3`;
      await tx`update audit_log set seq = 3 where tenant_id = ${ctx.tenantId} and seq = 1000`;
    });
    const p = await problemas(ctx);
    expect(p).toContain('hash_mismatch@2');
    expect(p).toContain('hash_mismatch@3');
  });

  it('apagar o FIM só aparece contra a âncora publicada fora do banco', async () => {
    const ctx = await novaClinica(5);
    const ancora = await withTenant(h.db, ctx.tenantId, (tx) => auditChainHead(tx, ctx.tenantId));
    if (!ancora) throw new Error('setup');
    await adulterar((tx) => tx`delete from audit_log where tenant_id = ${ctx.tenantId} and seq >= 4`);
    expect(await problemas(ctx)).toEqual([]); // limite documentado da cadeia sem âncora
    expect(await problemas(ctx, ancora)).toEqual(['truncated@5']);
  });
});

describe('contrato do metadata (ressalva R1 do Guardião)', () => {
  it('o banco recusa dado pessoal no metadata mesmo sem passar pela API', async () => {
    const ctx = await novaClinica();
    const msg = await errorText(
      withTenant(h.db, ctx.tenantId, (tx) =>
        tx.execute(sql`insert into audit_log (tenant_id, actor_id, action, scope, metadata)
          values (${ctx.tenantId}, ${ctx.userId}, 'update', 'patients', '{"antes": "123.456.789-09"}'::jsonb)`),
      ),
    );
    expect(msg).toMatch(/audit_log_metadata_contract_check/);
    await expect(
      withTenant(h.db, ctx.tenantId, (tx) =>
        recordAudit(tx, ctx, { action: 'update', scope: 'patients', metadata: { x: 'fulano@exemplo.com' } }),
      ),
    ).rejects.toBeInstanceOf(AuditMetadataRejectedError);
    expect(await verificar(ctx)).toMatchObject({ ok: true, checked: 0 });
  });

  it('regra do banco e regra da aplicação concordam em todos os casos', async () => {
    const casos = [...METADATA_ACEITO, ...METADATA_RECUSADO];
    const banco = await h.db.execute<{ ok: boolean }>(sql`
      select audit_metadata_ok(c.m) as ok
      from jsonb_array_elements(${JSON.stringify(casos)}::jsonb) with ordinality as c(m, i)
      order by c.i`);
    const app = casos.map((m) => {
      try {
        assertAuditMetadata(m);
        return true;
      } catch {
        return false;
      }
    });
    expect(banco.map((r) => r.ok)).toEqual(app);
    expect(app.filter(Boolean)).toHaveLength(METADATA_ACEITO.length);
  });
});

describe('isolamento da transação e data (ORDEM-005: B4 e sugestões)', () => {
  it('B4: fora de READ COMMITTED a gravação é recusada com erro claro (não duplicate key)', async () => {
    const ctx = await novaClinica(1);
    const msg = await errorText(
      h.db.transaction(
        async (tx) => {
          await tx.execute(sql`select app_set_tenant(${ctx.tenantId}::uuid)`);
          await recordAudit(tx, ctx, { action: 'read', scope: 'patients' });
        },
        { isolationLevel: 'repeatable read' },
      ),
    );
    expect(msg).toMatch(/exige transação READ COMMITTED/);
    expect(msg).not.toMatch(/duplicate key/);
    expect(await verificar(ctx)).toMatchObject({ ok: true, checked: 1 });
  });

  it('a data entra no hash e vem do banco, não de quem grava', async () => {
    const ctx = await novaClinica();
    await withTenant(h.db, ctx.tenantId, (tx) =>
      tx.execute(sql`insert into audit_log (tenant_id, actor_id, action, scope, created_at)
        values (${ctx.tenantId}, ${ctx.userId}, 'read', 'patients', '2001-01-01T00:00:00Z')`),
    );
    const linhas = await withTenant(h.db, ctx.tenantId, (tx) =>
      tx.execute<{ antiga: boolean }>(
        sql`select created_at < now() - interval '1 day' as antiga from audit_log where tenant_id = ${ctx.tenantId}`,
      ),
    );
    expect(linhas.map((l) => l.antiga)).toEqual([false]);
    expect(await verificar(ctx)).toMatchObject({ ok: true, checked: 1 });
  });
});

describe('enum de ações × CHECK do banco (0006)', () => {
  it('o CHECK de audit_log.action aceita exatamente os valores de AuditAction', async () => {
    const [row] = await owner<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conname = 'audit_log_action_check' and conrelid = 'audit_log'::regclass and convalidated`;
    expect(row, 'audit_log_action_check validada').toBeDefined();
    const doBanco = [...(row?.def ?? '').matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]).sort();
    expect(doBanco).toEqual(Object.values(AuditAction).sort());
  });

  it('as ações novas entram na cadeia; ação fora do enum é recusada', async () => {
    const ctx = await novaClinica();
    for (const action of [
      AuditAction.KeyProvision,
      AuditAction.KeyRotate,
      AuditAction.KeyDestroy,
      AuditAction.AiUse,
      AuditAction.AiRefusal,
      AuditAction.BreakGlass,
      AuditAction.AnomalyAlert,
    ]) {
      await withTenant(h.db, ctx.tenantId, (tx) => recordAudit(tx, ctx, { action, scope: 'teste.acoes', metadata: {} }));
    }
    expect(await verificar(ctx)).toMatchObject({ ok: true, checked: 7 });
    const msg = await errorText(
      withTenant(h.db, ctx.tenantId, (tx) =>
        tx.execute(sql`insert into audit_log (tenant_id, actor_id, action, scope)
          values (${ctx.tenantId}, ${ctx.userId}, 'apagar_tudo', 'teste.acoes')`),
      ),
    );
    expect(msg).toMatch(/audit_log_action_check/);
  });
});
