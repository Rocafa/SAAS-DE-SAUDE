/**
 * Ator interno (equipe de suporte da plataforma) na trilha de auditoria — Decisão 1 do Guardião
 * (parecer PR #57), migração 0008.
 *
 * A trilha sai no pacote de exportação da clínica (G2) com os campos da cadeia de hash. O atendente
 * do suporte é gravado JÁ pseudonimizado no INSERT (reescrever na saída quebraria o hash):
 *
 *   actor_id = UUID derivado de HMAC-SHA256(segredo do servidor, tenant_id || 0x1f || id do atendente)
 *
 * - por clínica: o mesmo atendente tem sempre o mesmo pseudônimo DENTRO da clínica (dá para ver que
 *   "o suporte X" fez A e B), mas o id não liga duas clínicas nem chega à pessoa;
 * - o segredo (SUPPORT_PSEUDONYM_KEY) fica no Secrets Manager, fora do banco e fora do papel da API;
 * - a reidentificação (pseudônimo -> pessoa) é do operador, com acesso restrito ao DPO/segurança;
 * - todo acesso de suporte leva o número do chamado (`ticket`) e o motivo (`reason`) no metadata,
 *   sem nome. O CHECK da 0008 recusa linha de suporte sem eles.
 */
import { createHmac, randomBytes } from 'node:crypto';
import type { TenantId } from '@plataforma/shared';
import type { TenantTx } from '../../db/tenant-transaction';
import { insertAudit, type AuditEntry } from './audit-log';

export const SUPPORT_PSEUDONYM_KEY_MIN_BYTES = 32;
export const MOTIVOS_DE_SUPORTE = ['pedido_da_clinica', 'break_glass'] as const;
export type MotivoDeSuporte = (typeof MOTIVOS_DE_SUPORTE)[number];

const CHAMADO_RE = /^SUP-\d{1,7}$/;
/** Id interno do atendente no diretório do operador: opaco, curto, sem espaço nem controle. */
const ATENDENTE_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export class AcessoDeSuporteInvalidoError extends Error {
  constructor(readonly campo: 'chamado' | 'atendente' | 'motivo' | 'metadata') {
    super(`acesso de suporte inválido: ${campo}`);
    this.name = 'AcessoDeSuporteInvalidoError';
  }
}

let chaveDoProcesso: Buffer | undefined;

/**
 * Segredo do pseudônimo. Obrigatório (≥ 32 bytes) fora de development/test (lista fechada, como a
 * chave local e a sessão fictícia): staging e produção não sobem acesso de suporte sem ele. Em
 * development/test, sem a variável, usa um segredo aleatório por processo (pseudônimo só estável
 * dentro do processo, o que basta para testes).
 */
export function loadSupportPseudonymKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.SUPPORT_PSEUDONYM_KEY?.trim();
  if (raw) {
    const key = Buffer.from(raw, 'base64');
    if (key.length < SUPPORT_PSEUDONYM_KEY_MIN_BYTES) {
      throw new Error(`SUPPORT_PSEUDONYM_KEY precisa de ao menos ${SUPPORT_PSEUDONYM_KEY_MIN_BYTES} bytes (base64)`);
    }
    return key;
  }
  if (env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test') {
    throw new Error('SUPPORT_PSEUDONYM_KEY é obrigatória fora de development/test (pseudônimo do suporte)');
  }
  chaveDoProcesso ??= randomBytes(SUPPORT_PSEUDONYM_KEY_MIN_BYTES);
  return chaveDoProcesso;
}

/** Pseudônimo do atendente nesta clínica, no formato UUID (versão 8, variante RFC 9562). */
export function supportActorPseudonym(key: Uint8Array, tenantId: TenantId, atendenteId: string): string {
  if (key.length < SUPPORT_PSEUDONYM_KEY_MIN_BYTES) throw new Error('segredo do pseudônimo curto demais');
  if (!ATENDENTE_RE.test(atendenteId)) throw new AcessoDeSuporteInvalidoError('atendente');
  const b = createHmac('sha256', key).update(`${tenantId}\u001f${atendenteId}`, 'utf8').digest().subarray(0, 16);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x80; // versão 8 (formato definido pela aplicação)
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80; // variante RFC 9562
  const h = b.toString('hex');
  const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  // Nunca colide com o ator do sistema (versão 8 garante bits não nulos), mas a regra fica explícita.
  if (id === '00000000-0000-0000-0000-000000000000') throw new Error('pseudônimo inválido');
  return id;
}

export interface AcessoDeSuporte {
  readonly tenantId: TenantId;
  /** Id do atendente no diretório do operador. Nunca vai para o banco da clínica. */
  readonly atendenteId: string;
  /** Número do chamado aberto pela clínica (ou do break-glass), ex.: `SUP-1234`. */
  readonly chamado: string;
  readonly motivo: MotivoDeSuporte;
}

/**
 * Grava, na transação do chamador, um evento feito pela equipe de suporte: ator pseudonimizado,
 * `actor_kind = suporte_plataforma`, chamado e motivo no metadata.
 */
export async function recordSupportAudit(
  tx: TenantTx,
  key: Uint8Array,
  acesso: AcessoDeSuporte,
  entry: AuditEntry,
): Promise<void> {
  if (!CHAMADO_RE.test(acesso.chamado)) throw new AcessoDeSuporteInvalidoError('chamado');
  if (!(MOTIVOS_DE_SUPORTE as readonly string[]).includes(acesso.motivo)) throw new AcessoDeSuporteInvalidoError('motivo');
  const metadata = entry.metadata ?? {};
  if ('ticket' in metadata || 'reason' in metadata) throw new AcessoDeSuporteInvalidoError('metadata');
  await insertAudit(
    tx,
    {
      tenantId: acesso.tenantId,
      actorId: supportActorPseudonym(key, acesso.tenantId, acesso.atendenteId),
      actorKind: 'suporte_plataforma',
    },
    { ...entry, metadata: { ...metadata, ticket: acesso.chamado, reason: acesso.motivo } },
  );
}
