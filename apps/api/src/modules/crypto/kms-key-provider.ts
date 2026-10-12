import type { TenantId } from '@plataforma/shared';
import { KeyUnavailableError } from './crypto-errors';
import { DataKey } from './data-key';
import type { GeneratedDataKey, KeyProvider, WrappedDataKey } from './key-provider';

/**
 * Subconjunto da API do AWS KMS usado aqui, com os nomes e formatos do SDK v3
 * (`new KMS({ region: 'sa-east-1' })` de `@aws-sdk/client-kms` deve satisfazer esta interface).
 * Mantido como interface para a API não depender do SDK até a infraestrutura existir (Portão A).
 */
export interface KmsApi {
  createKey(input: {
    Description: string;
    KeyUsage: 'ENCRYPT_DECRYPT';
    KeySpec: 'SYMMETRIC_DEFAULT';
    Tags: { TagKey: string; TagValue: string }[];
  }): Promise<{ KeyMetadata?: { Arn?: string | undefined } | undefined }>;
  enableKeyRotation(input: { KeyId: string }): Promise<unknown>;
  generateDataKey(input: {
    KeyId: string;
    KeySpec: 'AES_256';
    EncryptionContext: Record<string, string>;
  }): Promise<{ Plaintext?: Uint8Array | undefined; CiphertextBlob?: Uint8Array | undefined }>;
  decrypt(input: {
    KeyId: string;
    CiphertextBlob: Uint8Array;
    EncryptionContext: Record<string, string>;
  }): Promise<{ Plaintext?: Uint8Array | undefined }>;
  reEncrypt(input: {
    CiphertextBlob: Uint8Array;
    SourceKeyId: string;
    SourceEncryptionContext: Record<string, string>;
    DestinationKeyId: string;
    DestinationEncryptionContext: Record<string, string>;
  }): Promise<{ CiphertextBlob?: Uint8Array | undefined }>;
  scheduleKeyDeletion(input: { KeyId: string; PendingWindowInDays: number }): Promise<unknown>;
  cancelKeyDeletion(input: { KeyId: string }): Promise<unknown>;
  enableKey(input: { KeyId: string }): Promise<unknown>;
}

/** Mínimo permitido pelo KMS. Dentro da janela a destruição ainda pode ser cancelada. */
export const KMS_DELETION_WINDOW_DAYS = 7;

/**
 * Chave mestra no AWS KMS, uma por clínica (custo e limites em criptografia-de-campo.md).
 * `EncryptionContext = { tenant_id }` amarra cada DEK à clínica e aparece no CloudTrail.
 * A DEK em claro nunca é gravada; a chave mestra nunca sai do KMS.
 */
export class KmsKeyProvider implements KeyProvider {
  constructor(private readonly kms: KmsApi) {}

  async createMasterKey(tenantId: TenantId): Promise<string> {
    const out = await guard(() =>
      this.kms.createKey({
        Description: 'plataforma-saude: chave mestra de dados de uma clínica',
        KeyUsage: 'ENCRYPT_DECRYPT',
        KeySpec: 'SYMMETRIC_DEFAULT',
        Tags: [{ TagKey: 'tenant_id', TagValue: tenantId }],
      }),
    );
    const arn = out.KeyMetadata?.Arn;
    if (!arn) throw new KeyUnavailableError();
    // Rotação anual automática do material da chave (mesmo ARN; DEKs antigas continuam abrindo).
    await guard(() => this.kms.enableKeyRotation({ KeyId: arn }));
    return arn;
  }

  async generateDataKey(masterKeyId: string, tenantId: TenantId): Promise<GeneratedDataKey> {
    const out = await guard(() =>
      this.kms.generateDataKey({ KeyId: masterKeyId, KeySpec: 'AES_256', EncryptionContext: context(tenantId) }),
    );
    if (!out.Plaintext || !out.CiphertextBlob) throw new KeyUnavailableError();
    try {
      return { masterKeyId, wrapped: Buffer.from(out.CiphertextBlob), plaintext: DataKey.fromBytes(out.Plaintext) };
    } finally {
      out.Plaintext.fill(0);
    }
  }

  async unwrapDataKey(key: WrappedDataKey, tenantId: TenantId): Promise<DataKey> {
    const out = await guard(() =>
      this.kms.decrypt({ KeyId: key.masterKeyId, CiphertextBlob: key.wrapped, EncryptionContext: context(tenantId) }),
    );
    if (!out.Plaintext) throw new KeyUnavailableError();
    try {
      return DataKey.fromBytes(out.Plaintext);
    } finally {
      out.Plaintext.fill(0);
    }
  }

  async rewrapDataKey(key: WrappedDataKey, targetMasterKeyId: string, tenantId: TenantId): Promise<WrappedDataKey> {
    // ReEncrypt acontece dentro do KMS: a DEK em claro nem passa pela aplicação.
    const out = await guard(() =>
      this.kms.reEncrypt({
        CiphertextBlob: key.wrapped,
        SourceKeyId: key.masterKeyId,
        SourceEncryptionContext: context(tenantId),
        DestinationKeyId: targetMasterKeyId,
        DestinationEncryptionContext: context(tenantId),
      }),
    );
    if (!out.CiphertextBlob) throw new KeyUnavailableError();
    return { masterKeyId: targetMasterKeyId, wrapped: Buffer.from(out.CiphertextBlob) };
  }

  async destroyMasterKey(masterKeyId: string): Promise<void> {
    await guard(() => this.kms.scheduleKeyDeletion({ KeyId: masterKeyId, PendingWindowInDays: KMS_DELETION_WINDOW_DAYS }));
  }

  async cancelMasterKeyDestruction(masterKeyId: string): Promise<void> {
    // Cancelar deixa a chave "Disabled" (documentação do KMS): é preciso reabilitar.
    await guard(() => this.kms.cancelKeyDeletion({ KeyId: masterKeyId }));
    await guard(() => this.kms.enableKey({ KeyId: masterKeyId }));
  }
}

function context(tenantId: TenantId): Record<string, string> {
  return { tenant_id: tenantId };
}

/** Erro do SDK pode trazer ARN, id de requisição e contexto: troca por erro de mensagem fixa. */
async function guard<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch {
    throw new KeyUnavailableError();
  }
}
