variable "regiao" {
  description = "Região AWS. Dados ficam no Brasil: qualquer outra é recusada."
  type        = string
  default     = "sa-east-1"
  validation {
    condition     = var.regiao == "sa-east-1"
    error_message = "Somente sa-east-1 (São Paulo) é permitida."
  }
}

variable "conta_aws_id" {
  description = "ID da conta AWS de staging (12 dígitos). O provider recusa qualquer outra conta."
  type        = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.conta_aws_id))
    error_message = "conta_aws_id deve ter 12 dígitos."
  }
}
