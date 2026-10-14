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

variable "tls_ate_a_tarefa" {
  description = "TLS também no trecho ALB -> tarefa da API (R6 do PR #58). Exige a API escutando HTTPS (API_TLS=autoassinado, ENG). Proposta: true em prod."
  type        = bool
  default     = false
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
  description = "Retenção padrão (GOVERNANCE) dos objetos do bucket de documentos. Anti-ransomware, não custódia do prontuário (V1 do PR #58): no máximo 35 dias."
  type        = number
  default     = 1
  validation {
    condition     = var.object_lock_dias >= 1 && var.object_lock_dias <= 35
    error_message = "Entre 1 e 35 dias: Object Lock longo tornaria falsa a eliminação prometida na G3."
  }
}

variable "trilha_retencao_dias" {
  description = "Retenção (Object Lock COMPLIANCE) dos arquivos do CloudTrail. 365 = 12 meses (proposta da D7 para registros de acesso; Marco Civil art. 15 exige no mínimo 6 meses)."
  type        = number
  default     = 365
  validation {
    condition     = var.trilha_retencao_dias >= 180
    error_message = "Mínimo de 180 dias (Marco Civil, art. 15)."
  }
}

variable "exportacao_expiracao_dias" {
  description = "Dias até o S3 expirar um pacote de exportação (G2: link de 24 h). Máximo 7 (V1 do PR #58)."
  type        = number
  default     = 2
  validation {
    condition     = var.exportacao_expiracao_dias >= 1 && var.exportacao_expiracao_dias <= 7
    error_message = "Entre 1 e 7 dias."
  }
}

# --- Retenção de logs (R9 do parecer do PR #58; os valores de prod dependem da D7) ----------
# Dois grupos, porque a natureza é diferente:
#   - registros de ACESSO (log da API e do WAF; ALB e acesso aos buckets, no bucket "logs"):
#     o Marco Civil (art. 15) pede no mínimo 6 meses em prod. Proposta para a D7: 12 meses.
#   - logs TÉCNICOS (flow logs, Redis, RDS, métricas), sem dado pessoal. Proposta: 90 dias.
# Staging (só dado sintético, R8) usa prazos curtos. Tabela em infra-staging.md §4.2.

variable "logs_retencao_dias" {
  description = "Retenção dos logs TÉCNICOS no CloudWatch (flow logs, Redis, RDS, Container Insights, RDSOSMetrics). Staging: 30. Proposta de prod (D7): 90."
  type        = number
  default     = 30
  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.logs_retencao_dias)
    error_message = "Use um valor aceito pelo CloudWatch Logs (ex.: 30, 90)."
  }
}

variable "logs_acesso_retencao_dias" {
  description = "Retenção dos REGISTROS DE ACESSO no CloudWatch (log da API e do WAF). Staging: 30. Proposta de prod (D7): 365; mínimo legal em prod: 180 (Marco Civil, art. 15)."
  type        = number
  default     = 30
  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.logs_acesso_retencao_dias)
    error_message = "Use um valor aceito pelo CloudWatch Logs (ex.: 30, 180, 365)."
  }
}

variable "logs_bucket_retencao_dias" {
  description = "Dias até expirar um objeto do bucket logs (access logs do ALB e dos buckets). Staging: 90. Proposta de prod (D7): 365; mínimo legal em prod: 180."
  type        = number
  default     = 90
  validation {
    condition     = var.logs_bucket_retencao_dias >= 30 && var.logs_bucket_retencao_dias <= 400
    error_message = "Entre 30 e 400 dias."
  }
}

variable "redis_slow_log" {
  description = "Liga a entrega do slow-log do Redis ao CloudWatch. O slow-log grava os argumentos dos comandos: só ligar quando fila e chaves usarem apenas ids opacos (R5 do PR #58)."
  type        = bool
  default     = false
}

variable "redis_auth_versao" {
  description = "Versão do token de AUTH do Redis. Incrementar gera um token novo e o grava (write-only) no ElastiCache e no Secrets Manager na mesma execução."
  type        = number
  default     = 1
  validation {
    condition     = var.redis_auth_versao >= 1 && floor(var.redis_auth_versao) == var.redis_auth_versao
    error_message = "Inteiro >= 1."
  }
}

variable "banco_senhas_versao" {
  description = "Versão das senhas de app_user e app_migrator. Incrementar gera senhas novas no Secrets Manager; depois, reexecutar infra/rds/bootstrap.sh."
  type        = number
  default     = 1
  validation {
    condition     = var.banco_senhas_versao >= 1 && floor(var.banco_senhas_versao) == var.banco_senhas_versao
    error_message = "Inteiro >= 1."
  }
}

# --- Âncora da auditoria encadeada (R2 do parecer do PR #37) -------------------------------

variable "conta_auditoria_id" {
  description = "Conta AWS separada que guarda a âncora da auditoria. null = mesma conta de staging (aceitável só em staging, com papel e política separados)."
  type        = string
  default     = null
  validation {
    condition     = var.conta_auditoria_id == null || can(regex("^[0-9]{12}$", var.conta_auditoria_id))
    error_message = "conta_auditoria_id deve ter 12 dígitos ou ser null."
  }
}

variable "papel_auditoria_arn" {
  description = "Papel que o Terraform assume na conta de auditoria para criar o bucket da âncora. Obrigatório quando conta_auditoria_id é definido."
  type        = string
  default     = null
  validation {
    condition     = (var.conta_auditoria_id == null) == (var.papel_auditoria_arn == null)
    error_message = "Defina conta_auditoria_id e papel_auditoria_arn juntos (ou nenhum dos dois)."
  }
}

variable "ancora_retencao_dias" {
  description = "Retenção em modo COMPLIANCE de cada âncora publicada. Ninguém (nem o root) apaga ou encurta antes do prazo. Staging: 1 dia (dados sintéticos); prod: o prazo da trilha (D7)."
  type        = number
  default     = 1
  validation {
    condition     = var.ancora_retencao_dias >= 1
    error_message = "Mínimo de 1 dia."
  }
}

# --- Chave mestra (KEK) por clínica (item 22 do parecer do PR #35) -------------------------

variable "kek_janela_exclusao_dias" {
  description = "Janela mínima de ScheduleKeyDeletion aceita para as KEKs das clínicas (7 a 30). A API usa 7 (KMS_DELETION_WINDOW_DAYS)."
  type        = number
  default     = 7
  validation {
    condition     = var.kek_janela_exclusao_dias >= 7 && var.kek_janela_exclusao_dias <= 30
    error_message = "Entre 7 e 30 dias (limites do KMS)."
  }
}
