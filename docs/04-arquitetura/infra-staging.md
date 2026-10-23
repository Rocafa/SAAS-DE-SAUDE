# Infraestrutura de staging (Terraform)

> Código: [`infra/terraform/`](../../infra/terraform/) · CI: [`.github/workflows/infra.yml`](../../.github/workflows/infra.yml) · Bootstrap do banco: [`infra/rds/`](../../infra/rds/)
> Estado em 14/10/2026: **nada foi aplicado na AWS.** Só checagens offline (fmt, validate, tflint, checkov no CI).
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
| `staging` — KMS (`kms.tf`, `kms-clinicas.tf`) | Uma chave por domínio (rds, redis, s3, exportacoes, segredos, logs, ecr, alertas, backup), **Deny de `kms:Decrypt` para humanos** nas chaves de dado e as **permissões das KEKs por clínica** |
| `staging` — acesso humano (`acesso-humano.tf`) | Papéis `investigacao-seguranca` (lê o bucket de logs) e `break-glass` (decifra em emergência), ambos só com MFA e sessão de 1 h; alerta de uso por EventBridge e SNS cifrado |
| `staging` — backup (`backup.tf`) | AWS Backup mensal do RDS em cofre de sa-east-1 com chave própria e vault lock, sem cópia entre regiões |
| `staging` — CloudTrail (`cloudtrail.tf`) | **Trilha multirregião** com validação de integridade, data events de S3 (inclusive as leituras do bucket de logs) e bucket próprio (KMS, Object Lock COMPLIANCE de 12 meses) |
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

**Registro de DDL com pgaudit (R11 do [parecer do #61](../03-seguranca-lgpd/revisoes/2026-10-14-pr61.md)).** O `app_migrator` (dono das tabelas) e o master podem desligar os triggers de integridade (0013–0018) ou o `FORCE ROW LEVEL SECURITY`. Para isso deixar rastro sem gravar dado:
- `shared_preload_libraries = pg_stat_statements,pgaudit` (estático: vale no próximo reboot, feito na janela de manutenção);
- `pgaudit.log = ddl,role`. **Nunca** `read`, `write` nem `all`: gravariam SQL de consulta e dado de paciente;
- `pgaudit.log_parameter = off` (sem valor de bind) e `pgaudit.log_relation = off`;
- os parâmetros endurecidos do V2 continuam: `log_statement = none` (o pgaudit não depende dele), `terse`, `log_min_error_statement = panic`, `log_parameter_max_length(_on_error) = 0`;
- as linhas `AUDIT:` saem pelo mesmo export `postgresql`, no grupo `/aws/rds/instance/*/postgresql`, com retenção e chave `logs`.

Alerta (`auditoria-banco.tf`): metric filters nesse grupo somam na métrica `PlataformaSaude/Banco/DdlSensivel` quando aparece `DISABLE TRIGGER`, `DROP TRIGGER`, `ALTER ROLE`, `NO FORCE ROW LEVEL SECURITY` ou `DISABLE ROW LEVEL SECURITY` (regex sem diferença de caixa). O alarme `*-ddl-sensivel` (soma ≥ 1 em 1 min) publica no tópico `alertas-seguranca`; a key policy da chave `alertas` e a política do tópico liberam `cloudwatch.amazonaws.com`, restrito ao ARN do alarme. Uma migração legítima que altere papel ou trigger também alerta: é o esperado, e quem aplicou responde no alerta.

**Funções de guarda, policies e dono (R12 do #61).** O alarme também soma `CREATE FUNCTION` (o pgaudit registra `CREATE OR REPLACE FUNCTION` com essa etiqueta), `ALTER FUNCTION`, `DROP FUNCTION` (o `CASCADE` derruba o trigger sem gerar `DROP TRIGGER`), `CREATE/ALTER/DROP POLICY` e `OWNER TO` (`ALTER TABLE/FUNCTION/SCHEMA ... OWNER TO`). As etiquetas vêm do campo "comando" do pgaudit (maiúsculas); `OWNER TO` é regex sem caixa, porque o pgaudit marca o comando como `ALTER TABLE`.

**Constraint, índice, rule, réplica e permissões (R10 do #58).** O alarme também soma `DROP/ALTER CONSTRAINT` e `DROP NOT NULL`, `DROP INDEX`, `CREATE RULE` (inclui `CREATE OR REPLACE RULE`) e `DISABLE RULE`, `ENABLE REPLICA` e `ENABLE ALWAYS` (trigger ou rule que deixa de valer na sessão normal sem nenhum `DISABLE`), `GRANT`, `REVOKE`, `GRANT ROLE`, `ALTER DEFAULT PRIVILEGES` e qualquer menção a `session_replication_role` (`ALTER ROLE/DATABASE ... SET`, `GRANT SET ON PARAMETER`, `set_config` dentro de função). O CloudWatch aceita **no máximo 5 filtros com regex por log group** (FATO, [Filter pattern syntax](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/FilterAndPatternSyntax.html), consultado em 22/10/2026) e não aceita parênteses; por isso as regex sem caixa ficam agrupadas com `|` em 4 filtros (`alter-table-guardas`, `constraint`, `session-replication-role`, `owner-to`), e o resto é termo exato da etiqueta do pgaudit. O CI falha se um filtro ou palavra-chave sumir, ou se passar de 5 regex. Toda migração com `GRANT`/`REVOKE` dispara o alarme: é o esperado (alarme sempre, ver abaixo).

*Escolha: alarme sempre + conferência pós-deploy, sem janela de migração que silencie o alarme.* Motivos:
1. **Janela vira desligador.** Quem consegue marcar "início da janela" (parâmetro SSM, evento, linha de log) consegue esconder a troca de corpo de uma função de guarda; é justamente o `app_migrator` ou alguém com acesso ao deploy, o perfil que o alarme vigia. Um alarme que o próprio alvo silencia não prova nada.
2. **Metric filter não tem estado.** O CloudWatch não condiciona um filtro a outro evento; a janela exigiria Lambda ou EventBridge + SSM para ligar/desligar o alarme, mais código, mais permissões e uma corrida (DDL logo antes/depois da marca).
3. **O alerta não basta para provar o estado final.** Mesmo com janela, "dentro da janela" não diz *o que* mudou. A conferência por hash diz se o banco ficou igual ao repositório, que é o que interessa.
4. **Volume baixo.** Migração que mexe em função/policy é rara; responder ao alerta com a conferência custa minutos.

**Runbook de conferência pós-deploy** (staging hoje; produção quando existir, com aprovação dos sócios):
1. Ao aplicar uma migração, o alarme `*-ddl-sensivel` dispara. Quem aplicou responde no alerta com o commit/PR da migração.
2. Gerar a referência a partir do commit implantado, em máquina com PostgreSQL 16 (ou no runner): `git checkout <sha> && sh infra/rds/verificar-guardas.sh referencia > esperado.tsv`. Sobe Postgres descartável, roda `bootstrap.sh` e as migrações como `app_migrator`.
3. Ler o banco de dentro da VPC (mesma tarefa ECS avulsa da migração, papel de máquina, usuário `app_migrator`, TLS `verify-full`): `sh infra/rds/verificar-guardas.sh banco > obtido.tsv`. Só lê catálogo (`pg_proc`, `pg_policy`, `pg_trigger`, `pg_class`, `pg_attribute`, `pg_constraint`, `pg_index`, `pg_rewrite`, `pg_namespace`, `pg_default_acl`, `pg_roles`, `pg_auth_members`); a saída não tem dado de linha nem segredo.
4. `sh infra/rds/verificar-guardas.sh comparar esperado.tsv obtido.tsv`. Igual: anotar "conferido" no alerta e fechar. Diferente: incidente de segurança; o `diff` mostra função/policy/trigger/tabela divergente, e o Guardião decide entre reaplicar a migração e investigar.
5. Alarme sem migração correspondente: incidente direto (passo 4 para ver o que mudou).

A impressão cobre, por objeto: função (definição completa com `SECURITY DEFINER`/`SET`, dono e ACL), policy (comando, permissiva, papéis, `USING`, `WITH CHECK`), trigger (definição e `tgenabled`: `O` normal, `D` desligado, `R` só réplica, `A` sempre), tabela/view/sequência (dono, `ENABLE`/`FORCE ROW LEVEL SECURITY`, ACL da tabela e das colunas, colunas `NOT NULL`, `reloptions` e a definição da view), constraint (`pg_get_constraintdef`, validada, deferrable), índice único, parcial ou de exclusão (`pg_get_indexdef`, válido, pronto), rule fora de view (`pg_get_ruledef` e `ev_enabled`), esquema (dono e ACL), `ALTER DEFAULT PRIVILEGES`, papéis `app_user` e `app_migrator` (`rolsuper`, `rolbypassrls`, `rolcreaterole`, `rolcreatedb`, `rolreplication`, `rolinherit`, `rolcanlogin` e `ALTER ROLE ... SET`) e os vínculos de `pg_auth_members` em que eles são membros (com admin/inherit/set; o vínculo do master fica de fora porque o nome dele muda entre a referência e o RDS, e `GRANT ROLE` já alerta); no fim, uma linha `contagem` por tipo (R10 do #58). Objetos de extensão ficam de fora. O job `guardas-banco` do `infra.yml` roda `verificar-guardas.sh autoteste` a cada PR de infra ou de migração: gera a referência duas vezes (prova determinismo), aplica 15 adulterações (`CREATE OR REPLACE FUNCTION`, `ALTER FUNCTION`, `ALTER POLICY`, `NO FORCE RLS`, `DROP CONSTRAINT`, `DROP NOT NULL`, `DROP INDEX` do índice único parcial, `CREATE RULE ... DO INSTEAD NOTHING`, `ENABLE REPLICA TRIGGER`, `ENABLE ALWAYS TRIGGER`, `GRANT DELETE` na tabela, `GRANT UPDATE` em coluna, `ALTER DEFAULT PRIVILEGES` e, como master, `ALTER ROLE app_user CREATEDB` e `GRANT app_migrator TO app_user`) e exige que cada uma apareça no `diff`, inclusive os objetos removidos e as contagens. Possível falso positivo no 1º uso no RDS: a ACL do esquema `public` (o RDS pode diferir do Postgres puro); se aparecer, o Guardião confirma e a referência ganha o ajuste no bootstrap.

Bootstrap (`infra/rds/bootstrap.sql`): roda `CREATE EXTENSION IF NOT EXISTS pgaudit;` (falha se a biblioteca ainda não estiver carregada; nesse caso, reiniciar a instância na janela e repetir). A classe `role` grava o texto do comando, então o `ALTER ROLE ... PASSWORD` levaria a senha ao log: o bootstrap faz `SET LOCAL pgaudit.log = 'none'` só na transação das senhas e volta ao padrão logo depois. Se o master não puder fazer esse `SET`, o bootstrap para antes de qualquer senha (falha fechada). No fim, confere que `pgaudit.log` tem `ddl` e `role` e nada de `read`/`write`/`all`.

**Limite:** `SET session_replication_role = replica` puro é da classe `misc`, que fica fora (registraria todo `SET` da aplicação); as outras formas (`ALTER ROLE/DATABASE ... SET`, `GRANT SET ON PARAMETER`, `set_config` em função) passam pelo filtro `session-replication-role` (R10). Só o master (`rds_superuser`) consegue usá-lo, e humano só lê a senha do master pelo break-glass, que dispara alerta (R4 do #58). O `app_user` não é dono de tabela e não faz nada disso.

Todos os grupos de log são declarados no Terraform **antes** do recurso que escreve neles, com retenção (`logs_retencao_dias` ou, para app e WAF, `logs_acesso_retencao_dias`) e a chave KMS `logs`: `/aws/rds/instance/*/postgresql` e `/upgrade`, `RDSOSMetrics`, Container Insights, app, Redis (se o slow-log for ligado), WAF e flow logs. O `infra.yml` falha se houver export do RDS sem grupo declarado, ou sem `log_error_verbosity`/`log_min_error_statement`. O WAF também redige a query string (R1).

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
| KMS | 11 chaves fixas (inclui exportacoes, CloudTrail, alertas e backup) + KEKs das clínicas de teste (US$ 1 cada) | 12–16 |
| Secrets Manager, S3, ECR, DynamoDB | 4 segredos, volume de teste | 4–10 |
| AWS Backup | 1 ponto de recuperação mensal do RDS (20 GB) guardado 35 dias | 1–4 |
| CloudWatch | Logs (app, RDS, Redis, WAF, flow logs ALL) e Container Insights | 15–40 |
| CloudTrail | 1ª trilha de gerenciamento grátis; data events de S3 a ~US$ 0,10 por 100 mil; bucket da trilha | 2–10 |
| **Total staging** | | **~290–395** |

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
3. **Variáveis:** criar `staging.tfvars`, também fora do git, com `conta_aws_id`, `certificado_arn` e `api_imagem_tag` (SHA de 40 caracteres). Para a âncora em conta separada, adicionar `conta_auditoria_id` e `papel_auditoria_arn`. Quando houver o responsável, `alerta_seguranca_email` (assinatura do alerta de break-glass e dos alarmes de jobs) e `alerta_dpo_email` (encarregado: falha de retenção/revogação dos jobs, §4.4).
4. **Plano:** `terraform init -backend-config=backend.hcl`, depois `terraform plan -var-file=staging.tfvars -out=plano`.
   - Revisar o plano com um sócio, olhando com atenção a criação de `aws_s3_bucket_object_lock_configuration` (COMPLIANCE não se desfaz).
   - Conferir que nada sai de sa-east-1.
5. **Apply:** `terraform apply plano`.
6. **Banco:** rodar `infra/rds/bootstrap.sh` de dentro da VPC (tarefa ECS avulsa ou SSM), lendo as senhas dos segredos `banco-app-*` e a do master pelo output `rds_segredo_master`. Humano não decifra a chave `segredos` (R4): o bootstrap roda com papel de máquina ou, se for manual, pelo `break-glass`, que gera alerta. Antes, confirmar que a instância já reiniciou com o parameter group (o `pgaudit` em `shared_preload_libraries` só vale após reboot); o bootstrap roda `CREATE EXTENSION IF NOT EXISTS pgaudit;` e para se a biblioteca não estiver carregada.
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
- **Prod:** raiz própria em outra conta, com RDS e Redis maiores, Object Lock **curto** nos documentos (GOVERNANCE, ou COMPLIANCE de até 35 dias; nunca o prazo do prontuário, V1) e endpoints em 3 AZs. Valores de prod das variáveis de retenção, backup e TLS na §4.2.

### 4.1 Ressalvas do parecer do #58

Rodada 13.3 (14/10/2026): resolvido no Terraform tudo o que não depende de decisão dos sócios nem de código da ENG. O `infra.yml` tem uma trava para cada item marcado com ✔︎ CI.

| # | Situação | O que foi feito / o que falta | Prazo do que falta |
|---|---|---|---|
| R2 | **Resolvido** ✔︎ CI | Bucket `logs`: Deny de `GetObject`, `GetObjectVersion`, `GetObjectAttributes` e `RestoreObject` para todos, exceto o papel `investigacao-seguranca` (humano com MFA de até 1 h, sessão de 1 h, só sa-east-1). Uso do papel gera alerta. Prazo em `logs_bucket_retencao_dias`: 90 em staging; prod na §4.2 (D7) | Valor de prod com a D7 |
| R4 | **Resolvido no Terraform** ✔︎ CI; KEKs dependem da ENG | Deny de `kms:Decrypt` e `kms:ReEncrypt*` para humanos (papéis do SSO, usuários IAM, root e `papeis_humanos_extra`) nas chaves `rds`, `s3`, `exportacoes`, `segredos` e `backup`. Papel `break-glass` (MFA, 1 h, só sa-east-1) decifra essas chaves e as KEKs; todo uso dele (e da investigação) dispara regra do EventBridge para o tópico SNS `alertas-seguranca`, cifrado. Efeito colateral aceito: humano não vê Performance Insights nem lê segredo sem o break-glass. **Falta:** (a) o `KmsKeyProvider` incluir o statement do output `kms_deny_humanos` na key policy de cada KEK (ENG); (b) os permission sets do SSO com MFA e sessão curta (I1); (c) assinar o tópico (`alerta_seguranca_email`) | (a) antes de dado real; (b) com o I1; (c) antes do 1º apply |
| R5 | **Resolvido** ✔︎ CI | Slow-log do Redis desligado por padrão (`redis_slow_log = false`); o grupo de log nem é criado. Só ligar depois da regra da ENG "payload de fila e chave do Redis só com ids opacos" | — (ligar exige a regra da ENG) |
| R6 | **Parametrizado; depende da ENG** | `tls_ate_a_tarefa` troca target group e health check para HTTPS e passa `API_TLS=autoassinado` à tarefa (o ALB não valida o certificado do alvo). Falta a API escutar HTTPS com certificado autoassinado gerado na subida. Proposta: `true` em prod; a alternativa é o risco aceito pelos sócios | Antes de prod |
| R7 | **Resolvido** ✔︎ CI | `backup.tf`: plano mensal do RDS, cofre em sa-east-1 com chave `backup`, **sem `copy_action`** (o CI falha se aparecer), vault lock GOVERNANCE em staging e COMPLIANCE em prod (`backup_vault_lock_compliance`), prazo `backup_mensal_retencao_dias` (35 em staging, 365 em prod pela G3). O *crypto-shredding* cobre o backup: a KEK fica no KMS, fora de qualquer ponto de recuperação, e sem ela os campos cifrados por clínica ficam ilegíveis em todos os backups; o resto expira com o prazo | — |
| R9 | **Parametrizado; valor de prod pendente da D7** | Variáveis separadas: `logs_acesso_retencao_dias` (API, WAF), `logs_retencao_dias` (técnicos) e `logs_bucket_retencao_dias` (ALB e acesso a buckets), com validação. Propostas na §4.2 | Com a D7, antes de prod |
| N1 | **Resolvido no bucket** ✔︎ CI | Política do bucket `exportacoes` nega `PutObject` cuja chave não seja `????????-????-????-????-????????????` na raiz. Contrato com a API na §4.3 | Teste da rota de exportação (ENG) |
| N2 | **Resolvido** ✔︎ CI | Seletor do CloudTrail com as **leituras** (`readOnly = true`) do bucket `logs`. As gravações (entrega do ALB e do S3) ficam de fora, porque só gerariam volume | — |
| R10 | **Resolvido no código** ✔︎ CI; autoteste roda no job `guardas-banco` | Alarme: filtros de constraint, `NOT NULL`, índice, rule, `ENABLE REPLICA/ALWAYS`, `GRANT/REVOKE/GRANT ROLE/ALTER DEFAULT PRIVILEGES` e `session_replication_role` (regex agrupadas para caber na cota de 5). Conferência: constraint, índice único/parcial, rule, ACL de tabela e coluna, esquema, privilégios padrão e contagem por tipo; autoteste com um caso de cada. Observações da conferência de 22/10/2026: (O1) o alarme passou a cobrir `CREATE TRIGGER` e `REVOKE ROLE` (termos exatos) e `DROP ... CASCADE` e `DETACH PARTITION` (dentro das regex existentes, que seguem 4 de 5); (O2) a conferência tira impressão dos atributos de `app_user`/`app_migrator` e dos vínculos de `pg_auth_members`, com 2 casos novos no autoteste; (O3) limite na linha abaixo | Conferir no 1º deploy do staging (antes do piloto) |
| R10-O3 | **Limite aceito**; a conferência cobre | Comentário SQL no meio do comando escapa das regex do alarme: `ALTER TABLE t DISABLE/**/TRIGGER x` ou `DISABLE /* nada */ TRIGGER` não casa com `DISABLE\s+TRIGGER`, e um `--` seguido de quebra de linha também separa as palavras. O pgaudit grava o texto como foi enviado, e o filtro do CloudWatch não aceita parênteses, então não dá para escrever "espaço OU comentário" entre as palavras. Mitigação avaliada e **não** aplicada: trocar `\s+` por `[\s/*]+` pegaria só o comentário vazio (`/**/`, `/* */`); qualquer texto dentro do comentário volta a escapar, e o ganho não paga a falsa sensação de cobertura. Os filtros de termo exato (etiqueta de comando do pgaudit, como `,DROP TRIGGER,` e `,CREATE FUNCTION,`) não sofrem com isso, porque a etiqueta vem do parser, não do texto. O que fecha o buraco é a conferência pós-deploy: ela compara o catálogo (`tgenabled`, `relrowsecurity`, `relforcerowsecurity`, `ev_enabled`), não o texto do comando, e o runbook manda rodá-la a cada alarme e a cada deploy. Mesmo limite já aceito na R12 do #61 | Reavaliar se o CloudWatch passar a aceitar grupos; conferência no 1º deploy |
| ENG | Aberto | Cifrar documentos com a DEK da clínica; apagar a exportação quando o link vence; job que publica a âncora; job gestor de chaves; `kms_deny_humanos` nas KEKs (R4); HTTPS na API (R6) | Antes de dado real (R6: antes de prod) |

### 4.2 Valores propostos para prod (dependem da D7)

| Variável | Staging | Prod (proposta) | Base |
|---|---|---|---|
| `logs_acesso_retencao_dias` (API, WAF) | 30 | 365 | Marco Civil art. 15 (mínimo 180) e [matriz-retencao](../03-seguranca-lgpd/matriz-retencao.md) |
| `logs_bucket_retencao_dias` (ALB, acesso a buckets) | 90 | 365 | Idem |
| `logs_retencao_dias` (flow logs, Redis, RDS, métricas) | 30 | 90 | Log técnico, sem dado pessoal |
| `trilha_retencao_dias` (CloudTrail) | 365 | 365 ou o prazo da D7 | Mínimo 180 por validação |
| `backup_mensal_retencao_dias` | 35 | 365 | G3 ("backups mensais imutáveis até 12 meses") |
| `backup_vault_lock_compliance` | false | true | Imutável de fato em prod |
| `tls_ate_a_tarefa` | false | true | R6, depois da ENG |
| `redis_slow_log` | false | false (true só com ids opacos) | R5 |

### 4.3 Contrato com a API: objeto de exportação (N1)

- **Chave do objeto:** só um UUID v4 em minúsculas, na raiz do bucket (ex.: `3f2b8c1e-9a4d-4c7e-8b1a-2d6f0e5c9a71`). Nada de prefixo, extensão, nome da clínica, CNPJ ou nome de pessoa, porque a chave aparece nos logs de acesso do bucket. O bucket recusa outro formato.
- **Nome que o usuário vê ao baixar:** genérico (ex.: `exportacao.zip`), nunca com nome de clínica ou pessoa. Se a API usar `response-content-disposition` no link pré-assinado, o valor também vai para o log de acesso, porque faz parte da URL.
- **Metadados do objeto:** nenhum `x-amz-meta-*` com dado pessoal.
- **Vida do objeto:** a API apaga o objeto quando o link de 24 h vence; o lifecycle (`exportacao_expiracao_dias`) é a rede de segurança.
- **Rotação automática de segredos** (Lambda, I4) e **orçamento com alerta** (AWS Budgets), que fica para quando houver o e-mail do responsável.

### 4.4 Contrato com a API: agendador de jobs (PR #73, parecer `2026-10-23-jobs.md`, R3)
A API passou a ter um agendador real (BullMQ) para os jobs de retenção, revogação e lembretes (api-dominio §14). O IaC precisa, **antes do piloto**:
- **Exigir `REDIS_URL`** (TLS + AUTH, o mesmo Redis do rate limit) em toda tarefa da API fora de dev/test. Sem ele a API sobe **sem jobs** e loga `JOBS_DESLIGADOS` — o deploy deve falhar antes disso.
- **Filtros de métrica e alarmes** no log group da API para todos os marcadores de falha dos jobs (tabela abaixo), com aviso ao canal de operação e, nos que indicam falha de retenção ou revogação, ao encarregado (DPO); e alarme de `jobs` ≠ `bullmq` no `/health/ready` por mais de 15 min. Os logs não levam dado pessoal (só nome do job, código de erro e contagens).
- **Não** definir `JOBS_HABILITADOS=false` em staging/produção, salvo incidente registrado.

**Estado no Terraform (staging), R3 completa no código (rodada 21):** `REDIS_URL` vem do segredo `redis` e a task definition da API tem precondições (REDIS_URL presente, Redis com TLS, nenhum `JOBS_HABILITADOS`) que fazem o plano falhar (`app.tf`). O CI (`infra.yml`, Travas do projeto) confere tudo o que está abaixo.

**Alarmes por marcador de log (`jobs.tf`).** Nomes conferidos em `apps/api/src/modules/jobs/` (branch `eng/integracao-r19`). Um filtro de **termo exato** por marcador no log group da API (sem regex, então a cota de 5 regex do log group segue intacta: hoje 0 nesse grupo). Todo alarme vai para `alertas-seguranca` (operação, o único tópico de operação hoje); a severidade está no nome do alarme (`plataforma-saude-staging-<severidade>-<marcador>`), no início da descrição e na tag `severidade`.

| Marcador | Severidade | Dispara com | DPO |
|---|---|---|---|
| `JOBS_DESLIGADOS` (exclui `JOBS_DESLIGADOS_POR_OPCAO`) | crítica | ≥ 1 em 5 min | **sim**: nenhum job de retenção roda e, nesse modo, nem o sinal de vida |
| `JOBS_NAO_AGENDADOS` | crítica | ≥ 1 em 5 min | não (se nenhuma instância agenda, o `JOB_ATRASADO` dos jobs de retenção chega ao DPO) |
| `JOB_ATRASADO` | alta | ≥ 1 em 5 min | só os jobs de retenção/revogação (abaixo) |
| `JOB_ALARME` | alta | ≥ 1 em 5 min | só os jobs de retenção/revogação (abaixo) |
| `JOB_CLINICA_FALHOU` | alta | ≥ 1 em 5 min | não: o job não marca sucesso, e a falha persistente vira `JOB_ATRASADO` |
| `JOB_TRILHA_FALHOU` | alta | ≥ 1 em 5 min | não |
| `JOBS_DESLIGADOS_POR_OPCAO` | média | ≥ 1 em 5 min | não (o IaC proíbe `JOBS_HABILITADOS`; aparecer é incidente) |
| `JOB_TRABALHADOR_ERRO` | média | ≥ 3 em 15 min | não |
| `JOB_FALHOU` (cada tentativa no BullMQ) | média | ≥ 3 em 15 min | não |
| `JOB_DESCONHECIDO` | baixa | ≥ 1 em 1 h | não |

Sem alarme (informativos): `JOB_OK`, `JOB_EM_ANDAMENTO`, `JOB_REMOVIDO` e `JOB_TRAVA_NAO_LIBERADA`.

**DPO (`alertas-dpo`, assinatura por `alerta_dpo_email`).** Recebe só falha de retenção ou revogação: o alarme `jobs-desligados` e o alarme `alta-jobs-retencao-dpo`. Este último soma 12 filtros `"<marcador>" "job=<nome>"` (dois termos exatos = E lógico) para `JOB_ATRASADO` e `JOB_ALARME` × `whatsapp-retencao`, `importador-expurgo`, `notas-privadas-ciclo`, `retencao-fiscal`, `responsaveis-descarte` e `portal-representacoes` (lista `jobs_de_retencao`; job novo de retenção entra lá). `JOB_ATRASADO` de `whatsapp-lembretes` fica só com a operação.

**`jobs` ≠ `bullmq` no `/health/ready` (`jobs-ready.tf`).** Opção escolhida: **canary do CloudWatch Synthetics em sa-east-1**, a mais simples que funciona sem mudar a API nem sair da região:
- *Métrica a partir de log* não serve: a API não loga o modo; `nao_iniciado` (o `agendar()` do BullMQ pendurado) não gera log nenhum. Exigiria uma linha periódica na API (ENG).
- *Health check do ALB* só olha o status HTTP, não o corpo.
- *Health check do Route53* (`HTTPS_STR_MATCH`) lê o corpo, mas a métrica só existe em us-east-1: alarme e tópico SNS ficariam fora de sa-east-1 (trava de região).

O canary `jobs-ready-stg` lê `https://<DNS do ALB>/health/ready` a cada 5 min (Node, `canary/index.js`, empacotado em `canary/jobs-ready.zip`; o CI compara os dois) e falha se `jobs` não for `bullmq` (vale para 200 e 503; a mensagem de erro é só o rótulo, `jobs=<modo>`). Alarme `alta-jobs-nao-bullmq` em `SuccessPercent`: **3 leituras com falha em 6** (tudo fora = alarme em 15 min; com várias tarefas, uma presa derruba parte das leituras e o "3 em 6" pega). Canary parado conta como falha (`treat_missing_data = breaching`). Só operação. Artefatos no prefixo `synthetics/` do bucket `logs` (SSE-S3, lifecycle do bucket). O papel do canary não tem permissão de CloudWatch Logs, de propósito, para não nascer um grupo `/aws/lambda/cwsyn-*` sem retenção nem KMS; o log de cada execução vai para o S3.

**Limites e pendências:**
- **Nada disto foi validado com Terraform** (a máquina desta rodada não tem `terraform`): sem `fmt`, `validate`, `tflint` nem `checkov` locais. Rodaram só as travas de grep do CI (localmente) e um teste do script do canary com `https` simulado (`bullmq` passa; `nao_iniciado`, rótulo desconhecido e corpo inválido falham). O `infra.yml` roda o resto no PR.
- **Runtime do canary** (`canary_runtime`, padrão `syn-nodejs-puppeteer-10.0`): conferir na AWS se segue suportado antes do apply.
- **TLS do canary:** sem domínio (I10), a URL usa o DNS do ALB e o script não valida o certificado (`rejectUnauthorized: false`; o corpo só tem rótulos fixos). Com o domínio, trocar `URL_READY` para ele e tirar a opção.
- **Uma tarefa presa entre muitas** pode não fechar 3 em 6; se os jobs pararem de fato, o `JOB_ATRASADO` cobre.
- **Sintaxe de exclusão** (`"JOBS_DESLIGADOS" -"JOBS_DESLIGADOS_POR_OPCAO"`): conferir no 1º deploy com `aws logs test-metric-filter` contra as duas linhas reais; idem os filtros `"JOB_ATRASADO" "job=<nome>"`.
- Conferência do Guardião antes do piloto (api-dominio §14: até lá, os marcadores não acordam ninguém com dado real).
