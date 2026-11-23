/**
 * Revisão humana do uso de IA contra Postgres REAL (veto do Guardião no #227, bloqueantes 1 e 2):
 * a geração é lida por `use_id` sob RLS na clínica da sessão; tarefa, paciente e profissional são
 * herdados dela; só o responsável revisa, uma vez só (inclusive em corrida); uso de outra clínica é
 * invisível (404). Os hashes da trilha são HMAC da clínica, com `hash_key_id`.
 * Pré-requisitos: migrações aplicadas e DATABASE_URL (app_user). Dados fictícios.
 */
import type { RequestContext, TenantId, UserId } from '@plataforma/shared';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, tenants } from '../src/db/schema';
import { createDatabase, withTenant, type DatabaseHandle } from '../src/db/tenant-transaction';
import { ConflitoError, NaoEncontradoError, ProibidoError } from '../src/common/erros-dominio';
import { AiService, type AiGenerateInput } from '../src/modules/ai/ai.service';
import { FakeLlmProvider } from '../src/modules/ai/providers/fake-llm.provider';
import { CHAVE_LOCAL_DO_MAC } from '../src/modules/audit/ator-suporte';
import { AuditoriaIaService } from '../src/modules/audit/registro-ia';
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
  const pedido: AiGenerateInput = {
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
  return (await ai.generate(pedido)).auditId;
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
    const geracao = linhas.find((l) => l.scope === 'ai_generation');
    const revisao = linhas.find((l) => l.scope === 'ai_review');
    expect(geracao?.metadata).toMatchObject({ hash_key_id: CHAVE_LOCAL_DO_MAC, decision: 'pendente' });
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
    expect((await linhasDoUso(b, useIdDeB)).map((l) => l.scope)).toEqual(['ai_generation']);
  });

  it('revisor diferente do responsável: 403', async () => {
    const clinica = await novaClinica();
    const useId = await gerar(profissional(clinica));
    await expect(auditoria.registrarRevisao(profissional(clinica), { useId, decisao: 'aceita' })).rejects.toBeInstanceOf(ProibidoError);
    expect((await linhasDoUso(clinica, useId)).map((l) => l.scope)).toEqual(['ai_generation']);
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
