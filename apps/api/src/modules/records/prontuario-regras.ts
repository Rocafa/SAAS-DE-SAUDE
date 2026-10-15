/**
 * Regras puras do prontuário (sem banco): sigilo do compartimento de psicologia e hash da finalização.
 */
import { createHash } from 'node:crypto';
import type { PsychCompartmentMode, RecordCompartment } from '../../db/schema';

/** Padrão enquanto a pergunta 1.11 (Res. CFP 001/2009, art. 6º) não tem resposta: o mais protetor. */
export const MODO_PSICOLOGIA_PADRAO: PsychCompartmentMode = 'restrito_ao_autor';

/**
 * Quem já passou pelo porteiro (perfil clínico + vínculo de cuidado) lê o conteúdo, exceto o
 * compartimento de psicologia aberto no modo `restrito_ao_autor`: aí só o autor do registro.
 *
 * B1 do parecer do Guardião sobre o PR #63: vale o modo GRAVADO NO ATENDIMENTO na abertura
 * (`encounters.confidentiality`, migração 0015), nunca o da configuração atual da clínica. Trocar a
 * configuração vale só para atendimentos novos; o registro escrito sob "só o autor lê" continua assim.
 */
export function podeVerConteudo(
  registro: { readonly compartment: RecordCompartment; readonly authorUserId: string; readonly confidentiality: PsychCompartmentMode },
  usuarioId: string,
): boolean {
  if (registro.compartment !== 'psicologia') return true;
  if (registro.confidentiality === 'prontuario_unico') return true;
  return registro.authorUserId === usuarioId;
}

/**
 * SHA-256 do registro canônico da finalização: amarra atendimento, versão, modelo e o conteúdo
 * CIFRADO daquela versão (nunca o texto em claro, que não deve virar hash consultável no banco) ao
 * instante e a quem finalizou. Recalculável: trocar a versão ou o conteúdo depois deixa de bater.
 */
export function hashDaFinalizacao(r: {
  readonly tenantId: string;
  readonly encounterId: string;
  readonly versionId: string;
  readonly version: number;
  readonly template: string;
  readonly templateVersion: number;
  readonly contentEnc: string;
  readonly signedAt: Date;
  readonly signedBy: string;
}): string {
  const canonico = JSON.stringify([
    'v1',
    r.tenantId,
    r.encounterId,
    r.versionId,
    r.version,
    r.template,
    r.templateVersion,
    r.contentEnc,
    r.signedAt.toISOString(),
    r.signedBy,
  ]);
  return createHash('sha256').update(canonico, 'utf8').digest('hex');
}
