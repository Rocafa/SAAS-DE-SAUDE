# Tarefa avulsa do ECS para a anonimização de conta a pedido do titular (B10 do checklist do login
# real). Parecer do Guardião de 12/11/2026 (revisoes/2026-11-12-desenho-anonimizacao-pelo-suporte.md),
# resposta 1 e R5:
#   - definição de tarefa, papel de execução e papel de tarefa PRÓPRIOS; só as credenciais de banco
#     (app_auth e app_user). Nada de BETTER_AUTH_SECRET, Redis, chaves HMAC, KMS ou WhatsApp;
#   - quem roda é provado pela AWS (principal do ecs:RunTask no CloudTrail): só o papel ops-lgpd
#     (humano nominal, MFA, SourceIdentity; R-C). Nenhum papel de máquina roda esta tarefa nem passa os
#     papéis dela;
#   - sem break-glass.
#
# Execução (runbook docs/04-arquitetura/runbook-anonimizacao-pelo-suporte.md): RunTask com
#   containerOverrides[0].command     = ["--usuario", "<uuid>", "--chamado", "LGPD-<n>", "--operador", "<uuid>"]
# O programa fica no entryPoint (R-A e R-B do parecer do código do #190): o RunTask troca o `command`
# (só os argumentos), mas não o entryPoint, então quem roda não consegue executar outro programa.
#   containerOverrides[0].environment = [{ name = "CONFIRMA_ANONIMIZACAO", value = "<o mesmo uuid>" }]
# Os overrides vão para o CloudTrail: só uuid e número do chamado, nunca nome ou e-mail (R5).

locals {
  ops_anon_nome      = "${local.nome}-ops-anonimizacao"
  ops_anon_conteiner = "ops-anonimizacao"
  ops_anon_prefixo   = "ops-anonimizacao"

  # Segredo -> segredo do Secrets Manager. SÓ estes dois (R5). A política de leitura do papel de
  # execução é derivada deste mapa; a precondição abaixo falha se entrar qualquer outro.
  ops_anon_segredos_origem = {
    DATABASE_AUTH_URL = { segredo = aws_secretsmanager_secret.app["banco-app-auth"].arn, campo = "url" }
    DATABASE_URL      = { segredo = aws_secretsmanager_secret.app["banco-app-user"].arn, campo = "url" }
  }
  ops_anon_segredos_permitidos = {
    DATABASE_AUTH_URL = aws_secretsmanager_secret.app["banco-app-auth"].arn
    DATABASE_URL      = aws_secretsmanager_secret.app["banco-app-user"].arn
  }
  ops_anon_segredos      = [for nome, s in local.ops_anon_segredos_origem : { name = nome, valueFrom = "${s.segredo}:${s.campo}::" }]
  ops_anon_segredos_arns = distinct([for s in local.ops_anon_segredos_origem : s.segredo])

  # Ambiente fixo, sem segredo. CONFIRMA_ANONIMIZACAO NÃO entra aqui: vem só pelo override do RunTask.
  ops_anon_ambiente = [
    { name = "NODE_ENV", value = "production" },
    # CA do RDS para sslmode=verify-full (mesmo caminho do Dockerfile e da tarefa da API).
    { name = "NODE_EXTRA_CA_CERTS", value = "/etc/ssl/certs/rds-sa-east-1-bundle.pem" },
  ]
  ops_anon_ambiente_permitido = ["NODE_ENV", "NODE_EXTRA_CA_CERTS"]
  ops_anon_nomes_ambiente     = [for v in local.ops_anon_ambiente : v.name]
  ops_anon_nomes_segredos     = [for s in local.ops_anon_segredos : s.name]

  # A imagem é distroless (gcr.io/distroless/nodejs22): o entrypoint da imagem já é o node. Aqui ele
  # é fixado junto com o script; os argumentos vêm só pelo override.
  ops_anon_entrypoint = ["/nodejs/bin/node", "dist/ops/anonimizar-conta.js"]
}

# --- Rede: grupo de segurança próprio (só banco e VPC endpoints; sem Redis, sem entrada) -------

resource "aws_security_group" "ops_anonimizacao" {
  #checkov:skip=CKV2_AWS_5:Usado só no RunTask avulso (networkConfiguration da execução), não por um serviço; ver o runbook da anonimização.
  name        = local.ops_anon_nome
  description = "Tarefa avulsa da anonimizacao: so PostgreSQL e VPC endpoints, sem entrada"
  vpc_id      = aws_vpc.this.id
}

resource "aws_vpc_security_group_egress_rule" "ops_anonimizacao_https" {
  security_group_id = aws_security_group.ops_anonimizacao.id
  cidr_ipv4         = var.cidr_vpc
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "VPC endpoints (ECR, Secrets, Logs)"
}

resource "aws_vpc_security_group_egress_rule" "ops_anonimizacao_s3" {
  security_group_id = aws_security_group.ops_anonimizacao.id
  prefix_list_id    = aws_vpc_endpoint.s3.prefix_list_id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "S3 pelo gateway endpoint (camadas do ECR)"
}

resource "aws_vpc_security_group_egress_rule" "ops_anonimizacao_rds" {
  security_group_id            = aws_security_group.ops_anonimizacao.id
  referenced_security_group_id = aws_security_group.rds.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "PostgreSQL"
}

resource "aws_vpc_security_group_ingress_rule" "rds_da_ops_anonimizacao" {
  security_group_id            = aws_security_group.rds.id
  referenced_security_group_id = aws_security_group.ops_anonimizacao.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "PostgreSQL vindo da tarefa avulsa da anonimizacao (B10)"
}

# --- Papéis próprios ---------------------------------------------------------------------------

# EXECUÇÃO: o agente do ECS puxa a imagem, lê SÓ os dois segredos de banco e escreve o log.
resource "aws_iam_role" "ops_anonimizacao_execucao" {
  name               = "${local.ops_anon_nome}-execucao"
  description        = "Execução da tarefa avulsa da anonimização (B10): só banco-app-auth e banco-app-user."
  assume_role_policy = data.aws_iam_policy_document.ecs_confianca.json
}

data "aws_iam_policy_document" "ops_anonimizacao_execucao" {
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
    resources = ["${aws_cloudwatch_log_group.api.arn}:log-stream:${local.ops_anon_prefixo}/*"]
  }
  statement {
    sid       = "SegredosDeBanco"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = local.ops_anon_segredos_arns
  }
  statement {
    sid       = "Decifrar"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.this["segredos"].arn, aws_kms_key.this["ecr"].arn]
  }
}

resource "aws_iam_role_policy" "ops_anonimizacao_execucao" {
  name   = "execucao"
  role   = aws_iam_role.ops_anonimizacao_execucao.id
  policy = data.aws_iam_policy_document.ops_anonimizacao_execucao.json
}

# TAREFA (o processo Node): nenhuma permissão AWS. O comando só fala com o banco.
resource "aws_iam_role" "ops_anonimizacao_tarefa" {
  name               = "${local.ops_anon_nome}-tarefa"
  description        = "Papel da tarefa avulsa da anonimização (B10): sem permissão AWS (só banco)."
  assume_role_policy = data.aws_iam_policy_document.ecs_confianca.json
}

# --- Definição de tarefa -----------------------------------------------------------------------

resource "aws_ecs_task_definition" "ops_anonimizacao" {
  family                   = local.ops_anon_nome
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.ops_anonimizacao_execucao.arn
  task_role_arn            = aws_iam_role.ops_anonimizacao_tarefa.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  volume {
    name = "tmp"
  }

  container_definitions = jsonencode([{
    name                   = local.ops_anon_conteiner
    image                  = "${aws_ecr_repository.api.repository_url}:${var.api_imagem_tag}" # mesma imagem da API
    essential              = true
    readonlyRootFilesystem = true
    user                   = "1000:1000"
    entryPoint             = local.ops_anon_entrypoint
    command                = []
    stopTimeout            = 30
    linuxParameters        = { initProcessEnabled = true }
    mountPoints            = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
    environment            = local.ops_anon_ambiente
    secrets                = local.ops_anon_segredos
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.api.name
        awslogs-region        = local.regiao
        awslogs-stream-prefix = local.ops_anon_prefixo
      }
    }
  }])

  lifecycle {
    # R5: SÓ DATABASE_AUTH_URL (banco-app-auth) e DATABASE_URL (banco-app-user), e só em `secrets`.
    precondition {
      condition = (
        length(local.ops_anon_segredos_origem) == 2
        && length(setsubtract(keys(local.ops_anon_segredos_origem), keys(local.ops_anon_segredos_permitidos))) == 0
        && length(setsubtract(keys(local.ops_anon_segredos_permitidos), keys(local.ops_anon_segredos_origem))) == 0
        && alltrue([for n, s in local.ops_anon_segredos_origem : s.segredo == local.ops_anon_segredos_permitidos[n]])
        && length(setsubtract(local.ops_anon_segredos_arns, values(local.ops_anon_segredos_permitidos))) == 0
      )
      error_message = "A tarefa da anonimização só pode ter os segredos DATABASE_AUTH_URL (banco-app-auth) e DATABASE_URL (banco-app-user). Nada de BETTER_AUTH_SECRET, REDIS_URL, chaves HMAC, KMS ou WhatsApp (R5 do parecer de 12/11/2026)."
    }
    # Ambiente fechado: nada além de NODE_ENV e NODE_EXTRA_CA_CERTS (nenhum segredo em texto claro,
    # nenhuma porta da cadeia de credenciais AWS, nenhuma trava pré-preenchida).
    precondition {
      condition     = length(setsubtract(local.ops_anon_nomes_ambiente, local.ops_anon_ambiente_permitido)) == 0 && length(setintersection(local.ops_anon_nomes_ambiente, local.ops_anon_nomes_segredos)) == 0
      error_message = "O environment da tarefa da anonimização só aceita NODE_ENV e NODE_EXTRA_CA_CERTS. CONFIRMA_ANONIMIZACAO vem só pelo containerOverrides do RunTask."
    }
  }
}

# --- Papel ops-lgpd (resposta 1 do parecer do desenho; R-C do parecer do código do #190) ---------
# Acesso humano por PAPEL, no padrão de investigacao_seguranca e break_glass (confianca_humano_mfa):
# só a conta, MFA recente, sessão de 1 h. Mais restrito que o padrão: só os principais de
# var.principais_ops_lgpd (fora do git, no tfvars) e com sts:SourceIdentity obrigatório, para o
# CloudTrail do RunTask mostrar a pessoa e não só o papel.
#   - usuário IAM nominal: SourceIdentity tem de ser igual ao nome do usuário (aws:username);
#   - papel do SSO (permission set): a AWS não expõe o usuário do SSO como variável de política, então
#     a confiança exige só que haja SourceIdentity; a pessoa fica também no nome da sessão do SSO
#     (aws:userid no CloudTrail) e o conferente confere os dois no chamado.
# Sem principal na lista, o papel não existe (ninguém roda a anonimização).

locals {
  ops_lgpd_usuarios = [for a in var.principais_ops_lgpd : a if can(regex(":user/", a))]
  ops_lgpd_sso      = [for a in var.principais_ops_lgpd : a if !can(regex(":user/", a))]
  ops_lgpd_ativo    = length(var.principais_ops_lgpd) > 0
}

data "aws_iam_policy_document" "confianca_ops_lgpd" {
  dynamic "statement" {
    for_each = length(local.ops_lgpd_usuarios) > 0 ? [1] : []
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
        values   = local.ops_lgpd_usuarios
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
    for_each = length(local.ops_lgpd_sso) > 0 ? [1] : []
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
        values   = local.ops_lgpd_sso
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

resource "aws_iam_role" "ops_lgpd" {
  count                = local.ops_lgpd_ativo ? 1 : 0
  name                 = "${local.nome}-ops-lgpd"
  description          = "Roda a anonimização a pedido do titular (B10): humano nominal com MFA e SourceIdentity, sessão de 1 h, todo RunTask gera alerta."
  assume_role_policy   = data.aws_iam_policy_document.confianca_ops_lgpd.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "ops_lgpd" {
  # Roda SÓ a revisão atual desta definição (ARN com revisão), SÓ neste cluster. Uma revisão nova
  # registrada por fora (ex.: com outros papéis) não fica executável. O MFA é exigido na confiança.
  statement {
    sid       = "RodarAnonimizacao"
    actions   = ["ecs:RunTask"]
    resources = [aws_ecs_task_definition.ops_anonimizacao.arn]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.this.arn]
    }
  }
  statement {
    sid       = "PassarPapeisDaAnonimizacao"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.ops_anonimizacao_execucao.arn, aws_iam_role.ops_anonimizacao_tarefa.arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
  # Acompanhar a execução: estado da tarefa e a linha de saída (só o prefixo desta tarefa no log).
  statement {
    sid       = "AcompanharTarefa"
    actions   = ["ecs:DescribeTasks"]
    resources = ["arn:${data.aws_partition.atual.partition}:ecs:${local.regiao}:${local.conta}:task/${aws_ecs_cluster.this.name}/*"]
  }
  statement {
    sid       = "LerSaidaDaAnonimizacao"
    actions   = ["logs:GetLogEvents"]
    resources = ["${aws_cloudwatch_log_group.api.arn}:log-stream:${local.ops_anon_prefixo}/*"]
  }
  # Mesmo que alguém amplie a confiança: sessão sem MFA não roda nem passa papel.
  statement {
    sid       = "SemMfaNada"
    effect    = "Deny"
    actions   = ["ecs:RunTask", "iam:PassRole"]
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

resource "aws_iam_role_policy" "ops_lgpd" {
  count  = local.ops_lgpd_ativo ? 1 : 0
  name   = "rodar-anonimizacao"
  role   = aws_iam_role.ops_lgpd[0].id
  policy = data.aws_iam_policy_document.ops_lgpd.json
}

# --- Alerta a cada execução (R-B do parecer do código do #190) -------------------------------------
# RunTask é evento de ESCRITA do CloudTrail: o estado ENABLED basta. Duas regras no mesmo tópico:
#   1. <nome>-ops-anonimizacao-execucao: TODA chamada a RunTask desta família (pedida pelo nome,
#      nome:revisão ou ARN, inclusive as recusadas), como o break-glass ("cada uso gera alerta").
#   2. <nome>-ops-anonimizacao-override-suspeito (CRÍTICO): o override traz variável de ambiente com
#      nome diferente de CONFIRMA_ANONIMIZACAO (ex.: NODE_OPTIONS=--import=data:..., que roda código
#      antes do main), environmentFiles, troca de papel (taskRoleArn/executionRoleArn) ou ECS Exec.
# Limite do padrão de evento: o EventBridge não confere tamanho nem ordem de um array, então NÃO dá
# para exigir que o `command` seja exatamente as 6 posições --usuario/--chamado/--operador. Isso fica
# com a regra 1 (todo RunTask avisa) e com o conferente, que confere o JSON do override no evento do
# CloudTrail daquela execução e anota no chamado (R-B c, runbook). O entryPoint fixo (R-A) já impede
# trocar o programa pelo `command`.

locals {
  ops_anon_evento_runtask = {
    source        = ["aws.ecs"]
    "detail-type" = ["AWS API Call via CloudTrail"]
  }
  ops_anon_familia_curinga = [{ wildcard = "*${local.ops_anon_nome}*" }]
}

resource "aws_cloudwatch_event_rule" "ops_anonimizacao_execucao" {
  name        = "${local.ops_anon_nome}-execucao"
  description = "Toda execução (RunTask) da anonimização pelo suporte (R-B do #190)."
  event_pattern = jsonencode(merge(local.ops_anon_evento_runtask, {
    detail = {
      eventSource       = ["ecs.amazonaws.com"]
      eventName         = ["RunTask"]
      requestParameters = { taskDefinition = local.ops_anon_familia_curinga }
    }
  }))
}

resource "aws_cloudwatch_event_target" "ops_anonimizacao_execucao" {
  rule = aws_cloudwatch_event_rule.ops_anonimizacao_execucao.name
  arn  = aws_sns_topic.alertas_seguranca.arn
}

resource "aws_cloudwatch_event_rule" "ops_anonimizacao_override_suspeito" {
  name        = "${local.ops_anon_nome}-override-suspeito"
  description = "CRITICO: RunTask da anonimização com override fora do runbook (variável além de CONFIRMA_ANONIMIZACAO, troca de papel, ECS Exec). R-B do #190."
  event_pattern = jsonencode(merge(local.ops_anon_evento_runtask, {
    detail = {
      eventSource = ["ecs.amazonaws.com"]
      eventName   = ["RunTask"]
      "$or" = [
        { requestParameters = { taskDefinition = local.ops_anon_familia_curinga, overrides = { containerOverrides = { environment = { name = [{ "anything-but" = "CONFIRMA_ANONIMIZACAO" }] } } } } },
        { requestParameters = { taskDefinition = local.ops_anon_familia_curinga, overrides = { containerOverrides = { environmentFiles = [{ exists = true }] } } } },
        { requestParameters = { taskDefinition = local.ops_anon_familia_curinga, overrides = { taskRoleArn = [{ exists = true }] } } },
        { requestParameters = { taskDefinition = local.ops_anon_familia_curinga, overrides = { executionRoleArn = [{ exists = true }] } } },
        { requestParameters = { taskDefinition = local.ops_anon_familia_curinga, enableExecuteCommand = [true] } },
      ]
    }
  }))
}

resource "aws_cloudwatch_event_target" "ops_anonimizacao_override_suspeito" {
  rule = aws_cloudwatch_event_rule.ops_anonimizacao_override_suspeito.name
  arn  = aws_sns_topic.alertas_seguranca.arn
}


# --- Papéis de máquina NUNCA rodam esta tarefa (resposta 1: "o papel da API não pode...") -------
# Hoje nenhum deles tem ecs:RunTask, e o PassRole do deploy é só nos papéis da API. O Deny
# explícito garante que uma ampliação futura (curinga) não passe a alcançar a anonimização.

locals {
  ops_anon_papeis_sem_acesso = {
    api_tarefa        = aws_iam_role.api_tarefa.id
    api_execucao      = aws_iam_role.api_execucao.id
    github_deploy     = aws_iam_role.github_deploy.id
    gestor_chaves     = aws_iam_role.gestor_chaves.id
    ancora_publicador = aws_iam_role.ancora_publicador.id
  }
}

data "aws_iam_policy_document" "nega_ops_anonimizacao" {
  statement {
    sid     = "NaoRodaAnonimizacao"
    effect  = "Deny"
    actions = ["ecs:RunTask", "ecs:StartTask"]
    resources = [
      "arn:${data.aws_partition.atual.partition}:ecs:${local.regiao}:${local.conta}:task-definition/${local.ops_anon_nome}:*",
    ]
  }
  statement {
    sid       = "NaoPassaPapeisDaAnonimizacao"
    effect    = "Deny"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.ops_anonimizacao_execucao.arn, aws_iam_role.ops_anonimizacao_tarefa.arn]
  }
}

resource "aws_iam_role_policy" "nega_ops_anonimizacao" {
  for_each = local.ops_anon_papeis_sem_acesso
  name     = "nega-ops-anonimizacao"
  role     = each.value
  policy   = data.aws_iam_policy_document.nega_ops_anonimizacao.json
}
