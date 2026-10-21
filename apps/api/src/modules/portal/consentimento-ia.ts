import type { TenantId } from '@plataforma/shared';
import { and, desc, eq } from 'drizzle-orm';
import { portalConsents, type AiConsentState } from '../../db/schema';
import type { TenantTx } from '../../db/tenant-transaction';
import { consentimentoIa, estadoDoConsentimento } from './portal-regras';

/**
 * FONTE ÚNICA do consentimento de IA do paciente (A5 do parecer do #68; R15 do front-r8; Res. CFM 2.454/2026).
 *
 * A verdade é o ÚLTIMO evento `escriba_ia` de `portal_consents` (histórico append-only, com versão e hash do
 * texto apresentado). Nenhum evento, ou `desfeito`, = `nao_informado`, que NEGA. O gateway de IA (escriba)
 * deve chamar SÓ esta função antes de qualquer envio, na transação da clínica: um "não" dado no portal
 * bloqueia o escriba.
 *
 * `encounters.ai_consent` (0012) deixa de ser fonte de permissão: é só o REGISTRO do que foi informado no
 * atendimento (retrato no prontuário). Quando o escriba for ligado, a recepção/profissional registra a
 * resposta dada no consultório como evento nesta mesma trilha (canal próprio), nunca só no atendimento.
 */
export async function consentimentoIaDoPaciente(tx: TenantTx, tenantId: TenantId, pacienteId: string): Promise<AiConsentState> {
  const [ultimo] = await tx
    .select({ response: portalConsents.response })
    .from(portalConsents)
    .where(and(eq(portalConsents.tenantId, tenantId), eq(portalConsents.patientId, pacienteId), eq(portalConsents.purpose, 'escriba_ia')))
    .orderBy(desc(portalConsents.createdAt), desc(portalConsents.id))
    .limit(1);
  return consentimentoIa(estadoDoConsentimento(ultimo?.response));
}
