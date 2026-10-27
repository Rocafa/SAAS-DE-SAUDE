-- 0020 — O banco sabe quem é admin e quem é psicólogo da clínica (R13 da re-revisão 2 do Guardião
-- sobre o PR #63). Executar com o papel de MIGRAÇÃO (app_migrator).
-- Ver docs/04-arquitetura/api-dominio.md §"Perfis da clínica no banco".
--
-- NUMERAÇÃO: 0019 é do #61 (slot do usuário travado, de que esta depende); 0021 é do financeiro.
--
-- Antes, a exigência de admin (retenção legal) e de psicólogo (custódia das lacradas) era só da API:
-- um SQL injetado, ou um bug de rota, podia marcar/retirar retenção ou designar custódia com qualquer
-- usuário. Agora:
--
-- 1. clinic_members (usuário × clínica × perfil), mantida pela API (rotas /clinica/membros) e travada
--    por RLS + trigger:
--    - só um ADMIN ATIVO da clínica (conferido nesta tabela, com o usuário travado da sessão) concede
--      ou revoga perfil; quem concede/revoga é sempre o usuário da sessão;
--    - exceção única (fundação): numa clínica SEM nenhuma linha, o usuário da sessão registra a si
--      mesmo como admin (o primeiro admin). Serializado por advisory lock da clínica;
--    - linha não se apaga nem se reescreve: só se revoga (uma vez); o último admin ativo não é revogado;
--    - o sistema (sentinela da 0019) não concede nem revoga nada (app_current_user() = NULL).
-- 2. Os triggers de retenção legal e de custódia conferem o PERFIL no banco:
--    - legal_holds: marcar, pedir e aprovar a retirada exigem admin ativo;
--    - note_custodies: designar exige admin ativo; o autor tem de ter sido psicólogo da clínica (pode já
--      ter saído, e é para isso que a custódia existe); o substituto tem de ser psicólogo ATIVO, na
--      designação e no aceite;
--    - private_notes: levar a lacrada para a guarda da clínica exige psicólogo ativo (além da custódia
--      aceita, já conferida na 0017).

CREATE TABLE clinic_members (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  user_id     uuid NOT NULL CONSTRAINT clinic_members_user_check CHECK (user_id <> '00000000-0000-0000-0000-000000000000'::uuid),
  role        text NOT NULL CONSTRAINT clinic_members_role_check
                CHECK (role IN ('admin', 'profissional', 'recepcao', 'financeiro', 'psicologo')),
  granted_by  uuid NOT NULL,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  revoked_by  uuid,
  revoked_at  timestamptz,
  CONSTRAINT clinic_members_revoke_check CHECK ((revoked_by IS NULL) = (revoked_at IS NULL))
);
-- Um perfil ativo por usuário na clínica (histórico de revogados fica).
CREATE UNIQUE INDEX clinic_members_active_idx ON clinic_members (tenant_id, user_id, role) WHERE revoked_at IS NULL;

ALTER TABLE clinic_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinic_members FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON clinic_members
  USING (tenant_id = (SELECT app_current_tenant()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()));
REVOKE DELETE, TRUNCATE ON clinic_members FROM app_user;

-- Perfil ATIVO do usuário na clínica do contexto (sob RLS: só enxerga a clínica da transação).
CREATE FUNCTION app_user_has_role(p_user uuid, p_role text) RETURNS boolean
  LANGUAGE sql
  STABLE
  SET search_path = pg_catalog, public
AS $$
  SELECT p_user IS NOT NULL AND EXISTS (
    SELECT 1 FROM clinic_members m
     WHERE m.tenant_id = app_current_tenant() AND m.user_id = p_user AND m.role = p_role AND m.revoked_at IS NULL)
$$;
-- Perfil que o usuário JÁ TEVE na clínica (ativo ou revogado).
CREATE FUNCTION app_user_had_role(p_user uuid, p_role text) RETURNS boolean
  LANGUAGE sql
  STABLE
  SET search_path = pg_catalog, public
AS $$
  SELECT p_user IS NOT NULL AND EXISTS (
    SELECT 1 FROM clinic_members m
     WHERE m.tenant_id = app_current_tenant() AND m.user_id = p_user AND m.role = p_role)
$$;
REVOKE ALL ON FUNCTION app_user_has_role(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_user_had_role(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_user_has_role(uuid, text) TO app_user;
GRANT EXECUTE ON FUNCTION app_user_had_role(uuid, text) TO app_user;

CREATE FUNCTION clinic_members_guard() RETURNS trigger
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
  -- Serializa as mudanças de perfil da clínica (fundação concorrente, revogação do último admin).
  PERFORM pg_advisory_xact_lock(hashtextextended('clinic_members:' || COALESCE(NEW.tenant_id, OLD.tenant_id)::text, 0));
  IF TG_OP = 'INSERT' THEN
    IF NEW.granted_by IS DISTINCT FROM v_user OR NEW.revoked_by IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'perfil é concedido por quem está na sessão e nasce ativo' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT app_user_has_role(v_user, 'admin') THEN
      -- Fundação: clínica sem nenhuma linha; o usuário da sessão vira o primeiro admin.
      IF NOT (NEW.role = 'admin' AND NEW.user_id = v_user
              AND NOT EXISTS (SELECT 1 FROM clinic_members m WHERE m.tenant_id = NEW.tenant_id)) THEN
        RAISE EXCEPTION 'só um admin ativo da clínica concede perfil' USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
    NEW.granted_at := now();
    RETURN NEW;
  END IF;
  -- UPDATE: só a revogação (uma vez), por admin ativo, sem mexer na identidade.
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
CREATE TRIGGER clinic_members_guard BEFORE INSERT OR UPDATE OR DELETE ON clinic_members
  FOR EACH ROW EXECUTE FUNCTION clinic_members_guard();
CREATE TRIGGER clinic_members_no_truncate BEFORE TRUNCATE ON clinic_members
  FOR EACH STATEMENT EXECUTE FUNCTION clinic_members_guard();

-- ------------------------------------------------------------------ retenção legal: só admin ativo

CREATE FUNCTION legal_holds_perfil() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT app_user_has_role(app_current_user(), 'admin') THEN
    RAISE EXCEPTION 'retenção legal exige admin ativo da clínica' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER legal_holds_perfil BEFORE INSERT OR UPDATE ON legal_holds
  FOR EACH ROW EXECUTE FUNCTION legal_holds_perfil();

-- ------------------------------------------------------------------ custódia: admin designa, psicólogo recebe

CREATE FUNCTION note_custodies_perfil() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := app_current_user();
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT app_user_has_role(v_user, 'admin') THEN
      RAISE EXCEPTION 'designar custódia exige admin ativo da clínica' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT app_user_had_role(NEW.author_user_id, 'psicologo') THEN
      RAISE EXCEPTION 'autor da custódia não é psicólogo da clínica' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF NOT app_user_has_role(NEW.substitute_user_id, 'psicologo') THEN
    RAISE EXCEPTION 'substituto da custódia não é psicólogo ativo da clínica' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER note_custodies_perfil BEFORE INSERT OR UPDATE ON note_custodies
  FOR EACH ROW EXECUTE FUNCTION note_custodies_perfil();

CREATE FUNCTION private_notes_custodia_perfil() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.custody_state = 'lacrada' AND NEW.custody_state = 'guarda_clinica'
     AND NOT app_user_has_role(app_current_user(), 'psicologo') THEN
    RAISE EXCEPTION 'guarda da lacrada exige psicólogo ativo da clínica' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER private_notes_custodia_perfil BEFORE UPDATE OF custody_state ON private_notes
  FOR EACH ROW EXECUTE FUNCTION private_notes_custodia_perfil();
