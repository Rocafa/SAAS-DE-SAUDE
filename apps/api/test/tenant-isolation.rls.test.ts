/**
 * Isolamento entre tenants contra Postgres REAL (RLS FORCE + papel sem BYPASSRLS).
 * Pré-requisitos: migração aplicada (pnpm db:migrate) e DATABASE_URL = papel app_user.
 * Dados 100% fictícios, gerados a cada execução.
 */
import type { TenantId } from '@plataforma/shared';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { patients, tenants } from '../src/db/schema';
import { createDatabase, withTenant, type DatabaseHandle } from '../src/db/tenant-transaction';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL (papel app_user) é obrigatória para o teste de RLS');

const tenantA = randomUUID() as TenantId;
const tenantB = randomUUID() as TenantId;
const patientA = randomUUID();
const patientB = randomUUID();

let h: DatabaseHandle;

/** SQLSTATE de violação de RLS. É código, não texto: não muda com o idioma do servidor. */
const SQLSTATE_RLS = '42501'; // insufficient_privilege

/**
 * Postgres embrulha o erro; procuramos o SQLSTATE na cadeia de causas.
 * Comparar a MENSAGEM quebraria num servidor que não fala inglês (ex.: lc_messages = pt_BR).
 */
async function expectRlsViolation(p: Promise<unknown>): Promise<void> {
  const err: unknown = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, 'era esperada violação de RLS').toBeDefined();
  const codigos: unknown[] = [];
  for (let e: unknown = err; e instanceof Error; e = e.cause) codigos.push((e as { code?: unknown }).code);
  expect(codigos, `SQLSTATE esperado ${SQLSTATE_RLS}; erro: ${String(err)}`).toContain(SQLSTATE_RLS);
}

beforeAll(async () => {
  // max: 1 força reuso da MESMA conexão entre transações (prova que o contexto não vaza no pool).
  h = createDatabase(url, { max: 1 });
  for (const [tenantId, patientId, nome] of [
    [tenantA, patientA, 'Paciente Ficticio A'],
    [tenantB, patientB, 'Paciente Ficticio B'],
  ] as const) {
    await withTenant(h.db, tenantId, async (tx) => {
      await tx.insert(tenants).values({ id: tenantId, displayName: `Clinica Ficticia ${tenantId.slice(0, 8)}` });
      await tx.insert(patients).values({ id: patientId, tenantId, displayName: nome });
    });
  }
});

afterAll(async () => {
  await h?.close();
});

describe('isolamento entre tenants (RLS)', () => {
  it('o papel de runtime não é superusuário nem tem BYPASSRLS', async () => {
    const rows = await h.db.execute<{ rolsuper: boolean; rolbypassrls: boolean }>(
      sql`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
    );
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('toda tabela com tenant_id tem RLS habilitado e FORÇADO', async () => {
    const rows = await h.db.execute<{ table: string; rls: boolean; force: boolean }>(sql`
      select c.relname as table, c.relrowsecurity as rls, c.relforcerowsecurity as force
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
      where n.nspname = 'public' and c.relkind in ('r', 'p')`);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => !r.rls || !r.force).map((r) => r.table)).toEqual([]);
  });

  it('com contexto A, SELECT sem filtro só retorna dados de A', async () => {
    const rows = await withTenant(h.db, tenantA, (tx) => tx.select().from(patients));
    expect(rows.map((r) => r.id)).toEqual([patientA]);
    const ts = await withTenant(h.db, tenantA, (tx) => tx.select().from(tenants));
    expect(ts.map((t) => t.id)).toEqual([tenantA]);
  });

  it('com contexto A, ler o paciente de B pelo id retorna vazio', async () => {
    const rows = await withTenant(h.db, tenantA, (tx) =>
      tx.select().from(patients).where(eq(patients.id, patientB)),
    );
    expect(rows).toEqual([]);
  });

  it('com contexto A, INSERT com tenant_id de B é bloqueado', async () => {
    await expectRlsViolation(
      withTenant(h.db, tenantA, (tx) =>
        tx.insert(patients).values({ tenantId: tenantB, displayName: 'Intruso Ficticio' }),
      ),
    );
  });

  it('com contexto A, UPDATE/DELETE no paciente de B não afeta nada', async () => {
    const updated = await withTenant(h.db, tenantA, (tx) =>
      tx.update(patients).set({ displayName: 'Alterado' }).where(eq(patients.id, patientB)).returning(),
    );
    expect(updated).toEqual([]);
    // DELETE é recusado antes do RLS: o runtime não tem o privilégio em patients (0009, retenção).
    await expectRlsViolation(
      withTenant(h.db, tenantA, (tx) => tx.delete(patients).where(eq(patients.id, patientB)).returning()),
    );
    const intacto = await withTenant(h.db, tenantB, (tx) =>
      tx.select().from(patients).where(eq(patients.id, patientB)),
    );
    expect(intacto.map((r) => r.displayName)).toEqual(['Paciente Ficticio B']);
  });

  it('com contexto A, mover paciente de A para B é bloqueado (WITH CHECK)', async () => {
    await expectRlsViolation(
      withTenant(h.db, tenantA, (tx) =>
        tx.update(patients).set({ tenantId: tenantB }).where(eq(patients.id, patientA)),
      ),
    );
  });

  it('sem contexto (mesma conexão reutilizada) nada é visível — falha fechada', async () => {
    const rows = await h.db.transaction((tx) => tx.select().from(patients));
    expect(rows).toEqual([]);
    const fora = await h.db.select().from(patients);
    expect(fora).toEqual([]);
  });
});
