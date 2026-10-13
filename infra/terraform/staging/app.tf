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
  #checkov:skip=CKV_AWS_338:Staging guarda 30 dias; produção terá 1 ano.
  name              = "/${local.nome}/api"
  retention_in_days = var.logs_retencao_dias
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
  statement {
    sid     = "SegredosDaApi"
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      aws_secretsmanager_secret.app["banco-app-user"].arn,
      aws_secretsmanager_secret.app["redis"].arn,
    ]
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
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "API_PORT", value = tostring(local.api_porta) },
      # CA do RDS para sslmode=verify-full; o arquivo precisa estar na imagem (item 1, Dockerfile).
      { name = "NODE_EXTRA_CA_CERTS", value = "/app/certs/rds-sa-east-1-bundle.pem" },
    ]
    secrets = [
      { name = "DATABASE_URL", valueFrom = "${aws_secretsmanager_secret.app["banco-app-user"].arn}:url::" },
      { name = "REDIS_URL", valueFrom = "${aws_secretsmanager_secret.app["redis"].arn}:url::" },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.api.name
        awslogs-region        = local.regiao
        awslogs-stream-prefix = "api"
      }
    }
  }])
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

  access_logs {
    bucket  = aws_s3_bucket.logs.id
    prefix  = "alb"
    enabled = true
  }

  depends_on = [aws_s3_bucket_policy.logs]
}

resource "aws_lb_target_group" "api" {
  name                 = "${local.nome}-api"
  port                 = local.api_porta
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = aws_vpc.this.id
  deregistration_delay = 30

  health_check {
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
  #checkov:skip=CKV_AWS_338:Staging guarda 30 dias; produção terá 1 ano.
  name              = "aws-waf-logs-${local.nome}" # prefixo exigido pelo WAF
  retention_in_days = var.logs_retencao_dias
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
