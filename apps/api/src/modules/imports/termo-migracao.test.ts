import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TERMO_MIGRACAO_VERSAO } from './importacao-regras';
import { TERMO_MIGRACAO_SHA256, TERMO_MIGRACAO_TEXTO } from './termo-migracao';

describe('R4: texto do termo de migração versionado', () => {
  it('o texto servido é idêntico ao de docs/03-seguranca-lgpd/termo-migracao.md e cita a versão vigente', () => {
    // vitest roda com cwd em apps/api.
    const md = readFileSync(join(process.cwd(), '..', '..', 'docs', '03-seguranca-lgpd', 'termo-migracao.md'), 'utf8').replace(/\r\n/g, '\n');
    const trecho = md.split('<!-- termo:inicio -->')[1]?.split('<!-- termo:fim -->')[0]?.trim();
    expect(trecho).toBe(TERMO_MIGRACAO_TEXTO);
    expect(TERMO_MIGRACAO_TEXTO).toContain(`versão ${TERMO_MIGRACAO_VERSAO}`);
    expect(TERMO_MIGRACAO_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });
});
