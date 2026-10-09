// Só para subir a API COMPILADA no teste de carga (CI): `packages/shared` é TypeScript puro e
// importa './ids.js' apontando para './ids.ts'. Com o type stripping nativo do Node (>= 22.18),
// basta reescrever a extensão quando o .js não existe. Não é usado em produção (lá a imagem
// deve empacotar o shared compilado — pendência registrada em docs/04-arquitetura/testes-de-producao.md).
//
// Uso: node --import ./tests/carga/resolver-ts.mjs apps/api/dist/main.js
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      const relativo = specifier.startsWith('./') || specifier.startsWith('../');
      if (relativo && specifier.endsWith('.js') && err?.code === 'ERR_MODULE_NOT_FOUND') {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw err;
    }
  },
});
