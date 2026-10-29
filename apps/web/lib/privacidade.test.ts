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

/**
 * As telas da clínica mostram prontuário, CPF e nome de paciente. O portal já tem varredura própria
 * (lib/portal.test.ts); esta é a rede de proteção do lado da equipe, para o primeiro `console.log` de
 * depuração numa tela de prontuário não passar no CI.
 */
const TELAS_DA_CLINICA = (function listar(dir: string): string[] {
  return readdirSync(join(raiz, dir), { withFileTypes: true }).flatMap((e) => {
    const caminho = `${dir}/${e.name}`;
    if (e.isDirectory()) return listar(caminho);
    if (!/\.tsx?$/.test(e.name) || /\.test\.tsx?$/.test(e.name)) return [];
    return [caminho];
  });
})('app/(app)').concat(
  readdirSync(join(raiz, 'components/app'))
    .filter((f) => /\.tsx$/.test(f) && !f.endsWith('.test.tsx'))
    .map((f) => `components/app/${f}`),
  ['lib/api/fake.ts'],
);

const PROIBIDO_NAS_TELAS: [RegExp, string][] = [
  [/\bconsole\./, 'console'],
  [/localStorage|sessionStorage|indexedDB|document\.cookie/, 'armazenamento do navegador'],
  [/gtag|dataLayer|posthog|analytics|sentry/i, 'analytics'],
  [/dangerouslySetInnerHTML|\.innerHTML/, 'HTML cru'],
];

describe('privacidade das telas da clínica', () => {
  it('a varredura cobre as telas e os componentes do app', () => {
    expect(TELAS_DA_CLINICA.length).toBeGreaterThan(20);
  });

  it.each(TELAS_DA_CLINICA)('%s não registra, guarda nem injeta HTML', (arquivo) => {
    const codigo = readFileSync(join(raiz, arquivo), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    for (const [re, motivo] of PROIBIDO_NAS_TELAS) expect(re.test(codigo), `${arquivo}: ${motivo}`).toBe(false);
  });
});
