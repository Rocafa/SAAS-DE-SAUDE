import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// @next/eslint-plugin-next ficou de fora: depende de braces@3.0.3 (advisory high sem versão corrigida),
// o que reprovaria o job de auditoria. Reavaliar quando o plugin trocar a dependência.
export default tseslint.config(
  { ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      'no-console': 'error',
    },
  },
  {
    files: ['public/sw.js'],
    languageOptions: { globals: { self: 'readonly', caches: 'readonly', fetch: 'readonly', URL: 'readonly' } },
    // SW usa caches.* e pode usar sendBeacon/window.name; console continua proibido (não há uso).
  },
  {
    files: ['scripts/**/*.mjs', 'lib/**/*.mjs'],
    rules: { 'no-console': 'off' },
    languageOptions: { globals: { console: 'readonly', process: 'readonly', URL: 'readonly' } },
    // Scripts de build e arquivos .mjs em lib/ usam console propositalmente (checar-cinza: erro/sucesso;
    // gerar-icones: confirmação de geração). Exceção justificada: registro de erro de propósito.
  },
);
