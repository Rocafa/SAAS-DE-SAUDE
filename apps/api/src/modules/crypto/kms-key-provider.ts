import type { TenantId } from '@plataforma/shared';
import { KeyUnavailableError, type KeyFailureKind } from './crypto-errors';
import { DataKey } from './data-key';
import { KEY_PURPOSE_IMPORT_BATCH, KEY_PURPOSE_TENANT_DATA, type GeneratedDataKey, type KeyProvider, type MasterKeyPurpose, type WrappedDataKey } from './key-provider';

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
  describeKey(input: { KeyId: string }): Promise<{ KeyMetadata?: { KeyState?: string | undefined } | undefined }>;
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

  /**
   * R3-b: a chave do LOTE nasce com descrição própria e as tags `purpose=import_batch` e `batch_id` (só
   * ids), diferente da chave da clínica (`purpose=tenant_data`). É o que permite ao IAM liberar
   * `ScheduleKeyDeletion` só nas chaves de lote e negar `CancelKeyDeletion`/`EnableKey` nelas (§12d).
   */
  async createMasterKey(tenantId: TenantId, finalidade: MasterKeyPurpose = { purpose: KEY_PURPOSE_TENANT_DATA }): Promise<string> {
    const lote = finalidade.purpose === KEY_PURPOSE_IMPORT_BATCH ? finalidade : null;
    const out = await guard(() =>
      this.kms.createKey({
        Description: lote
          ? 'plataforma-saude: chave descartável de um lote de importação (crypto-shredding do arquivo bruto)'
          : 'plataforma-saude: chave mestra de dados de uma clínica',
        KeyUsage: 'ENCRYPT_DECRYPT',
        KeySpec: 'SYMMETRIC_DEFAULT',
        Tags: [
          { TagKey: 'tenant_id', TagValue: tenantId },
          { TagKey: 'purpose', TagValue: finalidade.purpose },
          ...(lote ? [{ TagKey: 'batch_id', TagValue: lote.batchId }] : []),
        ],
      }),
    );
    const arn = out.KeyMetadata?.Arn;
    if (!arn) throw new KeyUnavailableError();
    // Rotação anual automática do material da chave da clínica (mesmo ARN; DEKs antigas continuam
    // abrindo). A chave de lote vive no máximo 7 dias: rotação não faria nada (observação da rodada 22).
    if (!lote) await guard(() => this.kms.enableKeyRotation({ KeyId: arn }));
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
    try {
      await this.kms.scheduleKeyDeletion({ KeyId: masterKeyId, PendingWindowInDays: KMS_DELETION_WINDOW_DAYS });
    } catch (agendar) {
      // Observação 2 da conferência R3-a/R3-b: passada a janela de 7 dias, o KMS já excluiu a chave e
      // responde NotFound (no agendamento ou no describe). Não existe mais nada que abra: conta como feita.
      if (isNotFound(agendar)) return;
      // Idempotente: uma tentativa anterior pode ter agendado e parado antes de gravar `destroyed`
      // (o agendamento repetido dá KMSInvalidStateException; o describe diz PendingDeletion).
      let estado: string | undefined;
      try {
        estado = (await this.kms.describeKey({ KeyId: masterKeyId })).KeyMetadata?.KeyState;
      } catch (descrever) {
        if (isNotFound(descrever)) return;
        throw new KeyUnavailableError(classifyKmsError(descrever));
      }
      if (estado !== 'PendingDeletion') throw new KeyUnavailableError(classifyKmsError(agendar));
    }
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

/** Erro do SDK pode trazer ARN, id de requisição e contexto: troca por erro de mensagem fixa (com o tipo). */
async function guard<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    throw new KeyUnavailableError(classifyKmsError(e));
  }
}

const ACESSO_NEGADO = new Set([
  'AccessDeniedException',
  'AccessDenied',
  'UnrecognizedClientException',
  'InvalidClientTokenId',
  'ExpiredTokenException',
  'IncompleteSignature',
  'InvalidSignatureException',
]);
const INDISPONIVEL = new Set([
  'ThrottlingException',
  'Throttling',
  'TooManyRequestsException',
  'LimitExceededException',
  'KMSInternalException',
  'DependencyTimeoutException',
  'KeyUnavailableException',
  'ServiceUnavailable',
  'ServiceUnavailableException',
  'InternalFailure',
  'RequestTimeout',
  'RequestTimeoutException',
  'TimeoutError',
  'NetworkingError',
]);
const ESTADO_INVALIDO = new Set(['KMSInvalidStateException', 'NotFoundException', 'DisabledException', 'InvalidArnException']);

/** Nome do erro do SDK v3 (`name`; em versões antigas, `Code`/`code`). Nunca lê a mensagem. */
function kmsErrorName(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const o = e as { name?: unknown; Code?: unknown; code?: unknown };
  for (const v of [o.name, o.Code, o.code]) if (typeof v === 'string' && v !== 'Error') return v;
  return undefined;
}

/**
 * Observação 3 da conferência R3-a/R3-b: o tipo da falha sai do NOME do erro e do código HTTP
 * (`$metadata.httpStatusCode`), nunca da mensagem (que pode trazer ARN e conta).
 */
export function classifyKmsError(e: unknown): KeyFailureKind {
  const name = kmsErrorName(e);
  if (name && ACESSO_NEGADO.has(name)) return 'acesso_negado';
  if (name && INDISPONIVEL.has(name)) return 'indisponivel';
  if (name && ESTADO_INVALIDO.has(name)) return 'estado_invalido';
  const status = (e as { $metadata?: { httpStatusCode?: unknown } } | null)?.$metadata?.httpStatusCode;
  if (typeof status === 'number') {
    if (status === 401 || status === 403) return 'acesso_negado';
    if (status === 429 || status >= 500) return 'indisponivel';
  }
  return 'outro';
}

/** A chave não existe mais no KMS (a exclusão agendada venceu a janela de 7 dias). */
function isNotFound(e: unknown): boolean {
  return kmsErrorName(e) === 'NotFoundException';
}
