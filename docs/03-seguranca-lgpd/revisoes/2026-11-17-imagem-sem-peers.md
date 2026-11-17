# Revisão do Guardião LGPD e Segurança: PR #210 (imagem da API sem os peers de teste do better-auth)

**Veredito: APROVADO.** Não há ressalva bloqueante. O merge depende só do #209, que deixa a auditoria de dependências verde.

- Data: 2026-11-17
- Branch: `eng/imagem-sem-peers-de-teste` (commit `d450ea2`), base `main`
- Origem: recomendação R1 do parecer `2026-11-17-excecao-picomatch.md`
- Escopo: `.pnpmfile.cjs` (novo), `pnpm-lock.yaml`, `apps/api/Dockerfile`, `.dockerignore`, `.github/workflows/{imagem,e2e}.yml`

## 1. O que foi conferido

| Item | Resultado |
|---|---|
| O hook é mínimo, determinístico e sem rede | **OK.** São 28 linhas sem `require`, sem `fs`, sem rede, sem variável de ambiente e sem relógio. Ele só faz `delete` em duas chaves do manifesto quando `pkg.name === 'better-auth'`. A mesma entrada gera sempre a mesma saída. O `pnpmfileChecksum` no lockfile faz o `--frozen-lockfile` falhar se alguém alterar o arquivo sem regravar o lock. |
| Só mexe no better-auth | **OK.** O mapa `PEERS_REMOVIDOS` tem uma chave. Os demais pacotes passam intactos (`return pkg`). Os outros peers do better-auth (drizzle-orm, pg, prisma etc.) continuam lá. |
| O lockfile mudou só no que devia | **OK.** Mudaram 4 pontos: o `pnpmfileChecksum`, o specifier do importer `apps/api`, o bloco `packages` (4 peers e 4 entradas de meta) e o snapshot (sufixo de resolução e 4 `optionalDependencies`). Nenhuma versão de outro pacote mudou, nem integridade ou override. |
| Dockerfile | **OK.** O `.pnpmfile.cjs` entra na camada de manifestos, antes do `pnpm fetch --frozen-lockfile`, e fica em `/repo` para o `pnpm deploy`, que resolve de novo e também precisa do hook. Ele não vai para o estágio `runtime`, porque só `/app` é copiado. A base continua fixada por digest e o runtime continua distroless e nonroot. |
| `.dockerignore` | **OK.** A lista de permissão ganhou só `!.pnpmfile.cjs`. As exclusões de `.env`, `*.pem`, `*.key`, `*.pfx` e testes continuam. |
| Workflows | **OK.** `imagem.yml` e `e2e.yml` passam a disparar quando o hook muda. Nenhuma permissão nem segredo foi alterado. |
| Uso dos peers pela API | **OK.** A API importa `better-auth`, `/api`, `/node`, `/adapters/drizzle` e `/plugins/two-factor`. No `dist` do 1.7.12, só três arquivos importam next, react ou vitest: `client/react/react-store.mjs`, `integrations/next-js.mjs` e `test-utils/test-instance.mjs`. Quem os importa é só `client/react/index.mjs` e `test-utils/*`, que ficam fora do grafo dos entrypoints usados. `apps/web` e `packages/*` não dependem do better-auth. |
| CI | Verde nas verificações relevantes: build com Trivy, SBOM e fumaça; lint, typecheck e testes; RLS; testes ofensivos; DAST; CodeQL; gitleaks; carga e SIGTERM. Só a auditoria falha, porque espera o #209. |

## 2. Efeito em segurança

- A superfície de ataque cai bastante. A imagem vai de cerca de 268 MB para cerca de 82 MB e perde 49 pacotes (next, vite, vitest, playwright, esbuild, rollup, sharp etc.).
- O `picomatch@4.0.7` (GHSA-fc5q-39xc-vjpf) sai da imagem de produção. Com isso, a pendência R1 do parecer `2026-11-17-excecao-picomatch.md` fica resolvida para a imagem. A exceção da auditoria vale só para o ambiente de desenvolvimento e continua com o prazo definido naquele parecer.
- LGPD: o PR não toca dado pessoal, base legal, tenant, auditoria nem retenção. Não há segredo nem dado real no diff.

## 3. Observações (não bloqueiam)

1. **O hook vale para qualquer versão do better-auth.** Ao atualizar o pacote, confira se a versão nova passou a importar next, react ou vitest em algum entrypoint usado pela API, por exemplo com um grep no `dist` igual ao desta revisão. A fumaça da imagem pega o erro de import em tempo de execução, mas só nos caminhos que ela exercita.
2. **O comentário do hook já diz como reverter.** Se a API passar a usar `better-auth/react`, `/next-js` ou `/test-utils`, tire o nome da lista e regrave o lockfile. Esse caso não deve virar exceção silenciosa.
3. Após o merge, registre no relatório o tamanho real da imagem Linux e a ausência do `picomatch` no SBOM gerado pelo CI. Os números do PR foram medidos no Windows.
