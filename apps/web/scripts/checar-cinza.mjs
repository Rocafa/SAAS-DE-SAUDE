#!/usr/bin/env node
/**
 * Reprova o build se o CSS FINAL (.next/static) tiver qualquer cor com matiz: azul, vermelho,
 * verde… Só preto, branco, cinza e transparente passam (preferência do sócio, ORDEM-001 do front).
 * A lógica de leitura das cores fica em lib/cores.mjs e é testada no Vitest.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { coresNaoCinza } from '../lib/cores.mjs';

const raiz = new URL('../.next/static', import.meta.url).pathname;

function arquivosCss(dir) {
  const out = [];
  for (const nome of readdirSync(dir)) {
    const p = join(dir, nome);
    if (statSync(p).isDirectory()) out.push(...arquivosCss(p));
    else if (nome.endsWith('.css')) out.push(p);
  }
  return out;
}

let arquivos;
try {
  arquivos = arquivosCss(raiz);
} catch {
  console.error('checar-cinza: não achei .next/static. Rode "next build" antes.');
  process.exit(1);
}
if (arquivos.length === 0) {
  console.error('checar-cinza: nenhum CSS gerado. Algo mudou no build; confira antes de liberar.');
  process.exit(1);
}

let falhas = 0;
for (const arquivo of arquivos) {
  for (const cor of coresNaoCinza(readFileSync(arquivo, 'utf8'))) {
    falhas++;
    console.error(`checar-cinza: cor fora da escala de cinza em ${arquivo.replace(raiz, '.next/static')}: ${cor}`);
  }
}
if (falhas) {
  console.error(`checar-cinza: ${falhas} cor(es) proibida(s). Use só os tokens de cinza de app/globals.css.`);
  process.exit(1);
}
console.log(`checar-cinza: ${arquivos.length} arquivo(s) CSS conferido(s), só preto, branco e cinza.`);
