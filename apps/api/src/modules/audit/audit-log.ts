import type { AuditAction, RequestContext, UserId } from '@plataforma/shared';
import { auditLog, type ActorKind, type AuditMetadata } from '../../db/schema';
import type { TenantTx } from '../../db/tenant-transaction';
import { assertAuditMetadata } from './audit-metadata';

/** Ator das rotinas do sistema (ex.: rotação automática por limite de uso). Não é um usuário. */
export const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000' as UserId;

export interface AuditEntry {
  readonly action: AuditAction;
  /** Escopo da ação (ex.: `tenant.full_export`, `patients`). Minúsculas, sem dado pessoal. */
  readonly scope: string;
  /** Somente metadados escalares (contagens, versões). NUNCA conteúdo clínico ou PII de paciente. */
  readonly metadata?: AuditMetadata;
}

/** Tipo de ator de um contexto de requisição: sistema (id zero) ou usuário da clínica. */
export function actorKindOf(ctx: RequestContext): Extract<ActorKind, 'sistema' | 'usuario_clinica'> {
  return ctx.userId === SYSTEM_ACTOR_ID ? 'sistema' : 'usuario_clinica';
}

/** Gravação crua: valida o metadata (contrato da 0005) e insere na transação do chamador. */
export async function insertAudit(
  tx: TenantTx,
  row: { readonly tenantId: string; readonly actorId: string; readonly actorKind: ActorKind },
  entry: AuditEntry,
): Promise<void> {
  // Contrato do metadata (0005): falha aqui, antes do banco, com o motivo e sem repetir o valor.
  assertAuditMetadata(entry.metadata ?? {});
  await tx.insert(auditLog).values({
    tenantId: row.tenantId,
    actorId: row.actorId,
    actorKind: row.actorKind,
    action: entry.action,
    scope: entry.scope,
    metadata: entry.metadata ?? {},
  });
}

/**
 * Grava um evento na trilha append-only, dentro da transação do chamador (mesmo contexto de
 * tenant). Se a gravação falhar, a operação auditada falha junto: não há ação sem registro.
 * Ator: usuário da clínica (id real) ou sistema. Acesso da equipe de suporte da plataforma NÃO
 * passa por aqui: usa `recordSupportAudit` (ator-suporte.ts), que grava o pseudônimo.
 */
export async function recordAudit(tx: TenantTx, ctx: RequestContext, entry: AuditEntry): Promise<void> {
  await insertAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.userId, actorKind: actorKindOf(ctx) }, entry);
}
