# --- Alarme de `jobs` ≠ `bullmq` no /health/ready (R3 do parecer de jobs, infra-staging.md §4.4) ---
# Por que um canary: a API não loga o modo do agendador; `nao_iniciado` (agendar() pendurado) não
# tem log nenhum e pode durar para sempre. Opções avaliadas:
#   - métrica a partir de log: não há linha de log com o estado (só JOBS_DESLIGADOS/JOBS_NAO_AGENDADOS,
#     já alarmados em jobs.tf); exigiria mudança na API.
#   - health check do ALB: só olha o status HTTP, não lê o corpo.
#   - health check do Route53 (HTTPS_STR_MATCH): lê o corpo, mas a métrica só existe em us-east-1;
#     alarme e tópico SNS teriam de ficar fora de sa-east-1 (trava de região do projeto).
#   - CloudWatch Synthetics em sa-east-1 (escolhido): a cada 5 min lê /health/ready pelo ALB e falha
#     se jobs != "bullmq".
# Alarme: 3 leituras com falha em 6 (30 min). Tudo fora = alarme em 15 min (3 seguidas). Com várias
# tarefas, o ALB distribui as leituras e uma tarefa presa só derruba parte delas; o "3 em 6" pega esse
# caso intermitente (com 2 tarefas, metade das leituras cai na presa). Limite aceito: com muitas
# tarefas e só uma presa, pode não fechar 3 em 6; se os jobs pararem de fato, o JOB_ATRASADO cobre.

resource "aws_synthetics_canary" "jobs_ready" {
  name                 = "jobs-ready-stg" # até 21 caracteres
  artifact_s3_location = "s3://${aws_s3_bucket.logs.bucket}/synthetics/"
  execution_role_arn   = aws_iam_role.canary_jobs_ready.arn
  handler              = "index.handler"
  zip_file             = "${path.module}/canary/jobs-ready.zip" # fonte: canary/index.js (o CI compara)
  runtime_version      = var.canary_runtime
  start_canary         = true

  success_retention_period = 7
  failure_retention_period = 14

  schedule {
    expression = "rate(5 minutes)"
  }

  run_config {
    timeout_in_seconds = 30
    active_tracing     = false
    environment_variables = {
      URL_READY = "https://${aws_lb.this.dns_name}/health/ready"
    }
  }

  artifact_config {
    s3_encryption {
      encryption_mode = "SSE_S3" # o bucket logs é SSE-S3 (exigência da entrega do ALB)
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "jobs_ready" {
  alarm_name        = "${local.nome}-alta-jobs-nao-bullmq"
  alarm_description = "[ALTA] /health/ready da API com jobs diferente de bullmq (nao_iniciado, desligado ou memoria) ou ilegível em 3 leituras de 6 (30 min; tudo fora = 15 min). Mensagem de erro do canary jobs-ready-stg: jobs=<modo>. Ver JOBS_DESLIGADOS/JOBS_NAO_AGENDADOS no log group /${local.nome}/api e api-dominio §14."

  namespace   = "CloudWatchSynthetics"
  metric_name = "SuccessPercent"
  dimensions = {
    CanaryName = aws_synthetics_canary.jobs_ready.name
  }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 6
  datapoints_to_alarm = 3
  threshold           = 100
  comparison_operator = "LessThanThreshold"
  # Canary parado ou sem rodar também é falha: sem leitura, não há garantia de jobs.
  treat_missing_data = "breaching"

  alarm_actions = [aws_sns_topic.alertas_seguranca.arn]

  tags = { severidade = "alta" }
}

# --- Papel do canary ---------------------------------------------------------------------------
# Só grava artefatos no prefixo synthetics/ do bucket logs (lifecycle logs_bucket_retencao_dias) e
# publica métrica no namespace do Synthetics. Sem permissão de CloudWatch Logs de propósito: o grupo
# /aws/lambda/cwsyn-* nasceria sem retenção nem KMS; o log de cada execução já vai para o S3.

data "aws_iam_policy_document" "canary_confianca" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.atual.account_id]
    }
  }
}

resource "aws_iam_role" "canary_jobs_ready" {
  name               = "${local.nome}-canary-jobs-ready"
  assume_role_policy = data.aws_iam_policy_document.canary_confianca.json
}

data "aws_iam_policy_document" "canary_jobs_ready" {
  #checkov:skip=CKV_AWS_356:ListAllMyBuckets e PutMetricData não aceitam recurso específico; PutMetricData limitado ao namespace por condição.
  #checkov:skip=CKV_AWS_290:PutMetricData só aceita "*"; a condição cloudwatch:namespace limita ao CloudWatchSynthetics.
  statement {
    sid       = "ArtefatosNoBucketLogs"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.logs.arn}/synthetics/*"]
  }
  statement {
    sid       = "LocalDoBucket"
    actions   = ["s3:GetBucketLocation"]
    resources = [aws_s3_bucket.logs.arn]
  }
  statement {
    sid       = "ListaBucketsExigidaPeloSynthetics"
    actions   = ["s3:ListAllMyBuckets"]
    resources = ["*"]
  }
  statement {
    sid       = "MetricaDoSynthetics"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["CloudWatchSynthetics"]
    }
  }
}

resource "aws_iam_role_policy" "canary_jobs_ready" {
  name   = "canary-jobs-ready"
  role   = aws_iam_role.canary_jobs_ready.id
  policy = data.aws_iam_policy_document.canary_jobs_ready.json
}
