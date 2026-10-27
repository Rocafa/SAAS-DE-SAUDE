import type { RequestContext, TenantId } from '@plataforma/shared';
import type { TenantTx } from '../../db/tenant-transaction';
import { TenantKeyMissingError } from '../crypto/crypto-errors';
import type { FieldCipher } from '../crypto/field-cipher';
import type { FieldRef } from '../crypto/field-format';

/**
 * Colunas cifradas do financeiro (migração 0018). Tabela e coluna entram no AAD (com a clínica e o id
 * da linha): não renomear sem recifrar. O perfil fiscal usa o id do PROFISSIONAL como id da linha.
 */
export type CampoFinanceiro =
  | { readonly table: 'charges'; readonly column: 'payer_cpf' }
  | { readonly table: 'professional_fiscal_profiles'; readonly column: 'cpf' }
  | { readonly table: 'receipts'; readonly column: 'content' }
  | { readonly table: 'payments'; readonly column: 'guardian_payer' };

export const CAMPO_CPF_PAGADOR: CampoFinanceiro = { table: 'charges', column: 'payer_cpf' };
export const CAMPO_CPF_PROFISSIONAL: CampoFinanceiro = { table: 'professional_fiscal_profiles', column: 'cpf' };
export const CAMPO_RECIBO: CampoFinanceiro = { table: 'receipts', column: 'content' };
/** 0031 (V1 do #67): retrato JSON { nome, cpf } do responsável pagador congelado no recebimento. */
export const CAMPO_PAGADOR_DO_RECEBIMENTO: CampoFinanceiro = { table: 'payments', column: 'guardian_payer' };

export function campoFinanceiroRef(tenantId: TenantId, rowId: string, campo: CampoFinanceiro): FieldRef {
  return { tenantId, table: campo.table, column: campo.column, rowId };
}

/** Cifra com a chave da clínica; na primeira escrita cifrada provisiona a chave (idempotente, auditado). */
export async function cifrarCampoFinanceiro(
  cipher: FieldCipher<TenantTx>,
  tx: TenantTx,
  ctx: RequestContext,
  rowId: string,
  campo: CampoFinanceiro,
  valor: string,
): Promise<string> {
  const ref = campoFinanceiroRef(ctx.tenantId, rowId, campo);
  try {
    return await cipher.encrypt(tx, ref, valor);
  } catch (e) {
    if (!(e instanceof TenantKeyMissingError)) throw e;
    await cipher.provisionTenant(tx, ctx.tenantId, ctx.userId);
    return cipher.encrypt(tx, ref, valor);
  }
}

export async function decifrarCampoFinanceiro(
  cipher: FieldCipher<TenantTx>,
  tx: TenantTx,
  tenantId: TenantId,
  rowId: string,
  campo: CampoFinanceiro,
  valor: string | null,
): Promise<string | null> {
  return valor === null ? null : cipher.decryptString(tx, campoFinanceiroRef(tenantId, rowId, campo), valor);
}
