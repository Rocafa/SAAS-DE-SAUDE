import type { TenantId } from '@plataforma/shared';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { KeyUnavailableError } from './crypto-errors';
import { DATA_KEY_BYTES, DataKey } from './data-key';
import type { GeneratedDataKey, KeyProvider, WrappedDataKey } from './key-provider';

const IV_BYTES = 12;
const TAG_BYTES = 16;
const PREFIX = 'local:';

export interface LocalKeyProviderOptions {
  /**
   * Segredo de dev (≥ 32 bytes) do qual as chaves mestras são derivadas (HKDF-SHA256 pelo id), para
   * que os dados cifrados sobrevivam a um reinício local. Sem ele, as chaves vivem só na memória.
   */
  readonly rootSecret?: Uint8Array;
  /** Ambiente (padrão: process.env.NODE_ENV). Em `production` o provedor local é recusado. */
  readonly nodeEnv?: string | undefined;
}

/**
 * Provedor de chave mestra LOCAL, só para desenvolvimento e teste. Imita o KMS: a DEK sai cifrada
 * (AES-256-GCM) pela chave mestra da clínica, com AAD amarrando chave mestra + clínica.
 * Destruir a chave mestra é imediato aqui (no KMS há janela de 7 a 30 dias).
 */
export class LocalKeyProvider implements KeyProvider {
  private readonly masters = new Map<string, Buffer>();
  private readonly destroyed = new Set<string>();
  private readonly rootSecret: Buffer | undefined;

  constructor(options: LocalKeyProviderOptions = {}) {
    const nodeEnv = 'nodeEnv' in options ? options.nodeEnv : process.env.NODE_ENV;
    if (nodeEnv === 'production') {
      throw new Error('LocalKeyProvider é só para dev/teste: em produção use o KMS');
    }
    if (options.rootSecret && options.rootSecret.length < 32) {
      throw new Error('rootSecret do LocalKeyProvider precisa de ao menos 32 bytes');
    }
    this.rootSecret = options.rootSecret ? Buffer.from(options.rootSecret) : undefined;
  }

  createMasterKey(): Promise<string> {
    const id = `${PREFIX}${randomUUID()}`;
    if (!this.rootSecret) this.masters.set(id, randomBytes(32));
    return Promise.resolve(id);
  }

  generateDataKey(masterKeyId: string, tenantId: TenantId): Promise<GeneratedDataKey> {
    const bytes = randomBytes(DATA_KEY_BYTES);
    try {
      const wrapped = this.wrap(bytes, masterKeyId, tenantId);
      return Promise.resolve({ masterKeyId, wrapped, plaintext: DataKey.fromBytes(bytes) });
    } catch {
      return Promise.reject(new KeyUnavailableError());
    } finally {
      bytes.fill(0);
    }
  }

  unwrapDataKey(key: WrappedDataKey, tenantId: TenantId): Promise<DataKey> {
    let bytes: Buffer;
    try {
      bytes = this.unwrap(key, tenantId);
    } catch {
      return Promise.reject(new KeyUnavailableError());
    }
    try {
      return Promise.resolve(DataKey.fromBytes(bytes));
    } finally {
      bytes.fill(0);
    }
  }

  rewrapDataKey(key: WrappedDataKey, targetMasterKeyId: string, tenantId: TenantId): Promise<WrappedDataKey> {
    let bytes: Buffer | undefined;
    try {
      bytes = this.unwrap(key, tenantId);
      return Promise.resolve({ masterKeyId: targetMasterKeyId, wrapped: this.wrap(bytes, targetMasterKeyId, tenantId) });
    } catch {
      return Promise.reject(new KeyUnavailableError());
    } finally {
      bytes?.fill(0);
    }
  }

  destroyMasterKey(masterKeyId: string): Promise<void> {
    this.masters.get(masterKeyId)?.fill(0);
    this.masters.delete(masterKeyId);
    this.destroyed.add(masterKeyId);
    return Promise.resolve();
  }

  private master(masterKeyId: string): Buffer {
    if (!masterKeyId.startsWith(PREFIX) || this.destroyed.has(masterKeyId)) throw new KeyUnavailableError();
    if (this.rootSecret) {
      return Buffer.from(hkdfSync('sha256', this.rootSecret, Buffer.alloc(0), `plataforma:kek:${masterKeyId}`, 32));
    }
    const key = this.masters.get(masterKeyId);
    if (!key) throw new KeyUnavailableError();
    return key;
  }

  private wrap(dek: Buffer, masterKeyId: string, tenantId: TenantId): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.master(masterKeyId), iv);
    cipher.setAAD(wrapAad(masterKeyId, tenantId));
    const body = Buffer.concat([cipher.update(dek), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }

  private unwrap(key: WrappedDataKey, tenantId: TenantId): Buffer {
    const { wrapped, masterKeyId } = key;
    if (wrapped.length !== IV_BYTES + TAG_BYTES + DATA_KEY_BYTES) throw new KeyUnavailableError();
    const decipher = createDecipheriv('aes-256-gcm', this.master(masterKeyId), wrapped.subarray(0, IV_BYTES));
    decipher.setAAD(wrapAad(masterKeyId, tenantId));
    decipher.setAuthTag(wrapped.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(wrapped.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
  }
}

function wrapAad(masterKeyId: string, tenantId: TenantId): Buffer {
  return Buffer.from(JSON.stringify(['dek', 1, masterKeyId, tenantId]), 'utf8');
}
