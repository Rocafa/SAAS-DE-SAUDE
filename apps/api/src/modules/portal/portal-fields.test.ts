import type { TenantId, UserId } from '@plataforma/shared';
import { describe, expect, it, vi } from 'vitest';
import type { TenantTx } from '../../db/tenant-transaction';
import { TenantKeyMissingError } from '../crypto/crypto-errors';
import type { FieldCipher } from '../crypto/field-cipher';
import { cifrarCampoPortal } from './portal-fields';

const TENANT = '11111111-1111-4111-8111-111111111111' as TenantId;
const LINHA = '22222222-2222-4222-8222-222222222222';
const tx = {} as TenantTx;

function cifraSemChave() {
  let provisionada = false;
  const provisionTenant = vi.fn(() => {
    provisionada = true;
    return Promise.resolve('dek');
  });
  const encrypt = vi.fn(() => (provisionada ? Promise.resolve('v1:selado') : Promise.reject(new TenantKeyMissingError())));
  return { cipher: { encrypt, provisionTenant } as unknown as FieldCipher<TenantTx>, provisionTenant };
}

describe('cifrarCampoPortal (V2 do parecer do #68)', () => {
  it('pelo portal (ator null) NUNCA provisiona chave: falha fechada', async () => {
    const { cipher, provisionTenant } = cifraSemChave();
    await expect(cifrarCampoPortal(cipher, tx, TENANT, null, LINHA, 'detail', 'texto ficticio')).rejects.toBeInstanceOf(TenantKeyMissingError);
    expect(provisionTenant).not.toHaveBeenCalled();
  });

  it('pela clínica (usuário da sessão) provisiona na primeira escrita cifrada', async () => {
    const { cipher, provisionTenant } = cifraSemChave();
    const usuario = '33333333-3333-4333-8333-333333333333' as UserId;
    await expect(cifrarCampoPortal(cipher, tx, TENANT, usuario, LINHA, 'answer', 'resposta ficticia')).resolves.toBe('v1:selado');
    expect(provisionTenant).toHaveBeenCalledWith(tx, TENANT, usuario);
  });
});
