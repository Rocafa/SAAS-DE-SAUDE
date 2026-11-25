// Ajustes de manifesto aplicados pelo pnpm na resolução (o resultado fica gravado no pnpm-lock.yaml).
//
// better-auth: declara como *peers* opcionais os frameworks e ferramentas de teste com que se integra
// (next, react, react-dom, vitest). Como o vitest é devDependency da API e o next existe no workspace, o pnpm
// resolve esses peers no snapshot do better-auth, que é dependência de PRODUÇÃO da API. Aí o
// `pnpm deploy --prod` do apps/api/Dockerfile os leva para a imagem: ~268 MB de next, vite, vitest e playwright,
// com o picomatch vulnerável (GHSA-fc5q-39xc-vjpf) junto.
// A API só importa better-auth/{api,node,adapters/drizzle,plugins/two-factor}, que não carregam nenhum deles; o
// único uso é o `better-auth/test-utils`, que a API não importa. Ver
// docs/03-seguranca-lgpd/revisoes/2026-11-17-excecao-picomatch.md (recomendação R1).
// Se um dia a API usar a integração com Next/React ou o test-utils do better-auth, tire o nome desta lista.
// `pnpm.packageExtensions` e `pnpm.peerDependencyRules` só acrescentam ou relaxam peers; remover exige este hook.
const PEERS_REMOVIDOS = {
  'better-auth': ['next', 'react', 'react-dom', 'vitest'],
};

function readPackage(pkg) {
  const remover = PEERS_REMOVIDOS[pkg.name];
  if (remover) {
    for (const nome of remover) {
      if (pkg.peerDependencies) delete pkg.peerDependencies[nome];
      if (pkg.peerDependenciesMeta) delete pkg.peerDependenciesMeta[nome];
    }
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
