import type { TenantId } from '@plataforma/shared';
import { describe, expect, it, vi } from 'vitest';
import { isTenantId, withTenant, type Database } from './tenant-transaction';
import { loadConfig } from '../config';

describe('isTenantId', () => {
  it('aceita UUID e rejeita o resto', () => {
    expect(isTenantId('00000000-0000-4000-8000-000000000001')).toBe(true);
    expect(isTenantId("x'; DROP TABLE patients; --")).toBe(false);
    expect(isTenantId('')).toBe(false);
    expect(isTenantId(undefined)).toBe(false);
  });
});

describe('withTenant', () => {
  it('falha fechada: não abre transação com tenant inválido', async () => {
    const transaction = vi.fn();
    const db = { transaction } as unknown as Database;
    await expect(withTenant(db, 'nao-e-uuid' as TenantId, () => Promise.resolve(1))).rejects.toThrow(
      'tenant_id inválido',
    );
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe('loadConfig', () => {
  it('exige DATABASE_URL', () => {
    expect(() => loadConfig({})).toThrow('DATABASE_URL');
  });
});
