/**
 * Política de roteamento de IA (pura, sem I/O). Ver docs/05-ia-llm/arquitetura-ia.md §2.
 * Os testes em routing-policy.test.ts quebram o CI se alguém permitir que dado sensível ou
 * psicologia saiam do país, ou que uma rota BR caia para uma rota estrangeira.
 *
 * Ordem das regras (falha fechada: na dúvida, nega):
 * 1. Clínica com IA desligada → nega.
 * 2. Paciente recusou IA (Res. CFM 2.454/2026) → nega, para qualquer tarefa que use dado dele.
 * 3. Rota precisa ter sido avaliada para a tarefa (`provider.tasks`).
 * 4. Psicologia → somente BR, mesmo pseudonimizado e mesmo com transferência aceita.
 * 5. sensivel → somente BR.
 * 6. pseudonimizado → BR; EXTERIOR só se o tenant aceitou transferência internacional.
 * 7. nao_pessoal → qualquer residência.
 * Rotas BR vêm sempre antes das estrangeiras, e a lista resultante é a ordem de fallback:
 * se a primeira rota BR falhar, a próxima candidata é outra BR, nunca uma EXTERIOR que não
 * fosse elegível por si só.
 */
import type {
  AiNiche,
  AiTask,
  DataResidency,
  DataSensitivity,
  LlmProvider,
  PatientAiConsent,
  TenantAiPolicy,
} from './llm-provider';

export interface RoutingInput {
  readonly task: AiTask;
  readonly niche: AiNiche;
  readonly sensitivity: DataSensitivity;
  readonly tenantPolicy: TenantAiPolicy;
  /** Obrigatório quando a tarefa envolve dado de um paciente; `undefined` só para nao_pessoal. */
  readonly patientConsent?: PatientAiConsent;
}

export type RoutingDenialReason =
  | 'ia_desligada_na_clinica'
  | 'paciente_recusou_ia'
  | 'consentimento_nao_informado'
  | 'nenhuma_rota_elegivel';

export type RoutingDecision =
  | { readonly allowed: true; readonly candidates: readonly LlmProvider[] }
  | { readonly allowed: false; readonly reason: RoutingDenialReason };

/** Residências permitidas para a combinação nicho × sensibilidade × contrato do tenant. */
export function allowedResidencies(
  niche: AiNiche,
  sensitivity: DataSensitivity,
  tenantPolicy: TenantAiPolicy,
): ReadonlySet<DataResidency> {
  if (niche === 'psicologia') return new Set<DataResidency>(['BR']);
  switch (sensitivity) {
    case 'pseudonimizado':
      return new Set<DataResidency>(tenantPolicy.allowsInternationalTransfer ? ['BR', 'EXTERIOR'] : ['BR']);
    case 'nao_pessoal':
      return new Set<DataResidency>(['BR', 'EXTERIOR']);
    default:
      // 'sensivel' e qualquer valor desconhecido vindo de fora do tipo: somente BR.
      return new Set<DataResidency>(['BR']);
  }
}

export function routeRequest(input: RoutingInput, providers: readonly LlmProvider[]): RoutingDecision {
  if (!input.tenantPolicy.aiEnabled) return { allowed: false, reason: 'ia_desligada_na_clinica' };

  if (input.sensitivity !== 'nao_pessoal') {
    if (input.patientConsent === undefined) return { allowed: false, reason: 'consentimento_nao_informado' };
    if (input.patientConsent !== 'nao_recusou') return { allowed: false, reason: 'paciente_recusou_ia' };
  }

  const residencies = allowedResidencies(input.niche, input.sensitivity, input.tenantPolicy);
  const eligible = providers.filter((p) => p.tasks.includes(input.task) && residencies.has(p.residency));
  if (eligible.length === 0) return { allowed: false, reason: 'nenhuma_rota_elegivel' };

  const candidates = [
    ...eligible.filter((p) => p.residency === 'BR'),
    ...eligible.filter((p) => p.residency !== 'BR'),
  ];
  return { allowed: true, candidates };
}
