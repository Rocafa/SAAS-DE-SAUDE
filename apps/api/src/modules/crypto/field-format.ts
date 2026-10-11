import type { TenantId } from '@plataforma/shared';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { FieldDecryptionError, InvalidFieldRefError } from './crypto-errors';
import type { DataKey } from './data-key';

/**
 * Formato do campo cifrado, versionado: `v1:<keyId>:<iv>:<tag>:<dado>`
 * - keyId: id (uuid) da DEK em `tenant_data_keys` — diz qual chave abre, sem expor a chave;
 * - iv: 12 bytes aleatórios por valor (nunca reutilizado com a mesma chave);
 * - tag: 16 bytes do GCM; dado: texto cifrado. Os três em base64url sem preenchimento.
 * Uma versão nova de formato ganha prefixo próprio (v2:...) e convive com a v1 na leitura.
 */
export const FIELD_FORMAT_VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const FIELD_RE = new RegExp(`^v1:(${UUID}):([A-Za-z0-9_-]{16}):([A-Za-z0-9_-]{22}):([A-Za-z0-9_-]*)$`);
const IDENT_RE = /^[a-z][a-z0-9_]{0,62}$/;
const TENANT_RE = new RegExp(`^${UUID}$`, 'i');

/** Onde o valor mora. Entra no AAD: o mesmo texto cifrado não vale em outra clínica, coluna ou linha. */
export interface FieldRef {
  readonly tenantId: TenantId;
  readonly table: string;
  readonly column: string;
  readonly rowId: string;
}

export interface ParsedField {
  readonly keyId: string;
  readonly iv: Buffer;
  readonly tag: Buffer;
  readonly data: Buffer;
}

export function assertFieldRef(ref: FieldRef): void {
  if (
    !TENANT_RE.test(ref.tenantId) ||
    !IDENT_RE.test(ref.table) ||
    !IDENT_RE.test(ref.column) ||
    ref.rowId.length === 0 ||
    ref.rowId.length > 128
  ) {
    throw new InvalidFieldRefError();
  }
}

/** AAD = versão + clínica + tabela + coluna + id da linha (JSON: sem ambiguidade de separador). */
export function fieldAad(ref: FieldRef): Buffer {
  return Buffer.from(
    JSON.stringify([FIELD_FORMAT_VERSION, ref.tenantId.toLowerCase(), ref.table, ref.column, ref.rowId]),
    'utf8',
  );
}

export function isEncryptedField(value: string): boolean {
  return FIELD_RE.test(value);
}

export function parseField(value: string): ParsedField {
  const m = FIELD_RE.exec(value);
  if (!m) throw new FieldDecryptionError();
  const [, keyId, iv, tag, data] = m as unknown as [string, string, string, string, string];
  return {
    keyId,
    iv: Buffer.from(iv, 'base64url'),
    tag: Buffer.from(tag, 'base64url'),
    data: Buffer.from(data, 'base64url'),
  };
}

export function sealField(key: DataKey, keyId: string, ref: FieldRef, plaintext: Uint8Array): string {
  const iv = randomBytes(IV_BYTES);
  const { data, tag } = key.use((bytes) => {
    const cipher = createCipheriv('aes-256-gcm', bytes, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(fieldAad(ref));
    const out = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return { data: out, tag: cipher.getAuthTag() };
  });
  return [FIELD_FORMAT_VERSION, keyId, iv.toString('base64url'), tag.toString('base64url'), data.toString('base64url')].join(
    ':',
  );
}

export function openField(key: DataKey, ref: FieldRef, parsed: ParsedField): Buffer {
  return key.use((bytes) => {
    try {
      const decipher = createDecipheriv('aes-256-gcm', bytes, parsed.iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(fieldAad(ref));
      decipher.setAuthTag(parsed.tag);
      return Buffer.concat([decipher.update(parsed.data), decipher.final()]);
    } catch {
      // Tag inválida = adulteração, AAD de outro lugar ou chave errada. Mensagem fixa, sem detalhe.
      throw new FieldDecryptionError();
    }
  });
}
