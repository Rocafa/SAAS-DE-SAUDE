# Uma chave KMS por domínio: revogar ou auditar uma não afeta as outras.
locals {
  chaves_kms = {
    rds         = "RDS PostgreSQL (dados e Performance Insights)"
    redis       = "ElastiCache Redis"
    s3          = "Bucket S3 de documentos assinados"
    exportacoes = "Bucket S3 de exportações (efêmero; chave própria para revogar o acesso a todas de uma vez)"
    segredos    = "Secrets Manager"
    logs        = "CloudWatch Logs (app, RDS, Redis, Container Insights, VPC flow logs, WAF)"
    ecr         = "Imagens no ECR"
  }
}

data "aws_iam_policy_document" "kms" {
  #checkov:skip=CKV_AWS_109:Key policy: "*" significa esta chave; administração fica com a conta (padrão da AWS).
  #checkov:skip=CKV_AWS_111:Key policy: "*" significa esta chave; administração fica com a conta (padrão da AWS).
  #checkov:skip=CKV_AWS_356:Key policy: "*" significa esta chave; administração fica com a conta (padrão da AWS).
  for_each = local.chaves_kms

  statement {
    sid       = "AdministracaoPelaConta"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.atual.partition}:iam::${local.conta}:root"]
    }
  }

  dynamic "statement" {
    for_each = each.key == "logs" ? [1] : []
    content {
      sid = "CloudWatchLogs"
      actions = [
        "kms:Encrypt*",
        "kms:Decrypt*",
        "kms:ReEncrypt*",
        "kms:GenerateDataKey*",
        "kms:Describe*",
      ]
      resources = ["*"]
      principals {
        type        = "Service"
        identifiers = ["logs.${local.regiao}.amazonaws.com"]
      }
      condition {
        test     = "ArnLike"
        variable = "kms:EncryptionContext:aws:logs:arn"
        values   = ["arn:${data.aws_partition.atual.partition}:logs:${local.regiao}:${local.conta}:log-group:*"]
      }
    }
  }
}

resource "aws_kms_key" "this" {
  for_each = local.chaves_kms

  description             = "${local.nome}: ${each.value}"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.kms[each.key].json
}

resource "aws_kms_alias" "this" {
  for_each = local.chaves_kms

  name          = "alias/${local.nome}-${each.key}"
  target_key_id = aws_kms_key.this[each.key].key_id
}
