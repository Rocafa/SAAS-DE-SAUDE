# Exceções da auditoria de dependências

O job `deps` da CI (`pnpm audit --audit-level=high`) bloqueia qualquer alerta alto ou crítico. Uma exceção
(`pnpm.auditConfig.ignoreGhsas` no `package.json` da raiz) só entra:

- com parecer do `guardiao-lgpd`;
- quando **não existe versão corrigida**;
- quando o caminho de ataque não alcança a produção;
- com **data de revisão**, conferida pela própria CI: depois da data, o job falha enquanto a exceção existir
  (formato no fim deste arquivo).

Assim que sair a correção, a exceção é removida e a dependência é atualizada (override, se preciso).

## Exceções vigentes

### GHSA-fc5q-39xc-vjpf: picomatch, ReDoS por extglob repetido (alta)

- **FATO:** o alerta foi publicado em 19/10/2026 e atualizado em 17/11/2026 às 15:56 UTC, quando a faixa vulnerável passou a ser
  `<= 4.0.7`, sem versão corrigida (`first_patched_version: null`). Fonte:
  <https://github.com/advisories/GHSA-fc5q-39xc-vjpf>, consultado em 17/11/2026. A 4.0.7 é a versão mais recente
  publicada no npm (24/08/2026), também consultada em 17/11/2026.
- **FATO:** o picomatch 4.0.7 **está presente na imagem de produção da API, mas não é alcançável.** O `better-auth`
  (dependência de produção) declara vitest, vite, next e playwright como *peers* opcionais. O `pnpm deploy --prod` do
  Dockerfile os leva junto, e com eles vêm tinyglobby, fdir e picomatch (parecer do Guardião, 17/11/2026). Em runtime,
  a API não importa vitest nem vite, e nenhum código dela chama picomatch.
- **Avaliação do risco:** para explorar, o atacante precisa fornecer o **padrão glob** (`+(*)`, `+(*a)`). Nenhuma rota
  nem tarefa da API recebe glob do usuário, e o código presente na imagem nunca é carregado. Não há caminho a partir de
  requisição externa. Risco: baixo.
- **Revisão:** até **01/12/2026**, ou antes, se sair a 4.0.8. Quem remove: o Maestro, no primeiro ciclo depois da
  publicação da correção (com o Dependabot, ou pelo vencimento na CI).
- **Pendência recomendada (não bloqueia):** tirar da imagem as dependências de teste trazidas pelos *peers* do
  `better-auth` (cerca de 268 MB).
- **Parecer:** `revisoes/2026-11-17-excecao-picomatch.md`.

<!-- vence: GHSA-fc5q-39xc-vjpf 2026-12-01 -->

## Formato (lido pela CI)

Cada exceção tem uma linha `<!-- vence: <GHSA> <AAAA-MM-DD> -->` neste arquivo. O passo `excecoes-de-auditoria` do
`ci.yml` falha se uma GHSA do `ignoreGhsas` não tiver essa linha, ou se a data já tiver passado.
