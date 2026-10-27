import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { TenantId } from '@plataforma/shared';
import { describe, expect, it } from 'vitest';
import type { TenantTx } from '../../db/tenant-transaction';
import {
  AcessoDeSuporteInvalidoError,
  createPseudonymSigner,
  KmsPseudonymSigner,
  LocalPseudonymSigner,
  PseudonimoIndisponivelError,
  recordSupportAudit,
  supportActorPseudonym,
  type KmsMacApi,
} from './ator-suporte';

const T1 = '6f1c2a10-0000-4000-8000-000000000001' as TenantId;
const T2 = '6f1c2a10-0000-4000-8000-000000000002' as TenantId;

/** KMS de mentira: HMAC-SHA256 com uma chave que só ele conhece (como o KMS real). */
function kmsFalso(chave: Buffer, opcoes: { falhar?: boolean } = {}): KmsMacApi & { chamadas: string[] } {
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

  it('acesso sem chamado válido, sem motivo conhecido ou com ticket no metadata é recusado antes do banco', async () => {
    const tx = {} as TenantTx; // nunca é usado: a validação falha antes
    const signer = new LocalPseudonymSigner(chave, 'test');
    const base = { tenantId: T1, atendenteId: 'atendente-01', chamado: 'SUP-1234', motivo: 'pedido_da_clinica' } as const;
    const entrada = { action: 'read', scope: 'patients' } as const;
    await expect(recordSupportAudit(tx, signer, { ...base, chamado: '1234' }, entrada)).rejects.toThrow(/chamado/);
    await expect(recordSupportAudit(tx, signer, { ...base, chamado: 'SUP-12345678' }, entrada)).rejects.toThrow(/chamado/);
    await expect(
      recordSupportAudit(tx, signer, { ...base, motivo: 'curiosidade' as 'break_glass' }, entrada),
    ).rejects.toThrow(/motivo/);
    await expect(
      recordSupportAudit(tx, signer, base, { ...entrada, metadata: { ticket: 'SUP-1' } }),
    ).rejects.toThrow(/metadata/);
  });
});

describe('PseudonymSigner (N1: segredo fora do processo da API)', () => {
  it('signer local só existe em development/test (lista fechada)', () => {
    expect(new LocalPseudonymSigner(randomBytes(32), 'test').tipo).toBe('local');
    expect(new LocalPseudonymSigner(randomBytes(32), 'development').tipo).toBe('local');
    for (const env of ['production', 'staging', '', undefined, 'prod', 'Test']) {
      expect(() => new LocalPseudonymSigner(randomBytes(32), env), String(env)).toThrow(/proibido fora de development\/test/);
    }
    expect(() => new LocalPseudonymSigner(randomBytes(16), 'test')).toThrow(/32 bytes/);
  });

  it('KMS (GenerateMac) dá o MESMO pseudônimo que o HMAC com a mesma chave: a fórmula não muda', async () => {
    const chaveNoKms = randomBytes(32);
    const kms = kmsFalso(chaveNoKms);
    const signer = new KmsPseudonymSigner(kms, 'alias/pseudonimo-suporte');
    const p = await signer.pseudonimo(T1, 'atendente-01');
    expect(p).toBe(supportActorPseudonym(chaveNoKms, T1, 'atendente-01'));
    expect(await signer.pseudonimo(T2, 'atendente-01')).not.toBe(p);
    expect(kms.chamadas).toEqual(['generate:alias/pseudonimo-suporte', 'generate:alias/pseudonimo-suporte']);
  });

  it('KMS: atendente inválido nem chega ao KMS; falha do KMS sai com mensagem fixa (sem ARN)', async () => {
    const kms = kmsFalso(randomBytes(32));
    const signer = new KmsPseudonymSigner(kms, 'chave-x');
    await expect(signer.pseudonimo(T1, 'Nome Completo')).rejects.toBeInstanceOf(AcessoDeSuporteInvalidoError);
    expect(kms.chamadas).toEqual([]);
    const quebrado = new KmsPseudonymSigner(kmsFalso(randomBytes(32), { falhar: true }), 'chave-x');
    const erro = await quebrado.pseudonimo(T1, 'atendente-01').catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(PseudonimoIndisponivelError);
    expect(String((erro as Error).message)).not.toMatch(/arn|123/);
  });

  it('KMS: verificarChave usa GenerateMac + VerifyMac sobre a sonda fixa', async () => {
    const kms = kmsFalso(randomBytes(32));
    await expect(new KmsPseudonymSigner(kms, 'k').verificarChave()).resolves.toBeUndefined();
    expect(kms.chamadas).toEqual(['generate:k', 'verify:k']);
    const mentiroso: KmsMacApi = { ...kmsFalso(randomBytes(32)), verifyMac: () => Promise.resolve({ MacValid: false }) };
    await expect(new KmsPseudonymSigner(mentiroso, 'k').verificarChave()).rejects.toBeInstanceOf(PseudonimoIndisponivelError);
  });

  it('boot: fora de development/test sem KMS, a API não sobe; segredo em variável é recusado ali', () => {
    for (const NODE_ENV of ['production', 'staging', '', undefined]) {
      expect(() => createPseudonymSigner({ NODE_ENV }), String(NODE_ENV)).toThrow(/KMS do pseudônimo/);
      expect(
        () => createPseudonymSigner({ NODE_ENV, SUPPORT_PSEUDONYM_KEY: randomBytes(32).toString('base64') }),
        String(NODE_ENV),
      ).toThrow(/proibida fora de development\/test/);
    }
    // KMS configurado mas sem cliente ligado: também não sobe.
    expect(() => createPseudonymSigner({ NODE_ENV: 'production', SUPPORT_PSEUDONYM_KMS_KEY_ID: 'alias/x' })).toThrow(/cliente KMS/);
    const prod = createPseudonymSigner({ NODE_ENV: 'production', SUPPORT_PSEUDONYM_KMS_KEY_ID: 'alias/x' }, { kms: kmsFalso(randomBytes(32)) });
    expect(prod.tipo).toBe('kms');
  });

  it('boot em development/test: local, com segredo da variável (≥ 32 bytes) ou aleatório do processo', async () => {
    expect(createPseudonymSigner({ NODE_ENV: 'test' }).tipo).toBe('local');
    const valor = randomBytes(32);
    const s = createPseudonymSigner({ NODE_ENV: 'development', SUPPORT_PSEUDONYM_KEY: valor.toString('base64') });
    expect(await s.pseudonimo(T1, 'atendente-01')).toBe(supportActorPseudonym(valor, T1, 'atendente-01'));
    expect(() => createPseudonymSigner({ NODE_ENV: 'test', SUPPORT_PSEUDONYM_KEY: randomBytes(16).toString('base64') })).toThrow(/32 bytes/);
  });
});
