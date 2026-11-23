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
 * Toda tentativa e recusa passa por AuditoriaIaService: se a trilha falhar, não há rascunho
 * nem fallback que esconda a ausência do registro.
 */
import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { RequestContext } from '@plataforma/shared';
import { AuditoriaIaService, FalhaAuditoriaIaError } from '../audit/registro-ia';
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
  readonly ctx: RequestContext;
  readonly task: AiTask;
  readonly niche: AiNiche;
  readonly sensitivity: DataSensitivity;
  readonly tenantPolicy: TenantAiPolicy;
  readonly patientConsent?: PatientAiConsent;
  /** UUID do paciente, nunca nome/CPF; ausente só em tarefa sem paciente. */
  readonly patientId?: string;
  /** UUID do profissional, quando a chamada é de um profissional. */
  readonly professionalId?: string;
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
  /** UUID da linha de geração; liga a revisão humana append-only a esta chamada. */
  readonly auditId: string;
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
    private readonly auditoria: AuditoriaIaService,
  ) {}

  async generate(input: AiGenerateInput): Promise<AiDraft> {
    const decision = routeRequest(input, this.providers);
    if (!decision.allowed) {
      await this.auditoria.registrarRecusa(input.ctx, {
        task: input.task,
        reason: decision.reason,
        ...(input.patientId ? { patientId: input.patientId } : {}),
        ...(input.professionalId ? { professionalId: input.professionalId } : {}),
      });
      throw new AiDeniedError(decision.reason);
    }

    const request: LlmRequest = {
      tenantId: input.ctx.tenantId,
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
        const resultado = await this.auditoria.chamar(
          input.ctx,
          {
            task: input.task,
            ...(input.patientId ? { patientId: input.patientId } : {}),
            ...(input.professionalId ? { professionalId: input.professionalId } : {}),
            system: input.system,
            input: input.input,
            model: provider.model,
          },
          () => provider.generate(request, controller.signal),
        );
        const res = resultado.response;
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
            generatedAt: resultado.generatedAt,
          },
          auditId: resultado.auditId,
          requiresHumanReview: true,
        };
      } catch (err) {
        if (err instanceof FalhaAuditoriaIaError) throw err;
        const name = err instanceof Error ? err.name : 'Error';
        this.logger.warn(`rota ${provider.id} falhou (${name}); tentando a próxima`);
      } finally {
        clearTimeout(timer);
      }
    }
    throw new AiUnavailableError(attempts);
  }
}
