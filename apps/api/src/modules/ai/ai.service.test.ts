import type { RequestContext, TenantId, UserId } from '@plataforma/shared';
import { describe, expect, it } from 'vitest';
import { criarAuditoriaFalsa } from '../../../test/apoio-auditoria-ia';
import { AI_PROVIDER_IDS, createProviders, parseAiProvider } from './ai.module';
import { AiDeniedError, AiService, AiUnavailableError, promptHash, type AiGenerateInput } from './ai.service';
import type { LlmProvider } from './llm-provider';
import { FakeLlmProvider } from './providers/fake-llm.provider';

const ctx: RequestContext = {
  tenantId: 'tenant-sintetico-1' as TenantId,
  userId: '22222222-2222-4222-8222-222222222222' as UserId,
  roles: ['profissional'],
};
const fixedNow = new Date('2026-10-10T12:00:00.000Z');
const input: AiGenerateInput = {
  ctx,
  task: 'escriba',
  niche: 'fisio_to',
  sensitivity: 'sensivel',
  tenantPolicy: { aiEnabled: true, allowsInternationalTransfer: false },
  patientConsent: 'informado_nao_recusou',
  system: 'Você é um assistente de documentação. Prompt sintético v1.',
  input: 'Transcrição sintética.',
};

function servico(providers: readonly LlmProvider[]) {
  const { auditoria, linhas } = criarAuditoriaFalsa(ctx, { agora: () => fixedNow });
  return { service: new AiService(providers, auditoria), linhas };
}

describe('AiService', () => {
  it('devolve rascunho com proveniência e revisão humana obrigatória', async () => {
    const { service } = servico([new FakeLlmProvider({ version: '1.2.3' })]);
    const draft = await service.generate(input);
    expect(draft.requiresHumanReview).toBe(true);
    expect(draft.auditId).toMatch(/^[0-9a-f-]{36}$/);
    expect(draft.provenance).toEqual({
      providerId: 'fake-br',
      model: { provider: 'fake', name: 'fake-llm', version: '1.2.3' },
      promptHash: promptHash(input.system),
      generatedAt: '2026-10-10T12:00:00.000Z',
    });
    expect(draft.usage.cachedInputTokens).toBeGreaterThan(0);
  });

  it('o hash do prompt muda quando o prompt muda (versão rastreável)', () => {
    expect(promptHash('a')).not.toBe(promptHash('b'));
    expect(promptHash('a')).toHaveLength(16);
  });

  it('recusa do paciente: nega sem chamar nenhum modelo', async () => {
    const fake = new FakeLlmProvider();
    const { service, linhas } = servico([fake]);
    await expect(service.generate({ ...input, patientConsent: 'recusou' })).rejects.toBeInstanceOf(AiDeniedError);
    expect(fake.calls).toBe(0);
    expect(linhas[0]?.action).toBe('ai_refusal');
  });

  it('rota BR falhou: tenta a próxima rota BR e audita as duas tentativas', async () => {
    const quebrada = new FakeLlmProvider({ id: 'br-quebrada', failWith: new Error('503') });
    const boa = new FakeLlmProvider({ id: 'br-boa' });
    const { service, linhas } = servico([quebrada, boa]);
    const draft = await service.generate(input);
    expect(draft.provenance.providerId).toBe('br-boa');
    expect(linhas.map((l) => l.metadata.decision)).toEqual(['nao_aplicavel', 'pendente']);
  });

  it('rota BR falhou e só sobrou rota estrangeira: dado sensível não sai, erro de indisponibilidade', async () => {
    const quebrada = new FakeLlmProvider({ id: 'br-quebrada', failWith: new Error('503') });
    const estrangeira = new FakeLlmProvider({ id: 'ext', residency: 'EXTERIOR' });
    const { service } = servico([quebrada, estrangeira]);
    await expect(service.generate(input)).rejects.toBeInstanceOf(AiUnavailableError);
    expect(estrangeira.calls).toBe(0);
  });

  it('prazo estourado cancela a chamada e passa para a próxima rota', async () => {
    const lenta = new FakeLlmProvider({ id: 'br-lenta', delayMs: 1_000 });
    const rapida = new FakeLlmProvider({ id: 'br-rapida' });
    const { service } = servico([lenta, rapida]);
    const draft = await service.generate({ ...input, timeoutMs: 20 });
    expect(draft.provenance.providerId).toBe('br-rapida');
  });

  it('resposta bloqueada por filtro de conteúdo não vira rascunho', async () => {
    const filtrada = new FakeLlmProvider({
      id: 'br-filtro',
      responder: () => ({ text: '', finishReason: 'content_filter' }),
    });
    const { service, linhas } = servico([filtrada]);
    await expect(service.generate(input)).rejects.toBeInstanceOf(AiUnavailableError);
    expect(linhas[0]?.metadata).toMatchObject({ output_hash: null, decision: 'nao_aplicavel' });
  });
});

describe('configuração do provedor (AI_PROVIDER)', () => {
  it('padrão é o fake', () => {
    expect(parseAiProvider({})).toBe('fake');
  });

  it('valor desconhecido falha no boot', () => {
    expect(() => parseAiProvider({ AI_PROVIDER: 'openai' })).toThrow(/AI_PROVIDER inválido/);
  });

  it('fake NÃO sobe em produção: falha no boot', () => {
    expect(() => parseAiProvider({ AI_PROVIDER: 'fake', NODE_ENV: 'production' })).toThrow(
      /não sobe em produção/,
    );
  });

  it('em produção, nem o padrão implícito passa (AI_PROVIDER ausente)', () => {
    expect(() => parseAiProvider({ NODE_ENV: 'production' })).toThrow(/não sobe em produção/);
  });

  it('fora de produção o fake segue valendo', () => {
    expect(parseAiProvider({ AI_PROVIDER: 'fake', NODE_ENV: 'test' })).toBe('fake');
  });

  it.each(AI_PROVIDER_IDS.filter((id) => id !== 'fake'))('%s ainda não existe: aguarda a D3', (id) => {
    expect(() => createProviders(id)).toThrow(/aguarda a D3/);
  });
});
