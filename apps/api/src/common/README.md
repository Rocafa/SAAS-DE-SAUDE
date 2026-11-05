# common

Componentes transversais (a implementar em `eng/api-bootstrap`):

- `tenant/` — `TenantGuard`, `TenantContextInterceptor` (abre transação e executa `SET LOCAL app.tenant_id`)
- `audit/` — `AuditInterceptor` (eventos sem conteúdo clínico)
- `crypto/` — envelope encryption (KMS) e blind index (HMAC)
- Log de segurança estruturado: `src/security/log-de-seguranca.ts` (catálogo fechado de eventos, campos com formato validado, nunca dado pessoal), com a trava de PR `src/security/logs-sem-dado-pessoal.test.ts`. Ver `docs/03-seguranca-lgpd/logs-de-seguranca.md`.
