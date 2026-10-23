# Acesso de PESSOAS à conta (R2 e R4 do parecer do Guardião sobre o PR #58).
#
# Humanos entram por SSO (IAM Identity Center, I1) com MFA e sessão curta. Nenhum papel humano
# do dia a dia lê logs de acesso nem decifra dado de clínica. Para isso existem dois papéis de
# exceção, assumidos só por humano com MFA, com sessão de 1 h e uso registrado no CloudTrail:
#   - investigacao-seguranca: lê o bucket "logs" (URLs do ALB, IPs, acessos aos buckets). R2.
#   - break-glass: decifra com as chaves rds, s3, exportacoes e as KEKs das clínicas. Todo uso
#     gera alerta (EventBridge -> SNS). R4.
# Os permission sets do SSO são do I1 (fora deste Terraform); aqui ficam os padrões de ARN que
# identificam um humano, usados nos Deny das chaves KMS.

locals {
  # Quem é humano: papéis do SSO, usuários IAM e o root. Estende-se com papeis_humanos_extra.
  principais_humanos = concat(
    [
      "arn:${data.aws_partition.atual.partition}:iam::${local.conta}:role/aws-reserved/sso.amazonaws.com/*",
      "arn:${data.aws_partition.atual.partition}:iam::${local.conta}:user/*",
      "arn:${data.aws_partition.atual.partition}:iam::${local.conta}:root",
    ],
    var.papeis_humanos_extra,
  )
}

# Confiança comum aos papéis de exceção: só humano da própria conta, com MFA recente.
data "aws_iam_policy_document" "confianca_humano_mfa" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.atual.partition}:iam::${local.conta}:root"]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:PrincipalArn"
      values   = local.principais_humanos
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

# --- investigacao-seguranca (R2) ---------------------------------------------------------------

resource "aws_iam_role" "investigacao_seguranca" {
  name                 = "${local.nome}-investigacao-seguranca"
  description          = "Leitura do bucket de logs de acesso (ALB e S3) para investigação de incidente. R2 do PR #58."
  assume_role_policy   = data.aws_iam_policy_document.confianca_humano_mfa.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "investigacao_seguranca" {
  statement {
    sid       = "ListarLogs"
    actions   = ["s3:ListBucket", "s3:ListBucketVersions"]
    resources = [aws_s3_bucket.logs.arn]
  }
  statement {
    sid       = "LerLogs"
    actions   = ["s3:GetObject", "s3:GetObjectVersion"]
    resources = ["${aws_s3_bucket.logs.arn}/*"]
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

resource "aws_iam_role_policy" "investigacao_seguranca" {
  name   = "ler-logs-de-acesso"
  role   = aws_iam_role.investigacao_seguranca.id
  policy = data.aws_iam_policy_document.investigacao_seguranca.json
}

# --- break-glass (R4) --------------------------------------------------------------------------
# Único papel humano que decifra com as chaves rds, s3, exportacoes, segredos e as KEKs das
# clínicas (o Deny "HumanoNaoDecifra" de kms.tf não o alcança: o ARN dele não é de humano).
# Uso só em incidente, registrado no relatório do incidente; cada chamada gera alerta.

resource "aws_iam_role" "break_glass" {
  name                 = "${local.nome}-break-glass"
  description          = "Acesso de emergência a dado cifrado. Todo uso gera alerta. R4 do PR #58."
  assume_role_policy   = data.aws_iam_policy_document.confianca_humano_mfa.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "break_glass" {
  #checkov:skip=CKV_AWS_356:KEKs nascem em tempo de execução (ARN desconhecido); o escopo é pela tag tenant_id (ABAC).
  statement {
    sid       = "DecifrarChavesDeInfra"
    actions   = ["kms:Decrypt", "kms:DescribeKey"]
    resources = [for k in local.chaves_sem_humanos : aws_kms_key.this[k].arn]
  }
  statement {
    sid       = "DecifrarKekDeClinica"
    actions   = ["kms:Decrypt", "kms:DescribeKey"]
    resources = ["*"]
    condition {
      test     = "Null"
      variable = "aws:ResourceTag/tenant_id"
      values   = ["false"]
    }
  }
  statement {
    sid       = "LerDocumentos"
    actions   = ["s3:GetObject", "s3:GetObjectVersion", "s3:ListBucket"]
    resources = [aws_s3_bucket.documentos.arn, "${aws_s3_bucket.documentos.arn}/*"]
  }
  statement {
    sid       = "LerSegredos"
    actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
    resources = [for s in aws_secretsmanager_secret.app : s.arn]
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

resource "aws_iam_role_policy" "break_glass" {
  name   = "acesso-de-emergencia"
  role   = aws_iam_role.break_glass.id
  policy = data.aws_iam_policy_document.break_glass.json
}

# --- Alerta de uso dos papéis de exceção ------------------------------------------------------
# O EventBridge recebe os eventos do CloudTrail da região, inclusive os de leitura (kms:Decrypt,
# GetSecretValue), por ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS, e publica no tópico SNS.
# Assinatura por e-mail quando houver o responsável (alerta_seguranca_email, no tfvars).

resource "aws_sns_topic" "alertas_seguranca" {
  name              = "${local.nome}-alertas-seguranca"
  kms_master_key_id = aws_kms_key.this["alertas"].arn
}

locals {
  papeis_de_excecao = [aws_iam_role.break_glass.arn, aws_iam_role.investigacao_seguranca.arn]
}

resource "aws_cloudwatch_event_rule" "papeis_de_excecao" {
  name        = "${local.nome}-uso-papeis-de-excecao"
  description = "Uso do break-glass ou da investigação de segurança (R2/R4 do PR #58)."
  state       = "ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS"
  event_pattern = jsonencode({
    "detail-type" = ["AWS API Call via CloudTrail"]
    detail = {
      "$or" = [
        # Qualquer chamada feita com um dos papéis.
        { userIdentity = { sessionContext = { sessionIssuer = { arn = local.papeis_de_excecao } } } },
        # O próprio AssumeRole (quando feito pelo endpoint regional do STS).
        { eventName = ["AssumeRole"], requestParameters = { roleArn = local.papeis_de_excecao } },
      ]
    }
  })
}

resource "aws_cloudwatch_event_target" "papeis_de_excecao" {
  rule = aws_cloudwatch_event_rule.papeis_de_excecao.name
  arn  = aws_sns_topic.alertas_seguranca.arn
}

data "aws_iam_policy_document" "alertas_seguranca" {
  statement {
    sid       = "EventBridgePublica"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alertas_seguranca.arn]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_event_rule.papeis_de_excecao.arn]
    }
  }
  # Alarme de DDL sensível no banco (auditoria-banco.tf, R11 do PR #61) e alarmes do
  # agendador de jobs da API (jobs.tf, R3 do parecer de jobs).
  statement {
    sid       = "CloudWatchAlarmePublica"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alertas_seguranca.arn]
    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values = concat(
        [aws_cloudwatch_metric_alarm.ddl_sensivel.arn, aws_cloudwatch_metric_alarm.jobs_ready.arn],
        [for a in aws_cloudwatch_metric_alarm.jobs : a.arn],
      )
    }
  }
}

resource "aws_sns_topic_policy" "alertas_seguranca" {
  arn    = aws_sns_topic.alertas_seguranca.arn
  policy = data.aws_iam_policy_document.alertas_seguranca.json
}

resource "aws_sns_topic_subscription" "alertas_seguranca_email" {
  count     = var.alerta_seguranca_email == null ? 0 : 1
  topic_arn = aws_sns_topic.alertas_seguranca.arn
  protocol  = "email"
  endpoint  = var.alerta_seguranca_email
}
