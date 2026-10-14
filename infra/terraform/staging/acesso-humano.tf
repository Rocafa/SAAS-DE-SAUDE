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
