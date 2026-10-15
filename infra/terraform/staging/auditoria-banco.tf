# Alerta de DDL sensível no Postgres (R11 do parecer do PR #61).
# O pgaudit (classes DDL e ROLE, parameter group em dados.tf) escreve no grupo do export
# "postgresql" (retenção + KMS). Cada filtro abaixo procura um comando que enfraquece a
# integridade ou o RLS e soma 1 na mesma métrica; o alarme publica no tópico SNS
# alertas-seguranca (cifrado). A métrica é só uma contagem, sem texto do log.
#
# Regex do CloudWatch não tem flag de caixa: as classes [Xx] pegam SQL em minúsculas também.
# DROP TRIGGER e ALTER ROLE vêm do campo "comando" do pgaudit, sempre em maiúsculas.
# session_replication_role (SET) é da classe MISC, fora do pgaudit.log; só o master
# (rds_superuser) pode usá-lo, e o uso da senha do master já alerta pelo break-glass.

locals {
  ddl_sensivel_namespace = "PlataformaSaude/Banco"
  ddl_sensivel_metrica   = "DdlSensivel"

  ddl_sensivel_filtros = {
    disable-trigger = "%[Dd][Ii][Ss][Aa][Bb][Ll][Ee]\\s+[Tt][Rr][Ii][Gg][Gg][Ee][Rr]%"
    drop-trigger    = "\"AUDIT: SESSION\" \",DROP TRIGGER,\""
    alter-role      = "\"AUDIT: SESSION\" \",ALTER ROLE,\""
    no-force-rls    = "%[Nn][Oo]\\s+[Ff][Oo][Rr][Cc][Ee]\\s+[Rr][Oo][Ww]\\s+[Ll][Ee][Vv][Ee][Ll]\\s+[Ss][Ee][Cc][Uu][Rr][Ii][Tt][Yy]%"
    disable-rls     = "%[Dd][Ii][Ss][Aa][Bb][Ll][Ee]\\s+[Rr][Oo][Ww]\\s+[Ll][Ee][Vv][Ee][Ll]\\s+[Ss][Ee][Cc][Uu][Rr][Ii][Tt][Yy]%"
  }
}

resource "aws_cloudwatch_log_metric_filter" "ddl_sensivel" {
  for_each = local.ddl_sensivel_filtros

  name           = "${local.nome}-ddl-sensivel-${each.key}"
  log_group_name = aws_cloudwatch_log_group.rds["postgresql"].name
  pattern        = each.value

  metric_transformation {
    name          = local.ddl_sensivel_metrica
    namespace     = local.ddl_sensivel_namespace
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "ddl_sensivel" {
  alarm_name        = "${local.nome}-ddl-sensivel"
  alarm_description = "DDL sensivel no Postgres (DISABLE TRIGGER, DROP TRIGGER, ALTER ROLE, NO FORCE/DISABLE RLS). Ver /aws/rds/instance/${local.nome}/postgresql (R11 do PR #61)."

  namespace           = local.ddl_sensivel_namespace
  metric_name         = local.ddl_sensivel_metrica
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alertas_seguranca.arn]

  depends_on = [aws_cloudwatch_log_metric_filter.ddl_sensivel]
}
