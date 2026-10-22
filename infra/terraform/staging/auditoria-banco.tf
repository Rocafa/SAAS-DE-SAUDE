# Alerta de DDL sensível no Postgres (R11 e R12 do parecer do PR #61; R10 do parecer do PR #58).
# O pgaudit (classes DDL e ROLE, parameter group em dados.tf) escreve no grupo do export
# "postgresql" (retenção + KMS). Cada filtro abaixo procura um comando que enfraquece a
# integridade ou o RLS e soma 1 na mesma métrica; o alarme publica no tópico SNS
# alertas-seguranca (cifrado). A métrica é só uma contagem, sem texto do log.
#
# Regex do CloudWatch não tem flag de caixa: as classes [Xx] pegam SQL em minúsculas também.
# As etiquetas ",DROP TRIGGER," etc. vêm do campo "comando" do pgaudit, sempre em maiúsculas.
#
# COTA: no máximo 5 filtros com regex por log group (CloudWatch Logs, "Filter pattern syntax",
# https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/FilterAndPatternSyntax.html, consultado
# em 22/10/2026). Por isso as regex ficam agrupadas com "|" (o CloudWatch não aceita parênteses)
# em 4 filtros; os demais são termos exatos, sem essa cota. O CI falha se passar de 5.
#
# R12: função de guarda (corpo, SECURITY DEFINER, DROP ... CASCADE que leva o trigger junto),
# policy de RLS e dono de objeto também alertam. O pgaudit registra CREATE OR REPLACE FUNCTION
# com a etiqueta "CREATE FUNCTION", então o filtro pega as duas formas. "OWNER TO" vale para
# ALTER TABLE/FUNCTION/SCHEMA ... OWNER TO.
#
# R10: constraint (DROP/ALTER CONSTRAINT, DROP NOT NULL), índice (DROP INDEX), rule (CREATE RULE,
# que também cobre CREATE OR REPLACE RULE, e DISABLE RULE), trigger/rule em modo réplica
# (ENABLE REPLICA/ALWAYS: o trigger sai da sessão normal sem nenhum DISABLE), permissões (GRANT,
# REVOKE, GRANT ROLE, ALTER DEFAULT PRIVILEGES; classe ROLE) e qualquer menção a
# session_replication_role (ALTER ROLE/DATABASE ... SET, GRANT SET ON PARAMETER, set_config no
# corpo de uma função). O "SET session_replication_role" puro é da classe MISC, fora do
# pgaudit.log; só o master (rds_superuser) pode usá-lo, e o uso da senha do master já alerta pelo
# break-glass (limite registrado em docs/04-arquitetura/infra-staging.md).
#
# O alarme dispara SEMPRE, inclusive na migração legítima (quase toda migração tem GRANT/REVOKE);
# quem aplicou responde no alerta com a conferência pós-deploy (infra/rds/verificar-guardas.sh).
# Por que não há janela de migração que silencie o alarme: docs/04-arquitetura/infra-staging.md.

locals {
  ddl_sensivel_namespace = "PlataformaSaude/Banco"
  ddl_sensivel_metrica   = "DdlSensivel"

  ddl_sensivel_filtros = {
    # --- regex: 4 de no máximo 5 por log group ---
    # ALTER TABLE que desliga guarda: trigger, RLS, rule, ou trigger/rule só em modo réplica.
    alter-table-guardas = "%${join("|", [
      "[Dd][Ii][Ss][Aa][Bb][Ll][Ee]\\s+[Tt][Rr][Ii][Gg][Gg][Ee][Rr]",
      "[Dd][Ii][Ss][Aa][Bb][Ll][Ee]\\s+[Rr][Oo][Ww]\\s+[Ll][Ee][Vv][Ee][Ll]\\s+[Ss][Ee][Cc][Uu][Rr][Ii][Tt][Yy]",
      "[Nn][Oo]\\s+[Ff][Oo][Rr][Cc][Ee]\\s+[Rr][Oo][Ww]\\s+[Ll][Ee][Vv][Ee][Ll]\\s+[Ss][Ee][Cc][Uu][Rr][Ii][Tt][Yy]",
      "[Dd][Ii][Ss][Aa][Bb][Ll][Ee]\\s+[Rr][Uu][Ll][Ee]",
      "[Ee][Nn][Aa][Bb][Ll][Ee]\\s+[Rr][Ee][Pp][Ll][Ii][Cc][Aa]",
      "[Ee][Nn][Aa][Bb][Ll][Ee]\\s+[Aa][Ll][Ww][Aa][Yy][Ss]",
    ])}%"
    # Constraint de segurança (CHECK, FK composta com tenant_id, UNIQUE) e NOT NULL.
    constraint = "%${join("|", [
      "[Dd][Rr][Oo][Pp]\\s+[Cc][Oo][Nn][Ss][Tt][Rr][Aa][Ii][Nn][Tt]",
      "[Aa][Ll][Tt][Ee][Rr]\\s+[Cc][Oo][Nn][Ss][Tt][Rr][Aa][Ii][Nn][Tt]",
      "[Dd][Rr][Oo][Pp]\\s+[Nn][Oo][Tt]\\s+[Nn][Uu][Ll][Ll]",
    ])}%"
    session-replication-role = "%[Ss][Ee][Ss][Ss][Ii][Oo][Nn]_[Rr][Ee][Pp][Ll][Ii][Cc][Aa][Tt][Ii][Oo][Nn]_[Rr][Oo][Ll][Ee]%"
    owner-to                 = "%[Oo][Ww][Nn][Ee][Rr]\\s+[Tt][Oo]\\s%"

    # --- termos exatos (etiqueta de comando do pgaudit) ---
    drop-trigger             = "\"AUDIT: SESSION\" \",DROP TRIGGER,\""
    alter-role               = "\"AUDIT: SESSION\" \",ALTER ROLE,\""
    create-function          = "\"AUDIT: SESSION\" \",CREATE FUNCTION,\""
    alter-function           = "\"AUDIT: SESSION\" \",ALTER FUNCTION,\""
    drop-function            = "\"AUDIT: SESSION\" \",DROP FUNCTION,\""
    create-policy            = "\"AUDIT: SESSION\" \",CREATE POLICY,\""
    alter-policy             = "\"AUDIT: SESSION\" \",ALTER POLICY,\""
    drop-policy              = "\"AUDIT: SESSION\" \",DROP POLICY,\""
    drop-index               = "\"AUDIT: SESSION\" \",DROP INDEX,\""
    create-rule              = "\"AUDIT: SESSION\" \",CREATE RULE,\""
    grant                    = "\"AUDIT: SESSION\" \",GRANT,\""
    revoke                   = "\"AUDIT: SESSION\" \",REVOKE,\""
    grant-role               = "\"AUDIT: SESSION\" \",GRANT ROLE,\""
    alter-default-privileges = "\"AUDIT: SESSION\" \",ALTER DEFAULT PRIVILEGES,\""
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
  alarm_description = "DDL sensivel no Postgres (trigger, role, RLS, funcao, policy, OWNER TO, constraint, indice, rule, REPLICA/ALWAYS, GRANT/REVOKE, session_replication_role). Ver /aws/rds/instance/${local.nome}/postgresql e rodar infra/rds/verificar-guardas.sh (R11/R12 do PR #61, R10 do PR #58)."

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
