import { describe, expect, it } from 'vitest';
import { METADATA_ACEITO, METADATA_RECUSADO } from './audit-metadata.cases';
import { assertAuditMetadata, AuditMetadataRejectedError } from './audit-metadata';

describe('contrato do metadata de auditoria', () => {
  it.each(METADATA_ACEITO.map((m) => [JSON.stringify(m), m]))('aceita %s', (_n, m) => {
    expect(() => assertAuditMetadata(m)).not.toThrow();
  });

  it.each(METADATA_RECUSADO.map((m) => [JSON.stringify(m).slice(0, 40), m]))('recusa %s', (_n, m) => {
    expect(() => assertAuditMetadata(m)).toThrow(AuditMetadataRejectedError);
  });

  it('o erro diz a regra, nunca o valor recusado', () => {
    const err = (() => {
      try {
        assertAuditMetadata({ x: '123.456.789-09' });
      } catch (e) {
        return e as Error;
      }
      return undefined;
    })();
    expect(err?.message).toMatch(/possível dado pessoal em x/);
    expect(err?.message).not.toContain('123');
  });
});
