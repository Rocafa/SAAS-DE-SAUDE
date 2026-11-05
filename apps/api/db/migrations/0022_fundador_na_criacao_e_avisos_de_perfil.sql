-- 0022 — Fundador registrado na criação da clínica; perfis só com trilha; avisos aos demais admins
-- (R15 e R13-resto da re-revisão 3 do Guardião sobre o PR #63). Executar com o papel de MIGRAÇÃO.
-- Ver docs/04-arquitetura/api-dominio.md §"Perfis da clínica no banco" e o runbook
-- docs/04-arquitetura/runbook-fundador-clinicas-existentes.md.
--
-- NUMERAÇÃO: 0021 é do financeiro (#65); 0022 é desta rodada do #63; 0023 do #65; 0024 do importador.
--
-- Furo fechado (R15): na 0020, numa clínica SEM nenhum membro, QUALQUER usuário da sessão (inclusive um
-- SQL injetado de recepção) podia se registrar como o primeiro admin, e fora da trilha. Agora:
--
-- 1. tenants.founder_user_id: quem fundou a clínica. Gravado na criação da clínica, igual ao usuário
--    da sessão (o banco confere). Imutável para o runtime: só sai de NULL pelo runbook (papel de
--    operação, nunca app_user) para as clínicas antigas.
-- 2. A exceção de fundação de clinic_members só vale para o FUNDADOR registrado em tenants (e ainda só
--    numa clínica sem nenhuma linha). Clínica sem fundador registrado não aceita mais "qualquer usuário"
--    como primeiro admin: fica sem admin até o runbook.
-- 3. Clínica criada com fundador tem, no COMMIT, o fundador como admin (constraint trigger diferida):
--    a fundação acontece na MESMA transação que cria a clínica.
-- 4. Toda linha nova de clinic_members (e toda revogação) exige, no COMMIT, o evento correspondente na
--    trilha (member_found/member_grant/member_revoke com o member_id). INSERT direto sem o evento é
--    recusado: o "alarme" pedido vira barreira.
-- 5. clinical_notices ganha avisos aos DEMAIS admins: perfil concedido/revogado e retirada de retenção
--    legal pedida/aprovada. Só ids de usuário da equipe, perfil e id da retenção; nenhum dado de paciente.

-- ------------------------------------------------------------------ 1. fundador da clínica

ALTER TABLE tenants
  ADD COLUMN founder_user_id uuid
    CONSTRAINT tenants_founder_check CHECK (founder_user_id <> '00000000-0000-0000-0000-000000000000'::uuid);

CREATE FUNCTION tenants_founder_guard() RETURNS trigger
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
    -- Só o runbook (papel de operação, nunca o runtime) registra o fundador de clínica antiga, uma vez.
    IF OLD.founder_user_id IS NOT NULL OR current_user = 'app_user'
       OR NEW.founder_user_id IS DISTINCT FROM app_current_user() THEN
      RAISE EXCEPTION 'fundador da clínica é imutável' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER tenants_founder_guard BEFORE INSERT OR UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION tenants_founder_guard();

-- No COMMIT: clínica com fundador tem o fundador como admin (fundação na mesma transação).
CREATE FUNCTION tenants_founder_member_check() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.founder_user_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM clinic_members m
        WHERE m.tenant_id = NEW.id AND m.user_id = NEW.founder_user_id AND m.role = 'admin') THEN
    RAISE EXCEPTION 'clínica criada sem registrar o fundador como admin' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER tenants_founder_member_check AFTER INSERT OR UPDATE OF founder_user_id ON tenants
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION tenants_founder_member_check();

-- ------------------------------------------------------------------ 2. fundação só pelo fundador registrado

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
      -- Fundação (R15): só o FUNDADOR registrado em tenants, numa clínica sem nenhuma linha.
      IF NOT (NEW.role = 'admin' AND NEW.user_id = v_user
              AND EXISTS (SELECT 1 FROM tenants t WHERE t.id = NEW.tenant_id AND t.founder_user_id = v_user)
              AND NOT EXISTS (SELECT 1 FROM clinic_members m WHERE m.tenant_id = NEW.tenant_id)) THEN
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
  IF NOT app_user_has_role(v_user, 'admin') THEN
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

-- ------------------------------------------------------------------ 4. perfil só com o evento na trilha

CREATE FUNCTION clinic_members_trilha_check() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM audit_log a
        WHERE a.tenant_id = NEW.tenant_id AND a.scope = 'clinic_members'
          AND a.metadata->>'member_id' = NEW.id::text
          AND a.metadata->>'op' = ANY (CASE WHEN TG_OP = 'INSERT' THEN ARRAY['member_found', 'member_grant']
                                            ELSE ARRAY['member_revoke'] END)) THEN
    RAISE EXCEPTION 'mudança de perfil sem o evento correspondente na trilha' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER clinic_members_trilha_check AFTER INSERT OR UPDATE ON clinic_members
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION clinic_members_trilha_check();

-- ------------------------------------------------------------------ 5. avisos aos demais admins

ALTER TABLE clinical_notices DROP CONSTRAINT clinical_notices_kind_check;
ALTER TABLE clinical_notices
  ALTER COLUMN from_mode DROP NOT NULL,
  ALTER COLUMN to_mode DROP NOT NULL,
  ADD COLUMN subject_user_id uuid,
  ADD COLUMN subject_role text CONSTRAINT clinical_notices_subject_role_check
    CHECK (subject_role IN ('admin', 'profissional', 'recepcao', 'financeiro', 'psicologo')),
  ADD COLUMN change text CONSTRAINT clinical_notices_change_check CHECK (change IN ('concedido', 'revogado')),
  ADD COLUMN legal_hold_id uuid,
  ADD CONSTRAINT clinical_notices_kind_check CHECK (kind IN (
    'sigilo_psicologia_alterado', 'perfil_alterado', 'retencao_retirada_pedida', 'retencao_retirada_aprovada')),
  -- Cada tipo carrega só os seus campos (nada sobra para virar texto livre).
  ADD CONSTRAINT clinical_notices_shape_check CHECK (
    CASE kind
      WHEN 'sigilo_psicologia_alterado' THEN
        from_mode IS NOT NULL AND to_mode IS NOT NULL
        AND subject_user_id IS NULL AND subject_role IS NULL AND change IS NULL AND legal_hold_id IS NULL
      WHEN 'perfil_alterado' THEN
        from_mode IS NULL AND to_mode IS NULL AND restricted_existing = 0
        AND subject_user_id IS NOT NULL AND subject_role IS NOT NULL AND change IS NOT NULL AND legal_hold_id IS NULL
      ELSE
        from_mode IS NULL AND to_mode IS NULL AND restricted_existing = 0
        AND subject_user_id IS NULL AND subject_role IS NULL AND change IS NULL AND legal_hold_id IS NOT NULL
    END);

-- ------------------------------------------------------------------ runbook: clínicas antigas sem membros

-- Registra o fundador de uma clínica ANTIGA (sem fundador e sem nenhum membro), pelo mesmo caminho do
-- fluxo de criação: fundador em tenants + primeiro admin + evento member_found na trilha (ator sistema,
-- via=runbook, com o número do chamado). NÃO é SECURITY DEFINER e o runtime (app_user) não executa: só o
-- papel de operação/migração, numa transação própria. Ver docs/04-arquitetura/runbook-fundador-clinicas-existentes.md.
CREATE FUNCTION app_runbook_registrar_fundador(p_tenant uuid, p_fundador uuid, p_chamado text) RETURNS uuid
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_member uuid;
BEGIN
  IF current_user = 'app_user' THEN
    RAISE EXCEPTION 'runbook não roda com o papel do runtime' USING ERRCODE = 'insufficient_privilege';
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
