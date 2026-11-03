/**
 * R12 do parecer do #123 (G2): o manifesto da exportação marca as seções do prontuário por compartimento.
 * Nada pode sumir em silêncio: item de compartimento desconhecido ou versão sem atendimento derruba a exportação.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RECORD_COMPARTMENTS } from '../../db/schema';
import { secoesPorCompartimento } from './tenant-export';

describe('secoesPorCompartimento', () => {
  it('separa atendimentos, versões e adendos por compartimento, com os ids', () => {
    const s = secoesPorCompartimento(
      [
        { id: 'a1', compartment: 'geral' },
        { id: 'a2', compartment: 'psicologia' },
        { id: 'a3', compartment: 'psicologia' },
      ],
      [{ encounterId: 'a1' }, { encounterId: 'a2' }, { encounterId: 'a2' }, { encounterId: 'a3' }],
      [{ encounterId: 'a3' }],
    );
    expect(s.geral).toEqual({ encounters: 1, clinicalRecordVersions: 1, clinicalAddenda: 0, encounterIds: ['a1'] });
    expect(s.psicologia).toEqual({ encounters: 2, clinicalRecordVersions: 3, clinicalAddenda: 1, encounterIds: ['a2', 'a3'] });
  });

  it('todo compartimento do enum aparece, mesmo vazio', () => {
    const s = secoesPorCompartimento([], [], []);
    expect(Object.keys(s).sort()).toEqual([...RECORD_COMPARTMENTS].sort());
    for (const c of RECORD_COMPARTMENTS) expect(s[c]).toEqual({ encounters: 0, clinicalRecordVersions: 0, clinicalAddenda: 0, encounterIds: [] });
  });

  it('compartimento fora do enum falha fechado', () => {
    expect(() => secoesPorCompartimento([{ id: 'a1', compartment: 'nutricao' }], [], [])).toThrow(/compartimento desconhecido/);
  });

  it('versão ou adendo sem atendimento falha fechado', () => {
    expect(() => secoesPorCompartimento([{ id: 'a1', compartment: 'geral' }], [{ encounterId: 'x' }], [])).toThrow(/sem atendimento/);
    expect(() => secoesPorCompartimento([{ id: 'a1', compartment: 'geral' }], [], [{ encounterId: 'x' }])).toThrow(/sem atendimento/);
  });
});

describe('B1 do parecer do #126: ordem das leituras em READ COMMITTED', () => {
  it('versões e adendos são lidos antes dos atendimentos (sem versão órfã), na transação padrão', () => {
    const fonte = readFileSync(join(__dirname, 'tenant-export.ts'), 'utf8');
    const pos = (k: string) => fonte.indexOf(k);
    expect(pos('const versionRows')).toBeGreaterThan(0);
    expect(pos('const versionRows')).toBeLessThan(pos('const encounterRows'));
    expect(pos('const addendumRows')).toBeLessThan(pos('const encounterRows'));
    // A trilha (0005) recusa transação fora de READ COMMITTED: o serviço não pode trocar o isolamento.
    expect(readFileSync(join(__dirname, 'exports.module.ts'), 'utf8')).not.toMatch(/isolation|repeatable/i);
    expect(fonte).not.toMatch(/repeatable read/i);
  });
});
