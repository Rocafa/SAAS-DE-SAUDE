import type { AuditMetadata } from '../../db/schema';

/**
 * Contrato do `metadata` da trilha de auditoria — espelho da função `audit_metadata_ok` da
 * migração 0005 (o banco é a barreira final; aqui o erro sai antes e mais claro).
 *
 * A trilha é append-only, encadeada por hash e não cifrada: o que entra nela fica para sempre.
 * Por isso só cabem identificadores, códigos e contagens — nunca conteúdo clínico nem dado pessoal.
 * Quando for indispensável registrar O QUE mudou, registre a referência (tabela, coluna, id da
 * linha) e deixe o valor no campo cifrado.
 */
export const AUDIT_METADATA_MAX_KEYS = 16;
export const AUDIT_METADATA_MAX_JSON = 1024;
export const AUDIT_METADATA_MAX_STRING = 64;
export const AUDIT_METADATA_MAX_NUMBER = 1_000_000_000;

const KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
const FORBIDDEN_KEYS = new Set([
  'antes',
  'depois',
  'before',
  'after',
  'nome',
  'name',
  'cpf',
  'cns',
  'rg',
  'email',
  'telefone',
  'phone',
  'texto',
  'text',
  'conteudo',
  'content',
  'body',
  'nota',
  'note',
  'observacao',
  'diagnostico',
  'anamnese',
  'evolucao',
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX64_RE = /^[0-9a-f]{64}$/;

/** Motivo da recusa, sem repetir o valor recusado (que pode ser justamente o dado pessoal). */
export class AuditMetadataRejectedError extends Error {
  override readonly name = 'AuditMetadataRejectedError';
  constructor(readonly rule: string) {
    super(`metadata de auditoria fora do contrato: ${rule}`);
  }
}

/** Parece dado pessoal: e-mail ou sequência de 8+ dígitos (CPF, CNS, telefone), salvo UUID/hash. */
function looksPersonal(value: string): boolean {
  if (UUID_RE.test(value) || HEX64_RE.test(value)) return false;
  return value.includes('@') || /[0-9]{8}/.test(value.replace(/[\s().-]/g, ''));
}

export function assertAuditMetadata(metadata: unknown): asserts metadata is AuditMetadata {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    throw new AuditMetadataRejectedError('deve ser um objeto');
  }
  const entries = Object.entries(metadata as Record<string, unknown>);
  if (entries.length > AUDIT_METADATA_MAX_KEYS) throw new AuditMetadataRejectedError('chaves demais');
  if (JSON.stringify(metadata).length > AUDIT_METADATA_MAX_JSON) throw new AuditMetadataRejectedError('grande demais');
  for (const [key, value] of entries) {
    if (!KEY_RE.test(key)) throw new AuditMetadataRejectedError('chave inválida');
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) throw new AuditMetadataRejectedError(`chave proibida: ${key}`);
    if (value === null || typeof value === 'boolean') continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || Math.abs(value) >= AUDIT_METADATA_MAX_NUMBER) {
        throw new AuditMetadataRejectedError(`número fora da faixa em ${key}`);
      }
      continue;
    }
    if (typeof value === 'string') {
      if (value.length > AUDIT_METADATA_MAX_STRING) throw new AuditMetadataRejectedError(`texto longo em ${key}`);
      if (looksPersonal(value)) throw new AuditMetadataRejectedError(`possível dado pessoal em ${key}`);
      continue;
    }
    throw new AuditMetadataRejectedError(`valor não escalar em ${key}`);
  }
}
