# Ensaio local do merge completo (2026-10-25)

**Por quê:** o GitHub Actions continua parado (cobrança) e 24 PRs esperam merge. Este ensaio junta **todos** eles
localmente, na ordem planejada, para achar conflitos e quebras **antes** do dia do merge.

**O que NÃO foi feito:** nenhum merge real, nenhum push em branch de PR, nenhum comentário em PR. A branch do ensaio
(`ensaio/merge-completo`, 7bfdb71) ficou **só local**.

**Ambiente:** Windows 11, Node 24.20.0 (o CI usa Node 22), pnpm 9.12.0 via `npx`, base `origin/main` = 706c78a.
Cada PR entrou com `git merge --no-ff --no-edit origin/<head>`. Testes: `turbo run lint typecheck test build --force`
(sem cache), `pnpm audit --audit-level=high` e, no fim, `test:rls` e `test:security` contra Postgres embutido
(porta 54410, banco recriado do zero, papéis de `infra/local/postgres-init.sh`, migrações 0001–0053). Sem Redis local.

## 1. Ordem final recomendada

Bases conferidas com `gh pr view` / `gh pr list` (FATO, 25/10/2026):

| Pilha | Encadeamento (base ← head) |
|---|---|
| Backend | `main` ← #57 ← #61 ← #62 ← #63 ← #65 ← **#73** (`eng/integracao-r19`, sobre `eng/financeiro`; já contém #66/#67/#68/#69) |
| Front HTTP | `eng/rotas-pacientes-agenda` (#57) ← **#60** |
| Front (@Lopesloro) | `main` ← #43 ← #44 ← #45 ← #46 ← #47 ← **#75** |
| Soltos sobre `main` | #72, #70, #71, #52, #51, #74, #54, #56, #59, #58, #49 |

**Ordem recomendada (a mesma que o ensaio rodou e deixou verde):**

1. **Dependências e CI:** #72 → #70 → #71 → #52 → #51 → #74 → #54
2. **Primeira tela do front:** #43
3. **Backend:** #57 → #61 → #62 → #63 → #65 → **#73** (fecha #66/#67/#68/#69 sem merge)
4. **Front ligado à API:** #60
5. **Resto da pilha do front:** #44 → #45 → #46 → #47 → #75 (**entra logo depois do #60**, como sugerido: o #44 e o
   #75 conflitam com o #60 e é melhor resolver uma vez, já com o adaptador HTTP na main)
6. **Fim:** #56 → #59 → #58 → #49

Fora do plano e não ensaiados: #55 (relatório da rodada 8, só docs) e #36 (PoC da D4).

## 2. PR × conflito × resolução × risco

| # | PR (head) | Conflito | Natureza | Resolução no ensaio | Risco |
|---|---|---|---|---|---|
| 72 | minor-and-patch (next 16.4.2…) | — | — | — | Baixo |
| 70 | codeql analyze 4.39.0 | — | — | — | Baixo |
| 71 | codeql init 4.39.0 | — | — | — | Baixo |
| 52 | setup-node 7.1.0 | — | — | — | Baixo |
| 51 | upload-artifact 7.0.2 | — | — | — | Baixo |
| 74 | `deps/multer-2.5` | `pnpm-lock.yaml` | lockfile (o #72 mexeu no mesmo arquivo) | lado da main + `pnpm install` (sem frozen): só entram os `overrides` multer 2.5.0 / body-parser 2.4.0 | Baixo |
| 54 | `ci/economia-de-minutos` | — (auto-merge em 4 workflows) | — | — ; SHAs das actions conferidos: todos na versão nova | Baixo |
| 43 | `front/agenda-e-pacientes` | — | — | — | Baixo |
| 57 | `eng/rotas-pacientes-agenda` | — | — | — | Médio (dado sensível; já aprovado) |
| 61 | `eng/ressalvas-api-57` | — | — | — | Médio |
| 62 | `eng/guias-e-pacotes` | — | — | — | Médio |
| 63 | `eng/prontuario` | — | — | — | Médio |
| 65 | `eng/financeiro` | — | — | — | Médio |
| 73 | `eng/integracao-r19` | `pnpm-lock.yaml` | lockfile (bullmq 6.3.11 × #72/#74) | lado da main + `pnpm install`: +130 linhas, só `bullmq@6.3.11(ioredis@5.11.1)` | Médio (condição: 3 testes com Redis real no CI) |
| 60 | `front/adaptador-http-pacientes-agenda` | `docs/04-arquitetura/api-dominio.md` | documentação (os dois criam uma "§7") | juntar os dois; a seção do #60 vira **§15 "Ligando o front"** (a §7–§14 já são do backend) | Baixo |
| 44 | `front/atendimento-e-documentos` | `apps/web/components/app/dados.tsx`, `apps/web/lib/api/tipos.ts` | **código** (#60 pôs `limpar`/`modo`/`clinicaId`; #44 pôs `entrarComo`/`profissionalId`/`Registro`) | juntar os dois lados: o contexto expõe `modo`, `limpar` **e** `entrarComo`; `Usuario` tem `clinicaId?` **e** `profissionalId?` | Médio (código do front; typecheck e 293 testes verdes) |
| 45 | `front/financeiro-guias-mensagens-relatorios` | — | — | — | Baixo |
| 46 | `front/configuracoes-ajuda-acesso` | — | — | — | Baixo |
| 47 | `front/portal-pwa-erros` | — | — | — | Baixo |
| 75 | `front/portal-adaptador-http` | `apps/web/security-headers.test.ts` + **4 arquivos com import duplicado sem conflito textual** | código/teste | juntar os testes (CSP do modo http **e** convite sem Referer/`conferirConfigPortal`); remover o `import { fileURLToPath }` duplicado (ver §4) | **Médio-alto**: o merge "limpo" quebra o lint |
| 56 | `ia/golden-sets-50` | — | — | — | Baixo |
| 59 | `devops/imagem-api-e2e` | `.github/dependabot.yml`, `docs/04-arquitetura/ambientes-e-devops.md` | config + documentação | dependabot: manter o grupo `actions` do #54 **e** o ecossistema `docker` do #59; docs: manter "Economia de minutos" **e** "§8 Imagem da API" | Baixo |
| 58 | `devops/terraform-staging-b` | `docs/04-arquitetura/ambientes-e-devops.md` | documentação | linha do Terraform do #58 (`infra/terraform/`, link para `infra-staging.md`) + os itens de jobs e KMS da main | Baixo |
| 49 | ioredis 6.0.0 | `pnpm-lock.yaml` | lockfile | lado da main + `pnpm install`: `bullmq@6.3.11(ioredis@6.0.0)` sem conflito de peer | **Médio** (RESP3; Redis real não testado) |

Migrações: **sem número repetido nem buraco**, 0001–0053 em sequência; todas vêm da pilha do backend (#57…#73), que
entra em ordem. Nenhum PR de fora da pilha traz migração.

## 3. Resultados por bloco

| Bloco (até) | install | lint/typecheck/build | api test | web test | audit (high) |
|---|---|---|---|---|---|
| Dependências e CI (#72…#54) | frozen OK (após regerar o lock no #74) | 12/12 | **301/301** (16 arq.) | **137/137** (6) | **0 vulnerabilidades** (a alta do multer some com o #74) |
| Backend até #73 (+#43) | frozen OK (lock regerado no #73) | 12/12 | **529/529** (38) | **153/153** (7) | — |
| Front (#60, #44–#47, #75) | frozen OK | **web lint FALHOU** no merge limpo → corrigido → 12/12 | 529/529 | **293/293** (15) | — |
| Final (#56, #59, #58, #49) | frozen OK (lock regerado no #49) | 12/12 | **923/923** (38; o #56 parametriza os golden sets) | 293/293 | **0 vulnerabilidades** |
| Postgres real (resultado final) | — | — | `test:rls` **605/605** (22 arq.) | `test:security` **81 ok, 7 pulados** (5 do `agendador-redis` e 2 do `rate-limit-redis`: exigem Redis real) | — |

Não rodado localmente: E2E Playwright (`e2e.yml`), imagem Docker/Trivy (`imagem.yml`), `terraform validate`, CodeQL
e os testes com Redis real. Ficam para o CI.

## 4. Surpresas

1. **Quebra só na combinação (#75 × main):** o #75 traz o commit 76961dd ("caminhos com fileURLToPath"), que repete
   a correção 5e60d9e que **já está na main** (entrou com o #42). O git junta sem conflito, mas o import fica
   **duplicado** em 4 arquivos: `apps/web/scripts/checar-cinza.mjs` (ESLint `no-redeclare` → **lint vermelho**),
   `apps/web/lib/design.test.ts`, `apps/web/lib/privacidade.test.ts` e `apps/web/e2e/telas.spec.ts`. A pilha do front
   está sobre uma base antiga, então cada PR isolado passa; só a soma quebra. **Correção:** antes do merge, juntar a
   main na pilha do front (ou tirar o 76961dd do #75) e apagar a linha repetida.
2. **#44 × #60 conflitam em código** (contexto de dados e tipo `Usuario`). A resolução é aditiva, mas é do
   @Lopesloro decidir; o #44 precisa juntar a main **depois** do #60.
3. **Versões de actions voltam para trás com o #59:** `e2e.yml` e `imagem.yml` usam `setup-node` **v7.0.0** e
   `upload-artifact` **v7.0.1**, enquanto o #52/#51 sobem o resto para 7.1.0/7.0.2. Não quebra; o PR agrupado do
   Dependabot (#54) corrige depois, ou o #59 atualiza os SHAs antes do merge.
4. **#59 e #54 mexem no `dependabot.yml`:** sem resolver à mão, ou some o grupo `actions`, ou some o ecossistema
   `docker`. Os dois têm de ficar.
5. **Doc da main desatualizada pelo #58:** o item "Agendador de jobs" em `ambientes-e-devops.md` diz que o
   `infra-staging.md` "vive na branch do Terraform". Com o #58, ele passa a existir na main; o Terraform do #58
   **já** exige `REDIS_URL` e cria os alarmes (`jobs.tf`, `jobs-ready.tf`, `kms-clinicas.tf`). Ajustar a frase depois.
6. **Nenhuma migração fora de ordem** e nenhum teste de RLS quebrou na combinação (605/605, mais do que os 517 do #73
   sozinho porque entram o `adaptador-web.rls` do #60 e o resto da pilha).
7. Observação (não é bug): `conferirConfigPortal` recusa `NEXT_PUBLIC_PORTAL_MODO=http` em produção, mas o CSP só
   torna `NEXT_PUBLIC_API_ORIGIN` obrigatória com `NEXT_PUBLIC_API_MODO=http`. Em desenvolvimento, portal http sem
   origem só falha em execução. Vale um teste no #75 ou depois.

## 5. Passo a passo para o dia do merge

Pré-requisitos: billing do Actions resolvido; aprovação dos sócios; Guardião já aprovou os PRs que tocam dado.
**Use "Create a merge commit"** nas pilhas (squash quebra os PRs empilhados) e deixe "apagar a branch ao fazer merge"
ligado, para o GitHub reapontar o PR seguinte da pilha para a `main`.

1. **#72**: esperar CI verde (RLS e E2E com Playwright 1.64.1) → merge.
2. **#70** e **#71** juntos (pedir `@dependabot rebase` se ficarem desatualizados) → merge.
3. **#52** e **#51** → merge.
4. **#74**: vai conflitar no `pnpm-lock.yaml` depois do #72. Juntar a main e rodar `pnpm install` (o lock fica só com
   os `overrides`) → CI verde, `pnpm audit` verde → merge.
5. **#54** → merge (a partir daqui PR só de docs não roda CI).
6. **#43** → merge (CODEOWNERS: @Lopesloro).
7. **#57 → #61 → #62 → #63 → #65**: um por vez; depois de cada merge o próximo é reapontado para a `main`; esperar o CI.
8. **#73**: juntar a main (conflito no `pnpm-lock.yaml`: lado da main + `pnpm install`). Condição do Guardião: os 3
   testes com `JOBS_REDIS_TESTE=1` verdes no CI, com a saída anexada → merge. **Fechar #66, #67, #68 e #69** sem merge,
   com link para o #73.
9. **#60**: juntar a main (conflito em `api-dominio.md`: manter as duas seções, a do #60 vira §15) → merge.
10. **#44**: o @Lopesloro junta a main (conflito em `dados.tsx` e `tipos.ts`, resolução aditiva descrita na §2) → merge.
11. **#45 → #46 → #47**: juntar a main em cada um (no ensaio, sem conflito) → merge.
12. **#75**: juntar a main, resolver `security-headers.test.ts` (manter os dois testes) e **apagar o import duplicado
    de `fileURLToPath`** nos 4 arquivos da §4 (o CI de lint pega se esquecer) → merge.
13. **#56** → merge.
14. **#59**: juntar a main (conflito em `dependabot.yml`: manter grupo `actions` **e** `docker`; em
    `ambientes-e-devops.md`: manter as duas seções). Opcional: subir `setup-node`/`upload-artifact` dos workflows
    novos para 7.1.0/7.0.2 → merge.
15. **#58**: juntar a main (conflito em `ambientes-e-devops.md`: linha do Terraform do #58 + itens de jobs e KMS) → merge.
16. **#49**: pedir **`@dependabot rebase`** (o lock conflita desde o #72); conferir no lock
    `bullmq@6.3.11(ioredis@6.0.0)`; rodar os testes com Redis real (`redis:7`) e confirmar ElastiCache ≥ 6 (RESP3) →
    merge. Se não der para validar, segurar o #49.
17. Depois: atualizar a `fila.md` e a frase do `infra-staging.md` em `ambientes-e-devops.md` (surpresa 5).

Logs do ensaio (locais, fora do repositório): scratchpad `ensaio/b1.log` … `b4.log`, `rls.log`, `sec.log`.
