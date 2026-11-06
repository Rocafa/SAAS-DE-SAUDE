#!/usr/bin/env node
/**
 * Gera os ícones do PWA (public/icones) a partir de um SVG em preto e branco, usando o Chromium do
 * Playwright. Rodar só quando o desenho mudar: node scripts/gerar-icones.mjs
 */
import { chromium } from '@playwright/test';

const desenho = (margem) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100%" height="100%">
  <rect width="100" height="100" fill="#111111" rx="${margem ? 0 : 22}"/>
  <g transform="translate(50 50) scale(${margem ? 0.62 : 0.8}) translate(-50 -50)">
    <rect x="38" y="16" width="24" height="68" rx="5" fill="#ffffff"/>
    <rect x="16" y="38" width="68" height="24" rx="5" fill="#ffffff"/>
  </g>
</svg>`;

const navegador = await chromium.launch();
for (const [arquivo, tamanho, maskable] of [
  ['icone-192.png', 192, false],
  ['icone-512.png', 512, false],
  ['icone-maskable-512.png', 512, true],
]) {
  const pagina = await navegador.newPage({ viewport: { width: tamanho, height: tamanho } });
  await pagina.setContent(`<html><body style="margin:0;background:transparent">${desenho(maskable)}</body></html>`);
  await pagina.screenshot({ path: new URL(`../public/icones/${arquivo}`, import.meta.url).pathname, omitBackground: !maskable });
  await pagina.close();
}
await navegador.close();
console.log('ícones gerados em public/icones');
