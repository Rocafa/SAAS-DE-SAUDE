-- 0042 — Consumo de guia de convênio imutável, salvo o estorno (R20 da conferência de 23/10/2026 do
-- Guardião sobre o PR #65). Executar com o papel de MIGRAÇÃO (app_migrator). Ver
-- docs/04-arquitetura/api-dominio.md §9.
--
-- NUMERAÇÃO: 0042 é da rodada 20 (ressalvas #65 R20/R21 e #63 R17 sobre a integração #73).
--
-- Problema (R20): guide_sessions não tinha trigger de UPDATE (só RLS por clínica e o REVOKE DELETE/
-- TRUNCATE da 0011). Com SQL injetado, qualquer papel da clínica podia desfazer um estorno, trocar
-- guide_id/appointment_id, reescrever consumed_by/override_reason ou estornar em nome de outra pessoa:
-- o saldo da guia e o lote de faturamento ao convênio (TISS) ficavam inexatos.
--
-- Regra (vale para QUALQUER papel), a mesma da 0029 + 0041 para package_sessions:
--   * a linha ainda não estava estornada (OLD.reversed_at IS NULL): estorno acontece uma vez só;
--   * id, tenant_id, guide_id, appointment_id, consumed_at, consumed_by e override_reason não mudam;
--   * reversed_by = app_current_user() (sem usuário na transação, recusa);
--   * reversal_reason preenchido (a lista fechada continua no CHECK da 0011);
--   * o usuário tem perfil ATIVO admin, profissional, recepcao ou financeiro na clínica da transação
--     (a lista de `guias:consumir`; o estorno automático da agenda é feito por perfis da mesma lista);
--   * reversed_at é o relógio do banco: o trigger grava now(), seja qual for o valor enviado.

-- ------------------------------------------------------------------ R20: guide_sessions só estorno

CREATE FUNCTION guide_sessions_so_estorno() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := app_current_user();
BEGIN
  IF OLD.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'consumo de guia estornado não muda mais' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.guide_id IS DISTINCT FROM OLD.guide_id OR NEW.appointment_id IS DISTINCT FROM OLD.appointment_id
     OR NEW.consumed_at IS DISTINCT FROM OLD.consumed_at OR NEW.consumed_by IS DISTINCT FROM OLD.consumed_by
     OR NEW.override_reason IS DISTINCT FROM OLD.override_reason THEN
    RAISE EXCEPTION 'consumo de guia: só o estorno é permitido' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.reversed_at IS NULL OR NEW.reversal_reason IS NULL THEN
    RAISE EXCEPTION 'consumo de guia: só o estorno é permitido' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_user IS NULL OR NEW.reversed_by IS DISTINCT FROM v_user THEN
    RAISE EXCEPTION 'estorno de consumo de guia só em nome do usuário da sessão' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT (app_user_has_role(v_user, 'admin') OR app_user_has_role(v_user, 'profissional')
          OR app_user_has_role(v_user, 'recepcao') OR app_user_has_role(v_user, 'financeiro')) THEN
    RAISE EXCEPTION 'estorno de consumo de guia exige perfil registrado na clínica' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.reversed_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER guide_sessions_so_estorno BEFORE UPDATE ON guide_sessions
  FOR EACH ROW EXECUTE FUNCTION guide_sessions_so_estorno();

-- ------------------------------------------------------------------ #63 R17: correção do fundador errado
--
-- Observação O-R17a da conferência de 23/10/2026 do #63: se o runbook registrou o `userId` errado como
-- fundador, não havia caminho de correção. `app_runbook_registrar_fundador` recusa (55000) porque a
-- clínica já tem membro, e o único admin é o indevido. Agora a correção é feita em DOIS passos, com o
-- papel de operação/migração (nunca o runtime), chamado de incidente e trilha:
--
--   1. QUEM EXECUTA pede: app_runbook_pedir_correcao_fundador(clínica, userId errado, userId correto,
--      chamado). Confere que o errado é o fundador atual e grava `founder_fix_requested` na trilha.
--      Devolve o id do pedido.
--   2. O CONFERENTE confirma, em OUTRA transação e em até 24 h:
--      app_runbook_confirmar_correcao_fundador(clínica, pedido, userId correto, chamado). O userId
--      correto é redigitado pelo conferente (vindo do provedor de identidade, não de quem executa). Se
--      não bater com o pedido, recusa. Na mesma transação: o fundador passa a ser o correto, o correto
--      vira admin (`member_found`), TODOS os perfis ativos do errado na clínica são revogados
--      (`member_revoke`) e `founder_fixed` vai para a trilha. Ator `sistema`, `via=runbook_correcao`.
--
-- O banco garante: o runtime não executa nenhuma das duas (42501); pedido e confirmação não cabem na
-- mesma transação; o pedido vale uma vez e expira em 24 h; os guardas de tenants/clinic_members só
-- abrem a exceção dentro da confirmação (GUC local da transação, ignorada para o papel do runtime).
-- Ver docs/04-arquitetura/runbook-fundador-clinicas-existentes.md §"Se o userId estiver errado".

CREATE FUNCTION app_runbook_corrigindo_fundador(p_tenant uuid) RETURNS boolean
  LANGUAGE sql
  STABLE
  SET search_path = pg_catalog, public
AS $$
  SELECT current_user <> 'app_user' AND p_tenant IS NOT NULL
     AND COALESCE(current_setting('app.correcao_fundador', true), '') = p_tenant::text
$$;
-- Os guardas rodam com o papel de quem escreve (inclusive o runtime, para quem a função dá sempre false).
REVOKE ALL ON FUNCTION app_runbook_corrigindo_fundador(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_runbook_corrigindo_fundador(uuid) TO app_user;

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
    -- Correção sob incidente (0042): só dentro de app_runbook_confirmar_correcao_fundador.
    IF OLD.founder_user_id IS NOT NULL AND app_runbook_corrigindo_fundador(OLD.id)
       AND NEW.founder_user_id IS NOT NULL AND NEW.founder_user_id = app_current_user() THEN
      RETURN NEW;
    END IF;
    -- Só o runbook (papel de operação, nunca o runtime) registra o fundador de clínica antiga, uma vez.
    IF OLD.founder_user_id IS NOT NULL OR current_user = 'app_user'
       OR NEW.founder_user_id IS DISTINCT FROM app_current_user() THEN
      RAISE EXCEPTION 'fundador da clínica é imutável' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION clinic_members_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := app_current_user();
  semRevogacao clinic_members;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'clinic_members não se apaga (revogue)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'perfil da clínica exige o usuário da sessão' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('clinic_members:' || COALESCE(NEW.tenant_id, OLD.tenant_id)::text, 0));
  IF TG_OP = 'INSERT' THEN
    IF NEW.granted_by IS DISTINCT FROM v_user OR NEW.revoked_by IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'perfil é concedido por quem está na sessão e nasce ativo' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT app_user_has_role(v_user, 'admin') THEN
      -- Fundação (R15): só o FUNDADOR registrado em tenants, numa clínica sem nenhuma linha; ou a
      -- correção do fundador sob incidente (0042), em que o novo fundador se registra como admin.
      IF NOT (NEW.role = 'admin' AND NEW.user_id = v_user
              AND EXISTS (SELECT 1 FROM tenants t WHERE t.id = NEW.tenant_id AND t.founder_user_id = v_user)
              AND (NOT EXISTS (SELECT 1 FROM clinic_members m WHERE m.tenant_id = NEW.tenant_id)
                   OR app_runbook_corrigindo_fundador(NEW.tenant_id))) THEN
        RAISE EXCEPTION 'só um admin ativo da clínica concede perfil' USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
    NEW.granted_at := now();
    RETURN NEW;
  END IF;
  semRevogacao := NEW;
  semRevogacao.revoked_by := OLD.revoked_by;
  semRevogacao.revoked_at := OLD.revoked_at;
  IF semRevogacao IS DISTINCT FROM OLD OR OLD.revoked_at IS NOT NULL
     OR NEW.revoked_by IS DISTINCT FROM v_user OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'perfil só se revoga, uma vez, por quem está na sessão' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT app_user_has_role(v_user, 'admin') AND NOT app_runbook_corrigindo_fundador(OLD.tenant_id) THEN
    RAISE EXCEPTION 'só um admin ativo da clínica revoga perfil' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.role = 'admin' AND NOT EXISTS (
       SELECT 1 FROM clinic_members m
        WHERE m.tenant_id = OLD.tenant_id AND m.role = 'admin' AND m.revoked_at IS NULL AND m.id <> OLD.id) THEN
    RAISE EXCEPTION 'a clínica não fica sem admin ativo' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  NEW.revoked_at := now();
  RETURN NEW;
END;
$$;

CREATE FUNCTION app_runbook_pedir_correcao_fundador(p_tenant uuid, p_errado uuid, p_correto uuid, p_chamado text) RETURNS uuid
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_pedido uuid := gen_random_uuid();
BEGIN
  IF current_user = 'app_user' THEN
    RAISE EXCEPTION 'runbook não roda com o papel do runtime' USING ERRCODE = 'insufficient_privilege';
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
  INSERT INTO audit_log (tenant_id, actor_id, actor_kind, action, scope, metadata)
    VALUES (p_tenant, '00000000-0000-0000-0000-000000000000'::uuid, 'sistema', 'permission_change', 'tenants.founder',
            jsonb_build_object('op', 'founder_fix_requested', 'pedido', v_pedido, 'user_id_anterior', p_errado,
                               'user_id', p_correto, 'via', 'runbook_correcao', 'chamado', p_chamado,
                               'xid', txid_current()::text));
  RETURN v_pedido;
END;
$$;
REVOKE ALL ON FUNCTION app_runbook_pedir_correcao_fundador(uuid, uuid, uuid, text) FROM PUBLIC;

CREATE FUNCTION app_runbook_confirmar_correcao_fundador(p_tenant uuid, p_pedido uuid, p_correto uuid, p_chamado text) RETURNS uuid
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_pedido audit_log;
  v_errado uuid;
  v_member uuid;
  v_revog  record;
BEGIN
  IF current_user = 'app_user' THEN
    RAISE EXCEPTION 'runbook não roda com o papel do runtime' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM app_set_tenant(p_tenant);
  SELECT * INTO v_pedido FROM audit_log a
   WHERE a.tenant_id = p_tenant AND a.scope = 'tenants.founder'
     AND a.metadata->>'op' = 'founder_fix_requested' AND a.metadata->>'pedido' = p_pedido::text;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pedido de correção inexistente nesta clínica' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- Dupla confirmação: quem confirma não está na transação de quem pediu.
  IF v_pedido.metadata->>'xid' = txid_current()::text THEN
    RAISE EXCEPTION 'a confirmação é feita pelo conferente, em outra transação' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_pedido.created_at < now() - interval '24 hours' THEN
    RAISE EXCEPTION 'pedido de correção expirado: abra outro' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF EXISTS (SELECT 1 FROM audit_log a
              WHERE a.tenant_id = p_tenant AND a.scope = 'tenants.founder'
                AND a.metadata->>'op' = 'founder_fixed' AND a.metadata->>'pedido' = p_pedido::text) THEN
    RAISE EXCEPTION 'pedido de correção já confirmado' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF p_correto IS NULL OR v_pedido.metadata->>'user_id' IS DISTINCT FROM p_correto::text
     OR v_pedido.metadata->>'chamado' IS DISTINCT FROM p_chamado THEN
    RAISE EXCEPTION 'confirmação não confere com o pedido (userId ou chamado)' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_errado := (v_pedido.metadata->>'user_id_anterior')::uuid;
  IF NOT EXISTS (SELECT 1 FROM tenants t WHERE t.id = p_tenant AND t.founder_user_id = v_errado) THEN
    RAISE EXCEPTION 'o fundador mudou desde o pedido' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

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
REVOKE ALL ON FUNCTION app_runbook_confirmar_correcao_fundador(uuid, uuid, uuid, text) FROM PUBLIC;
