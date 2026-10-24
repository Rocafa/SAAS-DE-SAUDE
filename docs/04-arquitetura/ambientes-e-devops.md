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
- Infra como código (Terraform) em `infra/` (a criar), com plano revisado em PR.
- **Agendador de jobs (R3 do parecer dos jobs, 23/10/2026; condição do piloto):** o IaC de staging e produção tem de **exigir `REDIS_URL`** (`rediss://`, sem padrão; o plano falha sem ela) e **criar os alarmes `JOB_ATRASADO` e `JOBS_DESLIGADOS`** (filtros de métrica no CloudWatch Logs + SNS de on-call; retenção também para o DPO), além do alarme de `jobs` ≠ `bullmq` no `/health/ready` por mais de 15 min. Detalhe em [api-dominio.md §14](api-dominio.md), "Monitoramento e IaC". O `infra-staging.md` vive na branch do Terraform (`devops/terraform-staging-b`) e recebe este item quando ela for retomada.
- **KMS das chaves de lote do importador (R3-b do parecer do importador, rodada 22; antes de `IMPORTADOR_HABILITADO=true`):** cada lote de importação tem chave KMS própria, com tags `tenant_id`, `purpose=import_batch` e `batch_id` e descrição própria; a chave da clínica tem `tenant_id` e `purpose=tenant_data`. A política IAM do papel da API tem de:
  - liberar `kms:CreateKey`/`kms:TagResource` só com `aws:RequestTag/purpose` ∈ {`tenant_data`, `import_batch`} e `tenant_id` presente;
  - liberar `kms:ScheduleKeyDeletion` **só** com `aws:ResourceTag/purpose = import_batch` (a API nunca agenda a exclusão da chave de uma clínica);
  - negar explicitamente `kms:CancelKeyDeletion` e `kms:EnableKey` nas chaves com `purpose = import_batch` (salvo *break-glass*), com alarme no CloudTrail;
  - negar `kms:UntagResource` e a troca da tag `purpose` em chave existente;
  - criar filtro de métrica e alarme para o log `CHAVE_LOTE_PRESA` (chave de lote em `destroying` há mais de 24 h, R3-a), destino SNS de on-call e do DPO.

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

Configuração no GitHub: branch protection com *required reviews*, *required status checks*, *dismiss stale approvals*, `CODEOWNERS` (ex.: `apps/api/src/modules/records/**` e `**/migrations/**` exigem revisor de segurança).

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
