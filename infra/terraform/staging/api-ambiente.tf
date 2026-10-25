# Dependências do ambiente da API que não são banco nem Redis (infra-staging.md §4.5).

# --- Pseudônimo do suporte (SUPPORT_PSEUDONYM_KMS_KEY_ID, N1) ------------------------------
# A API recusa subir fora de dev/test sem esta chave (o segredo do pseudônimo não pode morar no
# processo). Chave HMAC: o material nunca sai do KMS; a tarefa só chama GenerateMac.
# Rotação automática não existe para chave HMAC no KMS, e trocar a chave muda todos os
# pseudônimos (a trilha antiga deixa de casar com a nova): troca só por suspeita, com o Guardião.
data "aws_iam_policy_document" "kms_pseudonimo" {
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
  # Humano com GenerateMac recalcularia o pseudônimo de um atendente e o reidentificaria (R4).
  statement {
    sid       = "HumanoNaoCalculaPseudonimo"
    effect    = "Deny"
    actions   = ["kms:GenerateMac", "kms:VerifyMac"]
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

resource "aws_kms_key" "pseudonimo_suporte" {
  #checkov:skip=CKV_AWS_7:Chave HMAC não aceita rotação automática no KMS; troca manual documentada (infra-staging.md §4.5).
  description              = "${local.nome}: HMAC do pseudônimo do atendente de suporte (SUPPORT_PSEUDONYM_KMS_KEY_ID)"
  customer_master_key_spec = "HMAC_256"
  key_usage                = "GENERATE_VERIFY_MAC"
  deletion_window_in_days  = 30
  policy                   = data.aws_iam_policy_document.kms_pseudonimo.json
}

resource "aws_kms_alias" "pseudonimo_suporte" {
  name          = "alias/${local.nome}-pseudonimo-suporte"
  target_key_id = aws_kms_key.pseudonimo_suporte.key_id
}

data "aws_iam_policy_document" "api_pseudonimo" {
  statement {
    sid       = "PseudonimoDoSuporte"
    actions   = ["kms:GenerateMac"]
    resources = [aws_kms_key.pseudonimo_suporte.arn]
  }
}

resource "aws_iam_role_policy" "api_pseudonimo" {
  name   = "pseudonimo-suporte"
  role   = aws_iam_role.api_tarefa.id
  policy = data.aws_iam_policy_document.api_pseudonimo.json
}

# --- WhatsApp Cloud API (só com whatsapp_provedor = "cloud_api") ----------------------------
# Credenciais emitidas pela Meta: o Terraform NÃO as gera nem as conhece. O segredo nasce VAZIO
# (sem versão) e é preenchido fora do git, uma vez, com papel de máquina ou break-glass:
#   aws secretsmanager put-secret-value --secret-id <nome>/whatsapp \
#     --secret-string file://<arquivo-temporário-fora-do-repo>.json
#   JSON: {"access_token": "...", "app_secret": "<base64>", "webhook_verify_token": "..."}
# Enquanto estiver vazio, o ECS não consegue iniciar a tarefa (falha fechada, visível no deploy).
resource "aws_secretsmanager_secret" "whatsapp" {
  #checkov:skip=CKV2_AWS_57:Credencial emitida pela Meta; rotação é feita no painel da Meta e regravada aqui (infra-staging.md §4.5).
  count = var.whatsapp_provedor == "cloud_api" ? 1 : 0

  name                    = "${local.nome}/whatsapp"
  description             = "WhatsApp Cloud API: access_token, app_secret (base64), webhook_verify_token. PREENCHER à mão (put-secret-value), nunca no git."
  kms_key_id              = aws_kms_key.this["segredos"].arn
  recovery_window_in_days = 7
}
