/**
 * Porta de entrada única para IA no SaaS. Aplica a política de roteamento, o prazo por
 * chamada e o fallback entre rotas elegíveis, e devolve um RASCUNHO com proveniência.
 *
 * Res. CFM 2.454/2026 (docs/05-ia-llm/avaliacao-e-seguranca.md §5.2):
 * - todo resultado é rascunho (`requiresHumanReview: true`); nada é salvo nem enviado ao
 *   paciente sem revisão e assinatura do profissional (isso é dever de quem consome o draft);
 * - a proveniência (rota, modelo@versão, prompt@hash) vai para o documento final;
 * - a recusa do paciente bloqueia a chamada (routing-policy.ts).
 * Nenhum log deste serviço contém texto clínico: só ids, códigos e contagens.
 */
import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { TenantId } from '@plataforma/shared';
import type {
  AiNiche,
  AiTask,
  DataSensitivity,
  LlmProvider,
  LlmRequest,
  LlmUsage,
  ModelRef,
  PatientAiConsent,
  TenantAiPolicy,
} from './llm-provider';
import { routeRequest, type RoutingDenialReason } from './routing-policy';

export const DEFAULT_AI_TIMEOUT_MS = 30_000;

export interface AiGenerateInput {
  readonly tenantId: TenantId;
  readonly task: AiTask;
  readonly niche: AiNiche;
  readonly sensitivity: DataSensitivity;
  readonly tenantPolicy: TenantAiPolicy;
  readonly patientConsent?: PatientAiConsent;
  readonly system: string;
  readonly input: string;
  readonly jsonSchema?: Readonly<Record<string, unknown>>;
  readonly maxOutputTokens?: number;
  readonly timeoutMs?: number;
}

export interface AiProvenance {
  readonly providerId: string;
  readonly model: ModelRef;
  /** sha256 do prompt de sistema (versão do prompt), 16 primeiros hex. */
  readonly promptHash: string;
  /** ISO-8601 (UTC). */
  readonly generatedAt: string;
}

export interface AiDraft {
  readonly text: string;
  readonly json?: unknown;
  readonly usage: LlmUsage;
  readonly provenance: AiProvenance;
  /** Sempre true: IA sugere, o profissional decide e assina. */
  readonly requiresHumanReview: true;
}

export class AiDeniedError extends Error {
  constructor(readonly reason: RoutingDenialReason) {
    super(`Uso de IA negado: ${reason}`);
    this.name = 'AiDeniedError';
  }
}

export class AiUnavailableError extends Error {
  constructor(readonly attempts: readonly string[]) {
    super(`Nenhuma rota de IA respondeu (tentativas: ${attempts.join(', ')})`);
    this.name = 'AiUnavailableError';
  }
}

export function promptHash(system: string): string {
  return createHash('sha256').update(system, 'utf8').digest('hex').slice(0, 16);
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  constructor(
    private readonly providers: readonly LlmProvider[],
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async generate(input: AiGenerateInput): Promise<AiDraft> {
    const decision = routeRequest(input, this.providers);
    if (!decision.allowed) throw new AiDeniedError(decision.reason);

    const request: LlmRequest = {
      tenantId: input.tenantId,
      task: input.task,
      niche: input.niche,
      sensitivity: input.sensitivity,
      system: input.system,
      input: input.input,
      ...(input.jsonSchema ? { jsonSchema: input.jsonSchema } : {}),
      maxOutputTokens: input.maxOutputTokens ?? 2_000,
      timeoutMs: input.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS,
    };

    const attempts: string[] = [];
    for (const provider of decision.candidates) {
      attempts.push(provider.id);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), request.timeoutMs);
      try {
        const res = await provider.generate(request, controller.signal);
        if (res.finishReason === 'error' || res.finishReason === 'content_filter') {
          this.logger.warn(`rota ${provider.id} terminou com ${res.finishReason}; tentando a próxima`);
          continue;
        }
        return {
          text: res.text,
          ...(res.json !== undefined ? { json: res.json } : {}),
          usage: res.usage,
          provenance: {
            providerId: provider.id,
            model: res.model,
            promptHash: promptHash(request.system),
            generatedAt: this.clock().toISOString(),
          },
          requiresHumanReview: true,
        };
      } catch (err) {
        const name = err instanceof Error ? err.name : 'Error';
        this.logger.warn(`rota ${provider.id} falhou (${name}); tentando a próxima`);
      } finally {
        clearTimeout(timer);
      }
    }
    throw new AiUnavailableError(attempts);
  }
}
