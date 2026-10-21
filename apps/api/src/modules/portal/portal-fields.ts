import type { TenantId, UserId } from '@plataforma/shared';
import type { TenantTx } from '../../db/tenant-transaction';
import { TenantKeyMissingError } from '../crypto/crypto-errors';
import type { FieldCipher } from '../crypto/field-cipher';
import type { FieldRef } from '../crypto/field-format';

/**
 * Colunas cifradas do portal (migração 0027). Tabela e coluna entram no AAD (com a clínica e o id da
 * linha): não renomear sem recifrar. O detalhe do pedido do titular pode conter dado de saúde (texto
 * livre do paciente) e a resposta da clínica também: só cifrados.
 */
export type CampoPortal = 'detail' | 'answer';

export function campoPortalRef(tenantId: TenantId, rowId: string, campo: CampoPortal): FieldRef {
  return { tenantId, table: 'portal_rights_requests', column: campo, rowId };
}

/**
 * Cifra com a chave da clínica. Na primeira escrita cifrada da CLÍNICA (`atorId` = usuário da clínica)
 * provisiona a chave (idempotente, auditado). Pelo PORTAL (`atorId` null) NUNCA provisiona (V2 do parecer
 * do #68; o banco também recusa INSERT de chave na sessão do portal, migração 0033): sem chave, falha
 * fechada (`TenantKeyMissingError`) e a clínica provisiona.
 */
export async function cifrarCampoPortal(
  cipher: FieldCipher<TenantTx>,
  tx: TenantTx,
  tenantId: TenantId,
  atorId: UserId | null,
  rowId: string,
  campo: CampoPortal,
  valor: string,
): Promise<string> {
  const ref = campoPortalRef(tenantId, rowId, campo);
  try {
    return await cipher.encrypt(tx, ref, valor);
  } catch (e) {
    if (!(e instanceof TenantKeyMissingError) || atorId === null) throw e;
    await cipher.provisionTenant(tx, tenantId, atorId);
    return cipher.encrypt(tx, ref, valor);
  }
}

export async function decifrarCampoPortal(
  cipher: FieldCipher<TenantTx>,
  tx: TenantTx,
  tenantId: TenantId,
  rowId: string,
  campo: CampoPortal,
  valor: string | null,
): Promise<string | null> {
  return valor === null ? null : cipher.decryptString(tx, campoPortalRef(tenantId, rowId, campo), valor);
}
