import type { TenantId } from '@plataforma/shared';
import { describe, expect, it } from 'vitest';
import { AI_PROVIDER_IDS, createProviders, parseAiProvider } from './ai.module';
import { AiDeniedError, AiService, AiUnavailableError, promptHash, type AiGenerateInput } from './ai.service';
import { FakeLlmProvider } from './providers/fake-llm.provider';

const tenantId = 'tenant-sintetico-1' as TenantId;
const fixedNow = new Date('2026-10-10T12:00:00.000Z');
const input: AiGenerateInput = {
  tenantId,
  task: 'escriba',
  niche: 'fisio_to',
  sensitivity: 'sensivel',
  tenantPolicy: { aiEnabled: true, allowsInternationalTransfer: false },
  patientConsent: 'nao_recusou',
  system: 'Você é um assistente de documentação. Prompt sintético v1.',
  input: 'Transcrição sintética.',
};

describe('AiService', () => {
  it('devolve rascunho com proveniência e revisão humana obrigatória', async () => {
    const service = new AiService([new FakeLlmProvider({ version: '1.2.3' })], () => fixedNow);
    const draft = await service.generate(input);
    expect(draft.requiresHumanReview).toBe(true);
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
    const service = new AiService([fake]);
    await expect(service.generate({ ...input, patientConsent: 'recusou' })).rejects.toBeInstanceOf(AiDeniedError);
    expect(fake.calls).toBe(0);
  });

  it('rota BR falhou: tenta a próxima rota BR', async () => {
    const quebrada = new FakeLlmProvider({ id: 'br-quebrada', failWith: new Error('503') });
    const boa = new FakeLlmProvider({ id: 'br-boa' });
    const draft = await new AiService([quebrada, boa]).generate(input);
    expect(draft.provenance.providerId).toBe('br-boa');
  });

  it('rota BR falhou e só sobrou rota estrangeira: dado sensível não sai, erro de indisponibilidade', async () => {
    const quebrada = new FakeLlmProvider({ id: 'br-quebrada', failWith: new Error('503') });
    const estrangeira = new FakeLlmProvider({ id: 'ext', residency: 'EXTERIOR' });
    await expect(new AiService([quebrada, estrangeira]).generate(input)).rejects.toBeInstanceOf(AiUnavailableError);
    expect(estrangeira.calls).toBe(0);
  });

  it('prazo estourado cancela a chamada e passa para a próxima rota', async () => {
    const lenta = new FakeLlmProvider({ id: 'br-lenta', delayMs: 1_000 });
    const rapida = new FakeLlmProvider({ id: 'br-rapida' });
    const draft = await new AiService([lenta, rapida]).generate({ ...input, timeoutMs: 20 });
    expect(draft.provenance.providerId).toBe('br-rapida');
  });

  it('resposta bloqueada por filtro de conteúdo não vira rascunho', async () => {
    const filtrada = new FakeLlmProvider({
      id: 'br-filtro',
      responder: () => ({ text: '', finishReason: 'content_filter' }),
    });
    await expect(new AiService([filtrada]).generate(input)).rejects.toBeInstanceOf(AiUnavailableError);
  });
});

describe('configuração do provedor (AI_PROVIDER)', () => {
  it('padrão é o fake', () => {
    expect(parseAiProvider({})).toBe('fake');
  });

  it('valor desconhecido falha no boot', () => {
    expect(() => parseAiProvider({ AI_PROVIDER: 'openai' })).toThrow(/AI_PROVIDER inválido/);
  });

  it.each(AI_PROVIDER_IDS.filter((id) => id !== 'fake'))('%s ainda não existe: aguarda a D3', (id) => {
    expect(() => createProviders(id)).toThrow(/aguarda a D3/);
  });
});
