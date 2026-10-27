import type { TenantId } from '@plataforma/shared';
import { KeyUnavailableError, type KeyFailureKind } from './crypto-errors';
import { DataKey } from './data-key';
import { KEY_PURPOSE_IMPORT_BATCH, KEY_PURPOSE_TENANT_DATA, type GeneratedDataKey, type KeyProvider, type MasterKeyPurpose, type WrappedDataKey } from './key-provider';

/**
 * Subconjunto da API do AWS KMS usado aqui, com os nomes e formatos do SDK v3
 * O adaptador real é `createAwsKmsCliente` (kms-client.ts, `@aws-sdk/client-kms`).
 * Mantido como interface para o provedor não depender do SDK (testes usam KMS falso).
 */
export interface KmsApi {
  createKey(input: {
    Description: string;
    KeyUsage: 'ENCRYPT_DECRYPT';
    KeySpec: 'SYMMETRIC_DEFAULT';
    Tags: { TagKey: string; TagValue: string }[];
    /** K-c2: key policy própria (JSON). Nunca com `BypassPolicyLockoutSafetyCheck` (proibido). */
    Policy: string;
  }): Promise<{ KeyMetadata?: { Arn?: string | undefined } | undefined }>;
  enableKeyRotation(input: { KeyId: string }): Promise<unknown>;
  generateDataKey(input: {
    KeyId: string;
    KeySpec: 'AES_256';
    EncryptionContext: Record<string, string>;
  }): Promise<{ Plaintext?: Uint8Array | undefined; CiphertextBlob?: Uint8Array | undefined }>;
  decrypt(input: {
    KeyId: string;
    CiphertextBlob: Uint8Array;
    EncryptionContext: Record<string, string>;
  }): Promise<{ Plaintext?: Uint8Array | undefined }>;
  reEncrypt(input: {
    CiphertextBlob: Uint8Array;
    SourceKeyId: string;
    SourceEncryptionContext: Record<string, string>;
    DestinationKeyId: string;
    DestinationEncryptionContext: Record<string, string>;
  }): Promise<{ CiphertextBlob?: Uint8Array | undefined }>;
  scheduleKeyDeletion(input: { KeyId: string; PendingWindowInDays: number }): Promise<unknown>;
  cancelKeyDeletion(input: { KeyId: string }): Promise<unknown>;
  describeKey(input: { KeyId: string }): Promise<{ KeyMetadata?: { KeyState?: string | undefined } | undefined }>;
  enableKey(input: { KeyId: string }): Promise<unknown>;
}

/** Mínimo permitido pelo KMS. Dentro da janela a destruição ainda pode ser cancelada. */
export const KMS_DELETION_WINDOW_DAYS = 7;

/**
 * Chave mestra no AWS KMS, uma por clínica (custo e limites em criptografia-de-campo.md).
 * `EncryptionContext = { tenant_id }` amarra cada DEK à clínica e aparece no CloudTrail.
 * A DEK em claro nunca é gravada; a chave mestra nunca sai do KMS.
 */
export class KmsKeyProvider implements KeyProvider {
  /**
   * `contaAws`: conta (12 dígitos) dona das chaves, para o statement padrão da key policy (K-c2). Vem do
   * ARN da chave HMAC do pseudônimo (`SUPPORT_PSEUDONYM_KMS_KEY_ID`), já exigido no boot de produção.
   */
  constructor(
    private readonly kms: KmsApi,
    private readonly contaAws: string,
    /** R4: padrões de ARN de humanos além dos fixos (`KMS_PAPEIS_HUMANOS_EXTRA` = `var.papeis_humanos_extra`). */
    private readonly papeisHumanosExtra: readonly string[] = [],
  ) {
    validarConta(contaAws);
    // Falha no boot, não na primeira clínica: monta uma política de prova só para validar os extras.
    politicaDaChaveDaClinica(contaAws, 'validacao' as TenantId, papeisHumanosExtra);
  }

  /**
   * R3-b: a chave do LOTE nasce com descrição própria e as tags `purpose=import_batch` e `batch_id` (só
   * ids), diferente da chave da clínica (`purpose=tenant_data`). É o que permite ao IAM liberar
   * `ScheduleKeyDeletion` só nas chaves de lote e negar `CancelKeyDeletion`/`EnableKey` nelas (§12d).
   */
  async createMasterKey(tenantId: TenantId, finalidade: MasterKeyPurpose = { purpose: KEY_PURPOSE_TENANT_DATA }): Promise<string> {
    const lote = finalidade.purpose === KEY_PURPOSE_IMPORT_BATCH ? finalidade : null;
    const out = await guard(() =>
      this.kms.createKey({
        Description: lote
          ? 'plataforma-saude: chave descartável de um lote de importação (crypto-shredding do arquivo bruto)'
          : 'plataforma-saude: chave mestra de dados de uma clínica',
        KeyUsage: 'ENCRYPT_DECRYPT',
        KeySpec: 'SYMMETRIC_DEFAULT',
        Tags: [
          { TagKey: 'tenant_id', TagValue: tenantId },
          { TagKey: 'purpose', TagValue: finalidade.purpose },
          ...(lote ? [{ TagKey: 'batch_id', TagValue: lote.batchId }] : []),
        ],
        // K-c2: a chave do lote também guarda DEK com contexto da clínica, então leva a mesma política.
        Policy: politicaDaChaveDaClinica(this.contaAws, tenantId, this.papeisHumanosExtra),
      }),
    );
    const arn = out.KeyMetadata?.Arn;
    if (!arn) throw new KeyUnavailableError();
    // Rotação anual automática do material da chave da clínica (mesmo ARN; DEKs antigas continuam
    // abrindo). A chave de lote vive no máximo 7 dias: rotação não faria nada (observação da rodada 22).
    if (!lote) await guard(() => this.kms.enableKeyRotation({ KeyId: arn }));
    return arn;
  }

  async generateDataKey(masterKeyId: string, tenantId: TenantId): Promise<GeneratedDataKey> {
    const out = await guard(() =>
      this.kms.generateDataKey({ KeyId: masterKeyId, KeySpec: 'AES_256', EncryptionContext: context(tenantId) }),
    );
    if (!out.Plaintext || !out.CiphertextBlob) throw new KeyUnavailableError();
    try {
      return { masterKeyId, wrapped: Buffer.from(out.CiphertextBlob), plaintext: DataKey.fromBytes(out.Plaintext) };
    } finally {
      out.Plaintext.fill(0);
    }
  }

  async unwrapDataKey(key: WrappedDataKey, tenantId: TenantId): Promise<DataKey> {
    const out = await guard(() =>
      this.kms.decrypt({ KeyId: key.masterKeyId, CiphertextBlob: key.wrapped, EncryptionContext: context(tenantId) }),
    );
    if (!out.Plaintext) throw new KeyUnavailableError();
    try {
      return DataKey.fromBytes(out.Plaintext);
    } finally {
      out.Plaintext.fill(0);
    }
  }

  async rewrapDataKey(key: WrappedDataKey, targetMasterKeyId: string, tenantId: TenantId): Promise<WrappedDataKey> {
    // ReEncrypt acontece dentro do KMS: a DEK em claro nem passa pela aplicação.
    const out = await guard(() =>
      this.kms.reEncrypt({
        CiphertextBlob: key.wrapped,
        SourceKeyId: key.masterKeyId,
        SourceEncryptionContext: context(tenantId),
        DestinationKeyId: targetMasterKeyId,
        DestinationEncryptionContext: context(tenantId),
      }),
    );
    if (!out.CiphertextBlob) throw new KeyUnavailableError();
    return { masterKeyId: targetMasterKeyId, wrapped: Buffer.from(out.CiphertextBlob) };
  }

  async destroyMasterKey(masterKeyId: string): Promise<void> {
    try {
      await this.kms.scheduleKeyDeletion({ KeyId: masterKeyId, PendingWindowInDays: KMS_DELETION_WINDOW_DAYS });
    } catch (agendar) {
      // Observação 2 da conferência R3-a/R3-b: passada a janela de 7 dias, o KMS já excluiu a chave e
      // responde NotFound (no agendamento ou no describe). Não existe mais nada que abra: conta como feita.
      if (isNotFound(agendar)) return;
      // Idempotente: uma tentativa anterior pode ter agendado e parado antes de gravar `destroyed`
      // (o agendamento repetido dá KMSInvalidStateException; o describe diz PendingDeletion).
      let estado: string | undefined;
      try {
        estado = (await this.kms.describeKey({ KeyId: masterKeyId })).KeyMetadata?.KeyState;
      } catch (descrever) {
        if (isNotFound(descrever)) return;
        throw new KeyUnavailableError(classifyKmsError(descrever));
      }
      if (estado !== 'PendingDeletion') throw new KeyUnavailableError(classifyKmsError(agendar));
    }
  }

  async cancelMasterKeyDestruction(masterKeyId: string): Promise<void> {
    // Cancelar deixa a chave "Disabled" (documentação do KMS): é preciso reabilitar.
    await guard(() => this.kms.cancelKeyDeletion({ KeyId: masterKeyId }));
    await guard(() => this.kms.enableKey({ KeyId: masterKeyId }));
  }
}

/** Operações de dados negadas sem o contexto da clínica (K-c2). */
const OPERACOES_DE_DADOS = ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*'];
const CONDICAO_TENANT = 'kms:EncryptionContext:tenant_id';

function validarConta(conta: string): void {
  if (!/^\d{12}$/.test(conta)) throw new Error('KmsKeyProvider: conta AWS inválida (12 dígitos, vinda do ARN da chave)');
}

/**
 * K-c2 (parecer #76, 27/10): key policy da chave de uma clínica.
 * (i) statement padrão da conta: a administração fica com a conta/IAM e ele satisfaz a trava de lockout
 *     do KMS, sem `BypassPolicyLockoutSafetyCheck` (proibido);
 * (ii) `Deny` para `"*"` nas operações de dados quando `kms:EncryptionContext:tenant_id` estiver AUSENTE
 *     (`Null` — `StringNotEquals` sozinho não nega quando a chave de contexto falta) ou DIFERENTE do
 *     tenant da chave. O tenant vai LITERAL (sem `${aws:ResourceTag/...}`): não depende da propagação da
 *     tag nem de substituição de variável. A role da API não tem `PutKeyPolicy`: a política é imutável para ela;
 * (iii) R4 (parecer #58): `HumanoNaoDecifra`, o mesmo statement de `kms_deny_humanos` do Terraform — `Deny`
 *     de `kms:Decrypt`/`kms:ReEncrypt*` quando `aws:PrincipalArn` casa (ArnLike) com SSO, usuário IAM, root
 *     ou um dos `papeisHumanosExtra`. Role da API, gestor de chaves e break-glass ficam fora dos padrões.
 *
 * Tudo que a função usa fica nela, em OPERACOES_DE_DADOS, CONDICAO_TENANT ou validarConta: o
 * `infra/scripts/staging/politica-kc3.mjs` (#58) extrai só essas declarações pela AST.
 */
export function politicaDaChaveDaClinica(contaAws: string, tenantId: TenantId, papeisHumanosExtra: readonly string[] = []): string {
  validarConta(contaAws);
  if (!/^[A-Za-z0-9-]+$/.test(tenantId)) throw new Error('politicaDaChaveDaClinica: tenant_id inválido');
  // Extra: role/ ou user/ da MESMA conta, com prefixo fixo (1º caractere não curinga) e só caracteres de nome IAM.
  // Recusa outra conta, sts, group, vazio e curinga total (`role/*` negaria a própria role da API).
  const formatoExtra = /^arn:aws:iam::(\d{12}):(?:role|user)\/[A-Za-z0-9+=,.@_-][A-Za-z0-9+=,.@_\-/*?]*$/;
  for (const extra of papeisHumanosExtra) {
    const m = formatoExtra.exec(extra);
    if (!m || m[1] !== contaAws) {
      throw new Error('politicaDaChaveDaClinica: papel humano extra inválido (arn:aws:iam::<mesma conta>:role|user/<prefixo fixo>...)');
    }
  }
  const humanos = [
    `arn:aws:iam::${contaAws}:role/aws-reserved/sso.amazonaws.com/*`,
    `arn:aws:iam::${contaAws}:user/*`,
    `arn:aws:iam::${contaAws}:root`,
    ...papeisHumanosExtra,
  ];
  const negar = (Sid: string, Condition: Record<string, Record<string, string>>) => ({
    Sid,
    Effect: 'Deny',
    Principal: '*',
    Action: OPERACOES_DE_DADOS,
    Resource: '*',
    Condition,
  });
  return JSON.stringify({
    Version: '2012-10-17',
    Id: 'plataforma-saude-chave-da-clinica',
    Statement: [
      {
        Sid: 'Enable IAM User Permissions',
        Effect: 'Allow',
        Principal: { AWS: `arn:aws:iam::${contaAws}:root` },
        Action: 'kms:*',
        Resource: '*',
      },
      negar('NegarSemContextoDaClinica', { Null: { [CONDICAO_TENANT]: 'true' } }),
      negar('NegarContextoDeOutraClinica', { StringNotEquals: { [CONDICAO_TENANT]: tenantId } }),
      {
        Sid: 'HumanoNaoDecifra',
        Effect: 'Deny',
        Principal: { AWS: '*' },
        Action: ['kms:Decrypt', 'kms:ReEncrypt*'],
        Resource: '*',
        Condition: { ArnLike: { 'aws:PrincipalArn': humanos } },
      },
    ],
  });
}

/**
 * R4: `KMS_PAPEIS_HUMANOS_EXTRA` (opcional) = `join(",", var.papeis_humanos_extra)` do Terraform.
 * Ausente ou só espaços: nenhum extra. Item vazio (`a,,b`, vírgula sobrando) é recusado; o formato de
 * cada item é conferido em `politicaDaChaveDaClinica` (o construtor do provedor valida no boot).
 */
export function papeisHumanosExtraDoAmbiente(valor: string | undefined): string[] {
  if (!valor?.trim()) return [];
  const itens = valor.split(',').map((s) => s.trim());
  if (itens.some((s) => s === '')) throw new Error('KMS_PAPEIS_HUMANOS_EXTRA: item vazio na lista separada por vírgula');
  return itens;
}

function context(tenantId: TenantId): Record<string, string> {
  return { tenant_id: tenantId };
}

/** Erro do SDK pode trazer ARN, id de requisição e contexto: troca por erro de mensagem fixa (com o tipo). */
async function guard<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    throw new KeyUnavailableError(classifyKmsError(e));
  }
}

const ACESSO_NEGADO = new Set([
  'AccessDeniedException',
  'AccessDenied',
  'UnrecognizedClientException',
  'InvalidClientTokenId',
  'ExpiredTokenException',
  'IncompleteSignature',
  'InvalidSignatureException',
]);
const INDISPONIVEL = new Set([
  'ThrottlingException',
  'Throttling',
  'TooManyRequestsException',
  'LimitExceededException',
  'KMSInternalException',
  'DependencyTimeoutException',
  'KeyUnavailableException',
  'ServiceUnavailable',
  'ServiceUnavailableException',
  'InternalFailure',
  'RequestTimeout',
  'RequestTimeoutException',
  'TimeoutError',
  'NetworkingError',
]);
const ESTADO_INVALIDO = new Set(['KMSInvalidStateException', 'NotFoundException', 'DisabledException', 'InvalidArnException']);

/** Nome do erro do SDK v3 (`name`; em versões antigas, `Code`/`code`). Nunca lê a mensagem. */
function kmsErrorName(e: unknown): string | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const o = e as { name?: unknown; Code?: unknown; code?: unknown };
  for (const v of [o.name, o.Code, o.code]) if (typeof v === 'string' && v !== 'Error') return v;
  return undefined;
}

/**
 * Observação 3 da conferência R3-a/R3-b: o tipo da falha sai do NOME do erro e do código HTTP
 * (`$metadata.httpStatusCode`), nunca da mensagem (que pode trazer ARN e conta).
 */
export function classifyKmsError(e: unknown): KeyFailureKind {
  const name = kmsErrorName(e);
  if (name && ACESSO_NEGADO.has(name)) return 'acesso_negado';
  if (name && INDISPONIVEL.has(name)) return 'indisponivel';
  if (name && ESTADO_INVALIDO.has(name)) return 'estado_invalido';
  const status = (e as { $metadata?: { httpStatusCode?: unknown } } | null)?.$metadata?.httpStatusCode;
  if (typeof status === 'number') {
    if (status === 401 || status === 403) return 'acesso_negado';
    if (status === 429 || status >= 500) return 'indisponivel';
  }
  return 'outro';
}

/** A chave não existe mais no KMS (a exclusão agendada venceu a janela de 7 dias). */
function isNotFound(e: unknown): boolean {
  return kmsErrorName(e) === 'NotFoundException';
}
