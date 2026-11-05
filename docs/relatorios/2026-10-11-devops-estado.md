# Estado da frente DEVOPS-CI, rodada 8 (11/10/2026)

## Feito
- **Item 3 (I14):** `infra/rds/bootstrap.sql` + `bootstrap.sh`. Idempotente, roda como master sem superusuário e repete o `REVOKE TEMPORARY`. `test-bootstrap.sh` usa um Postgres 16.15 descartável na porta 55482 e deu **14 ok, 0 falhas**. Cobre: controle negativo (sem o REVOKE o ataque funciona), tabela TEMP sombra e função em `pg_temp` negadas, idempotência, drift corrigido pela reexecução, rotação de senha.
- **Item 2:** `infra/terraform/bootstrap-state` (S3 + DynamoDB + KMS) e `infra/terraform/staging` (VPC em 3 AZs, endpoints, RDS 16 Multi-AZ, Redis TLS+AUTH, ECS+ALB com `/health`, WAF, S3 com Object Lock, Secrets, OIDC, trava de região). Nada foi aplicado e nenhuma credencial AWS foi usada.
- Verificação local (Terraform 1.16.5, tflint 0.64.0 + ruleset aws 0.49.0, checkov 3.3.27): `fmt` ok, `validate` ok nas 2 raízes, tflint com 0 achados. Checkov: 376 passaram, **1 falhou** (CKV2_AWS_76, Log4j no WAF do ALB, checagem em grafo; a regra KnownBadInputs já existe) e 20 foram pulados com justificativa.

## Falta
- **Item 1 (imagem):** BLOQUEADO pelo PR #30, que ainda não foi mergeado. Na main, `@plataforma/shared` exporta `./src/index.ts`, e por isso `node dist/main.js` não sobe. Além disso, esta máquina não tem Docker.
- Resolver ou justificar o CKV2_AWS_76.
- Workflow `.github/workflows/infra.yml` (fmt, validate, tflint, checkov, grep que garante `/health` e o bootstrap do RDS).
- Estimativa de custo com data, atualização de `docs/04-arquitetura/ambientes-e-devops.md`, relatório `2026-10-11-devops.md` e PR.

## Atenção
Uma sessão duplicada (job 37198a87) rodou a mesma tarefa no worktree `../saude-r8-devops`. Os arquivos dela e os meus colidiram. Mudei este trabalho para `../saude-r8-devops-b` (branch `devops/terraform-staging-b`). **Os sócios escolhem qual versão segue.**

## Próximo passo
Escrever o `infra.yml` e fechar o PR [R8-devops] dos itens 2–4. O item 1 começa depois do merge do PR #30.
