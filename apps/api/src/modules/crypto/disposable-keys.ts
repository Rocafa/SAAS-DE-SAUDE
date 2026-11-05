import type { TenantId } from '@plataforma/shared';
import { KeyUnavailableError } from './crypto-errors';
import { openField, parseField, sealField, type FieldRef, assertFieldRef } from './field-format';
import { KEY_PURPOSE_IMPORT_BATCH, type KeyProvider, type WrappedDataKey } from './key-provider';

/**
 * Chave DESCARTÁVEL de um escopo curto (ex.: um lote de importação, R3 do parecer do importador).
 *
 * Por que não basta uma DEK embrulhada pela chave da clínica: a DEK embrulhada mora no MESMO banco que
 * o texto cifrado, então o backup leva as duas juntas e, com a chave da clínica viva, o backup abre.
 * Apagar a linha não alcança o backup. Para "ilegível até em backup" quem embrulha a DEK tem de ser
 * destruível sozinho: aqui é uma chave mestra própria do escopo, criada pela MESMA porta `KeyProvider`
 * (KMS em produção, provedor local em dev/teste), marcada com a clínica (tag `tenant_id`) e com a DEK
 * amarrada à clínica (`EncryptionContext`/AAD). Destruir = `destroyMasterKey` (KMS: exclusão agendada,
 * a chave para de abrir na hora). Depois disso a DEK embrulhada que ficou num backup não abre mais.
 *
 * O valor usa o mesmo formato v1 do FieldCipher (`v1:<keyId>:...`, AAD = clínica + tabela + coluna +
 * linha), com `keyId` = id do escopo. A DEK em claro vive só durante a chamada e é zerada em seguida.
 */
export interface DisposableKey extends WrappedDataKey {
  /** Id do escopo (uuid): vai no lugar do keyId do formato v1. */
  readonly scopeId: string;
}

export class DisposableKeys {
  constructor(private readonly provider: KeyProvider) {}

  /**
   * Cria a chave do escopo e cifra `plaintext` com ela. Devolve a chave EMBRULHADA (para gravar) e o
   * valor cifrado. Se o chamador não conseguir gravar, deve chamar `destroy` (chave órfã).
   */
  async createAndSeal(tenantId: TenantId, scopeId: string, ref: FieldRef, plaintext: Uint8Array): Promise<{ key: DisposableKey; sealed: string }> {
    assertFieldRef(ref);
    if (ref.tenantId !== tenantId) throw new KeyUnavailableError();
    const masterKeyId = await this.create(tenantId, scopeId);
    try {
      return await this.seal(tenantId, scopeId, masterKeyId, ref, plaintext);
    } catch (e) {
      await this.provider.destroyMasterKey(masterKeyId, tenantId).catch(() => undefined);
      throw e;
    }
  }

  /**
   * Só cria a chave mestra do escopo e devolve o id (ARN). Para quem precisa REGISTRAR o id antes de usar a
   * chave (importador, 0049: nenhuma chave órfã no KMS); quem chama é dono da destruição se algo falhar.
   */
  create(tenantId: TenantId, scopeId: string): Promise<string> {
    // R3-b: tag `purpose=import_batch` + `batch_id` e descrição própria (o IAM separa da chave da clínica).
    return this.provider.createMasterKey(tenantId, { purpose: KEY_PURPOSE_IMPORT_BATCH, batchId: scopeId });
  }

  /** Gera a DEK sob a chave do escopo e cifra `plaintext`. Não destrói a chave se falhar (ver `create`). */
  async seal(tenantId: TenantId, scopeId: string, masterKeyId: string, ref: FieldRef, plaintext: Uint8Array): Promise<{ key: DisposableKey; sealed: string }> {
    assertFieldRef(ref);
    if (ref.tenantId !== tenantId) throw new KeyUnavailableError();
    const generated = await this.provider.generateDataKey(masterKeyId, tenantId);
    try {
      const sealed = sealField(generated.plaintext, scopeId, ref, plaintext);
      return { key: { scopeId, masterKeyId, wrapped: generated.wrapped }, sealed };
    } finally {
      generated.plaintext.destroy();
    }
  }

  /** Abre um valor cifrado com a chave do escopo. Chave destruída: KeyUnavailableError. */
  async open(tenantId: TenantId, key: DisposableKey, ref: FieldRef, value: string): Promise<Buffer> {
    assertFieldRef(ref);
    const parsed = parseField(value);
    if (parsed.keyId !== key.scopeId) throw new KeyUnavailableError();
    const dek = await this.provider.unwrapDataKey(key, tenantId);
    try {
      return openField(dek, ref, parsed);
    } finally {
      dek.destroy();
    }
  }

  /** Crypto-shredding do escopo. Idempotente (no KMS, chave já pendente conta como feita). */
  destroy(tenantId: TenantId, masterKeyId: string): Promise<void> {
    return this.provider.destroyMasterKey(masterKeyId, tenantId);
  }
}
