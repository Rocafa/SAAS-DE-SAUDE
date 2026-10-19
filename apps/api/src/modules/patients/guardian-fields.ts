import type { RequestContext, TenantId } from '@plataforma/shared';
import type { TenantTx } from '../../db/tenant-transaction';
import { TenantKeyMissingError } from '../crypto/crypto-errors';
import type { FieldCipher } from '../crypto/field-cipher';
import type { FieldRef } from '../crypto/field-format';

/**
 * Colunas cifradas de `guardians` (migração 0028). O nome entra no AAD (clínica + tabela + coluna + id da
 * PESSOA): não renomear sem recifrar. O histórico guarda o valor anterior com o MESMO AAD (é cópia do
 * texto cifrado de guardians), então decifra-se com esta referência também.
 */
export type GuardianEncryptedColumn = 'name' | 'cpf' | 'phone';

export function guardianFieldRef(tenantId: TenantId, guardianId: string, column: GuardianEncryptedColumn): FieldRef {
  return { tenantId, table: 'guardians', column, rowId: guardianId };
}

/** Cifra com a chave da clínica; na primeira escrita cifrada provisiona a chave (idempotente, auditado). */
export async function cifrarCampoResponsavel(
  cipher: FieldCipher<TenantTx>,
  tx: TenantTx,
  ctx: RequestContext,
  guardianId: string,
  column: GuardianEncryptedColumn,
  valor: string,
): Promise<string> {
  const ref = guardianFieldRef(ctx.tenantId, guardianId, column);
  try {
    return await cipher.encrypt(tx, ref, valor);
  } catch (e) {
    if (!(e instanceof TenantKeyMissingError)) throw e;
    await cipher.provisionTenant(tx, ctx.tenantId, ctx.userId);
    return cipher.encrypt(tx, ref, valor);
  }
}

export async function decifrarCampoResponsavel(
  cipher: FieldCipher<TenantTx>,
  tx: TenantTx,
  tenantId: TenantId,
  guardianId: string,
  column: GuardianEncryptedColumn,
  valor: string | null,
): Promise<string | null> {
  return valor === null ? null : cipher.decryptString(tx, guardianFieldRef(tenantId, guardianId, column), valor);
}
