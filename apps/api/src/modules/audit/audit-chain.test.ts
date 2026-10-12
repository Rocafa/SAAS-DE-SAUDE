import { describe, expect, it } from 'vitest';
import { GENESIS_HASH, sha256Hex, verifyChainRows, type ChainRow } from './audit-chain';

/** Cadeia sintética no mesmo formato da 0005 (o conteúdo canônico aqui é ilustrativo). */
function chain(n: number): ChainRow[] {
  const rows: ChainRow[] = [];
  let prev = GENESIS_HASH;
  for (let seq = 1; seq <= n; seq++) {
    const canonical = JSON.stringify({ seq, prev_hash: prev, action: 'read', scope: 'patients', metadata: { count: seq } });
    const hash = sha256Hex(canonical);
    rows.push({ seq, prevHash: prev, hash, canonical });
    prev = hash;
  }
  return rows;
}

function at(rows: ChainRow[], i: number): ChainRow {
  const row = rows[i];
  if (!row) throw new Error(`linha ${i} inexistente`);
  return row;
}

const kinds = (rows: ChainRow[], anchor?: { seq: number; hash: string }) =>
  verifyChainRows(rows, anchor ? { anchor } : {}).problems.map((p) => `${p.kind}@${p.seq}`);

describe('verifyChainRows', () => {
  it('cadeia íntegra passa e informa o último elo', () => {
    const rows = chain(5);
    const r = verifyChainRows(rows, { anchor: { seq: 5, hash: at(rows, 4).hash } });
    expect(r).toMatchObject({ ok: true, checked: 5, head: { seq: 5, hash: at(rows, 4).hash } });
    expect(verifyChainRows([])).toMatchObject({ ok: true, checked: 0, head: null });
  });

  it('ADULTERAR o conteúdo de uma linha é detectado nela', () => {
    const rows = chain(5);
    rows[2] = { ...at(rows, 2), canonical: at(rows, 2).canonical.replace('"read"', '"export"') };
    expect(kinds(rows)).toEqual(['hash_mismatch@3']);
  });

  it('adulterar e recalcular o hash da linha quebra o elo da seguinte', () => {
    const rows = chain(5);
    const canonical = at(rows, 2).canonical.replace('"read"', '"export"');
    rows[2] = { ...at(rows, 2), canonical, hash: sha256Hex(canonical) };
    expect(kinds(rows)).toEqual(['broken_link@4']);
  });

  it('APAGAR uma linha do meio é detectado (buraco + elo quebrado)', () => {
    const rows = chain(5);
    rows.splice(2, 1);
    expect(kinds(rows)).toEqual(['gap@4', 'broken_link@4']);
  });

  it('REORDENAR linhas é detectado', () => {
    const rows = chain(5);
    const [b, c] = [at(rows, 1), at(rows, 2)];
    rows[1] = c;
    rows[2] = b;
    const k = kinds(rows);
    expect(k).toContain('out_of_order@2');
    expect(k).toContain('broken_link@3');
    expect(verifyChainRows(rows).ok).toBe(false);
  });

  it('trocar os números de seq entre duas linhas é detectado', () => {
    const rows = chain(5);
    const [b, c] = [at(rows, 1), at(rows, 2)];
    rows[1] = { ...c, seq: 2 };
    rows[2] = { ...b, seq: 3 };
    expect(kinds(rows)).toContain('broken_link@2');
    expect(verifyChainRows(rows).ok).toBe(false);
  });

  it('apagar o FIM só aparece com âncora externa; reescrever o histórico também', () => {
    const rows = chain(5);
    const anchor = { seq: 5, hash: at(rows, 4).hash };
    const cortada = rows.slice(0, 3);
    expect(verifyChainRows(cortada).ok).toBe(true); // limite conhecido: sem âncora não há como saber
    expect(kinds(cortada, anchor)).toEqual(['truncated@5']);
    const reescrita = chain(5).map((r) => (r.seq === 5 ? { ...r, hash: 'f'.repeat(64) } : r));
    expect(kinds(reescrita, anchor)).toContain('anchor_mismatch@5');
  });

  it('a primeira linha precisa partir do hash gênese', () => {
    const rows = chain(2);
    rows[0] = { ...at(rows, 0), prevHash: 'a'.repeat(64) };
    expect(kinds(rows)).toEqual(['broken_link@1']);
  });
});
