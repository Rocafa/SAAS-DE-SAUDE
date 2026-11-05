# Âncora externa da auditoria encadeada (R2 do parecer do Guardião sobre o PR #37).
#
# O bucket com Object Lock COMPLIANCE fica no módulo ../modules/ancora-auditoria, criado pelo
# provider aws.auditoria:
#   - conta_auditoria_id = null  -> mesma conta de staging (aceito só em staging: papel e política
#                                   separados da API, mas um admin da conta ainda edita a política);
#   - conta_auditoria_id = "<id>" -> conta separada (obrigatório em prod), assumindo
#                                   papel_auditoria_arn. O papel publicador continua nesta conta.
#
# Quem publica: o papel "ancora-publicador" abaixo, para o job periódico (ECS agendado, de hora em
# hora e logo após ação de alta consequência). O job ainda não existe (código da ENG); o papel e o
# bucket ficam prontos. O papel da API NÃO grava âncora.

provider "aws" {
  alias               = "auditoria"
  region              = var.regiao
  allowed_account_ids = [coalesce(var.conta_auditoria_id, var.conta_aws_id)]

  dynamic "assume_role" {
    for_each = var.papel_auditoria_arn == null ? [] : [var.papel_auditoria_arn]
    content {
      role_arn     = assume_role.value
      session_name = "terraform-ancora-auditoria"
    }
  }

  default_tags {
    tags = {
      projeto    = "plataforma-saude"
      ambiente   = local.ambiente
      gerenciado = "terraform"
      dados      = "metadados-de-auditoria"
    }
  }
}

resource "aws_iam_role" "ancora_publicador" {
  name               = "${local.nome}-ancora-publicador"
  assume_role_policy = data.aws_iam_policy_document.ecs_confianca.json
}

module "ancora_auditoria" {
  source = "../modules/ancora-auditoria"
  providers = {
    aws = aws.auditoria
  }

  prefixo_nome     = local.nome
  publicadores_arn = [aws_iam_role.ancora_publicador.arn]
  retencao_dias    = var.ancora_retencao_dias
}

data "aws_iam_policy_document" "ancora_publicador" {
  statement {
    sid       = "PublicarAncora"
    actions   = ["s3:PutObject"]
    resources = ["${module.ancora_auditoria.bucket_arn}/ancoras/*"]
  }
  statement {
    sid       = "CifrarAncora"
    actions   = ["kms:GenerateDataKey"]
    resources = [module.ancora_auditoria.kms_key_arn]
  }
}

resource "aws_iam_role_policy" "ancora_publicador" {
  name   = "publicar-ancora"
  role   = aws_iam_role.ancora_publicador.id
  policy = data.aws_iam_policy_document.ancora_publicador.json
}
