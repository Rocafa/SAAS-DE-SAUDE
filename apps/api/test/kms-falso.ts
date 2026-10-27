/**
 * KMS falsos compartilhados pelos testes (sem rede, sem segredo real): o de chave mestra imita o
 * contrato do AWS KMS (EncryptionContext obrigatório e igual) e o de MAC calcula HMAC-SHA256 com uma
 * chave que só ele conhece. O de chave mestra também confere e aplica a key policy (K-c2/K-c3). Vieram de key-providers.test.ts e ator-suporte.test.ts (rodada 27).
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { KmsMacApi } from '../src/modules/audit/ator-suporte';
import type { KmsApi } from '../src/modules/crypto/kms-key-provider';

/** Conta fictícia dos testes (12 zeros, igual à dos ARNs falsos). */
export const CONTA_DE_TESTE = '000000000000';

interface StatementFalso {
  Effect?: string;
  Principal?: unknown;
  Action?: string | string[];
  Condition?: Record<string, Record<string, string>>;
}

/**
 * Confere a key policy como o KMS faria no essencial (K-c3, parte unitária): JSON válido, sem
 * `BypassPolicyLockoutSafetyCheck` e com o statement de root da conta (senão o KMS recusa por lockout).
 * Devolve o erro do KMS (sem lançar) ou o tenant literal da negação `StringNotEquals` (ou `null` se não houver), para aplicar a política.
 */
function conferirPolitica(input: { Policy?: unknown }): { tenant: string | null; exigeContexto: boolean } | Error {
  const malformada = () => kmsErro('MalformedPolicyDocumentException');
  if ('BypassPolicyLockoutSafetyCheck' in input) return malformada();
  if (typeof input.Policy !== 'string') return malformada();
  let doc: { Statement?: StatementFalso[] };
  try {
    doc = JSON.parse(input.Policy) as { Statement?: StatementFalso[] };
  } catch {
    return malformada();
  }
  const st = doc.Statement ?? [];
  const root = st.some(
    (s) => s.Effect === 'Allow' && JSON.stringify(s.Principal) === JSON.stringify({ AWS: `arn:aws:iam::${CONTA_DE_TESTE}:root` }) && s.Action === 'kms:*',
  );
  if (!root) return malformada();
  const negacoes = st.filter((s) => s.Effect === 'Deny' && s.Principal === '*');
  const tenant = negacoes.map((s) => s.Condition?.StringNotEquals?.['kms:EncryptionContext:tenant_id']).find((t) => t !== undefined) ?? null;
  const exigeContexto = negacoes.some((s) => s.Condition?.Null?.['kms:EncryptionContext:tenant_id'] === 'true');
  return { tenant, exigeContexto };
}

export type FakeKms = KmsApi & { calls: { op: string; input: unknown }[]; fail: boolean; excluir(keyId: string): void };

/** Erro como o SDK v3 lança: o tipo vem em `name`; a mensagem pode trazer ARN e conta. */
export function kmsErro(name: string, message = name, httpStatusCode?: number): Error {
  const e = new Error(message);
  e.name = name;
  if (httpStatusCode !== undefined) Object.assign(e, { $metadata: { httpStatusCode } });
  return e;
}

/** KMS falso que imita o contrato (EncryptionContext obrigatório e igual) e registra as chamadas. */
export function fakeKms(): FakeKms {
  const blobs = new Map<string, { plaintext: Buffer; ctx: string }>();
  const pendentes = new Set<string>();
  // Exclusão já feita pelo KMS (passou a janela de 7 dias): toda operação na chave dá NotFoundException.
  const excluidas = new Set<string>();
  // Política de cada chave criada (K-c2): DEK sem contexto ou com outro tenant dá AccessDenied, como no KMS.
  const politicas = new Map<string, { tenant: string | null; exigeContexto: boolean }>();
  const negadoPelaPolitica = (keyId: string, ctx: Record<string, string>): boolean => {
    const pol = politicas.get(keyId);
    if (!pol) return false;
    const t = ctx.tenant_id;
    return (pol.exigeContexto && t === undefined) || (pol.tenant !== null && t !== undefined && t !== pol.tenant);
  };
  const negado = () => Promise.reject(kmsErro('AccessDeniedException', 'explicit deny in a resource-based policy', 400));
  const naoExiste = (keyId: string) => Promise.reject(kmsErro('NotFoundException', `Key '${keyId}' does not exist`, 400));
  const fake: FakeKms = {
    calls: [],
    fail: false,
    excluir(keyId) {
      pendentes.delete(keyId);
      excluidas.add(keyId);
    },
    createKey(input) {
      fake.calls.push({ op: 'createKey', input });
      if (fake.fail) return Promise.reject(kmsErro('AccessDeniedException', 'AccessDenied arn:aws:kms:sa-east-1:123456789012:key/segredo'));
      const pol = conferirPolitica(input);
      if (pol instanceof Error) return Promise.reject(pol);
      const arn = `arn:aws:kms:sa-east-1:${CONTA_DE_TESTE}:key/${randomUUID()}`;
      politicas.set(arn, pol);
      return Promise.resolve({ KeyMetadata: { Arn: arn } });
    },
    enableKeyRotation(input) {
      fake.calls.push({ op: 'enableKeyRotation', input });
      return Promise.resolve({});
    },
    generateDataKey(input) {
      fake.calls.push({ op: 'generateDataKey', input });
      if (negadoPelaPolitica(input.KeyId, input.EncryptionContext)) return negado();
      const plaintext = randomBytes(32);
      const blob = randomBytes(64);
      blobs.set(blob.toString('hex'), { plaintext: Buffer.from(plaintext), ctx: JSON.stringify(input.EncryptionContext) });
      return Promise.resolve({ Plaintext: plaintext, CiphertextBlob: blob });
    },
    decrypt(input) {
      fake.calls.push({ op: 'decrypt', input });
      if (negadoPelaPolitica(input.KeyId, input.EncryptionContext)) return negado();
      // Como no KMS: chave com exclusão agendada não decifra (KMSInvalidStateException).
      if (pendentes.has(input.KeyId)) return Promise.reject(kmsErro('KMSInvalidStateException'));
      const b = blobs.get(Buffer.from(input.CiphertextBlob).toString('hex'));
      if (!b || b.ctx !== JSON.stringify(input.EncryptionContext)) {
        return Promise.reject(kmsErro('InvalidCiphertextException'));
      }
      return Promise.resolve({ Plaintext: Buffer.from(b.plaintext) });
    },
    reEncrypt(input) {
      fake.calls.push({ op: 'reEncrypt', input });
      if (negadoPelaPolitica(input.SourceKeyId, input.SourceEncryptionContext) || negadoPelaPolitica(input.DestinationKeyId, input.DestinationEncryptionContext)) {
        return negado();
      }
      return Promise.resolve({ CiphertextBlob: Buffer.from(input.CiphertextBlob) });
    },
    scheduleKeyDeletion(input) {
      fake.calls.push({ op: 'scheduleKeyDeletion', input });
      if (excluidas.has(input.KeyId)) return naoExiste(input.KeyId);
      if (pendentes.has(input.KeyId)) return Promise.reject(kmsErro('KMSInvalidStateException'));
      pendentes.add(input.KeyId);
      return Promise.resolve({});
    },
    describeKey(input) {
      fake.calls.push({ op: 'describeKey', input });
      if (excluidas.has(input.KeyId)) return naoExiste(input.KeyId);
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

/**
 * KMS de mentira: HMAC-SHA256 com uma chave que só ele conhece (como o KMS real). Responde o
 * `KeyId` como o KMS (ARN da chave; aqui, o próprio id recebido, ou `opcoes.keyIdResposta`).
 */
export function kmsFalso(
  chave: Buffer,
  opcoes: { falhar?: boolean; keyIdResposta?: string; macVazio?: boolean } = {},
): KmsMacApi & { chamadas: string[] } {
  const chamadas: string[] = [];
  return {
    chamadas,
    generateMac(input) {
      chamadas.push(`generate:${input.KeyId}`);
      if (opcoes.falhar) return Promise.reject(new Error(`AccessDenied arn:aws:kms:sa-east-1:123:key/${input.KeyId}`));
      const Mac = opcoes.macVazio ? new Uint8Array() : createHmac('sha256', chave).update(input.Message).digest();
      return Promise.resolve({ Mac, KeyId: opcoes.keyIdResposta ?? input.KeyId });
    },
  };
}
