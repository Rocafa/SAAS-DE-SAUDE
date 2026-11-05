# Trilha do CloudTrail (R3 do parecer do Guardião sobre o PR #58). CONDIÇÃO para o 1º apply.
#
# - Multirregião: registra chamadas em QUALQUER região (inclusive tentativa de usar outra região,
#   o que a trava de sa-east-1 deveria impedir). Os arquivos ficam só no bucket em sa-east-1.
# - Eventos de gerenciamento (inclui KMS Decrypt/GenerateDataKey e Secrets Manager
#   GetSecretValue: quem abriu chave ou segredo) e data events de S3 nos buckets sensíveis
#   (estado do Terraform, documentos, exportações e âncora quando estiver nesta conta) e as
#   leituras do bucket "logs" (N2).
# - Validação de integridade dos arquivos (digest assinado) ligada.
# - Bucket próprio: SSE-KMS com chave própria, versionado, Object Lock COMPLIANCE pelo prazo
#   var.trilha_retencao_dias (12 meses, proposta da D7 para registros de acesso; Marco Civil
#   pede no mínimo 6), sem acesso público, só TLS.
# Organização: quando o I1 (AWS Organizations) existir, esta trilha vira trilha da organização
# numa conta de log separada; o desenho do bucket é o mesmo.

locals {
  trilha_nome   = "${local.nome}-trilha"
  trilha_arn    = "arn:${data.aws_partition.atual.partition}:cloudtrail:${local.regiao}:${local.conta}:trail/${local.trilha_nome}"
  bucket_trilha = "${local.nome}-cloudtrail-${local.conta}"
  # Buckets cujas leituras/gravações de objeto entram como data events.
  buckets_auditados = compact([
    "plataforma-saude-staging-tfstate-${local.conta}", # bootstrap-state
    aws_s3_bucket.documentos.bucket,
    aws_s3_bucket.exportacoes.bucket,
    var.conta_auditoria_id == null ? module.ancora_auditoria.bucket : "",
  ])
}

# --- Chave KMS da trilha ----------------------------------------------------------------------

data "aws_iam_policy_document" "kms_trilha" {
  #checkov:skip=CKV_AWS_109:Key policy: "*" significa esta chave; administração fica com a conta (padrão da AWS).
  #checkov:skip=CKV_AWS_111:Key policy: "*" significa esta chave; administração fica com a conta (padrão da AWS).
  #checkov:skip=CKV_AWS_356:Key policy: "*" significa esta chave; administração fica com a conta (padrão da AWS).
  statement {
    sid       = "AdministracaoPelaConta"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.atual.partition}:iam::${local.conta}:root"]
    }
  }
  statement {
    sid       = "CloudTrailCifra"
    actions   = ["kms:GenerateDataKey*"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.trilha_arn]
    }
    condition {
      test     = "StringLike"
      variable = "kms:EncryptionContext:aws:cloudtrail:arn"
      values   = ["arn:${data.aws_partition.atual.partition}:cloudtrail:*:${local.conta}:trail/*"]
    }
  }
  statement {
    sid       = "CloudTrailDescreve"
    actions   = ["kms:DescribeKey"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.trilha_arn]
    }
  }
}

resource "aws_kms_key" "trilha" {
  description             = "${local.nome}: CloudTrail"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.kms_trilha.json
}

resource "aws_kms_alias" "trilha" {
  name          = "alias/${local.nome}-cloudtrail"
  target_key_id = aws_kms_key.trilha.key_id
}

# --- Bucket da trilha -------------------------------------------------------------------------

resource "aws_s3_bucket" "trilha" {
  #checkov:skip=CKV_AWS_144:Sem replicação para outra região (D8).
  #checkov:skip=CKV2_AWS_62:Sem consumidor de eventos; alertas entram com o GuardDuty/I1.
  bucket              = local.bucket_trilha
  object_lock_enabled = true

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "trilha" {
  bucket                  = aws_s3_bucket.trilha.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "trilha" {
  bucket = aws_s3_bucket.trilha.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "trilha" {
  bucket = aws_s3_bucket.trilha.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "trilha" {
  bucket = aws_s3_bucket.trilha.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.trilha.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_object_lock_configuration" "trilha" {
  bucket = aws_s3_bucket.trilha.id
  rule {
    default_retention {
      mode = "COMPLIANCE"
      days = var.trilha_retencao_dias
    }
  }
  depends_on = [aws_s3_bucket_versioning.trilha]
}

# Depois do prazo, o arquivo expira (a trilha tem prazo definido, não é eterna).
resource "aws_s3_bucket_lifecycle_configuration" "trilha" {
  bucket = aws_s3_bucket.trilha.id
  rule {
    id     = "prazo-da-trilha"
    status = "Enabled"
    filter {}
    expiration {
      days = var.trilha_retencao_dias + 1
    }
    noncurrent_version_expiration {
      noncurrent_days = 1
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

resource "aws_s3_bucket_logging" "trilha" {
  bucket        = aws_s3_bucket.trilha.id
  target_bucket = aws_s3_bucket.logs.id
  target_prefix = "s3/cloudtrail/"
}

data "aws_iam_policy_document" "trilha" {
  statement {
    sid     = "SomenteTLS"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.trilha.arn,
      "${aws_s3_bucket.trilha.arn}/*",
    ]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
  statement {
    sid       = "CloudTrailConfereAcl"
    actions   = ["s3:GetBucketAcl"]
    resources = [aws_s3_bucket.trilha.arn]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.trilha_arn]
    }
  }
  statement {
    sid       = "CloudTrailGrava"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.trilha.arn}/AWSLogs/${local.conta}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.trilha_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }
  }
  # Ninguém mexe na retenção (2ª camada sobre o COMPLIANCE).
  statement {
    sid    = "NinguemAlteraRetencao"
    effect = "Deny"
    actions = [
      "s3:PutObjectRetention",
      "s3:PutObjectLegalHold",
      "s3:BypassGovernanceRetention",
      "s3:PutBucketObjectLockConfiguration",
    ]
    resources = [
      aws_s3_bucket.trilha.arn,
      "${aws_s3_bucket.trilha.arn}/*",
    ]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
  }
}

resource "aws_s3_bucket_policy" "trilha" {
  bucket = aws_s3_bucket.trilha.id
  policy = data.aws_iam_policy_document.trilha.json
  depends_on = [
    aws_s3_bucket_public_access_block.trilha,
    aws_s3_bucket_object_lock_configuration.trilha,
  ]
}

# --- Trilha -----------------------------------------------------------------------------------

resource "aws_cloudtrail" "this" {
  #checkov:skip=CKV2_AWS_10:Entrega no CloudWatch Logs entra com os alertas de segurança (I1/GuardDuty); a guarda é o S3 com Object Lock.
  #checkov:skip=CKV_AWS_252:Notificação SNS por arquivo entregue não tem consumidor ainda.
  name                          = local.trilha_nome
  s3_bucket_name                = aws_s3_bucket.trilha.id
  kms_key_id                    = aws_kms_key.trilha.arn
  is_multi_region_trail         = true
  include_global_service_events = true
  enable_log_file_validation    = true
  enable_logging                = true

  advanced_event_selector {
    name = "Gerenciamento (inclui KMS e Secrets Manager)"
    field_selector {
      field  = "eventCategory"
      equals = ["Management"]
    }
  }

  advanced_event_selector {
    name = "Objetos dos buckets sensiveis"
    field_selector {
      field  = "eventCategory"
      equals = ["Data"]
    }
    field_selector {
      field  = "resources.type"
      equals = ["AWS::S3::Object"]
    }
    field_selector {
      field       = "resources.ARN"
      starts_with = [for b in local.buckets_auditados : "arn:${data.aws_partition.atual.partition}:s3:::${b}/"]
    }
  }

  # Bucket "logs" (N2 do PR #58): só as LEITURAS. As gravações são do ALB e do S3 entregando log a
  # cada poucos minutos; registrá-las só geraria volume e custo, sem dizer quem leu.
  advanced_event_selector {
    name = "Leituras do bucket de logs de acesso"
    field_selector {
      field  = "eventCategory"
      equals = ["Data"]
    }
    field_selector {
      field  = "resources.type"
      equals = ["AWS::S3::Object"]
    }
    field_selector {
      field  = "readOnly"
      equals = ["true"]
    }
    field_selector {
      field       = "resources.ARN"
      starts_with = ["${aws_s3_bucket.logs.arn}/"]
    }
  }

  depends_on = [aws_s3_bucket_policy.trilha]
}
