# PRs do Dependabot — teste local (2026-10-24)

**Por quê:** o GitHub Actions está parado por cobrança, então nenhum PR do Dependabot passou pelo CI.
Cada PR foi testado **localmente** sobre `origin/main` (4203b58). Não houve merge, push nas branches do
Dependabot nem comentário nos PRs.

**Ambiente:** Windows 11, Node **24.20.0** local (o CI usa Node 22), pnpm 9.12.0 via `npx`,
`pnpm install --frozen-lockfile`, depois `turbo run lint typecheck test build` e `pnpm audit --audit-level=high`.
Sem Postgres nem Redis: os testes de RLS e a integração com Redis real ficam para o CI.

## Resumo

| PR | O que muda | Resultado local | Risco | Ordem de merge |
|---|---|---|---|---|
| **#72** | Grupo minor-and-patch (14 pacotes): next 16.4.0→**16.4.2**, react/react-dom 19.3.1, @nestjs/* 12.2.0, vitest 5.0.5, @playwright/test 1.64.1, @axe-core/playwright 4.14.0, eslint 10.13.0, typescript-eslint 8.71.2, lucide-react 1.59.0, turbo 2.11.9 | install frozen OK; **12/12 tarefas OK** (lint, typecheck, build e test); api **301/301**, web **137/137**; build Next 16.4.2 OK. Audit: as 2 críticas e a alta do next, e a alta do body-parser, **somem**. Resta **1 alta (multer 2.4.0)**, que **já existe na main** | Baixo (versões minor e patch) | **1º** |
| **#70 + #71** | `github/codeql-action/analyze` e `init` 4.38.2→4.39.0 (`codeql.yml`) | Diff só troca o SHA; os SHAs conferem com a tag v4.39.0 na API do GitHub; fixado por SHA com comentário `# vX`, como manda o padrão | Baixo. Mudança incompatível: o bundle mínimo do CodeQL passa a ser 2.20.7 (usamos o bundle padrão, sem efeito). Novo aviso se `checkout_path` divergir (não usamos) | **2º, juntos** (init e analyze na mesma versão) |
| **#52** | `actions/setup-node` 7.0.0→7.1.0 (ci, producao, seguranca) | Cobre as 9 ocorrências; SHA confere com a tag v7.1.0; fixado por SHA | Baixo: só melhorias (mise.toml, retry do manifest), nada incompatível | 3º |
| **#51** | `actions/upload-artifact` 7.0.1→7.0.2 (`codeql.yml`) | SHA confere com a tag v7.0.2; fixado por SHA | Muito baixo: retry em HTTP 429 | 3º (junto com o #52) |
| **#49** | `ioredis` 5.11.1→**6.0.0** (`apps/api`) | Sobre a main: install OK, lint, typecheck e build OK, api **301/301**. Na primeira rodada o web:test falhou com `ENOTEMPTY` no `.vitest-cache` (corrida de cache no Windows, não tem relação com o ioredis); rodado de novo, **137/137**. Sobre `eng/integracao-r19` com ioredis ^6 + bullmq 6.3.11: lint e typecheck OK, api **504/504** | **Médio** (ver abaixo) | **Último** |

## Detalhes

### #72: segurança

- `pnpm audit` na main (lockfile do #49 = lockfile da main mais o ioredis): **2 críticas** (Next.js RCE não autenticado) e
  **3 altas** (Next.js DoS, body-parser DoS, multer DoS).
- Com o #72: **1 alta**: `multer >=2.0.0 <2.5.0` (GHSA-q7qp-rjg7-q26m, DoS com `fileFilter` assíncrono pendente),
  que vem de `@nestjs/platform-express@12.2.0`, que **fixa** `multer@2.4.0`. O multer 2.5.0 saiu em 2026-10-22 e o
  Nest ainda não o adotou. **O #72 não introduz o problema**, mas o job `pnpm audit` do CI vai continuar vermelho
  depois do merge. Correção sugerida num PR separado: `pnpm.overrides: { "multer": ">=2.5.0" }` no `package.json`
  raiz (a API não usa upload com multer hoje; nenhum `FileInterceptor` em `apps/api/src`).
- O next 16.4.3 já saiu (2026-10-23); o Dependabot deve abrir um novo PR depois.

### #49: mudanças incompatíveis do ioredis 6

Notas da versão v6.0.0 (o pacote em `node_modules/ioredis` não traz CHANGELOG; fonte: release `redis/ioredis` v6.0.0):

1. **Exige Node ≥ 20.** CI e produção usam Node 22, então tudo bem.
2. **RESP3 é o protocolo padrão** (`protocol: 2` mantém o da v5). O RESP3 exige `HELLO`, ou seja, Redis ≥ 6.
   O docker-compose usa `redis:7-alpine`; **confirmar a versão do ElastiCache em produção (≥ 6)**.
3. "Improve default connection resilience" muda os padrões de reconexão. No rate limit
   (`apps/api/src/security/rate-limit-store.ts`) passamos tudo de forma explícita (`enableOfflineQueue:false`,
   `maxRetriesPerRequest:0`, `commandTimeout`, `connectTimeout`, `retryStrategy`), então não há efeito. O único
   comando é `EVAL`, que devolve um array de inteiros, idêntico em RESP2 e RESP3.

**bullmq 6.3.11** (em `origin/eng/integracao-r19`, `agendador-bullmq.ts` e `jobs.module.ts`):

- O peer `ioredis: '>=5.0.0'` aceita a 6; o lockfile resolve `bullmq@6.3.11(ioredis@6.0.0)` sem conflito.
- Tipos: o issue aberto taskforcesh/bullmq#4595 diz que um `RedisOptions` do ioredis 6 não é atribuível a
  `ConnectionOptions` (o `retryStrategy` aceita `null`). **Não nos afeta**: passamos uma **instância** `new Redis(...)`
  e o typecheck passou.
- **Não verificado:** o comportamento em execução do BullMQ com RESP3 contra um Redis real (os testes usam fakes).
  Antes do merge, recomendo rodar a integração com `redis:7` ou passar `protocol: 2` nas conexões do BullMQ e do
  rate limit até validar.
- Conflito: o #49 e o #72 conflitam no `pnpm-lock.yaml`. Depois do merge do #72, peça `@dependabot rebase` no #49.

## Ordem recomendada de merge (quando o CI voltar)

1. **#72**, o mais urgente (2 críticas do Next). Conferir no CI os testes de RLS e o E2E com Playwright 1.64.1.
2. **#70 + #71** juntos.
3. **#52** e **#51**.
4. PR separado com o override do multer (deixa o `pnpm audit` verde).
5. **#49** por último: rebase depois do #72, validar com Redis real e confirmar que o ElastiCache está em ≥ 6.
