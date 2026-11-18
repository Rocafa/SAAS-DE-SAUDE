# Tarefa avulsa do ECS para a recuperação do FATOR do admin único pelo suporte (B12 do checklist do
# login real), no padrão da anonimização (ops-anonimizacao.tf, B10). Parecer do Guardião de
# 16/11/2026 (revisoes/2026-11-16-desenho-recuperacao-do-admin-unico.md), R4, R6 e R7:
#   - definição de tarefa, papel de execução e papel de tarefa PRÓPRIOS; só as credenciais de banco
#     (app_auth e app_user). Nada de BETTER_AUTH_SECRET (a emissão não precisa), Redis, chaves HMAC,
#     KMS de clínica ou WhatsApp;
#   - quem roda é provado pela AWS (principal do ecs:RunTask no CloudTrail): só o papel
#     ops-recuperacao-executor (humano nominal, MFA, SourceIdentity); quem lê a entrega é OUTRO papel,
#     ops-recuperacao-entrega, com lista de principais disjunta (C1 do parecer de 17/11). Nenhum
#     papel de máquina roda esta tarefa, passa os papéis dela ou toca os parâmetros /recuperacao-suporte/*.
#
# Saída do token (R3, R7): SecureString com a chave KMS própria "ops-recuperacao" em
#   /recuperacao-suporte/<usuario>/entrega
# (caminho do código, apps/api/src/ops/recuperar-admin-unico.ts). A tarefa grava e, se falhar depois de
# gravar, apaga; a SEGUNDA pessoa lê uma vez, entrega e apaga. A tarefa não lê o parâmetro; o humano
# não o grava (Deny explícito).
#
# Vencimento de 24 h (R7: "agendado para o vencimento"): a política de expiração do SSM é do
# PARÂMETRO, que nasce no PutParameter da tarefa, não no Terraform. Fica no cliente SSM da tarefa
# (TODO B12 em recuperar-admin-unico.ts): PutParameter com Type=SecureString, KeyId=$SSM_KMS_KEY_ID,
# Tier=Advanced e Policies=[{"Type":"Expiration","Version":"1.0","Attributes":{"Timestamp":"<agora + 24 h>"}}].
# Controle de duas pessoas (R6): dois papéis com listas disjuntas (precondição na definição de
# tarefa); o chamado confere o SourceIdentity do RunTask e do GetParameter no CloudTrail, e as duas
# pontas geram alerta (execução e entrega lida/apagada).
#
# Execução (runbook docs/04-arquitetura/runbook-recuperacao-admin-unico.md): RunTask com
#   containerOverrides[0].command     = ["--clinica", "<uuid>", "--usuario", "<uuid>", "--chamado", "SUP-<n>",
#                                        "--operador", "<uuid>", "--motivo", "<motivo>"(, "--derrubar-sessoes")]
#   containerOverrides[0].environment = [{ name = "CONFIRMA_RECUPERACAO", value = "<o mesmo uuid do usuário>" }]
# O programa fica no entryPoint (R-A do parecer do código do #190): o override troca só os argumentos.

locals {
  ops_rec_nome      = "${local.nome}-ops-recuperacao"
  ops_rec_conteiner = "ops-recuperacao"
  ops_rec_prefixo   = "ops-recuperacao"

  # Nomes e ARNs fixos dos papéis humanos (C1: quem roda não entrega). A key policy da chave
  # "ops-recuperacao" e local.principais_humanos os citam mesmo quando o papel não existe.
  ops_rec_papel_executor     = "${local.nome}-ops-recuperacao-executor"
  ops_rec_papel_entrega      = "${local.nome}-ops-recuperacao-entrega"
  ops_rec_papel_executor_arn = "arn:${data.aws_partition.atual.partition}:iam::${local.conta}:role/${local.ops_rec_papel_executor}"
  ops_rec_papel_entrega_arn  = "arn:${data.aws_partition.atual.partition}:iam::${local.conta}:role/${local.ops_rec_papel_entrega}"

  # Parâmetros SSM do fluxo: só a entrega.
  ops_rec_parametros = "arn:${data.aws_partition.atual.partition}:ssm:${local.regiao}:${local.conta}:parameter/recuperacao-suporte"
  ops_rec_entregas   = "${local.ops_rec_parametros}/*/entrega"
  ops_rec_via_ssm    = "ssm.${local.regiao}.amazonaws.com"

  # Segredo -> segredo do Secrets Manager. SÓ estes dois (R4). A política de leitura do papel de
  # execução é derivada deste mapa; a precondição abaixo falha se entrar qualquer outro.
  ops_rec_segredos_origem = {
    DATABASE_AUTH_URL = { segredo = aws_secretsmanager_secret.app["banco-app-auth"].arn, campo = "url" }
    DATABASE_URL      = { segredo = aws_secretsmanager_secret.app["banco-app-user"].arn, campo = "url" }
  }
  ops_rec_segredos_permitidos = {
    DATABASE_AUTH_URL = aws_secretsmanager_secret.app["banco-app-auth"].arn
    DATABASE_URL      = aws_secretsmanager_secret.app["banco-app-user"].arn
  }
  ops_rec_segredos      = [for nome, s in local.ops_rec_segredos_origem : { name = nome, valueFrom = "${s.segredo}:${s.campo}::" }]
  ops_rec_segredos_arns = distinct([for s in local.ops_rec_segredos_origem : s.segredo])

  # Ambiente fixo, sem segredo. CONFIRMA_RECUPERACAO NÃO entra aqui: vem só pelo override do RunTask.
  ops_rec_ambiente = [
    { name = "NODE_ENV", value = "production" },
    # CA do RDS para sslmode=verify-full (mesmo caminho do Dockerfile e da tarefa da API).
    { name = "NODE_EXTRA_CA_CERTS", value = "/etc/ssl/certs/rds-sa-east-1-bundle.pem" },
    # Cliente SSM da tarefa: região e chave KMS própria do PutParameter da entrega (não é segredo).
    { name = "AWS_REGION", value = local.regiao },
    { name = "SSM_KMS_KEY_ID", value = aws_kms_key.this["ops-recuperacao"].arn },
  ]
  ops_rec_ambiente_permitido = ["NODE_ENV", "NODE_EXTRA_CA_CERTS", "AWS_REGION", "SSM_KMS_KEY_ID"]
  ops_rec_nomes_ambiente     = [for v in local.ops_rec_ambiente : v.name]
  ops_rec_nomes_segredos     = [for s in local.ops_rec_segredos : s.name]

  # Imagem distroless (gcr.io/distroless/nodejs22): node e script fixos; argumentos só pelo override.
  ops_rec_entrypoint = ["/nodejs/bin/node", "dist/ops/recuperar-admin-unico.js"]
}

# --- Rede: grupo de segurança próprio (só banco e VPC endpoints; sem Redis, sem entrada) -------

resource "aws_security_group" "ops_recuperacao" {
  #checkov:skip=CKV2_AWS_5:Usado só no RunTask avulso (networkConfiguration da execução), não por um serviço; ver o runbook da recuperação.
  name        = local.ops_rec_nome
  description = "Tarefa avulsa da recuperacao do admin unico: so PostgreSQL e VPC endpoints, sem entrada"
  vpc_id      = aws_vpc.this.id
}

resource "aws_vpc_security_group_egress_rule" "ops_recuperacao_https" {
  security_group_id = aws_security_group.ops_recuperacao.id
  cidr_ipv4         = var.cidr_vpc
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "VPC endpoints (ECR, Secrets, Logs, KMS, SSM)"
}

resource "aws_vpc_security_group_egress_rule" "ops_recuperacao_s3" {
  security_group_id = aws_security_group.ops_recuperacao.id
  prefix_list_id    = aws_vpc_endpoint.s3.prefix_list_id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "S3 pelo gateway endpoint (camadas do ECR)"
}

resource "aws_vpc_security_group_egress_rule" "ops_recuperacao_rds" {
  security_group_id            = aws_security_group.ops_recuperacao.id
  referenced_security_group_id = aws_security_group.rds.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "PostgreSQL"
}

resource "aws_vpc_security_group_ingress_rule" "rds_da_ops_recuperacao" {
  security_group_id            = aws_security_group.rds.id
  referenced_security_group_id = aws_security_group.ops_recuperacao.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "PostgreSQL vindo da tarefa avulsa da recuperacao do admin unico (B12)"
}

# --- Papéis próprios ---------------------------------------------------------------------------

# EXECUÇÃO: o agente do ECS puxa a imagem, lê SÓ os dois segredos de banco e escreve o log.
resource "aws_iam_role" "ops_recuperacao_execucao" {
  name               = "${local.ops_rec_nome}-execucao"
  description        = "Execução da tarefa avulsa da recuperação do admin único (B12): só banco-app-auth e banco-app-user."
  assume_role_policy = data.aws_iam_policy_document.ecs_confianca.json
}

data "aws_iam_policy_document" "ops_recuperacao_execucao" {
  statement {
    sid       = "PullDaImagem"
    actions   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"]
    resources = [aws_ecr_repository.api.arn]
  }
  statement {
    sid       = "TokenDoEcr"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"] # a ação não aceita recurso específico
  }
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.api.arn}:log-stream:${local.ops_rec_prefixo}/*"]
  }
  statement {
    sid       = "SegredosDeBanco"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = local.ops_rec_segredos_arns
  }
  statement {
    sid       = "Decifrar"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.this["segredos"].arn, aws_kms_key.this["ecr"].arn]
  }
}

resource "aws_iam_role_policy" "ops_recuperacao_execucao" {
  name   = "execucao"
  role   = aws_iam_role.ops_recuperacao_execucao.id
  policy = data.aws_iam_policy_document.ops_recuperacao_execucao.json
}

# TAREFA (o processo Node): só grava e apaga a entrega em /recuperacao-suporte/*, com a chave própria.
resource "aws_iam_role" "ops_recuperacao_tarefa" {
  name               = "${local.ops_rec_nome}-tarefa"
  description        = "Papel da tarefa avulsa da recuperação do admin único (B12): grava e apaga a entrega em /recuperacao-suporte/*."
  assume_role_policy = data.aws_iam_policy_document.ecs_confianca.json
}

data "aws_iam_policy_document" "ops_recuperacao_tarefa" {
  statement {
    sid       = "GravarEApagarAEntrega"
    actions   = ["ssm:PutParameter", "ssm:DeleteParameter"]
    resources = [local.ops_rec_entregas]
  }
  # A2: a tarefa nunca relê o token. Deny explícito (não só a falta de Allow), para uma ampliação
  # futura por curinga não abrir a leitura; a key policy também não deixa este papel decifrar.
  statement {
    sid       = "EntregaNaoVolta"
    effect    = "Deny"
    actions   = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParameterHistory", "ssm:GetParametersByPath"]
    resources = [local.ops_rec_parametros, "${local.ops_rec_parametros}/*"]
  }
  statement {
    sid       = "CifrarAEntrega"
    actions   = ["kms:Encrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.this["ops-recuperacao"].arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = [local.ops_rec_via_ssm]
    }
    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:PARAMETER_ARN"
      values   = [local.ops_rec_entregas]
    }
  }
}

resource "aws_iam_role_policy" "ops_recuperacao_tarefa" {
  name   = "parametros-da-recuperacao"
  role   = aws_iam_role.ops_recuperacao_tarefa.id
  policy = data.aws_iam_policy_document.ops_recuperacao_tarefa.json
}

# --- Definição de tarefa -----------------------------------------------------------------------

resource "aws_ecs_task_definition" "ops_recuperacao" {
  family                   = local.ops_rec_nome
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.ops_recuperacao_execucao.arn
  task_role_arn            = aws_iam_role.ops_recuperacao_tarefa.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  volume {
    name = "tmp"
  }

  container_definitions = jsonencode([{
    name                   = local.ops_rec_conteiner
    image                  = "${aws_ecr_repository.api.repository_url}:${var.api_imagem_tag}" # mesma imagem da API
    essential              = true
    readonlyRootFilesystem = true
    user                   = "1000:1000"
    entryPoint             = local.ops_rec_entrypoint
    command                = []
    stopTimeout            = 30
    linuxParameters        = { initProcessEnabled = true }
    mountPoints            = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
    environment            = local.ops_rec_ambiente
    secrets                = local.ops_rec_segredos
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.api.name
        awslogs-region        = local.regiao
        awslogs-stream-prefix = local.ops_rec_prefixo
      }
    }
  }])

  lifecycle {
    # R4: SÓ DATABASE_AUTH_URL (banco-app-auth) e DATABASE_URL (banco-app-user), e só em `secrets`.
    precondition {
      condition = (
        length(local.ops_rec_segredos_origem) == 2
        && length(setsubtract(keys(local.ops_rec_segredos_origem), keys(local.ops_rec_segredos_permitidos))) == 0
        && length(setsubtract(keys(local.ops_rec_segredos_permitidos), keys(local.ops_rec_segredos_origem))) == 0
        && alltrue([for n, s in local.ops_rec_segredos_origem : s.segredo == local.ops_rec_segredos_permitidos[n]])
        && length(setsubtract(local.ops_rec_segredos_arns, values(local.ops_rec_segredos_permitidos))) == 0
      )
      error_message = "A tarefa da recuperação do admin único só pode ter os segredos DATABASE_AUTH_URL (banco-app-auth) e DATABASE_URL (banco-app-user). Nada de BETTER_AUTH_SECRET, REDIS_URL, chaves HMAC, KMS de clínica ou WhatsApp (R4 do parecer de 16/11/2026)."
    }
    # Ambiente fechado: nenhum segredo em texto claro, nenhuma porta da cadeia de credenciais AWS,
    # nenhuma trava pré-preenchida.
    precondition {
      condition     = length(setsubtract(local.ops_rec_nomes_ambiente, local.ops_rec_ambiente_permitido)) == 0 && length(setintersection(local.ops_rec_nomes_ambiente, local.ops_rec_nomes_segredos)) == 0
      error_message = "O environment da tarefa da recuperação só aceita NODE_ENV, NODE_EXTRA_CA_CERTS, AWS_REGION e SSM_KMS_KEY_ID. CONFIRMA_RECUPERACAO vem só pelo containerOverrides do RunTask."
    }
    # C1: quem roda não entrega. As duas listas preenchidas (ou as duas vazias: ninguém recupera) e
    # sem nenhum principal em comum. A validação das variáveis recusa curinga, então comparar os ARNs
    # como texto basta.
    precondition {
      condition = (
        (length(var.principais_ops_recuperacao_executor) == 0) == (length(var.principais_ops_recuperacao_entrega) == 0)
        && length(setintersection(var.principais_ops_recuperacao_executor, var.principais_ops_recuperacao_entrega)) == 0
      )
      error_message = "principais_ops_recuperacao_executor e principais_ops_recuperacao_entrega precisam estar as duas preenchidas (ou as duas vazias) e ser disjuntas: quem roda a recuperação não lê a entrega do token (C1 do parecer de 17/11/2026)."
    }
  }
}

# --- Papéis humanos ops-recuperacao-executor e ops-recuperacao-entrega ---------------------------
# R4 e R6 do parecer do desenho e C1 do parecer do código (revisoes/2026-11-17-codigo-infra-ops-provisionamento.md):
# quem roda NÃO entrega, separado por máquina, não só pelo chamado.
#   - executor: roda a tarefa e acompanha. Não toca /recuperacao-suporte/* e não decifra nada (a key
#     policy só deixa o papel de entrega decifrar);
#   - entrega: lê a entrega uma vez e apaga. Não roda a tarefa, não passa papel e não grava nada.
# Cada papel tem a sua lista de principais (fora do git, no tfvars); a precondição da definição de
# tarefa exige as duas listas preenchidas (ou as duas vazias) e disjuntas. Mesmo desenho de confiança
# do ops-lgpd (ops-anonimizacao.tf): só a conta, MFA de menos de 1 h, SourceIdentity obrigatório
# (igual ao aws:username no usuário IAM; presente no papel do SSO), sessão de 1 h. Sem principal na
# lista, o papel não existe.

locals {
  ops_rec_papeis_humanos = {
    executor = { nome = local.ops_rec_papel_executor, principais = var.principais_ops_recuperacao_executor }
    entrega  = { nome = local.ops_rec_papel_entrega, principais = var.principais_ops_recuperacao_entrega }
  }
  ops_rec_papeis_ativos = { for k, p in local.ops_rec_papeis_humanos : k => p if length(p.principais) > 0 }
}

data "aws_iam_policy_document" "confianca_ops_recuperacao" {
  for_each = local.ops_rec_papeis_humanos

  dynamic "statement" {
    for_each = length([for a in each.value.principais : a if can(regex(":user/", a))]) > 0 ? [1] : []
    content {
      sid     = "UsuarioNominalComMfa"
      actions = ["sts:AssumeRole", "sts:SetSourceIdentity"]
      principals {
        type        = "AWS"
        identifiers = ["arn:${data.aws_partition.atual.partition}:iam::${local.conta}:root"]
      }
      condition {
        test     = "ArnLike"
        variable = "aws:PrincipalArn"
        values   = [for a in each.value.principais : a if can(regex(":user/", a))]
      }
      condition {
        test     = "StringEquals"
        variable = "sts:SourceIdentity"
        values   = ["$${aws:username}"]
      }
      condition {
        test     = "Bool"
        variable = "aws:MultiFactorAuthPresent"
        values   = ["true"]
      }
      condition {
        test     = "NumericLessThan"
        variable = "aws:MultiFactorAuthAge"
        values   = ["3600"]
      }
    }
  }
  dynamic "statement" {
    for_each = length([for a in each.value.principais : a if !can(regex(":user/", a))]) > 0 ? [1] : []
    content {
      sid     = "SsoComMfaESourceIdentity"
      actions = ["sts:AssumeRole", "sts:SetSourceIdentity"]
      principals {
        type        = "AWS"
        identifiers = ["arn:${data.aws_partition.atual.partition}:iam::${local.conta}:root"]
      }
      condition {
        test     = "ArnLike"
        variable = "aws:PrincipalArn"
        values   = [for a in each.value.principais : a if !can(regex(":user/", a))]
      }
      condition {
        test     = "Null"
        variable = "sts:SourceIdentity"
        values   = ["false"]
      }
      condition {
        test     = "Bool"
        variable = "aws:MultiFactorAuthPresent"
        values   = ["true"]
      }
      condition {
        test     = "NumericLessThan"
        variable = "aws:MultiFactorAuthAge"
        values   = ["3600"]
      }
    }
  }
}

resource "aws_iam_role" "ops_recuperacao" {
  for_each             = local.ops_rec_papeis_ativos
  name                 = each.value.nome
  description          = each.key == "executor" ? "Roda a recuperação do fator do admin único (B12), sem ler a entrega: humano nominal com MFA e SourceIdentity, sessão de 1 h, todo RunTask gera alerta." : "Lê uma vez e apaga a entrega do token da recuperação do admin único (B12), sem rodar a tarefa: humano nominal com MFA e SourceIdentity, sessão de 1 h, toda leitura gera alerta."
  assume_role_policy   = data.aws_iam_policy_document.confianca_ops_recuperacao[each.key].json
  max_session_duration = 3600
}

# Comum aos dois papéis: sem MFA nada, só São Paulo.
data "aws_iam_policy_document" "ops_recuperacao_comum" {
  # Mesmo que alguém amplie a confiança: sessão sem MFA não roda, não passa papel e não toca o SSM.
  statement {
    sid       = "SemMfaNada"
    effect    = "Deny"
    actions   = ["ecs:RunTask", "iam:PassRole", "ssm:GetParameter", "ssm:DeleteParameter", "kms:Decrypt"]
    resources = ["*"]
    condition {
      test     = "BoolIfExists"
      variable = "aws:MultiFactorAuthPresent"
      values   = ["false"]
    }
  }
  statement {
    sid         = "SomenteSaoPaulo"
    effect      = "Deny"
    not_actions = ["iam:*", "sts:*"]
    resources   = ["*"]
    condition {
      test     = "StringNotEquals"
      variable = "aws:RequestedRegion"
      values   = ["sa-east-1"]
    }
  }
}

data "aws_iam_policy_document" "ops_recuperacao_executor" {
  source_policy_documents = [data.aws_iam_policy_document.ops_recuperacao_comum.json]

  # Roda SÓ a revisão atual desta definição (ARN com revisão), SÓ neste cluster.
  statement {
    sid       = "RodarRecuperacao"
    actions   = ["ecs:RunTask"]
    resources = [aws_ecs_task_definition.ops_recuperacao.arn]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.this.arn]
    }
  }
  statement {
    sid       = "PassarPapeisDaRecuperacao"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.ops_recuperacao_execucao.arn, aws_iam_role.ops_recuperacao_tarefa.arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
  statement {
    sid       = "AcompanharTarefa"
    actions   = ["ecs:DescribeTasks"]
    resources = ["arn:${data.aws_partition.atual.partition}:ecs:${local.regiao}:${local.conta}:task/${aws_ecs_cluster.this.name}/*"]
  }
  statement {
    sid       = "LerSaidaDaRecuperacao"
    actions   = ["logs:GetLogEvents"]
    resources = ["${aws_cloudwatch_log_group.api.arn}:log-stream:${local.ops_rec_prefixo}/*"]
  }
  # C1: quem roda não toca a entrega (nem forja, nem lê, nem apaga).
  statement {
    sid       = "NaoTocaAEntrega"
    effect    = "Deny"
    actions   = ["ssm:PutParameter", "ssm:GetParameter", "ssm:GetParameters", "ssm:GetParameterHistory", "ssm:GetParametersByPath", "ssm:DeleteParameter", "ssm:DeleteParameters"]
    resources = [local.ops_rec_parametros, "${local.ops_rec_parametros}/*"]
  }
}

data "aws_iam_policy_document" "ops_recuperacao_entrega" {
  source_policy_documents = [data.aws_iam_policy_document.ops_recuperacao_comum.json]

  # Lê a entrega uma vez, entrega fora de banda e apaga (R6, R7).
  statement {
    sid       = "LerEApagarAEntrega"
    actions   = ["ssm:GetParameter", "ssm:DeleteParameter"]
    resources = [local.ops_rec_entregas]
  }
  statement {
    sid       = "DecifrarAEntrega"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.this["ops-recuperacao"].arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = [local.ops_rec_via_ssm]
    }
    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:PARAMETER_ARN"
      values   = [local.ops_rec_entregas]
    }
  }
  # C1: quem entrega não roda a tarefa, não passa os papéis dela e não forja a entrega (o token só
  # nasce na tarefa).
  statement {
    sid       = "NaoRodaENaoGrava"
    effect    = "Deny"
    actions   = ["ecs:RunTask", "ecs:StartTask", "iam:PassRole", "ssm:PutParameter"]
    resources = ["*"]
  }
}

locals {
  ops_rec_politicas = {
    executor = data.aws_iam_policy_document.ops_recuperacao_executor.json
    entrega  = data.aws_iam_policy_document.ops_recuperacao_entrega.json
  }
}

resource "aws_iam_role_policy" "ops_recuperacao" {
  for_each = local.ops_rec_papeis_ativos
  name     = each.key == "executor" ? "rodar-recuperacao" : "entregar-token-da-recuperacao"
  role     = aws_iam_role.ops_recuperacao[each.key].id
  policy   = local.ops_rec_politicas[each.key]
}

# --- Alerta a cada execução (padrão R-B do parecer do código do #190) ------------------------------
# Duas regras no tópico de alertas de segurança:
#   1. <nome>-ops-recuperacao-execucao: TODA chamada a RunTask desta família;
#   2. <nome>-ops-recuperacao-override-suspeito (CRÍTICO): variável de ambiente com nome diferente de
#      CONFIRMA_RECUPERACAO, environmentFiles, troca de papel ou ECS Exec.
# O EventBridge não confere tamanho nem ordem do `command`: fica com a regra 1 e com o conferente, que
# confere o override no evento do CloudTrail e anota no chamado (runbook).

locals {
  ops_rec_evento_runtask = {
    source        = ["aws.ecs"]
    "detail-type" = ["AWS API Call via CloudTrail"]
  }
  ops_rec_familia_curinga = [{ wildcard = "*${local.ops_rec_nome}*" }]
}

resource "aws_cloudwatch_event_rule" "ops_recuperacao_execucao" {
  name        = "${local.ops_rec_nome}-execucao"
  description = "Toda execução (RunTask) da recuperação do admin único pelo suporte (B12)."
  event_pattern = jsonencode(merge(local.ops_rec_evento_runtask, {
    detail = {
      eventSource       = ["ecs.amazonaws.com"]
      eventName         = ["RunTask"]
      requestParameters = { taskDefinition = local.ops_rec_familia_curinga }
    }
  }))
}

resource "aws_cloudwatch_event_target" "ops_recuperacao_execucao" {
  rule = aws_cloudwatch_event_rule.ops_recuperacao_execucao.name
  arn  = aws_sns_topic.alertas_seguranca.arn
}

resource "aws_cloudwatch_event_rule" "ops_recuperacao_override_suspeito" {
  name        = "${local.ops_rec_nome}-override-suspeito"
  description = "CRITICO: RunTask da recuperação do admin único com override fora do runbook (variável além de CONFIRMA_RECUPERACAO, troca de papel, ECS Exec)."
  event_pattern = jsonencode(merge(local.ops_rec_evento_runtask, {
    detail = {
      eventSource = ["ecs.amazonaws.com"]
      eventName   = ["RunTask"]
      "$or" = [
        { requestParameters = { taskDefinition = local.ops_rec_familia_curinga, overrides = { containerOverrides = { environment = { name = [{ "anything-but" = "CONFIRMA_RECUPERACAO" }] } } } } },
        { requestParameters = { taskDefinition = local.ops_rec_familia_curinga, overrides = { containerOverrides = { environmentFiles = [{ exists = true }] } } } },
        { requestParameters = { taskDefinition = local.ops_rec_familia_curinga, overrides = { taskRoleArn = [{ exists = true }] } } },
        { requestParameters = { taskDefinition = local.ops_rec_familia_curinga, overrides = { executionRoleArn = [{ exists = true }] } } },
        { requestParameters = { taskDefinition = local.ops_rec_familia_curinga, enableExecuteCommand = [true] } },
      ]
    }
  }))
}

resource "aws_cloudwatch_event_target" "ops_recuperacao_override_suspeito" {
  rule = aws_cloudwatch_event_rule.ops_recuperacao_override_suspeito.name
  arn  = aws_sns_topic.alertas_seguranca.arn
}

# 3. <nome>-ops-recuperacao-entrega (A6, trilha do "entregue em" de C1): toda leitura ou apagamento de
#    /recuperacao-suporte/*/entrega (inclui o apagamento pela própria tarefa quando falha depois de
#    gravar). Mesmo desenho da regra do provisionamento: estado ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS
#    para receber o GetParameter (evento de leitura).
resource "aws_cloudwatch_event_rule" "ops_recuperacao_entrega" {
  name        = "${local.ops_rec_nome}-entrega"
  description = "Leitura ou apagamento da entrega do token da recuperação do admin único (B12)."
  state       = "ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS"
  event_pattern = jsonencode({
    source        = ["aws.ssm"]
    "detail-type" = ["AWS API Call via CloudTrail"]
    detail = {
      eventSource = ["ssm.amazonaws.com"]
      eventName   = ["GetParameter", "GetParameters", "GetParameterHistory", "DeleteParameter", "DeleteParameters"]
      "$or" = [
        { requestParameters = { name = [{ wildcard = "/recuperacao-suporte/*/entrega" }] } },
        { requestParameters = { names = [{ wildcard = "/recuperacao-suporte/*/entrega" }] } },
      ]
    }
  })
}

resource "aws_cloudwatch_event_target" "ops_recuperacao_entrega" {
  rule = aws_cloudwatch_event_rule.ops_recuperacao_entrega.name
  arn  = aws_sns_topic.alertas_seguranca.arn
}

# --- Papéis de máquina NUNCA rodam esta tarefa nem tocam os parâmetros (R4) ---------------------
# Mesma lista de papéis de máquina do B10 (local.ops_anon_papeis_sem_acesso). O Deny explícito
# garante que uma ampliação futura (curinga) não alcance a recuperação.

data "aws_iam_policy_document" "nega_ops_recuperacao" {
  statement {
    sid     = "NaoRodaRecuperacao"
    effect  = "Deny"
    actions = ["ecs:RunTask", "ecs:StartTask"]
    resources = [
      "arn:${data.aws_partition.atual.partition}:ecs:${local.regiao}:${local.conta}:task-definition/${local.ops_rec_nome}:*",
    ]
  }
  statement {
    sid       = "NaoPassaPapeisDaRecuperacao"
    effect    = "Deny"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.ops_recuperacao_execucao.arn, aws_iam_role.ops_recuperacao_tarefa.arn]
  }
  statement {
    sid       = "NaoTocaOsParametros"
    effect    = "Deny"
    actions   = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParameterHistory", "ssm:GetParametersByPath", "ssm:PutParameter", "ssm:DeleteParameter", "ssm:DeleteParameters"]
    resources = [local.ops_rec_parametros, "${local.ops_rec_parametros}/*"]
  }
  statement {
    sid       = "NaoUsaAChaveDosParametros"
    effect    = "Deny"
    actions   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey*", "kms:ReEncrypt*", "kms:CreateGrant"]
    resources = [aws_kms_key.this["ops-recuperacao"].arn]
  }
}

resource "aws_iam_role_policy" "nega_ops_recuperacao" {
  for_each = local.ops_anon_papeis_sem_acesso
  name     = "nega-ops-recuperacao"
  role     = each.value
  policy   = data.aws_iam_policy_document.nega_ops_recuperacao.json
}
