-- 0002 — Garantia de Saída: status de assinatura no tenant + trilha de auditoria append-only.
-- Executar com o papel de MIGRAÇÃO (app_migrator). Ver docs/04-arquitetura/garantia-de-saida.md.
--
-- Política em src/modules/exports/access-policy.ts: o status de assinatura não restringe
-- leitura/exportação, exceto após a janela de saída (cancelled_at + EXIT_WINDOW_DAYS, piso 90).
-- past_due/read_only bloqueiam só ESCRITA. Eliminação pós-janela NÃO é implementada aqui.

ALTER TABLE tenants
  ADD COLUMN subscription_status text NOT NULL DEFAULT 'active'
    CONSTRAINT tenants_subscription_status_check
    CHECK (subscription_status IN ('trialing', 'active', 'past_due', 'read_only', 'cancelled')),
  ADD COLUMN cancelled_at timestamptz,
  -- Cancelado sem data quebraria o cálculo da janela de saída (G4).
  ADD CONSTRAINT tenants_cancelled_at_check
    CHECK (subscription_status <> 'cancelled' OR cancelled_at IS NOT NULL);

-- Trilha de auditoria. metadata guarda SOMENTE metadados (contagens, versão, formato) —
-- nunca conteúdo clínico nem PII de paciente.
CREATE TABLE audit_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  actor_id   uuid NOT NULL,
  action     text NOT NULL CONSTRAINT audit_log_action_check CHECK (action IN (
               'read', 'create', 'update', 'sign', 'export', 'share',
               'login', 'login_failed', 'permission_change', 'consent_change')),
  scope      text NOT NULL CONSTRAINT audit_log_scope_check CHECK (scope ~ '^[a-z][a-z0-9_.:-]{0,63}$'),
  metadata   jsonb NOT NULL DEFAULT '{}'::jsonb
               CONSTRAINT audit_log_metadata_check CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_tenant_created_idx ON audit_log (tenant_id, created_at);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
-- Só SELECT e INSERT têm policy: sem policy de UPDATE/DELETE, o RLS também nega essas operações.
CREATE POLICY audit_log_select ON audit_log FOR SELECT
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY audit_log_insert ON audit_log FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Append-only, camada 1: o runtime só tem SELECT/INSERT (os DEFAULT PRIVILEGES deram UPDATE/DELETE).
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM app_user;

-- Append-only, camada 2: trigger rejeita alteração/remoção por QUALQUER papel (inclusive o dono).
CREATE FUNCTION audit_log_reject_mutation() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log é append-only: % não permitido', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_reject_mutation();
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_reject_mutation();
