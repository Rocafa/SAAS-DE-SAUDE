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
    alertas     = "Tópico SNS de alertas de segurança (uso do break-glass)"
    backup      = "Cofre do AWS Backup (backup mensal imutável, R7)"
  }

  # Chaves que guardam dado de clínica ou credencial: humano não decifra (R4 do PR #58).
  chaves_sem_humanos = ["rds", "s3", "exportacoes", "segredos", "backup"]

  # Das chaves sem humanos, as únicas em que um serviço integrado cria grant no apply feito com SSO
  # (condição 1 do Guardião, conferência de 27/10 no parecer do #76). Só nelas o Deny de CreateGrant
  # tem a exceção kms:GrantIsForAWSResource; nas demais ele é puro, igual ao da API. O CI confere.
  chaves_grant_de_servico = ["rds", "backup"]
}

# R4 do PR #58: nenhum principal HUMANO (SSO, usuário IAM, root) abre dado com estas chaves, nem
# administrador com kms:* por IAM. Só serviços e papéis de máquina (tarefa da API, RDS, Secrets
# Manager a pedido da tarefa) e o papel break-glass (acesso-humano.tf), cujo uso gera alerta.
# Decrypt, ReEncrypt e CreateGrant (este com exceção só em rds/backup, abaixo): GenerateDataKey continua liberado para o apply gravar segredos
# write-only. As KEKs das clínicas nascem fora do Terraform: a API monta o MESMO statement
# (Sid HumanoNaoDecifra; CreateGrant chega na API pelo #73) na key policy de cada chave de clínica e de lote, na função
# politicaDaChaveDaClinica (apps/api/src/modules/crypto/kms-key-provider.ts, #73 15e3303), a partir
# dos 3 padrões fixos de local.principais_humanos + KMS_PAPEIS_HUMANOS_EXTRA (= papeis_humanos_extra,
# injetada em app.tf). O CI ("Travas do projeto") compara os padrões fixos e as ações dos dois lados.
#
# kms:CreateGrant (recomendação do Guardião, conferência de 27/10 no parecer do #76): sem ele, um
# humano poderia dar Decrypt por grant a um papel de máquina que ele consegue assumir, e o grant não
# casa com os padrões humanos. Dois documentos, escolhidos por chave em "kms" abaixo:
# - kms_deny_humanos: Deny PURO, sem exceção. Referência da API (output kms_deny_humanos) e o que vale
#   em s3, exportacoes e segredos (S3 e Secrets Manager chamam o KMS com a credencial de quem pede;
#   não há grant de serviço a preservar).
# - kms_deny_humanos_grant_servico: o mesmo statement com a exceção de grant pedido por um serviço
#   integrado em nome do humano (kms:GrantIsForAWSResource = true), que o apply feito com SSO precisa
#   (o RDS e o AWS Backup criam grants nas chaves "rds" e "backup" ao criar a instância e o cofre).
#   Só em local.chaves_grant_de_servico. O KMS só põe essa chave de condição nos pedidos de grant; em
#   Decrypt/ReEncrypt ela não existe, o BoolIfExists casa e o Deny continua total.
# Todo CreateGrant segue alertando pela K-c5 (kms_administracao).
data "aws_iam_policy_document" "kms_deny_humanos" {
  statement {
    sid       = "HumanoNaoDecifra"
    effect    = "Deny"
    actions   = ["kms:Decrypt", "kms:ReEncrypt*", "kms:CreateGrant"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["*"]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:PrincipalArn"
      values   = local.principais_humanos
    }
  }
}

data "aws_iam_policy_document" "kms_deny_humanos_grant_servico" {
  statement {
    sid       = "HumanoNaoDecifra"
    effect    = "Deny"
    actions   = ["kms:Decrypt", "kms:ReEncrypt*", "kms:CreateGrant"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["*"]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:PrincipalArn"
      values   = local.principais_humanos
    }
    condition {
      test     = "BoolIfExists"
      variable = "kms:GrantIsForAWSResource"
      values   = ["false"]
    }
  }
}

data "aws_iam_policy_document" "kms" {
  #checkov:skip=CKV_AWS_109:Key policy: "*" significa esta chave; administração fica com a conta (padrão da AWS).
  #checkov:skip=CKV_AWS_111:Key policy: "*" significa esta chave; administração fica com a conta (padrão da AWS).
  #checkov:skip=CKV_AWS_356:Key policy: "*" significa esta chave; administração fica com a conta (padrão da AWS).
  for_each = local.chaves_kms

  # Sem humanos: Deny puro, salvo rds/backup (exceção de grant de serviço; condição 1 do Guardião).
  source_policy_documents = (
    !contains(local.chaves_sem_humanos, each.key) ? [] :
    contains(local.chaves_grant_de_servico, each.key) ? [data.aws_iam_policy_document.kms_deny_humanos_grant_servico.json] :
    [data.aws_iam_policy_document.kms_deny_humanos.json]
  )

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

  # EventBridge e alarmes do CloudWatch publicam no tópico SNS cifrado de alertas.
  dynamic "statement" {
    for_each = each.key == "alertas" ? [1] : []
    content {
      sid       = "EventBridgePublicaAlerta"
      actions   = ["kms:GenerateDataKey*", "kms:Decrypt"]
      resources = ["*"]
      principals {
        type        = "Service"
        identifiers = ["events.amazonaws.com", "cloudwatch.amazonaws.com"]
      }
      condition {
        test     = "StringEquals"
        variable = "aws:SourceAccount"
        values   = [local.conta]
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
