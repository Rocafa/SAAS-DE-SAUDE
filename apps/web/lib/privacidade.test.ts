/**
 * O texto digitado no Ajudante é dado pessoal ("achar Maria Silva"). Ele NÃO pode ir para log,
 * analytics, console, armazenamento do navegador nem rede. Este teste varre o código do Ajudante.
 */
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const raiz = fileURLToPath(new URL('..', import.meta.url));
const ARQUIVOS = [
  'components/app/ajudante.tsx',
  'components/app/executor.tsx',
  ...readdirSync(join(raiz, 'lib/ajudante'))
    .filter((f) => !f.endsWith('.test.ts'))
    .map((f) => `lib/ajudante/${f}`),
  'lib/texto.ts',
];

const PROIBIDO: [RegExp, string][] = [
  [/\bconsole\./, 'console'],
  [/\bfetch\s*\(/, 'fetch (rede)'],
  [/XMLHttpRequest|sendBeacon|WebSocket|EventSource/, 'rede'],
  [/localStorage|sessionStorage|indexedDB|document\.cookie/, 'armazenamento do navegador'],
  [/gtag|dataLayer|posthog|analytics|sentry/i, 'analytics'],
  [/SpeechRecognition|webkitSpeechRecognition|getUserMedia/, 'voz (manda áudio para fora)'],
];

describe('privacidade do Ajudante', () => {
  it.each(ARQUIVOS)('%s não registra, guarda nem envia o texto digitado', (arquivo) => {
    const codigo = readFileSync(join(raiz, arquivo), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    for (const [re, motivo] of PROIBIDO) expect(re.test(codigo), `${arquivo}: ${motivo}`).toBe(false);
  });

  it('a busca roda inteira no navegador (sem import de cliente HTTP)', () => {
    const busca = readFileSync(join(raiz, 'lib/ajudante/busca.ts'), 'utf8');
    expect(busca).not.toMatch(/from ['"](axios|ky|ofetch|node:http)/);
  });
});
