/**
 * O texto digitado no Ajudante e dado pessoal ("achar Maria Silva"). Ele NAO pode ir para log,
 * analytics, console, armazenamento do navegador nem rede. Este teste varre o codigo do Ajudante.
 */
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const raiz = fileURLToPath(new URL('..', import.meta.url));

function listarRecursivo(dir: string): string[] {
  const entradas = readdirSync(join(raiz, dir), { withFileTypes: true });
  return entradas.flatMap((e) => {
    if (e.isDirectory()) return listarRecursivo(join(dir, e.name));
    if (!/\.tsx?$/.test(e.name) || /\.test\.tsx?$/.test(e.name) || e.name.endsWith('.mjs')) return [];
    return [join(dir, e.name)];
  });
}

// Arquivos do Ajudante (componentes e lib/ajudante)
const ARQUIVOS_AJUDANTE = [
  'components/app/ajudante.tsx',
  'components/app/executor.tsx',
  ...listarRecursivo('lib/ajudante'),
  'lib/texto.ts',
];

const PROIBIDO_AJUDANTE: [RegExp, string][] = [
  [/\bconsole\./, 'console'],
  [/\bfetch\s*\(/, 'fetch (rede)'],
  [/XMLHttpRequest|sendBeacon|WebSocket|EventSource/, 'rede'],
  [/localStorage|sessionStorage|indexedDB|document\.cookie/, 'armazenamento do navegador'],
  [/gtag|dataLayer|posthog|analytics|sentry/i, 'analytics'],
  [/SpeechRecognition|webkitSpeechRecognition|getUserMedia/, 'voz (manda audio para fora)'],
];

// Remove comentarios de linha (// ...) que comecam no inicio da linha (apos espacos opcionais)
// e comentarios de bloco (/* ... */). Nao remove // dentro de strings (ex.: https://).
function semComentarios(codigo: string): string {
  return codigo
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('privacidade do Ajudante', () => {
  it.each(ARQUIVOS_AJUDANTE)('%s nao registra, guarda nem envia o texto digitado', (arquivo) => {
    const codigo = semComentarios(readFileSync(join(raiz, arquivo), 'utf8'));
    for (const [re, motivo] of PROIBIDO_AJUDANTE) expect(re.test(codigo), `${arquivo}: ${motivo}`).toBe(false);
  });

  it('a busca roda inteira no navegador (sem import de cliente HTTP)', () => {
    const busca = readFileSync(join(raiz, 'lib/ajudante/busca.ts'), 'utf8');
    expect(busca).not.toMatch(/from ['"](axios|ky|ofetch|node:http)/);
  });
});

/**
 * As telas da clinica mostram prontuario, CPF e nome de paciente. O portal ja tem varredura propria
 * (lib/portal.test.ts); esta e a rede de protecao do lado da equipe, para o primeiro console.log de
 * depuracao numa tela de prontuario nao passar no CI.
 * Cobertura: app/(app), app/(acesso), app/(portal), components/app, components/portal, lib/** (exceto .mjs e testes).
 */
const TELAS_DA_CLINICA = [
  ...listarRecursivo('app/(app)'),
  ...listarRecursivo('app/(acesso)'),
  ...listarRecursivo('app/(portal)'),
  ...listarRecursivo('components/app'),
  ...listarRecursivo('components/portal'),
  ...listarRecursivo('lib').filter((f) => !f.startsWith('lib/api/')),
  'lib/api/fake.ts',
];

const PROIBIDO_NAS_TELAS: [RegExp, string][] = [
  [/\bconsole\./, 'console'],
  [/localStorage|sessionStorage|indexedDB|document\.cookie/, 'armazenamento do navegador'],
  [/gtag|dataLayer|posthog|analytics|sentry/i, 'analytics'],
  [/dangerouslySetInnerHTML|\.innerHTML/, 'HTML cru'],
];

describe('privacidade das telas da clinica', () => {
  it('a varredura cobre as telas e os componentes do app', () => {
    expect(TELAS_DA_CLINICA.length).toBeGreaterThan(30);
  });

  it.each(TELAS_DA_CLINICA)('%s nao registra, guarda nem injeta HTML', (arquivo) => {
    const codigo = semComentarios(readFileSync(join(raiz, arquivo), 'utf8'));
    for (const [re, motivo] of PROIBIDO_NAS_TELAS) expect(re.test(codigo), `${arquivo}: ${motivo}`).toBe(false);
  });
});

/**
 * Varredura de rede/armazenamento/analytics no lib/ geral (exceto lib/api que e do portal).
 * Inclui sendBeacon, caches.*, window.name que podem vazar dados. public/sw.js e excecao justificada (service worker).
 */
const ARQUIVOS_LIB = [
  ...listarRecursivo('lib').filter((f) => !f.startsWith('lib/api/')),
];

const PROIBIDO_LIB: [RegExp, string][] = [
  [/\bconsole\./, 'console'],
  [/\bfetch\s*\(/, 'fetch (rede)'],
  [/XMLHttpRequest|sendBeacon|WebSocket|EventSource/, 'rede (sendBeacon/EventSource/WebSocket)'],
  [/caches\./, 'Cache API (exceto public/sw.js)'],
  [/window\.name/, 'window.name (pode vazar cross-origin)'],
  [/localStorage|sessionStorage|indexedDB|document\.cookie/, 'armazenamento do navegador'],
  [/gtag|dataLayer|posthog|analytics|sentry/i, 'analytics'],
];

describe('privacidade do lib/ (codigo compartilhado da clinica)', () => {
  it('ha arquivos para varrer', () => {
    expect(ARQUIVOS_LIB.length).toBeGreaterThan(10);
  });

  it.each(ARQUIVOS_LIB)('%s nao usa APIs perigosas de rede/armazenamento/analytics', (arquivo) => {
    const codigo = semComentarios(readFileSync(join(raiz, arquivo), 'utf8'));
    for (const [re, motivo] of PROIBIDO_LIB) expect(re.test(codigo), `${arquivo}: ${motivo}`).toBe(false);
  });
});
