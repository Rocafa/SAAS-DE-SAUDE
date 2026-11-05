import type { DataKey } from './data-key';

export interface DataKeyCacheOptions {
  /** Tempo de vida de uma DEK em claro na memória. Curto: limita exposição e propagação de destruição. */
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
}

export const DEFAULT_DEK_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 1_000;

interface Entry {
  readonly key: DataKey;
  readonly expiresAt: number;
}

/**
 * Cache de DEKs em claro por (clínica, keyId), para não chamar o KMS a cada campo.
 *
 * Expirar ou sair por tamanho só solta a referência (o GC recolhe): zerar ali poderia fazer uma
 * operação em andamento falhar. `invalidateTenant` (crypto-shredding) zera na hora — se algo ainda
 * estiver usando a chave, falha com KeyUnavailableError em vez de cifrar com bytes zerados.
 */
export class DataKeyCache {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: DataKeyCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_DEK_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
    if (!(this.ttlMs > 0) || !(this.maxEntries > 0)) throw new Error('cache de DEK: ttlMs e maxEntries > 0');
  }

  get size(): number {
    return this.entries.size;
  }

  get(tenantId: string, keyId: string): DataKey | undefined {
    const id = cacheKey(tenantId, keyId);
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now() || entry.key.isDestroyed) {
      this.entries.delete(id);
      return undefined;
    }
    return entry.key;
  }

  set(tenantId: string, keyId: string, key: DataKey): void {
    const id = cacheKey(tenantId, keyId);
    this.entries.delete(id);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    this.entries.set(id, { key, expiresAt: this.now() + this.ttlMs });
  }

  /** Remove e ZERA todas as DEKs da clínica (usado na destruição de chaves). */
  invalidateTenant(tenantId: string): void {
    const prefix = `${tenantId.toLowerCase()}:`;
    for (const [id, entry] of this.entries) {
      if (id.startsWith(prefix)) {
        entry.key.destroy();
        this.entries.delete(id);
      }
    }
  }

  clear(): void {
    for (const entry of this.entries.values()) entry.key.destroy();
    this.entries.clear();
  }
}

function cacheKey(tenantId: string, keyId: string): string {
  return `${tenantId.toLowerCase()}:${keyId}`;
}
