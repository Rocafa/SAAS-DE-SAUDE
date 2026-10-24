import type { TenantId } from '@plataforma/shared';
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { KeyUnavailableError } from './crypto-errors';
import type { DataKey } from './data-key';
import { KMS_DELETION_WINDOW_DAYS, KmsKeyProvider, type KmsApi } from './kms-key-provider';
import { createKeyProvider } from './crypto.module';
import { DisposableKeys } from './disposable-keys';
import { LocalKeyProvider } from './local-key-provider';

const tenantA = randomUUID() as TenantId;
const tenantB = randomUUID() as TenantId;
const bytesOf = (k: DataKey): Buffer => k.use((b) => Buffer.from(b));

describe('LocalKeyProvider', () => {
  it('é recusado em produção', () => {
    expect(() => new LocalKeyProvider({ nodeEnv: 'production' })).toThrow(/produção/);
  });

  it('só aceita development/test (lista fechada): staging, vazio e variações são recusados', () => {
    for (const nodeEnv of ['staging', 'homolog', 'prod', 'Production', '', undefined]) {
      expect(() => new LocalKeyProvider({ nodeEnv })).toThrow();
      expect(() => createKeyProvider({ NODE_ENV: nodeEnv })).toThrow(/KMS não configurado/);
    }
    expect(() => new LocalKeyProvider({ nodeEnv: 'development' })).not.toThrow();
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
    // Dentro da janela, cancelar devolve a chave (como no KMS).
    await p.cancelMasterKeyDestruction(master);
    expect(bytesOf(await p.unwrapDataKey(g, tenantA))).toEqual(bytesOf(g.plaintext));
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
  const pendentes = new Set<string>();
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
      // Como no KMS: chave com exclusão agendada não decifra (KMSInvalidStateException).
      if (pendentes.has(input.KeyId)) return Promise.reject(new Error('KMSInvalidStateException'));
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
      if (pendentes.has(input.KeyId)) return Promise.reject(new Error('KMSInvalidStateException'));
      pendentes.add(input.KeyId);
      return Promise.resolve({});
    },
    describeKey(input) {
      fake.calls.push({ op: 'describeKey', input });
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

describe('KmsKeyProvider (contra KMS falso)', () => {
  it('cria uma chave por clínica com tag e rotação automática ligada', async () => {
    const kms = fakeKms();
    const arn = await new KmsKeyProvider(kms).createMasterKey(tenantA);
    expect(arn).toMatch(/^arn:aws:kms:sa-east-1:/);
    expect(kms.calls[0]?.input).toMatchObject({
      Description: 'plataforma-saude: chave mestra de dados de uma clínica',
      Tags: [
        { TagKey: 'tenant_id', TagValue: tenantA },
        { TagKey: 'purpose', TagValue: 'tenant_data' },
      ],
    });
    expect(kms.calls[1]).toEqual({ op: 'enableKeyRotation', input: { KeyId: arn } });
  });

  it('R3-b: a chave de lote nasce com purpose=import_batch, batch_id e descrição própria, sem rotação', async () => {
    const kms = fakeKms();
    const p = new KmsKeyProvider(kms);
    const lote = randomUUID();
    await p.createMasterKey(tenantA, { purpose: 'import_batch', batchId: lote });
    await p.createMasterKey(tenantA);
    const [doLote, daClinica] = kms.calls.filter((c) => c.op === 'createKey').map((c) => c.input as { Description: string; Tags: { TagKey: string; TagValue: string }[] });
    expect(doLote?.Tags).toEqual([
      { TagKey: 'tenant_id', TagValue: tenantA },
      { TagKey: 'purpose', TagValue: 'import_batch' },
      { TagKey: 'batch_id', TagValue: lote },
    ]);
    // Descrição e tag `purpose` diferentes das da chave da clínica: é o que o IAM usa para separar as duas.
    expect(doLote?.Description).not.toBe(daClinica?.Description);
    expect(daClinica?.Tags.find((t) => t.TagKey === 'purpose')?.TagValue).toBe('tenant_data');
    expect(daClinica?.Tags.some((t) => t.TagKey === 'batch_id')).toBe(false);
    // Rotação só na chave da clínica (a de lote vive ≤ 7 dias).
    expect(kms.calls.filter((c) => c.op === 'enableKeyRotation')).toHaveLength(1);
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

  it('destruir de novo uma chave já pendente é idempotente (retomada da eliminação)', async () => {
    const kms = fakeKms();
    const p = new KmsKeyProvider(kms);
    const arn = await p.createMasterKey(tenantA);
    await p.destroyMasterKey(arn);
    await expect(p.destroyMasterKey(arn)).resolves.toBeUndefined();
    expect(kms.calls.at(-1)).toEqual({ op: 'describeKey', input: { KeyId: arn } });
  });

  it('erro de agendamento com a chave ainda ativa NÃO é tratado como feito', async () => {
    const kms = fakeKms();
    const p = new KmsKeyProvider(kms);
    kms.scheduleKeyDeletion = () => Promise.reject(new Error('AccessDenied'));
    await expect(p.destroyMasterKey(await p.createMasterKey(tenantA))).rejects.toBeInstanceOf(KeyUnavailableError);
  });

  it('cancelar a destruição cancela o agendamento e reabilita a chave (fica Disabled no KMS)', async () => {
    const kms = fakeKms();
    const p = new KmsKeyProvider(kms);
    const arn = await p.createMasterKey(tenantA);
    await p.destroyMasterKey(arn);
    await p.cancelMasterKeyDestruction(arn);
    expect(kms.calls.slice(-2)).toEqual([
      { op: 'cancelKeyDeletion', input: { KeyId: arn } },
      { op: 'enableKey', input: { KeyId: arn } },
    ]);
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

describe('DisposableKeys: chave descartável por escopo (R3 do importador, crypto-shredding por lote)', () => {
  const lote = randomUUID();
  const ref = { tenantId: tenantA, table: 'import_raw_files', column: 'content', rowId: lote };
  const bruto = Buffer.from('nome;cpf\nPaciente Ficticio;00000000191\n');
  const provedores: readonly [string, () => { provider: LocalKeyProvider | KmsKeyProvider; kms?: FakeKms }][] = [
    ['provedor local', () => ({ provider: new LocalKeyProvider({ nodeEnv: 'test' }) })],
    [
      'KMS falso',
      () => {
        const kms = fakeKms();
        return { provider: new KmsKeyProvider(kms), kms };
      },
    ],
  ];

  for (const [nome, criar] of provedores) {
    it(`${nome}: abre antes; depois de destruir, nem a cópia de backup (chave embrulhada + cifra) abre`, async () => {
      const { provider, kms } = criar();
      const chaves = new DisposableKeys(provider);
      const { key, sealed } = await chaves.createAndSeal(tenantA, lote, ref, bruto);
      expect(sealed.startsWith(`v1:${lote}:`)).toBe(true);
      expect(sealed).not.toContain('Ficticio');
      expect(await chaves.open(tenantA, key, ref, sealed)).toEqual(bruto);
      // Outra clínica e outra linha não abrem (EncryptionContext/AAD).
      await expect(chaves.open(tenantB, key, { ...ref, tenantId: tenantB }, sealed)).rejects.toThrow();
      await expect(chaves.open(tenantA, key, { ...ref, rowId: randomUUID() }, sealed)).rejects.toThrow();
      // "Backup": cópia da linha da chave e do valor cifrado tirada ANTES do descarte.
      const backup = { key: { ...key, wrapped: Buffer.from(key.wrapped) }, sealed };
      await chaves.destroy(tenantA, key.masterKeyId);
      await expect(chaves.open(tenantA, backup.key, ref, backup.sealed)).rejects.toBeInstanceOf(KeyUnavailableError);
      if (kms) {
        // R3-b: a tag de finalidade vai NA CRIAÇÃO (o IAM condiciona CreateKey a aws:RequestTag/purpose).
        expect(kms.calls.find((c) => c.op === 'createKey')?.input).toMatchObject({
          Tags: [
            { TagKey: 'tenant_id', TagValue: tenantA },
            { TagKey: 'purpose', TagValue: 'import_batch' },
            { TagKey: 'batch_id', TagValue: lote },
          ],
        });
        expect(kms.calls.some((c) => c.op === 'enableKeyRotation')).toBe(false);
        expect(kms.calls.find((c) => c.op === 'generateDataKey')?.input).toMatchObject({ EncryptionContext: { tenant_id: tenantA } });
        expect(kms.calls.find((c) => c.op === 'scheduleKeyDeletion')).toEqual({
          op: 'scheduleKeyDeletion',
          input: { KeyId: key.masterKeyId, PendingWindowInDays: 7 },
        });
      }
      // Idempotente.
      await expect(chaves.destroy(tenantA, key.masterKeyId)).resolves.toBeUndefined();
    });
  }

  it('cada escopo tem a própria chave mestra: destruir um lote não afeta outro da mesma clínica', async () => {
    const chaves = new DisposableKeys(new LocalKeyProvider({ nodeEnv: 'test' }));
    const outro = randomUUID();
    const a = await chaves.createAndSeal(tenantA, lote, ref, bruto);
    const b = await chaves.createAndSeal(tenantA, outro, { ...ref, rowId: outro }, bruto);
    expect(a.key.masterKeyId).not.toBe(b.key.masterKeyId);
    await chaves.destroy(tenantA, a.key.masterKeyId);
    expect(await chaves.open(tenantA, b.key, { ...ref, rowId: outro }, b.sealed)).toEqual(bruto);
  });
});
