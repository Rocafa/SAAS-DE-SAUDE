/**
 * Adaptador FAKE de LLM: determinístico, sem rede, sem fornecedor. Serve para
 * - desenvolver e testar o fluxo do escriba antes da D3 (provedor de LLM);
 * - rodar o protocolo de avaliação no CI com respostas roteirizadas (golden sets).
 * O teste no-network.test.ts garante que nada no módulo ai faz chamada externa.
 */
import type {
  AiTask,
  DataResidency,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  ModelRef,
} from '../llm-provider';
import { AI_TASKS } from '../llm-provider';

export type FakeResponder = (request: LlmRequest) => Omit<LlmResponse, 'model' | 'usage'> & {
  readonly usage?: LlmResponse['usage'];
};

export interface FakeLlmOptions {
  readonly id?: string;
  readonly residency?: DataResidency;
  readonly tasks?: readonly AiTask[];
  readonly version?: string;
  /** Resposta roteirizada; padrão: JSON vazio marcado como fake. */
  readonly responder?: FakeResponder;
  /** Simula falha do fornecedor (para testar fallback). */
  readonly failWith?: Error;
  /** Simula latência; respeita o AbortSignal (para testar timeout). */
  readonly delayMs?: number;
}

/** Estimativa grosseira (≈ 4 caracteres por token), só para exercitar a contabilidade de custo. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const defaultResponder: FakeResponder = () => ({
  text: JSON.stringify({ fake: true, secoes: [] }),
  json: { fake: true, secoes: [] },
  finishReason: 'stop',
});

export class FakeLlmProvider implements LlmProvider {
  readonly id: string;
  readonly residency: DataResidency;
  readonly model: ModelRef;
  readonly tasks: readonly AiTask[];
  /** Quantas chamadas recebeu. Não guarda o conteúdo: nem o fake retém texto clínico. */
  calls = 0;

  constructor(private readonly options: FakeLlmOptions = {}) {
    this.id = options.id ?? 'fake-br';
    this.residency = options.residency ?? 'BR';
    this.tasks = options.tasks ?? AI_TASKS;
    this.model = { provider: 'fake', name: 'fake-llm', version: options.version ?? '0.0.0' };
  }

  async generate(request: LlmRequest, signal: AbortSignal): Promise<LlmResponse> {
    this.calls += 1;
    if (this.options.delayMs) await sleep(this.options.delayMs, signal);
    if (signal.aborted) throw abortError();
    if (this.options.failWith) throw this.options.failWith;

    const out = (this.options.responder ?? defaultResponder)(request);
    return {
      ...out,
      model: this.model,
      usage: out.usage ?? {
        inputTokens: estimateTokens(request.system) + estimateTokens(request.input),
        cachedInputTokens: estimateTokens(request.system),
        outputTokens: estimateTokens(out.text),
      },
    };
  }
}

function abortError(): Error {
  const err = new Error('Chamada ao modelo cancelada (timeout ou encerramento)');
  err.name = 'AbortError';
  return err;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(abortError());
      },
      { once: true },
    );
  });
}
