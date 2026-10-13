# Bucket "exportacoes" (V1 do parecer do Guardião sobre o PR #58; garantia G2).
#
# Guarda o pacote de exportação da clínica (a base inteira, que a aplicação também cifra antes de
# subir) apenas enquanto o link de 24 h vale. Por isso:
#   - SEM Object Lock: o pacote tem de poder ser apagado (G2/G3, LGPD art. 16);
#   - expira a versão corrente em var.exportacao_expiracao_dias (<= 7) e a não corrente em 1 dia;
#     o lifecycle do S3 é assíncrono (pode atrasar até ~1 dia), então a aplicação também apaga
#     o objeto quando o link vence;
#   - chave KMS própria ("exportacoes"): desabilitá-la invalida todas as exportações de uma vez;
#   - só o papel da TAREFA da API lê e grava (gera o pacote e assina o link). Deny explícito para
#     qualquer outro principal, inclusive administradores com s3:* por IAM.

locals {
  bucket_exportacoes = "${local.nome}-exportacoes-${local.conta}"
}

resource "aws_s3_bucket" "exportacoes" {
  #checkov:skip=CKV_AWS_144:Sem replicação para outra região (dados de saúde só no Brasil, D8).
  #checkov:skip=CKV2_AWS_62:Sem consumidor de eventos; a aplicação gera o link na mesma transação.
  bucket = local.bucket_exportacoes
}

resource "aws_s3_bucket_public_access_block" "exportacoes" {
  bucket                  = aws_s3_bucket.exportacoes.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "exportacoes" {
  bucket = aws_s3_bucket.exportacoes.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Versionamento ligado só para o checkov e para proteger contra sobrescrita acidental; as versões
# antigas morrem em 1 dia pelo lifecycle abaixo.
resource "aws_s3_bucket_versioning" "exportacoes" {
  bucket = aws_s3_bucket.exportacoes.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "exportacoes" {
  bucket = aws_s3_bucket.exportacoes.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.this["exportacoes"].arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "exportacoes" {
  bucket = aws_s3_bucket.exportacoes.id
  rule {
    id     = "exportacao-efemera"
    status = "Enabled"
    filter {}
    expiration {
      days = var.exportacao_expiracao_dias
    }
    noncurrent_version_expiration {
      noncurrent_days = 1
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
  # Limpa os marcadores de exclusão que sobram depois que as versões expiram.
  rule {
    id     = "marcadores-de-exclusao"
    status = "Enabled"
    filter {}
    expiration {
      expired_object_delete_marker = true
    }
  }
}

resource "aws_s3_bucket_logging" "exportacoes" {
  bucket        = aws_s3_bucket.exportacoes.id
  target_bucket = aws_s3_bucket.logs.id
  target_prefix = "s3/exportacoes/"
}

data "aws_iam_policy_document" "exportacoes" {
  statement {
    sid     = "SomenteTLS"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.exportacoes.arn,
      "${aws_s3_bucket.exportacoes.arn}/*",
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

  # Conteúdo só para a tarefa da API (e o link pré-assinado, que é assinado por ela).
  statement {
    sid    = "SomenteATarefaDaApi"
    effect = "Deny"
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
      "s3:PutObject",
      "s3:RestoreObject",
    ]
    resources = ["${aws_s3_bucket.exportacoes.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "StringNotEquals"
      variable = "aws:PrincipalArn"
      values   = [aws_iam_role.api_tarefa.arn]
    }
  }

  statement {
    sid       = "SomenteChaveDeExportacao"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.exportacoes.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "StringNotEqualsIfExists"
      variable = "s3:x-amz-server-side-encryption-aws-kms-key-id"
      values   = [aws_kms_key.this["exportacoes"].arn]
    }
  }
}

resource "aws_s3_bucket_policy" "exportacoes" {
  bucket     = aws_s3_bucket.exportacoes.id
  policy     = data.aws_iam_policy_document.exportacoes.json
  depends_on = [aws_s3_bucket_public_access_block.exportacoes]
}

# Permissão do lado da tarefa da API.
data "aws_iam_policy_document" "api_exportacoes" {
  statement {
    sid       = "GravarELerExportacoes"
    actions   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.exportacoes.arn}/*"]
  }
  statement {
    sid       = "CifrarExportacoes"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [aws_kms_key.this["exportacoes"].arn]
  }
}

resource "aws_iam_role_policy" "api_exportacoes" {
  name   = "exportacoes"
  role   = aws_iam_role.api_tarefa.id
  policy = data.aws_iam_policy_document.api_exportacoes.json
}
