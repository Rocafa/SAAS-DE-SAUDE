-- 0003 — Contexto de tenant TRAVADO por transação (achado da suíte de segurança ofensiva).
-- Executar com o papel de MIGRAÇÃO (app_migrator). Ver docs/04-arquitetura/testes-de-seguranca.md.
--
-- Problema (0001/0002): as policies liam a GUC `app.tenant_id`, que QUALQUER sessão pode alterar
-- (`set_config`, `SET LOCAL`, `SET SESSION`). Um SQL injetado dentro da transação do tenant A
-- trocava a GUC para B e lia/escrevia dados de B.
--
-- Correção: o tenant da transação é gravado, uma única vez, numa tabela que o runtime NÃO acessa,
-- chaveada pelo ID da transação (txid, único no cluster). As policies leem dessa tabela via função
-- SECURITY DEFINER. A GUC deixa de ter efeito; a única porta é `app_set_tenant(uuid)`, chamada
-- por withTenant no início da transação, e uma segunda chamada com outro tenant é recusada.

CREATE UNLOGGED TABLE tenant_context (
  xid        bigint PRIMARY KEY,
  tenant_id  uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Os DEFAULT PRIVILEGES de app_migrator dariam SELECT/INSERT/UPDATE/DELETE ao runtime: retirar.
REVOKE ALL ON tenant_context FROM PUBLIC;
REVOKE ALL ON tenant_context FROM app_user;
-- Defesa em profundidade: RLS forçado; só o dono (usado pelas funções SECURITY DEFINER) tem policy.
-- Se um GRANT vazar para app_user no futuro, ainda assim ele não vê nem grava nenhuma linha.
ALTER TABLE tenant_context ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_context FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_context_definer_only ON tenant_context TO CURRENT_USER
  USING (true) WITH CHECK (true);

CREATE FUNCTION app_set_tenant(p_tenant uuid) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_xid     bigint := txid_current();
  v_current uuid;
BEGIN
  IF p_tenant IS NULL THEN
    RAISE EXCEPTION 'tenant nulo' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT tenant_id INTO v_current FROM public.tenant_context WHERE xid = v_xid;
  IF FOUND THEN
    IF v_current <> p_tenant THEN
      RAISE EXCEPTION 'contexto de tenant já definido nesta transação'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN;
  END IF;
  INSERT INTO public.tenant_context (xid, tenant_id) VALUES (v_xid, p_tenant);
  -- Limpeza oportunista: linhas de transações já encerradas (xid abaixo do xmin do snapshot).
  IF random() < 0.01 THEN
    DELETE FROM public.tenant_context WHERE xid < txid_snapshot_xmin(txid_current_snapshot());
  END IF;
END;
$$;

-- Lido pelas policies. Sem app_set_tenant nesta transação => NULL => nenhuma linha (falha fechada).
CREATE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT tenant_id FROM public.tenant_context WHERE xid = txid_current_if_assigned()
$$;

REVOKE ALL ON FUNCTION app_set_tenant(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_current_tenant() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_set_tenant(uuid) TO app_user;
GRANT EXECUTE ON FUNCTION app_current_tenant() TO app_user;

-- Policies passam a usar o contexto travado. `(SELECT ...)` vira InitPlan: avaliado 1x por consulta.
DROP POLICY tenant_isolation ON tenants;
CREATE POLICY tenant_isolation ON tenants
  USING (id = (SELECT app_current_tenant()))
  WITH CHECK (id = (SELECT app_current_tenant()));

DROP POLICY tenant_isolation ON patients;
CREATE POLICY tenant_isolation ON patients
  USING (tenant_id = (SELECT app_current_tenant()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()));

DROP POLICY audit_log_select ON audit_log;
CREATE POLICY audit_log_select ON audit_log FOR SELECT
  USING (tenant_id = (SELECT app_current_tenant()));
DROP POLICY audit_log_insert ON audit_log;
CREATE POLICY audit_log_insert ON audit_log FOR INSERT
  WITH CHECK (tenant_id = (SELECT app_current_tenant()));
