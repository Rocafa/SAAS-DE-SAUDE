# Tarefa avulsa do ECS para o provisionamento da clínica (B11 do checklist do login real), no padrão
# da anonimização (ops-anonimizacao.tf, B10). Parecer do Guardião de 16/11/2026
# (revisoes/2026-11-16-desenho-provisionamento-da-clinica.md), R1, R3, R7 e R8:
#   - definição de tarefa, papel de execução e papel de tarefa PRÓPRIOS; segredos só DATABASE_AUTH_URL
#     (app_auth), DATABASE_URL (app_user) e RATE_LIMIT_HASH_KEY (raiz do HMAC por uso: a tarefa deriva
#     chaveDeHmac('ativacao-email') para o HMAC do e-mail do fundador). Nada de BETTER_AUTH_SECRET,
#     Redis, KMS de clínica ou WhatsApp;
#   - quem roda é provado pela AWS (principal do ecs:RunTask no CloudTrail): só o papel
#     ops-provisionamento-executor (humano nominal, MFA, SourceIdentity); quem lê a entrega é OUTRO
#     papel, ops-provisionamento-entrega, com lista de principais disjunta (C1 do parecer de 17/11).
#     Nenhum papel de máquina roda esta tarefa, passa os papéis dela ou toca os parâmetros
#     /provisionamento/*.
#
# Dados pessoais só no SSM (R1, P1), em SecureString com a chave KMS própria "ops-provisionamento":
#   /provisionamento/<pedido>          {"email": ..., "clinica": ...}: o operador cria; a tarefa lê e apaga
#                                      (com sucesso ou falha, R9);
#   /provisionamento/<pedido>/entrega  o token: a tarefa grava; a SEGUNDA pessoa lê uma vez, entrega fora
#                                      de banda e apaga (R3).
# O papel da tarefa só lê e apaga o pedido e só grava a entrega; o executor só cria e apaga o pedido;
# o papel de entrega só lê e apaga a entrega. Nenhum forja o lado do outro (Deny explícito).
#
# Vencimento de 72 h no parâmetro de entrega (R3: "a tarefa agenda o apagamento no vencimento"): a
# política de expiração do SSM é do PARÂMETRO, e o parâmetro nasce no PutParameter da tarefa, não no
# Terraform. Fica no cliente SSM da tarefa (TODO B11 em apps/api/src/ops/provisionar-clinica.ts):
# PutParameter com Type=SecureString, KeyId=$SSM_KMS_KEY_ID, Tier=Advanced e
# Policies=[{"Type":"Expiration","Version":"1.0","Attributes":{"Timestamp":"<agora + 72 h>"}}]. O
# runbook pede o mesmo no pedido criado pelo operador (vence em 72 h se a tarefa não rodar).
# Controle de duas pessoas (quem roda não entrega): dois papéis com listas disjuntas (precondição na
# definição de tarefa); o chamado confere o SourceIdentity do RunTask e do GetParameter no CloudTrail,
# e as duas pontas geram alerta (execução e entrega lida/apagada).
#
# Execução (desenho em docs/04-arquitetura/provisionamento-da-clinica.md; o runbook ainda falta): RunTask com
#   containerOverrides[0].command     = ["--pedido", "<uuid>", "--contrato", "CTR-<n>"]
#   containerOverrides[0].environment = [{ name = "CONFIRMA_PROVISIONAMENTO", value = "<o mesmo uuid>" }]
# O programa fica no entryPoint (R-A do parecer do código do #190): o override troca só os argumentos.

locals {
  ops_prov_nome      = "${local.nome}-ops-provisionamento"
  ops_prov_conteiner = "ops-provisionamento"
  ops_prov_prefixo   = "ops-provisionamento"

  # Nomes e ARNs fixos dos papéis humanos (C1: quem roda não entrega). A key policy da chave
  # "ops-provisionamento" e local.principais_humanos os citam mesmo quando o papel não existe.
  ops_prov_papel_executor     = "${local.nome}-ops-provisionamento-executor"
  ops_prov_papel_entrega      = "${local.nome}-ops-provisionamento-entrega"
  ops_prov_papel_executor_arn = "arn:${data.aws_partition.atual.partition}:iam::${local.conta}:role/${local.ops_prov_papel_executor}"
  ops_prov_papel_entrega_arn  = "arn:${data.aws_partition.atual.partition}:iam::${local.conta}:role/${local.ops_prov_papel_entrega}"

  # Parâmetros SSM do fluxo. `*` no IAM atravessa a barra: ops_prov_pedidos inclui as entregas.
  ops_prov_parametros = "arn:${data.aws_partition.atual.partition}:ssm:${local.regiao}:${local.conta}:parameter/provisionamento"
  ops_prov_pedidos    = "${local.ops_prov_parametros}/*"
  ops_prov_entregas   = "${local.ops_prov_parametros}/*/entrega"
  ops_prov_via_ssm    = "ssm.${local.regiao}.amazonaws.com"

  # Segredo -> segredo do Secrets Manager. SÓ estes três (R8). A política de leitura do papel de
  # execução é derivada deste mapa; a precondição abaixo falha se entrar qualquer outro.
  # TODO(A1 do parecer de 17/11/2026, eng/hmac-por-uso): RATE_LIMIT_HASH_KEY é a RAIZ do HMAC por uso.
  # A tarefa só precisa de chaveDeHmac('ativacao-email') (HKDF em rate-limit-store.ts), mas com a raiz
  # consegue derivar todos os usos (rate-limit, bloqueio, sessao-ua, convite-email). Trocar por um
  # segredo próprio com a chave já derivada (ATIVACAO_EMAIL_HMAC_KEY, gerado uma vez por script e
  # gravado write-only) quando a API aceitar lê-la direto; a precondição troca junto. Não muda aqui
  # porque exige mudança no código da API.
  ops_prov_segredos_origem = {
    DATABASE_AUTH_URL   = { segredo = aws_secretsmanager_secret.app["banco-app-auth"].arn, campo = "url" }
    DATABASE_URL        = { segredo = aws_secretsmanager_secret.app["banco-app-user"].arn, campo = "url" }
    RATE_LIMIT_HASH_KEY = { segredo = aws_secretsmanager_secret.app["rate-limit-hash-key"].arn, campo = "chave" }
  }
  ops_prov_segredos_permitidos = {
    DATABASE_AUTH_URL   = aws_secretsmanager_secret.app["banco-app-auth"].arn
    DATABASE_URL        = aws_secretsmanager_secret.app["banco-app-user"].arn
    RATE_LIMIT_HASH_KEY = aws_secretsmanager_secret.app["rate-limit-hash-key"].arn
  }
  ops_prov_segredos      = [for nome, s in local.ops_prov_segredos_origem : { name = nome, valueFrom = "${s.segredo}:${s.campo}::" }]
  ops_prov_segredos_arns = distinct([for s in local.ops_prov_segredos_origem : s.segredo])

  # Ambiente fixo, sem segredo. CONFIRMA_PROVISIONAMENTO NÃO entra aqui: vem só pelo override do RunTask.
  ops_prov_ambiente = [
    { name = "NODE_ENV", value = "production" },
    # CA do RDS para sslmode=verify-full (mesmo caminho do Dockerfile e da tarefa da API).
    { name = "NODE_EXTRA_CA_CERTS", value = "/etc/ssl/certs/rds-sa-east-1-bundle.pem" },
    # Cliente SSM da tarefa: região e chave KMS própria do PutParameter da entrega (não é segredo).
    { name = "AWS_REGION", value = local.regiao },
    { name = "SSM_KMS_KEY_ID", value = aws_kms_key.this["ops-provisionamento"].arn },
  ]
  ops_prov_ambiente_permitido = ["NODE_ENV", "NODE_EXTRA_CA_CERTS", "AWS_REGION", "SSM_KMS_KEY_ID"]
  ops_prov_nomes_ambiente     = [for v in local.ops_prov_ambiente : v.name]
  ops_prov_nomes_segredos     = [for s in local.ops_prov_segredos : s.name]

  # Imagem distroless (gcr.io/distroless/nodejs22): node e script fixos; argumentos só pelo override.
  ops_prov_entrypoint = ["/nodejs/bin/node", "dist/ops/provisionar-clinica.js"]
}

# --- Rede: grupo de segurança próprio (só banco e VPC endpoints; sem Redis, sem entrada) -------

resource "aws_security_group" "ops_provisionamento" {
  #checkov:skip=CKV2_AWS_5:Usado só no RunTask avulso (networkConfiguration da execução), não por um serviço; ver o runbook do provisionamento.
  name        = local.ops_prov_nome
  description = "Tarefa avulsa do provisionamento: so PostgreSQL e VPC endpoints, sem entrada"
  vpc_id      = aws_vpc.this.id
}

resource "aws_vpc_security_group_egress_rule" "ops_provisionamento_https" {
  security_group_id = aws_security_group.ops_provisionamento.id
  cidr_ipv4         = var.cidr_vpc
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "VPC endpoints (ECR, Secrets, Logs, KMS, SSM)"
}

resource "aws_vpc_security_group_egress_rule" "ops_provisionamento_s3" {
  security_group_id = aws_security_group.ops_provisionamento.id
  prefix_list_id    = aws_vpc_endpoint.s3.prefix_list_id
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  description       = "S3 pelo gateway endpoint (camadas do ECR)"
}

resource "aws_vpc_security_group_egress_rule" "ops_provisionamento_rds" {
  security_group_id            = aws_security_group.ops_provisionamento.id
  referenced_security_group_id = aws_security_group.rds.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "PostgreSQL"
}

resource "aws_vpc_security_group_ingress_rule" "rds_da_ops_provisionamento" {
  security_group_id            = aws_security_group.rds.id
  referenced_security_group_id = aws_security_group.ops_provisionamento.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  description                  = "PostgreSQL vindo da tarefa avulsa do provisionamento (B11)"
}

# --- Papéis próprios ---------------------------------------------------------------------------

# EXECUÇÃO: o agente do ECS puxa a imagem, lê SÓ os três segredos e escreve o log.
resource "aws_iam_role" "ops_provisionamento_execucao" {
  name               = "${local.ops_prov_nome}-execucao"
  description        = "Execução da tarefa avulsa do provisionamento (B11): só banco-app-auth, banco-app-user e rate-limit-hash-key."
  assume_role_policy = data.aws_iam_policy_document.ecs_confianca.json
}

data "aws_iam_policy_document" "ops_provisionamento_execucao" {
  statement {
    sid       = "PullDaImagem"
    actions   = ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:BatchCheckLayerAvailability"]
    resources = [aws_ecr_repository.api.arn]
  }
  statement {
    sid       = "TokenDoEcr"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"] # a ação não aceita recurso específico
  }
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.api.arn}:log-stream:${local.ops_prov_prefixo}/*"]
  }
  statement {
    sid       = "SegredosDaTarefa"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = local.ops_prov_segredos_arns
  }
  statement {
    sid       = "Decifrar"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.this["segredos"].arn, aws_kms_key.this["ecr"].arn]
  }
}

resource "aws_iam_role_policy" "ops_provisionamento_execucao" {
  name   = "execucao"
  role   = aws_iam_role.ops_provisionamento_execucao.id
  policy = data.aws_iam_policy_document.ops_provisionamento_execucao.json
}

# TAREFA (o processo Node): só os parâmetros /provisionamento/*, pelo SSM, com a chave própria.
resource "aws_iam_role" "ops_provisionamento_tarefa" {
  name               = "${local.ops_prov_nome}-tarefa"
  description        = "Papel da tarefa avulsa do provisionamento (B11): lê e apaga o pedido, grava a entrega em /provisionamento/*."
  assume_role_policy = data.aws_iam_policy_document.ecs_confianca.json
}

data "aws_iam_policy_document" "ops_provisionamento_tarefa" {
  statement {
    sid       = "LerEApagarOPedido"
    actions   = ["ssm:GetParameter", "ssm:DeleteParameter"]
    resources = [local.ops_prov_pedidos]
  }
  statement {
    sid       = "GravarAEntrega"
    actions   = ["ssm:PutParameter"]
    resources = [local.ops_prov_entregas]
  }
  # A entrega é da segunda pessoa: a tarefa não a lê, não a apaga e não lê histórico.
  statement {
    sid       = "EntregaNaoVolta"
    effect    = "Deny"
    actions   = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParameterHistory", "ssm:DeleteParameter"]
    resources = [local.ops_prov_entregas]
  }
  statement {
    sid       = "DecifrarOPedido"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.this["ops-provisionamento"].arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = [local.ops_prov_via_ssm]
    }
    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:PARAMETER_ARN"
      values   = [local.ops_prov_pedidos]
    }
    # A3: `*` atravessa a barra; a entrega fica de fora também no KMS (igual ao Deny do SSM).
    condition {
      test     = "ArnNotLike"
      variable = "kms:EncryptionContext:PARAMETER_ARN"
      values   = [local.ops_prov_entregas]
    }
  }
  statement {
    sid       = "CifrarAEntrega"
    actions   = ["kms:Encrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.this["ops-provisionamento"].arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = [local.ops_prov_via_ssm]
    }
    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:PARAMETER_ARN"
      values   = [local.ops_prov_entregas]
    }
  }
}

resource "aws_iam_role_policy" "ops_provisionamento_tarefa" {
  name   = "parametros-do-provisionamento"
  role   = aws_iam_role.ops_provisionamento_tarefa.id
  policy = data.aws_iam_policy_document.ops_provisionamento_tarefa.json
}

# --- Definição de tarefa -----------------------------------------------------------------------

resource "aws_ecs_task_definition" "ops_provisionamento" {
  family                   = local.ops_prov_nome
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.ops_provisionamento_execucao.arn
  task_role_arn            = aws_iam_role.ops_provisionamento_tarefa.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  volume {
    name = "tmp"
  }

  container_definitions = jsonencode([{
    name                   = local.ops_prov_conteiner
    image                  = "${aws_ecr_repository.api.repository_url}:${var.api_imagem_tag}" # mesma imagem da API
    essential              = true
    readonlyRootFilesystem = true
    user                   = "1000:1000"
    entryPoint             = local.ops_prov_entrypoint
    command                = []
    stopTimeout            = 30
    linuxParameters        = { initProcessEnabled = true }
    mountPoints            = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
    environment            = local.ops_prov_ambiente
    secrets                = local.ops_prov_segredos
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.api.name
        awslogs-region        = local.regiao
        awslogs-stream-prefix = local.ops_prov_prefixo
      }
    }
  }])

  lifecycle {
    # R8: SÓ DATABASE_AUTH_URL, DATABASE_URL e RATE_LIMIT_HASH_KEY, e só em `secrets`.
    precondition {
      condition = (
        length(local.ops_prov_segredos_origem) == 3
        && length(setsubtract(keys(local.ops_prov_segredos_origem), keys(local.ops_prov_segredos_permitidos))) == 0
        && length(setsubtract(keys(local.ops_prov_segredos_permitidos), keys(local.ops_prov_segredos_origem))) == 0
        && alltrue([for n, s in local.ops_prov_segredos_origem : s.segredo == local.ops_prov_segredos_permitidos[n]])
        && length(setsubtract(local.ops_prov_segredos_arns, values(local.ops_prov_segredos_permitidos))) == 0
      )
      error_message = "A tarefa do provisionamento só pode ter os segredos DATABASE_AUTH_URL (banco-app-auth), DATABASE_URL (banco-app-user) e RATE_LIMIT_HASH_KEY (rate-limit-hash-key). Nada de BETTER_AUTH_SECRET, REDIS_URL, KMS de clínica ou WhatsApp (R8 do parecer de 16/11/2026)."
    }
    # Ambiente fechado: nenhum segredo em texto claro, nenhuma porta da cadeia de credenciais AWS,
    # nenhuma trava pré-preenchida.
    precondition {
      condition     = length(setsubtract(local.ops_prov_nomes_ambiente, local.ops_prov_ambiente_permitido)) == 0 && length(setintersection(local.ops_prov_nomes_ambiente, local.ops_prov_nomes_segredos)) == 0
      error_message = "O environment da tarefa do provisionamento só aceita NODE_ENV, NODE_EXTRA_CA_CERTS, AWS_REGION e SSM_KMS_KEY_ID. CONFIRMA_PROVISIONAMENTO vem só pelo containerOverrides do RunTask."
    }
    # C1: quem roda não entrega. As duas listas preenchidas (ou as duas vazias: ninguém provisiona)
    # e sem nenhum principal em comum. A validação das variáveis recusa curinga, então comparar os
    # ARNs como texto basta.
    precondition {
      condition = (
        (length(var.principais_ops_provisionamento_executor) == 0) == (length(var.principais_ops_provisionamento_entrega) == 0)
        && length(setintersection(var.principais_ops_provisionamento_executor, var.principais_ops_provisionamento_entrega)) == 0
      )
      error_message = "principais_ops_provisionamento_executor e principais_ops_provisionamento_entrega precisam estar as duas preenchidas (ou as duas vazias) e ser disjuntas: quem roda o provisionamento não lê a entrega do token (C1 do parecer de 17/11/2026)."
    }
  }
}

# --- Papéis humanos ops-provisionamento-executor e ops-provisionamento-entrega -------------------
# R7 do parecer do desenho e C1 do parecer do código (revisoes/2026-11-17-codigo-infra-ops-provisionamento.md):
# quem roda NÃO entrega, separado por máquina, não só pelo chamado.
#   - executor: cria o pedido, roda a tarefa, acompanha e apaga o pedido. Não lê nem apaga a entrega
#     e não decifra nada (a key policy só deixa a tarefa e o papel de entrega decifrarem);
#   - entrega: lê a entrega uma vez e apaga. Não roda a tarefa, não passa papel e não grava nada em
#     /provisionamento/*.
# Cada papel tem a sua lista de principais (fora do git, no tfvars); a precondição da definição de
# tarefa exige as duas listas preenchidas (ou as duas vazias) e disjuntas. Mesmo desenho de confiança
# do ops-lgpd (ops-anonimizacao.tf): só a conta, MFA de menos de 1 h, SourceIdentity obrigatório
# (igual ao aws:username no usuário IAM; presente no papel do SSO), sessão de 1 h. Sem principal na
# lista, o papel não existe.

locals {
  ops_prov_papeis_humanos = {
    executor = { nome = local.ops_prov_papel_executor, principais = var.principais_ops_provisionamento_executor }
    entrega  = { nome = local.ops_prov_papel_entrega, principais = var.principais_ops_provisionamento_entrega }
  }
  ops_prov_papeis_ativos = { for k, p in local.ops_prov_papeis_humanos : k => p if length(p.principais) > 0 }
}

data "aws_iam_policy_document" "confianca_ops_provisionamento" {
  for_each = local.ops_prov_papeis_humanos

  dynamic "statement" {
    for_each = length([for a in each.value.principais : a if can(regex(":user/", a))]) > 0 ? [1] : []
    content {
      sid     = "UsuarioNominalComMfa"
      actions = ["sts:AssumeRole", "sts:SetSourceIdentity"]
      principals {
        type        = "AWS"
        identifiers = ["arn:${data.aws_partition.atual.partition}:iam::${local.conta}:root"]
      }
      condition {
        test     = "ArnLike"
        variable = "aws:PrincipalArn"
        values   = [for a in each.value.principais : a if can(regex(":user/", a))]
      }
      condition {
        test     = "StringEquals"
        variable = "sts:SourceIdentity"
        values   = ["$${aws:username}"]
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
  dynamic "statement" {
    for_each = length([for a in each.value.principais : a if !can(regex(":user/", a))]) > 0 ? [1] : []
    content {
      sid     = "SsoComMfaESourceIdentity"
      actions = ["sts:AssumeRole", "sts:SetSourceIdentity"]
      principals {
        type        = "AWS"
        identifiers = ["arn:${data.aws_partition.atual.partition}:iam::${local.conta}:root"]
      }
      condition {
        test     = "ArnLike"
        variable = "aws:PrincipalArn"
        values   = [for a in each.value.principais : a if !can(regex(":user/", a))]
      }
      condition {
        test     = "Null"
        variable = "sts:SourceIdentity"
        values   = ["false"]
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
}

resource "aws_iam_role" "ops_provisionamento" {
  for_each             = local.ops_prov_papeis_ativos
  name                 = each.value.nome
  description          = each.key == "executor" ? "Cria o pedido e roda o provisionamento da clínica (B11), sem ler a entrega: humano nominal com MFA e SourceIdentity, sessão de 1 h, todo RunTask gera alerta." : "Lê uma vez e apaga a entrega do token do provisionamento (B11), sem rodar a tarefa: humano nominal com MFA e SourceIdentity, sessão de 1 h, toda leitura gera alerta."
  assume_role_policy   = data.aws_iam_policy_document.confianca_ops_provisionamento[each.key].json
  max_session_duration = 3600
}

# Comum aos dois papéis: sem MFA nada, só São Paulo.
data "aws_iam_policy_document" "ops_provisionamento_comum" {
  # Mesmo que alguém amplie a confiança: sessão sem MFA não roda, não passa papel e não toca o SSM.
  statement {
    sid       = "SemMfaNada"
    effect    = "Deny"
    actions   = ["ecs:RunTask", "iam:PassRole", "ssm:PutParameter", "ssm:GetParameter", "ssm:DeleteParameter", "kms:Decrypt"]
    resources = ["*"]
    condition {
      test     = "BoolIfExists"
      variable = "aws:MultiFactorAuthPresent"
      values   = ["false"]
    }
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

data "aws_iam_policy_document" "ops_provisionamento_executor" {
  source_policy_documents = [data.aws_iam_policy_document.ops_provisionamento_comum.json]

  # Roda SÓ a revisão atual desta definição (ARN com revisão), SÓ neste cluster.
  statement {
    sid       = "RodarProvisionamento"
    actions   = ["ecs:RunTask"]
    resources = [aws_ecs_task_definition.ops_provisionamento.arn]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.this.arn]
    }
  }
  statement {
    sid       = "PassarPapeisDoProvisionamento"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.ops_provisionamento_execucao.arn, aws_iam_role.ops_provisionamento_tarefa.arn]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
  statement {
    sid       = "AcompanharTarefa"
    actions   = ["ecs:DescribeTasks"]
    resources = ["arn:${data.aws_partition.atual.partition}:ecs:${local.regiao}:${local.conta}:task/${aws_ecs_cluster.this.name}/*"]
  }
  statement {
    sid       = "LerSaidaDoProvisionamento"
    actions   = ["logs:GetLogEvents"]
    resources = ["${aws_cloudwatch_log_group.api.arn}:log-stream:${local.ops_prov_prefixo}/*"]
  }
  # Cria o pedido e o apaga se nasceu errado. `*` atravessa a barra: o Deny abaixo tira a entrega.
  statement {
    sid       = "CriarEApagarOPedido"
    actions   = ["ssm:PutParameter", "ssm:DeleteParameter"]
    resources = [local.ops_prov_pedidos]
  }
  statement {
    sid       = "CifrarOPedido"
    actions   = ["kms:Encrypt", "kms:GenerateDataKey"]
    resources = [aws_kms_key.this["ops-provisionamento"].arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = [local.ops_prov_via_ssm]
    }
    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:PARAMETER_ARN"
      values   = [local.ops_prov_pedidos]
    }
  }
  # C1: quem roda não toca a entrega (nem forja, nem lê, nem apaga). Reler o pedido (e-mail em
  # claro) também fica de fora: não há Get liberado, e a key policy nega o Decrypt a este papel.
  statement {
    sid       = "NaoTocaAEntrega"
    effect    = "Deny"
    actions   = ["ssm:PutParameter", "ssm:GetParameter", "ssm:GetParameters", "ssm:GetParameterHistory", "ssm:DeleteParameter"]
    resources = [local.ops_prov_entregas]
  }
}

data "aws_iam_policy_document" "ops_provisionamento_entrega" {
  source_policy_documents = [data.aws_iam_policy_document.ops_provisionamento_comum.json]

  # Lê a entrega uma vez, entrega fora de banda e apaga (R3).
  statement {
    sid       = "LerEApagarAEntrega"
    actions   = ["ssm:GetParameter", "ssm:DeleteParameter"]
    resources = [local.ops_prov_entregas]
  }
  statement {
    sid       = "DecifrarAEntrega"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.this["ops-provisionamento"].arn]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = [local.ops_prov_via_ssm]
    }
    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:PARAMETER_ARN"
      values   = [local.ops_prov_entregas]
    }
  }
  # C1: quem entrega não roda a tarefa, não passa os papéis dela e não grava nada no fluxo (nem
  # pedido, nem entrega forjada).
  statement {
    sid       = "NaoRodaENaoGrava"
    effect    = "Deny"
    actions   = ["ecs:RunTask", "ecs:StartTask", "iam:PassRole", "ssm:PutParameter"]
    resources = ["*"]
  }
}

locals {
  ops_prov_politicas = {
    executor = data.aws_iam_policy_document.ops_provisionamento_executor.json
    entrega  = data.aws_iam_policy_document.ops_provisionamento_entrega.json
  }
}

resource "aws_iam_role_policy" "ops_provisionamento" {
  for_each = local.ops_prov_papeis_ativos
  name     = each.key == "executor" ? "rodar-provisionamento" : "entregar-token-do-provisionamento"
  role     = aws_iam_role.ops_provisionamento[each.key].id
  policy   = local.ops_prov_politicas[each.key]
}

# --- Alerta a cada execução (padrão R-B do parecer do código do #190) ------------------------------
# Duas regras no tópico de alertas de segurança:
#   1. <nome>-ops-provisionamento-execucao: TODA chamada a RunTask desta família;
#   2. <nome>-ops-provisionamento-override-suspeito (CRÍTICO): variável de ambiente com nome diferente
#      de CONFIRMA_PROVISIONAMENTO, environmentFiles, troca de papel ou ECS Exec.
# O EventBridge não confere tamanho nem ordem do `command`: fica com a regra 1 e com o conferente, que
# confere o override no evento do CloudTrail e anota no chamado (runbook).

locals {
  ops_prov_evento_runtask = {
    source        = ["aws.ecs"]
    "detail-type" = ["AWS API Call via CloudTrail"]
  }
  ops_prov_familia_curinga = [{ wildcard = "*${local.ops_prov_nome}*" }]
}

resource "aws_cloudwatch_event_rule" "ops_provisionamento_execucao" {
  name        = "${local.ops_prov_nome}-execucao"
  description = "Toda execução (RunTask) do provisionamento da clínica (B11)."
  event_pattern = jsonencode(merge(local.ops_prov_evento_runtask, {
    detail = {
      eventSource       = ["ecs.amazonaws.com"]
      eventName         = ["RunTask"]
      requestParameters = { taskDefinition = local.ops_prov_familia_curinga }
    }
  }))
}

resource "aws_cloudwatch_event_target" "ops_provisionamento_execucao" {
  rule = aws_cloudwatch_event_rule.ops_provisionamento_execucao.name
  arn  = aws_sns_topic.alertas_seguranca.arn
}

resource "aws_cloudwatch_event_rule" "ops_provisionamento_override_suspeito" {
  name        = "${local.ops_prov_nome}-override-suspeito"
  description = "CRITICO: RunTask do provisionamento com override fora do runbook (variável além de CONFIRMA_PROVISIONAMENTO, troca de papel, ECS Exec)."
  event_pattern = jsonencode(merge(local.ops_prov_evento_runtask, {
    detail = {
      eventSource = ["ecs.amazonaws.com"]
      eventName   = ["RunTask"]
      "$or" = [
        { requestParameters = { taskDefinition = local.ops_prov_familia_curinga, overrides = { containerOverrides = { environment = { name = [{ "anything-but" = "CONFIRMA_PROVISIONAMENTO" }] } } } } },
        { requestParameters = { taskDefinition = local.ops_prov_familia_curinga, overrides = { containerOverrides = { environmentFiles = [{ exists = true }] } } } },
        { requestParameters = { taskDefinition = local.ops_prov_familia_curinga, overrides = { taskRoleArn = [{ exists = true }] } } },
        { requestParameters = { taskDefinition = local.ops_prov_familia_curinga, overrides = { executionRoleArn = [{ exists = true }] } } },
        { requestParameters = { taskDefinition = local.ops_prov_familia_curinga, enableExecuteCommand = [true] } },
      ]
    }
  }))
}

resource "aws_cloudwatch_event_target" "ops_provisionamento_override_suspeito" {
  rule = aws_cloudwatch_event_rule.ops_provisionamento_override_suspeito.name
  arn  = aws_sns_topic.alertas_seguranca.arn
}

# 3. <nome>-ops-provisionamento-entrega (A6, trilha do "entregue em" de C1): toda leitura ou
#    apagamento de /provisionamento/*/entrega. GetParameter é evento de leitura: o EventBridge só o
#    recebe com a regra no estado ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS (o trail já grava
#    os eventos de gerenciamento de leitura, cloudtrail.tf). O alerta leva o SourceIdentity; quem
#    confere o chamado compara com o do RunTask (a separação em si já é garantida pelos dois papéis).
resource "aws_cloudwatch_event_rule" "ops_provisionamento_entrega" {
  name        = "${local.ops_prov_nome}-entrega"
  description = "Leitura ou apagamento da entrega do token do provisionamento (B11)."
  state       = "ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS"
  event_pattern = jsonencode({
    source        = ["aws.ssm"]
    "detail-type" = ["AWS API Call via CloudTrail"]
    detail = {
      eventSource = ["ssm.amazonaws.com"]
      eventName   = ["GetParameter", "GetParameters", "GetParameterHistory", "DeleteParameter", "DeleteParameters"]
      "$or" = [
        { requestParameters = { name = [{ wildcard = "/provisionamento/*/entrega" }] } },
        { requestParameters = { names = [{ wildcard = "/provisionamento/*/entrega" }] } },
      ]
    }
  })
}

resource "aws_cloudwatch_event_target" "ops_provisionamento_entrega" {
  rule = aws_cloudwatch_event_rule.ops_provisionamento_entrega.name
  arn  = aws_sns_topic.alertas_seguranca.arn
}

# 4. <nome>-ops-entrega-vencida (C2 do parecer 2026-11-17-codigo-infra-ops-provisionamento): a
#    entrega que ninguém retirou vence pela política Expiration do PutParameter (72 h no
#    provisionamento, 24 h na recuperação, #206) e o SSM a apaga. O alerta avisa quem opera que o
#    token não chegou ao destinatário e o chamado precisa de nova rodada. Vale para os dois fluxos.
resource "aws_cloudwatch_event_rule" "ops_entrega_vencida" {
  name        = "${local.nome}-ops-entrega-vencida"
  description = "Entrega de token (provisionamento ou recuperação) vencida sem retirada pela política Expiration."
  event_pattern = jsonencode({
    source        = ["aws.ssm"]
    "detail-type" = ["Parameter Store Policy Action"]
    detail = {
      "policy-type" = ["Expiration"]
      "$or" = [
        { "parameter-name" = [{ wildcard = "/provisionamento/*/entrega" }] },
        { "parameter-name" = [{ wildcard = "/recuperacao-suporte/*/entrega" }] },
      ]
    }
  })
}

resource "aws_cloudwatch_event_target" "ops_entrega_vencida" {
  rule = aws_cloudwatch_event_rule.ops_entrega_vencida.name
  arn  = aws_sns_topic.alertas_seguranca.arn
}

# --- Papéis de máquina NUNCA rodam esta tarefa nem tocam os parâmetros (R7) ---------------------
# Mesma lista de papéis de máquina do B10 (local.ops_anon_papeis_sem_acesso). O Deny explícito
# garante que uma ampliação futura (curinga) não alcance o provisionamento.

data "aws_iam_policy_document" "nega_ops_provisionamento" {
  statement {
    sid     = "NaoRodaProvisionamento"
    effect  = "Deny"
    actions = ["ecs:RunTask", "ecs:StartTask"]
    resources = [
      "arn:${data.aws_partition.atual.partition}:ecs:${local.regiao}:${local.conta}:task-definition/${local.ops_prov_nome}:*",
    ]
  }
  statement {
    sid       = "NaoPassaPapeisDoProvisionamento"
    effect    = "Deny"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.ops_provisionamento_execucao.arn, aws_iam_role.ops_provisionamento_tarefa.arn]
  }
  statement {
    sid       = "NaoTocaOsParametros"
    effect    = "Deny"
    actions   = ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParameterHistory", "ssm:GetParametersByPath", "ssm:PutParameter", "ssm:DeleteParameter", "ssm:DeleteParameters"]
    resources = [local.ops_prov_parametros, local.ops_prov_pedidos]
  }
  statement {
    sid       = "NaoUsaAChaveDosParametros"
    effect    = "Deny"
    actions   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey*", "kms:ReEncrypt*", "kms:CreateGrant"]
    resources = [aws_kms_key.this["ops-provisionamento"].arn]
  }
}

resource "aws_iam_role_policy" "nega_ops_provisionamento" {
  for_each = local.ops_anon_papeis_sem_acesso
  name     = "nega-ops-provisionamento"
  role     = each.value
  policy   = data.aws_iam_policy_document.nega_ops_provisionamento.json
}
