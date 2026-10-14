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

output "ancora_auditoria_bucket" {
  description = "Bucket (Object Lock COMPLIANCE) onde o job publica a âncora da auditoria encadeada."
  value       = module.ancora_auditoria.bucket
}

output "papel_ancora_publicador" {
  description = "Papel de tarefa do job que publica a âncora (único que grava no bucket)."
  value       = aws_iam_role.ancora_publicador.arn
}

output "papel_gestor_chaves" {
  description = "Papel de tarefa do job de onboarding/eliminação que cria e destrói as KEKs das clínicas."
  value       = aws_iam_role.gestor_chaves.arn
}

output "bucket_exportacoes" {
  description = "Bucket efêmero dos pacotes de exportação (G2), só para a tarefa da API."
  value       = aws_s3_bucket.exportacoes.bucket
}

output "bucket_documentos" {
  description = "Bucket privado de documentos assinados."
  value       = aws_s3_bucket.documentos.bucket
}

output "kms_deny_humanos" {
  description = "Política (JSON) cujo statement o KmsKeyProvider inclui na key policy de cada KEK de clínica: humano não decifra (R4 do PR #58)."
  value       = data.aws_iam_policy_document.kms_deny_humanos.json
}

output "papel_break_glass" {
  description = "Papel de emergência: humano com MFA, sessão de 1 h, todo uso gera alerta (R4)."
  value       = aws_iam_role.break_glass.arn
}

output "papel_investigacao_seguranca" {
  description = "Papel que lê o bucket de logs de acesso: humano com MFA, sessão de 1 h, uso gera alerta (R2)."
  value       = aws_iam_role.investigacao_seguranca.arn
}
