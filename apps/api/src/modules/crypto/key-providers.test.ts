import type { TenantId } from '@plataforma/shared';
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { KeyUnavailableError } from './crypto-errors';
import type { DataKey } from './data-key';
import { KMS_DELETION_WINDOW_DAYS, KmsKeyProvider, type KmsApi } from './kms-key-provider';
import { LocalKeyProvider } from './local-key-provider';

const tenantA = randomUUID() as TenantId;
const tenantB = randomUUID() as TenantId;
const bytesOf = (k: DataKey): Buffer => k.use((b) => Buffer.from(b));

describe('LocalKeyProvider', () => {
  it('é recusado em produção', () => {
    expect(() => new LocalKeyProvider({ nodeEnv: 'production' })).toThrow(/produção/);
  });

  it('gera DEK de 32 bytes que volta igual ao abrir; a cifrada não contém a chave', async () => {
    const p = new LocalKeyProvider({ nodeEnv: 'test' });
    const master = await p.createMasterKey();
    const g = await p.generateDataKey(master, tenantA);
    const dek = bytesOf(g.plaintext);
    expect(dek).toHaveLength(32);
    expect(g.wrapped.includes(dek)).toBe(false);
    expect(bytesOf(await p.unwrapDataKey(g, tenantA))).toEqual(dek);
  });

  it('DEK de A não abre como B; chave mestra desconhecida ou destruída falha', async () => {
    const p = new LocalKeyProvider({ nodeEnv: 'test' });
    const master = await p.createMasterKey();
    const g = await p.generateDataKey(master, tenantA);
    await expect(p.unwrapDataKey(g, tenantB)).rejects.toBeInstanceOf(KeyUnavailableError);
    await expect(p.unwrapDataKey({ ...g, masterKeyId: 'local:outra' }, tenantA)).rejects.toBeInstanceOf(
      KeyUnavailableError,
    );
    await p.destroyMasterKey(master);
    await expect(p.unwrapDataKey(g, tenantA)).rejects.toBeInstanceOf(KeyUnavailableError);
    await expect(p.generateDataKey(master, tenantA)).rejects.toBeInstanceOf(KeyUnavailableError);
  });

  it('com rootSecret, outra instância (reinício) abre a mesma DEK; segredo curto é recusado', async () => {
    const secret = randomBytes(32);
    const p1 = new LocalKeyProvider({ nodeEnv: 'test', rootSecret: secret });
    const master = await p1.createMasterKey();
    const g = await p1.generateDataKey(master, tenantA);
    const p2 = new LocalKeyProvider({ nodeEnv: 'test', rootSecret: secret });
    expect(bytesOf(await p2.unwrapDataKey(g, tenantA))).toEqual(bytesOf(g.plaintext));
    expect(() => new LocalKeyProvider({ nodeEnv: 'test', rootSecret: randomBytes(16) })).toThrow();
  });

  it('rewrap troca a chave mestra sem mudar a DEK', async () => {
    const p = new LocalKeyProvider({ nodeEnv: 'test' });
    const m1 = await p.createMasterKey();
    const m2 = await p.createMasterKey();
    const g = await p.generateDataKey(m1, tenantA);
    const r = await p.rewrapDataKey(g, m2, tenantA);
    expect(r.masterKeyId).toBe(m2);
    await p.destroyMasterKey(m1);
    expect(bytesOf(await p.unwrapDataKey(r, tenantA))).toEqual(bytesOf(g.plaintext));
  });
});

type FakeKms = KmsApi & { calls: { op: string; input: unknown }[]; fail: boolean };

/** KMS falso que imita o contrato (EncryptionContext obrigatório e igual) e registra as chamadas. */
function fakeKms(): FakeKms {
  const blobs = new Map<string, { plaintext: Buffer; ctx: string }>();
  const fake: FakeKms = {
    calls: [],
    fail: false,
    createKey(input) {
      fake.calls.push({ op: 'createKey', input });
      if (fake.fail) return Promise.reject(new Error('AccessDenied arn:aws:kms:sa-east-1:123456789012:key/segredo'));
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
      const b = blobs.get(Buffer.from(input.CiphertextBlob).toString('hex'));
      if (!b || b.ctx !== JSON.stringify(input.EncryptionContext)) {
        return Promise.reject(new Error('InvalidCiphertextException'));
      }
      return Promise.resolve({ Plaintext: Buffer.from(b.plaintext) });
    },
    reEncrypt(input) {
      fake.calls.push({ op: 'reEncrypt', input });
      return Promise.resolve({ CiphertextBlob: Buffer.from(input.CiphertextBlob) });
    },
    scheduleKeyDeletion(input) {
      fake.calls.push({ op: 'scheduleKeyDeletion', input });
      return Promise.resolve({});
    },
  };
  return fake;
}

describe('KmsKeyProvider (contra KMS falso)', () => {
  it('cria uma chave por clínica com tag e rotação automática ligada', async () => {
    const kms = fakeKms();
    const arn = await new KmsKeyProvider(kms).createMasterKey(tenantA);
    expect(arn).toMatch(/^arn:aws:kms:sa-east-1:/);
    expect(kms.calls[0]?.input).toMatchObject({ Tags: [{ TagKey: 'tenant_id', TagValue: tenantA }] });
    expect(kms.calls[1]).toEqual({ op: 'enableKeyRotation', input: { KeyId: arn } });
  });

  it('amarra a DEK à clínica pelo EncryptionContext', async () => {
    const kms = fakeKms();
    const p = new KmsKeyProvider(kms);
    const arn = await p.createMasterKey(tenantA);
    const g = await p.generateDataKey(arn, tenantA);
    expect(kms.calls.find((c) => c.op === 'generateDataKey')?.input).toMatchObject({
      KeySpec: 'AES_256',
      EncryptionContext: { tenant_id: tenantA },
    });
    expect(bytesOf(await p.unwrapDataKey(g, tenantA))).toEqual(bytesOf(g.plaintext));
    await expect(p.unwrapDataKey(g, tenantB)).rejects.toBeInstanceOf(KeyUnavailableError);
  });

  it('destruição agenda a exclusão com a janela mínima de 7 dias', async () => {
    const kms = fakeKms();
    const p = new KmsKeyProvider(kms);
    const arn = await p.createMasterKey(tenantA);
    await p.destroyMasterKey(arn);
    expect(KMS_DELETION_WINDOW_DAYS).toBe(7);
    expect(kms.calls.at(-1)).toEqual({ op: 'scheduleKeyDeletion', input: { KeyId: arn, PendingWindowInDays: 7 } });
  });

  it('erro do SDK vira erro de mensagem fixa, sem ARN nem causa', async () => {
    const kms = fakeKms();
    kms.fail = true;
    const err = await new KmsKeyProvider(kms).createMasterKey(tenantA).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KeyUnavailableError);
    expect((err as Error).message).not.toMatch(/arn|segredo|AccessDenied/);
    expect((err as Error).cause).toBeUndefined();
  });
});
