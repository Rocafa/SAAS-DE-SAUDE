# Chave mestra (KEK) por clínica, item 22 do parecer do Guardião sobre o PR #35.
#
# As KEKs NÃO são criadas pelo Terraform: nascem em tempo de execução, uma por clínica, pelo
# KmsKeyProvider (apps/api/src/modules/crypto/kms-key-provider.ts), com a tag tenant_id e
# EncryptionContext { tenant_id }. O Terraform prepara as permissões, separando:
#   - GESTOR de chaves (job de onboarding e eliminação): cria, liga rotação, agenda e cancela a
#     destruição. Não gera nem abre DEK.
#   - API: só GenerateDataKey e Decrypt, e só em chave com tag tenant_id e com EncryptionContext
#     tenant_id. Não cria nem destrói chave.
# O controle é por atributo (ABAC): a tag tenant_id identifica uma KEK de clínica. As chaves de
# infraestrutura (kms.tf) não têm essa tag, e um Deny explícito impede que alguém as "adote"
# colocando a tag.
#
# Custo e limites (FATO/ESTIMATIVA com fonte em docs/04-arquitetura/infra-staging.md §4):
# US$ 1/mês por chave (+US$ 1 em cada uma das 2 primeiras rotações), cota padrão de 100.000
# chaves por conta e região.

locals {
  # As chaves de infraestrutura e a da âncora nunca podem receber a tag tenant_id.
  chaves_infra_arn = concat(
    [for k in aws_kms_key.this : k.arn],
    [module.ancora_auditoria.kms_key_arn, aws_kms_key.trilha.arn],
  )
}

# --- Gestor de chaves (job de onboarding e eliminação; ainda não existe, o papel fica pronto) ---

resource "aws_iam_role" "gestor_chaves" {
  name               = "${local.nome}-gestor-chaves"
  assume_role_policy = data.aws_iam_policy_document.ecs_confianca.json
}

data "aws_iam_policy_document" "gestor_chaves" {
  #checkov:skip=CKV_AWS_111:KEKs nascem em tempo de execução (ARN desconhecido); o escopo é por tag tenant_id (ABAC) e por condições de KeySpec/MultiRegion.
  #checkov:skip=CKV_AWS_356:KEKs nascem em tempo de execução (ARN desconhecido); o escopo é por tag tenant_id (ABAC).
  statement {
    sid       = "CriarKekDeClinica"
    actions   = ["kms:CreateKey"]
    resources = ["*"] # CreateKey não aceita recurso específico
    condition {
      test     = "Null"
      variable = "aws:RequestTag/tenant_id"
      values   = ["false"]
    }
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = ["tenant_id"]
    }
    condition {
      test     = "StringEquals"
      variable = "kms:KeySpec"
      values   = ["SYMMETRIC_DEFAULT"]
    }
    condition {
      test     = "StringEquals"
      variable = "kms:KeyUsage"
      values   = ["ENCRYPT_DECRYPT"]
    }
    condition {
      test     = "StringEquals"
      variable = "kms:KeyOrigin"
      values   = ["AWS_KMS"]
    }
    # Chave multirregião replicaria o material para fora do Brasil.
    condition {
      test     = "BoolIfExists"
      variable = "kms:MultiRegion"
      values   = ["false"]
    }
    condition {
      test     = "BoolIfExists"
      variable = "kms:BypassPolicyLockoutSafetyCheck"
      values   = ["false"]
    }
  }

  # CreateKey com Tags exige kms:TagResource; só a tag tenant_id.
  statement {
    sid       = "TagDaKekNaCriacao"
    actions   = ["kms:TagResource"]
    resources = ["*"]
    condition {
      test     = "Null"
      variable = "aws:RequestTag/tenant_id"
      values   = ["false"]
    }
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = ["tenant_id"]
    }
  }

  statement {
    sid = "GerirKekDeClinica"
    actions = [
      "kms:DescribeKey",
      "kms:EnableKeyRotation",
      "kms:GetKeyRotationStatus",
      "kms:EnableKey",
      "kms:CancelKeyDeletion",
      # Rotação por suspeita (rotateMasterKey): ReEncrypt dentro do KMS, a DEK não sai em claro.
      "kms:ReEncryptFrom",
      "kms:ReEncryptTo",
    ]
    resources = ["*"]
    condition {
      test     = "Null"
      variable = "aws:ResourceTag/tenant_id"
      values   = ["false"]
    }
  }

  statement {
    sid       = "AgendarDestruicaoComJanela"
    actions   = ["kms:ScheduleKeyDeletion"]
    resources = ["*"]
    condition {
      test     = "Null"
      variable = "aws:ResourceTag/tenant_id"
      values   = ["false"]
    }
    condition {
      test     = "NumericGreaterThanEquals"
      variable = "kms:ScheduleKeyDeletionPendingWindowInDays"
      values   = [tostring(var.kek_janela_exclusao_dias)]
    }
  }

  # Alias é opcional (o ARN da KEK fica no banco); se usado, só sob alias/<nome>/clinica/.
  statement {
    sid     = "AliasDeClinica"
    actions = ["kms:CreateAlias", "kms:DeleteAlias", "kms:UpdateAlias"]
    resources = [
      "arn:${data.aws_partition.atual.partition}:kms:${local.regiao}:${local.conta}:alias/${local.nome}/clinica/*",
    ]
  }
  statement {
    sid       = "AliasApontaSoParaKekDeClinica"
    actions   = ["kms:CreateAlias", "kms:DeleteAlias", "kms:UpdateAlias"]
    resources = ["arn:${data.aws_partition.atual.partition}:kms:${local.regiao}:${local.conta}:key/*"]
    condition {
      test     = "Null"
      variable = "aws:ResourceTag/tenant_id"
      values   = ["false"]
    }
  }

  statement {
    sid       = "NuncaAsChavesDeInfra"
    effect    = "Deny"
    actions   = ["kms:*"]
    resources = local.chaves_infra_arn
  }
}

resource "aws_iam_role_policy" "gestor_chaves" {
  name   = "gerir-kek-de-clinica"
  role   = aws_iam_role.gestor_chaves.id
  policy = data.aws_iam_policy_document.gestor_chaves.json
}

# --- API: só gera e abre DEK da clínica ------------------------------------------------------

data "aws_iam_policy_document" "api_kek" {
  #checkov:skip=CKV_AWS_356:KEKs nascem em tempo de execução (ARN desconhecido); o escopo é por tag tenant_id e EncryptionContext.
  statement {
    sid       = "DekDaClinica"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = ["*"]
    condition {
      test     = "Null"
      variable = "aws:ResourceTag/tenant_id"
      values   = ["false"]
    }
    condition {
      test     = "Null"
      variable = "kms:EncryptionContext:tenant_id"
      values   = ["false"]
    }
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "kms:EncryptionContextKeys"
      values   = ["tenant_id"]
    }
  }
}

resource "aws_iam_role_policy" "api_kek" {
  name   = "dek-da-clinica"
  role   = aws_iam_role.api_tarefa.id
  policy = data.aws_iam_policy_document.api_kek.json
}
