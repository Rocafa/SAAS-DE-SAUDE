-- 0044 — Pedido de correção do fundador em tabela interna e checagem de papel por lista branca (O-R17c da
-- conferência 2, 23/10/2026, do Guardião sobre o PR #63). Executar com o papel de MIGRAÇÃO (app_migrator).
-- Ver docs/04-arquitetura/runbook-fundador-clinicas-existentes.md §"Correção do fundador errado".
--
-- NUMERAÇÃO: 0044 é da rodada 21 (#63 O-R17c), depois da 0043 (agendador de jobs).
--
-- Problema (O-R17c):
--   * a confirmação (0042) lia o pedido de `audit_log`, onde o runtime pode inserir linhas `sistema` da
--     clínica. Com SQL injetado dava para forjar um `founder_fix_requested` (pular o passo 1 se o conferente
--     recebesse o id forjado) ou um `founder_fixed` (bloquear uma confirmação legítima: negação de serviço);
--   * duas confirmações concorrentes podiam gravar `founder_fixed` em dobro;
--   * `app_runbook_corrigindo_fundador` e as duas funções do runbook usavam lista negra
--     (`current_user <> 'app_user'`): um papel novo (BI, leitura) herdaria a exceção.
--
-- Correção:
--   * `founder_fix_requests` (INTERNA: zero privilégio para o runtime e, portanto, para o portal, que usa o
--     mesmo papel; policy só do dono): o pedido mora aqui; a trilha continua recebendo `founder_fix_requested`
--     e `founder_fixed`, mas só como registro: a confirmação NÃO lê mais a trilha;
--   * a confirmação trava a linha do pedido (FOR UPDATE) e marca `confirmed_at`: vale uma vez, mesmo com
--     duas confirmações concorrentes;
--   * papel: `pg_has_role(current_user, 'app_migrator', 'MEMBER')` (lista branca) no guarda e nas duas
--     funções do runbook.

-- ------------------------------------------------------------------ tabela interna do pedido

CREATE TABLE founder_fix_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id),
  user_id_anterior uuid NOT NULL,
  user_id          uuid NOT NULL,
  chamado          text NOT NULL CHECK (chamado ~ '^[A-Za-z][A-Za-z0-9._-]{2,39}$'),
  requested_xid    bigint NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  confirmed_at     timestamptz,
  confirmed_xid    bigint,
  CHECK (user_id <> user_id_anterior),
  CHECK ((confirmed_at IS NULL) = (confirmed_xid IS NULL))
);
-- As DEFAULT PRIVILEGES do postgres-init.sh dão SELECT/INSERT/UPDATE/DELETE ao app_user: revogar explicitamente.
REVOKE ALL ON founder_fix_requests FROM PUBLIC;
REVOKE ALL ON founder_fix_requests FROM app_user;
ALTER TABLE founder_fix_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE founder_fix_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY founder_fix_requests_definer_only ON founder_fix_requests TO CURRENT_USER USING (true) WITH CHECK (true);

-- ------------------------------------------------------------------ lista branca de papel

CREATE OR REPLACE FUNCTION app_runbook_corrigindo_fundador(p_tenant uuid) RETURNS boolean
  LANGUAGE sql
  STABLE
  SET search_path = pg_catalog, public
AS $$
  SELECT pg_has_role(current_user, 'app_migrator', 'MEMBER') AND p_tenant IS NOT NULL
     AND COALESCE(current_setting('app.correcao_fundador', true), '') = p_tenant::text
$$;

CREATE OR REPLACE FUNCTION app_runbook_pedir_correcao_fundador(p_tenant uuid, p_errado uuid, p_correto uuid, p_chamado text) RETURNS uuid
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_pedido uuid;
BEGIN
  IF NOT pg_has_role(current_user, 'app_migrator', 'MEMBER') THEN
    RAISE EXCEPTION 'runbook só roda com o papel de operação (app_migrator)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_chamado IS NULL OR p_chamado !~ '^[A-Za-z][A-Za-z0-9._-]{2,39}$' THEN
    RAISE EXCEPTION 'chamado inválido (ex.: INC-123)' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_errado IS NULL OR p_correto IS NULL OR p_correto = p_errado
     OR p_correto = '00000000-0000-0000-0000-000000000000'::uuid THEN
    RAISE EXCEPTION 'userId correto inválido' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM app_set_tenant(p_tenant);
  IF NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = p_tenant AND t.founder_user_id = p_errado) THEN
    RAISE EXCEPTION 'o userId informado não é o fundador atual da clínica' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  INSERT INTO founder_fix_requests (tenant_id, user_id_anterior, user_id, chamado, requested_xid)
    VALUES (p_tenant, p_errado, p_correto, p_chamado, txid_current())
    RETURNING id INTO v_pedido;
  -- Só registro: a confirmação lê founder_fix_requests, nunca esta linha.
  INSERT INTO audit_log (tenant_id, actor_id, actor_kind, action, scope, metadata)
    VALUES (p_tenant, '00000000-0000-0000-0000-000000000000'::uuid, 'sistema', 'permission_change', 'tenants.founder',
            jsonb_build_object('op', 'founder_fix_requested', 'pedido', v_pedido, 'user_id_anterior', p_errado,
                               'user_id', p_correto, 'via', 'runbook_correcao', 'chamado', p_chamado));
  RETURN v_pedido;
END;
$$;

CREATE OR REPLACE FUNCTION app_runbook_confirmar_correcao_fundador(p_tenant uuid, p_pedido uuid, p_correto uuid, p_chamado text) RETURNS uuid
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_pedido founder_fix_requests;
  v_errado uuid;
  v_member uuid;
  v_revog  record;
BEGIN
  IF NOT pg_has_role(current_user, 'app_migrator', 'MEMBER') THEN
    RAISE EXCEPTION 'runbook só roda com o papel de operação (app_migrator)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM app_set_tenant(p_tenant);
  -- Trava a linha: duas confirmações concorrentes do mesmo pedido viram uma confirmação e uma recusa.
  SELECT * INTO v_pedido FROM founder_fix_requests r
   WHERE r.id = p_pedido AND r.tenant_id = p_tenant
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pedido de correção inexistente nesta clínica' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- Dupla confirmação: quem confirma não está na transação de quem pediu.
  IF v_pedido.requested_xid = txid_current() THEN
    RAISE EXCEPTION 'a confirmação é feita pelo conferente, em outra transação' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_pedido.confirmed_at IS NOT NULL THEN
    RAISE EXCEPTION 'pedido de correção já confirmado' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF v_pedido.created_at < now() - interval '24 hours' THEN
    RAISE EXCEPTION 'pedido de correção expirado: abra outro' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF p_correto IS NULL OR v_pedido.user_id IS DISTINCT FROM p_correto
     OR v_pedido.chamado IS DISTINCT FROM p_chamado THEN
    RAISE EXCEPTION 'confirmação não confere com o pedido (userId ou chamado)' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_errado := v_pedido.user_id_anterior;
  IF NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = p_tenant AND t.founder_user_id = v_errado) THEN
    RAISE EXCEPTION 'o fundador mudou desde o pedido' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  UPDATE founder_fix_requests SET confirmed_at = clock_timestamp(), confirmed_xid = txid_current() WHERE id = p_pedido;

  PERFORM set_config('app.correcao_fundador', p_tenant::text, true);
  PERFORM app_set_user(p_correto);
  UPDATE tenants SET founder_user_id = p_correto WHERE id = p_tenant;
  SELECT m.id INTO v_member FROM clinic_members m
   WHERE m.tenant_id = p_tenant AND m.user_id = p_correto AND m.role = 'admin' AND m.revoked_at IS NULL;
  IF v_member IS NULL THEN
    INSERT INTO clinic_members (tenant_id, user_id, role, granted_by) VALUES (p_tenant, p_correto, 'admin', p_correto)
      RETURNING id INTO v_member;
    INSERT INTO audit_log (tenant_id, actor_id, actor_kind, action, scope, metadata)
      VALUES (p_tenant, '00000000-0000-0000-0000-000000000000'::uuid, 'sistema', 'permission_change', 'clinic_members',
              jsonb_build_object('op', 'member_found', 'member_id', v_member, 'user_id', p_correto, 'role', 'admin',
                                 'via', 'runbook_correcao', 'chamado', p_chamado, 'pedido', p_pedido));
  END IF;
  FOR v_revog IN
    UPDATE clinic_members SET revoked_at = now(), revoked_by = p_correto
     WHERE tenant_id = p_tenant AND user_id = v_errado AND revoked_at IS NULL
    RETURNING id, role
  LOOP
    INSERT INTO audit_log (tenant_id, actor_id, actor_kind, action, scope, metadata)
      VALUES (p_tenant, '00000000-0000-0000-0000-000000000000'::uuid, 'sistema', 'permission_change', 'clinic_members',
              jsonb_build_object('op', 'member_revoke', 'member_id', v_revog.id, 'user_id', v_errado, 'role', v_revog.role,
                                 'via', 'runbook_correcao', 'chamado', p_chamado, 'pedido', p_pedido));
  END LOOP;
  INSERT INTO audit_log (tenant_id, actor_id, actor_kind, action, scope, metadata)
    VALUES (p_tenant, '00000000-0000-0000-0000-000000000000'::uuid, 'sistema', 'permission_change', 'tenants.founder',
            jsonb_build_object('op', 'founder_fixed', 'pedido', p_pedido, 'user_id_anterior', v_errado,
                               'user_id', p_correto, 'member_id', v_member, 'via', 'runbook_correcao', 'chamado', p_chamado));
  PERFORM set_config('app.correcao_fundador', '', true);
  RETURN v_member;
END;
$$;

-- ------------------------------------------------------------------ lista fechada das tabelas internas (0038)

CREATE OR REPLACE FUNCTION app_internal_tables() RETURNS text[]
  LANGUAGE sql IMMUTABLE
  SET search_path = pg_catalog
AS $$
  SELECT ARRAY['schema_migrations', 'tenant_context', 'portal_invite_lookup', 'portal_link_index', 'portal_invite_otp',
               'fiscal_retention_policy', 'whatsapp_routes', 'portal_birth_date_changes', 'job_tenant_index',
               'founder_fix_requests']::text[]
$$;

-- ------------------------------------------------------------------ conferência final

DO $$
DECLARE
  v_privs text;
BEGIN
  SELECT string_agg(privilege_type, ', ') INTO v_privs
    FROM information_schema.role_table_grants
   WHERE table_schema = 'public' AND table_name = 'founder_fix_requests' AND grantee IN ('app_user', 'PUBLIC');
  IF v_privs IS NOT NULL THEN
    RAISE EXCEPTION 'founder_fix_requests: o runtime não pode ter privilégio (%)', v_privs;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'founder_fix_requests'
                AND policyname <> 'founder_fix_requests_definer_only') THEN
    RAISE EXCEPTION 'founder_fix_requests: tabela interna só pode ter a policy <tabela>_definer_only';
  END IF;
  -- As funções do runbook continuam sem GRANT: só o dono (app_migrator) executa.
  IF has_function_privilege('app_user', 'app_runbook_pedir_correcao_fundador(uuid,uuid,uuid,text)', 'EXECUTE')
     OR has_function_privilege('app_user', 'app_runbook_confirmar_correcao_fundador(uuid,uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'funções do runbook não podem ser executáveis pelo runtime';
  END IF;
END;
$$;
