import type { TenantId } from '@plataforma/shared';
import { sql } from 'drizzle-orm';
import type { TenantTx } from '../../db/tenant-transaction';
import type { WrappedDataKey } from './key-provider';

export type KeyStatus = 'active' | 'retired' | 'destroying' | 'destroyed';

export interface DataKeyRecord extends WrappedDataKey {
  readonly id: string;
  readonly status: Extract<KeyStatus, 'active' | 'retired'>;
  /** Cifragens já contabilizadas no banco (aproximado; ver addUsage). */
  readonly encryptCount: number;
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
  /** `destroyed` quando a chave existiu e foi (ou está sendo) destruída; undefined quando não existe para a clínica. */
  findById(tx: Tx, tenantId: TenantId, id: string): Promise<DataKeyRecord | 'destroyed' | undefined>;
  insertActive(tx: Tx, tenantId: TenantId, key: WrappedDataKey): Promise<string>;
  retire(tx: Tx, tenantId: TenantId, id: string): Promise<void>;
  listLive(tx: Tx, tenantId: TenantId): Promise<DataKeyRecord[]>;
  updateWrapped(tx: Tx, tenantId: TenantId, id: string, key: WrappedDataKey): Promise<void>;
  /** Soma cifragens feitas com a DEK (em lotes, para não travar a linha a cada campo). */
  addUsage(tx: Tx, tenantId: TenantId, id: string, count: number): Promise<void>;
  /**
   * 1ª fase da destruição: DEKs e chaves mestras vivas viram `destroying` (nada mais decifra).
   * Devolve TODAS as chaves mestras em `destroying` — inclusive de uma tentativa anterior que parou
   * no meio —, que são as que precisam ser destruídas no provedor.
   */
  beginDestroy(tx: Tx, tenantId: TenantId): Promise<string[]>;
  /** 2ª fase, depois do provedor: `destroying` vira `destroyed` e a DEK cifrada é apagada. */
  finishDestroy(tx: Tx, tenantId: TenantId): Promise<void>;
  /** A clínica já teve chave destruída (ou em destruição)? */
  hasDestroyedKeys(tx: Tx, tenantId: TenantId): Promise<boolean>;
}

interface Row extends Record<string, unknown> {
  id: string;
  master_key_id: string;
  wrapped_key: Buffer | null;
  status: KeyStatus;
  encrypt_count: string;
}

function toRecord(row: Row): DataKeyRecord | 'destroyed' {
  if (row.status === 'destroyed' || row.status === 'destroying' || !row.wrapped_key) return 'destroyed';
  return {
    id: row.id,
    masterKeyId: row.master_key_id,
    wrapped: Buffer.from(row.wrapped_key),
    status: row.status,
    encryptCount: Number(row.encrypt_count),
  };
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
      sql`select id, master_key_id, wrapped_key, status, encrypt_count::text as encrypt_count from tenant_data_keys
          where tenant_id = ${tenantId} and status = 'active'`,
    );
    const rec = rows[0] && toRecord(rows[0]);
    return rec === 'destroyed' ? undefined : rec;
  }

  async findById(tx: TenantTx, tenantId: TenantId, id: string): Promise<DataKeyRecord | 'destroyed' | undefined> {
    const rows = await tx.execute<Row>(
      sql`select id, master_key_id, wrapped_key, status, encrypt_count::text as encrypt_count from tenant_data_keys
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
      sql`select id, master_key_id, wrapped_key, status, encrypt_count::text as encrypt_count from tenant_data_keys
          where tenant_id = ${tenantId} and status in ('active', 'retired') order by created_at desc`,
    );
    return rows.map(toRecord).filter((r): r is DataKeyRecord => r !== 'destroyed');
  }

  async updateWrapped(tx: TenantTx, tenantId: TenantId, id: string, key: WrappedDataKey): Promise<void> {
    await tx.execute(
      sql`update tenant_data_keys set master_key_id = ${key.masterKeyId}, wrapped_key = ${key.wrapped}
          where tenant_id = ${tenantId} and id = ${id}::uuid and status in ('active', 'retired')`,
    );
  }

  async addUsage(tx: TenantTx, tenantId: TenantId, id: string, count: number): Promise<void> {
    await tx.execute(
      sql`update tenant_data_keys set encrypt_count = encrypt_count + ${count}
          where tenant_id = ${tenantId} and id = ${id}::uuid and status in ('active', 'retired')`,
    );
  }

  async beginDestroy(tx: TenantTx, tenantId: TenantId): Promise<string[]> {
    await tx.execute(
      sql`update tenant_data_keys set status = 'destroying'
          where tenant_id = ${tenantId} and status in ('active', 'retired')`,
    );
    await tx.execute(
      sql`update tenant_master_keys set status = 'destroying'
          where tenant_id = ${tenantId} and status in ('active', 'retired')`,
    );
    const rows = await tx.execute<{ id: string }>(
      sql`select id from tenant_master_keys where tenant_id = ${tenantId} and status = 'destroying' order by created_at`,
    );
    return rows.map((r) => r.id);
  }

  async finishDestroy(tx: TenantTx, tenantId: TenantId): Promise<void> {
    await tx.execute(
      sql`update tenant_data_keys set status = 'destroyed', wrapped_key = null, destroyed_at = now()
          where tenant_id = ${tenantId} and status = 'destroying'`,
    );
    await tx.execute(
      sql`update tenant_master_keys set status = 'destroyed', destroyed_at = now()
          where tenant_id = ${tenantId} and status = 'destroying'`,
    );
  }

  async hasDestroyedKeys(tx: TenantTx, tenantId: TenantId): Promise<boolean> {
    const rows = await tx.execute<{ n: number }>(
      sql`select count(*)::int as n from tenant_master_keys
          where tenant_id = ${tenantId} and status in ('destroying', 'destroyed')`,
    );
    return (rows[0]?.n ?? 0) > 0;
  }
}
