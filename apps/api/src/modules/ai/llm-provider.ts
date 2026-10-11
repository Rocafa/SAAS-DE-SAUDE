/**
 * Contrato único entre os módulos do SaaS e qualquer modelo de linguagem.
 * Ver docs/05-ia-llm/arquitetura-ia.md §2: nenhum módulo chama fornecedor diretamente;
 * tudo passa pelo AiService, que aplica a política de roteamento (routing-policy.ts).
 *
 * Adaptadores reais (Gemini via Vertex AI em southamerica-east1, Maritaca Sabiá) só entram
 * depois da D3. Hoje existe apenas o FakeLlmProvider, que não faz chamada de rede.
 */
import type { TenantId } from '@plataforma/shared';

/** Onde o fornecedor processa o dado. Rota BR nunca cai automaticamente para EXTERIOR. */
export const DATA_RESIDENCIES = ['BR', 'EXTERIOR'] as const;
export type DataResidency = (typeof DATA_RESIDENCIES)[number];

/**
 * Sensibilidade do conteúdo enviado ao modelo.
 * - sensivel: dado de saúde identificável ou re-identificável (art. 11 LGPD) → somente BR.
 * - pseudonimizado: passou pela pseudonimização aprovada pelo Guardião → BR, ou EXTERIOR
 *   se o tenant aceitou transferência internacional em contrato.
 * - nao_pessoal: sem dado pessoal (FAQ da clínica, tabelas CID/TUSS).
 */
export const DATA_SENSITIVITIES = ['sensivel', 'pseudonimizado', 'nao_pessoal'] as const;
export type DataSensitivity = (typeof DATA_SENSITIVITIES)[number];

export const AI_TASKS = ['escriba', 'verificador', 'resumo_paciente', 'cid_tuss', 'chatbot'] as const;
export type AiTask = (typeof AI_TASKS)[number];

/** Nichos com regra própria de roteamento. Psicologia nunca sai do país (arquitetura-ia.md §2). */
export const AI_NICHES = ['fisio_to', 'psicologia', 'nutricao', 'medicina', 'outro'] as const;
export type AiNiche = (typeof AI_NICHES)[number];

/** Versão fixada do modelo. Nada de alias "latest": troca de versão só via PR com eval. */
export interface ModelRef {
  readonly provider: string;
  readonly name: string;
  readonly version: string;
}

export interface LlmRequest {
  readonly tenantId: TenantId;
  readonly task: AiTask;
  readonly niche: AiNiche;
  readonly sensitivity: DataSensitivity;
  /** Prefixo fixo e cacheável: instruções + template do nicho. Nunca contém dado do paciente. */
  readonly system: string;
  /** Conteúdo variável (transcrição pseudonimizada, contexto RAG). */
  readonly input: string;
  /** Saída estruturada: o adaptador deve pedir JSON e devolver o objeto em `json`. */
  readonly jsonSchema?: Readonly<Record<string, unknown>>;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
}

export interface LlmUsage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
}

export type LlmFinishReason = 'stop' | 'length' | 'content_filter' | 'error';

export interface LlmResponse {
  readonly text: string;
  readonly json?: unknown;
  readonly usage: LlmUsage;
  readonly model: ModelRef;
  readonly finishReason: LlmFinishReason;
}

export interface LlmProvider {
  /** Identificador estável da rota (ex.: "fake-br", "vertex-gemini-sp", "maritaca-sabia"). */
  readonly id: string;
  readonly residency: DataResidency;
  readonly model: ModelRef;
  /** Tarefas que esta rota foi avaliada para atender (só entra após passar no eval). */
  readonly tasks: readonly AiTask[];
  generate(request: LlmRequest, signal: AbortSignal): Promise<LlmResponse>;
}

/** Política de IA de cada clínica (vem do contrato e das configurações do tenant). */
export interface TenantAiPolicy {
  readonly aiEnabled: boolean;
  /** Tenant aceitou transferência internacional (cláusulas-padrão ANPD, Res. 19/2024). */
  readonly allowsInternationalTransfer: boolean;
}

/** Recusa do paciente ao uso de IA (Res. CFM 2.454/2026). Ausência de registro = não recusou. */
export type PatientAiConsent = 'nao_recusou' | 'recusou';
