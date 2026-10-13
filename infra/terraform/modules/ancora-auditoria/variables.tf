variable "prefixo_nome" {
  description = "Prefixo dos nomes (ex.: plataforma-saude-staging)."
  type        = string
}

variable "publicadores_arn" {
  description = "ARNs dos papéis IAM que podem publicar âncoras (job de âncora). Nunca o papel da API."
  type        = list(string)
  validation {
    condition     = length(var.publicadores_arn) > 0
    error_message = "Informe ao menos um papel publicador."
  }
}

variable "leitores_arn" {
  description = "ARNs dos papéis que podem ler âncoras (verificador da cadeia). Opcional."
  type        = list(string)
  default     = []
}

variable "retencao_dias" {
  description = "Retenção padrão em modo COMPLIANCE de cada versão publicada."
  type        = number
  validation {
    condition     = var.retencao_dias >= 1
    error_message = "Mínimo de 1 dia."
  }
}
