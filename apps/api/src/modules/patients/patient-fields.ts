import type { TenantId } from '@plataforma/shared';
import type { FieldRef } from '../crypto/field-format';

/** Colunas cifradas de `patients` (migração 0007). O nome entra no AAD: não renomear sem recifrar. */
export type PatientEncryptedColumn = 'cpf' | 'phone' | 'birth_date';

/** Referência do campo cifrado: AAD = clínica + tabela + coluna + id da linha. */
export function patientFieldRef(tenantId: TenantId, rowId: string, column: PatientEncryptedColumn): FieldRef {
  return { tenantId, table: 'patients', column, rowId };
}
