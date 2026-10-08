-- 0001 — Fundação multi-tenant: tenants + patients com RLS forçado.
-- Executar com o papel de MIGRAÇÃO (app_migrator, dono das tabelas).
-- O runtime usa app_user (NOBYPASSRLS, não dono) — ver infra/local/postgres-init.sh.
-- Colunas mínimas e fictícias: nenhuma PII real além de um nome de exibição sintético.

CREATE TABLE tenants (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE patients (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  display_name text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX patients_tenant_id_idx ON patients (tenant_id);

-- Contexto do tenant: NULLIF trata '' (valor que a GUC assume na conexão após um SET LOCAL
-- anterior expirar) como NULL. Sem contexto => NULL => nenhuma linha visível (falha fechada).
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenants
  USING (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE patients ENABLE ROW LEVEL SECURITY;
ALTER TABLE patients FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON patients
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Privilégios do runtime vêm dos DEFAULT PRIVILEGES de app_migrator (SELECT/INSERT/UPDATE/DELETE).
-- Menor privilégio: a aplicação não exclui tenants.
REVOKE DELETE ON tenants FROM app_user;
