/**
 * KMS falsos compartilhados pelos testes (sem rede, sem segredo real): o de chave mestra imita o
 * contrato do AWS KMS (EncryptionContext obrigatório e igual) e o de MAC calcula HMAC-SHA256 com uma
 * chave que só ele conhece. Vieram de key-providers.test.ts e ator-suporte.test.ts (rodada 27).
 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { KmsMacApi } from '../src/modules/audit/ator-suporte';
import type { KmsApi } from '../src/modules/crypto/kms-key-provider';

export type FakeKms = KmsApi & { calls: { op: string; input: unknown }[]; fail: boolean; excluir(keyId: string): void };

/** Erro como o SDK v3 lança: o tipo vem em `name`; a mensagem pode trazer ARN e conta. */
export function kmsErro(name: string, message = name, httpStatusCode?: number): Error {
  const e = new Error(message);
  e.name = name;
  if (httpStatusCode !== undefined) Object.assign(e, { $metadata: { httpStatusCode } });
  return e;
}

/** KMS falso que imita o contrato (EncryptionContext obrigatório e igual) e registra as chamadas. */
export function fakeKms(): FakeKms {
  const blobs = new Map<string, { plaintext: Buffer; ctx: string }>();
  const pendentes = new Set<string>();
  // Exclusão já feita pelo KMS (passou a janela de 7 dias): toda operação na chave dá NotFoundException.
  const excluidas = new Set<string>();
  const naoExiste = (keyId: string) => Promise.reject(kmsErro('NotFoundException', `Key '${keyId}' does not exist`, 400));
  const fake: FakeKms = {
    calls: [],
    fail: false,
    excluir(keyId) {
      pendentes.delete(keyId);
      excluidas.add(keyId);
    },
    createKey(input) {
      fake.calls.push({ op: 'createKey', input });
      if (fake.fail) return Promise.reject(kmsErro('AccessDeniedException', 'AccessDenied arn:aws:kms:sa-east-1:123456789012:key/segredo'));
      return Promise.resolve({ KeyMetadata: { Arn: `arn:aws:kms:sa-east-1:000000000000:key/${randomUUID()}` } });
    },
    enableKeyRotation(input) {
      fake.calls.push({ op: 'enableKeyRotation', input });
      return Promise.resolve({});
    },
    generateDataKey(input) {
      fake.calls.push({ op: 'generateDataKey', input });
      const plaintext = randomBytes(32);
      const blob = randomBytes(64);
      blobs.set(blob.toString('hex'), { plaintext: Buffer.from(plaintext), ctx: JSON.stringify(input.EncryptionContext) });
      return Promise.resolve({ Plaintext: plaintext, CiphertextBlob: blob });
    },
    decrypt(input) {
      fake.calls.push({ op: 'decrypt', input });
      // Como no KMS: chave com exclusão agendada não decifra (KMSInvalidStateException).
      if (pendentes.has(input.KeyId)) return Promise.reject(kmsErro('KMSInvalidStateException'));
      const b = blobs.get(Buffer.from(input.CiphertextBlob).toString('hex'));
      if (!b || b.ctx !== JSON.stringify(input.EncryptionContext)) {
        return Promise.reject(kmsErro('InvalidCiphertextException'));
      }
      return Promise.resolve({ Plaintext: Buffer.from(b.plaintext) });
    },
    reEncrypt(input) {
      fake.calls.push({ op: 'reEncrypt', input });
      return Promise.resolve({ CiphertextBlob: Buffer.from(input.CiphertextBlob) });
    },
    scheduleKeyDeletion(input) {
      fake.calls.push({ op: 'scheduleKeyDeletion', input });
      if (excluidas.has(input.KeyId)) return naoExiste(input.KeyId);
      if (pendentes.has(input.KeyId)) return Promise.reject(kmsErro('KMSInvalidStateException'));
      pendentes.add(input.KeyId);
      return Promise.resolve({});
    },
    describeKey(input) {
      fake.calls.push({ op: 'describeKey', input });
      if (excluidas.has(input.KeyId)) return naoExiste(input.KeyId);
      return Promise.resolve({ KeyMetadata: { KeyState: pendentes.has(input.KeyId) ? 'PendingDeletion' : 'Enabled' } });
    },
    cancelKeyDeletion(input) {
      fake.calls.push({ op: 'cancelKeyDeletion', input });
      pendentes.delete(input.KeyId);
      return Promise.resolve({});
    },
    enableKey(input) {
      fake.calls.push({ op: 'enableKey', input });
      return Promise.resolve({});
    },
  };
  return fake;
}

/** KMS de mentira: HMAC-SHA256 com uma chave que só ele conhece (como o KMS real). */
export function kmsFalso(chave: Buffer, opcoes: { falhar?: boolean } = {}): KmsMacApi & { chamadas: string[] } {
  const chamadas: string[] = [];
  return {
    chamadas,
    generateMac(input) {
      chamadas.push(`generate:${input.KeyId}`);
      if (opcoes.falhar) return Promise.reject(new Error(`AccessDenied arn:aws:kms:sa-east-1:123:key/${input.KeyId}`));
      return Promise.resolve({ Mac: createHmac('sha256', chave).update(input.Message).digest() });
    },
    verifyMac(input) {
      chamadas.push(`verify:${input.KeyId}`);
      const esperado = createHmac('sha256', chave).update(input.Message).digest();
      return Promise.resolve({ MacValid: esperado.length === input.Mac.length && timingSafeEqual(esperado, input.Mac) });
    },
  };
}
