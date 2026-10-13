import { inspect } from 'node:util';
import { KeyUnavailableError } from './crypto-errors';

export const DATA_KEY_BYTES = 32;

// Os bytes ficam fora do objeto: nem util.inspect, nem JSON.stringify, nem um logger que serialize
// o objeto inteiro conseguem enxergar a chave.
const material = new WeakMap<DataKey, Buffer>();

/**
 * Chave de dados (DEK) AES-256 em claro, só em memória. Nunca é serializada nem impressa.
 * Depois de `destroy()` os bytes são zerados e qualquer uso falha — nunca cifra com chave zerada.
 */
export class DataKey {
  private destroyed = false;

  private constructor() {}

  /** Copia os bytes (quem chamou pode zerar o próprio buffer em seguida). */
  static fromBytes(bytes: Uint8Array): DataKey {
    if (bytes.length !== DATA_KEY_BYTES) throw new KeyUnavailableError();
    const key = new DataKey();
    material.set(key, Buffer.from(bytes));
    return key;
  }

  /** Uso síncrono dos bytes: impede que a chave seja guardada fora desta classe por engano. */
  use<T>(fn: (bytes: Buffer) => T): T {
    const bytes = material.get(this);
    if (this.destroyed || !bytes) throw new KeyUnavailableError();
    return fn(bytes);
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    material.get(this)?.fill(0);
    material.delete(this);
    this.destroyed = true;
  }

  toJSON(): string {
    return '[DataKey]';
  }

  toString(): string {
    return '[DataKey]';
  }

  [inspect.custom](): string {
    return '[DataKey]';
  }
}
