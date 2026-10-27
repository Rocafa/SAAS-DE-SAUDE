import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hmacDoCpf } from './cpf-indice-cego';

// CPF fictício (prefixo 000, faixa não emitida).
const CPF = '00000000191';

describe('índice cego do CPF (R9 do importador)', () => {
  it('chaves de clínicas diferentes dão índices diferentes para o mesmo CPF', () => {
    const a = randomBytes(32);
    const b = randomBytes(32);
    expect(hmacDoCpf(a, CPF)).not.toBe(hmacDoCpf(b, CPF));
  });

  it('determinístico por chave, 43 caracteres base64url, ignora máscara e não contém o CPF', () => {
    const k = randomBytes(32);
    const i = hmacDoCpf(k, CPF);
    expect(i).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hmacDoCpf(k, '000.000.001-91')).toBe(i);
    expect(i).not.toContain(CPF);
    expect(hmacDoCpf(k, '00000000272')).not.toBe(i);
  });
});
