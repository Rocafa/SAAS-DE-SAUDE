/**
 * O texto digitado no Ajudante é dado pessoal ("achar Maria Silva"). Ele NÃO pode ir para log,
 * analytics, console, armazenamento do navegador nem rede. Este teste varre o código do Ajudante.
 */
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const raiz = fileURLToPath(new URL('..', import.meta.url));

// Caminhos relativos sempre com "/" (no Windows, join geraria "\" e quebraria os filtros por prefixo).
// join(raiz, dir) fica só para ler o disco.
function listarRecursivo(dir: string): string[] {
  const entradas = readdirSync(join(raiz, dir), { withFileTypes: true });
  return entradas.flatMap((e) => {
    if (e.isDirectory()) return listarRecursivo(`${dir}/${e.name}`);
    if (!/\.tsx?$/.test(e.name) || /\.test\.tsx?$/.test(e.name) || e.name.endsWith('.mjs')) return [];
    return [`${dir}/${e.name}`];
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
  [/SpeechRecognition|webkitSpeechRecognition|getUserMedia/, 'voz (manda áudio para fora)'],
];

// Remove comentários de linha (// ...) que começam no início da linha (após espaços opcionais)
// e comentários de bloco (/* ... */). Não remove // dentro de strings (ex.: https://).
function semComentarios(codigo: string): string {
  return codigo
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('privacidade do Ajudante', () => {
  it.each(ARQUIVOS_AJUDANTE)('%s não registra, guarda nem envia o texto digitado', (arquivo) => {
    const codigo = semComentarios(readFileSync(join(raiz, arquivo), 'utf8'));
    for (const [re, motivo] of PROIBIDO_AJUDANTE) expect(re.test(codigo), `${arquivo}: ${motivo}`).toBe(false);
  });

  it('a busca roda inteira no navegador (sem import de cliente HTTP)', () => {
    const busca = readFileSync(join(raiz, 'lib/ajudante/busca.ts'), 'utf8');
    expect(busca).not.toMatch(/from ['"](axios|ky|ofetch|node:http)/);
  });
});

/**
 * As telas da clínica mostram prontuário, CPF e nome de paciente. O portal já tem varredura própria
 * (lib/portal.test.ts); esta é a rede de proteção do lado da equipe, para o primeiro `console.log` de
 * depuração numa tela de prontuário não passar no CI.
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

describe('privacidade das telas da clínica', () => {
  it('a varredura cobre as telas e os componentes do app', () => {
    expect(TELAS_DA_CLINICA.length).toBeGreaterThan(30);
  });

  it.each(TELAS_DA_CLINICA)('%s não registra, guarda nem injeta HTML', (arquivo) => {
    const codigo = semComentarios(readFileSync(join(raiz, arquivo), 'utf8'));
    for (const [re, motivo] of PROIBIDO_NAS_TELAS) expect(re.test(codigo), `${arquivo}: ${motivo}`).toBe(false);
  });
});

/**
 * Varredura de rede/armazenamento/analytics no lib/ geral (exceto lib/api que é do portal).
 * Inclui sendBeacon, caches.*, window.name que podem vazar dados.
 */
const ARQUIVOS_LIB = [
  ...listarRecursivo('lib').filter((f) => !f.startsWith('lib/api/')),
];

const PROIBIDO_LIB: [RegExp, string][] = [
  [/\bconsole\./, 'console'],
  [/\bfetch\s*\(/, 'fetch (rede)'],
  [/XMLHttpRequest|sendBeacon|WebSocket|EventSource/, 'rede (sendBeacon/EventSource/WebSocket)'],
  [/caches\./, 'Cache API'],
  [/window\.name/, 'window.name (pode vazar cross-origin)'],
  [/localStorage|sessionStorage|indexedDB|document\.cookie/, 'armazenamento do navegador'],
  [/gtag|dataLayer|posthog|analytics|sentry/i, 'analytics'],
];

describe('privacidade do lib/ (código compartilhado da clínica)', () => {
  it('há arquivos para varrer', () => {
    expect(ARQUIVOS_LIB.length).toBeGreaterThan(10);
  });

  it.each(ARQUIVOS_LIB)('%s não usa APIs perigosas de rede/armazenamento/analytics', (arquivo) => {
    const codigo = semComentarios(readFileSync(join(raiz, arquivo), 'utf8'));
    for (const [re, motivo] of PROIBIDO_LIB) expect(re.test(codigo), `${arquivo}: ${motivo}`).toBe(false);
  });
});
