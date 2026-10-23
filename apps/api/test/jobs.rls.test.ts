/**
 * Agendador de jobs (rodada 20; api-dominio.md §14, migração 0043) contra Postgres REAL (RLS):
 * - o job roda em cada clínica SÓ dentro dela (withTenant + sentinela de sistema): a sonda dentro do job vê
 *   apenas a própria clínica, e a trilha `jobs` (ator `sistema`) fica na clínica certa;
 * - os jobs reais do registro rodam por clínica e deixam trilha; falha numa clínica vira trilha `erro` só nela,
 *   com código e sem mensagem;
 * - `app_job_tenants()` lista as clínicas só fora de contexto (dentro de withTenant: 42501) e o runtime não lê
 *   o índice interno.
 * Agendador em memória (NODE_ENV=test): o disparo é manual. Redis real: test/security/agendador-redis.security.test.ts.
 * Pré-requisitos: migrações aplicadas e DATABASE_URL = papel app_user. Dados 100% fictícios.
 */
import type { TenantId } from '@plataforma/shared';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog } from '../src/db/schema';
import { USUARIO_SISTEMA, withTenant } from '../src/db/tenant-transaction';
import type { DefinicaoDeJob } from '../src/modules/jobs/agendador.port';
import { JobsService } from '../src/modules/jobs/jobs.module';
import { modoDosJobs } from '../src/modules/jobs/estado-dos-jobs';
import { ClinicasDoAgendador } from '../src/modules/tenancy/tenancy.module';
import { subirApi, type ApiDeTeste } from './apoio-api';

let api: ApiDeTeste;
let jobs: JobsService;
let clinicaA: TenantId;
let clinicaB: TenantId;

async function trilhaDosJobs(t: TenantId, job: string) {
  return withTenant(api.db.db, t, (tx) =>
    tx
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.scope, 'jobs'), sql`${auditLog.metadata}->>'job' = ${job}`)),
  );
}

beforeAll(async () => {
  api = await subirApi();
  jobs = api.app.get(JobsService);
  clinicaA = await api.novaClinica();
  clinicaB = await api.novaClinica();
});

afterAll(async () => {
  await api?.fechar();
});

describe('agendador em teste', () => {
  it('sobe em memória (nada dispara sozinho) com o registro inteiro', () => {
    expect(jobs.modo).toBe('memoria');
    expect(modoDosJobs()).toBe('memoria');
    expect(jobs.jobs.map((j) => j.nome)).toEqual([
      'whatsapp-lembretes',
      'whatsapp-retencao',
      'portal-representacoes',
      'importador-expurgo',
      'notas-privadas-ciclo',
      'retencao-fiscal',
      'responsaveis-descarte',
    ]);
  });
});

describe('lista de clínicas (0043)', () => {
  it('app_job_tenants() traz as clínicas novas (gatilho em tenants), só ids', async () => {
    const lista = await api.app.get(ClinicasDoAgendador).listar();
    expect(lista).toEqual(expect.arrayContaining([clinicaA, clinicaB]));
    expect(lista.every((t) => /^[0-9a-f-]{36}$/.test(t))).toBe(true);
  });

  it('dentro de contexto de clínica, app_job_tenants() recusa (42501): o domínio não descobre outras clínicas', async () => {
    await expect(withTenant(api.db.db, clinicaA, (tx) => tx.execute(sql`select * from app_job_tenants()`))).rejects.toMatchObject({
      cause: expect.objectContaining({ code: '42501' }) as unknown,
    });
  });

  it('o runtime não lê o índice interno nem com contexto', async () => {
    await expect(api.db.db.execute(sql`select * from job_tenant_index`)).rejects.toMatchObject({ cause: expect.objectContaining({ code: '42501' }) as unknown });
    await expect(withTenant(api.db.db, clinicaA, (tx) => tx.execute(sql`select * from job_tenant_index`))).rejects.toMatchObject({
      cause: expect.objectContaining({ code: '42501' }) as unknown,
    });
  });
});

describe('job por clínica, com RLS e trilha', () => {
  it('a sonda dentro do job só enxerga a clínica da vez; a trilha `sistema` fica em cada clínica, nunca na outra', async () => {
    const vistos: Array<{ t: TenantId; tenants: string[]; usuario: string | null; trilhaDaOutra: number }> = [];
    const sonda: DefinicaoDeJob = {
      nome: 'sonda-rls',
      periodicidade: { cron: '0 3 * * *', descricao: 'teste' },
      prazoMaximoMs: 26 * 3_600_000,
      travaMs: 60_000,
      critico: true,
      trilha: 'sempre',
      porClinica: (t) =>
        withTenant(api.db.db, t, async (tx) => {
          const tenants = (await tx.execute<{ id: string }>(sql`select id from tenants`)).map((r) => r.id);
          const [u] = await tx.execute<{ u: string | null }>(sql`select app_current_user()::text as u`);
          const outra = t === clinicaA ? clinicaB : clinicaA;
          const [n] = await tx.execute<{ n: number }>(sql`select count(*)::int as n from audit_log where tenant_id = ${outra}::uuid`);
          vistos.push({ t, tenants, usuario: u?.u ?? null, trilhaDaOutra: Number(n?.n ?? 0) });
          return { visiveis: tenants.length };
        }),
    };
    const executor = jobs.novoExecutor({ jobs: [sonda], listarClinicas: () => Promise.resolve([clinicaA, clinicaB]) });
    expect(await executor.executar('sonda-rls')).toEqual({ job: 'sonda-rls', situacao: 'ok', clinicas: 2, clinicasComFalha: 0 });
    // Cada passada só vê a própria clínica; o slot do usuário é o sentinela (app_current_user() = NULL).
    expect(vistos).toEqual([
      { t: clinicaA, tenants: [clinicaA], usuario: null, trilhaDaOutra: 0 },
      { t: clinicaB, tenants: [clinicaB], usuario: null, trilhaDaOutra: 0 },
    ]);
    for (const t of [clinicaA, clinicaB]) {
      const linhas = await trilhaDosJobs(t, 'sonda-rls');
      expect(linhas).toHaveLength(1);
      expect(linhas[0]).toMatchObject({ tenantId: t, actorKind: 'sistema', actorId: USUARIO_SISTEMA, action: 'update' });
      expect(linhas[0]?.metadata).toEqual({ op: 'job_run', job: 'sonda-rls', status: 'ok', tentativas: 1, visiveis: 1 });
    }
  });

  it('os jobs reais do registro rodam por clínica (idempotentes) e deixam trilha `sistema` em cada uma', async () => {
    const executor = jobs.novoExecutor({ jobs: jobs.jobs, listarClinicas: () => Promise.resolve([clinicaA, clinicaB]) });
    for (let rodada = 1; rodada <= 2; rodada++) {
      for (const j of jobs.jobs) expect((await executor.executar(j.nome)).situacao, `${j.nome} (rodada ${rodada})`).toBe('ok');
    }
    for (const t of [clinicaA, clinicaB]) {
      for (const j of jobs.jobs) {
        const linhas = await trilhaDosJobs(t, j.nome);
        // Lembretes com o canal desligado = só zeros: trilha `com_efeito` não grava (o envio já audita).
        expect(linhas, j.nome).toHaveLength(j.trilha === 'sempre' ? 2 : 0);
        for (const l of linhas) {
          expect(l).toMatchObject({ actorKind: 'sistema', actorId: USUARIO_SISTEMA });
          expect((l.metadata as Record<string, unknown>).status).toBe('ok');
        }
      }
    }
    const importador = await trilhaDosJobs(clinicaA, 'importador-expurgo');
    expect(importador[0]?.metadata).toMatchObject({ arquivosDescartados: 0, atrasados: 0, alarme: false });
  });

  it('falha numa clínica: trilha `erro` só nela, com código e sem mensagem; a outra segue ok', async () => {
    const quebra: DefinicaoDeJob = {
      nome: 'sonda-falha',
      periodicidade: { cron: '0 3 * * *', descricao: 'teste' },
      prazoMaximoMs: 26 * 3_600_000,
      travaMs: 60_000,
      critico: true,
      trilha: 'sempre',
      // Na clínica A, tenta trocar o usuário travado pelo sentinela (0019: 42501) — a mensagem do banco não pode sair.
      porClinica: (t) =>
        withTenant(api.db.db, t, async (tx) => {
          if (t === clinicaA) await tx.execute(sql`select app_set_user(gen_random_uuid())`);
          return { ok: 1 };
        }),
    };
    const executor = jobs.novoExecutor({ jobs: [quebra], listarClinicas: () => Promise.resolve([clinicaA, clinicaB]), backoffMs: 1 });
    await expect(executor.executar('sonda-falha')).rejects.toMatchObject({ name: 'FalhaDeJobError', clinicasComFalha: 1 });
    const [emA] = await trilhaDosJobs(clinicaA, 'sonda-falha');
    expect(emA?.metadata).toEqual({ op: 'job_run', job: 'sonda-falha', status: 'erro', tentativas: 3, erro: expect.stringMatching(/^pg_[0-9A-Z]{5}$/) as unknown });
    const [emB] = await trilhaDosJobs(clinicaB, 'sonda-falha');
    expect(emB?.metadata).toMatchObject({ status: 'ok', ok: 1 });
  });
});
