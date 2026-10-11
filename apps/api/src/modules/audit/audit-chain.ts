import type { TenantId } from '@plataforma/shared';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { TenantTx } from '../../db/tenant-transaction';

/** prev_hash da primeira linha encadeada de cada clínica (migração 0005). */
export const GENESIS_HASH = '0'.repeat(64);

/** Uma linha da cadeia como o verificador a enxerga. `canonical` é recalculado a partir das colunas. */
export interface ChainRow {
  readonly seq: number;
  readonly prevHash: string;
  readonly hash: string;
  readonly canonical: string;
}

/** Último elo conhecido, guardado FORA do banco (ex.: S3 com Object Lock) para pegar corte do fim. */
export interface ChainAnchor {
  readonly seq: number;
  readonly hash: string;
}

export type ChainProblemKind =
  /** O conteúdo da linha não bate com o hash gravado: linha alterada. */
  | 'hash_mismatch'
  /** prev_hash não é o hash da linha anterior: linha anterior apagada, trocada ou inserida. */
  | 'broken_link'
  /** Falta posição na sequência: linha apagada. */
  | 'gap'
  /** Sequência fora de ordem ou repetida: linhas reordenadas. */
  | 'out_of_order'
  /** A cadeia termina antes da âncora: linhas do fim apagadas. */
  | 'truncated'
  /** O elo da âncora não bate: histórico reescrito. */
  | 'anchor_mismatch';

export interface ChainProblem {
  readonly seq: number;
  readonly kind: ChainProblemKind;
}

export interface ChainReport {
  readonly ok: boolean;
  /** Linhas encadeadas verificadas. */
  readonly checked: number;
  /** Linhas anteriores à migração 0005 (fora da cadeia), só contadas. */
  readonly legacy: number;
  readonly head: ChainAnchor | null;
  readonly problems: readonly ChainProblem[];
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Verifica a cadeia de UMA clínica, linha a linha, na ordem recebida (ordem de `seq`).
 * Recalcula cada hash, confere o elo com a anterior e a continuidade da sequência; com âncora,
 * detecta também corte do fim e reescrita do histórico.
 */
export function verifyChainRows(
  rows: readonly ChainRow[],
  options: { readonly anchor?: ChainAnchor; readonly legacy?: number } = {},
): ChainReport {
  const problems: ChainProblem[] = [];
  let expectedSeq = 1;
  let prevHash = GENESIS_HASH;
  let lastSeq = 0;
  for (const row of rows) {
    if (row.seq <= lastSeq) {
      problems.push({ seq: row.seq, kind: 'out_of_order' });
    } else if (row.seq !== expectedSeq) {
      problems.push({ seq: row.seq, kind: 'gap' });
    }
    if (sha256Hex(row.canonical) !== row.hash) problems.push({ seq: row.seq, kind: 'hash_mismatch' });
    if (row.prevHash !== prevHash) problems.push({ seq: row.seq, kind: 'broken_link' });
    prevHash = row.hash;
    lastSeq = Math.max(lastSeq, row.seq);
    expectedSeq = row.seq + 1;
  }
  const last = rows.at(-1);
  const head = last ? { seq: last.seq, hash: last.hash } : null;
  const { anchor } = options;
  if (anchor) {
    const atAnchor = rows.find((r) => r.seq === anchor.seq);
    if (!atAnchor) problems.push({ seq: anchor.seq, kind: 'truncated' });
    else if (atAnchor.hash !== anchor.hash) problems.push({ seq: anchor.seq, kind: 'anchor_mismatch' });
  }
  return { ok: problems.length === 0, checked: rows.length, legacy: options.legacy ?? 0, head, problems };
}

/**
 * Verifica a trilha de auditoria da clínica no banco (rodar dentro de `withTenant`). O JSON canônico
 * é recalculado pelo banco a partir das colunas ATUAIS (`audit_log_canonical`, migração 0005) e o
 * SHA-256 é recalculado aqui: qualquer coluna alterada depois da gravação muda o resultado.
 */
export async function verifyAuditChain(
  tx: TenantTx,
  tenantId: TenantId,
  options: { readonly anchor?: ChainAnchor } = {},
): Promise<ChainReport> {
  const rows = await tx.execute<{ seq: string; prev_hash: string; hash: string; canonical: string }>(sql`
    select a.seq::text as seq, a.prev_hash, a.hash, audit_log_canonical(a) as canonical
    from audit_log a
    where a.tenant_id = ${tenantId} and a.seq is not null
    order by a.seq`);
  const legacy = await tx.execute<{ n: number }>(
    sql`select count(*)::int as n from audit_log where tenant_id = ${tenantId} and seq is null`,
  );
  return verifyChainRows(
    rows.map((r) => ({ seq: Number(r.seq), prevHash: r.prev_hash, hash: r.hash, canonical: r.canonical })),
    { ...options, legacy: legacy[0]?.n ?? 0 },
  );
}

/** Último elo da clínica, para ser publicado como âncora fora do banco. */
export async function auditChainHead(tx: TenantTx, tenantId: TenantId): Promise<ChainAnchor | null> {
  const rows = await tx.execute<{ seq: string; hash: string }>(sql`
    select seq::text as seq, hash from audit_log
    where tenant_id = ${tenantId} and seq is not null
    order by seq desc limit 1`);
  const row = rows[0];
  return row ? { seq: Number(row.seq), hash: row.hash } : null;
}
