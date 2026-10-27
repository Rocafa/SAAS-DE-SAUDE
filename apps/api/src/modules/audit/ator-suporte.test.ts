import { randomBytes } from 'node:crypto';
import type { TenantId } from '@plataforma/shared';
import { describe, expect, it } from 'vitest';
import type { TenantTx } from '../../db/tenant-transaction';
import {
  AcessoDeSuporteInvalidoError,
  loadSupportPseudonymKey,
  recordSupportAudit,
  supportActorPseudonym,
} from './ator-suporte';

const T1 = '6f1c2a10-0000-4000-8000-000000000001' as TenantId;
const T2 = '6f1c2a10-0000-4000-8000-000000000002' as TenantId;

describe('pseudônimo do atendente do suporte (Decisão 1, migração 0008)', () => {
  const chave = randomBytes(32);

  it('estável dentro da clínica, diferente entre clínicas, atendentes e segredos', () => {
    const a = supportActorPseudonym(chave, T1, 'atendente-01');
    expect(supportActorPseudonym(chave, T1, 'atendente-01')).toBe(a);
    expect(supportActorPseudonym(chave, T2, 'atendente-01')).not.toBe(a);
    expect(supportActorPseudonym(chave, T1, 'atendente-02')).not.toBe(a);
    expect(supportActorPseudonym(randomBytes(32), T1, 'atendente-01')).not.toBe(a);
  });

  it('formato UUID versão 8 (cabe em actor_id) e não contém o id do atendente', () => {
    const a = supportActorPseudonym(chave, T1, 'atendente-01');
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).not.toContain('atendente');
  });

  it('recusa segredo curto e id de atendente fora do formato', () => {
    expect(() => supportActorPseudonym(randomBytes(16), T1, 'atendente-01')).toThrow(/curto/);
    expect(() => supportActorPseudonym(chave, T1, 'Nome Completo')).toThrow(AcessoDeSuporteInvalidoError);
    expect(() => supportActorPseudonym(chave, T1, '')).toThrow(AcessoDeSuporteInvalidoError);
  });

  it('segredo: obrigatório fora de development/test (lista fechada), ≥ 32 bytes', () => {
    for (const NODE_ENV of ['production', 'staging', '', undefined]) {
      expect(() => loadSupportPseudonymKey({ NODE_ENV })).toThrow(/SUPPORT_PSEUDONYM_KEY/);
    }
    expect(() => loadSupportPseudonymKey({ NODE_ENV: 'production', SUPPORT_PSEUDONYM_KEY: randomBytes(16).toString('base64') })).toThrow(
      /32 bytes/,
    );
    const valor = randomBytes(32);
    expect(loadSupportPseudonymKey({ NODE_ENV: 'production', SUPPORT_PSEUDONYM_KEY: valor.toString('base64') })).toEqual(valor);
    expect(loadSupportPseudonymKey({ NODE_ENV: 'test' })).toHaveLength(32);
  });

  it('acesso sem chamado válido, sem motivo conhecido ou com ticket no metadata é recusado antes do banco', async () => {
    const tx = {} as TenantTx; // nunca é usado: a validação falha antes
    const base = { tenantId: T1, atendenteId: 'atendente-01', chamado: 'SUP-1234', motivo: 'pedido_da_clinica' } as const;
    const entrada = { action: 'read', scope: 'patients' } as const;
    await expect(recordSupportAudit(tx, chave, { ...base, chamado: '1234' }, entrada)).rejects.toThrow(/chamado/);
    await expect(recordSupportAudit(tx, chave, { ...base, chamado: 'SUP-12345678' }, entrada)).rejects.toThrow(/chamado/);
    await expect(
      recordSupportAudit(tx, chave, { ...base, motivo: 'curiosidade' as 'break_glass' }, entrada),
    ).rejects.toThrow(/motivo/);
    await expect(
      recordSupportAudit(tx, chave, base, { ...entrada, metadata: { ticket: 'SUP-1' } }),
    ).rejects.toThrow(/metadata/);
  });
});
