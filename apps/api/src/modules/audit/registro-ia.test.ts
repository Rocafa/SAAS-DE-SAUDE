import type { RequestContext, TenantId, UserId } from '@plataforma/shared';
import { describe, expect, it } from 'vitest';
import { criarAuditoriaFalsa } from '../../../test/apoio-auditoria-ia';
import { AiDeniedError, AiService, AiUnavailableError, type AiGenerateInput } from '../ai/ai.service';
import { FakeLlmProvider } from '../ai/providers/fake-llm.provider';
import { SYSTEM_ACTOR_ID } from './audit-log';
import { DECISOES_IA, FalhaAuditoriaIaError } from './registro-ia';

const ctx: RequestContext = {
  tenantId: '11111111-1111-4111-8111-111111111111' as TenantId,
  userId: '22222222-2222-4222-8222-222222222222' as UserId,
  roles: ['profissional'],
};
const patientId = '33333333-3333-4333-8333-333333333333';
const professionalId = '44444444-4444-4444-8444-444444444444';
const agora = () => new Date('2026-10-10T12:00:00.000Z');
const input: AiGenerateInput = {
  ctx,
  task: 'escriba',
  niche: 'fisio_to',
  sensitivity: 'sensivel',
  tenantPolicy: { aiEnabled: true, allowsInternationalTransfer: false },
  patientConsent: 'informado_nao_recusou',
  patientId,
  professionalId,
  system: 'Você é um assistente de documentação. Prompt sintético v1.',
  input: 'Paciente Ficticio 000.000.000-00: transcrição sintética.',
};

function servico(
  provider: FakeLlmProvider,
  opcoes: Parameters<typeof criarAuditoriaFalsa>[1] = {},
) {
  const banco = criarAuditoriaFalsa(ctx, { agora, monotonico: () => 125, ...opcoes });
  return { ...banco, service: new AiService([provider], banco.auditoria) };
}

describe('registro obrigatório de IA', () => {
  it('grava todos os metadados da chamada real, sem nome, CPF, prompt ou saída em claro', async () => {
    const provider = new FakeLlmProvider({ version: '1.2.3' });
    const { service, linhas } = servico(provider, { monotonico: (() => {
      const valores = [100, 125];
      return () => valores.shift() ?? 125;
    })() });
    const draft = await service.generate(input);

    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({
      tenantId: ctx.tenantId,
      actorId: ctx.userId,
      actorKind: 'usuario_clinica',
      action: 'ai_use',
      scope: 'ai_generation',
      metadata: {
        use_id: draft.auditId,
        task: 'escriba',
        model: 'fake/fake-llm',
        model_version: '1.2.3',
        patient_id: patientId,
        professional_id: professionalId,
        prompt_hash: 'a62696e51ba8eca166ff8d7a8fb79267d7728a6b4ffe0cdbe7c77c8470daec1d',
        output_hash: 'a236c37b3f04ea276e19da4cf1515c56c4ca93d64df9987e8a9ada2802e3d771',
        input_tokens: 29,
        cached_input_tokens: 15,
        output_tokens: 7,
        latency_ms: 25,
        human_reviewed: false,
        decision: 'pendente',
      },
    });
    expect(draft.provenance.generatedAt).toBe('2026-10-10T12:00:00.000Z');
    const trilha = JSON.stringify(linhas);
    expect(trilha).not.toContain('Paciente Ficticio');
    expect(trilha).not.toContain('000.000.000-00');
    expect(trilha).not.toContain('transcrição sintética');
    expect(trilha).not.toContain('"fake":true');
  });

  it('não devolve rascunho quando o INSERT da auditoria falha', async () => {
    const provider = new FakeLlmProvider();
    const { service, linhas } = servico(provider, { falharInsert: true });
    await expect(service.generate(input)).rejects.toBeInstanceOf(FalhaAuditoriaIaError);
    expect(provider.calls).toBe(1);
    expect(linhas).toHaveLength(0);
  });

  it('não devolve rascunho quando o COMMIT da auditoria falha', async () => {
    const provider = new FakeLlmProvider();
    const { service } = servico(provider, { falharCommit: true });
    await expect(service.generate(input)).rejects.toBeInstanceOf(FalhaAuditoriaIaError);
  });

  it('registra tentativa falha sem inventar saída ou tokens', async () => {
    const provider = new FakeLlmProvider({ failWith: new Error('503') });
    const { service, linhas } = servico(provider);
    await expect(service.generate(input)).rejects.toBeInstanceOf(AiUnavailableError);
    expect(linhas[0]?.metadata).toMatchObject({
      output_hash: null,
      input_tokens: null,
      cached_input_tokens: null,
      output_tokens: null,
      human_reviewed: false,
      decision: 'nao_aplicavel',
    });
  });

  it('recusa política sem chamar modelo e grava ai_refusal sem hashes de conteúdo', async () => {
    const provider = new FakeLlmProvider();
    const { service, linhas } = servico(provider);
    await expect(service.generate({ ...input, patientConsent: 'recusou' })).rejects.toBeInstanceOf(AiDeniedError);
    expect(provider.calls).toBe(0);
    expect(linhas[0]).toMatchObject({ action: 'ai_refusal', scope: 'ai_refusal' });
    expect(linhas[0]?.metadata).toMatchObject({ task: 'escriba', reason: 'paciente_recusou_ia' });
    expect(linhas[0]?.metadata).not.toHaveProperty('prompt_hash');
    expect(linhas[0]?.metadata).not.toHaveProperty('output_hash');
  });
});

describe('revisão humana append-only', () => {
  it.each(DECISOES_IA)('grava decisão %s ligada ao uso original', async (decisao) => {
    const { service, auditoria, linhas } = servico(new FakeLlmProvider());
    const draft = await service.generate(input);
    await auditoria.registrarRevisao(ctx, {
      useId: draft.auditId,
      task: input.task,
      patientId,
      professionalId,
      decisao,
      ...(decisao === 'editada' ? { textoFinal: 'Texto final fictício editado.' } : {}),
    });
    expect(linhas).toHaveLength(2);
    expect(linhas[1]).toMatchObject({ action: 'ai_use', scope: 'ai_review', actorId: ctx.userId });
    expect(linhas[1]?.metadata).toMatchObject({
      use_id: draft.auditId,
      reviewer_id: ctx.userId,
      human_reviewed: true,
      decision: decisao,
      ...(decisao === 'editada'
        ? { final_output_hash: '442501b64102d9cd94169fa1568811b21221004361b8428c2f409e2bb3945556' }
        : {}),
    });
  });

  it('edição sem texto final falha e não grava', async () => {
    const { service, auditoria, linhas } = servico(new FakeLlmProvider());
    const draft = await service.generate(input);
    await expect(
      auditoria.registrarRevisao(ctx, { useId: draft.auditId, task: input.task, decisao: 'editada' }),
    ).rejects.toThrow();
    expect(linhas).toHaveLength(1);
  });

  it('sentinela de sistema não conta como revisor humano', async () => {
    const { service, auditoria, linhas } = servico(new FakeLlmProvider());
    const draft = await service.generate(input);
    await expect(
      auditoria.registrarRevisao({ ...ctx, userId: SYSTEM_ACTOR_ID }, { useId: draft.auditId, task: input.task, decisao: 'aceita' }),
    ).rejects.toThrow();
    expect(linhas).toHaveLength(1);
  });
});
