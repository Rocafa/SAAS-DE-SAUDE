output "backend_hcl" {
  description = "Conteúdo de ../staging/backend.hcl depois do apply."
  value       = <<-EOT
    bucket         = "${aws_s3_bucket.estado.bucket}"
    dynamodb_table = "${aws_dynamodb_table.trava.name}"
    kms_key_id     = "${aws_kms_key.estado.arn}"
  EOT
}
