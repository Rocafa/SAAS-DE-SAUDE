# Estado da frente Engenharia — rodada 8 (11/10/2026)

Atualizado a cada entrega. Ordens vêm do Maestro (`.maestro/ordens-eng.md`).

## Feito
- **Item 1 (S5): criptografia de campo por clínica**, branch `eng/criptografia-por-clinica`
  - migração 0004 (`tenant_master_keys`, `tenant_data_keys`, RLS FORCE, transições por trigger);
  - módulo `apps/api/src/modules/crypto` (KeyProvider, KMS por interface, provedor local, FieldCipher, cache com TTL);
  - doc `docs/04-arquitetura/criptografia-de-campo.md`;
  - testes: unit 85 (25 novos de cifra + 9 de provedores), RLS 25 (7 novos), security 74, resiliência 24.

## Falta
- Item 2 (S6): auditoria encadeada por clínica, migração 0005, branch `eng/auditoria-encadeada`.
- Item 0: rebase dos PRs #31 e #33, só depois de o #30 entrar na `main` (o Maestro avisa).
- Relatório final `docs/relatorios/2026-10-11-eng.md`.

## Ambiente de teste (sem Docker neste Mac)
Postgres 16.15 nativo em 127.0.0.1:5441 e Redis 8.10 em 6381 (o Homebrew não tem Redis 7), com dados em `~/Documents/Dev/projetos/.r8-dados/eng`. Os papéis foram criados com `infra/local/postgres-init.sh`.

## Próximo passo
Abrir o PR do item 1 e começar o item 2.
