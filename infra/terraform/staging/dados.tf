# Camada de dados: RDS PostgreSQL 16 Multi-AZ e ElastiCache Redis, ambos só na sub-rede de dados,
# cifrados por KMS e acessíveis apenas a partir das tarefas da API.

locals {
  banco = "plataforma_saude"
}

resource "aws_security_group" "rds" {
  name        = "${local.nome}-rds"
  description = "PostgreSQL: so a API entra"
  vpc_id      = aws_vpc.this.id
}

resource "aws_vpc_security_group_ingress_rule" "rds_da_api" {
  security_group_id            = aws_security_group.rds.id
  referenced_security_group_id = aws_security_group.api.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "PostgreSQL vindo das tarefas da API"
}

resource "aws_security_group" "redis" {
  name        = "${local.nome}-redis"
  description = "Redis: so a API entra"
  vpc_id      = aws_vpc.this.id
}

resource "aws_vpc_security_group_ingress_rule" "redis_da_api" {
  security_group_id            = aws_security_group.redis.id
  referenced_security_group_id = aws_security_group.api.id
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
  description                  = "Redis (TLS) vindo das tarefas da API"
}

# --- RDS ----------------------------------------------------------------------------------

resource "aws_db_subnet_group" "this" {
  name       = local.nome
  subnet_ids = aws_subnet.dados[*].id
}

resource "aws_db_parameter_group" "pg16" {
  name   = "${local.nome}-pg16"
  family = "postgres16"

  # Recusa qualquer conexão sem TLS (I14).
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  parameter {
    name  = "ssl_min_protocol_version"
    value = "TLSv1.2"
  }
  parameter {
    name  = "log_connections"
    value = "1"
  }
  parameter {
    name  = "log_disconnections"
    value = "1"
  }
  # Log do Postgres NUNCA leva valor de linha nem SQL (V2 do parecer do PR #58, item 13):
  # - log_statement = none: "ddl" gravaria o ALTER ROLE ... PASSWORD do bootstrap (senha em log);
  # - log_min_duration_statement = -1 e log_min_duration_sample = -1: sem SQL de query lenta;
  # - log_error_verbosity = terse: corta DETAIL/HINT/QUERY/CONTEXT ("Failing row contains (...)",
  #   "Key (...)=(...)" trazem nome de paciente numa violação de CHECK/UNIQUE);
  # - log_min_error_statement = panic: não grava o SQL que causou o erro;
  # - log_parameter_max_length(_on_error) = 0: nunca grava valor de parâmetro de bind.
  parameter {
    name  = "log_statement"
    value = "none"
  }
  parameter {
    name  = "log_min_duration_statement"
    value = "-1"
  }
  parameter {
    name  = "log_min_duration_sample"
    value = "-1"
  }
  parameter {
    name  = "log_error_verbosity"
    value = "terse"
  }
  parameter {
    name  = "log_min_error_statement"
    value = "panic"
  }
  parameter {
    name  = "log_parameter_max_length"
    value = "0"
  }
  parameter {
    name  = "log_parameter_max_length_on_error"
    value = "0"
  }
}

# Grupos que o RDS criaria sozinho ("nunca expira", sem KMS). Declarados ANTES da instância para
# nascerem com retenção e a chave de logs (V2). Log técnico: retenção curta (logs_retencao_dias).
resource "aws_cloudwatch_log_group" "rds" {
  #checkov:skip=CKV_AWS_338:Log técnico do banco (sem dado pessoal após o V2): retenção curta, alinhada à matriz-retencao/D7.
  for_each = toset(["postgresql", "upgrade"])

  name              = "/aws/rds/instance/${local.nome}/${each.key}"
  retention_in_days = var.logs_retencao_dias
  kms_key_id        = aws_kms_key.this["logs"].arn
}

# Enhanced Monitoring escreve métricas de SO no grupo da conta "RDSOSMetrics" (sem dado pessoal).
resource "aws_cloudwatch_log_group" "rds_os_metrics" {
  #checkov:skip=CKV_AWS_338:Métrica de SO, sem dado pessoal: retenção curta.
  name              = "RDSOSMetrics"
  retention_in_days = var.logs_retencao_dias
  kms_key_id        = aws_kms_key.this["logs"].arn
}

data "aws_iam_policy_document" "rds_monitoramento_confianca" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["monitoring.rds.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "rds_monitoramento" {
  name               = "${local.nome}-rds-monitoramento"
  assume_role_policy = data.aws_iam_policy_document.rds_monitoramento_confianca.json
}

resource "aws_iam_role_policy_attachment" "rds_monitoramento" {
  role       = aws_iam_role.rds_monitoramento.name
  policy_arn = "arn:${data.aws_partition.atual.partition}:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

resource "aws_db_instance" "this" {
  identifier     = local.nome
  engine         = "postgres"
  engine_version = "16"
  instance_class = var.rds_classe
  db_name        = local.banco

  # Senha do master gerada e guardada pelo próprio RDS no Secrets Manager (não passa pelo estado).
  username                      = "plataforma_master"
  manage_master_user_password   = true
  master_user_secret_kms_key_id = aws_kms_key.this["segredos"].arn

  multi_az               = true
  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false
  parameter_group_name   = aws_db_parameter_group.pg16.name
  ca_cert_identifier     = "rds-ca-rsa2048-g1"

  storage_type          = "gp3"
  allocated_storage     = var.rds_armazenamento_gb
  max_allocated_storage = var.rds_armazenamento_gb * 5
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.this["rds"].arn

  # PITR: o RDS guarda os WALs pelo período de retenção; 35 dias é o máximo (I5).
  backup_retention_period   = 35
  backup_window             = "05:00-06:00" # 02:00–03:00 em Brasília
  maintenance_window        = "sun:06:30-sun:07:30"
  copy_tags_to_snapshot     = true
  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "${local.nome}-final"
  delete_automated_backups  = false

  auto_minor_version_upgrade          = true
  allow_major_version_upgrade         = false
  iam_database_authentication_enabled = true
  enabled_cloudwatch_logs_exports     = ["postgresql", "upgrade"]
  monitoring_interval                 = 60
  monitoring_role_arn                 = aws_iam_role.rds_monitoramento.arn
  # Os grupos de log precisam existir antes do primeiro export (senão o RDS os cria sem expiração).
  depends_on                      = [aws_cloudwatch_log_group.rds, aws_cloudwatch_log_group.rds_os_metrics]
  performance_insights_enabled    = true
  performance_insights_kms_key_id = aws_kms_key.this["rds"].arn

  lifecycle {
    prevent_destroy = true
  }
}

# --- ElastiCache Redis (privado, TLS obrigatório + AUTH) ---------------------------------
# Privado: só nas sub-redes de dados (sem rota para a internet) e o SG só aceita a API.
# AUTH: o token NUNCA aparece em código nem no estado do Terraform. Ele nasce efêmero a cada
# execução e vai, na MESMA execução, write-only para o ElastiCache (auth_token_wo) e para o
# Secrets Manager (secret_string_wo, segredo "redis"). Os dois só recebem o valor quando
# var.redis_auth_versao muda; nas outras execuções o valor efêmero é descartado sem uso.
# A API lê REDIS_URL (rediss://) do Secrets Manager pelo papel de execução do ECS.

ephemeral "random_password" "redis_auth" {
  length  = 64
  special = false # AUTH do ElastiCache aceita só parte dos especiais; 64 alfanuméricos bastam.
}

resource "aws_elasticache_subnet_group" "this" {
  name       = local.nome
  subnet_ids = aws_subnet.dados[*].id
}

resource "aws_cloudwatch_log_group" "redis" {
  #checkov:skip=CKV_AWS_338:Staging guarda 30 dias; produção terá 1 ano.
  name              = "/${local.nome}/redis"
  retention_in_days = var.logs_retencao_dias
  kms_key_id        = aws_kms_key.this["logs"].arn
}

resource "aws_elasticache_replication_group" "this" {
  #checkov:skip=CKV_AWS_31:TLS obrigatório e AUTH ligados; o token vai em auth_token_wo (write-only, fora do estado), que o checkov ainda não reconhece.
  replication_group_id = local.nome
  description          = "Rate limit e filas (BullMQ) da ${local.nome}"
  engine               = "redis"
  engine_version       = "7.1"
  node_type            = var.redis_tipo_no
  port                 = 6379

  num_cache_clusters         = 2
  automatic_failover_enabled = true
  multi_az_enabled           = true
  subnet_group_name          = aws_elasticache_subnet_group.this.name
  security_group_ids         = [aws_security_group.redis.id]

  at_rest_encryption_enabled = true
  kms_key_id                 = aws_kms_key.this["redis"].arn
  transit_encryption_enabled = true
  transit_encryption_mode    = "required"
  auth_token_wo              = ephemeral.random_password.redis_auth.result
  auth_token_wo_version      = var.redis_auth_versao
  # ROTATE: o token novo entra e o antigo continua válido até a próxima troca com SET, então as
  # tarefas da API em execução não caem durante a rotação (ver infra-staging.md, "Rotação").
  auth_token_update_strategy = "ROTATE"

  snapshot_retention_limit   = 7
  auto_minor_version_upgrade = true
  apply_immediately          = false

  log_delivery_configuration {
    destination      = aws_cloudwatch_log_group.redis.name
    destination_type = "cloudwatch-logs"
    log_format       = "json"
    log_type         = "slow-log"
  }
}

# --- Segredos da aplicação ---------------------------------------------------------------
# Senhas de app_user e app_migrator e o token do Redis: efêmeros, gravados write-only no Secrets
# Manager (nunca no estado). O bootstrap (infra/rds/bootstrap.sh) lê as senhas do Secrets Manager
# e cria os papéis. Rotação: incrementar a variável de versão do segredo e aplicar (o valor novo é
# gerado e gravado na mesma execução); para o banco, reexecutar o bootstrap em seguida.

ephemeral "random_password" "banco" {
  for_each = toset(["app_user", "app_migrator"])
  length   = 40
  special  = false # vai dentro de URL; sem especiais não precisa de escape
}

locals {
  host_banco = aws_db_instance.this.address

  # Parte NÃO efêmera (nome, descrição, versão): pode ir em for_each.
  segredos_app = {
    "banco-app-user" = {
      descricao = "DATABASE_URL da API (papel app_user, RLS sempre aplicado)"
      versao    = var.banco_senhas_versao
    }
    "banco-app-migrator" = {
      descricao = "DATABASE_MIGRATOR_URL (papel app_migrator, só na tarefa de migração)"
      versao    = var.banco_senhas_versao
    }
    "redis" = {
      descricao = "REDIS_URL com TLS (rediss://) e AUTH"
      versao    = var.redis_auth_versao
    }
  }

  # Parte efêmera (o conteúdo): só existe durante a execução e só vai para atributos write-only.
  valores_segredos = {
    "banco-app-user" = jsonencode({
      username = "app_user"
      password = ephemeral.random_password.banco["app_user"].result
      url      = "postgres://app_user:${ephemeral.random_password.banco["app_user"].result}@${local.host_banco}:5432/${local.banco}?sslmode=verify-full"
    })
    "banco-app-migrator" = jsonencode({
      username = "app_migrator"
      password = ephemeral.random_password.banco["app_migrator"].result
      url      = "postgres://app_migrator:${ephemeral.random_password.banco["app_migrator"].result}@${local.host_banco}:5432/${local.banco}?sslmode=verify-full"
    })
    "redis" = jsonencode({
      url = "rediss://:${ephemeral.random_password.redis_auth.result}@${aws_elasticache_replication_group.this.primary_endpoint_address}:6379"
    })
  }
}

resource "aws_secretsmanager_secret" "app" {
  #checkov:skip=CKV2_AWS_57:Rotação automática entra com o I4 (Lambda de rotação); hoje rotaciona-se pela variável de versão (ver infra-staging.md).
  for_each = local.segredos_app

  name                    = "${local.nome}/${each.key}"
  description             = each.value.descricao
  kms_key_id              = aws_kms_key.this["segredos"].arn
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret_version" "app" {
  for_each = local.segredos_app

  secret_id                = aws_secretsmanager_secret.app[each.key].id
  secret_string_wo         = local.valores_segredos[each.key]
  secret_string_wo_version = each.value.versao
}
