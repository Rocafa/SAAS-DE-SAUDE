# --- Agendador de jobs da API: alarmes (infra-staging.md §4.4, R3 do parecer 2026-10-23-jobs.md) ---
# A API loga marcadores fixos, sem dado pessoal (só nome do job, id opaco da clínica, código de erro
# e contagens). Nomes conferidos em apps/api/src/modules/jobs/ (branch eng/integracao-r19, rodada 20).
#
# Cada marcador vira um filtro de métrica de TERMO EXATO no log group da API e um alarme no tópico de
# operação (alertas_seguranca, o único de operação hoje). A severidade vai no nome do alarme, na
# descrição e na tag "severidade" (critica > alta > media > baixa), para o on-call triar pelo e-mail.
# Termo exato não usa regex, então não conta na cota de 5 filtros com regex por log group.
#
# O encarregado (DPO) só recebe o que indica falha de retenção ou revogação:
#   - JOBS_DESLIGADOS (nenhum job roda e, nesse modo, nem o sinal de vida);
#   - JOB_ATRASADO e JOB_ALARME dos jobs de retenção/revogação (lista jobs_de_retencao), por um
#     filtro "marcador + job=<nome>" por par, todos na mesma métrica e num alarme só.
# JOB_ATRASADO de whatsapp-lembretes (não é retenção) e o resto ficam só com a operação.
# JOB_CLINICA_FALHOU não vai ao DPO direto: o executor não marca sucesso quando uma clínica falha,
# então a falha persistente de um job de retenção vira JOB_ATRASADO desse job, que vai ao DPO.
#
# Sem alarme (informativos): JOB_OK, JOB_EM_ANDAMENTO, JOB_REMOVIDO e JOB_TRAVA_NAO_LIBERADA (a trava
# vence sozinha; se prender o job de vez, aparece como JOB_ATRASADO).

locals {
  jobs_namespace = "${local.nome}/jobs"
  jobs_log_api   = "Ver o log group /${local.nome}/api e api-dominio §14."

  # excluir = termos que CONTÊM o termo e não devem casar. periodo em segundos; limiar = soma no período.
  jobs_marcadores = {
    jobs-desligados = {
      termo      = "JOBS_DESLIGADOS"
      excluir    = ["JOBS_DESLIGADOS_POR_OPCAO"] # N2: desligado por opção tem alarme próprio, mais brando
      metrica    = "JobsDesligados"
      severidade = "critica"
      periodo    = 300
      limiar     = 1
      dpo        = true
      descricao  = "Agendador de jobs desligado (sem Redis): nenhum job de retenção ou revogação roda, nem o sinal de vida. Conferir REDIS_URL e o Redis."
    }
    jobs-nao-agendados = {
      termo      = "JOBS_NAO_AGENDADOS"
      excluir    = []
      metrica    = "JobsNaoAgendados"
      severidade = "critica"
      periodo    = 300
      limiar     = 1
      dpo        = false
      descricao  = "A instância não conseguiu agendar os jobs no BullMQ. Se nenhuma outra instância agenda, os jobs de retenção param e o JOB_ATRASADO deles avisa o DPO."
    }
    job-atrasado = {
      termo      = "JOB_ATRASADO"
      excluir    = []
      metrica    = "JobAtrasado"
      severidade = "alta"
      periodo    = 300
      limiar     = 1
      dpo        = false # o DPO recebe só os de retenção/revogação (alarme jobs_retencao_dpo)
      descricao  = "Job crítico (retenção, revogação ou lembretes) sem execução bem-sucedida no prazo. O campo job= diz qual."
    }
    job-alarme = {
      termo      = "JOB_ALARME"
      excluir    = []
      metrica    = "JobAlarme"
      severidade = "alta"
      periodo    = 300
      limiar     = 1
      dpo        = false # idem: alarme jobs_retencao_dpo
      descricao  = "Um job sinalizou atraso no próprio trabalho (ex.: bruto do importador vencido há mais de 24 h depois do expurgo). Contagens na trilha da clínica."
    }
    job-clinica-falhou = {
      termo      = "JOB_CLINICA_FALHOU"
      excluir    = []
      metrica    = "JobClinicaFalhou"
      severidade = "alta"
      periodo    = 300
      limiar     = 1
      dpo        = false
      descricao  = "Um job falhou numa clínica depois de todas as tentativas; o job não marca sucesso e o BullMQ refaz. Persistindo, vira JOB_ATRASADO."
    }
    job-trilha-falhou = {
      termo      = "JOB_TRILHA_FALHOU"
      excluir    = []
      metrica    = "JobTrilhaFalhou"
      severidade = "alta"
      periodo    = 300
      limiar     = 1
      dpo        = false
      descricao  = "A trilha de auditoria de uma execução de job não foi gravada (prestação de contas). Conferir o banco."
    }
    jobs-desligados-por-opcao = {
      termo      = "JOBS_DESLIGADOS_POR_OPCAO"
      excluir    = []
      metrica    = "JobsDesligadosPorOpcao"
      severidade = "media"
      periodo    = 300
      limiar     = 1
      dpo        = false
      descricao  = "Instância com JOBS_HABILITADOS=false. O IaC de staging/produção proíbe a variável (precondição em app.tf): só com incidente registrado."
    }
    job-trabalhador-erro = {
      termo      = "JOB_TRABALHADOR_ERRO"
      excluir    = []
      metrica    = "JobTrabalhadorErro"
      severidade = "media"
      periodo    = 900
      limiar     = 3
      dpo        = false
      descricao  = "Erro repetido no trabalhador do BullMQ (em geral conexão com o Redis). Persistindo, aparece como JOB_ATRASADO."
    }
    job-falhou = {
      termo      = "JOB_FALHOU"
      excluir    = []
      metrica    = "JobFalhou"
      severidade = "media"
      periodo    = 900
      limiar     = 3
      dpo        = false
      descricao  = "Tentativas de job falhando no BullMQ (cada tentativa loga uma vez e o BullMQ refaz). Ver também JOB_CLINICA_FALHOU."
    }
    job-desconhecido = {
      termo      = "JOB_DESCONHECIDO"
      excluir    = []
      metrica    = "JobDesconhecido"
      severidade = "baixa"
      periodo    = 3600
      limiar     = 1
      dpo        = false
      descricao  = "Há na fila um job que esta versão da API não conhece (deploy gradual, ou job retirado sem JOBS_APOSENTADOS). Mantido; conferir o registro de jobs."
    }
  }

  # Jobs de retenção e revogação (api-dominio §14, "Monitoramento e IaC"). Job novo de retenção
  # entra aqui e no registro da API.
  jobs_de_retencao = [
    "whatsapp-retencao",
    "importador-expurgo",
    "notas-privadas-ciclo",
    "retencao-fiscal",
    "responsaveis-descarte",
    "portal-representacoes",
  ]

  jobs_retencao_filtros = {
    for par in setproduct(["JOB_ATRASADO", "JOB_ALARME"], local.jobs_de_retencao) :
    "${lower(replace(par[0], "_", "-"))}-${par[1]}" => { termo = par[0], job = par[1] }
  }
}

resource "aws_cloudwatch_log_metric_filter" "jobs" {
  for_each = local.jobs_marcadores

  name           = "${local.nome}-${each.key}"
  log_group_name = aws_cloudwatch_log_group.api.name
  pattern        = join(" ", concat(["\"${each.value.termo}\""], [for e in each.value.excluir : "-\"${e}\""]))

  metric_transformation {
    name          = each.value.metrica
    namespace     = local.jobs_namespace
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "jobs" {
  for_each = local.jobs_marcadores

  alarm_name        = "${local.nome}-${each.value.severidade}-${each.key}"
  alarm_description = "[${upper(each.value.severidade)}] ${each.value.descricao} Marcador ${each.value.termo}. ${local.jobs_log_api}"

  namespace           = local.jobs_namespace
  metric_name         = each.value.metrica
  statistic           = "Sum"
  period              = each.value.periodo
  evaluation_periods  = 1
  threshold           = each.value.limiar
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = each.value.dpo ? [aws_sns_topic.alertas_seguranca.arn, aws_sns_topic.alertas_dpo.arn] : [aws_sns_topic.alertas_seguranca.arn]

  tags = { severidade = each.value.severidade }

  depends_on = [aws_cloudwatch_log_metric_filter.jobs]
}

# Retenção/revogação para o DPO: "marcador" E "job=<nome>" (dois termos exatos = E lógico).
resource "aws_cloudwatch_log_metric_filter" "jobs_retencao" {
  for_each = local.jobs_retencao_filtros

  name           = "${local.nome}-dpo-${each.key}"
  log_group_name = aws_cloudwatch_log_group.api.name
  pattern        = "\"${each.value.termo}\" \"job=${each.value.job}\""

  metric_transformation {
    name          = "RetencaoOuRevogacaoFalhou"
    namespace     = local.jobs_namespace
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

resource "aws_cloudwatch_metric_alarm" "jobs_retencao_dpo" {
  alarm_name        = "${local.nome}-alta-jobs-retencao-dpo"
  alarm_description = "[ALTA] Job de retenção ou revogação (${join(", ", local.jobs_de_retencao)}) atrasado (JOB_ATRASADO) ou com alarme próprio (JOB_ALARME): dado pessoal pode estar passando do prazo. ${local.jobs_log_api}"

  namespace           = local.jobs_namespace
  metric_name         = "RetencaoOuRevogacaoFalhou"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  # A operação já recebe pelo alarme geral do marcador; aqui só o encarregado.
  alarm_actions = [aws_sns_topic.alertas_dpo.arn]

  tags = { severidade = "alta" }

  depends_on = [aws_cloudwatch_log_metric_filter.jobs_retencao]
}

# --- Aviso ao encarregado (DPO) ---------------------------------------------------------------
# Tópico próprio, cifrado com a chave de alertas. Assinatura por e-mail só quando houver o
# endereço (alerta_dpo_email, no tfvars, fora do git).

resource "aws_sns_topic" "alertas_dpo" {
  name              = "${local.nome}-alertas-dpo"
  kms_master_key_id = aws_kms_key.this["alertas"].arn
}

data "aws_iam_policy_document" "alertas_dpo" {
  statement {
    sid       = "CloudWatchAlarmePublica"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.alertas_dpo.arn]
    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values = concat(
        [for k, a in aws_cloudwatch_metric_alarm.jobs : a.arn if local.jobs_marcadores[k].dpo],
        [aws_cloudwatch_metric_alarm.jobs_retencao_dpo.arn],
      )
    }
  }
}

resource "aws_sns_topic_policy" "alertas_dpo" {
  arn    = aws_sns_topic.alertas_dpo.arn
  policy = data.aws_iam_policy_document.alertas_dpo.json
}

resource "aws_sns_topic_subscription" "alertas_dpo_email" {
  count     = var.alerta_dpo_email == null ? 0 : 1
  topic_arn = aws_sns_topic.alertas_dpo.arn
  protocol  = "email"
  endpoint  = var.alerta_dpo_email
}
