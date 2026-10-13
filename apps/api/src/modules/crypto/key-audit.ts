import { AuditAction, type UserId } from '@plataforma/shared';
import type { TenantTx } from '../../db/tenant-transaction';
import { recordAudit } from '../audit/audit-log';
import type { KeyAuditor, KeyEventKind } from './field-cipher';

/** Ator das rotinas do sistema (ex.: rotação automática por limite de uso). Não é um usuário. */
export const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000' as UserId;

/**
 * Auditor padrão das operações de chave: grava em `audit_log` na MESMA transação, então a operação
 * não acontece sem o registro (e, com a migração 0005, entra na cadeia de hash da clínica).
 *
 * Ações próprias de chave (migração 0006: key_provision, key_rotate, key_destroy); o escopo
 * `crypto.key.<operação>` distingue rotação de DEK e de KEK. Os metadados levam só o id da DEK
 * (uuid), nunca material de chave nem o ARN da chave mestra.
 */
const ACTION_BY_KIND: Readonly<Record<KeyEventKind, AuditAction>> = {
  provision: AuditAction.KeyProvision,
  rotate_dek: AuditAction.KeyRotate,
  rotate_kek: AuditAction.KeyRotate,
  destroy: AuditAction.KeyDestroy,
};

export const auditKeyEvents: KeyAuditor<TenantTx> = (tx, event) =>
  recordAudit(
    tx,
    { tenantId: event.tenantId, userId: (event.actorId ?? SYSTEM_ACTOR_ID) as UserId, roles: [] },
    {
      action: ACTION_BY_KIND[event.kind],
      scope: `crypto.key.${event.kind}`,
      metadata: event.keyId ? { key_id: event.keyId } : {},
    },
  );
