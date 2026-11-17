/** Marca de lista truncada: nunca muta a lista de quem chamou nem deixa marca velha para trás. */
import { describe, expect, it } from 'vitest';
import { comTruncado, type Paciente } from './tipos';

const pac = (id: string): Paciente => ({
  id,
  nome: `Paciente ${id}`,
  telefone: '(11) 90000-0000',
  cpf: '000.000.000-00',
  responsaveis: [],
  ativo: true,
  nascimento: '1990-01-01',
  ficticio: true,
});

describe('comTruncado', () => {
  it('não muta a lista recebida', () => {
    const original = [pac('a')];
    const marcada = comTruncado(original, true);
    expect(marcada.truncado).toBe(true);
    expect((original as { truncado?: boolean }).truncado).toBeUndefined();
  });

  it('apaga a marca quando a lista nova não está truncada', () => {
    const antes = comTruncado([pac('a')], true);
    expect(comTruncado(antes, false).truncado).toBeUndefined();
  });
});
