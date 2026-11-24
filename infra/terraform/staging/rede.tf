# VPC em 3 AZs com três camadas: pública (só ALB e NAT), app (ECS) e dados (RDS, Redis).
# App e dados não têm rota para a internet; serviços AWS chegam por VPC endpoint.
resource "aws_vpc" "this" {
  cidr_block           = var.cidr_vpc
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = local.nome }
}

# Grupo padrão sem nenhuma regra: nada usa o default por acidente.
resource "aws_default_security_group" "this" {
  vpc_id = aws_vpc.this.id
}

resource "aws_subnet" "publica" {
  count                   = 3
  vpc_id                  = aws_vpc.this.id
  availability_zone       = var.zonas[count.index]
  cidr_block              = cidrsubnet(var.cidr_vpc, 8, count.index)
  map_public_ip_on_launch = false
  tags                    = { Name = "${local.nome}-publica-${var.zonas[count.index]}", camada = "publica" }
}

resource "aws_subnet" "app" {
  count             = 3
  vpc_id            = aws_vpc.this.id
  availability_zone = var.zonas[count.index]
  cidr_block        = cidrsubnet(var.cidr_vpc, 8, 10 + count.index)
  tags              = { Name = "${local.nome}-app-${var.zonas[count.index]}", camada = "app" }
}

resource "aws_subnet" "dados" {
  count             = 3
  vpc_id            = aws_vpc.this.id
  availability_zone = var.zonas[count.index]
  cidr_block        = cidrsubnet(var.cidr_vpc, 8, 20 + count.index)
  tags              = { Name = "${local.nome}-dados-${var.zonas[count.index]}", camada = "dados" }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = local.nome }
}

resource "aws_route_table" "publica" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }
  tags = { Name = "${local.nome}-publica" }
}

resource "aws_route_table_association" "publica" {
  count          = 3
  subnet_id      = aws_subnet.publica[count.index].id
  route_table_id = aws_route_table.publica.id
}

resource "aws_eip" "nat" {
  count  = var.habilitar_nat ? 1 : 0
  domain = "vpc"
  tags   = { Name = "${local.nome}-nat" }
}

resource "aws_nat_gateway" "this" {
  count         = var.habilitar_nat ? 1 : 0
  allocation_id = aws_eip.nat[0].id
  subnet_id     = aws_subnet.publica[0].id
  tags          = { Name = local.nome }
}

resource "aws_route_table" "app" {
  vpc_id = aws_vpc.this.id
  dynamic "route" {
    for_each = var.habilitar_nat ? [1] : []
    content {
      cidr_block     = "0.0.0.0/0"
      nat_gateway_id = aws_nat_gateway.this[0].id
    }
  }
  tags = { Name = "${local.nome}-app" }
}

resource "aws_route_table_association" "app" {
  count          = 3
  subnet_id      = aws_subnet.app[count.index].id
  route_table_id = aws_route_table.app.id
}

# Camada de dados: sem rota padrão nenhuma, nem por NAT.
resource "aws_route_table" "dados" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${local.nome}-dados" }
}

resource "aws_route_table_association" "dados" {
  count          = 3
  subnet_id      = aws_subnet.dados[count.index].id
  route_table_id = aws_route_table.dados.id
}

# --- VPC endpoints -------------------------------------------------------------------------

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${local.regiao}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.app.id, aws_route_table.dados.id]
  tags              = { Name = "${local.nome}-s3" }
}

resource "aws_security_group" "endpoints" {
  name        = "${local.nome}-endpoints"
  description = "HTTPS da VPC para os VPC endpoints de interface"
  vpc_id      = aws_vpc.this.id

  ingress {
    description = "HTTPS de dentro da VPC"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [var.cidr_vpc]
  }
}

locals {
  # ecr.dkr + ecr.api: pull de imagem; secretsmanager: segredos da task; kms: decifrar; logs: awslogs.
  # O ssm (tarefas avulsas B11/B12/B13) é à parte, condicional e com política de endpoint (abaixo).
  endpoints_interface = toset(["ecr.api", "ecr.dkr", "secretsmanager", "kms", "logs"])
}

resource "aws_vpc_endpoint" "interface" {
  for_each = local.endpoints_interface

  vpc_id              = aws_vpc.this.id
  service_name        = "com.amazonaws.${local.regiao}.${each.key}"
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true
  subnet_ids          = slice(aws_subnet.app[*].id, 0, var.zonas_dos_endpoints)
  security_group_ids  = [aws_security_group.endpoints.id]
  tags                = { Name = "${local.nome}-${each.key}" }
}

# Endpoint ssm das tarefas avulsas do provisionamento, da recuperação e da troca do admin único
# (B11, B12, B13; A4 do parecer de
# 17/11/2026). Só com var.endpoint_ssm = true. Custo (ESTIMATIVA, conferir na página de preços do AWS
# PrivateLink para sa-east-1 antes de ligar): da ordem de US$ 7 a 12 por mês por AZ, mais o tráfego;
# staging tem zonas_dos_endpoints = 1, prod teria 3. Desligado, as tarefas NÃO chegam ao SSM (o grupo
# de segurança delas só sai para 443 dentro da VPC, sem NAT) e falham fechado: ligar junto com o PR
# do cliente SSM, antes da primeira execução real.
# A política de endpoint fecha o canal: só principal E recurso DESTA conta (sem ela, uma credencial de
# fora usaria o endpoint para gravar no SSM de outra conta) e só os parâmetros dos três fluxos.
data "aws_iam_policy_document" "endpoint_ssm" {
  statement {
    sid     = "SoParametrosDasTarefasAvulsasDestaConta"
    actions = ["ssm:GetParameter", "ssm:PutParameter", "ssm:DeleteParameter"]
    resources = [
      "arn:${data.aws_partition.atual.partition}:ssm:${local.regiao}:${local.conta}:parameter/provisionamento/*",
      "arn:${data.aws_partition.atual.partition}:ssm:${local.regiao}:${local.conta}:parameter/recuperacao-suporte/*",
      "${local.ops_troca_parametros}/*",
    ]
    principals {
      type        = "AWS"
      identifiers = ["*"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:PrincipalAccount"
      values   = [local.conta]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:ResourceAccount"
      values   = [local.conta]
    }
  }
}

resource "aws_vpc_endpoint" "ssm" {
  count = var.endpoint_ssm ? 1 : 0

  vpc_id              = aws_vpc.this.id
  service_name        = "com.amazonaws.${local.regiao}.ssm"
  vpc_endpoint_type   = "Interface"
  private_dns_enabled = true
  subnet_ids          = slice(aws_subnet.app[*].id, 0, var.zonas_dos_endpoints)
  security_group_ids  = [aws_security_group.endpoints.id]
  policy              = data.aws_iam_policy_document.endpoint_ssm.json
  tags                = { Name = "${local.nome}-ssm" }
}

# --- VPC flow logs (rejeitados e aceitos), cifrados ----------------------------------------

resource "aws_cloudwatch_log_group" "flow_logs" {
  #checkov:skip=CKV_AWS_338:Log técnico (IP e porta): logs_retencao_dias (staging 30; prod 90 proposto à D7, R9).
  name              = "/${local.nome}/vpc-flow-logs"
  retention_in_days = var.logs_retencao_dias
  kms_key_id        = aws_kms_key.this["logs"].arn
}

data "aws_iam_policy_document" "flow_logs_confianca" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["vpc-flow-logs.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.conta]
    }
  }
}

resource "aws_iam_role" "flow_logs" {
  name               = "${local.nome}-flow-logs"
  assume_role_policy = data.aws_iam_policy_document.flow_logs_confianca.json
}

data "aws_iam_policy_document" "flow_logs" {
  statement {
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogStreams",
    ]
    resources = ["${aws_cloudwatch_log_group.flow_logs.arn}:*"]
  }
}

resource "aws_iam_role_policy" "flow_logs" {
  name   = "escrever-flow-logs"
  role   = aws_iam_role.flow_logs.id
  policy = data.aws_iam_policy_document.flow_logs.json
}

resource "aws_flow_log" "this" {
  vpc_id          = aws_vpc.this.id
  traffic_type    = "ALL"
  log_destination = aws_cloudwatch_log_group.flow_logs.arn
  iam_role_arn    = aws_iam_role.flow_logs.arn
}
