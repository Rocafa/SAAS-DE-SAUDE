# Estado da frente Engenharia — rodada 8 (11 e 12/10/2026)

Atualizado a cada entrega. Ordens vêm do Maestro (`.maestro/ordens-eng.md`), hoje até a ORDEM-007.

## Feito
- **Item 2 (S6): auditoria encadeada por clínica.** PR #37, já na `main`. Migração 0005, `audit-chain.ts`, contrato do metadata, doc `auditoria-encadeada.md`.
- **Pendências de produção (ORDEM-004).** PR #30, já na `main`: rate limit sem IP em claro (HMAC), Redis obrigatório em produção, modo exposto em `/health/ready`.
- **Item 1 (S5): criptografia de campo por clínica.** PR #35, branch `eng/criptografia-por-clinica`, rebaseado sobre a `main` em 12/10:
  - B1 do revisor N1 (destruição em duas fases) e as sugestões (FK composta, clínica destruída não reprovisiona, chaves no backup-restore) em `e05004d`;
  - tabelas de chave declaradas na guarda de schema do #34 e espelho `pgTable` em `f764e26`;
  - ordem global das travas `audit_chain` → `tenant_keys` em `950ac20`. Corrige um deadlock real que só apareceu com a 0005 na `main`; o teste de regressão falha com a ordem antiga.
- **Item 0: rebase dos #31 e #33** sobre a `main` nova, com conflito resolvido nos dois lados e `pnpm-lock.yaml` regenerado:
  - #31 `d5d8fd8`: helmet 8.3.0 junto com o ioredis da `main`;
  - #33 `2908ee8`: ESLint 10 junto com o `@nestjs/testing` 12 da `main`.
  Os dois mexem em `apps/api/package.json` e no lock: o que entrar por último precisa de mais um rebase.

## Falta
- CI 9/9 no #35, #31 e #33; o merge é do Maestro.
- PR separado, autorizado na ORDEM-004: ações novas no enum de `packages/shared` (chaves, uso e recusa de IA, break-glass) e migração do CHECK de `audit_log.action`.
- Com a DevOps: SDK do KMS e IAM; job de âncora da auditoria em S3 com Object Lock.

## Números da última bateria (12/10, #35 rebaseado)
lint, typecheck, test e build 12/12; `test:rls` 67/67; `test:security` 76/76; `test:resiliencia` 25/25; `test:backup-restore` OK. A migração 0004 também foi aplicada depois da 0005, num banco que já tinha a 0005: `test:rls` 67/67.

## Ambiente de teste (sem Docker neste Mac)
Postgres 16.15 nativo em 127.0.0.1:5441 e Redis 8.10 em 6381 (o Homebrew não tem Redis 7), com dados em `~/Documents/Dev/projetos/.r8-dados/eng`. Um banco por branch: `plataforma_saude_reb` (#35), `plataforma_saude_deps` (#31 e #33).
