/**
 * GARANTIA DE SAÍDA contra Postgres REAL (papel app_user, RLS FORCE). Roda em `test:rls` no CI.
 * Dados 100% fictícios, gerados a cada execução.
 */
import type { RequestContext, TenantId, UserId } from '@plataforma/shared';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, patients, tenants, type SubscriptionStatus } from '../src/db/schema';
import { createDatabase, withTenant, type DatabaseHandle } from '../src/db/tenant-transaction';
import { recordAudit } from '../src/modules/audit/audit-log';
import { ExitWindowClosedError, SubscriptionWriteBlockedError } from '../src/modules/exports/access-policy';
import { EXPORT_AUDIT_SCOPE, EXPORT_SCHEMA_VERSION, exportTenantData } from '../src/modules/exports/tenant-export';
import { createPatient, listPatients } from '../src/modules/patients/patients.repository';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL (papel app_user) é obrigatória para o teste de RLS');

const DAY = 24 * 60 * 60 * 1000;
let h: DatabaseHandle;

interface FakeTenant {
  readonly ctx: RequestContext;
  readonly patientNames: readonly string[];
}

function ctxFor(tenantId: TenantId): RequestContext {
  return { tenantId, userId: randomUUID() as UserId, roles: ['gestor'] };
}

/** Cria tenant fictício com status e N pacientes fictícios. */
async function seedTenant(
  status: SubscriptionStatus,
  nPatients: number,
  cancelledAt: Date | null = null,
): Promise<FakeTenant> {
  const tenantId = randomUUID() as TenantId;
  const tag = tenantId.slice(0, 8);
  const patientNames = Array.from({ length: nPatients }, (_, i) => `Paciente Ficticio ${tag}-${i}`);
  await withTenant(h.db, tenantId, async (tx) => {
    await tx
      .insert(tenants)
      .values({ id: tenantId, displayName: `Clinica Ficticia ${tag}`, subscriptionStatus: status, cancelledAt });
    for (const displayName of patientNames) await tx.insert(patients).values({ tenantId, displayName });
  });
  return { ctx: ctxFor(tenantId), patientNames };
}

function exportAuditRows(t: FakeTenant) {
  return withTenant(h.db, t.ctx.tenantId, (tx) =>
    tx.select().from(auditLog).where(eq(auditLog.action, 'export')),
  );
}

/** Junta mensagens da cadeia de causas (drizzle/postgres embrulham o erro original). */
/** SQLSTATE de violação de RLS. Código, não texto: independe do idioma do servidor. */
const SQLSTATE_RLS = '42501'; // insufficient_privilege

/**
 * SQLSTATEs da cadeia de causas. Use isto para violação de RLS; o `errorText` abaixo serve
 * para as asserções que comparam NOME DE CONSTRAINT, que é identificador e não traduz.
 */
async function sqlstates(p: Promise<unknown>): Promise<unknown[]> {
  const err: unknown = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, 'era esperado erro').toBeDefined();
  const codigos: unknown[] = [];
  for (let e: unknown = err; e instanceof Error; e = e.cause) codigos.push((e as { code?: unknown }).code);
  return codigos;
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

let a: FakeTenant;
let b: FakeTenant;

beforeAll(async () => {
  h = createDatabase(url, { max: 1 });
  a = await seedTenant('active', 2);
  b = await seedTenant('active', 1);
});

afterAll(async () => {
  await h?.close();
});

describe('G2 — exportação total do tenant', () => {
  it('export de A contém só pacientes de A (JSON e CSV), com manifesto versionado', async () => {
    const pkg = await exportTenantData(h.db, a.ctx);
    const { manifest, data } = pkg.json;
    expect(manifest.schemaVersion).toBe(EXPORT_SCHEMA_VERSION);
    expect(manifest.tenant.id).toBe(a.ctx.tenantId);
    expect(manifest.counts).toEqual({
      tenants: 1,
      patients: 2,
      professionals: 0,
      appointmentTypes: 0,
      appointments: 0,
      insurers: 0,
      insuranceGuides: 0,
      guideSessions: 0,
      guideSessionSignatures: 0,
      sessionPackages: 0,
      packageSessions: 0,
      clinicalSettings: 0,
      encounters: 0,
      clinicalRecordVersions: 0,
      clinicalAddenda: 0,
      privateNotes: 0,
      privateNotesWithheld: 0,
      appointmentReschedules: 0,
      legalHolds: 0,
      noteCustodies: 0,
      clinicMembers: 0,
      auditEvents: pkg.auditEvents.length,
    });
    expect(Date.parse(manifest.generatedAt)).not.toBeNaN();
    expect(data.patients.map((p) => p.displayName).sort()).toEqual([...a.patientNames].sort());

    const json = JSON.stringify(pkg.json);
    for (const nome of b.patientNames) {
      expect(json).not.toContain(nome);
      expect(pkg.patientsCsv).not.toContain(nome);
    }
    expect(json).not.toContain(b.ctx.tenantId);
    const linhas = pkg.patientsCsv.trimEnd().split('\r\n');
    expect(linhas).toHaveLength(1 + 2);
    for (const nome of a.patientNames) expect(pkg.patientsCsv).toContain(nome);
  });
});

describe('G1/G4 — status de assinatura', () => {
  it.each(['past_due', 'read_only'] as const)('%s: exporta e lê, mas escrita é recusada', async (status) => {
    const t = await seedTenant(status, 1);
    const pkg = await exportTenantData(h.db, t.ctx);
    expect(pkg.json.manifest.subscription.status).toBe(status);
    expect(pkg.json.manifest.counts.patients).toBe(1);

    const lidos = await withTenant(h.db, t.ctx.tenantId, (tx) => listPatients(tx, t.ctx));
    expect(lidos.map((p) => p.displayName)).toEqual(t.patientNames);

    await expect(
      withTenant(h.db, t.ctx.tenantId, (tx) => createPatient(tx, t.ctx, { displayName: 'Novo Ficticio' })),
    ).rejects.toBeInstanceOf(SubscriptionWriteBlockedError);
    const depois = await withTenant(h.db, t.ctx.tenantId, (tx) => tx.select().from(patients));
    expect(depois).toHaveLength(1);
  });

  it('cancelled dentro da janela: exporta e lê, escrita recusada; manifesto informa fim da janela', async () => {
    const cancelledAt = new Date(Date.now() - 10 * DAY);
    const t = await seedTenant('cancelled', 1, cancelledAt);
    const pkg = await exportTenantData(h.db, t.ctx);
    expect(pkg.json.manifest.subscription.status).toBe('cancelled');
    expect(pkg.json.manifest.subscription.exitWindowEndsAt).toBe(
      new Date(cancelledAt.getTime() + 90 * DAY).toISOString(),
    );
    const lidos = await withTenant(h.db, t.ctx.tenantId, (tx) => listPatients(tx, t.ctx));
    expect(lidos).toHaveLength(1);
    await expect(
      withTenant(h.db, t.ctx.tenantId, (tx) => createPatient(tx, t.ctx, { displayName: 'Novo Ficticio' })),
    ).rejects.toBeInstanceOf(SubscriptionWriteBlockedError);
  });

  it('cancelled após a janela: export e leitura negados, sem linha de auditoria de export', async () => {
    const t = await seedTenant('cancelled', 1, new Date(Date.now() - 91 * DAY));
    await expect(exportTenantData(h.db, t.ctx)).rejects.toBeInstanceOf(ExitWindowClosedError);
    await expect(withTenant(h.db, t.ctx.tenantId, (tx) => listPatients(tx, t.ctx))).rejects.toBeInstanceOf(
      ExitWindowClosedError,
    );
    expect(await exportAuditRows(t)).toHaveLength(0);
  });

  it('active: escrita permitida e auditada', async () => {
    const t = await seedTenant('active', 0);
    await withTenant(h.db, t.ctx.tenantId, (tx) => createPatient(tx, t.ctx, { displayName: 'Novo Ficticio' }));
    const rows = await withTenant(h.db, t.ctx.tenantId, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.action, 'create')),
    );
    expect(rows).toHaveLength(1);
  });

  it('banco recusa cancelled sem cancelled_at e status fora da lista', async () => {
    const t = await seedTenant('active', 0);
    expect(
      await errorText(
        withTenant(h.db, t.ctx.tenantId, (tx) =>
          tx.update(tenants).set({ subscriptionStatus: 'cancelled' }).where(eq(tenants.id, t.ctx.tenantId)),
        ),
      ),
    ).toMatch(/tenants_cancelled_at_check/);
    expect(
      await errorText(
        withTenant(h.db, t.ctx.tenantId, (tx) =>
          tx.execute(sql`update tenants set subscription_status = 'free_forever' where id = ${t.ctx.tenantId}`),
        ),
      ),
    ).toMatch(/tenants_subscription_status_check/);
  });
});

describe('G3 — auditoria append-only da exportação', () => {
  it('cada export cria exatamente 1 linha de auditoria, sem conteúdo clínico', async () => {
    const t = await seedTenant('active', 3);
    expect(await exportAuditRows(t)).toHaveLength(0);
    await exportTenantData(h.db, t.ctx);
    const rows = await exportAuditRows(t);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.actorId).toBe(t.ctx.userId);
    expect(row?.tenantId).toBe(t.ctx.tenantId);
    expect(row?.scope).toBe(EXPORT_AUDIT_SCOPE);
    expect(row?.metadata).toEqual({
      schemaVersion: EXPORT_SCHEMA_VERSION,
      formats: 'json+csv+jsonl',
      subscriptionStatus: 'active',
      tenants: 1,
      patients: 3,
      professionals: 0,
      appointmentTypes: 0,
      appointments: 0,
      guides: 0,
      packages: 0,
      encounters: 0,
      recordVersions: 0,
      privateNotes: 0,
      privateNotesWithheld: 0,
      appointmentReschedules: 0,
      auditEvents: 0,
    });
    const serial = JSON.stringify(row);
    for (const nome of t.patientNames) expect(serial).not.toContain(nome);
    expect(serial).not.toContain('Ficticio');
  });

  it('app_user não consegue UPDATE nem DELETE em audit_log', async () => {
    await exportTenantData(h.db, a.ctx);
    // SQLSTATE, não mensagem: "permission denied" vem traduzido num servidor pt-BR.
    const upd = await sqlstates(
      withTenant(h.db, a.ctx.tenantId, (tx) => tx.update(auditLog).set({ scope: 'adulterado' })),
    );
    expect(upd, `UPDATE: SQLSTATE esperado ${SQLSTATE_RLS}`).toContain(SQLSTATE_RLS);
    const del = await sqlstates(withTenant(h.db, a.ctx.tenantId, (tx) => tx.delete(auditLog)));
    expect(del, `DELETE: SQLSTATE esperado ${SQLSTATE_RLS}`).toContain(SQLSTATE_RLS);
    const trunc = await sqlstates(withTenant(h.db, a.ctx.tenantId, (tx) => tx.execute(sql`truncate audit_log`)));
    expect(trunc, `TRUNCATE: SQLSTATE esperado ${SQLSTATE_RLS}`).toContain(SQLSTATE_RLS);
    expect((await exportAuditRows(a)).length).toBeGreaterThan(0);
  });

  it('tenant A não vê auditoria de B e não grava auditoria em nome de B', async () => {
    await exportTenantData(h.db, b.ctx);
    const vistosPorA = await withTenant(h.db, a.ctx.tenantId, (tx) => tx.select().from(auditLog));
    expect(vistosPorA.length).toBeGreaterThan(0);
    expect(vistosPorA.every((r) => r.tenantId === a.ctx.tenantId)).toBe(true);
    const deB = await withTenant(h.db, a.ctx.tenantId, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.tenantId, b.ctx.tenantId)),
    );
    expect(deB).toEqual([]);

    const intruso = await sqlstates(
      withTenant(h.db, a.ctx.tenantId, (tx) =>
        recordAudit(tx, { ...a.ctx, tenantId: b.ctx.tenantId }, { action: 'export', scope: 'teste' }),
      ),
    );
    expect(intruso, `SQLSTATE esperado ${SQLSTATE_RLS}`).toContain(SQLSTATE_RLS);
  });
});
