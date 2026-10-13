/**
 * Enquanto a D3 não sai, o módulo de IA não pode falar com nenhum fornecedor.
 * Quando um adaptador real entrar (PR próprio, com eval e Guardião), ele vai para
 * providers/<nome>.provider.ts e é adicionado a ALLOWED_NETWORK_FILES aqui, no mesmo PR.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ALLOWED_NETWORK_FILES: readonly string[] = [];

const FORBIDDEN = [
  /from ['"](node:)?(http|https|net|tls|dgram)['"]/,
  /\bfetch\s*\(/,
  /from ['"](axios|undici|got|node-fetch|openai|@anthropic-ai\/sdk|@google\/genai|@google-cloud\/vertexai)['"]/,
  /\bWebSocket\b/,
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('módulo ai sem rede', () => {
  const files = sourceFiles(__dirname);

  it('encontrou os arquivos do módulo', () => {
    expect(files.length).toBeGreaterThan(3);
  });

  it.each(files.map((f) => [relative(__dirname, f), f]))('%s não faz chamada externa', (rel, file) => {
    if (ALLOWED_NETWORK_FILES.includes(rel)) return;
    const src = readFileSync(file, 'utf8');
    for (const re of FORBIDDEN) expect(re.test(src), `${rel} casa com ${re}`).toBe(false);
  });
});
