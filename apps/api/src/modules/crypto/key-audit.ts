import { AuditAction, type UserId } from '@plataforma/shared';
import type { TenantTx } from '../../db/tenant-transaction';
import { recordAudit } from '../audit/audit-log';
import type { KeyAuditor } from './field-cipher';

/** Ator das rotinas do sistema (ex.: rotação automática por limite de uso). Não é um usuário. */
export const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000' as UserId;

/**
 * Auditor padrão das operações de chave: grava em `audit_log` na MESMA transação, então a operação
 * não acontece sem o registro (e, com a migração 0005, entra na cadeia de hash da clínica).
 *
 * Usa as ações já existentes (`create`/`update`) com escopo `crypto.key.<operação>`; os metadados
 * levam só o id da chave, nunca material de chave.
 */
export const auditKeyEvents: KeyAuditor<TenantTx> = (tx, event) =>
  recordAudit(
    tx,
    { tenantId: event.tenantId, userId: (event.actorId ?? SYSTEM_ACTOR_ID) as UserId, roles: [] },
    {
      action: event.kind === 'provision' ? AuditAction.Create : AuditAction.Update,
      scope: `crypto.key.${event.kind}`,
      metadata: event.keyId ? { key_id: event.keyId } : {},
    },
  );
