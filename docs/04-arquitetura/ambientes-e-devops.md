# Ambientes e DevOps

## 1. Ambientes

| Ambiente | Onde | Dados | Deploy | Acesso |
|---|---|---|---|---|
| **local** | Máquina do dev — `docker compose` (Postgres + Redis) | Sintéticos (seed com faker pt-BR) | Manual | Dev |
| **dev** (opcional) | Conta AWS `dev` | Sintéticos | Automático a cada merge em `develop` ou preview por PR | Time de engenharia |
| **staging** | Conta AWS `staging`, sa-east-1, espelho de prod em escala menor | **Sintéticos** — nunca cópia de produção sem anonimização aprovada pelo Guardião | Automático a cada merge na `main` | Engenharia, Produto, QA |
| **prod** | Conta AWS `prod`, sa-east-1, Multi-AZ | Reais | Promoção manual da mesma imagem validada em staging, com aprovação | Acesso humano *just-in-time* com MFA |

Princípios:
- **Build uma vez, promove a mesma imagem** (tag por SHA do commit) de staging para prod.
- Configuração por variável de ambiente; segredos injetados do Secrets Manager (nunca no repo).
- Infra como código (Terraform) em `infra/terraform/`, com plano revisado em PR. Staging: [infra-staging.md](infra-staging.md).
- **Agendador de jobs (R3 do parecer dos jobs, 23/10/2026; condição do piloto):** o IaC de staging e produção tem de **exigir `REDIS_URL`** (`rediss://`, sem padrão; o plano falha sem ela) e **criar os alarmes `JOB_ATRASADO` e `JOBS_DESLIGADOS`** (filtros de métrica no CloudWatch Logs + SNS de on-call; retenção também para o DPO), além do alarme de `jobs` ≠ `bullmq` no `/health/ready` por mais de 15 min. Detalhe em [api-dominio.md §14](api-dominio.md), "Monitoramento e IaC". O `infra-staging.md` vive na branch do Terraform (`devops/terraform-staging-b`) e recebe este item quando ela for retomada.
- **KMS das chaves de lote do importador (R3-b do parecer do importador, rodada 22; antes de `IMPORTADOR_HABILITADO=true`):** cada lote de importação tem chave KMS própria, com tags `tenant_id`, `purpose=import_batch` e `batch_id` e descrição própria; a chave da clínica tem `tenant_id` e `purpose=tenant_data`. A política IAM do papel da API tem de:
  - liberar `kms:CreateKey`/`kms:TagResource` só com `aws:RequestTag/purpose` ∈ {`tenant_data`, `import_batch`} e `tenant_id` presente;
  - liberar `kms:ScheduleKeyDeletion` **só** com `aws:ResourceTag/purpose = import_batch` (a API nunca agenda a exclusão da chave de uma clínica);
  - negar explicitamente `kms:CancelKeyDeletion` e `kms:EnableKey` nas chaves com `purpose = import_batch` (salvo *break-glass*), com alarme no CloudTrail;
  - negar `kms:UntagResource` e a troca da tag `purpose` em chave existente;
  - criar filtro de métrica e alarme para os logs `CHAVE_LOTE_PRESA` (chave de lote em `destroying` ou intenção pendente há mais de 24 h, R3-a/0049) e `CHAVE_LOTE_ORFA` (recebimento que falhou sem ARN gravado, 0049), destino SNS de on-call e do DPO.

  Lista completa das permissões em [api-dominio.md §12d](api-dominio.md), "Chave de lote separável no IAM".
- Feature flags para liberar funcionalidades por tenant (ex.: IA, TISS).

## 2. Fluxo Git

- `main` é protegida: sem push direto, merge apenas via PR aprovado (ver `docs/00-governanca/fluxograma.md`).
- **Branches:** `<frente>/<microparte>`
  - `eng/agenda-api`, `eng/rls-patients`, `eng/esqueleto`
  - `produto/prd-agenda`, `ia/escriba-prompt`, `lgpd/ripd-teleconsulta`, `pesquisa/nichos-odonto`
- Branches curtas (idealmente < 3 dias); rebase/merge da `main` frequente.
- Hotfix: `eng/hotfix-<descricao>` com o mesmo rito de revisão (pode ter revisão expressa, nunca ausente).

## 3. Commits — Conventional Commits (em português)

```
<tipo>(<escopo>): <descrição no imperativo>

[corpo opcional]

[rodapé: BREAKING CHANGE, refs #issue]
```

Tipos: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, `perf`, `build`, `security`.
Escopos sugeridos = módulos: `tenancy`, `auth`, `patients`, `scheduling`, `records`, `prescriptions`, `billing`, `audit`, `web`, `shared`, `infra`.

Exemplos:
- `feat(scheduling): adiciona bloqueio de horários recorrentes`
- `security(records): força RLS na tabela record_entry`
- `docs(arquitetura): descreve fluxo de assinatura ICP-Brasil`

Validação automática futura: commitlint + husky (pré-commit também roda gitleaks local).

## 4. Revisão obrigatória

Todo PR precisa de:
1. **CI verde** (lint, typecheck, testes, gitleaks, auditoria de dependências, SAST).
2. **Revisão do líder da frente (N2)**.
3. **Gate do Guardião LGPD** quando tocar dado pessoal/de saúde, autenticação, criptografia, integrações, logs ou IA (rótulo `lgpd-review`). Veto do Guardião bloqueia merge.
4. **Aprovação humana (N0 — sócios)** para merge na `main`.

**Proteção da `main` (ligada em 28/10/2026):**

- **PR obrigatório.** Nenhum push direto de quem não é administrador.
- **Branch atualizada com a `main`** antes do merge (*strict*).
- **Proibido** force push e apagar a `main`.
- **10 checks obrigatórios**, todos rodam em todo PR:
  - CI: lint, typecheck e testes; RLS; auditoria de dependências; gitleaks.
  - CodeQL.
  - Segurança: testes ofensivos; ZAP.
  - Testes de produção: k6 + SIGTERM; resiliência + backup.
  - Infra: trava de TLS.

E2E, imagem e os jobs pesados de infra só rodam quando o PR mexe nos arquivos deles. Por isso não são obrigatórios: se fossem, um PR que não os dispara ficaria travado esperando. Quando rodam, a regra é a mesma: não se faz merge com check vermelho.

Ainda **não** estão ligados:
- **Aprovação obrigatória (0 por enquanto).** O GitHub não deixa o autor aprovar o próprio PR, e hoje um sócio sozinho travaria.
- **`enforce_admins`.** O administrador ainda consegue empurrar relatórios direto na `main`.
- **`CODEOWNERS`.**

Próximos passos, quando os dois sócios revisarem rotineiramente: 1 aprovação, `CODEOWNERS` (ex.: `apps/api/src/modules/records/**` e `**/migrations/**` com revisor de segurança) e *dismiss stale approvals*.

Checklist do PR (template a criar em `.github/pull_request_template.md`):
- [ ] Nenhum segredo, certificado ou dado real de paciente
- [ ] Toda query nova filtra por tenant e a tabela tem RLS
- [ ] Leitura/escrita de prontuário gera evento de auditoria
- [ ] Campos sensíveis novos estão cifrados (ou justificativa)
- [ ] Logs não contêm PII/dados clínicos
- [ ] Testes cobrem o caso de isolamento entre tenants

## 5. CI/CD — GitHub Actions

**CI** (`.github/workflows/ci.yml`, em todo PR e push na `main`):
1. `secrets` — gitleaks no histórico do PR.
2. `quality` — `pnpm install --frozen-lockfile` → `turbo run lint typecheck test` (com cache).
3. `deps` — `pnpm audit --audit-level=high`.
4. (a adicionar) `codeql` — SAST; `rls-tests` — Postgres em service container.

**CD** (a criar quando houver infraestrutura):
- `deploy-staging.yml`: em merge na `main` → build de imagens (API, worker, web) → push ECR → Trivy → migrations (`app_migrator`) → deploy ECS → smoke tests.
- `deploy-prod.yml`: `workflow_dispatch`/tag `v*` com **environment protection** (aprovação de sócio) → promove a mesma imagem → migrations compatíveis (expand/contract) → deploy *blue/green* ou *rolling* → verificação de saúde → rollback automático em falha.
- Autenticação GitHub → AWS via **OIDC** (sem chaves de acesso estáticas).

## 6. Migrations

- SQL versionado (Drizzle Kit), revisado em PR; toda tabela nova com `tenant_id` + RLS na **mesma** migration.
- Padrão *expand/contract* para não quebrar versões em execução.
- Nunca editar migration já aplicada em staging/prod.

## 7. Desenvolvimento local

```bash
cp .env.example .env          # preencher apenas com valores locais/de teste
docker compose up -d          # Postgres 16 + Redis 7
pnpm install
pnpm dev                      # turbo run dev (web + api)
```

Seeds locais usam apenas dados sintéticos. Proibido importar dumps de produção.

## 8. Imagem da API

**Arquivos:** `apps/api/Dockerfile`, `.dockerignore` (raiz) e `.github/workflows/imagem.yml`. O build é feito a partir da raiz do repositório:

```bash
docker build -f apps/api/Dockerfile -t plataforma-api .
docker run --read-only -e DATABASE_MIGRATOR_URL=... plataforma-api scripts/migrate.mjs   # migrações
docker run --read-only -e DATABASE_URL=... plataforma-api                                # API (porta 3333)
```

| Item | Como está |
|---|---|
| Bases | Build em `node:22-trixie-slim`, runtime em `gcr.io/distroless/nodejs22-debian13:nonroot` (Debian 13; a debian12 parou de ser republicada em fev/2026 e ficou com OpenSSL vulnerável) (sem shell nem gerenciador de pacotes). As duas são fixadas por **digest**, e o Dependabot (`docker`, em `/apps/api`) abre PR com o digest novo |
| Dependências | pnpm 9.12.0 via corepack; `pnpm fetch` (camada de cache) → `install --offline` filtrado em `@plataforma/api...` → build → `pnpm deploy --prod --prefer-offline` (o `deploy` do pnpm 9 precisa dos metadados do registro; `--offline` falha). Só a API e o `shared` entram, com o patch do `postgres@3.4.9` aplicado |
| Conteúdo | `dist/`, `node_modules/` de produção, `db/migrations/` e `scripts/migrate.mjs` |
| Usuário e disco | `USER 1000:1000` (o mesmo da task do ECS). O código pertence ao root e é só leitura, e a imagem roda com `--read-only` (no ECS: `readonlyRootFilesystem`) |
| Certificado do RDS | Bundle de `sa-east-1` baixado no build com `ADD --checksum=sha256:...` em `/etc/ssl/certs/rds-sa-east-1-bundle.pem`, e `NODE_EXTRA_CA_CERTS` aponta para ele (TLS `verify-full`). Se a AWS trocar o bundle, o build falha de propósito: baixar, conferir e atualizar o checksum |
| Healthcheck | `HEALTHCHECK` com o próprio node em `GET /health` (liveness, não toca o banco). No ECS vale o health check do ALB; `/health/ready` checa o banco |
| Segredos | Nenhum `ARG` ou `ENV` sensível. `DATABASE_URL`, `REDIS_URL`, `RATE_LIMIT_HASH_KEY` etc. chegam no runtime pelo Secrets Manager |
| Padrão | `NODE_ENV=production`, então a API recusa o provedor de IA fake e exige `RATE_LIMIT_HASH_KEY` (D4) |

**`.dockerignore`:** é uma lista de permissão. Tudo fica de fora, menos manifestos, lockfile, `patches/`, `packages/shared` (fonte) e `apps/api` (fonte, `db/`, `scripts/`). Testes, `.env*`, `node_modules`, `dist`, docs e `.git` nunca entram. Imagens futuras (web, worker) usam `<Dockerfile>.dockerignore` próprio.

**Workflow `imagem.yml`** (só em PR que muda `apps/api/**`, `packages/**`, `patches/**`, manifestos, lockfile, `.dockerignore` ou o próprio workflow; `timeout-minutes: 20`):
1. hadolint (binário oficial, SHA-256 conferido);
2. build com buildx e cache do GitHub (`type=gha`), **sem push**. O push para o ECR (por OIDC) entra quando o Terraform do staging for aplicado;
3. confere `User = 1000:1000` e o healthcheck;
4. Trivy (binário oficial, SHA-256 conferido): **falha em CRITICAL/HIGH com correção disponível** e gera o SBOM CycloneDX (artefato `sbom-api`, 30 dias);
5. fumaça com Postgres em service: cria os papéis, roda as migrações **pela imagem** (`app_migrator`), sobe a API com `--read-only`, `--cap-drop ALL` e `NODE_ENV=test` (D4: sem IA real nem Redis no CI) e bate em `/health` e `/health/ready`.

**E2E do front (`e2e.yml`):** Playwright do `apps/web` (celular e computador) contra o build de produção com o adaptador fake. Só roda em PR que muda `apps/web/**`, `packages/**` ou dependências. Usa cache do `.next` e do Chromium por versão do Playwright, 2 workers e `timeout-minutes: 20`. Relatório e trace só sobem em falha (7 dias; só dados sintéticos).
