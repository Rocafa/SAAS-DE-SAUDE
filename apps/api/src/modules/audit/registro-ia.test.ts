import { createHash } from 'node:crypto';
import type { RequestContext, TenantId, UserId } from '@plataforma/shared';
import { describe, expect, it } from 'vitest';
import { criarAuditoriaFalsa, signerDeTeste } from '../../../test/apoio-auditoria-ia';
import { ConflitoError, NaoEncontradoError, ProibidoError, RegraNaoAtendidaError } from '../../common/erros-dominio';
import { AiDeniedError, AiService, AiUnavailableError, type AiGenerateInput } from '../ai/ai.service';
import { FakeLlmProvider } from '../ai/providers/fake-llm.provider';
import { CHAVE_LOCAL_DO_MAC, PseudonimoIndisponivelError, type PseudonymSigner } from './ator-suporte';
import { SYSTEM_ACTOR_ID } from './audit-log';
import { DECISOES_IA, FalhaAuditoriaIaError, type RevisaoIaInput } from './registro-ia';

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
        prompt_hash: (await signerDeTeste().macDeConteudo(ctx.tenantId, 'ia_prompt', `${input.system}\0${input.input}`)).mac,
        output_hash: (await signerDeTeste().macDeConteudo(ctx.tenantId, 'ia_saida', draft.text)).mac,
        hash_key_id: CHAVE_LOCAL_DO_MAC,
        input_tokens: 29,
        cached_input_tokens: 15,
        output_tokens: 7,
        latency_ms: 25,
        human_reviewed: false,
        decision: 'pendente',
      },
    });
    expect(draft.provenance.generatedAt).toBe('2026-10-10T12:00:00.000Z');
    // Os SHA-256 puros de antes do veto não podem mais aparecer (dicionário sem chave).
    expect(linhas[0]?.metadata['prompt_hash']).not.toBe(createHash('sha256').update(`${input.system}\0${input.input}`, 'utf8').digest('hex'));
    expect(linhas[0]?.metadata['output_hash']).not.toBe(createHash('sha256').update(draft.text, 'utf8').digest('hex'));
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

  it('sem MAC (chave indisponível) o provedor nem é chamado e não há rascunho', async () => {
    const provider = new FakeLlmProvider();
    const quebrado: PseudonymSigner = {
      tipo: 'kms',
      pseudonimo: () => Promise.reject(new PseudonimoIndisponivelError()),
      macDeConteudo: () => Promise.reject(new PseudonimoIndisponivelError()),
    };
    const { service, linhas } = servico(provider, { signer: quebrado });
    await expect(service.generate(input)).rejects.toBeInstanceOf(FalhaAuditoriaIaError);
    expect(provider.calls).toBe(0);
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

/** O profissional responsável pela geração (professional_id do uso) é quem revisa. */
const ctxResponsavel: RequestContext = { ...ctx, userId: professionalId as UserId };
const OUTRA_CLINICA = '55555555-5555-4555-8555-555555555555';

describe('revisão humana append-only (veto do Guardião no #227, bloqueante 2)', () => {
  it.each(DECISOES_IA)('caminho feliz: grava decisão %s herdando tarefa, paciente e profissional da geração', async (decisao) => {
    const { service, auditoria, linhas, travas } = servico(new FakeLlmProvider());
    const draft = await service.generate(input);
    const textoFinal = 'Texto final fictício editado.';
    await auditoria.registrarRevisao(ctxResponsavel, {
      useId: draft.auditId,
      decisao,
      ...(decisao === 'editada' ? { textoFinal } : {}),
    });
    expect(travas).toEqual(['advisory']);
    expect(linhas).toHaveLength(2);
    expect(linhas[1]).toMatchObject({ action: 'ai_use', scope: 'ai_review', actorId: professionalId });
    expect(linhas[1]?.metadata).toEqual({
      use_id: draft.auditId,
      task: 'escriba',
      patient_id: patientId,
      professional_id: professionalId,
      reviewer_id: professionalId,
      human_reviewed: true,
      decision: decisao,
      ...(decisao === 'editada'
        ? {
            final_output_hash: (await signerDeTeste().macDeConteudo(ctx.tenantId, 'ia_saida_final', textoFinal)).mac,
            hash_key_id: CHAVE_LOCAL_DO_MAC,
          }
        : {}),
    });
    expect(JSON.stringify(linhas)).not.toContain(textoFinal);
  });

  it('ignora tarefa, paciente e profissional vindos da entrada: valem os da geração', async () => {
    const { service, auditoria, linhas } = servico(new FakeLlmProvider());
    const draft = await service.generate(input);
    const forjada = {
      useId: draft.auditId,
      decisao: 'aceita',
      task: 'resumo',
      patientId: '99999999-9999-4999-8999-999999999999',
      professionalId: ctx.userId,
    } as RevisaoIaInput;
    await auditoria.registrarRevisao(ctxResponsavel, forjada);
    expect(linhas[1]?.metadata).toMatchObject({ task: 'escriba', patient_id: patientId, professional_id: professionalId });
  });

  it('uso inexistente: 404 e nada gravado', async () => {
    const { service, auditoria, linhas } = servico(new FakeLlmProvider());
    await service.generate(input);
    await expect(
      auditoria.registrarRevisao(ctxResponsavel, { useId: '77777777-7777-4777-8777-777777777777', decisao: 'aceita' }),
    ).rejects.toBeInstanceOf(NaoEncontradoError);
    expect(linhas).toHaveLength(1);
  });

  it('uso de outra clínica: mesmo 404, mesmo se a leitura devolvesse a linha (conferência em memória)', async () => {
    const useIdOutra = '66666666-6666-4666-8666-666666666666';
    const { auditoria, linhas } = servico(new FakeLlmProvider(), {
      linhasIniciais: [
        {
          tenantId: OUTRA_CLINICA,
          actorId: professionalId,
          actorKind: 'usuario_clinica',
          action: 'ai_use',
          scope: 'ai_generation',
          metadata: { use_id: useIdOutra, task: 'escriba', professional_id: professionalId, decision: 'pendente', human_reviewed: false },
        },
      ],
    });
    await expect(auditoria.registrarRevisao(ctxResponsavel, { useId: useIdOutra, decisao: 'aceita' })).rejects.toBeInstanceOf(
      NaoEncontradoError,
    );
    expect(linhas).toHaveLength(1);
  });

  it('revisor diferente do profissional responsável: 403 revisor_nao_responsavel', async () => {
    const { service, auditoria, linhas } = servico(new FakeLlmProvider());
    const draft = await service.generate(input);
    // ctx.userId pediu a geração, mas o responsável gravado é professionalId.
    const erro = await auditoria.registrarRevisao(ctx, { useId: draft.auditId, decisao: 'aceita' }).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ProibidoError);
    expect((erro as ProibidoError).getResponse()).toMatchObject({ codigo: 'revisor_nao_responsavel' });
    expect(linhas).toHaveLength(1);
  });

  it('sem professional_id na geração, o responsável é quem a pediu', async () => {
    const { service, auditoria, linhas } = servico(new FakeLlmProvider());
    const semProfissional: AiGenerateInput = { ...input };
    delete (semProfissional as { professionalId?: string }).professionalId;
    const draft = await service.generate(semProfissional);
    await expect(auditoria.registrarRevisao(ctxResponsavel, { useId: draft.auditId, decisao: 'aceita' })).rejects.toBeInstanceOf(ProibidoError);
    await auditoria.registrarRevisao(ctx, { useId: draft.auditId, decisao: 'aceita' });
    expect(linhas[1]?.metadata).toMatchObject({ reviewer_id: ctx.userId });
    expect(linhas[1]?.metadata).not.toHaveProperty('professional_id');
  });

  it('revisão duplicada do mesmo uso: 409 revisao_ja_registrada e a primeira fica', async () => {
    const { service, auditoria, linhas } = servico(new FakeLlmProvider());
    const draft = await service.generate(input);
    await auditoria.registrarRevisao(ctxResponsavel, { useId: draft.auditId, decisao: 'aceita' });
    const erro = await auditoria
      .registrarRevisao(ctxResponsavel, { useId: draft.auditId.toUpperCase(), decisao: 'rejeitada' })
      .catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ConflitoError);
    expect((erro as ConflitoError).codigo).toBe('revisao_ja_registrada');
    expect(linhas).toHaveLength(2);
    expect(linhas[1]?.metadata).toMatchObject({ decision: 'aceita' });
  });

  it('tentativa sem rascunho (nao_aplicavel) não aceita revisão', async () => {
    const { service, auditoria, linhas } = servico(new FakeLlmProvider({ failWith: new Error('503') }));
    await expect(service.generate(input)).rejects.toBeInstanceOf(AiUnavailableError);
    const useId = linhas[0]?.metadata['use_id'] as string;
    const erro = await auditoria.registrarRevisao(ctxResponsavel, { useId, decisao: 'aceita' }).catch((e: unknown) => e);
    expect((erro as ConflitoError).codigo).toBe('uso_sem_rascunho_para_revisar');
    expect(linhas).toHaveLength(1);
  });

  it('use_id que não é UUID: 422 sem consultar a trilha', async () => {
    const { auditoria, travas } = servico(new FakeLlmProvider());
    await expect(auditoria.registrarRevisao(ctxResponsavel, { useId: 'Maria Souza', decisao: 'aceita' })).rejects.toBeInstanceOf(
      RegraNaoAtendidaError,
    );
    expect(travas).toHaveLength(0);
  });

  it('edição sem texto final falha e não grava', async () => {
    const { service, auditoria, linhas } = servico(new FakeLlmProvider());
    const draft = await service.generate(input);
    await expect(auditoria.registrarRevisao(ctxResponsavel, { useId: draft.auditId, decisao: 'editada' })).rejects.toBeInstanceOf(
      RegraNaoAtendidaError,
    );
    expect(linhas).toHaveLength(1);
  });

  it('sentinela de sistema não conta como revisor humano', async () => {
    const { service, auditoria, linhas } = servico(new FakeLlmProvider());
    const draft = await service.generate(input);
    await expect(
      auditoria.registrarRevisao({ ...ctx, userId: SYSTEM_ACTOR_ID }, { useId: draft.auditId, decisao: 'aceita' }),
    ).rejects.toBeInstanceOf(ProibidoError);
    expect(linhas).toHaveLength(1);
  });
});
