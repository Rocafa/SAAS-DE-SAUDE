# Estado remoto do Terraform da conta STAGING: bucket S3 cifrado por KMS + tabela DynamoDB de trava.
# Aplicado UMA vez por conta, com estado local (é o ovo da galinha); depois disso o diretório
# ../staging usa este bucket como backend. Nada aqui foi aplicado.

terraform {
  required_version = ">= 1.10.0, < 2.0.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.60.0, < 7.0.0"
    }
  }
}

provider "aws" {
  region              = var.regiao
  allowed_account_ids = [var.conta_aws_id]
  default_tags {
    tags = {
      projeto    = "plataforma-saude"
      ambiente   = "staging"
      gerenciado = "terraform"
    }
  }
}

data "aws_region" "atual" {}

resource "terraform_data" "trava_regiao" {
  lifecycle {
    precondition {
      condition     = data.aws_region.atual.region == "sa-east-1"
      error_message = "Provider apontando para região fora de sa-east-1."
    }
  }
}

locals {
  bucket = "plataforma-saude-staging-tfstate-${var.conta_aws_id}"
  tabela = "plataforma-saude-staging-tflock"
}

data "aws_iam_policy_document" "kms_estado" {
  #checkov:skip=CKV_AWS_109:Key policy: "*" significa esta chave; administração fica com a conta (padrão da AWS).
  #checkov:skip=CKV_AWS_111:Key policy: "*" significa esta chave; administração fica com a conta (padrão da AWS).
  #checkov:skip=CKV_AWS_356:Key policy: "*" significa esta chave; administração fica com a conta (padrão da AWS).
  statement {
    sid       = "AdministracaoPelaConta"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.conta_aws_id}:root"]
    }
  }
}

resource "aws_kms_key" "estado" {
  description             = "Cifra o estado do Terraform de staging"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.kms_estado.json
}

resource "aws_kms_alias" "estado" {
  name          = "alias/plataforma-saude-staging-tfstate"
  target_key_id = aws_kms_key.estado.key_id
}

resource "aws_s3_bucket" "estado" {
  #checkov:skip=CKV_AWS_144:Replicação entre regiões fica fora até a D8 (dados só no Brasil).
  #checkov:skip=CKV2_AWS_62:Estado do Terraform não precisa de notificação de eventos.
  #checkov:skip=CKV_AWS_18:Acesso ao estado é auditado pelo CloudTrail (data events), não por server access logs.
  bucket = local.bucket
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "estado" {
  bucket                  = aws_s3_bucket.estado.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "estado" {
  bucket = aws_s3_bucket.estado.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "estado" {
  bucket = aws_s3_bucket.estado.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "estado" {
  bucket = aws_s3_bucket.estado.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.estado.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "estado" {
  bucket = aws_s3_bucket.estado.id
  rule {
    id     = "versoes-antigas"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 90
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

data "aws_iam_policy_document" "estado_tls" {
  statement {
    sid     = "SomenteTLS"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.estado.arn,
      "${aws_s3_bucket.estado.arn}/*",
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

resource "aws_s3_bucket_policy" "estado" {
  bucket = aws_s3_bucket.estado.id
  policy = data.aws_iam_policy_document.estado_tls.json
}

resource "aws_dynamodb_table" "trava" {
  name         = local.tabela
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.estado.arn
  }

  point_in_time_recovery {
    enabled = true
  }

  deletion_protection_enabled = true
}
