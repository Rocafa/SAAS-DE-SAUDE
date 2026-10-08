# apps/api

API em **NestJS (TypeScript)** — monólito modular. Workers BullMQ rodam a partir da mesma base de código (processo separado).

Status: **bootstrap** — NestJS + `GET /health`, tenancy (`withTenant` → `set_config(app.tenant_id, …, true)`), migração `db/migrations/0001` com RLS FORCE. Teste de isolamento: `pnpm db:migrate` (DATABASE_MIGRATOR_URL) e `pnpm test:rls` (DATABASE_URL = app_user).

## Estrutura

```
src/
  common/                 Guards, interceptors e utilitários transversais
                          (TenantGuard, TenantContextInterceptor -> SET LOCAL app.tenant_id,
                           AuditInterceptor, crypto de campo, redaction de logs)
  modules/
    tenancy/              Tenant, Clinic, resolução de tenant, planos
    auth/                 User, Role, sessão, MFA, RBAC/ABAC
    patients/             Patient, Consent, PatientInsurance, pedidos do titular
    scheduling/           Schedule, Appointment, agendamento online, teleconsulta
    records/              MedicalRecord, RecordTemplate, RecordEntry (prontuário)
    prescriptions/        Prescription, Document, Signature (ICP-Brasil, Memed)
    billing/              Charge, Payment, Invoice (NFS-e), InsurancePlan, TISS
    audit/                AuditLog append-only com encadeamento de hash
```

Cada módulo seguirá: `*.module.ts`, `*.controller.ts`, `*.service.ts`, `*.repository.ts`, `dto/`, `adapters/` (integrações externas atrás de interfaces).

## Regras obrigatórias (checklist `docs/03-seguranca-lgpd/`)

1. Toda query filtra por `tenant_id` **e** a tabela tem RLS forçado.
2. Toda leitura/escrita de prontuário, prescrição ou documento gera evento de auditoria.
3. PII e conteúdo clínico cifrados em nível de campo (ver `docs/04-arquitetura/modelo-de-dados.md`).
4. Nenhum segredo no código; nenhum dado real em seed/teste.
5. Logs sem PII/dados clínicos.
