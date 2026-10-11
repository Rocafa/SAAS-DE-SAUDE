# Buckets S3 (I15). "documentos": exportações e documentos assinados, privado, SSE-KMS, versionado,
# com Object Lock. "logs": logs de acesso do ALB e do bucket de documentos (esses serviços só
# entregam em bucket com SSE-S3, por isso ele não usa KMS).

locals {
  bucket_documentos = "${local.nome}-documentos-${local.conta}"
  bucket_logs       = "${local.nome}-logs-${local.conta}"
}

# --- documentos ---------------------------------------------------------------------------

resource "aws_s3_bucket" "documentos" {
  #checkov:skip=CKV_AWS_144:Sem replicação para outra região até a D8 (dados de saúde só no Brasil).
  #checkov:skip=CKV2_AWS_62:Notificação de eventos entra quando houver consumidor (fila de assinatura).
  bucket              = local.bucket_documentos
  object_lock_enabled = true

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "documentos" {
  bucket                  = aws_s3_bucket.documentos.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "documentos" {
  bucket = aws_s3_bucket.documentos.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "documentos" {
  bucket = aws_s3_bucket.documentos.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "documentos" {
  bucket = aws_s3_bucket.documentos.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.this["s3"].arn
    }
    bucket_key_enabled = true
  }
}

# Staging usa GOVERNANCE (dados sintéticos podem ser apagados por quem tem
# s3:BypassGovernanceRetention). Produção usará COMPLIANCE com o prazo de guarda do prontuário.
resource "aws_s3_bucket_object_lock_configuration" "documentos" {
  bucket = aws_s3_bucket.documentos.id
  rule {
    default_retention {
      mode = "GOVERNANCE"
      days = var.object_lock_dias
    }
  }
  depends_on = [aws_s3_bucket_versioning.documentos]
}

resource "aws_s3_bucket_lifecycle_configuration" "documentos" {
  bucket = aws_s3_bucket.documentos.id
  rule {
    id     = "limpeza-staging"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 30
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

resource "aws_s3_bucket_logging" "documentos" {
  bucket        = aws_s3_bucket.documentos.id
  target_bucket = aws_s3_bucket.logs.id
  target_prefix = "s3/documentos/"
}

data "aws_iam_policy_document" "documentos" {
  statement {
    sid     = "SomenteTLS"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.documentos.arn,
      "${aws_s3_bucket.documentos.arn}/*",
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
    sid       = "SomenteChaveDoProjeto"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.documentos.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "StringNotEqualsIfExists"
      variable = "s3:x-amz-server-side-encryption-aws-kms-key-id"
      values   = [aws_kms_key.this["s3"].arn]
    }
  }
}

resource "aws_s3_bucket_policy" "documentos" {
  bucket     = aws_s3_bucket.documentos.id
  policy     = data.aws_iam_policy_document.documentos.json
  depends_on = [aws_s3_bucket_public_access_block.documentos]
}

# --- logs (ALB e acesso ao S3) ------------------------------------------------------------

resource "aws_s3_bucket" "logs" {
  #checkov:skip=CKV_AWS_145:ALB e S3 server access logging só entregam em bucket com SSE-S3.
  #checkov:skip=CKV_AWS_18:É o próprio bucket de destino dos logs de acesso.
  #checkov:skip=CKV_AWS_144:Sem replicação entre regiões (D8).
  #checkov:skip=CKV2_AWS_62:Sem consumidor de eventos para logs.
  bucket = local.bucket_logs
}

resource "aws_s3_bucket_public_access_block" "logs" {
  bucket                  = aws_s3_bucket.logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "logs" {
  bucket = aws_s3_bucket.logs.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "logs" {
  bucket = aws_s3_bucket.logs.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id
  rule {
    id     = "expira-logs"
    status = "Enabled"
    filter {}
    expiration {
      days = 90
    }
    noncurrent_version_expiration {
      noncurrent_days = 7
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

data "aws_elb_service_account" "atual" {}

data "aws_iam_policy_document" "logs" {
  statement {
    sid       = "AlbEscreveLogs"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.logs.arn}/alb/AWSLogs/${local.conta}/*"]
    principals {
      type        = "AWS"
      identifiers = [data.aws_elb_service_account.atual.arn]
    }
  }
  statement {
    sid       = "S3EscreveLogsDeAcesso"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.logs.arn}/s3/*"]
    principals {
      type        = "Service"
      identifiers = ["logging.s3.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.conta]
    }
  }
  statement {
    sid     = "SomenteTLS"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.logs.arn,
      "${aws_s3_bucket.logs.arn}/*",
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
}

resource "aws_s3_bucket_policy" "logs" {
  bucket     = aws_s3_bucket.logs.id
  policy     = data.aws_iam_policy_document.logs.json
  depends_on = [aws_s3_bucket_public_access_block.logs]
}
