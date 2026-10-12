import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// @next/eslint-plugin-next ficou de fora: depende de braces@3.0.3 (advisory high sem versão corrigida),
// o que reprovaria o job de auditoria. Reavaliar quando o plugin trocar a dependência.
export default tseslint.config(
  { ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['scripts/**/*.mjs', 'lib/**/*.mjs'],
    languageOptions: { globals: { console: 'readonly', process: 'readonly', URL: 'readonly' } },
  },
);
