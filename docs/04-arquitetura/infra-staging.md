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

**KEK por clínica e chave de lote do importador no KMS (item 22 do #35; R3/R3-b do parecer do importador, rodada 22).** As chaves nascem em tempo de execução pelo `KmsKeyProvider`, com as tags **na criação**: a da clínica com `tenant_id` + `purpose=tenant_data`; a de cada lote do importador com `tenant_id` + `purpose=import_batch` + `batch_id` (vive ≤ 7 dias; [api-dominio.md §12d](api-dominio.md)). O Terraform (`kms-clinicas.tf`) cria as permissões, separadas por papel (ABAC pelas tags):

| Papel | Pode | Não pode |
|---|---|---|
| `gestor-chaves` (onboarding e eliminação da clínica, G3) | `CreateKey` só simétrica, `ENCRYPT_DECRYPT`, origem AWS_KMS, **nunca multirregião**, com `tenant_id` e `purpose=tenant_data`; ligar rotação; `ScheduleKeyDeletion` com janela ≥ `kek_janela_exclusao_dias` (7), cancelar destruição e `ReEncrypt` (rotação por suspeita), **só em `purpose=tenant_data`**; alias só em `alias/<nome>/clinica/*` | Gerar ou abrir DEK; criar chave de lote; `CancelKeyDeletion`/`EnableKey` em `purpose=import_batch` (Deny); `UntagResource` e `TagResource` em chave existente (Deny); tocar nas chaves de infraestrutura (Deny explícito, para ninguém "adotar" uma chave de infra colocando a tag) |
| API (papel da tarefa) | `CreateKey` com as mesmas condições de material, em dois statements: `purpose=tenant_data` (tags só `tenant_id`, `purpose`) ou `purpose=import_batch` com `batch_id` (tags só `tenant_id`, `purpose`, `batch_id`); `TagResource` só na criação, com `aws:RequestTag/purpose` ∈ {`tenant_data`, `import_batch`} e `tenant_id`; `GenerateDataKey`, `Decrypt`, `ReEncryptFrom`/`ReEncryptTo` só em chave com `tenant_id` e com `kms:EncryptionContext:tenant_id` **igual** a `aws:ResourceTag/tenant_id` (único campo do contexto); `DescribeKey` em chave com `tenant_id`; `EnableKeyRotation` só em `purpose=tenant_data`; `ScheduleKeyDeletion` **só** em `purpose=import_batch`, janela ≥ 7 | Excluir, cancelar exclusão ou desabilitar chave que não seja de lote (Deny com `StringNotEquals`, que também pega chave sem `purpose`); `CancelKeyDeletion`/`EnableKey` em `purpose=import_batch` (Deny); `UntagResource` (Deny); `TagResource` em chave que já tem `tenant_id` (Deny); gerir chaves de infraestrutura (Deny) |

A exclusão da chave da clínica continua no fluxo de eliminação (G3, `FieldCipher.destroyTenantKeys`), que **não é chamado por nenhum caminho da API hoje**: quando for ligado, roda com o papel `gestor-chaves`, já restrito a `purpose=tenant_data` (a definir com o Guardião). Toda chamada de `CancelKeyDeletion` ou `EnableKey` na conta dispara a regra `kms-cancelar-exclusao` do EventBridge para o tópico `alertas-seguranca` (o EventBridge não filtra por tag; a tag se confere pelo ARN do evento). A trava "R3-b" do `infra.yml` confere cada statement acima (purpose, `tenant_id`, `TagKeys`, contexto igual à tag, Deny de cancelar/destagear, alerta).

**Não validado nesta rodada** (sem terraform/AWS na máquina): `terraform fmt`/`validate`, tflint e checkov (rodam no CI); a variável de política `${aws:ResourceTag/tenant_id}` como valor de condição do contexto e o `TagResource` implícito do `CreateKey` com tags só se provam num apply em staging, com uma chamada de cada tipo e uma chamada negada de cada Deny. **Lacunas conhecidas:** o Deny de `CancelKeyDeletion`/`EnableKey` em chave de lote vale para os papéis da API e do gestor; "qualquer principal da conta salvo o break-glass" pediria key policy na criação (a chave nasce com a política padrão) ou SCP (sem Organizations hoje) — fica com o R4(a) (`kms_deny_humanos` na key policy). Chaves de clínica criadas antes do R3-b (sem `purpose`) perderiam rotação e eliminação pelo gestor; em staging ainda não há nenhuma.

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
| KMS | 12 chaves fixas (inclui exportacoes, CloudTrail, alertas, backup e a HMAC do pseudônimo do suporte) + KEKs das clínicas de teste (US$ 1 cada) | 12–16 |
| Secrets Manager, S3, ECR, DynamoDB | 6 segredos (7 com WhatsApp), volume de teste | 4–10 |
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
- **Chaves HMAC da API** (`PAGINATION_CURSOR_KEY`, `RATE_LIMIT_HASH_KEY`): procedimento e efeitos na §4.5.
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
- **TLS do canary:** o script valida o certificado por padrão e só deixa de validar com `VALIDAR_CERTIFICADO = "false"`. Sem domínio (I10), a URL usa o DNS do ALB, e o staging liga essa exceção em `jobs-ready.tf`, com o comentário "remover quando houver domínio" (o corpo só tem rótulos fixos). Com o domínio, trocar `URL_READY` para ele e apagar a linha da exceção. O job `tls` do `infra.yml` roda em todo PR e reprova a validação de certificado desligada (`rejectUnauthorized` falso, `NODE_TLS_REJECT_UNAUTHORIZED`, `VALIDAR_CERTIFICADO` falso, `sslmode=no-verify`, `checkServerIdentity`, `--insecure` etc.) em qualquer arquivo fora de `infra/terraform/staging/` e de `docs/`. Também reprova `.tf` fora do staging com canary no DNS do ALB. Limite: o grep pega a forma literal, e desligar por variável indireta passa (fica para a revisão humana).
- **Uma tarefa presa entre muitas** pode não fechar 3 em 6; se os jobs pararem de fato, o `JOB_ATRASADO` cobre.
- **Sintaxe de exclusão** (`"JOBS_DESLIGADOS" -"JOBS_DESLIGADOS_POR_OPCAO"`): conferir no 1º deploy com `aws logs test-metric-filter` contra as duas linhas reais; idem os filtros `"JOB_ATRASADO" "job=<nome>"`.
- Conferência do Guardião antes do piloto (api-dominio §14: até lá, os marcadores não acordam ninguém com dado real).

**Checklist antes do piloto** (condições da conferência da rodada 21, `revisoes/2026-10-23-jobs.md`; anexar a evidência de cada item ao PR do deploy):
- [ ] **Terraform validado no CI:** `infra.yml` verde no PR, com `terraform fmt -check`, `validate`, `tflint` e `checkov` rodando de fato (não pulados pelo filtro `mudancas`) e com o job `tls` verde.
- [ ] **`aws logs test-metric-filter` com linhas reais de cada marcador:** uma linha real (do log group da API em staging) para cada um dos 10 marcadores da tabela acima. Provar em especial que `JOBS_DESLIGADOS` casa e `JOBS_DESLIGADOS_POR_OPCAO` não casa no filtro `jobs-desligados` (exclusão `-"…"`), e que `"JOB_ATRASADO" "job=<nome>"` casa para cada job de retenção e não casa para `whatsapp-lembretes` (E de dois termos). Anexar a saída.
- [ ] **Disparo de teste aos tópicos de operação e do DPO:** `aws cloudwatch set-alarm-state` num alarme que avisa `alertas-seguranca` e no `alta-jobs-retencao-dpo` (`alertas-dpo`), com o e-mail recebido pelos dois e a assinatura do DPO confirmada. Devolver os alarmes a `OK` em seguida.
- [ ] **Remoção da exceção de TLS quando houver domínio (I10):** trocar `URL_READY` para o domínio e apagar `VALIDAR_CERTIFICADO = "false"` de `jobs-ready.tf` antes de qualquer dado real em staging. O canary passa a validar o certificado pelo padrão do script.
- [ ] Conferir na AWS que `canary_runtime` (`syn-nodejs-puppeteer-10.0`) segue suportado.

### 4.5 Contrato com a API: variáveis de ambiente da tarefa (C1 da conferência do cursor, `revisoes/2026-10-25-pr76.md`)

A tarefa roda com `NODE_ENV=production`. Antes desta rodada, `api_segredos` só tinha `DATABASE_URL` e `REDIS_URL`, e a API recusava subir por falta de `PAGINATION_CURSOR_KEY` e de `RATE_LIMIT_HASH_KEY` (esta última obrigatória desde o #30). O levantamento abaixo foi feito com grep de `process.env` e das validações de boot em `apps/api/src` (branch `eng/integracao-r19`, 25/10/2026).

**Como está no código** (`app.tf`, `dados.tf`, `api-ambiente.tf`):
- `local.api_segredos_origem` liga cada segredo ao seu segredo do Secrets Manager e ao campo JSON dele. Essa mesma lista gera os `secrets` da task definition e a política `SegredosDaApi` da role de execução (`GetSecretValue` só nesses ARNs, nunca no `banco-app-migrator`).
- Precondições da task definition fazem o **plano falhar** quando: falta um segredo obrigatório ou ele aparece em `environment` (texto claro); o cursor e o rate limit usam o mesmo segredo; falta uma variável obrigatória de `environment`; aparece uma variável proibida; ou `cloud_api` está ligado sem R17, WABA e as três credenciais.
- `infra.yml` (Travas do projeto) confere a lista, a origem de cada segredo, as precondições, os padrões seguros e a ausência de variáveis proibidas.

| Variável | Tipo | Origem | Valor em staging | Rotação |
|---|---|---|---|---|
| `DATABASE_URL` | segredo | `banco-app-user` (campo `url`), senha efêmera write-only | `postgres://app_user:…?sslmode=verify-full` | `banco_senhas_versao` + bootstrap (§3) |
| `REDIS_URL` | segredo | `redis` (campo `url`), token efêmero write-only | `rediss://:…` | `redis_auth_versao` + deploy forçado (§3) |
| `PAGINATION_CURSOR_KEY` | segredo | `pagination-cursor-key` (campo `chave`): `ephemeral "random_password"`, 64 alfanuméricos, write-only, KMS `segredos` | gerado | `pagination_cursor_key_versao`: por calendário (mesmo ciclo dos outros segredos de app) e na hora, em caso de suspeita. Procedimento abaixo |
| `RATE_LIMIT_HASH_KEY` | segredo | `rate-limit-hash-key` (campo `chave`): igual ao anterior, **segredo distinto** | gerado | `rate_limit_hash_key_versao`: mesmo ciclo. Os contadores da janela recomeçam (o limite fica frouxo por no máximo uma janela) |
| `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET` (base64), `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | segredo | `whatsapp`, **só com `whatsapp_provedor = "cloud_api"`**. Nasce vazio; preencher com `put-secret-value` fora do git (comentário em `api-ambiente.tf`) | ausentes (WhatsApp desligado) | Gerar no painel da Meta, regravar o segredo e forçar o deploy |
| `NODE_ENV` | ambiente | fixo | `production` | — |
| `API_PORT` | ambiente | `local.api_porta` | `3333` | — |
| `NODE_EXTRA_CA_CERTS` | ambiente | fixo (CA do RDS na imagem) | `/app/certs/rds-sa-east-1-bundle.pem` | junto com a CA da AWS |
| `HTTP_TRUST_PROXY_HOPS` | ambiente | fixo | `1` (ALB). Com `0`, todo cliente seria contado como o IP do ALB no rate limit | — |
| `IMPORTADOR_HABILITADO` | ambiente | `var.importador_habilitado` | `false` | — |
| `WHATSAPP_PROVEDOR` | ambiente | `var.whatsapp_provedor` (`desligado` ou `cloud_api`; `falso` é recusado) | `desligado` | — |
| `WHATSAPP_R17_CLAUSULAS_PADRAO` | ambiente | `var.whatsapp_clausulas_padrao_assinadas`, só com `cloud_api` | ausente | — |
| `WHATSAPP_WABA_ID` | ambiente | `var.whatsapp_waba_id`, só com `cloud_api` | ausente | — |
| `SUPPORT_PSEUDONYM_KMS_KEY_ID` | ambiente (é ARN, não segredo) | `aws_kms_key.pseudonimo_suporte` (HMAC_256). A role da tarefa só tem `kms:GenerateMac`, e há Deny de `GenerateMac`/`VerifyMac` para humanos | ARN da chave | O KMS não rotaciona chave HMAC automaticamente, e trocar a chave muda todos os pseudônimos. Troca só por suspeita, com o Guardião |
| `AWS_REGION` | ambiente (obrigatória, K-b) | `local.regiao`; precondição exige `sa-east-1` | `sa-east-1` | — |
| Credencial AWS | só a role da tarefa (`api_tarefa`), pela `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` que o ECS injeta | — | — | a do STS, automática |
| `CORS_ALLOWED_ORIGINS` | ambiente | `var.cors_origens` (só https, sem curinga) | ausente = nenhuma origem cruzada | — |
| `API_TLS` | ambiente | `var.tls_ate_a_tarefa` (R6) | ausente | — |
| `EXIT_WINDOW_DAYS`, `DB_*`, `RATE_LIMIT_MAX`/`_WINDOW_MS`, `HTTP_BODY_LIMIT`, `PATIENT_*`, `PORTAL_*`, `ATTENDANCE_*`, `SELF_SCHEDULED_ALERT_PER_DAY`, `IMPORT_RAW_TTL_HOURS`, `WHATSAPP_GRAPH_VERSAO` | ambiente | não definidas: valem os padrões do código (validados no boot) | padrão | — |

**Proibidas na tarefa da API** (precondição e CI): `DATABASE_ADMIN_URL` e `DATABASE_MIGRATOR_URL` (só a tarefa de migração/bootstrap), `SUPPORT_PSEUDONYM_KEY` e `FIELD_KEYS_DEV_ROOT_SECRET` (segredo local de dev), `RATE_LIMIT_ALLOW_SINGLE_INSTANCE` (rate limit por instância), `JOBS_HABILITADOS` (§4.4), a variável global do Node que desliga a validação de TLS, `AUTH_PROVIDER` e `PORTAL_AUTH_PROVIDER` (hoje só aceitam `dev`). **Credenciais e endpoints AWS (K-a/K-b, `local.api_variaveis_aws_proibidas`, precondição própria):** `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_PROFILE`, `AWS_CONTAINER_CREDENTIALS_FULL_URI`, `AWS_CONTAINER_AUTHORIZATION_TOKEN`, `AWS_WEB_IDENTITY_TOKEN_FILE`, `AWS_ROLE_ARN`, `AWS_SHARED_CREDENTIALS_FILE`, `AWS_CONFIG_FILE`, `AWS_EC2_METADATA_SERVICE_ENDPOINT`, `KMS_ENDPOINT` e qualquer nome que comece com `AWS_ENDPOINT_URL` (por `startswith`). Cada uma trocaria a role da tarefa por outra credencial ou desviaria o tráfego do KMS. Fica permitida só `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`, que o ECS injeta (é a própria role), e a trava do CI reprova se alguém a vetar. Ela também **nunca é declarada à mão** na task definition (K-a2): apontaria a cadeia do SDK para outro caminho. A trava do CI reprova qualquer `.tf` que a declare (`name = "..."` em `environment`/`secrets` ou chave de mapa). `AI_PROVIDER` não entra porque o `AiModule` não está no `AppModule`. Quando entrar, `fake` derruba o boot em produção.

**Rotação do `PAGINATION_CURSOR_KEY`:**
1. Incrementar `pagination_cursor_key_versao` no `staging.tfvars`, gerar o plano e aplicar com um sócio. Uma chave nova é gerada e gravada write-only no segredo `pagination-cursor-key`. O valor antigo não fica no estado.
2. Forçar um deploy novo do serviço (`aws ecs update-service --cluster <nome> --service api --force-new-deployment`). Cada tarefa lê o segredo só ao iniciar.
3. **Efeito esperado e aceito:** trocar a chave invalida todos os cursores em curso (validade de no máximo 10 min). O próximo pedido com cursor antigo recebe `409 cursor_invalido`, e **o front recomeça a lista do início**: descarta as páginas já juntadas e pede a página 1 de novo, depois de conferir a sessão (§3b de `api-dominio.md`, C2 do mesmo parecer). Durante o deploy, com tarefas velhas e novas juntas, um cursor emitido por uma tarefa pode cair na outra e também dar 409. Por isso não há chave dupla: o custo é só um recomeço da lista.
4. Os 409 contam no limite por usuário (vigilância). Um pico curto de `cursor_invalido` no log logo depois da rotação é esperado. Fora de uma rotação, é sinal para investigar.
5. Em caso de suspeita de vazamento da chave, rotacionar na hora, sem esperar o calendário. Um cursor forjado com a chave vazada fica preso à clínica e ao usuário que ele carrega e continua passando pelo RLS, mas a chave precisa sair de uso.

**Bloqueios do boot que o IaC NÃO resolve** (no `eng/integracao-r19`, commit `19bfbb4`, a API continua sem subir com `NODE_ENV=production` mesmo com todas as variáveis acima, por desenho de falha fechada):
- `createAuthProvider` e `createPortalAuthProvider`/`createPortalOtpSender`: não há provedor real de login nem de OTP do portal (D4);
- `API_TLS=autoassinado` (R6) não é lido pela API.
Resolvidos na rodada 27 da ENG: `createKeyProvider` (KEK por clínica com `@aws-sdk/client-kms`) e `createPseudonymSigner` (cliente KMS real). O nome conferido é `SUPPORT_PSEUDONYM_KMS_KEY_ID` com o **ARN completo** da chave HMAC, na região de `AWS_REGION` (`ator-suporte.ts` e §0 de `api-dominio.md`), que é exatamente o que o Terraform passa (`aws_kms_key.pseudonimo_suporte.arn`). Os itens que sobram são da ENG e dos sócios (D4). O Terraform já entrega as variáveis e as permissões, de modo que, quando o código estiver pronto, o deploy não trave por falta de ambiente.

**`kms:VerifyMac` no pseudônimo: não concedido (decisão a registrar com o Guardião).** A role da tarefa tem só `kms:GenerateMac` na chave HMAC (`api_pseudonimo`), e a key policy nega `GenerateMac`/`VerifyMac` a humanos. `KmsPseudonymSigner.verificarChave()` faz `GenerateMac` + `VerifyMac` numa sonda fixa, e por isso o boot **não** a chama. Proposta: **não dar `VerifyMac`**. Uma sonda de saúde só com `GenerateMac` numa mensagem fixa já prova o que importa (a chave existe, é HMAC, está na região, a role pode usar e o KMS responde). O `VerifyMac` do próprio MAC recém-gerado é tautológico e não acrescenta nada. Do lado do risco, dar `VerifyMac` à role quase não amplia o poder (quem tem `GenerateMac` já confirma palpites de pseudônimo), mas é uma ação a mais sem uso, contra o menor privilégio. Se a ENG quiser a sonda, o caminho é trocar `verificarChave()` para só `GenerateMac` (eventualmente comparando dois MACs da mesma sonda, que são deterministas) e chamá-la no readiness, não no boot (o boot segue sem chamada de rede). A trava do `infra.yml` reprova `VerifyMac` em `api_pseudonimo` até haver decisão registrada.

**K-c: `EncryptionContext` das chaves por clínica (conferido em `kms-clinicas.tf`):**
- **IAM da API (`DekDaClinica`): cumpre.** `GenerateDataKey`, `Decrypt`, `ReEncryptFrom` e `ReEncryptTo` só em chave com tag `tenant_id`, com `kms:EncryptionContext:tenant_id` igual a `&{aws:ResourceTag/tenant_id}` e `kms:EncryptionContextKeys` só `tenant_id`.
- **Faltava em dois Allow, corrigido nesta rodada:** o `ReEncryptFrom`/`ReEncryptTo` do gestor de chaves (`GerirKekDeClinica`) e o `Decrypt` do break-glass (`DecifrarKekDeClinica`) não exigiam o contexto. Agora ficam em statements próprios (`RecifrarDekDaClinica` e `DecifrarKekDeClinica`) com a mesma condição. Nenhum dos dois papéis é usado hoje (o gestor ainda não existe, e o break-glass é só para incidente), mas a regra passa a valer para todo Allow de uso de DEK. A trava do `infra.yml` confere os três e reprova arquivo com mais Allow de DEK do que condições de contexto.
- **K-c1 (conferência de 27/10):** o `DecifrarKekDeClinica` do break-glass ganhou também `ForAllValues:StringEquals` em `kms:EncryptionContextKeys` = `["tenant_id"]`, ficando igual à `DekDaClinica`. A trava do `infra.yml` reprova a ausência da condição ou outro valor.
- **Key policy das chaves por clínica: decisão do Guardião (K-c2, conferência de 27/10 em `revisoes/2026-10-25-pr76.md`).** As chaves nascem em execução (`KmsKeyProvider.createMasterKey`) e hoje o `CreateKey` vai **sem** `Policy`, então vale a key policy padrão (a conta com `kms:*`, delegando ao IAM): um principal com `kms:*` amplo no IAM usaria a chave sem contexto. Decisão: **opção (a)**. A API passa `Policy` no `CreateKey` com (i) o statement padrão da conta (administração pela conta/IAM; satisfaz a trava de lockout, e `BypassPolicyLockoutSafetyCheck` fica **proibido**) e (ii) um `Deny` para `"*"` em `kms:Encrypt`, `kms:Decrypt`, `kms:GenerateDataKey*` e `kms:ReEncrypt*` quando `kms:EncryptionContext:tenant_id` for diferente do tenant da chave (`StringNotEquals`) **ou estiver ausente** (statement com `Null` = `true`). O `tenant_id` vai **literal** na política (o provider já o conhece no `CreateKey`), não `${aws:ResourceTag/tenant_id}`: isso elimina as duas dúvidas antes levantadas aqui (propagação da tag logo após a criação e substituição de variável em key policy). A role da API não tem `PutKeyPolicy` e assim deve ficar, então a política é imutável para ela.
  - **SCP da organização (opção b): só como camada extra**, se a conta estiver numa AWS Organization (decisão dos sócios). Não substitui a K-c2.
  - **Escopo do bloqueio:** **não bloqueia staging** (só dado fictício, e o IAM já exige o contexto). **Bloqueia o piloto** (qualquer dado real de paciente) e, por consequência, produção. **Chaves criadas em staging antes da K-c2 não vão para o piloto**: a key policy de chave existente só muda por `PutKeyPolicy` de um humano, com trilha.
  - **Implementação na API: feita** no PR #73 (`cdf7152`), com teste de unidade do JSON da política.
  - **Pendente:** o teste de integração **K-c3** em staging (`Decrypt`/`GenerateDataKey` sem contexto, ou com outro `tenant_id`, falham mesmo para um principal com `kms:*` no IAM). Nada disso foi testado contra a AWS.
  - **Provas prontas para o 1º dia:** `infra/scripts/staging/prova-kc3.sh` (política gerada pelo próprio código da API, via `politica-kc3.mjs`) e `prova-kc5.sh` (disparo do `kms_administracao` lido por uma fila temporária). A ordem do dia, quem faz cada passo e onde a evidência é anexada estão no [runbook do primeiro dia do staging](runbook-primeiro-dia-staging.md).
  - **Alerta de administração da chave (K-c5, risco residual da K-c2):** como o statement da conta deixa um humano com `kms:PutKeyPolicy` remover o `Deny`, a regra `aws_cloudwatch_event_rule.kms_administracao` (`kms-clinicas.tf`, mesmo padrão da `kms_reativacao`) manda ao tópico `alertas_seguranca` toda chamada de `PutKeyPolicy`, `ScheduleKeyDeletion`, `DisableKey` e `CreateGrant` vinda do CloudTrail. A política do tópico (`acesso-humano.tf`) aceita a regra pelo `aws:SourceArn`.
    - **Por que em todas as chaves, e não só nas com tag `tenant_id`:** o evento do CloudTrail traz só o ARN/`keyId` da chave, sem as tags, e o padrão do EventBridge não consulta a tag do recurso. Não dá para filtrar por `tenant_id`/`purpose`; a triagem confere a tag pelo ARN do evento.
    - **Disparos esperados (registram, não são incidente por si):** `ScheduleKeyDeletion` do gestor na eliminação da clínica (G3, `destroyTenantKeys`); `ScheduleKeyDeletion` da API na chave de lote do importador (`purpose=import_batch`, ≤ 7 dias); `CreateGrant` de serviço AWS (`userIdentity.invokedBy`, ex.: RDS) em chave de infraestrutura. `PutKeyPolicy` e `DisableKey` não têm fluxo normal: todo disparo é tratado como incidente até prova contrária.
    - Trava: `infra.yml` (Travas do projeto) reprova a regra sem as 4 ações, alvo que não seja `alertas_seguranca` ou o tópico sem a regra no `aws:SourceArn`. Terraform não foi executado (não instalado no ambiente do agente); nada testado contra a AWS.

**`X-Forwarded-For` e o rate limit (C1-b, `revisoes/2026-10-25-pr76.md`):**
- `aws_lb.this` fixa `xff_header_processing_mode = "append"` (antes dependia do padrão da AWS) e mantém `drop_invalid_header_fields = true`. No modo `append`, o ALB **acrescenta ao fim** do `X-Forwarded-For` o IP de quem abriu a conexão TCP com ele. O que o cliente mandar no cabeçalho fica à esquerda.
- A API roda com `HTTP_TRUST_PROXY_HOPS=1` (`trust proxy = 1` no Express): `req.ip` é o endereço **mais à direita**, ou seja, o salto que o próprio ALB escreveu. É esse IP que entra no HMAC do rate limit (`RATE_LIMIT_HASH_KEY`). O cliente não consegue escolher o próprio IP, e o limite por IP vale.
- O SG da tarefa só aceita o SG do ALB (`api_do_alb`). Sem ALB no meio, ninguém fala com a API, então não existe um caminho que pule o salto 1.
- Por que não os outros modos: com `preserve`, o ALB repassa o cabeçalho do cliente sem acrescentar nada, e o salto 1 passa a ser o que o cliente escreveu (falsificável: cada requisição pode inventar um IP novo e fugir do limite). Com `remove`, o cabeçalho some, e todo mundo é contado como o IP do ALB (um cliente esgota o limite de todos). Se um dia entrar outro proxy na frente (CloudFront, por exemplo), `HTTP_TRUST_PROXY_HOPS` precisa subir junto, e esta seção deve ser revista com o Guardião.
- Trava: `infra.yml` (Travas do projeto) reprova `aws_lb.this` sem `append` ou sem `drop_invalid_header_fields = true`, e qualquer `.tf` com `preserve`/`remove`.

**Logs de acesso do ALB e o cursor (R7, C1-c):**
- Os logs de acesso do ALB estão **ligados** (`access_logs` em `aws_lb.this`, prefixo `alb/` no bucket `logs`, SSE-S3 (AES256: o ALB não entrega log em bucket com SSE-KMS), leitura só pela role `investigacao-seguranca`, leituras na trilha do CloudTrail). Cada linha traz IP do cliente, porta, user agent, status, horário e **a URL inteira com a query string**.
- Por isso o cursor que vai na query (`?cursor=...`) aparece no log. Com o cursor assinado do #73, ele carrega ids em claro (UUIDs da clínica, do usuário e do último item da página), e esses ids ficariam no bucket. A rodada 27 do backend **cifra** o cursor (v2: AES-256-GCM + HMAC, commit `1603ca1` no #73, aprovado pelo Guardião em 26/10, o que fecha a C1-c): a partir dela, o **cursor** no log é opaco e não expõe id nenhum. Isso vale **só para o cursor** (R7-a): as rotas REST levam o UUID do recurso no caminho (`GET /patients/:id`, `/cobrancas/:id`, `/importacoes/:id`...), e o log do ALB registra esses UUIDs em claro. É aceito por ser id técnico (pseudônimo, sem nome) e está declarado no ROPA. A regra é: nunca nome, CPF, telefone, e-mail, termo de busca ou conteúdo clínico na URL. O risco residual de quem tiver a chave e o log (V2-c) é tratado na linha do cursor no RIPD/ROPA, não aqui. Até esse código entrar em staging, o log contém os UUIDs. A busca não tem esse problema, porque o termo vai no corpo do POST, e o ALB não registra o corpo.
- **Retenção (alinhada ao ROPA da main):** expiração do objeto em `logs_bucket_retencao_dias`: **90 dias em staging**. Produção: **365 dias, com piso legal de 180** (Marco Civil, art. 15), **a confirmar na D7**. Versões antigas expiram em 7 dias.
- **ROPA:** a linha "Log de acesso do balanceador (ALB)" já está em `docs/03-seguranca-lgpd/bases-legais-e-consentimento.md` na main (Guardião, conferência de 27/10), com os UUIDs no caminho declarados, base legal art. 7º, II e IX, e art. 11, II, "a" e "g" quando o acesso se ligar a paciente, e a retenção acima. Esta seção não repete a linha; a fonte é o ROPA.

**Não validado nesta rodada** (a máquina não tem `terraform`): `fmt`, `validate`, `tflint` e `checkov` (rodam no `infra.yml` do PR). Pontos a conferir no CI ou no 1º plano: a unificação de tipos do `merge(..., cond ? {...} : {})` em `api_segredos_origem`; `one(aws_secretsmanager_secret.whatsapp[*].arn)` com `count = 0`; o skip `CKV_AWS_7` na chave HMAC; e se o ECS aceita referenciar um segredo **sem versão** (com `cloud_api`, a tarefa só inicia depois do `put-secret-value`). Rodaram localmente só as travas de grep do `infra.yml` (verdes). Rodada 27 (C1-b, K-a/K-b/K-c), também sem `terraform`: não conferi se o provider aceita `xff_header_processing_mode` na versão travada (o atributo existe no `aws_lb` desde o provider 4.x); o `one([...]) == "sa-east-1"` e o `startswith`/`anytrue` das novas precondições; e as condições `kms:EncryptionContext:*` com `&{aws:ResourceTag/tenant_id}` nos Allow do gestor e do break-glass (mesma forma da `DekDaClinica`, que também nunca rodou contra a AWS). O passo "Travas do projeto" inteiro rodou localmente com `bash -e` (como no CI): verde no código atual e vermelho em 13 casos negativos (XFF `preserve`/`remove`/ausente, `drop_invalid_header_fields = false`, `AWS_REGION` ausente ou fora da lista obrigatória, `AWS_ROLE_ARN`/`AWS_CONTAINER_CREDENTIALS_FULL_URI` fora da lista, `AWS_ACCESS_KEY_ID`/`AWS_ENDPOINT_URL_KMS` na tarefa, `VerifyMac` na role, contexto removido do gestor ou do break-glass). Conferência de 27/10 (R7-a, K-a2, K-c1), também sem `terraform`: o passo rodou com `bash -e`, verde no código atual e vermelho em 5 negativos novos (`AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` em `environment` e como chave de mapa; `DecifrarKekDeClinica` sem a condição de `EncryptionContextKeys`, com `ForAnyValue` e com valor extra).
