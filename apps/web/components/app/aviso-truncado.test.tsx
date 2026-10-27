import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AvisoTruncado } from './aviso-truncado';

describe('AvisoTruncado (lista de pacientes acima de 1.000)', () => {
  it('mostra o aviso fixo quando a lista veio truncada, sem nenhum dado de paciente', () => {
    const html = renderToStaticMarkup(<AvisoTruncado truncado />);
    expect(html).toContain('Mostrando os primeiros 1.000 — refine a busca');
    expect(html).toContain('role="status"');
  });

  it('não mostra nada quando a lista veio inteira', () => {
    expect(renderToStaticMarkup(<AvisoTruncado truncado={false} />)).toBe('');
    expect(renderToStaticMarkup(<AvisoTruncado />)).toBe('');
  });
});
