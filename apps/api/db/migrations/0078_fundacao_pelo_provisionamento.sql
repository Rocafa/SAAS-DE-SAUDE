-- 0078 — Fundação da clínica pelo provisionamento com ator SISTEMA (B11, PR 2; R7 do parecer do Guardião de 16/11/2026
-- sobre docs/04-arquitetura/provisionamento-da-clinica.md e C2 do parecer do #195). Executar com o papel de MIGRAÇÃO.
--
-- Antes: a 0022 exigia `tenants.founder_user_id` = usuário da transação e a fundação em `clinic_members` pelo próprio
-- fundador. A tarefa de provisionamento (nossa equipe) gravava, então, `tenant_create` e `member_found` com o FUNDADOR
-- como ator, um ato que ele não fez (e, na conta nova, um uuid reservado que ainda não tem conta).
--
-- Agora, além do caminho de sempre (fundador = usuário da sessão), a fundação aceita a SESSÃO DE SISTEMA
-- (`app_set_system_user`, 0019) só quando a trilha da mesma transação prova o provisionamento:
--
-- 1. tenants: na sessão de sistema, a clínica nasce com um fundador que não é o usuário da sessão; no COMMIT, a trilha
--    precisa de `tenant_create` com ator sistema e metadata `via = 'provisionamento'` e `contract ~ '^CTR-[0-9]{1,7}$'`.
-- 2. clinic_members: na sessão de sistema, só a fundação (perfil admin do fundador registrado, clínica sem nenhuma linha,
--    `granted_by` = sentinela de sistema). No COMMIT, a linha concedida pelo sistema exige `member_found` com ator
--    sistema, `via = 'provisionamento'` e o contrato, além do `member_id` (regra da 0022).
--
-- Fora disso nada muda: a sessão de sistema continua sem conceder nem revogar perfil, e o runtime continua sem mudar o
-- fundador. A sessão de sistema numa clínica INEXISTENTE só é aberta pela tarefa de provisionamento (os jobs rodam nas
-- clínicas de `app_job_tenants()`, e o RLS de `tenants` só aceita o id do contexto). Quem rodou a tarefa fica no
-- CloudTrail e no evento CLINICA_PROVISIONADA, nunca na trilha da clínica (R7).

-- ------------------------------------------------------------------ prova do provisionamento na trilha

CREATE FUNCTION app_trilha_do_provisionamento(p_tenant uuid, p_scope text, p_op text, p_member uuid) RETURNS boolean
  LANGUAGE sql
  STABLE
  SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM audit_log a
     WHERE a.tenant_id = p_tenant AND a.scope = p_scope
       AND a.actor_kind = 'sistema' AND a.actor_id = '00000000-0000-0000-0000-000000000000'::uuid
       AND a.metadata->>'op' = p_op
       AND a.metadata->>'via' = 'provisionamento'
       AND COALESCE(a.metadata->>'contract', '') ~ '^CTR-[0-9]{1,7}$'
       AND (p_member IS NULL OR a.metadata->>'member_id' = p_member::text))
$$;
REVOKE ALL ON FUNCTION app_trilha_do_provisionamento(uuid, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_trilha_do_provisionamento(uuid, text, text, uuid) TO app_user;

-- ------------------------------------------------------------------ 1. tenants (base: 0047)

CREATE OR REPLACE FUNCTION tenants_founder_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.founder_user_id IS NOT NULL AND NEW.founder_user_id IS DISTINCT FROM app_current_user() THEN
      -- 0078: o provisionamento cria a clínica na sessão de sistema; a prova (trilha) é conferida no COMMIT.
      IF app_is_system_session() THEN
        RETURN NEW;
      END IF;
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

-- No COMMIT: clínica criada com fundador na sessão de sistema só com o `tenant_create` do provisionamento na trilha.
CREATE FUNCTION tenants_provisionamento_check() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.founder_user_id IS NOT NULL AND app_is_system_session()
     AND NOT app_trilha_do_provisionamento(NEW.id, 'tenants', 'tenant_create', NULL) THEN
    RAISE EXCEPTION 'clínica criada pelo sistema sem a trilha do provisionamento' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER tenants_provisionamento_check AFTER INSERT ON tenants
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION tenants_provisionamento_check();

-- ------------------------------------------------------------------ 2. clinic_members (base: 0042)

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
    -- 0078: fundação pelo provisionamento, na sessão de sistema. Só o admin do fundador registrado, numa clínica sem
    -- nenhuma linha, concedido pelo sentinela de sistema; a trilha (`member_found` do provisionamento) vai no COMMIT.
    IF TG_OP = 'INSERT' AND app_is_system_session() THEN
      PERFORM pg_advisory_xact_lock(hashtextextended('clinic_members:' || NEW.tenant_id::text, 0));
      IF NEW.role = 'admin'
         AND NEW.granted_by = '00000000-0000-0000-0000-000000000000'::uuid
         AND NEW.revoked_by IS NULL AND NEW.revoked_at IS NULL
         AND EXISTS (SELECT 1 FROM tenants t WHERE t.id = NEW.tenant_id AND t.founder_user_id = NEW.user_id)
         AND NOT EXISTS (SELECT 1 FROM clinic_members m WHERE m.tenant_id = NEW.tenant_id) THEN
        NEW.granted_at := now();
        RETURN NEW;
      END IF;
    END IF;
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

-- Base: 0022. A concessão pelo sentinela de sistema só vale com o `member_found` do provisionamento (ator sistema).
CREATE OR REPLACE FUNCTION clinic_members_trilha_check() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.granted_by = '00000000-0000-0000-0000-000000000000'::uuid THEN
    IF NOT app_trilha_do_provisionamento(NEW.tenant_id, 'clinic_members', 'member_found', NEW.id) THEN
      RAISE EXCEPTION 'fundação pelo sistema sem a trilha do provisionamento' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NULL;
  END IF;
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
