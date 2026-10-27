import type { TenantId } from '@plataforma/shared';
import type { DataKey } from './data-key';

/** DEK cifrada pela chave mestra da clínica, como fica gravada em `tenant_data_keys`. */
export interface WrappedDataKey {
  /** ARN no KMS (produção) ou id do provedor local. Não é segredo. */
  readonly masterKeyId: string;
  readonly wrapped: Buffer;
}

export interface GeneratedDataKey extends WrappedDataKey {
  readonly plaintext: DataKey;
}

/**
 * Fronteira com quem guarda as chaves mestras (KEK). Toda chamada amarra a operação à clínica
 * (no KMS, `EncryptionContext`; no provedor local, AAD): uma DEK cifrada para a clínica A não abre
 * se for apresentada como da clínica B, mesmo sob a mesma chave mestra.
 *
 * Implementações: `KmsKeyProvider` (produção, AWS KMS em sa-east-1) e `LocalKeyProvider`
 * (dev/teste; recusa NODE_ENV=production).
 */
/**
 * Finalidade da chave mestra (R3-b do parecer do importador). Vai na tag `purpose` e na descrição, para o
 * IAM distinguir a chave da CLÍNICA (nunca agendada para exclusão pela API) da chave descartável de um
 * LOTE de importação (a API pode agendar a exclusão; `CancelKeyDeletion`/`EnableKey` negados).
 */
export type MasterKeyPurpose = { readonly purpose: 'tenant_data' } | { readonly purpose: 'import_batch'; readonly batchId: string };

/** Valores da tag `purpose` (o IAM do devops usa exatamente estes textos). */
export const KEY_PURPOSE_TENANT_DATA = 'tenant_data';
export const KEY_PURPOSE_IMPORT_BATCH = 'import_batch';

export interface KeyProvider {
  /**
   * Cria uma chave mestra. Sem `finalidade` (ou `tenant_data`): a chave EXCLUSIVA da clínica, uma por
   * clínica (é o que permite o crypto-shredding da clínica). `import_batch`: chave descartável de um lote.
   */
  createMasterKey(tenantId: TenantId, finalidade?: MasterKeyPurpose): Promise<string>;
  /** Gera uma DEK nova: devolve a chave em claro (só memória) e a versão cifrada (para o banco). */
  generateDataKey(masterKeyId: string, tenantId: TenantId): Promise<GeneratedDataKey>;
  unwrapDataKey(key: WrappedDataKey, tenantId: TenantId): Promise<DataKey>;
  /** Re-cifra a DEK sob outra chave mestra (rotação da KEK) sem mexer nos dados. */
  rewrapDataKey(key: WrappedDataKey, targetMasterKeyId: string, tenantId: TenantId): Promise<WrappedDataKey>;
  /**
   * Crypto-shredding: agenda a destruição da chave mestra. A partir daqui ela não abre mais nada;
   * até o fim da janela (KMS: 7 dias) a destruição ainda pode ser cancelada.
   */
  destroyMasterKey(masterKeyId: string, tenantId: TenantId): Promise<void>;
  /** Desfaz um agendamento de destruição (compensação quando a destruição da clínica falha no meio). */
  cancelMasterKeyDestruction(masterKeyId: string, tenantId: TenantId): Promise<void>;
}
