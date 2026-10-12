import type { TenantId } from '@plataforma/shared';
import { randomUUID } from 'node:crypto';
import type { DataKeyRecord, DataKeyStore, KeyStatus } from './data-key-store';
import type { WrappedDataKey } from './key-provider';

export interface StoredDataKey {
  readonly id: string;
  readonly tenantId: string;
  masterKeyId: string;
  wrapped: Buffer | null;
  status: KeyStatus;
  encryptCount: number;
}

export interface StoredMasterKey {
  readonly id: string;
  readonly tenantId: string;
  status: KeyStatus;
}

/**
 * Store em memória com as mesmas regras da migração 0004 (uma chave ativa por clínica, destruída é
 * terminal). Para testes unitários e para simular uma cópia de backup das tabelas de chave.
 */
export class MemoryDataKeyStore implements DataKeyStore<unknown> {
  readonly dataKeys: StoredDataKey[] = [];
  readonly masterKeys: StoredMasterKey[] = [];

  /** Cópia profunda do estado (como um snapshot/backup do banco). */
  snapshot(): MemoryDataKeyStore {
    const copy = new MemoryDataKeyStore();
    for (const k of this.dataKeys) copy.dataKeys.push({ ...k, wrapped: k.wrapped && Buffer.from(k.wrapped) });
    for (const m of this.masterKeys) copy.masterKeys.push({ ...m });
    return copy;
  }

  lockTenant(): Promise<void> {
    return Promise.resolve();
  }

  findActiveMaster(_tx: unknown, tenantId: TenantId): Promise<string | undefined> {
    return Promise.resolve(this.masterKeys.find((m) => m.tenantId === tenantId && m.status === 'active')?.id);
  }

  insertMaster(_tx: unknown, tenantId: TenantId, masterKeyId: string): Promise<void> {
    if (this.masterKeys.some((m) => m.tenantId === tenantId && m.status === 'active')) {
      return Promise.reject(new Error('já existe chave mestra ativa'));
    }
    this.masterKeys.push({ id: masterKeyId, tenantId, status: 'active' });
    return Promise.resolve();
  }

  retireMaster(_tx: unknown, tenantId: TenantId, masterKeyId: string): Promise<void> {
    const m = this.masterKeys.find((x) => x.tenantId === tenantId && x.id === masterKeyId && x.status === 'active');
    if (m) m.status = 'retired';
    return Promise.resolve();
  }

  findActive(_tx: unknown, tenantId: TenantId): Promise<DataKeyRecord | undefined> {
    const k = this.dataKeys.find((x) => x.tenantId === tenantId && x.status === 'active');
    return Promise.resolve(k && toRecord(k));
  }

  findById(_tx: unknown, tenantId: TenantId, id: string): Promise<DataKeyRecord | 'destroyed' | undefined> {
    const k = this.dataKeys.find((x) => x.tenantId === tenantId && x.id === id);
    if (!k) return Promise.resolve(undefined);
    return Promise.resolve(toRecord(k) ?? 'destroyed');
  }

  insertActive(_tx: unknown, tenantId: TenantId, key: WrappedDataKey): Promise<string> {
    if (this.dataKeys.some((x) => x.tenantId === tenantId && x.status === 'active')) {
      return Promise.reject(new Error('já existe chave de dados ativa'));
    }
    const id = randomUUID();
    this.dataKeys.push({ id, tenantId, masterKeyId: key.masterKeyId, wrapped: Buffer.from(key.wrapped), status: 'active', encryptCount: 0 });
    return Promise.resolve(id);
  }

  retire(_tx: unknown, tenantId: TenantId, id: string): Promise<void> {
    const k = this.dataKeys.find((x) => x.tenantId === tenantId && x.id === id && x.status === 'active');
    if (k) k.status = 'retired';
    return Promise.resolve();
  }

  listLive(_tx: unknown, tenantId: TenantId): Promise<DataKeyRecord[]> {
    return Promise.resolve(
      this.dataKeys
        .filter((x) => x.tenantId === tenantId)
        .map(toRecord)
        .filter((r): r is DataKeyRecord => r !== undefined),
    );
  }

  updateWrapped(_tx: unknown, tenantId: TenantId, id: string, key: WrappedDataKey): Promise<void> {
    const k = this.dataKeys.find((x) => x.tenantId === tenantId && x.id === id && x.status !== 'destroyed');
    if (k) {
      k.masterKeyId = key.masterKeyId;
      k.wrapped = Buffer.from(key.wrapped);
    }
    return Promise.resolve();
  }

  addUsage(_tx: unknown, tenantId: TenantId, id: string, count: number): Promise<void> {
    const k = this.dataKeys.find((x) => x.tenantId === tenantId && x.id === id && x.status !== 'destroyed');
    if (k) k.encryptCount += count;
    return Promise.resolve();
  }

  destroyAll(_tx: unknown, tenantId: TenantId): Promise<string[]> {
    for (const k of this.dataKeys) {
      if (k.tenantId === tenantId && k.status !== 'destroyed') {
        k.status = 'destroyed';
        k.wrapped = null;
      }
    }
    const ids: string[] = [];
    for (const m of this.masterKeys) {
      if (m.tenantId === tenantId && m.status !== 'destroyed') {
        m.status = 'destroyed';
        ids.push(m.id);
      }
    }
    return Promise.resolve(ids);
  }
}

function toRecord(k: StoredDataKey): DataKeyRecord | undefined {
  if (k.status === 'destroyed' || !k.wrapped) return undefined;
  return {
    id: k.id,
    masterKeyId: k.masterKeyId,
    wrapped: Buffer.from(k.wrapped),
    status: k.status,
    encryptCount: k.encryptCount,
  };
}
