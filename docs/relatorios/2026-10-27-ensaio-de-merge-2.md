# Ensaio local do merge completo — 2ª rodada (2026-10-27)

**Por quê:** na rodada 27 mudaram os heads do #73 (cursor v2, KMS por clínica), do #58 (Terraform) e entrou o #76
(adaptador HTTP alinhado ao backend da rodada 19+). Este ensaio repete o de 25/10
([2026-10-25-ensaio-de-merge.md](2026-10-25-ensaio-de-merge.md)) com os heads atuais.

**O que NÃO foi feito:** nenhum merge real, nenhum push em branch de PR, nenhum comentário em PR. A branch do ensaio
(`ensaio/merge-completo-2`, 94a7a89) ficou **só local**.

**Ambiente:** Windows 11, Node 24.20.0 (CI usa Node 22), pnpm 9.12.0 via `npx`. Base `origin/main` = 5c9db00 (a main
andou para e4ee51d durante o ensaio, só `CONTEXTO.md` e `RELATORIO-GERAL.md`: sem efeito). Cada PR entrou com
`git merge --no-ff --no-edit origin/<head>`. Dados 100% sintéticos.

## 1. Heads ensaiados (FATO, `gh pr list`, 27/10/2026)

#72 ed38dba · #74 400f491 · #54 af2f905 · #43 77993c3 · #57 23c9e2d · #61 19cf9ea · #62 c10ba7f · #63 1bdf94c ·
#65 c64a5ea · **#73 b25c017** · #60 a3542cb · **#76 8609141** · #44 b40d3dd · #45 7465d1c · #46 4fd3bcb · #47 380d205 ·
#75 232576a · #56 0a85284 · #59 62c340d · **#58 8a7a83a** · #70 7cac32f · #71 8f053dc · #52 7c2b56c · #51 591ce22 ·
#49 044170f.

Ordem: #72 → #74 → #54 → #43 → #57 → #61 → #62 → #63 → #65 → #73 → #60 → #76 → #44 → #45 → #46 → #47 → #75 → #56 →
#59 → #58 → #70 + #71 → #52 + #51 → #49. **Todos os 25 entraram.** Migrações 0001–0053, sem número repetido nem buraco.

## 2. Conflitos: previstos × novos

| # | Arquivo(s) | Já previsto em 25/10? | Resolução |
|---|---|---|---|
| 74 | `pnpm-lock.yaml` | sim | lado da main + `pnpm install` (+8/−4: overrides multer/body-parser) |
| 73 | `pnpm-lock.yaml` | sim | lado da main + `pnpm install` (+404 linhas: bullmq e `@aws-sdk/client-kms`) |
| 73 | **`apps/api/package.json`** | **NOVO** | o #73 agora traz `@aws-sdk/client-kms` 3.1149.0 (KMS por clínica) na mesma região em que o #72 sobe `@nestjs/*` para ^12.2.0. Juntar: manter `client-kms` **e** `@nestjs/*` ^12.2.0 (não voltar para ^12.1.2) |
| 60 | `docs/04-arquitetura/api-dominio.md` | sim | as duas seções; a do #60 vira **§15 "Ligando o front"** |
| 76 | — | (PR novo) | entrou limpo sobre o #60 |
| 44 | `dados.tsx`, `tipos.ts` | sim | aditivo: contexto com `modo`, `limpar` **e** `entrarComo`; `Usuario` com `clinicaId?` **e** `profissionalId?` (+ `Adendo`/`Registro`) |
| 44 | **`apps/web/lib/api/fake.ts`** | **NOVO** (vem do #76) | imports dos dois lados (`http`/`nascimento` do #76 + `prontuario` do #44; `Papel` **e** `Registro`); `usuarioAtual` do #44 (usuário trocável) com `listarPacientes` do #76 (simula `lista_mudou`). Para os testes do #76 continuarem valendo: `let usuario = opcoes.papel ? { ...USUARIOS[0], papel: opcoes.papel } : USUARIOS[0]` e a conferência de documento usa `podeConferirDocumento(usuario.papel)` em vez de `opcoes.papel ?? 'admin'` |
| 44 | **2 capturas** `docs/02-produto/telas/{celular,computador}-ficha-paciente.png` | **NOVO** (o #76 regravou) | lado do #44 (o E2E regrava de qualquer jeito) |
| 45 | **`apps/web/lib/api/tipos.ts`** | **NOVO** | aditivo: `TETO_LISTA_PACIENTES`/`ListaPacientes`/`comTruncado` do #76 **e** `Guia`/`NovaGuia`/`Conversa` do #45 |
| 46 | **`apps/web/lib/api/fake.ts`** | **NOVO** | aditivo nos imports (`http`/`nascimento` + `fimDaJanela` de `../conta`) |
| 75 | `apps/web/security-headers.test.ts` | sim | manter os dois testes (CSP do modo http **e** convite sem Referer/`conferirConfigPortal`) |
| 75 | **`packages/shared/src/index.ts`** | **NOVO** | manter `export * from './paginacao.js'` (cursor do #73) |
| 59 | `.github/dependabot.yml`, `ambientes-e-devops.md` | sim | grupo `actions` do #54 **e** ecossistema `docker`; "Economia de minutos" **e** "§8 Imagem da API" |
| 58 | `ambientes-e-devops.md` | sim | linha do Terraform do #58 + itens de jobs e KMS da main |
| 49 | `pnpm-lock.yaml` | sim | lado da main + `pnpm install` → `bullmq@6.3.11(ioredis@6.0.0)` |

**Sumiu:** a surpresa 1 de 25/10 (import duplicado de `fileURLToPath` no #75, que quebrava o lint) **não aparece
mais**: cada arquivo tem um só import. Lint verde sem correção manual.

Quase todos os conflitos novos são **a pilha do front (#44–#46) contra o #76**, porque o #76 mexe no adaptador fake e
nos tipos. São aditivos, mas o do `fake.ts` no #44 pede decisão (usuário trocável × `opcoes.papel`); é do @Lopesloro.

## 3. Falha nova encontrada (e corrigida no ensaio)

`test:rls` → **1 falha** em `test/adaptador-web.rls.test.ts` › "outra clínica não enxerga o paciente nem a agenda":
`ErroApi … sessao_mudou` (409) em `apps/web/lib/api/http.ts:377`.

- **Causa:** o teste cria o adaptador com `obterToken: () => tokenDe(api.sessao(clinicaB, 'admin'))`, e
  `api.sessao()` gera **um usuário novo a cada chamada** (`randomUUID()`). O #76 passou a conferir a sessão no fim
  da paginação (R5 do parecer #76); como o usuário muda entre chamadas, ele recusa a lista.
- **Não é vazamento:** o erro acontece *antes* da asserção, e é a trava do #76 funcionando.
- **Não é só da combinação:** o `apoio-api.ts` do próprio head do #76 tem o mesmo `sessao()`, e o teste é idêntico ao
  do head. Então a falha deve existir no #76 isolado. Isso não foi rodado à parte.
- **Correção (só no teste, aplicada no ensaio):** uma sessão fixa por clínica (`const sa = api.sessao(clinicaA, …)`,
  `const sb = …`; `obterToken: () => tokenDe(sb)`). A asserção entre tenants não muda. Com ela: o arquivo dá 5/5 e a
  suíte 618/618. **Ação:** levar essa correção para o #76 antes do merge.

## 4. Números por suíte (branch final do ensaio)

| Suíte | Comando | Resultado | 25/10 |
|---|---|---|---|
| install | `pnpm install --frozen-lockfile` (depois de regerar o lock no #74, #73 e #49) | OK | OK |
| shared build | `pnpm --filter @plataforma/shared build` | OK | OK |
| turbo | `turbo run lint typecheck test build --force` | **12/12 tarefas** (0 em cache) | 12/12 |
| api test | (no turbo) | **986/986** (42 arquivos) | 923/923 (38) |
| web test | (no turbo) | **349/349** (18 arquivos) | 293/293 (15) |
| `listas-terraform.test.ts` | `vitest run … --reporter=verbose` | **2/2 rodaram e passaram**. O caso "app.tf do staging (após o merge do #58)" **não pulou** (✓, não ↓) | pulava (sem #58) |
| audit | `pnpm audit --audit-level=high` | **No known vulnerabilities found** | 0 |
| `test:rls` (Postgres embutido, porta 55451, banco do zero, migrações 0001–0053) | `node run.cjs fresh` / `rls` | 1ª: **617/618** (falha da §3) → com a correção: **618/618** (23 arquivos) | 605/605 (22) |
| `test:security` | `node run.cjs security` | **81 ok, 7 pulados** (4 arq. ok, 1 pulado: `agendador-redis` 5 + `rate-limit-redis` 2, exigem Redis real) | 81 ok, 7 pulados |
| E2E web (Playwright) | `pnpm build`; `next start -p 3005` à mão; `npx playwright test --workers=1` | **223 ok, 1 pulado** (3,6 min). O pulado é intencional: "remarcar arrastando na semana (computador)" no projeto celular | **não rodado** em 25/10 |

Antes do E2E a porta 3005 estava livre (`Get-NetTCPConnection`). O servidor e o Postgres foram encerrados no fim, com
3005 e 55451 livres. As capturas regravadas em `docs/02-produto/telas/` foram descartadas com `git checkout -- docs`.

## 5. O que não foi rodado

- **Docker**: imagem da API, hadolint, Trivy/SBOM e fumaça (`imagem.yml`).
- **Terraform**: `terraform validate`/`plan` do #58 (`infra.yml`). Só a trava de listas API × `app.tf` rodou (§4).
- **Redis real**: os 7 testes pulados de segurança e as variantes `JOBS_REDIS_TESTE=1`. Risco do #49 (ioredis 6, RESP3)
  continua sem teste local.
- CodeQL e Node 22 (aqui foi Node 24).

## 6. Comparação com 25/10

- Mais testes em todas as suítes: api +63, web +56, RLS +13, E2E (novo) 223. Lint verde sem mexer à mão.
- **Conflitos novos: 7** (§2). O único em código de backend é o `apps/api/package.json` do #73 × #72 (trivial). Os
  outros vêm da pilha do front contra o #76, mais o `shared/index.ts` do #75 × #73.
- **Falha nova: 1** (§3). É defeito de teste do #76, não da soma.
- Sem mudança no resto do passo a passo de 25/10. Ajustes:
  1. **#73**: depois de juntar a main, resolver também o `apps/api/package.json` (manter `client-kms` e Nest ^12.2.0).
  2. **#76** entra logo depois do #60. **Antes do merge, corrigir o `adaptador-web.rls.test.ts`** (sessão fixa).
  3. **#44/#45/#46**: juntar a main *depois* do #76 e resolver `fake.ts`/`tipos.ts` como na §2.
  4. **#75**: conflito extra em `packages/shared/src/index.ts` (manter `paginacao.js`). O import duplicado não precisa
     mais de correção.

Logs (locais, fora do repositório): scratchpad `ensaio2/turbo.log`, `ensaio2/pg/rls.log` (com a falha),
`ensaio2/pg/rls2.log`, `ensaio2/pg/sec.log`, `ensaio2/e2e.log`.
