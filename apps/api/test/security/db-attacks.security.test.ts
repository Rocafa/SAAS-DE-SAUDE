/**
 * SUÍTE OFENSIVA — BANCO. O atacante tem execução de SQL como `app_user` (papel de runtime:
 * NOBYPASSRLS, não dono). Cada teste TENTA burlar o isolamento entre tenants ou a trilha de
 * auditoria e prova que falha (erro do Postgres) ou que o payload é tratado como dado.
 *
 * Exige Postgres real com as migrações aplicadas (mesmo esquema do `test:rls`).
 * Dados 100% fictícios, gerados a cada execução. Ver docs/04-arquitetura/testes-de-seguranca.md.
 */
import type { RequestContext, TenantId, UserId } from '@plataforma/shared';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, patients, tenants } from '../../src/db/schema';
import { createDatabase, withTenant, type DatabaseHandle } from '../../src/db/tenant-transaction';
import { exportTenantData } from '../../src/modules/exports/tenant-export';
import { createPatient, listPatients } from '../../src/modules/patients/patients.repository';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL (papel app_user) é obrigatória para a suíte de segurança');

let h: DatabaseHandle;
/** Conexão "crua" do atacante, fora de withTenant (mesmo papel app_user). */
let raw: postgres.Sql;

interface FakeTenant {
  readonly ctx: RequestContext;
  readonly names: readonly string[];
}

function ctxFor(tenantId: TenantId): RequestContext {
  return { tenantId, userId: randomUUID() as UserId, roles: ['gestor'] };
}

async function seedTenant(nPatients: number): Promise<FakeTenant> {
  const tenantId = randomUUID() as TenantId;
  const tag = tenantId.slice(0, 8);
  const names = Array.from({ length: nPatients }, (_, i) => `Paciente Ficticio Sec ${tag}-${i}`);
  await withTenant(h.db, tenantId, async (tx) => {
    await tx.insert(tenants).values({ id: tenantId, displayName: `Clinica Ficticia Sec ${tag}` });
    for (const displayName of names) await tx.insert(patients).values({ tenantId, displayName });
  });
  return { ctx: ctxFor(tenantId), names };
}

/** Mensagens da cadeia de causas (drizzle/postgres embrulham o erro original). */
async function errorText(p: Promise<unknown>): Promise<string> {
  const err: unknown = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, 'o ataque deveria ter falhado com erro').toBeDefined();
  let text = '';
  for (let e: unknown = err; e instanceof Error; e = e.cause) text += ` ${e.message}`;
  return text;
}

/** Executa `stmt` numa conexão crua (fora de withTenant) e devolve o erro. */
function rawError(stmt: string): Promise<string> {
  return errorText(raw.unsafe(stmt));
}

/** Nomes de pacientes visíveis numa leitura sem filtro explícito (só o RLS protege). */
function namesIn(rows: readonly { display_name?: unknown; displayName?: unknown }[]): string[] {
  return rows.map((r) => String(r.display_name ?? r.displayName));
}

let a: FakeTenant;
let b: FakeTenant;

beforeAll(async () => {
  h = createDatabase(url, { max: 2 });
  raw = postgres(url, { max: 1, onnotice: () => undefined });
  a = await seedTenant(2);
  b = await seedTenant(2);
});

afterAll(async () => {
  await raw?.end({ timeout: 5 });
  await h?.close();
});

describe('troca de contexto de tenant', () => {
  it('set_config para B no meio da transação de A não expõe B', async () => {
    const vistos = await withTenant(h.db, a.ctx.tenantId, async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${b.ctx.tenantId}, true)`);
      return tx.execute<{ display_name: string }>(sql`select display_name from patients`);
    }).catch(() => [] as { display_name: string }[]);
    for (const nome of b.names) expect(namesIn(vistos)).not.toContain(nome);
  });

  it('SET LOCAL para B no meio da transação de A não expõe B', async () => {
    const vistos = await withTenant(h.db, a.ctx.tenantId, async (tx) => {
      await tx.execute(sql.raw(`set local app.tenant_id = '${b.ctx.tenantId}'`));
      return tx.execute<{ display_name: string }>(sql`select display_name from patients`);
    }).catch(() => [] as { display_name: string }[]);
    for (const nome of b.names) expect(namesIn(vistos)).not.toContain(nome);
  });

  it('chamar app_set_tenant(B) dentro da transação de A é recusado', async () => {
    const msg = await errorText(
      withTenant(h.db, a.ctx.tenantId, async (tx) => {
        await tx.execute(sql`select app_set_tenant(${b.ctx.tenantId}::uuid)`);
        return tx.execute(sql`select display_name from patients`);
      }),
    );
    expect(msg).toMatch(/já definido nesta transação/);
  });

  it('nem via savepoint (transação aninhada) dá para trocar para B', async () => {
    const msg = await errorText(
      withTenant(h.db, a.ctx.tenantId, (tx) =>
        tx.transaction((sp) => sp.execute(sql`select app_set_tenant(${b.ctx.tenantId}::uuid)`)),
      ),
    );
    expect(msg).toMatch(/já definido nesta transação/);
  });

  it('RESET do contexto dentro de withTenant(A) não abre a tabela inteira', async () => {
    const vistos = await withTenant(h.db, a.ctx.tenantId, async (tx) => {
      await tx.execute(sql`reset app.tenant_id`);
      return tx.execute<{ display_name: string }>(sql`select display_name from patients`);
    });
    for (const nome of b.names) expect(namesIn(vistos)).not.toContain(nome);
  });

  it('SET SESSION app.tenant_id = B fora de withTenant não expõe B', async () => {
    await raw.unsafe(`set session app.tenant_id = '${b.ctx.tenantId}'`);
    const vistos = await raw.unsafe<{ display_name: string }[]>('select display_name from patients');
    await raw.unsafe('reset app.tenant_id');
    expect(vistos).toHaveLength(0);
  });

  it('BEGIN + SET LOCAL manual (sem withTenant) não expõe B', async () => {
    const vistos = await raw.begin(async (t) => {
      await t.unsafe(`set local app.tenant_id = '${b.ctx.tenantId}'`);
      return t.unsafe<{ display_name: string }[]>('select display_name from patients');
    });
    expect(vistos).toHaveLength(0);
  });

  it('RESET ALL / sem contexto: nenhuma linha de nenhum tenant', async () => {
    await raw.unsafe('reset all');
    expect(await raw.unsafe('select 1 from patients')).toHaveLength(0);
    expect(await raw.unsafe('select 1 from tenants')).toHaveLength(0);
    expect(await raw.unsafe('select 1 from audit_log')).toHaveLength(0);
  });

  it('a tabela de contexto travado é inacessível ao runtime', async () => {
    expect(await rawError('select * from tenant_context')).toMatch(/permission denied/);
    expect(
      await rawError(`insert into tenant_context (xid, tenant_id) values (txid_current(), '${b.ctx.tenantId}')`),
    ).toMatch(/permission denied/);
    expect(await rawError('delete from tenant_context')).toMatch(/permission denied/);
  });
});

describe('escalada de privilégio e DDL', () => {
  it.each(['app_migrator', 'postgres'])('SET ROLE %s é negado', async (role) => {
    expect(await rawError(`set role ${role}`)).toMatch(/permission denied/);
  });

  it('SET SESSION AUTHORIZATION e ALTER ROLE BYPASSRLS são negados', async () => {
    expect(await rawError('set session authorization postgres')).toMatch(/permission denied/);
    expect(await rawError('alter role app_user bypassrls')).toMatch(/permission denied/);
    expect(await rawError('create role atacante login superuser')).toMatch(/permission denied/);
  });

  it.each([
    'alter table patients disable row level security',
    'alter table patients no force row level security',
    'alter table audit_log disable row level security',
    'alter table audit_log disable trigger audit_log_no_update_delete',
    'drop policy tenant_isolation on patients',
    'alter policy tenant_isolation on patients using (true)',
    'create policy abre_tudo on patients using (true)',
    'drop table patients',
    'alter function app_current_tenant() owner to app_user',
  ])('"%s" é negado (não é dono)', async (stmt) => {
    expect(await rawError(stmt)).toMatch(/must be owner|permission denied/);
  });

  it.each([
    'create table public.exfil (x text)',
    'create function public.app_current_tenant_fake() returns uuid language sql as $$ select null::uuid $$',
    'create or replace function public.app_current_tenant() returns uuid language sql as $$ select null::uuid $$',
    'create schema atacante',
  ])('"%s" é negado', async (stmt) => {
    expect(await rawError(stmt)).toMatch(/permission denied|must be owner/);
  });

  it('tabela TEMP que sombreia "patients" na conexão do pool é negada', async () => {
    // Sem isto, um atacante criaria pg_temp.patients numa conexão do pool e capturaria inserts
    // de outros tenants que reutilizassem a conexão (pg_temp vem antes de public no search_path).
    expect(await rawError('create temp table patients (display_name text)')).toMatch(/permission denied/);
    expect(
      await rawError('create function pg_temp.f() returns int language sql as $$ select 1 $$'),
    ).toMatch(/permission denied/);
  });

  it('leitura de hashes de senha (pg_authid/pg_shadow) é negada', async () => {
    expect(await rawError('select rolpassword from pg_authid')).toMatch(/permission denied/);
    expect(await rawError('select passwd from pg_shadow')).toMatch(/permission denied/);
  });

  it('leitura/escrita de arquivos do servidor é negada', async () => {
    expect(await rawError("select pg_read_file('postgresql.conf')")).toMatch(/permission denied/);
    expect(await rawError("copy (select 1) to 'exfil.csv'")).toMatch(/permission denied|must be superuser/);
    expect(await rawError("copy (select 1) to program 'echo x'")).toMatch(/permission denied|must be superuser/);
  });

  it('schema_migrations não é legível pelo runtime', async () => {
    expect(await rawError('select * from schema_migrations')).toMatch(/permission denied/);
  });
});

describe('auditoria append-only', () => {
  beforeAll(async () => {
    await exportTenantData(h.db, a.ctx);
  });

  it.each([
    "update audit_log set scope = 'adulterado'",
    'delete from audit_log',
    'truncate audit_log',
  ])('"%s" é negado mesmo com contexto do próprio tenant', async (stmt) => {
    const msg = await errorText(withTenant(h.db, a.ctx.tenantId, (tx) => tx.execute(sql.raw(stmt))));
    expect(msg).toMatch(/permission denied/);
  });

  it('A não insere auditoria em nome de B', async () => {
    const msg = await errorText(
      withTenant(h.db, a.ctx.tenantId, (tx) =>
        tx.insert(auditLog).values({
          tenantId: b.ctx.tenantId,
          actorId: a.ctx.userId,
          action: 'export',
          scope: 'tenant.full_export',
        }),
      ),
    );
    expect(msg).toMatch(/row-level security/);
    const deB = await withTenant(h.db, b.ctx.tenantId, (tx) =>
      tx.select().from(auditLog).where(eq(auditLog.actorId, a.ctx.userId)),
    );
    expect(deB).toHaveLength(0);
  });

  it('A não lê, não altera e não insere pacientes de B (UPDATE/DELETE/INSERT cruzados)', async () => {
    await withTenant(h.db, a.ctx.tenantId, async (tx) => {
      const upd = await tx
        .update(patients)
        .set({ displayName: 'sequestrado' })
        .where(eq(patients.tenantId, b.ctx.tenantId))
        .returning({ id: patients.id });
      expect(upd).toHaveLength(0);
    });
    // DELETE nem chega ao RLS: o runtime não tem o privilégio em patients (0009, retenção).
    const del = await errorText(
      withTenant(h.db, a.ctx.tenantId, (tx) => tx.delete(patients).where(eq(patients.tenantId, b.ctx.tenantId))),
    );
    expect(del).toMatch(/permission denied|permissão negada/);
    const ins = await errorText(
      withTenant(h.db, a.ctx.tenantId, (tx) =>
        tx.insert(patients).values({ tenantId: b.ctx.tenantId, displayName: 'Intruso Ficticio' }),
      ),
    );
    expect(ins).toMatch(/row-level security/);
    const deB = await withTenant(h.db, b.ctx.tenantId, (tx) => tx.select().from(patients));
    expect(deB.map((p) => p.displayName).sort()).toEqual([...b.names].sort());
  });
});

const SQLI_PAYLOADS = [
  "' OR 1=1 --",
  "'; DROP TABLE patients; --",
  "x' UNION SELECT display_name FROM patients --",
  `${'00000000-0000-4000-8000-000000000001'}' OR '1'='1`,
  "'); SELECT set_config('app.tenant_id', NULL, false); --",
  '\\x27 OR 1=1',
  '\uFF2F\uFF07 \uFF2F\uFF32 \uFF11\uFF1D\uFF11', // fullwidth
  '\u202Eevil', // RTL override
];

describe('SQL injection via funções públicas', () => {
  it.each(SQLI_PAYLOADS)('tenantId malicioso %j é recusado antes de abrir transação', async (payload) => {
    const ctx = { ...a.ctx, tenantId: payload as TenantId };
    await expect(withTenant(h.db, ctx.tenantId, () => Promise.resolve(1))).rejects.toThrow('tenant_id inválido');
    await expect(exportTenantData(h.db, ctx)).rejects.toThrow('tenant_id inválido');
  });

  it('UUID válido com sufixo de payload (quebra de linha) é recusado', async () => {
    const payload = `${b.ctx.tenantId}\n' OR 1=1 --` as TenantId;
    await expect(withTenant(h.db, payload, () => Promise.resolve(1))).rejects.toThrow('tenant_id inválido');
  });

  it('payloads em campos de texto são gravados e lidos como DADO, e não afetam B', async () => {
    const t = await seedTenant(0);
    const textuais = SQLI_PAYLOADS.filter((p) => !p.includes('\u0000'));
    for (const displayName of textuais) {
      await withTenant(h.db, t.ctx.tenantId, (tx) => createPatient(tx, t.ctx, { displayName }));
    }
    const lidos = await withTenant(h.db, t.ctx.tenantId, (tx) => listPatients(tx, t.ctx));
    expect(lidos.map((p) => p.displayName).sort()).toEqual([...textuais].sort());
    // A tabela continua lá e B intacto.
    const deB = await withTenant(h.db, b.ctx.tenantId, (tx) => tx.select().from(patients));
    expect(deB).toHaveLength(b.names.length);
    // Exportação devolve os payloads literalmente no JSON.
    const pkg = await exportTenantData(h.db, t.ctx);
    expect(pkg.json.data.patients.map((p) => p.displayName).sort()).toEqual([...textuais].sort());
    for (const nome of b.names) expect(pkg.patientsCsv).not.toContain(nome);
  });

  it('byte nulo em texto é recusado pelo banco e nada é gravado', async () => {
    const t = await seedTenant(0);
    const msg = await errorText(
      withTenant(h.db, t.ctx.tenantId, (tx) => createPatient(tx, t.ctx, { displayName: "Nulo\u0000' OR 1=1 --" })),
    );
    expect(msg).toMatch(/0x00|null character|invalid byte sequence/i);
    const lidos = await withTenant(h.db, t.ctx.tenantId, (tx) => tx.select().from(patients));
    expect(lidos).toHaveLength(0);
  });

  it('userId (actor_id) malicioso não injeta: o banco recusa como UUID inválido', async () => {
    const ctx = { ...a.ctx, userId: "' OR 1=1 --" as UserId };
    const msg = await errorText(withTenant(h.db, a.ctx.tenantId, (tx) => listPatients(tx, ctx)));
    expect(msg).toMatch(/invalid input syntax for type uuid/);
  });
});

describe('CSV injection na exportação', () => {
  const formulas = [
    '=HYPERLINK("http://exemplo.invalid","clique")',
    "=cmd|' /C calc'!A0",
    '+SOMA(1;1)',
    '-2+3',
    '@SUM(1,1)',
    '\t=1+1',
    '\r=1+1',
    ' =1+1',
    '\n=1+1',
    '\uFF1D1+1', // sinal de igual fullwidth
  ];

  it('valores que viram fórmula em planilha saem neutralizados (apóstrofo) no pacientes.csv', async () => {
    const t = await seedTenant(0);
    for (const displayName of formulas) {
      await withTenant(h.db, t.ctx.tenantId, (tx) => createPatient(tx, t.ctx, { displayName }));
    }
    const pkg = await exportTenantData(h.db, t.ctx);
    const linhas = pkg.patientsCsv.replace(/^\uFEFF/, '');
    for (const f of formulas) {
      const campo = `"'${f.replaceAll('"', '""')}"`;
      expect(linhas, `não neutralizou ${JSON.stringify(f)}`).toContain(campo);
    }
    // O JSON (formato canônico) mantém o valor original, sem alteração.
    expect(pkg.json.data.patients.map((p) => p.displayName).sort()).toEqual([...formulas].sort());
  });
});
