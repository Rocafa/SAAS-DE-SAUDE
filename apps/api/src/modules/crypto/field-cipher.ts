import type { TenantId } from '@plataforma/shared';
import { FieldDecryptionError, KeyUnavailableError, TenantKeyMissingError } from './crypto-errors';
import type { DataKey } from './data-key';
import { DataKeyCache } from './data-key-cache';
import type { DataKeyRecord, DataKeyStore } from './data-key-store';
import { assertFieldRef, openField, parseField, sealField, type FieldRef } from './field-format';
import type { KeyProvider } from './key-provider';

/**
 * Criptografia de campo em envelope, por clínica (S5). Ver docs/04-arquitetura/criptografia-de-campo.md.
 *
 * - Cada clínica: uma chave mestra própria (KEK) e DEKs AES-256 cifradas por ela.
 * - Cada valor: AES-256-GCM com IV aleatório e AAD = clínica + tabela + coluna + id da linha.
 * - Rotação sem downtime: a DEK nova passa a cifrar; as antigas continuam abrindo o que já existe.
 * - Destruição: a KEK da clínica é destruída e todas as cópias (inclusive backups) ficam ilegíveis.
 *
 * Todos os métodos recebem a transação do tenant (`withTenant`): o RLS limita as chaves à clínica.
 */
export class FieldCipher<Tx> {
  constructor(
    private readonly provider: KeyProvider,
    private readonly store: DataKeyStore<Tx>,
    private readonly cache: DataKeyCache = new DataKeyCache(),
  ) {}

  /** Garante chave mestra e DEK ativas para a clínica. Idempotente; devolve o id da DEK ativa. */
  async provisionTenant(tx: Tx, tenantId: TenantId): Promise<string> {
    await this.store.lockTenant(tx, tenantId);
    const active = await this.store.findActive(tx, tenantId);
    if (active) return active.id;
    let master = await this.store.findActiveMaster(tx, tenantId);
    if (!master) {
      master = await this.provider.createMasterKey(tenantId);
      await this.store.insertMaster(tx, tenantId, master);
    }
    return this.createDataKey(tx, tenantId, master);
  }

  async encrypt(tx: Tx, ref: FieldRef, plaintext: string | Uint8Array): Promise<string> {
    assertFieldRef(ref);
    const active = await this.store.findActive(tx, ref.tenantId);
    // Falha fechada: sem chave, o campo não é gravado (nunca em claro).
    if (!active) throw new TenantKeyMissingError();
    const key = await this.dataKey(ref.tenantId, active);
    const bytes = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
    return sealField(key, active.id, ref, bytes);
  }

  async decrypt(tx: Tx, ref: FieldRef, value: string): Promise<Buffer> {
    assertFieldRef(ref);
    const parsed = parseField(value);
    let key = this.cache.get(ref.tenantId, parsed.keyId);
    if (!key) {
      const record = await this.store.findById(tx, ref.tenantId, parsed.keyId);
      if (record === 'destroyed') throw new KeyUnavailableError();
      // Chave de outra clínica (invisível pelo RLS) ou inexistente.
      if (!record) throw new FieldDecryptionError();
      key = await this.dataKey(ref.tenantId, record);
    }
    return openField(key, ref, parsed);
  }

  async decryptString(tx: Tx, ref: FieldRef, value: string): Promise<string> {
    return (await this.decrypt(tx, ref, value)).toString('utf8');
  }

  /** Gira a DEK: a atual vira `retired` (continua decifrando) e uma nova passa a cifrar. */
  async rotateDataKey(tx: Tx, tenantId: TenantId): Promise<string> {
    await this.store.lockTenant(tx, tenantId);
    const active = await this.store.findActive(tx, tenantId);
    if (!active) throw new TenantKeyMissingError();
    await this.store.retire(tx, tenantId, active.id);
    return this.createDataKey(tx, tenantId, active.masterKeyId);
  }

  /** true quando o valor foi cifrado com uma DEK que não é mais a ativa (candidato a recifrar). */
  async isStale(tx: Tx, tenantId: TenantId, value: string): Promise<boolean> {
    const active = await this.store.findActive(tx, tenantId);
    return !active || parseField(value).keyId !== active.id;
  }

  /** Recifra com a DEK ativa (job em segundo plano após rotação). Não muda o valor em claro. */
  async reencrypt(tx: Tx, ref: FieldRef, value: string): Promise<string> {
    if (!(await this.isStale(tx, ref.tenantId, value))) return value;
    const plaintext = await this.decrypt(tx, ref, value);
    try {
      return await this.encrypt(tx, ref, plaintext);
    } finally {
      plaintext.fill(0);
    }
  }

  /**
   * Gira a chave mestra (comprometimento suspeito; a rotação anual de rotina é automática no KMS).
   * Re-cifra as DEKs sob a KEK nova sem tocar nos dados. A KEK antiga fica `retired`, não é
   * destruída: backups anteriores ainda dependem dela até expirarem.
   */
  async rotateMasterKey(tx: Tx, tenantId: TenantId): Promise<string> {
    await this.store.lockTenant(tx, tenantId);
    const old = await this.store.findActiveMaster(tx, tenantId);
    if (!old) throw new TenantKeyMissingError();
    const next = await this.provider.createMasterKey(tenantId);
    await this.store.retireMaster(tx, tenantId, old);
    await this.store.insertMaster(tx, tenantId, next);
    for (const record of await this.store.listLive(tx, tenantId)) {
      const rewrapped = await this.provider.rewrapDataKey(record, next, tenantId);
      await this.store.updateWrapped(tx, tenantId, record.id, rewrapped);
    }
    return next;
  }

  /**
   * Crypto-shredding da clínica: marca todas as chaves como destruídas, zera o cache e destrói as
   * chaves mestras no provedor (KMS: agenda com a janela mínima de 7 dias). Depois disso nenhum campo
   * da clínica abre — nem no banco, nem em snapshot, nem em backup imutável.
   * Ordem: banco primeiro; se o provedor falhar, a transação desfaz e nada fica pela metade.
   */
  async destroyTenantKeys(tx: Tx, tenantId: TenantId): Promise<void> {
    await this.store.lockTenant(tx, tenantId);
    const masters = await this.store.destroyAll(tx, tenantId);
    this.cache.invalidateTenant(tenantId);
    for (const master of masters) await this.provider.destroyMasterKey(master, tenantId);
  }

  private async createDataKey(tx: Tx, tenantId: TenantId, masterKeyId: string): Promise<string> {
    const generated = await this.provider.generateDataKey(masterKeyId, tenantId);
    const id = await this.store.insertActive(tx, tenantId, generated);
    this.cache.set(tenantId, id, generated.plaintext);
    return id;
  }

  private async dataKey(tenantId: TenantId, record: DataKeyRecord): Promise<DataKey> {
    const cached = this.cache.get(tenantId, record.id);
    if (cached) return cached;
    const key = await this.provider.unwrapDataKey(record, tenantId);
    this.cache.set(tenantId, record.id, key);
    return key;
  }
}
