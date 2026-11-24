import { createHash } from 'node:crypto';
import type { RequestContext, TenantId, UserId } from '@plataforma/shared';
import { describe, expect, it } from 'vitest';
import { criarAuditoriaFalsa, signerDeTeste } from '../../../test/apoio-auditoria-ia';
import { ConflitoError, NaoEncontradoError, ProibidoError, RegraNaoAtendidaError } from '../../common/erros-dominio';
import { AiDeniedError, AiService, AiUnavailableError, type AiGenerateInput } from '../ai/ai.service';
import type { LlmProvider } from '../ai/llm-provider';
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

const macDe = async (uso: 'ia_prompt' | 'ia_saida', texto: string) => (await signerDeTeste().macDeConteudo(ctx.tenantId, uso, texto)).mac;

describe('registro obrigatório de IA: tentativa e resultado (item 3 do veto do Guardião no #227)', () => {
  it('grava tentativa e resultado com todos os metadados, sem nome, CPF, prompt ou saída em claro', async () => {
    const provider = new FakeLlmProvider({ version: '1.2.3' });
    const { service, linhas } = servico(provider, { monotonico: (() => {
      const valores = [100, 125];
      return () => valores.shift() ?? 125;
    })() });
    const draft = await service.generate(input);

    expect(linhas.map((l) => l.scope)).toEqual(['ai_attempt', 'ai_result']);
    expect(linhas[0]).toMatchObject({ tenantId: ctx.tenantId, actorId: ctx.userId, actorKind: 'usuario_clinica', action: 'ai_use' });
    expect(linhas[0]?.metadata).toEqual({
      use_id: draft.auditId,
      task: 'escriba',
      model: 'fake/fake-llm',
      model_version: '1.2.3',
      patient_id: patientId,
      professional_id: professionalId,
      prompt_hash: await macDe('ia_prompt', `${input.system}\0${input.input}`),
      hash_key_id: CHAVE_LOCAL_DO_MAC,
      human_reviewed: false,
    });
    expect(linhas[1]).toMatchObject({ actorId: ctx.userId, action: 'ai_use' });
    expect(linhas[1]?.metadata).toEqual({
      use_id: draft.auditId,
      status: 'sucesso',
      model: 'fake/fake-llm',
      model_version: '1.2.3',
      finish_reason: 'stop',
      output_hash: await macDe('ia_saida', draft.text),
      hash_key_id: CHAVE_LOCAL_DO_MAC,
      input_tokens: 29,
      cached_input_tokens: 15,
      output_tokens: 7,
      latency_ms: 25,
      human_reviewed: false,
      decision: 'pendente',
    });
    expect(draft.provenance.generatedAt).toBe('2026-10-10T12:00:00.000Z');
    // Os SHA-256 puros de antes do veto não podem mais aparecer (dicionário sem chave).
    expect(linhas[0]?.metadata['prompt_hash']).not.toBe(createHash('sha256').update(`${input.system}\0${input.input}`, 'utf8').digest('hex'));
    expect(linhas[1]?.metadata['output_hash']).not.toBe(createHash('sha256').update(draft.text, 'utf8').digest('hex'));
    const trilha = JSON.stringify(linhas);
    expect(trilha).not.toContain('Paciente Ficticio');
    expect(trilha).not.toContain('000.000.000-00');
    expect(trilha).not.toContain('transcrição sintética');
    expect(trilha).not.toContain('"fake":true');
  });

  it('a chamada ao modelo roda FORA de transação: a tentativa já está commitada e nenhuma conexão fica presa', async () => {
    const fake = new FakeLlmProvider();
    let abertasNaChamada = -1;
    let linhasNaChamada: string[] = [];
    const banco = criarAuditoriaFalsa(ctx, { agora, monotonico: () => 125 });
    const espiao: LlmProvider = {
      id: fake.id,
      residency: fake.residency,
      model: fake.model,
      tasks: fake.tasks,
      generate: (request, signal) => {
        abertasNaChamada = banco.transacoesAbertas();
        linhasNaChamada = banco.linhas.map((l) => l.scope);
        return fake.generate(request, signal);
      },
    };
    await new AiService([espiao], banco.auditoria).generate(input);
    expect(abertasNaChamada).toBe(0);
    expect(linhasNaChamada).toEqual(['ai_attempt']);
  });

  it('se a tentativa não grava (INSERT), nada vai ao provedor e não há rascunho', async () => {
    const provider = new FakeLlmProvider();
    const { service, linhas } = servico(provider, { falharInsert: true });
    await expect(service.generate(input)).rejects.toBeInstanceOf(FalhaAuditoriaIaError);
    expect(provider.calls).toBe(0);
    expect(linhas).toHaveLength(0);
  });

  it('se o COMMIT da tentativa falha, nada vai ao provedor', async () => {
    const provider = new FakeLlmProvider();
    const { service, linhas } = servico(provider, { falharCommit: true });
    await expect(service.generate(input)).rejects.toBeInstanceOf(FalhaAuditoriaIaError);
    expect(provider.calls).toBe(0);
    expect(linhas).toHaveLength(0);
  });

  it('sem MAC do prompt (chave indisponível) o provedor nem é chamado e nada é gravado', async () => {
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

  it('MAC da saída falha DEPOIS do envio: resultado gravado como erro, sem hash e sem rascunho (nada órfão)', async () => {
    const provider = new FakeLlmProvider();
    const local = signerDeTeste();
    const saidaQuebrada: PseudonymSigner = {
      tipo: 'kms',
      pseudonimo: (t, a) => local.pseudonimo(t, a),
      macDeConteudo: (t, uso, c) => (uso === 'ia_saida' ? Promise.reject(new PseudonimoIndisponivelError()) : local.macDeConteudo(t, uso, c)),
    };
    const { service, linhas } = servico(provider, { signer: saidaQuebrada });
    await expect(service.generate(input)).rejects.toBeInstanceOf(FalhaAuditoriaIaError);
    expect(provider.calls).toBe(1);
    expect(linhas.map((l) => l.scope)).toEqual(['ai_attempt', 'ai_result']);
    expect(linhas[1]?.metadata).toMatchObject({ status: 'erro', motivo: 'mac_indisponivel', output_hash: null, decision: 'nao_aplicavel' });
    expect(linhas[1]?.metadata).not.toHaveProperty('hash_key_id');
  });

  it('provedor falha: a tentativa fica e o resultado é erro, sem inventar saída ou tokens', async () => {
    const provider = new FakeLlmProvider({ failWith: new Error('503') });
    const { service, linhas } = servico(provider);
    await expect(service.generate(input)).rejects.toBeInstanceOf(AiUnavailableError);
    expect(linhas.map((l) => l.scope)).toEqual(['ai_attempt', 'ai_result']);
    expect(linhas[1]?.metadata).toMatchObject({
      use_id: linhas[0]?.metadata['use_id'],
      status: 'erro',
      finish_reason: null,
      output_hash: null,
      input_tokens: null,
      cached_input_tokens: null,
      output_tokens: null,
      human_reviewed: false,
      decision: 'nao_aplicavel',
    });
  });

  it('provedor falha e o resultado não grava: tentativa sem resultado, sem rascunho e sem fallback silencioso', async () => {
    const provider = new FakeLlmProvider({ failWith: new Error('503') });
    const { service, linhas } = servico(provider, { falharInsertDoEscopo: 'ai_result' });
    await expect(service.generate(input)).rejects.toBeInstanceOf(FalhaAuditoriaIaError);
    expect(provider.calls).toBe(1);
    expect(linhas.map((l) => l.scope)).toEqual(['ai_attempt']);
  });

  it('timeout do provedor (AbortError) vira status timeout', async () => {
    const abortado = new Error('cancelada');
    abortado.name = 'AbortError';
    const { service, linhas } = servico(new FakeLlmProvider({ failWith: abortado }));
    await expect(service.generate(input)).rejects.toBeInstanceOf(AiUnavailableError);
    expect(linhas[1]?.metadata).toMatchObject({ status: 'timeout', output_hash: null });
  });

  it('escrita bloqueada pela assinatura na tentativa: 403 sem chamar o provedor nem tentar outra rota', async () => {
    const provider = new FakeLlmProvider();
    const banco = criarAuditoriaFalsa(ctx, { agora, assinatura: 'read_only' });
    await expect(new AiService([provider], banco.auditoria).generate(input)).rejects.toBeInstanceOf(ProibidoError);
    expect(provider.calls).toBe(0);
    expect(banco.linhas).toHaveLength(0);
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
    expect(linhas).toHaveLength(3);
    expect(linhas[2]).toMatchObject({ action: 'ai_use', scope: 'ai_review', actorId: professionalId });
    expect(linhas[2]?.metadata).toEqual({
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
    expect(linhas[2]?.metadata).toMatchObject({ task: 'escriba', patient_id: patientId, professional_id: professionalId });
  });

  it('uso inexistente: 404 e nada gravado', async () => {
    const { service, auditoria, linhas } = servico(new FakeLlmProvider());
    await service.generate(input);
    await expect(
      auditoria.registrarRevisao(ctxResponsavel, { useId: '77777777-7777-4777-8777-777777777777', decisao: 'aceita' }),
    ).rejects.toBeInstanceOf(NaoEncontradoError);
    expect(linhas).toHaveLength(2);
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
          scope: 'ai_attempt',
          metadata: { use_id: useIdOutra, task: 'escriba', professional_id: professionalId, human_reviewed: false },
        },
        {
          tenantId: OUTRA_CLINICA,
          actorId: professionalId,
          actorKind: 'usuario_clinica',
          action: 'ai_use',
          scope: 'ai_result',
          metadata: { use_id: useIdOutra, status: 'sucesso', decision: 'pendente', human_reviewed: false },
        },
      ],
    });
    await expect(auditoria.registrarRevisao(ctxResponsavel, { useId: useIdOutra, decisao: 'aceita' })).rejects.toBeInstanceOf(
      NaoEncontradoError,
    );
    expect(linhas).toHaveLength(2);
  });

  it('revisor diferente do profissional responsável: 403 revisor_nao_responsavel', async () => {
    const { service, auditoria, linhas } = servico(new FakeLlmProvider());
    const draft = await service.generate(input);
    // ctx.userId pediu a geração, mas o responsável gravado é professionalId.
    const erro = await auditoria.registrarRevisao(ctx, { useId: draft.auditId, decisao: 'aceita' }).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ProibidoError);
    expect((erro as ProibidoError).getResponse()).toMatchObject({ codigo: 'revisor_nao_responsavel' });
    expect(linhas).toHaveLength(2);
  });

  it('sem professional_id na geração, o responsável é quem a pediu', async () => {
    const { service, auditoria, linhas } = servico(new FakeLlmProvider());
    const semProfissional: AiGenerateInput = { ...input };
    delete (semProfissional as { professionalId?: string }).professionalId;
    const draft = await service.generate(semProfissional);
    await expect(auditoria.registrarRevisao(ctxResponsavel, { useId: draft.auditId, decisao: 'aceita' })).rejects.toBeInstanceOf(ProibidoError);
    await auditoria.registrarRevisao(ctx, { useId: draft.auditId, decisao: 'aceita' });
    expect(linhas[2]?.metadata).toMatchObject({ reviewer_id: ctx.userId });
    expect(linhas[2]?.metadata).not.toHaveProperty('professional_id');
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
    expect(linhas).toHaveLength(3);
    expect(linhas[2]?.metadata).toMatchObject({ decision: 'aceita' });
  });

  it('tentativa sem rascunho (nao_aplicavel) não aceita revisão', async () => {
    const { service, auditoria, linhas } = servico(new FakeLlmProvider({ failWith: new Error('503') }));
    await expect(service.generate(input)).rejects.toBeInstanceOf(AiUnavailableError);
    const useId = linhas[0]?.metadata['use_id'] as string;
    const erro = await auditoria.registrarRevisao(ctxResponsavel, { useId, decisao: 'aceita' }).catch((e: unknown) => e);
    expect((erro as ConflitoError).codigo).toBe('uso_sem_rascunho_para_revisar');
    expect(linhas).toHaveLength(2);
  });

  it('tentativa sem resultado (resultado não gravou) não aceita revisão', async () => {
    const { service, auditoria, linhas } = servico(new FakeLlmProvider(), { falharInsertDoEscopo: 'ai_result' });
    await expect(service.generate(input)).rejects.toBeInstanceOf(FalhaAuditoriaIaError);
    const useId = linhas[0]?.metadata['use_id'] as string;
    const erro = await auditoria.registrarRevisao(ctxResponsavel, { useId, decisao: 'aceita' }).catch((e: unknown) => e);
    expect((erro as ConflitoError).codigo).toBe('uso_sem_rascunho_para_revisar');
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
    expect(linhas).toHaveLength(2);
  });

  it('sentinela de sistema não conta como revisor humano', async () => {
    const { service, auditoria, linhas } = servico(new FakeLlmProvider());
    const draft = await service.generate(input);
    await expect(
      auditoria.registrarRevisao({ ...ctx, userId: SYSTEM_ACTOR_ID }, { useId: draft.auditId, decisao: 'aceita' }),
    ).rejects.toBeInstanceOf(ProibidoError);
    expect(linhas).toHaveLength(2);
  });
});
