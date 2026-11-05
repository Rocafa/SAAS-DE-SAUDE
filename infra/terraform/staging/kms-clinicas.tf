# Chave mestra (KEK) por clínica, item 22 do parecer do Guardião sobre o PR #35, e chave
# descartável por lote do importador (R3/R3-b do parecer do importador, rodada 22; api-dominio.md
# §12d, ambientes-e-devops.md §1).
#
# Nenhuma dessas chaves é criada pelo Terraform: nascem em tempo de execução pelo KmsKeyProvider
# (apps/api/src/modules/crypto/kms-key-provider.ts), com EncryptionContext { tenant_id } e com as
# tags NA CRIAÇÃO:
#   - chave da clínica: tenant_id + purpose=tenant_data (liga rotação anual);
#   - chave de lote:    tenant_id + purpose=import_batch + batch_id (vive ≤ 7 dias).
# O Terraform prepara as permissões, separando:
#   - GESTOR de chaves (onboarding e eliminação da clínica, G3): só chave purpose=tenant_data;
#     cria, liga rotação, agenda e cancela a destruição. Não gera nem abre DEK.
#   - API: cria os dois tipos, gera/abre DEK com EncryptionContext igual à tag tenant_id, liga
#     rotação só na da clínica e agenda a exclusão SÓ da chave de lote. Nunca cancela a exclusão
#     de chave de lote nem exclui chave de clínica.
# O controle é por atributo (ABAC): as tags tenant_id/purpose identificam as chaves. As chaves de
# infraestrutura (kms.tf) não têm essas tags, e um Deny explícito impede que alguém as "adote"
# colocando a tag. A tag não muda depois da criação (Untag negado; Tag negado em chave existente).
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

  kms_tags_permitidas = ["tenant_id", "purpose", "batch_id"]

  # Condições comuns de CreateKey: simétrica, material do KMS, nunca multirregião (o material
  # sairia do Brasil), sem pular a trava de lockout da key policy.
  kms_criacao_segura = [
    { test = "StringEquals", variable = "kms:KeySpec", values = ["SYMMETRIC_DEFAULT"] },
    { test = "StringEquals", variable = "kms:KeyUsage", values = ["ENCRYPT_DECRYPT"] },
    { test = "StringEquals", variable = "kms:KeyOrigin", values = ["AWS_KMS"] },
    { test = "BoolIfExists", variable = "kms:MultiRegion", values = ["false"] },
    { test = "BoolIfExists", variable = "kms:BypassPolicyLockoutSafetyCheck", values = ["false"] },
  ]
}

# --- Gestor de chaves (onboarding e eliminação da clínica; ainda não existe, o papel fica pronto) ---

resource "aws_iam_role" "gestor_chaves" {
  name               = "${local.nome}-gestor-chaves"
  assume_role_policy = data.aws_iam_policy_document.ecs_confianca.json
}

data "aws_iam_policy_document" "gestor_chaves" {
  #checkov:skip=CKV_AWS_111:KEKs nascem em tempo de execução (ARN desconhecido); o escopo é por tag purpose/tenant_id (ABAC) e por condições de KeySpec/MultiRegion.
  #checkov:skip=CKV_AWS_356:KEKs nascem em tempo de execução (ARN desconhecido); o escopo é por tag purpose/tenant_id (ABAC).
  statement {
    sid       = "CriarKekDeClinica"
    actions   = ["kms:CreateKey"]
    resources = ["*"] # CreateKey não aceita recurso específico
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/purpose"
      values   = ["tenant_data"]
    }
    condition {
      test     = "Null"
      variable = "aws:RequestTag/tenant_id"
      values   = ["false"]
    }
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = ["tenant_id", "purpose"]
    }
    dynamic "condition" {
      for_each = local.kms_criacao_segura
      content {
        test     = condition.value.test
        variable = condition.value.variable
        values   = condition.value.values
      }
    }
  }

  # CreateKey com Tags exige kms:TagResource; só tenant_id + purpose=tenant_data.
  statement {
    sid       = "TagDaKekNaCriacao"
    actions   = ["kms:TagResource"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/purpose"
      values   = ["tenant_data"]
    }
    condition {
      test     = "Null"
      variable = "aws:RequestTag/tenant_id"
      values   = ["false"]
    }
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = ["tenant_id", "purpose"]
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
    ]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/purpose"
      values   = ["tenant_data"]
    }
    condition {
      test     = "Null"
      variable = "aws:ResourceTag/tenant_id"
      values   = ["false"]
    }
  }

  # Rotação por suspeita (rotateMasterKey): ReEncrypt dentro do KMS, a DEK não sai em claro.
  # K-c: como na API (DekDaClinica), o EncryptionContext { tenant_id } tem de ser IGUAL à tag.
  statement {
    sid       = "RecifrarDekDaClinica"
    actions   = ["kms:ReEncryptFrom", "kms:ReEncryptTo"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/purpose"
      values   = ["tenant_data"]
    }
    condition {
      test     = "Null"
      variable = "aws:ResourceTag/tenant_id"
      values   = ["false"]
    }
    condition {
      test     = "StringEquals"
      variable = "kms:EncryptionContext:tenant_id"
      values   = ["&{aws:ResourceTag/tenant_id}"]
    }
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "kms:EncryptionContextKeys"
      values   = ["tenant_id"]
    }
  }

  # Eliminação da clínica (G3: destroyTenantKeys): exclusão agendada só da chave da clínica.
  statement {
    sid       = "AgendarDestruicaoComJanela"
    actions   = ["kms:ScheduleKeyDeletion"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/purpose"
      values   = ["tenant_data"]
    }
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
      test     = "StringEquals"
      variable = "aws:ResourceTag/purpose"
      values   = ["tenant_data"]
    }
  }

  # Chave de lote destruída não volta, nem pelo gestor.
  statement {
    sid       = "LoteDestruidoNaoVolta"
    effect    = "Deny"
    actions   = ["kms:CancelKeyDeletion", "kms:EnableKey"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/purpose"
      values   = ["import_batch"]
    }
  }

  statement {
    sid       = "NuncaDestagear"
    effect    = "Deny"
    actions   = ["kms:UntagResource"]
    resources = ["*"]
  }
  statement {
    sid       = "NuncaRetagear"
    effect    = "Deny"
    actions   = ["kms:TagResource"]
    resources = ["*"]
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

# --- API: chave da clínica e chave descartável de lote do importador ---------------------------

data "aws_iam_policy_document" "api_kek" {
  #checkov:skip=CKV_AWS_111:Chaves nascem em tempo de execução (ARN desconhecido); escopo por tags purpose/tenant_id (ABAC) e KeySpec/MultiRegion.
  #checkov:skip=CKV_AWS_356:Chaves nascem em tempo de execução (ARN desconhecido); escopo por tags purpose/tenant_id e EncryptionContext.

  # Criar chave da clínica: tenant_id + purpose=tenant_data, sem batch_id.
  statement {
    sid       = "CriarChaveDaClinica"
    actions   = ["kms:CreateKey"]
    resources = ["*"] # CreateKey não aceita recurso específico
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/purpose"
      values   = ["tenant_data"]
    }
    condition {
      test     = "Null"
      variable = "aws:RequestTag/tenant_id"
      values   = ["false"]
    }
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = ["tenant_id", "purpose"]
    }
    dynamic "condition" {
      for_each = local.kms_criacao_segura
      content {
        test     = condition.value.test
        variable = condition.value.variable
        values   = condition.value.values
      }
    }
  }

  # Criar chave de lote: tenant_id + purpose=import_batch + batch_id.
  statement {
    sid       = "CriarChaveDeLote"
    actions   = ["kms:CreateKey"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/purpose"
      values   = ["import_batch"]
    }
    condition {
      test     = "Null"
      variable = "aws:RequestTag/tenant_id"
      values   = ["false"]
    }
    condition {
      test     = "Null"
      variable = "aws:RequestTag/batch_id"
      values   = ["false"]
    }
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = local.kms_tags_permitidas
    }
    dynamic "condition" {
      for_each = local.kms_criacao_segura
      content {
        test     = condition.value.test
        variable = condition.value.variable
        values   = condition.value.values
      }
    }
  }

  # CreateKey com Tags exige kms:TagResource: só as tags do desenho e só purpose conhecido.
  # Em chave já existente o TagResource é negado (NuncaRetagear).
  statement {
    sid       = "TagNaCriacao"
    actions   = ["kms:TagResource"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestTag/purpose"
      values   = ["tenant_data", "import_batch"]
    }
    condition {
      test     = "Null"
      variable = "aws:RequestTag/tenant_id"
      values   = ["false"]
    }
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = local.kms_tags_permitidas
    }
  }

  # DEK só em chave com tenant_id e com EncryptionContext { tenant_id } IGUAL à tag da chave.
  # ReEncrypt (rewrapDataKey): From confere o contexto de origem e To o de destino, cada um na
  # sua chave. "&{...}" é a variável de política (o Terraform não interpola).
  statement {
    sid       = "DekDaClinica"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt", "kms:ReEncryptFrom", "kms:ReEncryptTo"]
    resources = ["*"]
    condition {
      test     = "Null"
      variable = "aws:ResourceTag/tenant_id"
      values   = ["false"]
    }
    condition {
      test     = "StringEquals"
      variable = "kms:EncryptionContext:tenant_id"
      values   = ["&{aws:ResourceTag/tenant_id}"]
    }
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "kms:EncryptionContextKeys"
      values   = ["tenant_id"]
    }
  }

  # destroyMasterKey consulta o estado (idempotência: já PendingDeletion conta como feito).
  statement {
    sid       = "DescreverChave"
    actions   = ["kms:DescribeKey"]
    resources = ["*"]
    condition {
      test     = "Null"
      variable = "aws:ResourceTag/tenant_id"
      values   = ["false"]
    }
  }

  # Rotação anual só na chave da clínica (a de lote vive ≤ 7 dias).
  statement {
    sid       = "RotacaoSoDaClinica"
    actions   = ["kms:EnableKeyRotation"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/purpose"
      values   = ["tenant_data"]
    }
  }

  # Exclusão agendada SÓ da chave de lote, com a janela mínima configurada (a API usa 7).
  statement {
    sid       = "ExclusaoSoDaChaveDeLote"
    actions   = ["kms:ScheduleKeyDeletion"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/purpose"
      values   = ["import_batch"]
    }
    condition {
      test     = "NumericGreaterThanEquals"
      variable = "kms:ScheduleKeyDeletionPendingWindowInDays"
      values   = [tostring(var.kek_janela_exclusao_dias)]
    }
  }

  # A API não exclui chave de clínica (nem chave sem purpose): isso é da eliminação da clínica,
  # pelo papel gestor_chaves, só em purpose=tenant_data. Hoje nenhum caminho da API chama
  # destroyTenantKeys. StringNotEquals com a tag ausente também nega.
  statement {
    sid       = "NuncaExcluiChaveDaClinica"
    effect    = "Deny"
    actions   = ["kms:ScheduleKeyDeletion", "kms:CancelKeyDeletion", "kms:DisableKey"]
    resources = ["*"]
    condition {
      test     = "StringNotEquals"
      variable = "aws:ResourceTag/purpose"
      values   = ["import_batch"]
    }
  }

  # Chave de lote destruída não volta.
  statement {
    sid       = "LoteDestruidoNaoVolta"
    effect    = "Deny"
    actions   = ["kms:CancelKeyDeletion", "kms:EnableKey"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceTag/purpose"
      values   = ["import_batch"]
    }
  }

  # A tag é o que separa os dois tipos: não sai nem muda depois da criação.
  statement {
    sid       = "NuncaDestagear"
    effect    = "Deny"
    actions   = ["kms:UntagResource"]
    resources = ["*"]
  }
  statement {
    sid       = "NuncaRetagear"
    effect    = "Deny"
    actions   = ["kms:TagResource"]
    resources = ["*"]
    condition {
      test     = "Null"
      variable = "aws:ResourceTag/tenant_id"
      values   = ["false"]
    }
  }

  # Chaves de infraestrutura: a API nunca as gere (o uso de dado, ex.: exportacoes, segue nas
  # outras políticas da tarefa).
  statement {
    sid    = "NuncaGereChavesDeInfra"
    effect = "Deny"
    actions = [
      "kms:TagResource", "kms:UntagResource", "kms:ScheduleKeyDeletion", "kms:CancelKeyDeletion",
      "kms:EnableKey", "kms:DisableKey", "kms:EnableKeyRotation", "kms:PutKeyPolicy",
    ]
    resources = local.chaves_infra_arn
  }
}

resource "aws_iam_role_policy" "api_kek" {
  name   = "chaves-da-clinica-e-de-lote"
  role   = aws_iam_role.api_tarefa.id
  policy = data.aws_iam_policy_document.api_kek.json
}

# --- Alerta: CancelKeyDeletion / EnableKey ----------------------------------------------------
# O EventBridge não filtra pela tag da chave, e nenhum fluxo normal chama essas ações (a API é
# negada na chave de lote; o gestor só as usa em chave de clínica, sob incidente). Toda chamada
# vai para o tópico de segurança; a tag purpose se confere pelo ARN do evento no CloudTrail.
resource "aws_cloudwatch_event_rule" "kms_reativacao" {
  name        = "${local.nome}-kms-cancelar-exclusao"
  description = "CancelKeyDeletion/EnableKey em qualquer chave (R3-b do parecer do importador)."
  event_pattern = jsonencode({
    source        = ["aws.kms"]
    "detail-type" = ["AWS API Call via CloudTrail"]
    detail = {
      eventSource = ["kms.amazonaws.com"]
      eventName   = ["CancelKeyDeletion", "EnableKey"]
    }
  })
}

resource "aws_cloudwatch_event_target" "kms_reativacao" {
  rule = aws_cloudwatch_event_rule.kms_reativacao.name
  arn  = aws_sns_topic.alertas_seguranca.arn
}

# --- Alerta: PutKeyPolicy / ScheduleKeyDeletion / DisableKey / CreateGrant (K-c5) -------------
# Risco residual da K-c2: o statement da conta na key policy deixa um administrador humano com
# kms:PutKeyPolicy remover o Deny de contexto. É administração por desenho, mas tem de ser visível.
# O evento do CloudTrail traz só o ARN da chave (resources[].ARN / requestParameters.keyId), sem as
# tags, e o EventBridge não consulta a tag do recurso: NÃO dá para filtrar por tenant_id/purpose.
# Por isso o alerta vale para TODAS as chaves da conta; a triagem confere a tag pelo ARN.
# Disparos ESPERADOS (o alerta dispara mesmo assim, porque é registro):
#   - ScheduleKeyDeletion do gestor na eliminação da clínica (G3, destroyTenantKeys);
#   - ScheduleKeyDeletion da API na chave de lote do importador (purpose=import_batch, ≤ 7 dias);
#   - CreateGrant feito por serviço AWS (userIdentity.invokedBy, ex.: RDS) em chave de infra.
# PutKeyPolicy e DisableKey não têm fluxo normal: qualquer disparo é incidente até prova contrária.
resource "aws_cloudwatch_event_rule" "kms_administracao" {
  name        = "${local.nome}-kms-administracao"
  description = "PutKeyPolicy/ScheduleKeyDeletion/DisableKey/CreateGrant em qualquer chave (K-c5)."
  event_pattern = jsonencode({
    source        = ["aws.kms"]
    "detail-type" = ["AWS API Call via CloudTrail"]
    detail = {
      eventSource = ["kms.amazonaws.com"]
      eventName   = ["PutKeyPolicy", "ScheduleKeyDeletion", "DisableKey", "CreateGrant"]
    }
  })
}

resource "aws_cloudwatch_event_target" "kms_administracao" {
  rule = aws_cloudwatch_event_rule.kms_administracao.name
  arn  = aws_sns_topic.alertas_seguranca.arn
}
