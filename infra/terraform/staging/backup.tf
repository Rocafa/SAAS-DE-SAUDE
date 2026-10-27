# Backup mensal imutável (R7 do parecer do Guardião sobre o PR #58; garantia G3).
#
# - Complementa o PITR de 35 dias do RDS (dados.tf) com um ponto de recuperação MENSAL guardado
#   por var.backup_mensal_retencao_dias (G3: "backups mensais imutáveis até 12 meses").
# - Cofre em sa-east-1, SEM copy_action: nenhuma cópia sai da região (D8). O infra.yml falha se
#   aparecer copy_action.
# - Vault lock: ninguém apaga nem encurta um ponto de recuperação antes do prazo. Em staging fica
#   em modo GOVERNANCE (o lock pode ser removido); em prod, COMPLIANCE (backup_vault_lock_compliance
#   = true: depois de 3 dias o lock não se desfaz mais, nem pelo root).
# - Crypto-shredding cobre o backup: os campos sensíveis estão cifrados com DEK da clínica, e a DEK
#   só abre com a KEK da clínica no KMS. A KEK NÃO entra em backup nenhum (chave KMS não é copiada
#   pelo AWS Backup); destruída a KEK, os mesmos campos ficam ilegíveis em todos os pontos de
#   recuperação. O que não é cifrado por clínica expira com o prazo do backup.
# - O snapshot do RDS no cofre continua cifrado com a chave "rds" (o RDS não troca a chave); a chave
#   "backup" cifra o cofre e os recursos que o AWS Backup cifra por conta própria.

resource "aws_backup_vault" "this" {
  name          = "${local.nome}-mensal"
  kms_key_arn   = aws_kms_key.this["backup"].arn
  force_destroy = false
}

resource "aws_backup_vault_lock_configuration" "this" {
  backup_vault_name  = aws_backup_vault.this.name
  min_retention_days = 7
  max_retention_days = var.backup_mensal_retencao_dias
  # null = modo GOVERNANCE; um número = COMPLIANCE após esse período de carência.
  changeable_for_days = var.backup_vault_lock_compliance ? 3 : null
}

resource "aws_backup_plan" "mensal" {
  name = "${local.nome}-mensal"

  rule {
    rule_name         = "mensal"
    target_vault_name = aws_backup_vault.this.name
    schedule          = "cron(0 7 1 * ? *)" # dia 1, 04:00 em Brasília
    start_window      = 60
    completion_window = 360

    lifecycle {
      delete_after = var.backup_mensal_retencao_dias
    }
    # Sem copy_action: o backup não sai de sa-east-1 (D8).
  }
}

data "aws_iam_policy_document" "backup_confianca" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["backup.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.conta]
    }
  }
}

resource "aws_iam_role" "backup" {
  name               = "${local.nome}-backup"
  assume_role_policy = data.aws_iam_policy_document.backup_confianca.json
}

resource "aws_iam_role_policy_attachment" "backup" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:${data.aws_partition.atual.partition}:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}

resource "aws_backup_selection" "rds" {
  name         = "rds"
  plan_id      = aws_backup_plan.mensal.id
  iam_role_arn = aws_iam_role.backup.arn
  resources    = [aws_db_instance.this.arn]
}
