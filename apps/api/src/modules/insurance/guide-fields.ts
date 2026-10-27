import type { RequestContext, TenantId } from '@plataforma/shared';
import type { TenantTx } from '../../db/tenant-transaction';
import { TenantKeyMissingError } from '../crypto/crypto-errors';
import type { FieldCipher } from '../crypto/field-cipher';
import type { FieldRef } from '../crypto/field-format';

/**
 * Colunas cifradas de `insurance_guides` (migração 0011): número da guia, senha de autorização e nº
 * da carteirinha identificam o paciente na operadora. O nome entra no AAD: não renomear sem recifrar.
 */
export type GuideEncryptedColumn = 'number' | 'authorization_code' | 'card_number';

/** AAD = clínica + tabela + coluna + id da linha (mesmo esquema de patients). */
export function guideFieldRef(tenantId: TenantId, rowId: string, column: GuideEncryptedColumn): FieldRef {
  return { tenantId, table: 'insurance_guides', column, rowId };
}

/** Cifra com a chave da clínica; na primeira escrita cifrada provisiona a chave (idempotente, auditado). */
export async function cifrarCampoDaGuia(
  cipher: FieldCipher<TenantTx>,
  tx: TenantTx,
  ctx: RequestContext,
  rowId: string,
  coluna: GuideEncryptedColumn,
  valor: string,
): Promise<string> {
  const ref = guideFieldRef(ctx.tenantId, rowId, coluna);
  try {
    return await cipher.encrypt(tx, ref, valor);
  } catch (e) {
    if (!(e instanceof TenantKeyMissingError)) throw e;
    await cipher.provisionTenant(tx, ctx.tenantId, ctx.userId);
    return cipher.encrypt(tx, ref, valor);
  }
}

export async function decifrarCampoDaGuia(
  cipher: FieldCipher<TenantTx>,
  tx: TenantTx,
  tenantId: TenantId,
  rowId: string,
  coluna: GuideEncryptedColumn,
  valor: string | null,
): Promise<string | null> {
  return valor === null ? null : cipher.decryptString(tx, guideFieldRef(tenantId, rowId, coluna), valor);
}
