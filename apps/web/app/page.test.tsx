import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import HomePage from './page';

describe('HomePage', () => {
  it('renderiza o título da plataforma', () => {
    const html = renderToStaticMarkup(<HomePage />);
    expect(html).toContain('<h1');
    expect(html).toContain('Plataforma Saúde');
  });
});
