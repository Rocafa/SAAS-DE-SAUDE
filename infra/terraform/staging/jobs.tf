# --- Agendador de jobs da API: alarmes (infra-staging.md §4.4, R3 do parecer 2026-10-23-jobs.md) ---
# A API loga marcadores fixos, sem dado pessoal (só nome do job, código de erro e contagens):
#   JOB_ATRASADO     job crítico (retenção, revogação, lembretes) sem sucesso dentro do prazo;
#   JOBS_DESLIGADOS  agendador sem Redis: a API subiu, mas nenhum job roda.
# Cada marcador vira um filtro de métrica no log group da API e um alarme que avisa o canal de
# operação (tópico alertas_seguranca, o único tópico de operação hoje) e o encarregado (DPO).
# Os filtros são termos exatos (sem regex), então não contam na cota de 5 regex por log group.

locals {
  jobs_namespace = "${local.nome}/jobs"

  jobs_marcadores = {
    job-atrasado = {
      termo     = "JOB_ATRASADO"
      metrica   = "JobAtrasado"
      descricao = "Job crítico da API (retenção, revogação ou lembretes) sem execução bem-sucedida no prazo. Ver o log group /${local.nome}/api (marcador JOB_ATRASADO) e api-dominio §14."
    }
    jobs-desligados = {
      termo     = "JOBS_DESLIGADOS"
      metrica   = "JobsDesligados"
      descricao = "Agendador de jobs da API desligado (sem Redis): nenhum job de retenção roda. Conferir REDIS_URL e o Redis. Ver o log group /${local.nome}/api (marcador JOBS_DESLIGADOS)."
    }
  }
}

resource "aws_cloudwatch_log_metric_filter" "jobs" {
  for_each = local.jobs_marcadores

  name           = "${local.nome}-${each.key}"
  log_group_name = aws_cloudwatch_log_group.api.name
  pattern        = "\"${each.value.termo}\""

  metric_transformation {
    name          = each.value.metrica
    namespace     = local.jobs_namespace
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "jobs" {
  for_each = local.jobs_marcadores

  alarm_name        = "${local.nome}-${each.key}"
  alarm_description = each.value.descricao

  namespace           = local.jobs_namespace
  metric_name         = each.value.metrica
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alertas_seguranca.arn, aws_sns_topic.alertas_dpo.arn]

  depends_on = [aws_cloudwatch_log_metric_filter.jobs]
}

# --- Aviso ao encarregado (DPO) ---------------------------------------------------------------
# Tópico próprio, cifrado com a chave de alertas. Assinatura por e-mail só quando houver o
# endereço (alerta_dpo_email, no tfvars, fora do git).

resource "aws_sns_topic" "alertas_dpo" {
  name              = "${local.nome}-alertas-dpo"
  kms_master_key_id = aws_kms_key.this["alertas"].arn
}

data "aws_iam_policy_document" "alertas_dpo" {
  statement {
    sid       = "CloudWatchAlarmePublica"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alertas_dpo.arn]
    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [for a in aws_cloudwatch_metric_alarm.jobs : a.arn]
    }
  }
}

resource "aws_sns_topic_policy" "alertas_dpo" {
  arn    = aws_sns_topic.alertas_dpo.arn
  policy = data.aws_iam_policy_document.alertas_dpo.json
}

resource "aws_sns_topic_subscription" "alertas_dpo_email" {
  count     = var.alerta_dpo_email == null ? 0 : 1
  topic_arn = aws_sns_topic.alertas_dpo.arn
  protocol  = "email"
  endpoint  = var.alerta_dpo_email
}
