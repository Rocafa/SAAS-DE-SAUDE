/** R11 e R12 do parecer do #123 (MFA no prontuário). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RECORD_COMPARTMENTS } from '../../db/schema';
import { exigeMfaRecente, MFA_RECENTE_POR_COMPARTIMENTO } from './prontuario-regras';

describe('MFA recente por compartimento do prontuário', () => {
  it('R11: todo compartimento do schema tem decisão de MFA; hoje só a psicologia exige', () => {
    expect(Object.keys(MFA_RECENTE_POR_COMPARTIMENTO).sort()).toEqual([...RECORD_COMPARTMENTS].sort());
    expect(RECORD_COMPARTMENTS.filter((c) => exigeMfaRecente({ compartment: c }))).toEqual(['psicologia']);
  });

  it('R12: a exportação total lê as tabelas direto, sem a regra de tela que oculta a psicologia sem MFA', () => {
    const exportacao = readFileSync(join(__dirname, '..', 'exports', 'tenant-export.ts'), 'utf8');
    for (const proibido of ['podeVerConteudo', 'exigeMfaRecente', 'recusaDeMfaRecente', 'ProntuarioService']) {
      expect(exportacao.includes(proibido), `tenant-export.ts não pode depender de ${proibido} (ocultaria a psicologia no pacote G2)`).toBe(false);
    }
  });
});
