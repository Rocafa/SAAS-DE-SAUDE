# common

Componentes transversais (a implementar em `eng/api-bootstrap`):

- `tenant/` — `TenantGuard`, `TenantContextInterceptor` (abre transação e executa `SET LOCAL app.tenant_id`)
- `audit/` — `AuditInterceptor` (eventos sem conteúdo clínico)
- `crypto/` — envelope encryption (KMS) e blind index (HMAC)
- `logging/` — logger estruturado com redaction de PII
