output "bucket" {
  description = "Nome do bucket da âncora (variável de ambiente do job publicador)."
  value       = aws_s3_bucket.ancora.bucket
}

output "bucket_arn" {
  description = "ARN do bucket da âncora."
  value       = aws_s3_bucket.ancora.arn
}

output "kms_key_arn" {
  description = "Chave KMS que cifra as âncoras (o publicador grava com ela)."
  value       = aws_kms_key.ancora.arn
}
