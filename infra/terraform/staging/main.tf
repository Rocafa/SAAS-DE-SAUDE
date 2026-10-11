# Conta STAGING (sa-east-1). Nada aqui foi aplicado: o CI só roda fmt, validate, tflint e checkov.
#
# Backend: configuração parcial. Depois do apply de ../bootstrap-state:
#   terraform init -backend-config=backend.hcl
# (backend.hcl recebe o output backend_hcl; não tem segredo, mas fica fora do git por ter o ID da conta.)
terraform {
  required_version = ">= 1.10.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.60.0, < 7.0.0"
    }
    random = {
      source  = "hashicorp/random"
      version = ">= 3.6.0, < 4.0.0"
    }
  }

  backend "s3" {
    key     = "staging/terraform.tfstate"
    region  = "sa-east-1"
    encrypt = true
    # bucket, dynamodb_table e kms_key_id vêm do backend.hcl
  }
}

provider "aws" {
  region              = var.regiao
  allowed_account_ids = [var.conta_aws_id]

  default_tags {
    tags = {
      projeto    = "plataforma-saude"
      ambiente   = local.ambiente
      gerenciado = "terraform"
      dados      = "sinteticos"
    }
  }
}

data "aws_region" "atual" {}
data "aws_caller_identity" "atual" {}
data "aws_partition" "atual" {}

# Trava de região em camadas: (1) validação da variável, (2) backend fixo em sa-east-1,
# (3) esta precondição contra a região efetiva do provider, (4) Deny por aws:RequestedRegion
# no papel do GitHub (oidc.tf).
resource "terraform_data" "trava_regiao" {
  lifecycle {
    precondition {
      condition     = data.aws_region.atual.region == "sa-east-1"
      error_message = "Provider apontando para região fora de sa-east-1. Dados de saúde ficam no Brasil."
    }
  }
}

locals {
  ambiente = "staging"
  nome     = "plataforma-saude-${local.ambiente}"
  conta    = data.aws_caller_identity.atual.account_id
  regiao   = data.aws_region.atual.region
}
