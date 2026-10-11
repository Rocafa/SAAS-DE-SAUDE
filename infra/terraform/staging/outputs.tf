output "alb_dns" {
  description = "DNS do ALB (apontar o domínio de staging aqui quando o I10 existir)."
  value       = aws_lb.this.dns_name
}

output "ecr_api" {
  description = "Repositório da imagem da API."
  value       = aws_ecr_repository.api.repository_url
}

output "papel_github_deploy" {
  description = "ARN para o role-to-assume do aws-actions/configure-aws-credentials (environment staging)."
  value       = aws_iam_role.github_deploy.arn
}

output "rds_endpoint" {
  description = "Endpoint do RDS (só acessível de dentro da VPC)."
  value       = aws_db_instance.this.address
}

output "rds_segredo_master" {
  description = "ARN do segredo do master (gerado pelo RDS) usado pelo infra/rds/bootstrap.sh."
  value       = aws_db_instance.this.master_user_secret[0].secret_arn
}

output "segredos_app" {
  description = "ARNs dos segredos da aplicação no Secrets Manager."
  value       = { for k, s in aws_secretsmanager_secret.app : k => s.arn }
}

output "bucket_documentos" {
  description = "Bucket privado de documentos e exportações."
  value       = aws_s3_bucket.documentos.bucket
}
