import type { TenantId } from '@plataforma/shared';
import {
  FieldDecryptionError,
  KeyUnavailableError,
  TenantKeyMissingError,
  TenantKeysDestroyedError,
} from './crypto-errors';
import type { DataKey } from './data-key';
import { DataKeyCache } from './data-key-cache';
import type { DataKeyRecord, DataKeyStore } from './data-key-store';
import { assertFieldRef, openField, parseField, sealField, type FieldRef } from './field-format';
import type { KeyProvider } from './key-provider';

export type KeyEventKind = 'provision' | 'rotate_dek' | 'rotate_kek' | 'destroy';

/** Operação de chave a registrar na trilha de auditoria (quem, o quê, qual chave). */
export interface KeyEvent {
  readonly tenantId: TenantId;
  readonly kind: KeyEventKind;
  /** Usuário que pediu; null = rotina do sistema (ex.: rotação por limite de uso). */
  readonly actorId: string | null;
  readonly keyId?: string;
}

/** Abre uma transação do tenant e roda `fn` nela (ex.: `(fn) => withTenant(db, tenantId, fn)`). */
export type TxRunner<Tx> = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

/** Grava o evento NA MESMA transação: sem evento registrado, a operação de chave não acontece. */
export type KeyAuditor<Tx> = (tx: Tx, event: KeyEvent) => Promise<void>;

/** Gira a DEK ao chegar aqui. O NIST SP 800-38D limita IV aleatório a 2^32 usos por chave. */
export const DEK_ROTATE_AFTER = 2 ** 30;
/** Cifragens acumuladas em memória antes de somar no banco (contagem aproximada, sem travar a linha a cada campo). */
export const DEK_USAGE_FLUSH_EVERY = 1024;

export interface FieldCipherOptions {
  readonly cache?: DataKeyCache;
  readonly rotateAfter?: number;
  readonly usageFlushEvery?: number;
}

/**
 * Criptografia de campo em envelope, por clínica (S5). Ver docs/04-arquitetura/criptografia-de-campo.md.
 *
 * - Cada clínica: uma chave mestra própria (KEK) e DEKs AES-256 cifradas por ela.
 * - Cada valor: AES-256-GCM com IV aleatório e AAD = clínica + tabela + coluna + id da linha.
 * - Rotação sem downtime: a DEK nova passa a cifrar; as antigas continuam abrindo o que já existe.
 * - Destruição: a KEK da clínica é destruída e todas as cópias (inclusive backups) ficam ilegíveis.
 *
 * Todos os métodos recebem a transação do tenant (`withTenant`): o RLS limita as chaves à clínica.
 * A destruição recebe um `TxRunner`, porque precisa de duas transações (ver destroyTenantKeys).
 *
 * Ordem das travas da clínica, em qualquer transação: `audit_chain` (a do trigger de audit_log,
 * migração 0005) → `tenant_keys` → linhas de tenant_data_keys. `store.lockTenant` toma as duas
 * primeiras nessa ordem, e TODO caminho que grava linha de chave passa por ele antes — inclusive a
 * soma do contador de uso dentro de `encrypt`. Assim "auditou e depois cifrou" numa transação e
 * "girou a chave e auditou" em outra só esperam uma pela outra, sem deadlock (teste em
 * test/crypto.rls.test.ts). Custo: a cada `usageFlushEvery` cifragens a transação segura a trava
 * da trilha da clínica até o COMMIT, como já faz qualquer transação que audita.
 */
export class FieldCipher<Tx> {
  private readonly cache: DataKeyCache;
  private readonly rotateAfter: number;
  private readonly usageFlushEvery: number;
  /** Cifragens ainda não somadas no banco, por DEK. */
  private readonly pendingUsage = new Map<string, number>();

  constructor(
    private readonly provider: KeyProvider,
    private readonly store: DataKeyStore<Tx>,
    private readonly audit: KeyAuditor<Tx>,
    options: FieldCipherOptions = {},
  ) {
    this.cache = options.cache ?? new DataKeyCache();
    this.rotateAfter = options.rotateAfter ?? DEK_ROTATE_AFTER;
    this.usageFlushEvery = options.usageFlushEvery ?? DEK_USAGE_FLUSH_EVERY;
  }

  /** A clínica teve as chaves destruídas (eliminação, G3)? Não decifra nada nem chama o provedor. */
  tenantKeysDestroyed(tx: Tx, tenantId: TenantId): Promise<boolean> {
    return this.store.hasDestroyedKeys(tx, tenantId);
  }

  /** Garante chave mestra e DEK ativas para a clínica. Idempotente; devolve o id da DEK ativa. */
  async provisionTenant(tx: Tx, tenantId: TenantId, actorId: string | null): Promise<string> {
    await this.store.lockTenant(tx, tenantId);
    const active = await this.store.findActive(tx, tenantId);
    if (active) return active.id;
    // Clínica eliminada não ganha chave nova em silêncio (os dados antigos continuam ilegíveis).
    if (await this.store.hasDestroyedKeys(tx, tenantId)) throw new TenantKeysDestroyedError();
    let master = await this.store.findActiveMaster(tx, tenantId);
    if (!master) {
      master = await this.provider.createMasterKey(tenantId);
      await this.store.insertMaster(tx, tenantId, master);
    }
    const id = await this.createDataKey(tx, tenantId, master);
    await this.audit(tx, { tenantId, kind: 'provision', actorId, keyId: id });
    return id;
  }

  async encrypt(tx: Tx, ref: FieldRef, plaintext: string | Uint8Array): Promise<string> {
    assertFieldRef(ref);
    let active = await this.store.findActive(tx, ref.tenantId);
    // Falha fechada: sem chave, o campo não é gravado (nunca em claro).
    if (!active) throw new TenantKeyMissingError();
    if (this.usage(active) >= this.rotateAfter) {
      active = await this.rotateIfExhausted(tx, ref.tenantId);
    }
    const key = await this.dataKey(ref.tenantId, active);
    const bytes = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
    const sealed = sealField(key, active.id, ref, bytes);
    await this.countUsage(tx, ref.tenantId, active.id);
    return sealed;
  }

  async decrypt(tx: Tx, ref: FieldRef, value: string): Promise<Buffer> {
    assertFieldRef(ref);
    const parsed = parseField(value);
    // O status vem SEMPRE do banco, mesmo com a DEK em cache: destruição feita por outra instância
    // vale na hora aqui também (o cache só poupa a chamada ao KMS).
    const record = await this.store.findById(tx, ref.tenantId, parsed.keyId);
    if (record === 'destroyed') {
      this.cache.invalidateTenant(ref.tenantId);
      throw new KeyUnavailableError();
    }
    // Chave de outra clínica (invisível pelo RLS) ou inexistente.
    if (!record) throw new FieldDecryptionError();
    return openField(await this.dataKey(ref.tenantId, record), ref, parsed);
  }

  async decryptString(tx: Tx, ref: FieldRef, value: string): Promise<string> {
    return (await this.decrypt(tx, ref, value)).toString('utf8');
  }

  /** Gira a DEK: a atual vira `retired` (continua decifrando) e uma nova passa a cifrar. */
  async rotateDataKey(tx: Tx, tenantId: TenantId, actorId: string | null): Promise<string> {
    await this.store.lockTenant(tx, tenantId);
    const active = await this.store.findActive(tx, tenantId);
    if (!active) throw new TenantKeyMissingError();
    return this.replaceDataKey(tx, tenantId, active, actorId);
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
  async rotateMasterKey(tx: Tx, tenantId: TenantId, actorId: string | null): Promise<string> {
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
    await this.audit(tx, { tenantId, kind: 'rotate_kek', actorId });
    return next;
  }

  /**
   * Crypto-shredding da clínica, em duas transações (`run` abre uma transação do tenant por chamada):
   *
   * 1. `destroying` comitado: DEKs e chaves mestras vivas param de decifrar e o evento entra na
   *    trilha de auditoria. Sem evento registrado, nada segue.
   * 2. Provedor: agenda a destruição de TODAS as chaves mestras (KMS: janela de 7 dias). Idempotente:
   *    chave já pendente conta como feita.
   * 3. `destroyed` comitado: a DEK cifrada é apagada do banco.
   *
   * Se qualquer passo falhar, o banco fica em `destroying` — nunca volta a dizer "ativa" para uma
   * chave que o provedor já pode ter agendado —, e chamar de novo retoma de onde parou. Depois disso
   * nenhum campo da clínica abre: nem no banco, nem em snapshot, nem em backup.
   */
  async destroyTenantKeys(run: TxRunner<Tx>, tenantId: TenantId, actorId: string | null): Promise<void> {
    const masters = await run(async (tx) => {
      await this.store.lockTenant(tx, tenantId);
      const ids = await this.store.beginDestroy(tx, tenantId);
      await this.audit(tx, { tenantId, kind: 'destroy', actorId });
      return ids;
    });
    this.cache.invalidateTenant(tenantId);
    for (const master of masters) await this.provider.destroyMasterKey(master, tenantId);
    await run(async (tx) => {
      await this.store.lockTenant(tx, tenantId);
      await this.store.finishDestroy(tx, tenantId);
    });
  }

  private usage(record: DataKeyRecord): number {
    return record.encryptCount + (this.pendingUsage.get(record.id) ?? 0);
  }

  private async countUsage(tx: Tx, tenantId: TenantId, keyId: string): Promise<void> {
    const n = (this.pendingUsage.get(keyId) ?? 0) + 1;
    if (n < this.usageFlushEvery) {
      this.pendingUsage.set(keyId, n);
      return;
    }
    this.pendingUsage.delete(keyId);
    // UPDATE trava a linha da DEK: entra na ordem global (ver comentário da classe).
    await this.store.lockTenant(tx, tenantId);
    await this.store.addUsage(tx, tenantId, keyId, n);
  }

  /** Rotação por limite de uso, sob a trava da clínica (outra instância pode ter girado antes). */
  private async rotateIfExhausted(tx: Tx, tenantId: TenantId): Promise<DataKeyRecord> {
    await this.store.lockTenant(tx, tenantId);
    const active = await this.store.findActive(tx, tenantId);
    if (!active) throw new TenantKeyMissingError();
    if (this.usage(active) < this.rotateAfter) return active;
    const pending = this.pendingUsage.get(active.id);
    if (pending) {
      this.pendingUsage.delete(active.id);
      await this.store.addUsage(tx, tenantId, active.id, pending);
    }
    await this.replaceDataKey(tx, tenantId, active, null);
    const next = await this.store.findActive(tx, tenantId);
    if (!next) throw new TenantKeyMissingError();
    return next;
  }

  private async replaceDataKey(
    tx: Tx,
    tenantId: TenantId,
    active: DataKeyRecord,
    actorId: string | null,
  ): Promise<string> {
    await this.store.retire(tx, tenantId, active.id);
    const id = await this.createDataKey(tx, tenantId, active.masterKeyId);
    await this.audit(tx, { tenantId, kind: 'rotate_dek', actorId, keyId: id });
    return id;
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
