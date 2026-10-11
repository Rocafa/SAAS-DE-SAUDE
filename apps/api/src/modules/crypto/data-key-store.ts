import type { TenantId } from '@plataforma/shared';
import { sql } from 'drizzle-orm';
import type { TenantTx } from '../../db/tenant-transaction';
import type { WrappedDataKey } from './key-provider';

export type KeyStatus = 'active' | 'retired' | 'destroyed';

export interface DataKeyRecord extends WrappedDataKey {
  readonly id: string;
  readonly status: Exclude<KeyStatus, 'destroyed'>;
}

/**
 * Persistência das chaves da clínica (migração 0004). Toda chamada roda na transação do tenant
 * (`withTenant`), então o RLS garante que uma clínica só enxerga as próprias chaves.
 */
export interface DataKeyStore<Tx> {
  /** Serializa operações de gestão de chave da clínica (provisionar, girar, destruir). */
  lockTenant(tx: Tx, tenantId: TenantId): Promise<void>;
  findActiveMaster(tx: Tx, tenantId: TenantId): Promise<string | undefined>;
  insertMaster(tx: Tx, tenantId: TenantId, masterKeyId: string): Promise<void>;
  retireMaster(tx: Tx, tenantId: TenantId, masterKeyId: string): Promise<void>;
  findActive(tx: Tx, tenantId: TenantId): Promise<DataKeyRecord | undefined>;
  /** `destroyed` quando a chave existiu e foi destruída; undefined quando não existe para a clínica. */
  findById(tx: Tx, tenantId: TenantId, id: string): Promise<DataKeyRecord | 'destroyed' | undefined>;
  insertActive(tx: Tx, tenantId: TenantId, key: WrappedDataKey): Promise<string>;
  retire(tx: Tx, tenantId: TenantId, id: string): Promise<void>;
  listLive(tx: Tx, tenantId: TenantId): Promise<DataKeyRecord[]>;
  updateWrapped(tx: Tx, tenantId: TenantId, id: string, key: WrappedDataKey): Promise<void>;
  /** Marca DEKs e chaves mestras como destruídas; devolve as chaves mestras a destruir no provedor. */
  destroyAll(tx: Tx, tenantId: TenantId): Promise<string[]>;
}

interface Row extends Record<string, unknown> {
  id: string;
  master_key_id: string;
  wrapped_key: Buffer | null;
  status: KeyStatus;
}

function toRecord(row: Row): DataKeyRecord | 'destroyed' {
  if (row.status === 'destroyed' || !row.wrapped_key) return 'destroyed';
  return { id: row.id, masterKeyId: row.master_key_id, wrapped: Buffer.from(row.wrapped_key), status: row.status };
}

export class PgDataKeyStore implements DataKeyStore<TenantTx> {
  async lockTenant(tx: TenantTx, tenantId: TenantId): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`tenant_keys:${tenantId}`}, 0))`);
  }

  async findActiveMaster(tx: TenantTx, tenantId: TenantId): Promise<string | undefined> {
    const rows = await tx.execute<{ id: string }>(
      sql`select id from tenant_master_keys where tenant_id = ${tenantId} and status = 'active'`,
    );
    return rows[0]?.id;
  }

  async insertMaster(tx: TenantTx, tenantId: TenantId, masterKeyId: string): Promise<void> {
    await tx.execute(sql`insert into tenant_master_keys (id, tenant_id) values (${masterKeyId}, ${tenantId})`);
  }

  async retireMaster(tx: TenantTx, tenantId: TenantId, masterKeyId: string): Promise<void> {
    await tx.execute(
      sql`update tenant_master_keys set status = 'retired'
          where tenant_id = ${tenantId} and id = ${masterKeyId} and status = 'active'`,
    );
  }

  async findActive(tx: TenantTx, tenantId: TenantId): Promise<DataKeyRecord | undefined> {
    const rows = await tx.execute<Row>(
      sql`select id, master_key_id, wrapped_key, status from tenant_data_keys
          where tenant_id = ${tenantId} and status = 'active'`,
    );
    const rec = rows[0] && toRecord(rows[0]);
    return rec === 'destroyed' ? undefined : rec;
  }

  async findById(tx: TenantTx, tenantId: TenantId, id: string): Promise<DataKeyRecord | 'destroyed' | undefined> {
    const rows = await tx.execute<Row>(
      sql`select id, master_key_id, wrapped_key, status from tenant_data_keys
          where tenant_id = ${tenantId} and id = ${id}::uuid`,
    );
    return rows[0] && toRecord(rows[0]);
  }

  async insertActive(tx: TenantTx, tenantId: TenantId, key: WrappedDataKey): Promise<string> {
    const rows = await tx.execute<{ id: string }>(
      sql`insert into tenant_data_keys (tenant_id, master_key_id, wrapped_key)
          values (${tenantId}, ${key.masterKeyId}, ${key.wrapped}) returning id`,
    );
    const id = rows[0]?.id;
    if (!id) throw new Error('falha ao gravar a chave de dados');
    return id;
  }

  async retire(tx: TenantTx, tenantId: TenantId, id: string): Promise<void> {
    await tx.execute(
      sql`update tenant_data_keys set status = 'retired', retired_at = now()
          where tenant_id = ${tenantId} and id = ${id}::uuid and status = 'active'`,
    );
  }

  async listLive(tx: TenantTx, tenantId: TenantId): Promise<DataKeyRecord[]> {
    const rows = await tx.execute<Row>(
      sql`select id, master_key_id, wrapped_key, status from tenant_data_keys
          where tenant_id = ${tenantId} and status <> 'destroyed' order by created_at desc`,
    );
    return rows.map(toRecord).filter((r): r is DataKeyRecord => r !== 'destroyed');
  }

  async updateWrapped(tx: TenantTx, tenantId: TenantId, id: string, key: WrappedDataKey): Promise<void> {
    await tx.execute(
      sql`update tenant_data_keys set master_key_id = ${key.masterKeyId}, wrapped_key = ${key.wrapped}
          where tenant_id = ${tenantId} and id = ${id}::uuid and status <> 'destroyed'`,
    );
  }

  async destroyAll(tx: TenantTx, tenantId: TenantId): Promise<string[]> {
    await tx.execute(
      sql`update tenant_data_keys set status = 'destroyed', wrapped_key = null, destroyed_at = now()
          where tenant_id = ${tenantId} and status <> 'destroyed'`,
    );
    const rows = await tx.execute<{ id: string }>(
      sql`update tenant_master_keys set status = 'destroyed', destroyed_at = now()
          where tenant_id = ${tenantId} and status <> 'destroyed' returning id`,
    );
    return rows.map((r) => r.id);
  }
}
