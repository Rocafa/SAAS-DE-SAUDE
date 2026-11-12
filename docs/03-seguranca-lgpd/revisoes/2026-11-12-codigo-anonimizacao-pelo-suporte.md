# Parecer do Guardião — código da anonimização pelo suporte (B10, PR #190)

> 12/11/2026 · Guardião LGPD & Segurança · parecer de **código**, branch `eng/anonimizacao-suporte` (empilhado sobre o #179).
> Base: parecer do desenho [`2026-11-12-desenho-anonimizacao-pelo-suporte.md`](2026-11-12-desenho-anonimizacao-pelo-suporte.md) (R1 a R9).
> Diff conferido: `git diff origin/eng/hmac-por-uso...HEAD` (11 arquivos).

## Veredito: **APROVADO COM RESSALVAS**

O código cumpre R1 a R5 e R7 a R9 na lógica. Nenhum caminho de saída do comando ou do log leva nome, e-mail ou mensagem do driver. As ressalvas estão na **infra**. A tarefa como está provavelmente nem sobe (R-A). Quem roda pode trocar o código executado, e nada avisa quando isso acontece (R-B). O grupo IAM foge do padrão de acesso humano do repositório (R-C). Nenhuma delas pede mudança na função. R-A, R-B e R-C são condição para o **B10 fechar**, ou seja, para a fumaça do staging com o comando real. O merge em staging pode vir antes, desde que a bancada RLS esteja verde (R-D).

## Conferência R1–R9

| R | Situação | Onde |
|---|---|---|
| R1 ator sistema | **ok**. `SYSTEM_ACTOR_ID`; o teste confere `actor_kind = 'sistema'` | `anonimizacao.ts:118-122`; `contrato-provedor-better-auth.rls.test.ts:1144-1154` |
| R2 operador fora da clínica | **ok**. Metadata `{op, user_id, ticket, via}`; o teste confere as chaves e a ausência do operador | `anonimizacao.ts:121`; teste `:1153-1154` |
| R3 (a) existência / sistema | **ok**. `nao_encontrada` sai antes de qualquer escrita e sem evento | `anonimizacao.ts:64-69` |
| R3 (b) filtro do HMAC | **ok** | `anonimizacao.ts:100` |
| R3 (c) trilha uma vez por clínica | **ok**, inclusive a linha antiga com o titular como ator | `anonimizacao.ts:112-116` |
| R3 (d) evento uma vez | **ok**. Na repetição sai `ANONIMIZACAO_REPETIDA` | `anonimizacao.ts:87`; `log-de-seguranca.ts` (evento novo) |
| R3 (e) clínica isolada | **ok**. `.catch` por clínica, erro no fim, o espelho só é limpo sem falha | `anonimizacao.ts:123-133` |
| R4 ordem e saída | **ok**. Credenciais primeiro; o comando confere o banco antes do `ok`; saída só com código fixo | `anonimizar-conta.ts:51-64`, `:91` |
| R5 segredos mínimos | **ok no Terraform**: só `DATABASE_AUTH_URL` e `DATABASE_URL`, com precondições. Ver R-B | `ops-anonimizacao.tf:24-46`, `:184-202` |
| R6 prazo e resposta | **ok** | runbook "Prazo interno" e "Depois"; RIPD §5 item 2 |
| R7 antes de rodar e dois registros | **ok** | runbook "Dois registros" e "Antes de rodar"; `matriz-retencao.md` (linha nova, 5 anos ⚖️) |
| R8 testes | **ok**, com a observação N3 | `anonimizar-conta.test.ts`; describe "B10" (`rls.test.ts:1351-1417`) |
| R9 RIPD | **ok** (§5 item 2 e §5a). O §3 não cita o prazo, mas o §5 cita, e isso basta | `RIPD-identidade.md:66`, `:81-82` |

## Respostas às perguntas do PR

**1. `user_id` do titular na metadata: aceito.** R2 trata do id de **quem executa**, não do titular. O id do titular é justamente o dado que **fica** (autoria do prontuário, 20 anos). A clínica já o tem em `clinic_members` e `professionals`. Sem ele, a trilha não prova de quem foi o atendimento (art. 37) e o R3(c) não funciona. O `ticket` conta à clínica que houve um pedido, o que o aviso do art. 18 §6 já faz, sem motivo. A regra R2 fica assim: na trilha da clínica, nenhum id da nossa equipe; o id do titular é permitido.

**2. `ops-lgpd` por usuário IAM × SSO: ver R-C.** O repositório já tem um padrão para acesso humano: **papel** assumido com MFA por `principais_humanos` (`acesso-humano.tf:25-48`, como `investigacao_seguranca` e `break_glass`). Um grupo IAM pede usuários IAM com chave de longo prazo para rodar `aws ecs run-task` pela CLI, e isso vai contra o I1.

**3. `containerOverrides` não restritos: o risco é real, e o CloudTrail sozinho não basta. Ver R-B.** Hoje `command` substitui o programa inteiro. Quem está no `ops-lgpd` pode rodar `node -e ...` com as credenciais `app_auth` e `app_user` e jogar no CloudWatch o schema `identidade` inteiro (e-mails e hashes de todas as contas). O CloudTrail registra o override, mas ninguém olha a menos que um alarme dispare. A "conferência a dois" vê o uuid, não o JSON do override.

## Achados

### Ressalvas (condição para fechar o B10)

- **R-A — A tarefa provavelmente não sobe.** A imagem é a distroless `nodejs22`, que tem `ENTRYPOINT ["/nodejs/bin/node"]` (`apps/api/Dockerfile:47`, `:74` usa `CMD ["dist/main.js"]` sem `node`). O `command = ["node", "dist/ops/anonimizar-conta.js"]` (`ops-anonimizacao.tf:45`, `:168`) vira `node node dist/ops/...` e falha com `Cannot find module '/app/node'`. O mesmo padrão já está em `app.tf:312`, então é preciso conferir se a API do staging já subiu com ele. Se não subiu, o defeito é anterior a este PR e afeta os dois. **Correção:** na definição desta tarefa, `entryPoint = ["/nodejs/bin/node", "dist/ops/anonimizar-conta.js"]`, e o override passa **só os argumentos** (`command = ["--usuario", …]`). Atualizar o runbook (`:37-40`) e o comentário do `.tf:11-14`. Essa mesma mudança ajuda na R-B.
- **R-B — Override de código sem alarme.** (a) O `entryPoint` fixo da R-A tira o `node -e` do caminho trivial, porque o `containerOverrides` do ECS não troca o `entryPoint`. (b) Ainda dá para injetar código por `environment` (`NODE_OPTIONS=--import=data:...` roda antes do `main`). Então: regra do EventBridge sobre o CloudTrail para `RunTask` da família `*-ops-anonimizacao` com alerta SNS a cada execução (como o break-glass, "cada uso gera alerta"). O alerta é **crítico** se `overrides.containerOverrides[].environment` tiver nome diferente de `CONFIRMA_ANONIMIZACAO`, ou se `command` não for exatamente as 6 posições `--usuario/--chamado/--operador`. (c) No runbook, o conferente confere o evento do CloudTrail daquela execução (o JSON do override) e anota no chamado.
- **R-C — Acesso humano por papel, não por grupo IAM.** Trocar `aws_iam_group.ops_lgpd` e a política do grupo (`ops-anonimizacao.tf:209-296`) por `aws_iam_role.ops_lgpd` com `confianca_humano_mfa` e `max_session_duration = 3600`. A política de confiança restringe a uma lista própria (`var.principais_ops_lgpd`, ARNs de SSO ou de usuários nominais, fora do git como os demais) e exige `sts:SourceIdentity` igual ao usuário, para o CloudTrail do `RunTask` mostrar a pessoa e não só o papel. A política do papel fica igual à atual. O `Deny` sem MFA e o `outputs.tf` (`grupo_ops_lgpd`) mudam junto. Se os sócios (N0) preferirem manter o grupo em staging, que fique registrado como exceção só de staging, com produção obrigatoriamente por papel.
- **R-D — Prova pendente.** No momento da revisão, "Isolamento entre tenants (RLS)", "Lint, typecheck e testes" e "fmt, validate, tflint e checkov" estavam **pendentes** (`gh pr checks 190`). O describe "B10" só roda na bancada RLS. O merge depende desses três verdes. O "1149 verdes" do corpo do PR é a unidade local.

### Notas (não bloqueiam)

- **N1 — Rede no runbook.** `runbook-anonimizacao-pelo-suporte.md:38` diz `'<a mesma da API>'`. Deve usar o output `ops_anonimizacao_rede` (`outputs.tf:76-84`), que tem o grupo de segurança próprio e sem Redis. Com o grupo da API a tarefa roda do mesmo jeito, mas perde a separação.
- **N2 — Corrida entre duas execuções.** `anonimizacao.ts:112-122` confere e depois grava sem trava. Duas tarefas simultâneas para a mesma conta podem duplicar `account_anonymized`. O runbook (uma execução por chamado, com conferente) já mitiga. Se quiser fechar, use `pg_advisory_xact_lock(hashtext(usuarioId))` na transação da clínica.
- **N3 — R8 "saída sem e-mail" provado com dependência falsa.** `anonimizar-conta.test.ts:47-51` cobre `executarComando`. `principal()` (`anonimizar-conta.ts:67-95`) não tem teste, e o único caminho de texto livre dele é `saida.linha`, que é fechado. Aceito. A prova ponta a ponta é a fumaça do B8/B10 com conta fictícia, e a saída real do CloudWatch vai anexada ao chamado de teste.
- **N4 — Retenção da saída.** O log vai para `/…/api` (`app.tf:139-143`), que guarda 30 dias em staging. Em produção vale a mesma decisão D7 do log de segurança (mínimo 180). É coerente com R5, nada a mudar aqui.
- **N5 — Deny nos papéis de máquina.** A lista (`ops-anonimizacao.tf:303-309`) cobre API, deploy, gestor de chaves e âncora. `backup`, `canary_jobs_ready`, `flow_logs` e `rds_monitoramento` não têm ECS nem PassRole hoje. Ao criar um papel de máquina novo com `ecs:*`, incluí-lo aqui.

## Caminhos de dado pessoal na saída e no log (verificado)

- Saída do comando: só `ok <uuid> clinicas=<n> [repetida]` ou um código fixo (`anonimizar-conta.ts:45`, `:64`). O `catch` descarta o erro (`:56`, `:91`).
- Log de segurança: os campos passam pela lista fechada (`linhaDeSeguranca`). `chamado` aceita só `LGPD-\d{1,7}` e `operador` só uuid. Um valor inválido vira `VALOR_INVALIDO`, nunca o texto.
- Falha por clínica: `.catch(() => …)` sem a mensagem (`anonimizacao.ts:123-126`).
- CloudTrail: só uuids e o número do chamado, desde que o runbook seja seguido. A R-B transforma o desvio em alerta.

## Checagens LGPD

- **Base legal:** art. 18 IV atendido. O que fica tem base no art. 16 I e no art. 7º II (CFM 1.821/2007). Nada do art. 11 é tocado.
- **Minimização:** ok na função e na tarefa (dois segredos). Fica a lacuna do override (R-B).
- **Consentimento:** não se aplica.
- **Criptografia:** TLS `verify-full` com o CA do RDS; o log é cifrado com KMS `logs`.
- **Isolamento por clínica:** `withTenant` por clínica, com o usuário de sistema.
- **Controle de acesso:** MFA e escopo por ARN de revisão. Faltam a R-C (forma) e a R-B (override).
- **Auditoria:** trilha por clínica com ator sistema, evento de segurança com o operador e CloudTrail. Falta o alerta da R-B.
- **Retenção:** prontuário e autoria 20 anos inalterados; registro do pedido em 5 anos ⚖️ (B5).
- **Segredos e dados fora do git:** ok. Só uuids fictícios nos testes, e nenhum nome de pessoa no Terraform.
- **CFM e ICP-Brasil:** a autoria do prontuário é preservada pelo id; nenhuma assinatura é afetada.
