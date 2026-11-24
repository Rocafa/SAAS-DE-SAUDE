/**
 * Revisão humana do uso de IA contra Postgres REAL (veto do Guardião no #227, bloqueantes 1 e 2):
 * a geração é lida por `use_id` sob RLS na clínica da sessão; tarefa, paciente e profissional são
 * herdados dela; só o responsável revisa, uma vez só (inclusive em corrida); uso de outra clínica é
 * invisível (404). Os hashes da trilha são HMAC da clínica, com `hash_key_id`. Item 3: tentativa e
 * resultado em transações curtas, com a chamada ao modelo fora delas (pool de 1 conexão não trava).
 * Pré-requisitos: migrações aplicadas e DATABASE_URL (app_user). Dados fictícios.
 */
import type { RequestContext, TenantId, UserId } from '@plataforma/shared';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, tenants } from '../src/db/schema';
import { createDatabase, withTenant, type DatabaseHandle } from '../src/db/tenant-transaction';
import { ConflitoError, NaoEncontradoError, ProibidoError } from '../src/common/erros-dominio';
import { AiService, type AiGenerateInput } from '../src/modules/ai/ai.service';
import type { LlmProvider } from '../src/modules/ai/llm-provider';
import { FakeLlmProvider } from '../src/modules/ai/providers/fake-llm.provider';
import { CHAVE_LOCAL_DO_MAC } from '../src/modules/audit/ator-suporte';
import { juntarEventosIa } from '../src/modules/audit/consulta-ia';
import { AuditoriaIaService, FalhaAuditoriaIaError } from '../src/modules/audit/registro-ia';
import { TenantDatabase } from '../src/modules/tenancy/tenancy.module';
import { signerDeTeste } from './apoio-auditoria-ia';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL é obrigatória para este teste');

let h: DatabaseHandle;
let auditoria: AuditoriaIaService;
let ai: AiService;

async function novaClinica(): Promise<TenantId> {
  const id = randomUUID() as TenantId;
  await withTenant(h.db, id, async (tx) => {
    await tx.insert(tenants).values({ id, displayName: `Clinica Ficticia ${id.slice(0, 8)}` });
  });
  return id;
}

const profissional = (tenantId: TenantId, userId: string = randomUUID()): RequestContext => ({
  tenantId,
  userId: userId as UserId,
  roles: ['profissional'],
});

async function gerar(ctx: RequestContext): Promise<string> {
  return (await ai.generate(pedido(ctx))).auditId;
}

function pedido(ctx: RequestContext): AiGenerateInput {
  return {
    ctx,
    task: 'escriba',
    niche: 'fisio_to',
    sensitivity: 'sensivel',
    tenantPolicy: { aiEnabled: true, allowsInternationalTransfer: false },
    patientConsent: 'informado_nao_recusou',
    patientId: randomUUID(),
    professionalId: ctx.userId,
    system: 'Prompt sintético de teste v1.',
    input: 'Transcrição sintética, sem dado real.',
  };
}

const linhasDoUso = (tenantId: TenantId, useId: string) =>
  withTenant(h.db, tenantId, async (tx) =>
    (await tx.select().from(auditLog).where(eq(auditLog.tenantId, tenantId))).filter(
      (l) => (l.metadata as Record<string, unknown>)['use_id'] === useId,
    ),
  );

beforeAll(() => {
  h = createDatabase(url, { max: 6 });
  auditoria = new AuditoriaIaService(new TenantDatabase(h), signerDeTeste());
  ai = new AiService([new FakeLlmProvider()], auditoria);
});

afterAll(async () => {
  await h?.close();
});

describe('revisão de uso de IA sob RLS', () => {
  it('caminho feliz: herda da geração e grava HMAC com hash_key_id; geração também', async () => {
    const clinica = await novaClinica();
    const ctx = profissional(clinica);
    const useId = await gerar(ctx);
    await auditoria.registrarRevisao(ctx, { useId, decisao: 'editada', textoFinal: 'Texto final fictício.' });
    const linhas = await linhasDoUso(clinica, useId);
    const geracao = linhas.find((l) => l.scope === 'ai_attempt');
    const resultado = linhas.find((l) => l.scope === 'ai_result');
    const revisao = linhas.find((l) => l.scope === 'ai_review');
    expect(geracao?.metadata).toMatchObject({ hash_key_id: CHAVE_LOCAL_DO_MAC });
    expect(resultado?.metadata).toMatchObject({ status: 'sucesso', hash_key_id: CHAVE_LOCAL_DO_MAC, decision: 'pendente' });
    const g = geracao?.metadata as Record<string, unknown>;
    expect(revisao?.metadata).toMatchObject({
      use_id: useId,
      task: 'escriba',
      patient_id: g['patient_id'],
      professional_id: ctx.userId,
      reviewer_id: ctx.userId,
      decision: 'editada',
      final_output_hash: (await signerDeTeste().macDeConteudo(clinica, 'ia_saida_final', 'Texto final fictício.')).mac,
      hash_key_id: CHAVE_LOCAL_DO_MAC,
    });
  });

  it('uso inexistente: 404', async () => {
    const ctx = profissional(await novaClinica());
    await expect(auditoria.registrarRevisao(ctx, { useId: randomUUID(), decisao: 'aceita' })).rejects.toBeInstanceOf(NaoEncontradoError);
  });

  it('uso de outra clínica: invisível pelo RLS (404), mesmo com o mesmo usuário', async () => {
    const a = await novaClinica();
    const b = await novaClinica();
    const userId = randomUUID();
    const useIdDeB = await gerar(profissional(b, userId));
    await expect(auditoria.registrarRevisao(profissional(a, userId), { useId: useIdDeB, decisao: 'aceita' })).rejects.toBeInstanceOf(
      NaoEncontradoError,
    );
    expect(await linhasDoUso(a, useIdDeB)).toHaveLength(0);
    expect((await linhasDoUso(b, useIdDeB)).map((l) => l.scope).sort()).toEqual(['ai_attempt', 'ai_result']);
  });

  it('revisor diferente do responsável: 403', async () => {
    const clinica = await novaClinica();
    const useId = await gerar(profissional(clinica));
    await expect(auditoria.registrarRevisao(profissional(clinica), { useId, decisao: 'aceita' })).rejects.toBeInstanceOf(ProibidoError);
    expect((await linhasDoUso(clinica, useId)).map((l) => l.scope).sort()).toEqual(['ai_attempt', 'ai_result']);
  });

  it('revisão duplicada: 409, inclusive com duas revisões em corrida (só uma grava)', async () => {
    const clinica = await novaClinica();
    const ctx = profissional(clinica);
    const useId = await gerar(ctx);
    const resultados = await Promise.allSettled([
      auditoria.registrarRevisao(ctx, { useId, decisao: 'aceita' }),
      auditoria.registrarRevisao(ctx, { useId, decisao: 'rejeitada' }),
    ]);
    expect(resultados.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const falha = resultados.find((r) => r.status === 'rejected');
    expect(falha?.status === 'rejected' ? falha.reason : null).toBeInstanceOf(ConflitoError);
    await expect(auditoria.registrarRevisao(ctx, { useId, decisao: 'aceita' })).rejects.toBeInstanceOf(ConflitoError);
    const revisoes = await withTenant(h.db, clinica, (tx) =>
      tx.select().from(auditLog).where(and(eq(auditLog.tenantId, clinica), eq(auditLog.scope, 'ai_review'))),
    );
    expect(revisoes).toHaveLength(1);
  });
});

describe('item 3 do veto: tentativa e resultado em transações curtas, chamada fora delas', () => {
  it('pool de 1 conexão: outra consulta termina enquanto o provedor responde (nenhuma conexão presa)', async () => {
    const pool1 = createDatabase(url, { max: 1 });
    try {
      const servico = new AuditoriaIaService(new TenantDatabase(pool1), signerDeTeste());
      const clinica = await novaClinica();
      const fake = new FakeLlmProvider();
      let concorrenteTerminou = false;
      const lento: LlmProvider = {
        id: fake.id,
        residency: fake.residency,
        model: fake.model,
        tasks: fake.tasks,
        generate: async (request, signal) => {
          // Se a tentativa ainda segurasse a única conexão do pool, esta consulta ficaria na fila até o prazo.
          let timer: NodeJS.Timeout | undefined;
          try {
            await Promise.race([
              withTenant(pool1.db, clinica, (tx) => tx.execute(sql`select 1`)),
              new Promise((_, rejeitar) => {
                timer = setTimeout(() => rejeitar(new Error('conexão presa durante a chamada ao modelo')), 5_000);
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
          concorrenteTerminou = true;
          return fake.generate(request, signal);
        },
      };
      const draft = await new AiService([lento], servico).generate(pedido(profissional(clinica)));
      expect(concorrenteTerminou).toBe(true);
      const escopos = (await linhasDoUso(clinica, draft.auditId)).map((l) => l.scope).sort();
      expect(escopos).toEqual(['ai_attempt', 'ai_result']);
    } finally {
      await pool1.close();
    }
  });

  it('provedor falha e o resultado não grava: a tentativa fica no banco e a consulta a mostra como sem_resultado', async () => {
    const clinica = await novaClinica();
    const ctx = profissional(clinica);
    const real = new TenantDatabase(h);
    let chamadas = 0;
    // Só a 1ª transação (tentativa) passa; a do resultado cai, como numa queda do banco depois do envio.
    const instavel = {
      run: (tenantId: TenantId, fn: Parameters<TenantDatabase['run']>[1], userId?: string): Promise<unknown> =>
        ++chamadas === 1 ? real.run(tenantId, fn, userId) : Promise.reject(new Error('banco fora depois do envio')),
    } as unknown as TenantDatabase;
    const servico = new AuditoriaIaService(instavel, signerDeTeste());
    const provider = new FakeLlmProvider({ failWith: new Error('503') });
    await expect(new AiService([provider], servico).generate(pedido(ctx))).rejects.toBeInstanceOf(FalhaAuditoriaIaError);
    expect(provider.calls).toBe(1);
    const eventos = await withTenant(h.db, clinica, (tx) =>
      tx.select().from(auditLog).where(and(eq(auditLog.tenantId, clinica), inArray(auditLog.scope, ['ai_attempt', 'ai_result']))),
    );
    expect(eventos.map((e) => e.scope)).toEqual(['ai_attempt']);
    const [linha] = juntarEventosIa(
      eventos.map((e) => ({ id: e.id, createdAt: e.createdAt, actorId: e.actorId, scope: e.scope, metadata: e.metadata })),
    );
    expect(linha).toMatchObject({ status: 'sem_resultado', saidaHash: null });
  });
});
