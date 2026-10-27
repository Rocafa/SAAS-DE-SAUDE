# API no ECS Fargate atrás de um ALB com WAF. A imagem é a mesma promovida para prod (tag = SHA).

locals {
  api_porta = 3333 # API_PORT (apps/api/src/config.ts)
  # Health check do ALB: SEMPRE /health (liveness). /health/ready depende do banco; se o ALB usasse
  # readiness, uma queda do RDS tiraria todas as tarefas do balanceador de uma vez e o ECS ficaria
  # reciclando contêineres saudáveis. O infra.yml falha se este valor mudar.
  alb_health_check_path = "/health"
}

# --- ECR ------------------------------------------------------------------------------------

resource "aws_ecr_repository" "api" {
  name                 = "${local.nome}/api"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.this["ecr"].arn
  }
}

resource "aws_ecr_lifecycle_policy" "api" {
  repository = aws_ecr_repository.api.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Mantém as 50 imagens mais recentes"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 50
      }
      action = { type = "expire" }
    }]
  })
}

# --- Grupos de segurança -----------------------------------------------------------------

resource "aws_security_group" "alb" {
  name        = "${local.nome}-alb"
  description = "ALB publico: so HTTPS"
  vpc_id      = aws_vpc.this.id
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "HTTPS da internet (filtrado pelo WAF)"
}

resource "aws_vpc_security_group_egress_rule" "alb_para_api" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.api.id
  ip_protocol                  = "tcp"
  from_port                    = local.api_porta
  to_port                      = local.api_porta
  description                  = "Somente para as tarefas da API"
}

resource "aws_security_group" "api" {
  name        = "${local.nome}-api"
  description = "Tarefas da API: entrada so do ALB"
  vpc_id      = aws_vpc.this.id
}

resource "aws_vpc_security_group_ingress_rule" "api_do_alb" {
  security_group_id            = aws_security_group.api.id
  referenced_security_group_id = aws_security_group.alb.id
  ip_protocol                  = "tcp"
  from_port                    = local.api_porta
  to_port                      = local.api_porta
  description                  = "HTTP vindo do ALB"
}

resource "aws_vpc_security_group_egress_rule" "api_https" {
  security_group_id = aws_security_group.api.id
  cidr_ipv4         = var.cidr_vpc
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "VPC endpoints (ECR, Secrets, KMS, Logs)"
}

resource "aws_vpc_security_group_egress_rule" "api_s3" {
  security_group_id = aws_security_group.api.id
  prefix_list_id    = aws_vpc_endpoint.s3.prefix_list_id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "S3 pelo gateway endpoint (camadas do ECR, documentos)"
}

resource "aws_vpc_security_group_egress_rule" "api_rds" {
  security_group_id            = aws_security_group.api.id
  referenced_security_group_id = aws_security_group.rds.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "PostgreSQL"
}

resource "aws_vpc_security_group_egress_rule" "api_redis" {
  security_group_id            = aws_security_group.api.id
  referenced_security_group_id = aws_security_group.redis.id
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
  description                  = "Redis"
}

# --- ECS ------------------------------------------------------------------------------------

resource "aws_ecs_cluster" "this" {
  name = local.nome
  setting {
    name  = "containerInsights"
    value = "enhanced"
  }
  depends_on = [aws_cloudwatch_log_group.container_insights]
}

# O Container Insights criaria este grupo sozinho, sem expiração e sem KMS (V2 do PR #58).
resource "aws_cloudwatch_log_group" "container_insights" {
  #checkov:skip=CKV_AWS_338:Métrica de desempenho, sem dado pessoal: retenção curta.
  name              = "/aws/ecs/containerinsights/${local.nome}/performance"
  retention_in_days = var.logs_retencao_dias
  kms_key_id        = aws_kms_key.this["logs"].arn
}

resource "aws_cloudwatch_log_group" "api" {
  #checkov:skip=CKV_AWS_338:Registro de acesso: logs_acesso_retencao_dias (staging 30; prod 365 proposto à D7, mínimo 180 pelo Marco Civil).
  name              = "/${local.nome}/api"
  retention_in_days = var.logs_acesso_retencao_dias
  kms_key_id        = aws_kms_key.this["logs"].arn
}

data "aws_iam_policy_document" "ecs_confianca" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.conta]
    }
  }
}

# Papel de EXECUÇÃO: o agente do ECS puxa a imagem, lê os segredos e escreve logs.
resource "aws_iam_role" "api_execucao" {
  name               = "${local.nome}-api-execucao"
  assume_role_policy = data.aws_iam_policy_document.ecs_confianca.json
}

data "aws_iam_policy_document" "api_execucao" {
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
    resources = ["${aws_cloudwatch_log_group.api.arn}:*"]
  }
  # Leitura mínima: só os segredos que a tarefa da API referencia (nunca banco-app-migrator).
  statement {
    sid       = "SegredosDaApi"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = local.api_segredos_arns
  }
  statement {
    sid       = "Decifrar"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.this["segredos"].arn, aws_kms_key.this["ecr"].arn]
  }
}

resource "aws_iam_role_policy" "api_execucao" {
  name   = "execucao"
  role   = aws_iam_role.api_execucao.id
  policy = data.aws_iam_policy_document.api_execucao.json
}

# Papel da TAREFA (o processo Node): só gera e abre DEK das clínicas (política em kms-clinicas.tf).
resource "aws_iam_role" "api_tarefa" {
  name               = "${local.nome}-api-tarefa"
  assume_role_policy = data.aws_iam_policy_document.ecs_confianca.json
}

# Contrato da tarefa da API (infra-staging.md §4.4, R3 do parecer 2026-10-23-jobs.md).
# REDIS_URL é obrigatório: sem ele a API sobe SEM o agendador de jobs (retenção, revogação,
# lembretes) e só loga JOBS_DESLIGADOS. As precondições da task definition fazem o plano falhar
# antes disso. JOBS_HABILITADOS=false nunca entra aqui (desligar jobs só com incidente registrado).
locals {
  api_ambiente = concat([
    { name = "NODE_ENV", value = "production" },
    { name = "API_PORT", value = tostring(local.api_porta) },
    # CA do RDS para sslmode=verify-full; o arquivo precisa estar na imagem (item 1, Dockerfile).
    { name = "NODE_EXTRA_CA_CERTS", value = "/app/certs/rds-sa-east-1-bundle.pem" },
    ],
    # R6: a API sobe HTTPS com certificado autoassinado gerado em memória (contrato com a ENG).
    var.tls_ate_a_tarefa ? [{ name = "API_TLS", value = "autoassinado" }] : [],
    # §4.5: variáveis NÃO secretas, com valor seguro por padrão.
    [
      # Atrás do ALB: sem isto o rate limit por IP contaria todo mundo como o IP do ALB.
      { name = "HTTP_TRUST_PROXY_HOPS", value = "1" },
      { name = "IMPORTADOR_HABILITADO", value = tostring(var.importador_habilitado) },
      { name = "WHATSAPP_PROVEDOR", value = var.whatsapp_provedor },
      { name = "SUPPORT_PSEUDONYM_KMS_KEY_ID", value = aws_kms_key.pseudonimo_suporte.arn },
      # Cliente KMS da API (kms-client.ts): região explícita, só sa-east-1 (lista fechada na API).
      # Sem depender da variável que o agente do Fargate injeta; o plano falha se sumir.
      { name = "AWS_REGION", value = local.regiao },
    ],
    length(var.cors_origens) > 0 ? [{ name = "CORS_ALLOWED_ORIGINS", value = join(",", var.cors_origens) }] : [],
    var.whatsapp_provedor == "cloud_api" ? [{ name = "WHATSAPP_WABA_ID", value = var.whatsapp_waba_id }] : [],
    var.whatsapp_provedor == "cloud_api" && var.whatsapp_clausulas_padrao_assinadas ? [{ name = "WHATSAPP_R17_CLAUSULAS_PADRAO", value = "assinadas" }] : [],
  )

  # Segredo -> segredo do Secrets Manager. Toda chave daqui entra (e só ela) na política de leitura.
  api_segredos_origem = merge(
    {
      DATABASE_URL          = { segredo = aws_secretsmanager_secret.app["banco-app-user"].arn, campo = "url" }
      REDIS_URL             = { segredo = aws_secretsmanager_secret.app["redis"].arn, campo = "url" }
      PAGINATION_CURSOR_KEY = { segredo = aws_secretsmanager_secret.app["pagination-cursor-key"].arn, campo = "chave" }
      RATE_LIMIT_HASH_KEY   = { segredo = aws_secretsmanager_secret.app["rate-limit-hash-key"].arn, campo = "chave" }
    },
    var.whatsapp_provedor == "cloud_api" ? {
      WHATSAPP_ACCESS_TOKEN         = { segredo = one(aws_secretsmanager_secret.whatsapp[*].arn), campo = "access_token" }
      WHATSAPP_APP_SECRET           = { segredo = one(aws_secretsmanager_secret.whatsapp[*].arn), campo = "app_secret" }
      WHATSAPP_WEBHOOK_VERIFY_TOKEN = { segredo = one(aws_secretsmanager_secret.whatsapp[*].arn), campo = "webhook_verify_token" }
    } : {},
  )

  api_segredos      = [for nome, s in local.api_segredos_origem : { name = nome, valueFrom = "${s.segredo}:${s.campo}::" }]
  api_segredos_arns = distinct([for s in local.api_segredos_origem : s.segredo])

  # Contrato com a API (branch eng/integracao-r19): sem estes, a API não sobe com NODE_ENV=production.
  api_segredos_obrigatorios = ["DATABASE_URL", "REDIS_URL", "PAGINATION_CURSOR_KEY", "RATE_LIMIT_HASH_KEY"]
  api_ambiente_obrigatorio  = ["NODE_ENV", "API_PORT", "HTTP_TRUST_PROXY_HOPS", "IMPORTADOR_HABILITADO", "WHATSAPP_PROVEDOR", "SUPPORT_PSEUDONYM_KMS_KEY_ID", "AWS_REGION"]
  # Nunca na tarefa da API: credencial de migração/admin, segredo local de dev, chave do pseudônimo
  # fora do KMS, rate limit por instância, jobs desligados (§4.4), TLS sem validação.
  api_variaveis_proibidas = [
    "DATABASE_ADMIN_URL", "DATABASE_MIGRATOR_URL", "SUPPORT_PSEUDONYM_KEY", "FIELD_KEYS_DEV_ROOT_SECRET",
    "RATE_LIMIT_ALLOW_SINGLE_INSTANCE", "JOBS_HABILITADOS", "NODE_TLS_REJECT_UNAUTHORIZED", "AUTH_PROVIDER", "PORTAL_AUTH_PROVIDER",
  ]
  # K-a/K-b (revisoes/2026-10-25-pr76.md, "Conferência cursor v2 e boot KMS"): a tarefa usa SÓ a
  # role (cadeia padrão do SDK via AWS_CONTAINER_CREDENTIALS_RELATIVE_URI, que o ECS injeta e fica
  # permitida). Qualquer outra porta da cadeia de credenciais ou desvio de endpoint é vetada.
  # Mais os prefixos AWS_ENDPOINT_URL* (precondição por startswith, abaixo).
  api_variaveis_aws_proibidas = [
    "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_AUTHORIZATION_TOKEN", "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_ROLE_ARN", "AWS_SHARED_CREDENTIALS_FILE", "AWS_CONFIG_FILE", "AWS_EC2_METADATA_SERVICE_ENDPOINT",
    "KMS_ENDPOINT",
  ]
  api_prefixos_aws_proibidos = ["AWS_ENDPOINT_URL"]
  api_nomes_ambiente = [for v in local.api_ambiente : v.name]
  api_nomes_segredos = [for s in local.api_segredos : s.name]
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.nome}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.api_execucao.arn
  task_role_arn            = aws_iam_role.api_tarefa.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  volume {
    name = "tmp"
  }

  container_definitions = jsonencode([{
    name                   = "api"
    image                  = "${aws_ecr_repository.api.repository_url}:${var.api_imagem_tag}"
    essential              = true
    readonlyRootFilesystem = true
    user                   = "1000:1000"
    command                = ["node", "dist/main.js"]
    stopTimeout            = 30
    linuxParameters        = { initProcessEnabled = true }
    portMappings           = [{ containerPort = local.api_porta, protocol = "tcp" }]
    mountPoints            = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
    environment            = local.api_ambiente
    secrets                = local.api_segredos
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.api.name
        awslogs-region        = local.regiao
        awslogs-stream-prefix = "api"
      }
    }
  }])

  lifecycle {
    precondition {
      condition     = contains([for s in local.api_segredos : s.name], "REDIS_URL") && contains(keys(local.segredos_app), "redis")
      error_message = "REDIS_URL é obrigatório na tarefa da API, vindo do segredo \"redis\" do Secrets Manager. Sem ele os jobs de retenção ficam desligados (JOBS_DESLIGADOS). Ver infra-staging.md §4.4."
    }
    precondition {
      condition     = aws_elasticache_replication_group.this.transit_encryption_enabled == true
      error_message = "O Redis do REDIS_URL precisa de TLS (rediss://) e AUTH; transit_encryption_enabled está desligado."
    }
    precondition {
      condition     = !contains(concat([for v in local.api_ambiente : v.name], [for s in local.api_segredos : s.name]), "JOBS_HABILITADOS")
      error_message = "Não defina JOBS_HABILITADOS na tarefa da API em staging/produção (infra-staging.md §4.4). Desligar os jobs só com incidente registrado."
    }
    # §4.5 / C1 do parecer 2026-10-25-pr76: cada segredo obrigatório vem do Secrets Manager (nunca
    # em environment, em texto claro) e cada chave HMAC tem o seu segredo.
    precondition {
      condition     = length(setsubtract(local.api_segredos_obrigatorios, local.api_nomes_segredos)) == 0 && length(setintersection(local.api_segredos_obrigatorios, local.api_nomes_ambiente)) == 0
      error_message = "Faltam segredos obrigatórios da API em `secrets` (DATABASE_URL, REDIS_URL, PAGINATION_CURSOR_KEY, RATE_LIMIT_HASH_KEY), ou algum foi posto em `environment`. Sem eles a API não sobe com NODE_ENV=production. Ver infra-staging.md §4.5."
    }
    precondition {
      condition     = local.api_segredos_origem["PAGINATION_CURSOR_KEY"].segredo != local.api_segredos_origem["RATE_LIMIT_HASH_KEY"].segredo
      error_message = "PAGINATION_CURSOR_KEY e RATE_LIMIT_HASH_KEY precisam de segredos distintos (C1 do parecer 2026-10-25-pr76)."
    }
    precondition {
      condition     = length(setsubtract(local.api_ambiente_obrigatorio, local.api_nomes_ambiente)) == 0
      error_message = "Falta variável obrigatória em `environment` da API (NODE_ENV, API_PORT, HTTP_TRUST_PROXY_HOPS, IMPORTADOR_HABILITADO, WHATSAPP_PROVEDOR, SUPPORT_PSEUDONYM_KMS_KEY_ID, AWS_REGION). Ver infra-staging.md §4.5."
    }
    precondition {
      condition     = one([for v in local.api_ambiente : v.value if v.name == "AWS_REGION"]) == "sa-east-1"
      error_message = "AWS_REGION da API precisa ser sa-east-1 (a API recusa outra região para o KMS). Ver infra-staging.md §4.5."
    }
    # K-a/K-b: só a role da tarefa; nada de credencial fixa, outra porta da cadeia do SDK ou endpoint alternativo.
    precondition {
      condition = length(setintersection(local.api_variaveis_aws_proibidas, concat(local.api_nomes_ambiente, local.api_nomes_segredos))) == 0 && length([
        for n in concat(local.api_nomes_ambiente, local.api_nomes_segredos) : n
        if anytrue([for p in local.api_prefixos_aws_proibidos : startswith(n, p)])
      ]) == 0
      error_message = "Credencial AWS fixa, outra porta da cadeia de credenciais (AWS_ROLE_ARN, AWS_WEB_IDENTITY_TOKEN_FILE, AWS_CONTAINER_CREDENTIALS_FULL_URI, arquivos de config...) ou endpoint alternativo (AWS_ENDPOINT_URL*, KMS_ENDPOINT, AWS_EC2_METADATA_SERVICE_ENDPOINT) na tarefa da API. A tarefa usa só a role. Ver infra-staging.md §4.5."
    }
    precondition {
      condition     = length(setintersection(local.api_variaveis_proibidas, concat(local.api_nomes_ambiente, local.api_nomes_segredos))) == 0
      error_message = "Variável proibida na tarefa da API (DATABASE_ADMIN_URL, DATABASE_MIGRATOR_URL, SUPPORT_PSEUDONYM_KEY, FIELD_KEYS_DEV_ROOT_SECRET, RATE_LIMIT_ALLOW_SINGLE_INSTANCE, JOBS_HABILITADOS, NODE_TLS_REJECT_UNAUTHORIZED, AUTH_PROVIDER, PORTAL_AUTH_PROVIDER). Ver infra-staging.md §4.5."
    }
    precondition {
      condition     = var.whatsapp_provedor != "cloud_api" || (var.whatsapp_clausulas_padrao_assinadas && var.whatsapp_waba_id != "" && length(setsubtract(["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_APP_SECRET", "WHATSAPP_WEBHOOK_VERIFY_TOKEN"], local.api_nomes_segredos)) == 0)
      error_message = "whatsapp_provedor = cloud_api exige cláusulas-padrão da ANPD assinadas (R17), whatsapp_waba_id e as três credenciais no segredo whatsapp. Ver infra-staging.md §4.5."
    }
  }
}

resource "aws_ecs_service" "api" {
  name             = "api"
  cluster          = aws_ecs_cluster.this.id
  task_definition  = aws_ecs_task_definition.api.arn
  desired_count    = var.api_tarefas
  launch_type      = "FARGATE"
  platform_version = "LATEST"

  health_check_grace_period_seconds  = 30
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  propagate_tags                     = "SERVICE"

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = aws_subnet.app[*].id
    security_groups  = [aws_security_group.api.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = local.api_porta
  }

  depends_on = [aws_lb_listener.https]
}

# --- ALB --------------------------------------------------------------------------------

resource "aws_lb" "this" {
  name                       = local.nome
  load_balancer_type         = "application"
  internal                   = false
  subnets                    = aws_subnet.publica[*].id
  security_groups            = [aws_security_group.alb.id]
  drop_invalid_header_fields = true
  enable_deletion_protection = true
  # C1-b (revisoes/2026-10-25-pr76.md): explícito, sem depender do padrão da AWS. O ALB ACRESCENTA
  # o IP de quem conectou ao fim do X-Forwarded-For; HTTP_TRUST_PROXY_HOPS=1 lê só esse salto.
  # preserve = o cliente escolhe o IP do rate limit; remove = todos viram o mesmo IP. §4.5.
  xff_header_processing_mode = "append"

  access_logs {
    bucket  = aws_s3_bucket.logs.id
    prefix  = "alb"
    enabled = true
  }

  depends_on = [aws_s3_bucket_policy.logs]
}

# ALB -> tarefa (R6 do parecer do PR #58). Com tls_ate_a_tarefa = true, o target group fala HTTPS
# com a tarefa (o ALB cifra mas não valida o certificado do alvo; um certificado autoassinado gerado
# na subida do contêiner basta) e a API recebe API_TLS=autoassinado. Depende da ENG: a API ainda
# só escuta HTTP, então ligar antes disso derruba o health check. Proposta: true em prod; em
# staging (dado sintético, R8) fica false até a API suportar.
resource "aws_lb_target_group" "api" {
  name                 = "${local.nome}-${var.tls_ate_a_tarefa ? "apis" : "api"}" # nome muda: create_before_destroy
  port                 = local.api_porta
  protocol             = var.tls_ate_a_tarefa ? "HTTPS" : "HTTP"
  target_type          = "ip"
  vpc_id               = aws_vpc.this.id
  deregistration_delay = 30

  # Trocar o protocolo recria o target group; o novo nasce antes para o listener não ficar sem alvo.
  lifecycle {
    create_before_destroy = true
  }

  health_check {
    protocol            = var.tls_ate_a_tarefa ? "HTTPS" : "HTTP"
    path                = local.alb_health_check_path
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-Res-2021-06"
  certificate_arn   = var.certificado_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

# --- WAF --------------------------------------------------------------------------------

locals {
  waf_regras_gerenciadas = {
    AWSManagedRulesAmazonIpReputationList = 10
    AWSManagedRulesCommonRuleSet          = 20
    AWSManagedRulesSQLiRuleSet            = 40
  }
}

resource "aws_wafv2_web_acl" "this" {
  name  = local.nome
  scope = "REGIONAL"

  default_action {
    allow {}
  }

  dynamic "rule" {
    for_each = local.waf_regras_gerenciadas
    content {
      name     = rule.key
      priority = rule.value
      override_action {
        none {}
      }
      statement {
        managed_rule_group_statement {
          name        = rule.key
          vendor_name = "AWS"
        }
      }
      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = rule.key
        sampled_requests_enabled   = true
      }
    }
  }

  # Fora do dynamic para o checkov enxergar a proteção contra Log4Shell (CKV_AWS_192).
  rule {
    name     = "AWSManagedRulesKnownBadInputsRuleSet"
    priority = 30
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "AWSManagedRulesKnownBadInputsRuleSet"
      sampled_requests_enabled   = true
    }
  }

  # IPs anônimos (Tor, proxies abertos) bloqueados. HostingProviderIPList só conta: os smoke tests
  # do CI saem de runners em nuvem e seriam barrados. Também fecha o CKV2_AWS_76 do checkov, que
  # exige este grupo junto com o KnownBadInputs.
  rule {
    name     = "AWSManagedRulesAnonymousIpList"
    priority = 5
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesAnonymousIpList"
        vendor_name = "AWS"
        rule_action_override {
          name = "HostingProviderIPList"
          action_to_use {
            count {}
          }
        }
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "AWSManagedRulesAnonymousIpList"
      sampled_requests_enabled   = true
    }
  }

  # Teto por IP antes do rate limit da própria API (que usa Redis).
  rule {
    name     = "limite-por-ip"
    priority = 1
    action {
      block {}
    }
    statement {
      rate_based_statement {
        limit              = 1000
        aggregate_key_type = "IP"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "limite-por-ip"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = local.nome
    sampled_requests_enabled   = true
  }
}

resource "aws_wafv2_web_acl_association" "alb" {
  resource_arn = aws_lb.this.arn
  web_acl_arn  = aws_wafv2_web_acl.this.arn
}

resource "aws_cloudwatch_log_group" "waf" {
  #checkov:skip=CKV_AWS_338:Registro de acesso: logs_acesso_retencao_dias (staging 30; prod 365 proposto à D7, mínimo 180 pelo Marco Civil).
  name              = "aws-waf-logs-${local.nome}" # prefixo exigido pelo WAF
  retention_in_days = var.logs_acesso_retencao_dias
  kms_key_id        = aws_kms_key.this["logs"].arn
}

resource "aws_wafv2_web_acl_logging_configuration" "this" {
  resource_arn            = aws_wafv2_web_acl.this.arn
  log_destination_configs = [aws_cloudwatch_log_group.waf.arn]

  # Cabeçalhos com credencial nunca vão para o log.
  redacted_fields {
    single_header {
      name = "authorization"
    }
  }
  redacted_fields {
    single_header {
      name = "cookie"
    }
  }
  # Query string pode trazer texto de busca (nome de paciente): nunca vai para o log (R1 do PR #58).
  redacted_fields {
    query_string {}
  }
}
