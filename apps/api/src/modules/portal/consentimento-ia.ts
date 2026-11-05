import type { TenantId } from '@plataforma/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import { portalConsents, type AiConsentState } from '../../db/schema';
import type { TenantTx } from '../../db/tenant-transaction';
import { hojeNaClinica } from '../insurance/guias-regras';
import { consentimentoIa, estadoDoConsentimento, eventoVale } from './portal-regras';

/**
 * FONTE ÚNICA do consentimento de IA do paciente (A5 do parecer do #68; R15 do front-r8; Res. CFM 2.454/2026).
 *
 * A verdade é o ÚLTIMO evento `escriba_ia` de `portal_consents` que ainda VALE (histórico append-only, com
 * versão e hash do texto apresentado; o evento de um responsável deixa de valer quando a representação
 * acaba, V1 do #68). Nenhum evento, ou `desfeito`, = `nao_informado`, que NEGA. O gateway de IA (escriba)
 * deve chamar SÓ esta função antes de qualquer envio, na transação da clínica: um "não" dado no portal
 * bloqueia o escriba.
 *
 * `encounters.ai_consent` (0012) deixa de ser fonte de permissão: é só o REGISTRO do que foi informado no
 * atendimento (retrato no prontuário). Quando o escriba for ligado, a resposta dada no consultório entra
 * como evento nesta mesma trilha (canal próprio), nunca só no atendimento.
 */
export async function consentimentoIaDoPaciente(tx: TenantTx, tenantId: TenantId, pacienteId: string): Promise<AiConsentState> {
  const eventos = await tx
    .select({
      response: portalConsents.response,
      actingAs: portalConsents.actingAs,
      representUntil: portalConsents.representUntil,
      representationEndedAt: portalConsents.representationEndedAt,
      guardianLinkOk: sql<boolean | null>`app_portal_guardian_link_ok(${portalConsents.tenantId}, ${portalConsents.guardianLinkId})`,
    })
    .from(portalConsents)
    .where(and(eq(portalConsents.tenantId, tenantId), eq(portalConsents.patientId, pacienteId), eq(portalConsents.purpose, 'escriba_ia')))
    .orderBy(asc(portalConsents.createdAt), asc(portalConsents.id));
  const hoje = hojeNaClinica();
  return consentimentoIa(estadoDoConsentimento(eventos.filter((e) => eventoVale(e, hoje)).at(-1)?.response));
}
