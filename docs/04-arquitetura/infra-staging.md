# Infraestrutura de staging (Terraform)

> Código: [`infra/terraform/`](../../infra/terraform/) · CI: [`.github/workflows/infra.yml`](../../.github/workflows/infra.yml) · Bootstrap do banco: [`infra/rds/`](../../infra/rds/)
> Estado em 13/10/2026: **nada foi aplicado na AWS.** Só checagens offline (fmt, validate, tflint, checkov no CI).
> Base: [ambientes-e-devops.md](ambientes-e-devops.md), pareceres do Guardião sobre o [#35](../03-seguranca-lgpd/revisoes/2026-10-11-pr35.md) e o [#37](../03-seguranca-lgpd/revisoes/2026-10-11-pr37.md), item 22 do [checklist de PR](../03-seguranca-lgpd/checklist-pr.md).

## 1. O que cria

Duas raízes e um módulo, todos travados em `sa-east-1` (validação da variável, backend fixo, precondição no provider e Deny por `aws:RequestedRegion` no papel do GitHub).

| Raiz / módulo | Recursos |
|---|---|
| `bootstrap-state` (uma vez por conta, estado local) | Bucket S3 do estado (KMS, versionado, só TLS), tabela DynamoDB de trava, chave KMS |
| `staging` — rede (`rede.tf`) | VPC 10.40.0.0/16 em 3 AZs com camadas pública (ALB), app (ECS) e dados (RDS, Redis, sem rota para a internet); NAT desligado por padrão; VPC endpoints (S3 gateway; ECR, Secrets Manager, KMS e Logs de interface); flow logs cifrados |
| `staging` — dados (`dados.tf`) | RDS PostgreSQL 16 Multi-AZ, `rds.force_ssl=1`, PITR de 35 dias, senha do master gerada e guardada pelo próprio RDS; ElastiCache Redis 7.1 com 2 nós, **privado, TLS obrigatório e AUTH**; segredos da aplicação no Secrets Manager |
| `staging` — aplicação (`app.tf`) | ECR imutável, ECS Fargate (imagem por SHA, raiz somente leitura, usuário 1000), ALB só HTTPS com health check em `/health`, WAF (IP reputation, Common, KnownBadInputs, SQLi, **AnonymousIpList**, limite por IP) |
| `staging` — S3 (`s3.tf`, `exportacoes.tf`) | Bucket de documentos (KMS, Object Lock GOVERNANCE de no máximo 35 dias), **bucket `exportacoes` efêmero** e bucket de logs |
| `staging` — KMS (`kms.tf`, `kms-clinicas.tf`) | Uma chave por domínio (rds, redis, s3, exportacoes, segredos, logs, ecr) e as **permissões das KEKs por clínica** |
| `staging` — CloudTrail (`cloudtrail.tf`) | **Trilha multirregião** com validação de integridade, data events de S3 e bucket próprio (KMS, Object Lock COMPLIANCE de 12 meses) |
| `staging` — auditoria (`auditoria.tf`) + `modules/ancora-auditoria` | **Bucket da âncora da auditoria encadeada com Object Lock COMPLIANCE** e o papel que publica a âncora |
| `staging` — OIDC (`oidc.tf`) | Provedor OIDC do GitHub e papel de deploy restrito ao environment `staging` |

### 1.1 Requisitos do Guardião atendidos nesta rodada

**Exportações fora do Object Lock (V1 do [parecer do #58](../03-seguranca-lgpd/revisoes/2026-10-13-pr58.md)).** O pacote de exportação G2 (a base inteira da clínica) fica no bucket `exportacoes`:
- sem Object Lock;
- chave KMS própria;
- bloqueio público;
- a versão corrente expira em `exportacao_expiracao_dias` (padrão 2, máximo 7) e a não corrente em 1 dia;
- Deny para qualquer principal que não seja a tarefa da API, que gera o pacote e assina o link de 24 h.

O lifecycle do S3 é assíncrono, então **a aplicação também apaga o objeto quando o link vence** (requisito da ENG).

Os **documentos assinados** continuam no bucket `documentos`, com Object Lock só anti-ransomware: GOVERNANCE, no máximo 35 dias (validação da variável). Nunca o prazo de 20 anos do prontuário, porque a guarda legal é da clínica (G3). **Requisito da ENG:** os documentos são cifrados na aplicação com a DEK da clínica (envelope), para o *crypto-shredding* da KEK alcançar o S3.

**Logs sem valor de linha (V2).** O parameter group do Postgres grava só o mínimo:
- `log_statement = none`: `ddl` gravaria o `ALTER ROLE ... PASSWORD` do bootstrap;
- `log_error_verbosity = terse`: sem `DETAIL`, que traz "Failing row contains (...)";
- `log_min_error_statement = panic`, `log_parameter_max_length(_on_error) = 0` e `log_min_duration_statement/sample = -1`.

Todos os grupos de log são declarados no Terraform **antes** do recurso que escreve neles, com `logs_retencao_dias` e a chave KMS `logs`: `/aws/rds/instance/*/postgresql` e `/upgrade`, `RDSOSMetrics`, Container Insights, app, Redis, WAF e flow logs. O `infra.yml` falha se houver export do RDS sem grupo declarado, ou sem `log_error_verbosity`/`log_min_error_statement`. O WAF também redige a query string (R1).

**CloudTrail (R3, condição para o 1º apply).** Trilha multirregião com:
- eventos de gerenciamento, que incluem `kms:Decrypt` e `secretsmanager:GetSecretValue`;
- data events de objeto S3 nos buckets de estado, documentos, exportações e âncora (esta quando estiver nesta conta);
- validação de integridade ligada;
- bucket próprio em sa-east-1 com KMS próprio, Object Lock COMPLIANCE de `trilha_retencao_dias` (365, mínimo 180 pelo Marco Civil art. 15) e expiração depois do prazo.

Quando o I1 existir, ela vira trilha da organização numa conta de log.

**Regra de staging (R8):** staging **nunca** recebe dado real nem cópia de produção. Restaurar backup de prod em staging é proibido. Item 3 do checklist de PR.

**Redis privado com TLS e AUTH (item 22).** O Redis fica só nas sub-redes de dados, e o SG aceita só as tarefas da API. `transit_encryption_mode = "required"`, AUTH ligado. O token **não aparece em código nem no estado do Terraform**. Ele nasce efêmero (`ephemeral "random_password"`) e, na mesma execução, vai write-only para o ElastiCache (`auth_token_wo`) e para o Secrets Manager (`secret_string_wo`, segredo `redis`, chave `url` com `rediss://`). A API recebe `REDIS_URL` do Secrets Manager pelo papel de execução do ECS. As senhas de `app_user` e `app_migrator` seguem o mesmo caminho. O CI falha se aparecer `resource "random_password"`, `auth_token =` ou `secret_string =`.

**Âncora da auditoria (R2 do #37).** Módulo `ancora-auditoria`:
- bucket versionado com Object Lock **COMPLIANCE** (ninguém apaga ou encurta a retenção antes do prazo, nem o root);
- KMS próprio;
- só TLS;
- só o papel `ancora-publicador` grava, e só em `ancoras/`. O papel da API não grava;
- Deny para todos em `PutObjectRetention`, `PutObjectLegalHold`, `BypassGovernanceRetention`, `DeleteObjectVersion` e `PutBucketObjectLockConfiguration`.

**Conta separada:** o módulo é criado pelo provider `aws.auditoria`. Com `conta_auditoria_id = null`, ele fica na própria conta de staging, o que só é aceitável em staging: um administrador da conta ainda poderia editar a política do bucket, embora não consiga apagar as âncoras já gravadas. Com `conta_auditoria_id` e `papel_auditoria_arn` definidos, o Terraform assume um papel na conta de auditoria e o bucket nasce lá. **Em prod, a conta separada é obrigatória** (depende do I1, AWS Organizations).

Retenção: `ancora_retencao_dias`, 1 dia em staging. Em prod será o prazo da trilha, que depende da D7. O job que publica a âncora (de hora em hora e logo após ação de alta consequência) é código da ENG e ainda não existe; o papel já está pronto para ele.

**KEK por clínica no KMS (item 22 do #35).** As KEKs nascem em tempo de execução pelo `KmsKeyProvider`, com a tag `tenant_id`. O Terraform cria as permissões, separadas por papel (ABAC pela tag):

| Papel | Pode | Não pode |
|---|---|---|
| `gestor-chaves` (job de onboarding e eliminação) | `CreateKey` só simétrica, `ENCRYPT_DECRYPT`, origem AWS_KMS, **nunca multirregião** e com a tag `tenant_id`; ligar rotação; `ScheduleKeyDeletion` com janela ≥ `kek_janela_exclusao_dias` (7); cancelar destruição; `ReEncrypt` para rotação por suspeita; alias só em `alias/<nome>/clinica/*` | Gerar ou abrir DEK; tocar nas chaves de infraestrutura (Deny explícito, para ninguém "adotar" uma chave de infra colocando a tag) |
| API (papel da tarefa) | `GenerateDataKey` e `Decrypt` só em chave com tag `tenant_id` e com `EncryptionContext` contendo apenas `tenant_id` | Criar, destruir ou gerir chave |

## 2. Custo ESTIMADO mensal (staging)

Método igual ao da D13 ([rodada 7 §4](../relatorios/2026-10-10-rodada-7-necessidades-producao.md)): preço de referência de us-east-1 multiplicado por **1,5 a 2,1** para sa-east-1. **Tudo é ESTIMATIVA.** Conferir na [AWS Pricing Calculator](https://calculator.aws/) antes do apply.

| Item | Dimensionamento (padrões das variáveis) | US$/mês |
|---|---|---|
| RDS PostgreSQL | `db.t4g.small` **Multi-AZ**, 20 GB gp3, PITR 35 dias | 105–120 |
| ElastiCache Redis | `cache.t4g.micro` × 2 (primário + réplica) | 35–50 |
| ECS Fargate | 1 tarefa de 0,5 vCPU / 1 GB | 27–38 |
| ALB + IPv4 públicos | 1 ALB em 3 sub-redes, LCU baixo | 35–45 |
| WAF | 1 Web ACL + 6 regras, poucas requisições | 10–12 |
| VPC endpoints de interface | 5 endpoints × 1 AZ | 37–55 |
| KMS | 9 chaves fixas (inclui exportacoes e CloudTrail) + KEKs das clínicas de teste (US$ 1 cada) | 10–14 |
| Secrets Manager, S3, ECR, DynamoDB | 4 segredos, volume de teste | 4–10 |
| CloudWatch | Logs (app, RDS, Redis, WAF, flow logs ALL) e Container Insights | 15–40 |
| CloudTrail | 1ª trilha de gerenciamento grátis; data events de S3 a ~US$ 0,10 por 100 mil; bucket da trilha | 2–10 |
| **Total staging** | | **~285–390** |

**Comparação com a D13:** a D13 previu US$ 180–260 para um staging single-AZ. Este Terraform espelha a topologia de prod (RDS Multi-AZ, Redis com réplica), o que custa cerca de US$ 70–120 a mais. Botões para descer até a faixa da D13, se os sócios preferirem:
- RDS `multi_az = false` (hoje fixo em `dados.tf`): −50 a −60;
- Redis com 1 nó: −18 a −25;
- flow logs só `REJECT`: −5 a −15.

O NAT está desligado. Ligá-lo (`habilitar_nat`) soma cerca de US$ 50–70.

**KEK por clínica:**
- FATO ([AWS KMS pricing](https://aws.amazon.com/kms/pricing/), consultado em 11/10/2026, ver [criptografia-de-campo.md §7](criptografia-de-campo.md)): US$ 1/mês por chave, mais US$ 1/mês em cada uma das 2 primeiras rotações.
- ESTIMATIVA: com 1.000 clínicas, ≈ US$ 1.000/mês no 1º ano e ≈ US$ 3.000/mês do 3º ano em diante. É o maior custo variável de KMS e precisa entrar no preço por clínica (D2).

**Limites do KMS** (FATO, [Resource quotas](https://docs.aws.amazon.com/kms/latest/developerguide/resource-limits.html) e [Request quotas](https://docs.aws.amazon.com/kms/latest/developerguide/requests-per-second.html), consultados em 13/10/2026):
- 100.000 chaves gerenciadas pelo cliente por conta e região (ajustável);
- `CreateKey` a 5 req/s: onboarding em massa precisa de fila;
- 10.000 req/s compartilhadas para operações criptográficas simétricas em sa-east-1, que não está na lista de regiões com cota maior;
- `ScheduleKeyDeletion` a 15 req/s.

## 3. Como aplicar com segurança

**Pré-requisitos:** conta AWS de staging dentro do AWS Organizations (I1), certificado ACM do domínio (I10) e imagem da API no ECR (I3).

> ⚠️ **Mudança em produção exige aprovação dos sócios.** Staging também só é aplicado com um sócio acompanhando.

1. **Credencial:** SSO de curta duração com MFA, nunca chave de acesso de longa duração. Nenhuma credencial vai para o repositório, para o chat ou para arquivo versionado.
2. **Estado:**
   - rodar `terraform -chdir=infra/terraform/bootstrap-state init && terraform apply -var conta_aws_id=<id>`, com estado local, uma única vez;
   - guardar o output `backend_hcl` em `infra/terraform/staging/backend.hcl`, que fica fora do git (`.gitignore`).
3. **Variáveis:** criar `staging.tfvars`, também fora do git, com `conta_aws_id`, `certificado_arn` e `api_imagem_tag` (SHA de 40 caracteres). Para a âncora em conta separada, adicionar `conta_auditoria_id` e `papel_auditoria_arn`.
4. **Plano:** `terraform init -backend-config=backend.hcl`, depois `terraform plan -var-file=staging.tfvars -out=plano`.
   - Revisar o plano com um sócio, olhando com atenção a criação de `aws_s3_bucket_object_lock_configuration` (COMPLIANCE não se desfaz).
   - Conferir que nada sai de sa-east-1.
5. **Apply:** `terraform apply plano`.
6. **Banco:** rodar `infra/rds/bootstrap.sh` de dentro da VPC (tarefa ECS avulsa ou SSM), lendo as senhas dos segredos `banco-app-*` e a do master pelo output `rds_segredo_master`.
7. **Fumaça:** `/health` pelo ALB e conexão da API ao Redis por `rediss://`.

**Rotação:**
- **Redis:** incrementar `redis_auth_versao` e aplicar. Com a estratégia `ROTATE`, o token antigo continua válido. Em seguida, forçar um deploy novo do ECS para as tarefas lerem a `REDIS_URL` nova.
- **Banco:** incrementar `banco_senhas_versao`, aplicar e reexecutar o bootstrap.
- **Atenção:** se o endpoint do RDS ou do Redis mudar (recriação), os segredos só são regravados quando a versão é incrementada.

## 4. O que falta

- **Aplicar:** depende do I1 (contas e SSO), do I10 (domínio e certificado) e do I3 (imagem da API, hoje bloqueada pelo PR #30).
- **Conta de auditoria separada** (prod obrigatório) e o **job que publica a âncora** (ENG, R2 do #37).
- **Job gestor de chaves** (onboarding e eliminação) usando o papel `gestor-chaves`, e a dependência `@aws-sdk/client-kms` na API.
- **Checkov local não rodou nesta rodada:** a máquina não tem Python. Ele roda no `infra.yml`. A rodada 8 tinha 1 falha (CKV2_AWS_76), corrigida aqui com a regra AnonymousIpList; os skips novos têm justificativa no código.
- **Backend:** migrar a trava do DynamoDB para `use_lockfile = true`, nativo do S3 no Terraform 1.10+. Hoje o `dynamodb_table` funciona, mas está marcado como obsoleto.
- **Prod:** raiz própria em outra conta, com RDS e Redis maiores, Object Lock **curto** nos documentos (GOVERNANCE, ou COMPLIANCE de até 35 dias; nunca o prazo do prontuário, V1) e endpoints em 3 AZs. Retenção de logs amarrada à D7 e à [matriz-retencao](../03-seguranca-lgpd/matriz-retencao.md): 12 meses para app e WAF (registros de acesso; o mínimo legal é 6), 90 dias para flow logs, Redis e logs técnicos do RDS (R9).

### 4.1 Ressalvas do parecer do #58 que ficam rastreadas

| # | O que falta | Prazo |
|---|---|---|
| R2 | Política do bucket `logs` com Deny de `GetObject` para todos, exceto um papel de investigação de segurança. Prazo de prod: 6 a 12 meses (D7) | Antes de prod |
| R4 | Papéis humanos (SSO, MFA, sessão curta), papel de *break-glass* com alerta e Deny de `kms:Decrypt` para humanos nas chaves `rds`, `s3`, `exportacoes` e nas KEKs | Antes de prod |
| R5 | Payload de fila e chave do Redis só com ids opacos (regra da ENG em `api-dominio.md`), ou desligar o slow-log | Antes da 1ª fila com dado de paciente |
| R6 | TLS do ALB até a tarefa (target group HTTPS), ou risco aceito pelos sócios | Antes de prod |
| R7 | AWS Backup com vault lock em sa-east-1, sem cópia entre regiões, e registro de que o *crypto-shredding* cobre o backup | Antes de prod |
| R9 | Valores de retenção de prod amarrados à D7 (acima) | Com a D7 |
| ENG | Cifrar documentos com a DEK da clínica; apagar a exportação quando o link vence; job que publica a âncora; job gestor de chaves | Antes de dado real |
- **Rotação automática de segredos** (Lambda, I4) e **orçamento com alerta** (AWS Budgets), que fica para quando houver o e-mail do responsável.
