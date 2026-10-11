variable "regiao" {
  description = "Região AWS. Somente sa-east-1: dados de saúde ficam no Brasil."
  type        = string
  default     = "sa-east-1"
  validation {
    condition     = var.regiao == "sa-east-1"
    error_message = "Somente sa-east-1 (São Paulo) é permitida."
  }
}

variable "conta_aws_id" {
  description = "ID da conta AWS de staging. O provider recusa credencial de qualquer outra conta (ex.: prod)."
  type        = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.conta_aws_id))
    error_message = "conta_aws_id deve ter 12 dígitos."
  }
}

variable "zonas" {
  description = "Três AZs de sa-east-1."
  type        = list(string)
  default     = ["sa-east-1a", "sa-east-1b", "sa-east-1c"]
  validation {
    condition     = length(var.zonas) == 3 && alltrue([for z in var.zonas : startswith(z, "sa-east-1")])
    error_message = "Use exatamente 3 AZs de sa-east-1."
  }
}

variable "cidr_vpc" {
  description = "Bloco da VPC de staging."
  type        = string
  default     = "10.40.0.0/16"
}

variable "zonas_dos_endpoints" {
  description = "Em quantas AZs criar os VPC endpoints de interface (1 a 3). Cada endpoint cobra por AZ; staging usa 1, prod usa 3."
  type        = number
  default     = 1
  validation {
    condition     = var.zonas_dos_endpoints >= 1 && var.zonas_dos_endpoints <= 3
    error_message = "Entre 1 e 3."
  }
}

variable "habilitar_nat" {
  description = "Cria 1 NAT Gateway para saída à internet. Desligado: ECR, Secrets, KMS, Logs e S3 vão por VPC endpoint. Ligar quando houver integração externa (e-mail, WhatsApp)."
  type        = bool
  default     = false
}

variable "rds_classe" {
  description = "Classe da instância do RDS."
  type        = string
  default     = "db.t4g.small"
}

variable "rds_armazenamento_gb" {
  description = "Armazenamento inicial (gp3) do RDS."
  type        = number
  default     = 20
}

variable "redis_tipo_no" {
  description = "Tipo de nó do ElastiCache."
  type        = string
  default     = "cache.t4g.micro"
}

variable "api_imagem_tag" {
  description = "Tag da imagem da API no ECR: o SHA do commit (imagem imutável, a mesma promovida para prod)."
  type        = string
  validation {
    condition     = can(regex("^[0-9a-f]{40}$", var.api_imagem_tag))
    error_message = "Use o SHA completo do commit (40 hex), nunca latest."
  }
}

variable "api_tarefas" {
  description = "Quantidade de tarefas da API no ECS."
  type        = number
  default     = 1
}

variable "certificado_arn" {
  description = "ARN do certificado ACM do domínio de staging (I10: domínio e DNS ainda não existem)."
  type        = string
}

variable "github_repositorio" {
  description = "Repositório autorizado a assumir o papel de deploy via OIDC."
  type        = string
  default     = "Rocafa/SAAS-DE-SAUDE"
}

variable "object_lock_dias" {
  description = "Retenção padrão (modo GOVERNANCE em staging) dos objetos do bucket de documentos."
  type        = number
  default     = 1
}

variable "logs_retencao_dias" {
  description = "Retenção dos logs no CloudWatch em staging."
  type        = number
  default     = 30
}
