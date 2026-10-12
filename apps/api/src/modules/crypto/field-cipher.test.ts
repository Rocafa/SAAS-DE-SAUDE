import type { TenantId } from '@plataforma/shared';
import { randomUUID } from 'node:crypto';
import { inspect } from 'node:util';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FieldCryptoError,
  FieldDecryptionError,
  InvalidFieldRefError,
  KeyUnavailableError,
  TenantKeyMissingError,
} from './crypto-errors';
import { DataKey } from './data-key';
import { DataKeyCache } from './data-key-cache';
import { FieldCipher, type KeyAuditor, type KeyEvent } from './field-cipher';
import { AllExceptionsFilter } from '../../lifecycle/all-exceptions.filter';
import { KeyDestructionIncompleteError } from './crypto-errors';
import { isEncryptedField, parseField, type FieldRef } from './field-format';
import { LocalKeyProvider } from './local-key-provider';
import { MemoryDataKeyStore } from './memory-data-key-store';

// Dados 100% fictícios.
const tenantA = randomUUID() as TenantId;
const tenantB = randomUUID() as TenantId;
const ref = (tenantId: TenantId, over: Partial<FieldRef> = {}): FieldRef => ({
  tenantId,
  table: 'record_entries',
  column: 'body',
  rowId: '00000000-0000-4000-8000-000000000001',
  ...over,
});
const TEXTO = 'Paciente fictício relata cefaleia há 3 dias. Conduta: observação.';
const ATOR = randomUUID();

let provider: LocalKeyProvider;
let store: MemoryDataKeyStore;
let cipher: FieldCipher<unknown>;
let eventos: KeyEvent[];
const auditar: KeyAuditor<unknown> = (_tx, e) => {
  eventos.push(e);
  return Promise.resolve();
};

beforeEach(async () => {
  eventos = [];
  provider = new LocalKeyProvider({ nodeEnv: 'test' });
  store = new MemoryDataKeyStore();
  cipher = new FieldCipher(provider, store, auditar);
  await cipher.provisionTenant(null, tenantA, ATOR);
  await cipher.provisionTenant(null, tenantB, ATOR);
});

/** Troca um caractere base64url do trecho `part` (1=keyId … 4=dado) por outro válido. */
function tamper(value: string, part: number): string {
  const parts = value.split(':');
  const seg = parts[part] ?? '';
  const i = Math.floor(seg.length / 2);
  const ch = seg[i] === 'a' ? 'b' : 'a';
  parts[part] = seg.slice(0, i) + ch + seg.slice(i + 1);
  return parts.join(':');
}

describe('formato e ida e volta', () => {
  it('cifra e decifra texto, vazio e binário', async () => {
    const v = await cipher.encrypt(null, ref(tenantA), TEXTO);
    expect(await cipher.decryptString(null, ref(tenantA), v)).toBe(TEXTO);
    const vazio = await cipher.encrypt(null, ref(tenantA), '');
    expect(await cipher.decryptString(null, ref(tenantA), vazio)).toBe('');
    const bin = Buffer.from([0, 1, 2, 255]);
    const vb = await cipher.encrypt(null, ref(tenantA), bin);
    expect(await cipher.decrypt(null, ref(tenantA), vb)).toEqual(bin);
  });

  it('usa o formato versionado v1:keyId:iv:tag:dado e não contém o texto', async () => {
    const v = await cipher.encrypt(null, ref(tenantA), TEXTO);
    expect(v).toMatch(/^v1:[0-9a-f-]{36}:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]+$/);
    expect(isEncryptedField(v)).toBe(true);
    expect(v).not.toContain('cefaleia');
    expect(parseField(v).keyId).toBe(store.dataKeys.find((k) => k.tenantId === tenantA)?.id);
  });

  it('IV novo a cada valor: o mesmo texto gera cifras diferentes', async () => {
    const a = await cipher.encrypt(null, ref(tenantA), TEXTO);
    const b = await cipher.encrypt(null, ref(tenantA), TEXTO);
    expect(a).not.toBe(b);
    expect(a.split(':')[2]).not.toBe(b.split(':')[2]);
  });

  it('referência inválida é recusada antes de cifrar', async () => {
    await expect(cipher.encrypt(null, ref(tenantA, { table: 'X; drop' }), TEXTO)).rejects.toBeInstanceOf(
      InvalidFieldRefError,
    );
    await expect(cipher.encrypt(null, ref(tenantA, { rowId: '' }), TEXTO)).rejects.toBeInstanceOf(InvalidFieldRefError);
    await expect(cipher.encrypt(null, ref('nao-uuid' as TenantId), TEXTO)).rejects.toBeInstanceOf(InvalidFieldRefError);
  });

  it('clínica sem chave provisionada: falha fechada, nada é cifrado', async () => {
    await expect(cipher.encrypt(null, ref(randomUUID() as TenantId), TEXTO)).rejects.toBeInstanceOf(
      TenantKeyMissingError,
    );
  });

  it('provisionar é idempotente: uma chave mestra e uma DEK ativa por clínica', async () => {
    await cipher.provisionTenant(null, tenantA, ATOR);
    expect(store.masterKeys.filter((m) => m.tenantId === tenantA)).toHaveLength(1);
    expect(store.dataKeys.filter((k) => k.tenantId === tenantA && k.status === 'active')).toHaveLength(1);
    const masterA = store.masterKeys.find((m) => m.tenantId === tenantA)?.id;
    const masterB = store.masterKeys.find((m) => m.tenantId === tenantB)?.id;
    expect(masterA).not.toBe(masterB);
  });
});

describe('isolamento: outra clínica não decifra', () => {
  it('valor de A apresentado como de B falha', async () => {
    const v = await cipher.encrypt(null, ref(tenantA), TEXTO);
    await expect(cipher.decrypt(null, ref(tenantB), v)).rejects.toBeInstanceOf(FieldDecryptionError);
  });

  it('mesmo com a DEK de A em cache, o pedido de B não a encontra', async () => {
    const v = await cipher.encrypt(null, ref(tenantA), TEXTO);
    await cipher.decrypt(null, ref(tenantA), v); // aquece o cache de A
    await expect(cipher.decrypt(null, ref(tenantB), v)).rejects.toBeInstanceOf(FieldDecryptionError);
  });

  it('DEK de A copiada para B (linha forjada) não abre: a chave mestra amarra a clínica', async () => {
    const dekA = store.dataKeys.find((k) => k.tenantId === tenantA);
    if (!dekA?.wrapped) throw new Error('setup');
    store.dataKeys.push({ ...dekA, tenantId: tenantB, wrapped: Buffer.from(dekA.wrapped) });
    const fresh = new FieldCipher(provider, store, auditar);
    const v = await cipher.encrypt(null, ref(tenantA), TEXTO);
    await expect(fresh.decrypt(null, ref(tenantB), v)).rejects.toBeInstanceOf(KeyUnavailableError);
  });
});

describe('adulteração é detectada (AES-GCM + AAD)', () => {
  it.each([
    ['iv', 2],
    ['tag', 3],
    ['dado', 4],
  ])('alterar %s', async (_nome, parte) => {
    const v = await cipher.encrypt(null, ref(tenantA), TEXTO);
    await expect(cipher.decrypt(null, ref(tenantA), tamper(v, parte))).rejects.toBeInstanceOf(FieldDecryptionError);
  });

  it('trocar o keyId', async () => {
    const v = await cipher.encrypt(null, ref(tenantA), TEXTO);
    await expect(cipher.decrypt(null, ref(tenantA), tamper(v, 1))).rejects.toBeInstanceOf(FieldDecryptionError);
  });

  it('truncar, versão desconhecida ou lixo', async () => {
    const v = await cipher.encrypt(null, ref(tenantA), TEXTO);
    for (const bad of [v.slice(0, -4), v.replace(/^v1/, 'v9'), 'texto em claro', '']) {
      await expect(cipher.decrypt(null, ref(tenantA), bad)).rejects.toBeInstanceOf(FieldDecryptionError);
    }
  });

  it.each([
    ['tabela', { table: 'patients' }],
    ['coluna', { column: 'summary' }],
    ['linha', { rowId: '00000000-0000-4000-8000-000000000002' }],
  ])('mover o valor para outra %s', async (_nome, over) => {
    const v = await cipher.encrypt(null, ref(tenantA), TEXTO);
    await expect(cipher.decrypt(null, ref(tenantA, over), v)).rejects.toBeInstanceOf(FieldDecryptionError);
  });
});

describe('rotação sem downtime', () => {
  it('DEK nova cifra; valores antigos continuam abrindo; recifrar atualiza', async () => {
    const antigo = await cipher.encrypt(null, ref(tenantA), TEXTO);
    const novaId = await cipher.rotateDataKey(null, tenantA, ATOR);
    const novo = await cipher.encrypt(null, ref(tenantA), TEXTO);
    expect(parseField(novo).keyId).toBe(novaId);
    expect(parseField(antigo).keyId).not.toBe(novaId);
    expect(await cipher.decryptString(null, ref(tenantA), antigo)).toBe(TEXTO);
    expect(await cipher.isStale(null, tenantA, antigo)).toBe(true);
    const recifrado = await cipher.reencrypt(null, ref(tenantA), antigo);
    expect(parseField(recifrado).keyId).toBe(novaId);
    expect(await cipher.decryptString(null, ref(tenantA), recifrado)).toBe(TEXTO);
    expect(await cipher.reencrypt(null, ref(tenantA), recifrado)).toBe(recifrado);
    expect(
      store.dataKeys
        .filter((k) => k.tenantId === tenantA)
        .map((k) => k.status)
        .sort(),
    ).toEqual(['active', 'retired']);
  });

  it('girar a chave mestra re-cifra as DEKs sem tocar nos dados', async () => {
    const antes = await cipher.encrypt(null, ref(tenantA), TEXTO);
    const velha = store.masterKeys.find((m) => m.tenantId === tenantA)?.id;
    const nova = await cipher.rotateMasterKey(null, tenantA, ATOR);
    expect(nova).not.toBe(velha);
    expect(store.dataKeys.filter((k) => k.tenantId === tenantA).every((k) => k.masterKeyId === nova)).toBe(true);
    expect(store.masterKeys.find((m) => m.id === velha)?.status).toBe('retired');
    const semCache = new FieldCipher(provider, store, auditar);
    expect(await semCache.decryptString(null, ref(tenantA), antes)).toBe(TEXTO);
  });
});

describe('destruir a chave da clínica deixa tudo ilegível (retencao-e-descarte §4.1)', () => {
  it('banco atual, cache e cópias de backup (antes e depois de girar a chave mestra)', async () => {
    const v1 = await cipher.encrypt(null, ref(tenantA), TEXTO);
    const backupAntigo = store.snapshot(); // backup feito com a chave mestra original
    // Sanidade: o backup abre antes da destruição.
    expect(await new FieldCipher(provider, backupAntigo, auditar).decryptString(null, ref(tenantA), v1)).toBe(TEXTO);
    await cipher.rotateMasterKey(null, tenantA, ATOR);
    await cipher.rotateDataKey(null, tenantA, ATOR);
    const v2 = await cipher.encrypt(null, ref(tenantA), 'segundo registro fictício');
    const backupRecente = store.snapshot();
    const vB = await cipher.encrypt(null, ref(tenantB), TEXTO);

    await cipher.destroyTenantKeys(null, tenantA, ATOR);

    // Banco atual (o cache também foi zerado).
    for (const v of [v1, v2]) {
      await expect(cipher.decrypt(null, ref(tenantA), v)).rejects.toBeInstanceOf(KeyUnavailableError);
    }
    expect(store.dataKeys.filter((k) => k.tenantId === tenantA).every((k) => k.wrapped === null)).toBe(true);
    // Backups restaurados: as DEKs cifradas estão lá, mas as chaves mestras (as duas) não existem mais.
    for (const backup of [backupAntigo, backupRecente]) {
      const restaurado = new FieldCipher(provider, backup, auditar, { cache: new DataKeyCache() });
      await expect(restaurado.decrypt(null, ref(tenantA), v1)).rejects.toBeInstanceOf(KeyUnavailableError);
    }
    await expect(
      new FieldCipher(provider, backupRecente, auditar).decrypt(null, ref(tenantA), v2),
    ).rejects.toBeInstanceOf(FieldCryptoError);
    // Outras clínicas não são afetadas.
    expect(await cipher.decryptString(null, ref(tenantB), vB)).toBe(TEXTO);
    // E a clínica não volta a cifrar sem novo provisionamento.
    await expect(cipher.encrypt(null, ref(tenantA), TEXTO)).rejects.toBeInstanceOf(TenantKeyMissingError);
  });
});

describe('nenhuma chave em log ou erro', () => {
  it('DataKey não se revela por inspect, JSON, String nem propriedades', () => {
    const bytes = Buffer.alloc(32, 0xab);
    const key = DataKey.fromBytes(bytes);
    const hex = bytes.toString('hex');
    const b64 = bytes.toString('base64');
    for (const out of [inspect(key, { showHidden: true, depth: 5 }), JSON.stringify({ key }), String(key)]) {
      expect(out).not.toContain(hex);
      expect(out).not.toContain(b64);
      expect(out).not.toContain('171'); // 0xab em decimal, como apareceria num Buffer serializado
    }
    expect(Object.values(key)).not.toContainEqual(expect.any(Buffer));
  });

  it('DataKey destruída zera os bytes e recusa uso (nunca cifra com chave zerada)', () => {
    const key = DataKey.fromBytes(Buffer.alloc(32, 7));
    let guardado: Buffer | undefined;
    key.use((b) => {
      guardado = b;
    });
    key.destroy();
    expect(guardado?.every((x) => x === 0)).toBe(true);
    expect(() => key.use(() => 1)).toThrow(KeyUnavailableError);
  });

  it('erros têm mensagem fixa, sem cifra, AAD, ids nem causa encadeada', async () => {
    const v = await cipher.encrypt(null, ref(tenantA), TEXTO);
    const errs: unknown[] = [];
    for (const p of [
      cipher.decrypt(null, ref(tenantA), tamper(v, 4)),
      cipher.decrypt(null, ref(tenantB), v),
      cipher.decrypt(null, ref(tenantA), 'lixo'),
    ]) {
      errs.push(await p.catch((e: unknown) => e));
    }
    await cipher.destroyTenantKeys(null, tenantA, ATOR);
    errs.push(await cipher.decrypt(null, ref(tenantA), v).catch((e: unknown) => e));
    for (const e of errs) {
      expect(e).toBeInstanceOf(FieldCryptoError);
      const err = e as Error;
      expect(err.cause).toBeUndefined();
      const dump = `${err.message}\n${err.stack ?? ''}\n${inspect(err)}`;
      for (const parte of v.split(':').slice(1)) expect(dump).not.toContain(parte);
      expect(dump).not.toContain(tenantA);
      expect(dump).not.toContain('record_entries');
    }
  });
});

describe('cache de DEK com TTL curto', () => {
  it('reaproveita a DEK dentro do TTL e volta ao provedor depois', async () => {
    let agora = 1_000;
    const cache = new DataKeyCache({ ttlMs: 50, now: () => agora });
    const c = new FieldCipher(provider, store, auditar, { cache });
    const unwrap = vi.spyOn(provider, 'unwrapDataKey');
    const v = await cipher.encrypt(null, ref(tenantA), TEXTO);
    await c.decrypt(null, ref(tenantA), v);
    await c.decrypt(null, ref(tenantA), v);
    expect(unwrap).toHaveBeenCalledTimes(1);
    agora += 51;
    await c.decrypt(null, ref(tenantA), v);
    expect(unwrap).toHaveBeenCalledTimes(2);
  });

  it('respeita o limite de entradas', () => {
    const cache = new DataKeyCache({ maxEntries: 2 });
    for (let i = 0; i < 5; i++) cache.set(tenantA, randomUUID(), DataKey.fromBytes(Buffer.alloc(32, i)));
    expect(cache.size).toBe(2);
  });
});

describe('ressalvas do Guardião (PR #35)', () => {
  it('R1: destruição feita por outra instância vale na hora, mesmo com a DEK em cache', async () => {
    const instancia2 = new FieldCipher(provider, store, auditar);
    const v = await cipher.encrypt(null, ref(tenantA), TEXTO);
    expect(await instancia2.decryptString(null, ref(tenantA), v)).toBe(TEXTO); // DEK no cache da instância 2
    await cipher.destroyTenantKeys(null, tenantA, ATOR); // a instância 1 destrói
    await expect(instancia2.decrypt(null, ref(tenantA), v)).rejects.toBeInstanceOf(KeyUnavailableError);
  });

  it('R2: se o provedor falhar no meio, os agendamentos já feitos são cancelados e nada se perde', async () => {
    const v1 = await cipher.encrypt(null, ref(tenantA), TEXTO);
    const backupComKekAntiga = store.snapshot(); // depende da 1ª chave mestra
    await cipher.rotateMasterKey(null, tenantA, ATOR); // agora A tem duas chaves mestras
    const antes = store.snapshot();
    const destroy = provider.destroyMasterKey.bind(provider);
    const destruidas: string[] = [];
    vi.spyOn(provider, 'destroyMasterKey').mockImplementation(async (id: string) => {
      if (destruidas.length === 1) throw new KeyUnavailableError(); // falha na 2ª
      destruidas.push(id);
      await destroy(id);
    });
    await expect(cipher.destroyTenantKeys(null, tenantA, ATOR)).rejects.toBeInstanceOf(KeyUnavailableError);
    expect(destruidas).toHaveLength(1);
    // Simula o rollback da transação: o banco volta ao estado anterior. As DUAS chaves mestras
    // precisam abrir — inclusive a que chegou a ser agendada para destruição.
    for (const banco of [antes, backupComKekAntiga]) {
      const restaurado = new FieldCipher(provider, banco, auditar, { cache: new DataKeyCache() });
      expect(await restaurado.decryptString(null, ref(tenantA), v1)).toBe(TEXTO);
    }
  });

  it('R2: se até o cancelamento falhar, o erro exige intervenção', async () => {
    await cipher.rotateMasterKey(null, tenantA, ATOR);
    const destroy = provider.destroyMasterKey.bind(provider);
    let chamadas = 0;
    vi.spyOn(provider, 'destroyMasterKey').mockImplementation(async (id: string) => {
      if (++chamadas === 2) throw new KeyUnavailableError();
      await destroy(id);
    });
    vi.spyOn(provider, 'cancelMasterKeyDestruction').mockRejectedValue(new KeyUnavailableError());
    await expect(cipher.destroyTenantKeys(null, tenantA, ATOR)).rejects.toBeInstanceOf(KeyDestructionIncompleteError);
  });

  it('R3: a DEK gira sozinha ao atingir o limite de uso e o uso é somado no banco', async () => {
    const c = new FieldCipher(provider, store, auditar, { rotateAfter: 5, usageFlushEvery: 2 });
    const ids = new Set<string>();
    for (let i = 0; i < 12; i++) ids.add(parseField(await c.encrypt(null, ref(tenantA), TEXTO)).keyId);
    expect(ids.size).toBeGreaterThanOrEqual(2);
    const deA = store.dataKeys.filter((k) => k.tenantId === tenantA);
    expect(deA.filter((k) => k.status === 'retired').every((k) => k.encryptCount >= 5)).toBe(true);
    expect(eventos.some((e) => e.kind === 'rotate_dek' && e.actorId === null)).toBe(true);
  });

  it('R4: provisionar, girar e destruir emitem evento com o ator', async () => {
    eventos = [];
    const c = randomUUID() as TenantId;
    await cipher.provisionTenant(null, c, ATOR);
    await cipher.rotateDataKey(null, c, ATOR);
    await cipher.rotateMasterKey(null, c, ATOR);
    await cipher.destroyTenantKeys(null, c, ATOR);
    expect(eventos.map((e) => [e.kind, e.actorId, e.tenantId])).toEqual([
      ['provision', ATOR, c],
      ['rotate_dek', ATOR, c],
      ['rotate_kek', ATOR, c],
      ['destroy', ATOR, c],
    ]);
  });

  it('R4: se o registro do evento falhar, a destruição não acontece no provedor', async () => {
    const falha = new FieldCipher(provider, store, () => Promise.reject(new Error('auditoria fora')));
    const destroy = vi.spyOn(provider, 'destroyMasterKey');
    await expect(falha.destroyTenantKeys(null, tenantB, ATOR)).rejects.toThrow('auditoria fora');
    expect(destroy).not.toHaveBeenCalled();
  });

  it('R5: chave destruída e chave inexistente viram a MESMA resposta HTTP genérica', async () => {
    const v = await cipher.encrypt(null, ref(tenantA), TEXTO);
    const inexistente = await cipher.decrypt(null, ref(tenantB), v).catch((e: unknown) => e);
    await cipher.destroyTenantKeys(null, tenantA, ATOR);
    const destruida = await cipher.decrypt(null, ref(tenantA), v).catch((e: unknown) => e);
    const resposta = (erro: unknown) => {
      const out: { status?: number; body?: unknown } = {};
      const res = {
        headersSent: false,
        status(code: number) {
          out.status = code;
          return res;
        },
        setHeader() {
          return res;
        },
        json(body: unknown) {
          out.body = body;
          return res;
        },
      };
      const host = { switchToHttp: () => ({ getResponse: () => res }) };
      new AllExceptionsFilter().catch(erro, host as never);
      return out;
    };
    expect(resposta(inexistente)).toEqual(resposta(destruida));
    expect(resposta(destruida).status).toBe(500);
  });
});
