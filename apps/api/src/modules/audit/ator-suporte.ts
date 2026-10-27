/**
 * Ator interno (equipe de suporte da plataforma) na trilha de auditoria — Decisão 1 do Guardião
 * (parecer PR #57), migração 0008; segredo fora do processo da API (N1 da re-revisão).
 *
 * A trilha sai no pacote de exportação da clínica (G2) com os campos da cadeia de hash. O atendente
 * do suporte é gravado JÁ pseudonimizado no INSERT (reescrever na saída quebraria o hash):
 *
 *   actor_id = UUID derivado de HMAC-SHA256(segredo do operador, tenant_id || 0x1f || id do atendente)
 *
 * - por clínica: o mesmo atendente tem sempre o mesmo pseudônimo DENTRO da clínica (dá para ver que
 *   "o suporte X" fez A e B), mas o id não liga duas clínicas nem chega à pessoa;
 * - quem calcula o HMAC é a porta `PseudonymSigner`:
 *   - `KmsPseudonymSigner` (staging/produção): chave HMAC_256 no AWS KMS, `GenerateMac`; o segredo
 *     NUNCA entra no processo da API. A política da chave dá ao papel da API só `kms:GenerateMac`
 *     (sem `Decrypt`, sem exportar material); quem compromete a API pode pedir pseudônimos enquanto
 *     estiver dentro, com cada chamada no CloudTrail, mas não leva o segredo embora;
 *   - `LocalPseudonymSigner` (só development/test, lista fechada): HMAC local com segredo de
 *     variável ou aleatório por processo;
 *   - fora de development/test sem KMS configurado, `createPseudonymSigner` lança e a API não sobe;
 * - a reidentificação (pseudônimo -> pessoa) é do operador, com acesso restrito ao DPO/segurança;
 * - todo acesso de suporte leva o número do chamado (`ticket`) e o motivo (`reason`) no metadata,
 *   sem nome. O CHECK da 0008 recusa linha de suporte sem eles.
 */
import { createHmac, randomBytes } from 'node:crypto';
import type { TenantId } from '@plataforma/shared';
import type { TenantTx } from '../../db/tenant-transaction';
import { insertAudit, type AuditEntry } from './audit-log';

export const SUPPORT_PSEUDONYM_KEY_MIN_BYTES = 32;
export const MOTIVOS_DE_SUPORTE = ['pedido_da_clinica', 'break_glass'] as const;
export type MotivoDeSuporte = (typeof MOTIVOS_DE_SUPORTE)[number];

const CHAMADO_RE = /^SUP-\d{1,7}$/;
/** Id interno do atendente no diretório do operador: opaco, curto, sem espaço nem controle. */
const ATENDENTE_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const AMBIENTES_LOCAIS: readonly string[] = ['development', 'test'];

export class AcessoDeSuporteInvalidoError extends Error {
  constructor(readonly campo: 'chamado' | 'atendente' | 'motivo' | 'metadata') {
    super(`acesso de suporte inválido: ${campo}`);
    this.name = 'AcessoDeSuporteInvalidoError';
  }
}

/** Falha do KMS com mensagem fixa: o erro do SDK pode trazer ARN, id de requisição e contexto. */
export class PseudonimoIndisponivelError extends Error {
  override readonly name = 'PseudonimoIndisponivelError';
  constructor() {
    super('pseudônimo do suporte indisponível');
  }
}

/** Mensagem assinada: clínica + 0x1f + atendente (o separador não aparece em nenhum dos dois). */
export function mensagemDoPseudonimo(tenantId: TenantId, atendenteId: string): Buffer {
  if (!ATENDENTE_RE.test(atendenteId)) throw new AcessoDeSuporteInvalidoError('atendente');
  return Buffer.from(`${tenantId}\u001f${atendenteId}`, 'utf8');
}

/** Primeiros 16 bytes do HMAC no formato UUID (versão 8, variante RFC 9562). */
export function macParaUuid(mac: Uint8Array): string {
  if (mac.length < 16) throw new PseudonimoIndisponivelError();
  const b = Buffer.from(mac.subarray(0, 16));
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x80; // versão 8 (formato definido pela aplicação)
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80; // variante RFC 9562
  const h = b.toString('hex');
  // A versão 8 garante bits não nulos: nunca colide com o ator do sistema (id zero).
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Pseudônimo do atendente nesta clínica com segredo local (base do LocalPseudonymSigner). */
export function supportActorPseudonym(key: Uint8Array, tenantId: TenantId, atendenteId: string): string {
  if (key.length < SUPPORT_PSEUDONYM_KEY_MIN_BYTES) throw new Error('segredo do pseudônimo curto demais');
  return macParaUuid(createHmac('sha256', key).update(mensagemDoPseudonimo(tenantId, atendenteId)).digest());
}

/** Porta: quem calcula o pseudônimo do atendente. */
export interface PseudonymSigner {
  readonly tipo: 'local' | 'kms';
  pseudonimo(tenantId: TenantId, atendenteId: string): Promise<string>;
}

export const PSEUDONYM_SIGNER = Symbol('PSEUDONYM_SIGNER');

/** HMAC local. Só development/test (lista fechada): em qualquer outro ambiente, recusa existir. */
export class LocalPseudonymSigner implements PseudonymSigner {
  readonly tipo = 'local' as const;
  private readonly key: Buffer;

  constructor(key: Uint8Array, nodeEnv: string | undefined) {
    if (!AMBIENTES_LOCAIS.includes(nodeEnv ?? '')) {
      throw new Error(`segredo local do pseudônimo proibido fora de development/test (NODE_ENV=${nodeEnv ?? 'vazio'})`);
    }
    if (key.length < SUPPORT_PSEUDONYM_KEY_MIN_BYTES) {
      throw new Error(`SUPPORT_PSEUDONYM_KEY precisa de ao menos ${SUPPORT_PSEUDONYM_KEY_MIN_BYTES} bytes (base64)`);
    }
    this.key = Buffer.from(key);
  }

  pseudonimo(tenantId: TenantId, atendenteId: string): Promise<string> {
    try {
      return Promise.resolve(supportActorPseudonym(this.key, tenantId, atendenteId));
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new PseudonimoIndisponivelError());
    }
  }
}

/**
 * Subconjunto da API do AWS KMS para MAC, com os nomes e formatos do SDK v3
 * (`new KMS({ region: 'sa-east-1' })` de `@aws-sdk/client-kms` deve satisfazer esta interface).
 * Interface para a API não depender do SDK até a infraestrutura existir (Portão A) e para teste.
 */
export interface KmsMacApi {
  generateMac(input: { KeyId: string; Message: Uint8Array; MacAlgorithm: 'HMAC_SHA_256' }): Promise<{ Mac?: Uint8Array | undefined }>;
  verifyMac(input: {
    KeyId: string;
    Message: Uint8Array;
    Mac: Uint8Array;
    MacAlgorithm: 'HMAC_SHA_256';
  }): Promise<{ MacValid?: boolean | undefined }>;
}

/** Sonda fixa, sem dado de ninguém, para conferir a chave no boot/readiness. */
const SONDA = Buffer.from('plataforma-saude:pseudonimo-suporte:sonda:v1', 'utf8');

/** HMAC-SHA256 dentro do KMS (chave HMAC_256, uso GENERATE_VERIFY_MAC). O segredo nunca sai de lá. */
export class KmsPseudonymSigner implements PseudonymSigner {
  readonly tipo = 'kms' as const;

  constructor(
    private readonly kms: KmsMacApi,
    private readonly keyId: string,
  ) {
    if (!keyId.trim()) throw new Error('SUPPORT_PSEUDONYM_KMS_KEY_ID vazia');
  }

  async pseudonimo(tenantId: TenantId, atendenteId: string): Promise<string> {
    const Message = mensagemDoPseudonimo(tenantId, atendenteId);
    const out = await guard(() => this.kms.generateMac({ KeyId: this.keyId, Message, MacAlgorithm: 'HMAC_SHA_256' }));
    if (!out.Mac) throw new PseudonimoIndisponivelError();
    return macParaUuid(out.Mac);
  }

  /**
   * Confere que a chave existe, é de MAC e responde (GenerateMac + VerifyMac sobre a sonda fixa).
   * Para o boot/readiness e para a ferramenta de reidentificação do operador.
   */
  async verificarChave(): Promise<void> {
    const gerado = await guard(() => this.kms.generateMac({ KeyId: this.keyId, Message: SONDA, MacAlgorithm: 'HMAC_SHA_256' }));
    if (!gerado.Mac) throw new PseudonimoIndisponivelError();
    const conferido = await guard(() =>
      this.kms.verifyMac({ KeyId: this.keyId, Message: SONDA, Mac: gerado.Mac as Uint8Array, MacAlgorithm: 'HMAC_SHA_256' }),
    );
    if (conferido.MacValid !== true) throw new PseudonimoIndisponivelError();
  }
}

async function guard<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch {
    throw new PseudonimoIndisponivelError();
  }
}

let segredoDoProcesso: Buffer | undefined;

/**
 * Escolhe o signer no boot:
 * - SUPPORT_PSEUDONYM_KMS_KEY_ID definida: KMS (exige o cliente KMS; sem ele, não sobe);
 * - development/test: segredo local (SUPPORT_PSEUDONYM_KEY em base64, ≥ 32 bytes, ou aleatório por
 *   processo, com pseudônimo só estável dentro do processo, o que basta para testes);
 * - qualquer outro NODE_ENV (production, staging, vazio...) sem KMS: lança e a API não sobe. O
 *   segredo em variável de ambiente também é recusado ali: ele não pode morar no processo da API.
 */
export function createPseudonymSigner(env: NodeJS.ProcessEnv = process.env, deps: { readonly kms?: KmsMacApi } = {}): PseudonymSigner {
  const kmsKeyId = env.SUPPORT_PSEUDONYM_KMS_KEY_ID?.trim();
  const local = AMBIENTES_LOCAIS.includes(env.NODE_ENV ?? '');
  if (!local && env.SUPPORT_PSEUDONYM_KEY?.trim()) {
    throw new Error('SUPPORT_PSEUDONYM_KEY é proibida fora de development/test: o segredo do pseudônimo fica no KMS (SUPPORT_PSEUDONYM_KMS_KEY_ID)');
  }
  if (kmsKeyId) {
    if (!deps.kms) throw new Error('SUPPORT_PSEUDONYM_KMS_KEY_ID definida, mas o cliente KMS não foi ligado');
    return new KmsPseudonymSigner(deps.kms, kmsKeyId);
  }
  if (!local) {
    throw new Error(
      `KMS do pseudônimo do suporte não configurado (SUPPORT_PSEUDONYM_KMS_KEY_ID): proibido subir fora de development/test (NODE_ENV=${env.NODE_ENV ?? 'vazio'})`,
    );
  }
  const raw = env.SUPPORT_PSEUDONYM_KEY?.trim();
  const key = raw ? Buffer.from(raw, 'base64') : (segredoDoProcesso ??= randomBytes(SUPPORT_PSEUDONYM_KEY_MIN_BYTES));
  return new LocalPseudonymSigner(key, env.NODE_ENV);
}

export interface AcessoDeSuporte {
  readonly tenantId: TenantId;
  /** Id do atendente no diretório do operador. Nunca vai para o banco da clínica. */
  readonly atendenteId: string;
  /** Número do chamado aberto pela clínica (ou do break-glass), ex.: `SUP-1234`. */
  readonly chamado: string;
  readonly motivo: MotivoDeSuporte;
}

/**
 * Grava, na transação do chamador, um evento feito pela equipe de suporte: ator pseudonimizado
 * pelo `signer`, `actor_kind = suporte_plataforma`, chamado e motivo no metadata.
 */
export async function recordSupportAudit(
  tx: TenantTx,
  signer: PseudonymSigner,
  acesso: AcessoDeSuporte,
  entry: AuditEntry,
): Promise<void> {
  if (!CHAMADO_RE.test(acesso.chamado)) throw new AcessoDeSuporteInvalidoError('chamado');
  if (!(MOTIVOS_DE_SUPORTE as readonly string[]).includes(acesso.motivo)) throw new AcessoDeSuporteInvalidoError('motivo');
  const metadata = entry.metadata ?? {};
  if ('ticket' in metadata || 'reason' in metadata) throw new AcessoDeSuporteInvalidoError('metadata');
  await insertAudit(
    tx,
    {
      tenantId: acesso.tenantId,
      actorId: await signer.pseudonimo(acesso.tenantId, acesso.atendenteId),
      actorKind: 'suporte_plataforma',
    },
    { ...entry, metadata: { ...metadata, ticket: acesso.chamado, reason: acesso.motivo } },
  );
}
