/**
 * Timeouts por conexão, rollback de withTenant (inclusive auditoria do export) e esgotamento do
 * pool — direto na camada de banco, contra Postgres real (papel app_user, RLS FORCE).
 */
import type { RequestContext, TenantId, UserId } from '@plataforma/shared';
import { randomUUID } from 'node:crypto';
import { count, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dbErrorCode, isTransientDatabaseError, PoolExhaustedError } from '../../src/db/db-errors';
import { auditLog, patients } from '../../src/db/schema';
import { createDatabase, withTenant, type DatabaseHandle } from '../../src/db/tenant-transaction';
import { exportInTransaction } from '../../src/modules/exports/tenant-export';
import { semearTenant, urlDoAmbiente } from './apoio';

let h: DatabaseHandle;
let tenant: TenantId;
let ctx: RequestContext;

async function contagens(): Promise<{ pacientes: number; auditoria: number }> {
  return withTenant(h.db, tenant, async (tx) => {
    const [p] = await tx.select({ n: count() }).from(patients);
    const [a] = await tx.select({ n: count() }).from(auditLog).where(eq(auditLog.action, 'export'));
    return { pacientes: p?.n ?? -1, auditoria: a?.n ?? -1 };
  });
}

async function erroDe(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error('era esperado erro');
    },
    (e: unknown) => e,
  );
}

beforeAll(async () => {
  tenant = await semearTenant(2);
  ctx = { tenantId: tenant, userId: randomUUID() as UserId, roles: ['gestor'] };
  h = createDatabase(urlDoAmbiente(), {
    max: 2,
    statementTimeoutMs: 400,
    idleInTransactionTimeoutMs: 400,
    acquireTimeoutMs: 300,
  });
});

afterAll(async () => {
  await h?.close();
});

describe('timeouts por conexão', () => {
  it('statement_timeout e idle_in_transaction_session_timeout valem em toda conexão do pool', async () => {
    const rows = await withTenant(h.db, tenant, (tx) =>
      tx.execute<{ st: string; it: string; app: string }>(
        sql`select current_setting('statement_timeout') as st,
                   current_setting('idle_in_transaction_session_timeout') as it,
                   current_setting('application_name') as app`,
      ),
    );
    expect([...rows][0]).toEqual({ st: '400ms', it: '400ms', app: 'plataforma-api' });
  });

  it('query lenta acima do statement_timeout é CANCELADA pelo Postgres (57014), rápido', async () => {
    const inicio = Date.now();
    const err = await erroDe(withTenant(h.db, tenant, (tx) => tx.execute(sql`select pg_sleep(5)`)));
    expect(Date.now() - inicio).toBeLessThan(2_000);
    expect(dbErrorCode(err)).toBe('57014');
    expect(isTransientDatabaseError(err)).toBe(true);
  });

  it('escrita em banco somente leitura (failover) dá 25006, classificado como transitório (503)', async () => {
    // No failover, conexões antigas podem cair num nó que virou somente leitura. Simulamos com
    // SET TRANSACTION READ ONLY: o Postgres recusa a escrita com o mesmo SQLSTATE 25006.
    const err = await erroDe(
      withTenant(h.db, tenant, async (tx) => {
        await tx.execute(sql`set transaction read only`);
        // Escrita que não muda nada (o runtime não tem DELETE em patients desde a 0009).
        await tx.execute(sql`update patients set display_name = display_name where false`);
      }),
    );
    expect(dbErrorCode(err)).toBe('25006');
    expect(isTransientDatabaseError(err)).toBe(true);
    expect((await contagens()).pacientes).toBe(2);
  });

  it('transação esquecida aberta é encerrada pelo Postgres, sem crash, e o pool se recupera', async () => {
    // Regressão do bug do postgres.js 3.4.9 (patches/postgres@3.4.9.patch): escrever numa conexão
    // reservada já encerrada pelo servidor lançava TypeError NÃO capturado (derruba o processo) e
    // deixava a conexão sem reconectar (CONNECT_TIMEOUT eterno). Vitest falha com erro não tratado.
    for (const ociosoMs of [700, 800, 900, 950]) {
      const err = await erroDe(
        withTenant(h.db, tenant, async (tx) => {
          await tx.execute(sql`select 1`);
          await new Promise((r) => setTimeout(r, ociosoMs)); // ocioso dentro da transação
          await tx.execute(sql`select 1`);
        }),
      );
      expect(isTransientDatabaseError(err)).toBe(true);
      // a próxima transação funciona (no máximo 1 erro transitório residual da conexão morta)
      const proxima = await contagens().catch(() => contagens());
      expect(proxima.pacientes).toBe(2);
    }
  });
});

describe('rollback de withTenant (nada parcial gravado)', () => {
  it('erro da aplicação depois do INSERT e da auditoria do export => rollback total', async () => {
    const antes = await contagens();
    const err = await erroDe(
      withTenant(h.db, tenant, async (tx) => {
        await tx.insert(patients).values({ tenantId: tenant, displayName: 'Paciente Ficticio Rollback' });
        await exportInTransaction(tx, ctx); // grava audit_log 'export' nesta transação
        throw new Error('falha simulada após gravar');
      }),
    );
    expect((err as Error).message).toBe('falha simulada após gravar');
    expect(await contagens()).toEqual(antes);
  });

  it('erro do BANCO (statement_timeout) depois da auditoria do export => rollback total', async () => {
    const antes = await contagens();
    const err = await erroDe(
      withTenant(h.db, tenant, async (tx) => {
        await tx.insert(patients).values({ tenantId: tenant, displayName: 'Paciente Ficticio Timeout' });
        await exportInTransaction(tx, ctx);
        await tx.execute(sql`select pg_sleep(5)`);
      }),
    );
    expect(dbErrorCode(err)).toBe('57014');
    expect(await contagens()).toEqual(antes);
  });

  it('caminho feliz grava export + auditoria (controle do teste)', async () => {
    const antes = await contagens();
    await withTenant(h.db, tenant, (tx) => exportInTransaction(tx, ctx));
    expect(await contagens()).toEqual({ ...antes, auditoria: antes.auditoria + 1 });
  });
});

describe('esgotamento do pool', () => {
  it('sem vaga => PoolExhaustedError em ~acquireTimeout (não trava) e depois normaliza', async () => {
    const lento = createDatabase(urlDoAmbiente(), { max: 2, statementTimeoutMs: 5_000, acquireTimeoutMs: 300 });
    try {
      const segurando = [1, 2].map(() =>
        withTenant(lento.db, tenant, (tx) => tx.execute(sql`select pg_sleep(1.2)`)),
      );
      await new Promise((r) => setTimeout(r, 100));
      const inicio = Date.now();
      const err = await erroDe(withTenant(lento.db, tenant, (tx) => tx.execute(sql`select 1`)));
      const ms = Date.now() - inicio;
      expect(err).toBeInstanceOf(PoolExhaustedError);
      expect(isTransientDatabaseError(err)).toBe(true);
      expect(ms).toBeGreaterThanOrEqual(250);
      expect(ms).toBeLessThan(1_000);
      await Promise.all(segurando);
      await withTenant(lento.db, tenant, (tx) => tx.execute(sql`select 1`));
    } finally {
      await lento.close();
    }
  });

  it('transação além do prazo do cliente => TRANSACTION_TIMEOUT e ROLLBACK (não grava depois)', async () => {
    const curto = createDatabase(urlDoAmbiente(), { max: 1, statementTimeoutMs: 5_000, transactionTimeoutMs: 300 });
    try {
      const antes = await contagens();
      const err = await erroDe(
        withTenant(curto.db, tenant, async (tx) => {
          await tx.execute(sql`select pg_sleep(0.8)`); // passa do prazo de 300 ms
          await tx.insert(patients).values({ tenantId: tenant, displayName: 'Paciente Ficticio Atrasado' });
        }),
      );
      expect(dbErrorCode(err)).toBe('TRANSACTION_TIMEOUT');
      await new Promise((r) => setTimeout(r, 1_000)); // deixa a transação "atrasada" terminar
      expect(await contagens()).toEqual(antes);
      // a vaga foi devolvida quando a transação real terminou
      await withTenant(curto.db, tenant, (tx) => tx.execute(sql`select 1`));
    } finally {
      await curto.close();
    }
  });
});
