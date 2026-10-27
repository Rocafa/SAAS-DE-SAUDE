/**
 * Criptografia de campo por clínica (S5) contra Postgres REAL: RLS nas tabelas de chave, privilégios
 * do runtime, corrida de provisionamento e crypto-shredding com cópia de backup.
 * Pré-requisitos: migrações aplicadas e DATABASE_URL = papel app_user. Dados 100% fictícios.
 */
import { AuditAction, type TenantId, type UserId } from '@plataforma/shared';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tenants } from '../src/db/schema';
import { recordAudit } from '../src/modules/audit/audit-log';
import { createDatabase, withTenant, type DatabaseHandle, type TenantTx } from '../src/db/tenant-transaction';
import { FieldDecryptionError, KeyUnavailableError, TenantKeysDestroyedError } from '../src/modules/crypto/crypto-errors';
import { DataKeyCache } from '../src/modules/crypto/data-key-cache';
import { PgDataKeyStore } from '../src/modules/crypto/data-key-store';
import { FieldCipher, type KeyAuditor } from '../src/modules/crypto/field-cipher';
import { auditKeyEvents } from '../src/modules/crypto/key-audit';
import type { FieldRef } from '../src/modules/crypto/field-format';
import { LocalKeyProvider } from '../src/modules/crypto/local-key-provider';
import { MemoryDataKeyStore } from '../src/modules/crypto/memory-data-key-store';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL (papel app_user) é obrigatória para o teste de RLS');

const tenantA = randomUUID() as TenantId;
const tenantB = randomUUID() as TenantId;
const TEXTO = 'Anotação clínica fictícia para teste.';
const ATOR = randomUUID();
const semAuditoria: KeyAuditor<unknown> = () => Promise.resolve();
const ref = (tenantId: TenantId): FieldRef => ({
  tenantId,
  table: 'record_entries',
  column: 'body',
  rowId: '00000000-0000-4000-8000-0000000000aa',
});

let h: DatabaseHandle;
const provider = new LocalKeyProvider({ nodeEnv: 'test' });
const store = new PgDataKeyStore();
const cipher = new FieldCipher<TenantTx>(provider, store, auditKeyEvents);

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

async function novaClinica(tenantId: TenantId): Promise<void> {
  await withTenant(h.db, tenantId, async (tx) => {
    await tx.insert(tenants).values({ id: tenantId, displayName: `Clinica Ficticia ${tenantId.slice(0, 8)}` });
  });
}

beforeAll(async () => {
  h = createDatabase(url, { max: 4 });
  for (const t of [tenantA, tenantB]) {
    await novaClinica(t);
    await withTenant(h.db, t, (tx) => cipher.provisionTenant(tx, t, ATOR));
  }
});

afterAll(async () => {
  await h?.close();
});

describe('chaves por clínica no banco (0004)', () => {
  it('tabelas de chave têm RLS forçado', async () => {
    const rows = await h.db.execute<{ relname: string; force: boolean }>(sql`
      select relname, relforcerowsecurity as force from pg_class
      where relname in ('tenant_master_keys', 'tenant_data_keys') order by relname`);
    expect(rows.map((r) => [r.relname, r.force])).toEqual([
      ['tenant_data_keys', true],
      ['tenant_master_keys', true],
    ]);
  });

  it('o banco guarda só a DEK cifrada e a referência da chave mestra', async () => {
    const rows = await withTenant(h.db, tenantA, (tx) =>
      tx.execute<{ n: number; len: number }>(
        sql`select count(*)::int as n, max(length(wrapped_key))::int as len from tenant_data_keys`,
      ),
    );
    // 60 bytes = IV 12 + tag 16 + DEK cifrada 32 (provedor local). Nunca 32 bytes "crus".
    expect(rows[0]).toEqual({ n: 1, len: 60 });
  });

  it('clínica B não vê nem usa as chaves de A', async () => {
    const valorA = await withTenant(h.db, tenantA, (tx) => cipher.encrypt(tx, ref(tenantA), TEXTO));
    const visiveis = await withTenant(h.db, tenantB, (tx) =>
      tx.execute<{ n: number }>(sql`select count(*)::int as n from tenant_data_keys where tenant_id = ${tenantA}`),
    );
    expect(visiveis[0]?.n).toBe(0);
    // Cache novo: a única porta para a DEK é o banco, que o RLS fecha.
    const semCache = new FieldCipher<TenantTx>(provider, store, auditKeyEvents, { cache: new DataKeyCache() });
    await expect(withTenant(h.db, tenantB, (tx) => semCache.decrypt(tx, ref(tenantB), valorA))).rejects.toBeInstanceOf(
      FieldDecryptionError,
    );
    expect(await withTenant(h.db, tenantA, (tx) => semCache.decryptString(tx, ref(tenantA), valorA))).toBe(TEXTO);
  });

  it('B não grava chave em nome de A', async () => {
    const msg = await errorText(
      withTenant(h.db, tenantB, (tx) =>
        tx.execute(sql`insert into tenant_master_keys (id, tenant_id) values ('local:forjada', ${tenantA})`),
      ),
    );
    expect(msg).toMatch(/row-level security/);
  });

  it('runtime não apaga chave nem altera identidade; nada volta a ser ativo', async () => {
    const del = await errorText(withTenant(h.db, tenantA, (tx) => tx.execute(sql`delete from tenant_data_keys`)));
    expect(del).toMatch(/permission denied/);
    const ident = await errorText(
      withTenant(h.db, tenantA, (tx) => tx.execute(sql`update tenant_data_keys set tenant_id = ${tenantB}`)),
    );
    expect(ident).toMatch(/permission denied/);
    const reativar = await errorText(
      withTenant(h.db, tenantA, async (tx) => {
        const antiga = await store.findActive(tx, tenantA);
        await cipher.rotateDataKey(tx, tenantA, ATOR);
        await tx.execute(sql`update tenant_data_keys set status = 'retired' where status = 'active'`);
        await tx.execute(sql`update tenant_data_keys set status = 'active' where id = ${antiga?.id ?? ''}::uuid`);
      }),
    );
    expect(reativar).toMatch(/não volta a ser ativa/);
  });

  it('provisionamento concorrente termina com uma chave mestra e uma DEK ativa', async () => {
    const c = randomUUID() as TenantId;
    await novaClinica(c);
    const cifras = [0, 1, 2].map(() => new FieldCipher<TenantTx>(provider, store, auditKeyEvents, { cache: new DataKeyCache() }));
    const ids = await Promise.all(cifras.map((cf) => withTenant(h.db, c, (tx) => cf.provisionTenant(tx, c, ATOR))));
    expect(new Set(ids).size).toBe(1);
    const n = await withTenant(h.db, c, (tx) =>
      tx.execute<{ m: number; d: number }>(sql`select
        (select count(*)::int from tenant_master_keys) as m,
        (select count(*)::int from tenant_data_keys where status = 'active') as d`),
    );
    expect(n[0]).toEqual({ m: 1, d: 1 });
  });
});

describe('crypto-shredding com cópia de backup (retencao-e-descarte §4.1)', () => {
  it('depois de destruir, nem o banco nem o backup restaurado abrem os dados de A; B segue normal', async () => {
    const valorA = await withTenant(h.db, tenantA, (tx) => cipher.encrypt(tx, ref(tenantA), TEXTO));
    const valorB = await withTenant(h.db, tenantB, (tx) => cipher.encrypt(tx, ref(tenantB), TEXTO));

    // "Backup": cópia das linhas de chave de A como estavam antes da eliminação.
    const backup = new MemoryDataKeyStore();
    await withTenant(h.db, tenantA, async (tx) => {
      const ms = await tx.execute<{ id: string; status: 'active' | 'retired' }>(
        sql`select id, status from tenant_master_keys`,
      );
      for (const m of ms) backup.masterKeys.push({ id: m.id, tenantId: tenantA, status: m.status });
      const ks = await tx.execute<{
        id: string;
        master_key_id: string;
        wrapped_key: Buffer;
        status: 'active' | 'retired';
      }>(sql`select id, master_key_id, wrapped_key, status from tenant_data_keys`);
      for (const k of ks) {
        backup.dataKeys.push({
          id: k.id,
          tenantId: tenantA,
          masterKeyId: k.master_key_id,
          wrapped: Buffer.from(k.wrapped_key),
          status: k.status,
          encryptCount: 0,
        });
      }
    });
    expect(await new FieldCipher(provider, backup, semAuditoria).decryptString(null, ref(tenantA), valorA)).toBe(TEXTO);

    await cipher.destroyTenantKeys((fn) => withTenant(h.db, tenantA, fn), tenantA, ATOR);

    await expect(withTenant(h.db, tenantA, (tx) => cipher.decrypt(tx, ref(tenantA), valorA))).rejects.toBeInstanceOf(
      KeyUnavailableError,
    );
    await expect(
      new FieldCipher(provider, backup, semAuditoria, { cache: new DataKeyCache() }).decrypt(null, ref(tenantA), valorA),
    ).rejects.toBeInstanceOf(KeyUnavailableError);
    const restante = await withTenant(h.db, tenantA, (tx) =>
      tx.execute<{ vivas: number }>(
        sql`select count(*)::int as vivas from tenant_data_keys where wrapped_key is not null or status <> 'destroyed'`,
      ),
    );
    expect(restante[0]?.vivas).toBe(0);
    // Chave destruída é terminal, também para o runtime.
    const reviver = await errorText(
      withTenant(h.db, tenantA, (tx) => tx.execute(sql`update tenant_data_keys set status = 'retired'`)),
    );
    expect(reviver).toMatch(/destruída não pode ser alterada/);
    // A destruição (e o provisionamento) ficaram na trilha de auditoria, com o ator.
    const eventos = await withTenant(h.db, tenantA, (tx) =>
      tx.execute<{ action: string; scope: string; actor_id: string }>(
        sql`select action, scope, actor_id from audit_log where scope like 'crypto.key.%' order by seq`,
      ),
    );
    // Ações próprias de chave (0006), não create/update genéricos.
    const pares = eventos.map((e) => `${e.action}:${e.scope}`);
    expect(pares).toContain('key_provision:crypto.key.provision');
    expect(pares).toContain('key_destroy:crypto.key.destroy');
    expect(eventos.find((e) => e.scope === 'crypto.key.destroy')?.actor_id).toBe(ATOR);
    expect(await withTenant(h.db, tenantB, (tx) => cipher.decryptString(tx, ref(tenantB), valorB))).toBe(TEXTO);
  });
});

describe('destruição em duas fases (B1 do revisor N1)', () => {
  it('COMMIT final falha: o banco fica em destroying, nada decifra, e a nova chamada conclui', async () => {
    const c = randomUUID() as TenantId;
    await novaClinica(c);
    await withTenant(h.db, c, (tx) => cipher.provisionTenant(tx, c, ATOR));
    const valor = await withTenant(h.db, c, (tx) => cipher.encrypt(tx, ref(c), TEXTO));
    let chamada = 0;
    const commitFalhaNaSegunda = <T>(fn: (tx: TenantTx) => Promise<T>): Promise<T> =>
      withTenant(h.db, c, async (tx) => {
        const out = await fn(tx);
        if (++chamada === 2) throw new Error('commit falhou'); // ROLLBACK da 2ª transação
        return out;
      });
    await expect(cipher.destroyTenantKeys(commitFalhaNaSegunda, c, ATOR)).rejects.toThrow('commit falhou');
    const estados = await withTenant(h.db, c, (tx) =>
      tx.execute<{ status: string }>(sql`select status from tenant_data_keys union all select status from tenant_master_keys`),
    );
    expect(estados.map((e) => e.status)).toEqual(['destroying', 'destroying']); // nunca "active"
    const semCache = new FieldCipher<TenantTx>(provider, store, auditKeyEvents, { cache: new DataKeyCache() });
    await expect(withTenant(h.db, c, (tx) => semCache.decrypt(tx, ref(c), valor))).rejects.toBeInstanceOf(
      KeyUnavailableError,
    );
    // Retomada: o provedor já tinha agendado; destruir de novo é idempotente e o banco conclui.
    await cipher.destroyTenantKeys((fn) => withTenant(h.db, c, fn), c, ATOR);
    const finais = await withTenant(h.db, c, (tx) =>
      tx.execute<{ status: string }>(sql`select status from tenant_data_keys union all select status from tenant_master_keys`),
    );
    expect(finais.map((e) => e.status)).toEqual(['destroyed', 'destroyed']);
    await expect(withTenant(h.db, c, (tx) => cipher.provisionTenant(tx, c, ATOR))).rejects.toBeInstanceOf(
      TenantKeysDestroyedError,
    );
  });

  it('a DEK só aponta para chave mestra da MESMA clínica (FK composta)', async () => {
    const outra = await withTenant(h.db, tenantB, (tx) =>
      tx.execute<{ id: string }>(sql`select id from tenant_master_keys limit 1`),
    );
    const msg = await errorText(
      withTenant(h.db, tenantA, (tx) =>
        tx.execute(sql`insert into tenant_data_keys (tenant_id, master_key_id, wrapped_key)
          values (${tenantA}, ${outra[0]?.id ?? ''}, ${Buffer.alloc(60)})`),
      ),
    );
    expect(msg).toMatch(/tenant_data_keys_master_fk|foreign key/);
  });
});

describe('ordem das travas: trilha de auditoria (0005) × chaves (0004)', () => {
  it('"auditou e depois cifrou" concorrendo com "girou a DEK" não vira deadlock', async () => {
    const tenantC = randomUUID() as TenantId;
    await novaClinica(tenantC);
    await withTenant(h.db, tenantC, (tx) => cipher.provisionTenant(tx, tenantC, ATOR));
    // Soma o contador a cada cifragem: o UPDATE da linha da DEK acontece já na primeira.
    const cifraComContador = new FieldCipher<TenantTx>(provider, store, auditKeyEvents, { usageFlushEvery: 1 });
    const ctx = { tenantId: tenantC, userId: ATOR as UserId, roles: [] };

    let auditou!: () => void;
    const auditouPromise = new Promise<void>((resolve) => (auditou = resolve));
    // A: grava na trilha (trava audit_chain), espera B entrar na disputa e então cifra.
    const a = withTenant(h.db, tenantC, async (tx) => {
      await recordAudit(tx, ctx, { action: AuditAction.Read, scope: 'teste.travas', metadata: {} });
      auditou();
      await new Promise((r) => setTimeout(r, 300));
      return cifraComContador.encrypt(tx, ref(tenantC), TEXTO);
    });
    // Se A falhar antes de auditar, o portão abre mesmo assim: o teste falha com o erro de A, sem ficar
    // pendurado até o timeout com a transação de B nunca iniciada.
    void a.finally(() => auditou()).catch(() => undefined);
    // B: gira a DEK (trava as chaves e audita). Na ordem antiga travava a linha da DEK e esperava a
    // trilha, enquanto A segurava a trilha e esperava a linha: deadlock (40P01).
    await auditouPromise;
    const b = withTenant(h.db, tenantC, (tx) => cipher.rotateDataKey(tx, tenantC, ATOR));

    const [ra, rb] = await Promise.allSettled([a, b]);
    expect([ra.status, rb.status]).toEqual(['fulfilled', 'fulfilled']);
    const cifrado = ra.status === 'fulfilled' ? ra.value : '';
    await expect(
      withTenant(h.db, tenantC, (tx) => cipher.decryptString(tx, ref(tenantC), cifrado)),
    ).resolves.toBe(TEXTO);
  });
});
