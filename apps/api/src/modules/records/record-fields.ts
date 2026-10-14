import type { RequestContext, TenantId } from '@plataforma/shared';
import type { TenantTx } from '../../db/tenant-transaction';
import { TenantKeyMissingError } from '../crypto/crypto-errors';
import type { FieldCipher } from '../crypto/field-cipher';
import type { FieldRef } from '../crypto/field-format';

/**
 * Colunas cifradas do prontuário (migração 0012). Tabela e coluna entram no AAD (com a clínica e o
 * id da linha): não renomear sem recifrar. Copiar a cifra de uma versão para outra linha, outra
 * tabela ou outra clínica faz a decifragem falhar.
 */
export type CampoClinico =
  | { readonly table: 'clinical_record_versions'; readonly column: 'content' }
  | { readonly table: 'clinical_addenda'; readonly column: 'text' }
  | { readonly table: 'private_notes'; readonly column: 'content' };

export const CAMPO_VERSAO: CampoClinico = { table: 'clinical_record_versions', column: 'content' };
export const CAMPO_ADENDO: CampoClinico = { table: 'clinical_addenda', column: 'text' };
export const CAMPO_NOTA: CampoClinico = { table: 'private_notes', column: 'content' };

export function campoClinicoRef(tenantId: TenantId, rowId: string, campo: CampoClinico): FieldRef {
  return { tenantId, table: campo.table, column: campo.column, rowId };
}

/** Cifra com a chave da clínica; na primeira escrita cifrada provisiona a chave (idempotente, auditado). */
export async function cifrarCampoClinico(
  cipher: FieldCipher<TenantTx>,
  tx: TenantTx,
  ctx: RequestContext,
  rowId: string,
  campo: CampoClinico,
  valor: string,
): Promise<string> {
  const ref = campoClinicoRef(ctx.tenantId, rowId, campo);
  try {
    return await cipher.encrypt(tx, ref, valor);
  } catch (e) {
    if (!(e instanceof TenantKeyMissingError)) throw e;
    await cipher.provisionTenant(tx, ctx.tenantId, ctx.userId);
    return cipher.encrypt(tx, ref, valor);
  }
}

export function decifrarCampoClinico(
  cipher: FieldCipher<TenantTx>,
  tx: TenantTx,
  tenantId: TenantId,
  rowId: string,
  campo: CampoClinico,
  valor: string,
): Promise<string> {
  return cipher.decryptString(tx, campoClinicoRef(tenantId, rowId, campo), valor);
}
