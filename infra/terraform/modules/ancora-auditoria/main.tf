# Âncora externa da auditoria encadeada (R2 do parecer do Guardião sobre o PR #37).
#
# O que é: um bucket S3 append-only onde um job periódico publica, por clínica, o último hash da
# cadeia de audit_log (ChainAnchor / auditChainHead). Quem domina o banco consegue recalcular a
# cadeia inteira; não consegue reescrever uma âncora já publicada aqui.
#
# Garantias:
#   - Object Lock em modo COMPLIANCE: nenhuma versão é apagada ou sobrescrita antes do prazo, nem
#     pelo root da conta; o prazo não pode ser encurtado.
#   - Versionamento obrigatório (exigido pelo Object Lock): publicar de novo na mesma chave cria
#     versão nova, a antiga continua lá.
#   - Só os papéis em var.publicadores_arn gravam, e só em ancoras/. O papel da API NÃO está lá.
#   - Pensado para viver numa CONTA SEPARADA (provider aws.auditoria do chamador). Na mesma conta
#     vale só para staging, porque um administrador da conta ainda poderia trocar a política do
#     bucket (não as âncoras já gravadas).
#
# Região: sempre sa-east-1 (o chamador já trava; aqui há uma precondição a mais).

terraform {
  required_version = ">= 1.11.0, < 2.0.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.68.0, < 7.0.0"
    }
  }
}

data "aws_caller_identity" "atual" {}
data "aws_partition" "atual" {}
data "aws_region" "atual" {}

locals {
  conta  = data.aws_caller_identity.atual.account_id
  bucket = "${var.prefixo_nome}-ancora-auditoria-${local.conta}"
}

resource "terraform_data" "trava_regiao" {
  lifecycle {
    precondition {
      condition     = data.aws_region.atual.region == "sa-east-1"
      error_message = "A âncora da auditoria fica em sa-east-1."
    }
  }
}

# --- Chave KMS própria (na conta da âncora) -------------------------------------------------

data "aws_iam_policy_document" "kms" {
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
    sid       = "PublicadoresCifram"
    actions   = ["kms:GenerateDataKey", "kms:Encrypt"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = var.publicadores_arn
    }
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${data.aws_region.atual.region}.amazonaws.com"]
    }
  }

  dynamic "statement" {
    for_each = length(var.leitores_arn) > 0 ? [1] : []
    content {
      sid       = "LeitoresDecifram"
      actions   = ["kms:Decrypt"]
      resources = ["*"]
      principals {
        type        = "AWS"
        identifiers = var.leitores_arn
      }
      condition {
        test     = "StringEquals"
        variable = "kms:ViaService"
        values   = ["s3.${data.aws_region.atual.region}.amazonaws.com"]
      }
    }
  }
}

resource "aws_kms_key" "ancora" {
  description             = "${var.prefixo_nome}: âncora da auditoria encadeada"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.kms.json
}

resource "aws_kms_alias" "ancora" {
  name          = "alias/${var.prefixo_nome}-ancora-auditoria"
  target_key_id = aws_kms_key.ancora.key_id
}

# --- Bucket ---------------------------------------------------------------------------------

resource "aws_s3_bucket" "ancora" {
  #checkov:skip=CKV_AWS_144:Sem replicação para outra região (dados e metadados ficam no Brasil, D8).
  #checkov:skip=CKV2_AWS_62:Sem consumidor de eventos; o verificador lê sob demanda.
  #checkov:skip=CKV_AWS_18:Acesso auditado por CloudTrail data events na conta da âncora (server access log exigiria outro bucket nessa conta).
  bucket              = local.bucket
  object_lock_enabled = true

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "ancora" {
  bucket                  = aws_s3_bucket.ancora.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "ancora" {
  bucket = aws_s3_bucket.ancora.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "ancora" {
  bucket = aws_s3_bucket.ancora.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "ancora" {
  bucket = aws_s3_bucket.ancora.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.ancora.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_object_lock_configuration" "ancora" {
  bucket = aws_s3_bucket.ancora.id
  rule {
    default_retention {
      mode = "COMPLIANCE"
      days = var.retencao_dias
    }
  }
  depends_on = [aws_s3_bucket_versioning.ancora]
}

# Nada expira por regra: o Object Lock já impediria, e a âncora vale enquanto a trilha existir.
resource "aws_s3_bucket_lifecycle_configuration" "ancora" {
  bucket = aws_s3_bucket.ancora.id
  rule {
    id     = "uploads-incompletos"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

data "aws_iam_policy_document" "bucket" {
  statement {
    sid     = "SomenteTLS"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.ancora.arn,
      "${aws_s3_bucket.ancora.arn}/*",
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

  # Só os publicadores gravam (vale também para quem tem s3:* por IAM na mesma conta).
  statement {
    sid       = "SomentePublicadoresGravam"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.ancora.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "StringNotEquals"
      variable = "aws:PrincipalArn"
      values   = var.publicadores_arn
    }
  }

  # Ninguém mexe em retenção, legal hold ou governança: o modo COMPLIANCE já trava, isto é a 2ª camada.
  statement {
    sid    = "NinguemAlteraRetencao"
    effect = "Deny"
    actions = [
      "s3:PutObjectRetention",
      "s3:PutObjectLegalHold",
      "s3:BypassGovernanceRetention",
      "s3:DeleteObjectVersion",
      "s3:PutBucketObjectLockConfiguration",
    ]
    resources = [
      aws_s3_bucket.ancora.arn,
      "${aws_s3_bucket.ancora.arn}/*",
    ]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
  }

  statement {
    sid       = "PublicadoresGravamAncoras"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.ancora.arn}/ancoras/*"]
    principals {
      type        = "AWS"
      identifiers = var.publicadores_arn
    }
    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-server-side-encryption-aws-kms-key-id"
      values   = [aws_kms_key.ancora.arn]
    }
  }

  dynamic "statement" {
    for_each = length(var.leitores_arn) > 0 ? [1] : []
    content {
      sid       = "LeitoresLeem"
      actions   = ["s3:GetObject", "s3:GetObjectVersion", "s3:ListBucket", "s3:ListBucketVersions"]
      resources = [aws_s3_bucket.ancora.arn, "${aws_s3_bucket.ancora.arn}/*"]
      principals {
        type        = "AWS"
        identifiers = var.leitores_arn
      }
    }
  }
}

# Aplicada DEPOIS do Object Lock: a política nega PutBucketObjectLockConfiguration a todos.
# Mudar a retenção padrão (ou apagar versões vencidas, ao fim do prazo da D7) exige antes tirar
# o statement NinguemAlteraRetencao, o que é uma mudança revisada em PR e visível no CloudTrail.
resource "aws_s3_bucket_policy" "ancora" {
  bucket = aws_s3_bucket.ancora.id
  policy = data.aws_iam_policy_document.bucket.json
  depends_on = [
    aws_s3_bucket_public_access_block.ancora,
    aws_s3_bucket_object_lock_configuration.ancora,
  ]
}
