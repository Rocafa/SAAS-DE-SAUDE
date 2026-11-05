-- 0047 — Login nominal por operador na correção do fundador e lista branca no registro do fundador
-- (O-R17b, O-R17d e O-R17e das conferências do Guardião sobre o PR #63, rodada 21, 23/10/2026).
-- Executar com o papel de MIGRAÇÃO (app_migrator).
-- Ver docs/04-arquitetura/runbook-fundador-clinicas-existentes.md §"Operadores nominais".
--
-- NUMERAÇÃO: 0047 é da rodada 22 (#63), depois da 0045 (responsáveis) e da 0046 (reservada a outro ramo).
--
-- Problema:
--   * O-R17b: pedido e confirmação da correção do fundador rodavam com o login compartilhado app_migrator;
--     a separação de pessoas só era provada pelo chamado, não pelo banco;
--   * O-R17d: o caminho do REGISTRO do fundador de clínica antiga usava lista negra
--     (`current_user = 'app_user'` em tenants_founder_guard, 0042, e em app_runbook_registrar_fundador, 0022);
--   * O-R17e: a exceção dependia só de current_user; uma função SECURITY DEFINER de dono app_migrator,
--     executável pelo runtime, rodaria como app_migrator e passaria na lista branca.
--
-- Correção:
--   * operador nominal = papel LOGIN, membro de app_migrator, que não é o próprio app_migrator, nem o
--     runtime, nem superusuário (app_operador_nominal()). O pedido grava o session_user de quem pede; a
--     confirmação grava o de quem confirma e recusa se forem iguais (42501). Os dois nomes vão para a trilha;
--   * a exceção da correção (app_runbook_corrigindo_fundador) passa a exigir também session_user nominal:
--     dentro de uma função SECURITY DEFINER chamada pelo runtime, session_user continua app_user → false;
--   * registro do fundador: lista branca `pg_has_role(current_user, ...) AND pg_has_role(session_user, ...)`
--     no guarda e na função do runbook (session_user do runtime é app_user, nunca membro de app_migrator).
--   * a guarda de schema (guarda-schema.rls.test.ts) reprova função SECURITY DEFINER executável pelo
--     runtime (ou usada por trigger) que grave em tenants ou clinic_members.

-- ------------------------------------------------------------------ operador nominal

CREATE OR REPLACE FUNCTION app_operador_nominal() RETURNS boolean
  LANGUAGE sql
  STABLE
  SET search_path = pg_catalog
AS $$
  SELECT session_user::text NOT IN ('app_migrator', 'app_user')
     AND pg_has_role(session_user, 'app_migrator', 'MEMBER')
     AND EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = session_user AND r.rolcanlogin AND NOT r.rolsuper)
$$;
-- Fica executável por todos de propósito: só lê o catálogo e é chamada pelos guardas (SECURITY INVOKER)
-- quando o runtime escreve em tenants; para o runtime devolve sempre false.

ALTER TABLE founder_fix_requests ADD COLUMN requested_by text;
ALTER TABLE founder_fix_requests ADD COLUMN confirmed_by text;
-- Pedidos anteriores à 0047 ficam com requested_by NULL e a confirmação os recusa (abra outro).
ALTER TABLE founder_fix_requests ADD CONSTRAINT founder_fix_requests_duas_pessoas
  CHECK (confirmed_by IS NULL OR (requested_by IS NOT NULL AND confirmed_by <> requested_by));

-- ------------------------------------------------------------------ exceção da correção (guardas)

CREATE OR REPLACE FUNCTION app_runbook_corrigindo_fundador(p_tenant uuid) RETURNS boolean
  LANGUAGE sql
  STABLE
  SET search_path = pg_catalog, public
AS $$
  SELECT pg_has_role(current_user, 'app_migrator', 'MEMBER') AND app_operador_nominal() AND p_tenant IS NOT NULL
     AND COALESCE(current_setting('app.correcao_fundador', true), '') = p_tenant::text
$$;

-- ------------------------------------------------------------------ registro do fundador (lista branca)

CREATE OR REPLACE FUNCTION tenants_founder_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.founder_user_id IS NOT NULL AND NEW.founder_user_id IS DISTINCT FROM app_current_user() THEN
      RAISE EXCEPTION 'o fundador é quem está na sessão ao criar a clínica' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.founder_user_id IS DISTINCT FROM OLD.founder_user_id THEN
    -- Correção sob incidente (0042/0047): só dentro de app_runbook_confirmar_correcao_fundador, por operador nominal.
    IF OLD.founder_user_id IS NOT NULL AND app_runbook_corrigindo_fundador(OLD.id)
       AND NEW.founder_user_id IS NOT NULL AND NEW.founder_user_id = app_current_user() THEN
      RETURN NEW;
    END IF;
    -- Registro do fundador de clínica antiga, uma vez: só o papel de operação (lista branca: quem escreve E
    -- o login da sessão são membros de app_migrator; o runtime, mesmo via SECURITY DEFINER, nunca).
    IF OLD.founder_user_id IS NOT NULL
       OR NOT (pg_has_role(current_user, 'app_migrator', 'MEMBER') AND pg_has_role(session_user, 'app_migrator', 'MEMBER'))
       OR NEW.founder_user_id IS DISTINCT FROM app_current_user() THEN
      RAISE EXCEPTION 'fundador da clínica é imutável' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app_runbook_registrar_fundador(p_tenant uuid, p_fundador uuid, p_chamado text) RETURNS uuid
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_member uuid;
BEGIN
  IF NOT (pg_has_role(current_user, 'app_migrator', 'MEMBER') AND pg_has_role(session_user, 'app_migrator', 'MEMBER')) THEN
    RAISE EXCEPTION 'runbook só roda com o papel de operação (app_migrator)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_chamado IS NULL OR p_chamado !~ '^[A-Za-z][A-Za-z0-9._-]{2,39}$' THEN
    RAISE EXCEPTION 'chamado inválido (ex.: OPS-123)' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM app_set_tenant(p_tenant);
  PERFORM app_set_user(p_fundador);
  IF NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = p_tenant AND t.founder_user_id IS NULL) THEN
    RAISE EXCEPTION 'clínica inexistente ou já tem fundador' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF EXISTS (SELECT 1 FROM clinic_members m WHERE m.tenant_id = p_tenant) THEN
    RAISE EXCEPTION 'clínica já tem membros: use a concessão por um admin' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  UPDATE tenants SET founder_user_id = p_fundador WHERE id = p_tenant;
  INSERT INTO clinic_members (tenant_id, user_id, role, granted_by) VALUES (p_tenant, p_fundador, 'admin', p_fundador)
    RETURNING id INTO v_member;
  INSERT INTO audit_log (tenant_id, actor_id, actor_kind, action, scope, metadata)
    VALUES (p_tenant, '00000000-0000-0000-0000-000000000000'::uuid, 'sistema', 'permission_change', 'clinic_members',
            jsonb_build_object('op', 'member_found', 'member_id', v_member, 'user_id', p_fundador, 'role', 'admin',
                               'via', 'runbook', 'chamado', p_chamado));
  RETURN v_member;
END;
$$;
REVOKE ALL ON FUNCTION app_runbook_registrar_fundador(uuid, uuid, text) FROM PUBLIC;

-- ------------------------------------------------------------------ correção: duas pessoas nominais

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
  IF NOT app_operador_nominal() THEN
    RAISE EXCEPTION 'a correção exige o login nominal do operador (membro de app_migrator), não o login compartilhado'
      USING ERRCODE = 'insufficient_privilege';
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
  INSERT INTO founder_fix_requests (tenant_id, user_id_anterior, user_id, chamado, requested_xid, requested_by)
    VALUES (p_tenant, p_errado, p_correto, p_chamado, txid_current(), session_user)
    RETURNING id INTO v_pedido;
  -- Só registro: a confirmação lê founder_fix_requests, nunca esta linha.
  INSERT INTO audit_log (tenant_id, actor_id, actor_kind, action, scope, metadata)
    VALUES (p_tenant, '00000000-0000-0000-0000-000000000000'::uuid, 'sistema', 'permission_change', 'tenants.founder',
            jsonb_build_object('op', 'founder_fix_requested', 'pedido', v_pedido, 'user_id_anterior', p_errado,
                               'user_id', p_correto, 'via', 'runbook_correcao', 'chamado', p_chamado,
                               'pedido_por', session_user::text));
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
  IF NOT app_operador_nominal() THEN
    RAISE EXCEPTION 'a correção exige o login nominal do operador (membro de app_migrator), não o login compartilhado'
      USING ERRCODE = 'insufficient_privilege';
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
  IF v_pedido.requested_by IS NULL THEN
    RAISE EXCEPTION 'pedido sem operador nominal (anterior à 0047): abra outro' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- O-R17b: duas PESSOAS, verificável pela trilha.
  IF v_pedido.requested_by = session_user::text THEN
    RAISE EXCEPTION 'quem confirma a correção não pode ser quem a pediu' USING ERRCODE = 'insufficient_privilege';
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

  UPDATE founder_fix_requests
     SET confirmed_at = clock_timestamp(), confirmed_xid = txid_current(), confirmed_by = session_user
   WHERE id = p_pedido;

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
                               'user_id', p_correto, 'member_id', v_member, 'via', 'runbook_correcao', 'chamado', p_chamado,
                               'pedido_por', v_pedido.requested_by, 'confirmado_por', session_user::text));
  PERFORM set_config('app.correcao_fundador', '', true);
  RETURN v_member;
END;
$$;

-- ------------------------------------------------------------------ conferência final

DO $$
DECLARE
  v_fn text;
BEGIN
  IF has_function_privilege('app_user', 'app_runbook_pedir_correcao_fundador(uuid,uuid,uuid,text)', 'EXECUTE')
     OR has_function_privilege('app_user', 'app_runbook_confirmar_correcao_fundador(uuid,uuid,uuid,text)', 'EXECUTE')
     OR has_function_privilege('app_user', 'app_runbook_registrar_fundador(uuid,uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'funções do runbook não podem ser executáveis pelo runtime';
  END IF;
  -- Nada de lista negra por nome de papel no caminho do fundador.
  FOREACH v_fn IN ARRAY ARRAY['tenants_founder_guard()', 'clinic_members_guard()', 'app_runbook_corrigindo_fundador(uuid)',
                              'app_runbook_registrar_fundador(uuid,uuid,text)',
                              'app_runbook_pedir_correcao_fundador(uuid,uuid,uuid,text)',
                              'app_runbook_confirmar_correcao_fundador(uuid,uuid,uuid,text)'] LOOP
    IF pg_get_functiondef(v_fn::regprocedure) ~ 'current_user\s*(=|<>)\s*''app_user''' THEN
      RAISE EXCEPTION '%: troque a lista negra (current_user = ''app_user'') por pg_has_role', v_fn;
    END IF;
    IF (SELECT prosecdef FROM pg_proc WHERE oid = v_fn::regprocedure) THEN
      RAISE EXCEPTION '%: não pode ser SECURITY DEFINER (a exceção depende de current_user)', v_fn;
    END IF;
  END LOOP;
END;
$$;
