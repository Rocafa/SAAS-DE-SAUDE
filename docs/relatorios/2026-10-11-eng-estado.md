# Estado da frente Engenharia — rodada 8 (11/10/2026)

Atualizado a cada entrega. Ordens vêm do Maestro (`.maestro/ordens-eng.md`).

## Feito
- **Item 1 (S5): criptografia de campo por clínica.** PR #35, branch `eng/criptografia-por-clinica`.
  Migração 0004, módulo `crypto`, doc `criptografia-de-campo.md`. Unit 85, RLS 25, security 74, resiliência 24.
- **Item 2 (S6): auditoria encadeada por clínica.** PR #37, branch `eng/auditoria-encadeada`.
  Migração 0005 (trigger com trava por clínica + SHA-256 de JSON canônico), `audit-chain.ts`, doc `auditoria-encadeada.md`.
  Unit 59, RLS 29, security 74, resiliência 24, backup-restore OK.

## Falta
- Item 0: rebase dos PRs #31 e #33, só depois de o #30 entrar na `main` (o Maestro avisa).
- Relatório final `docs/relatorios/2026-10-11-eng.md`.
- Pendentes registrados nos docs: SDK do KMS e IAM (DevOps); job de âncora da auditoria em S3 com Object Lock (DevOps + Engenharia).

## Ambiente de teste (sem Docker neste Mac)
Postgres 16.15 nativo em 127.0.0.1:5441 (bancos `plataforma_saude` para o item 1 e `plataforma_saude_audit` para o item 2) e Redis 8.10 em 6381 (o Homebrew não tem Redis 7), com dados em `~/Documents/Dev/projetos/.r8-dados/eng`.

## Próximo passo
Aguardar o #30 na `main` para o item 0; enquanto isso, acompanhar o CI e a revisão do Guardião nos PRs #35 e #37.
