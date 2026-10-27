-- 0053 — ressalva 1 da Conferência 0052 (24/10/2026). Executar com o papel de MIGRAÇÃO (app_migrator). Ver
-- docs/04-arquitetura/api-dominio.md §10d e §10h e docs/03-seguranca-lgpd/revisoes/2026-10-24-front-vetos.md
-- ("Conferência 0052").
--
-- Conferência de documento do nascimento (pedido do titular e PATCH do cadastro): passa a gravar o PERFIL de
-- quem conferiu e a exigir perfil ATIVO `admin` ou `profissional` na clínica da transação (clinic_members,
-- 0020). A recepção sozinha não confere. O perfil é calculado AQUI (nunca vem de quem grava); com os dois
-- perfis, grava `admin`. A API confere o mesmo antes (403 `conferencia_exige_perfil`); o banco é a trava.
--   * `portal_rights_requests.document_checked_role`: preenchido pelo gatilho na conferência; imutável depois.
--     Conferências anteriores a esta migração ficam com perfil nulo (= não registrado); o CHECK só proíbe
--     perfil sem conferência (não há backfill: o gatilho recusaria e o perfil da época não é recuperável).
--   * `portal_birth_date_changes.document_checked_role`: a marca da mudança da data (0052) leva o perfil; a
--     trilha `birth_date_document_checked` também (sem a data).
-- O resto (exigência gravada na abertura, trava no recálculo da 0052) não muda.

-- Perfil que pode declarar "conferi o documento original": admin antes de profissional; null = nenhum.
CREATE FUNCTION app_document_check_role(p_user uuid) RETURNS text
  LANGUAGE sql
  STABLE
  SET search_path = pg_catalog, public
AS $$
  SELECT CASE WHEN app_user_has_role(p_user, 'admin') THEN 'admin'
              WHEN app_user_has_role(p_user, 'profissional') THEN 'profissional' END
$$;
REVOKE ALL ON FUNCTION app_document_check_role(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_document_check_role(uuid) TO app_user;

-- ================================================================ (1) pedido do titular

ALTER TABLE portal_rights_requests
  ADD COLUMN document_checked_role text,
  ADD CONSTRAINT portal_rights_requests_document_checked_role_check
    CHECK (document_checked_role IS NULL OR (document_checked_at IS NOT NULL AND document_checked_role IN ('admin', 'profissional')));

-- Gatilho da 0052 + o perfil da conferência.
CREATE OR REPLACE FUNCTION portal_rights_requests_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := app_current_user();
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF app_portal_patient() IS NULL OR NEW.patient_id IS DISTINCT FROM app_portal_patient()
       OR NEW.link_id IS DISTINCT FROM app_portal_link() OR NEW.account_id IS DISTINCT FROM app_portal_account() THEN
      RAISE EXCEPTION 'pedido do titular é aberto pela sessão do portal' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.created_at IS DISTINCT FROM now() OR NEW.status <> 'aberta' OR NEW.handled_by IS NOT NULL OR NEW.answer_enc IS NOT NULL
       OR NEW.document_checked_by IS NOT NULL OR NEW.document_checked_at IS NOT NULL OR NEW.document_checked_role IS NOT NULL
       OR NEW.acting_as IS DISTINCT FROM
          (SELECT l.acting_as FROM portal_links l WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.link_id AND l.revoked_at IS NULL) THEN
      RAISE EXCEPTION 'pedido do titular nasce aberto, no vínculo ativo' USING ERRCODE = 'check_violation';
    END IF;
    -- C1-b′ (0052): sem decisão da API, falha fechada (com data proposta, exige documento).
    NEW.document_required := COALESCE(NEW.document_required, NEW.birth_date_proposed_enc IS NOT NULL);
    -- Teto diário por vínculo (A3c do #68). Trava o vínculo para a contagem não correr.
    PERFORM pg_advisory_xact_lock(hashtextextended('portal_rights:' || NEW.link_id::text, 0));
    IF (SELECT count(*) FROM portal_rights_requests r
         WHERE r.tenant_id = NEW.tenant_id AND r.link_id = NEW.link_id AND r.created_at > now() - interval '1 day') >= 5 THEN
      RAISE EXCEPTION 'teto diário de pedidos do titular atingido' USING ERRCODE = 'program_limit_exceeded';
    END IF;
    -- V1: qual responsável agiu sai do vínculo (nunca de quem grava).
    NEW.guardian_id := (SELECT l.guardian_id FROM portal_links l WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.link_id);
    NEW.due_at := NEW.created_at + interval '15 days';
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
     OR NEW.link_id IS DISTINCT FROM OLD.link_id OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.acting_as IS DISTINCT FROM OLD.acting_as OR NEW.protocol IS DISTINCT FROM OLD.protocol
     OR NEW.detail_enc IS DISTINCT FROM OLD.detail_enc OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.due_at IS DISTINCT FROM OLD.due_at OR NEW.guardian_id IS DISTINCT FROM OLD.guardian_id
     OR NEW.birth_date_proposed_enc IS DISTINCT FROM OLD.birth_date_proposed_enc
     OR NEW.document_required IS DISTINCT FROM OLD.document_required THEN
    RAISE EXCEPTION 'pedido do titular: identidade e detalhe são imutáveis' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_user IS NULL OR app_portal_patient() IS NOT NULL OR NEW.handled_by IS DISTINCT FROM v_user OR NEW.handled_at IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'só o usuário da sessão da clínica atende o pedido' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status IN ('atendida', 'recusada') THEN
    RAISE EXCEPTION 'pedido encerrado não muda' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NOT ((OLD.status = 'aberta' AND NEW.status IN ('em_andamento', 'atendida', 'recusada'))
          OR (OLD.status = 'em_andamento' AND NEW.status IN ('atendida', 'recusada'))) THEN
    RAISE EXCEPTION 'transição de pedido do titular inválida' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IN ('atendida', 'recusada') AND NEW.answer_enc IS NULL THEN
    RAISE EXCEPTION 'pedido atendido ou recusado exige resposta ao titular' USING ERRCODE = 'check_violation';
  END IF;
  -- C1: conferência do documento da data proposta: uma vez, pelo usuário da sessão, agora; depois imutável.
  IF OLD.document_checked_at IS NOT NULL THEN
    IF NEW.document_checked_by IS DISTINCT FROM OLD.document_checked_by OR NEW.document_checked_at IS DISTINCT FROM OLD.document_checked_at
       OR NEW.document_checked_role IS DISTINCT FROM OLD.document_checked_role THEN
      RAISE EXCEPTION 'conferência de documento do pedido é imutável' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NEW.document_checked_at IS NOT NULL THEN
    IF NEW.document_checked_by IS DISTINCT FROM v_user OR NEW.document_checked_at IS DISTINCT FROM now() THEN
      RAISE EXCEPTION 'conferência de documento: autor e hora são da sessão da clínica' USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- 0053: o perfil sai do banco (clinic_members), nunca de quem grava; a recepção sozinha não confere.
    NEW.document_checked_role := app_document_check_role(v_user);
    IF NEW.document_checked_role IS NULL THEN
      RAISE EXCEPTION 'conferência de documento exige perfil admin ou profissional' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NEW.document_checked_role IS NOT NULL OR NEW.document_checked_by IS NOT NULL THEN
    RAISE EXCEPTION 'perfil/autor da conferência só junto com a conferência' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- C1-b′ (0052): atender pedido que exigia documento só com a conferência gravada.
  IF NEW.status = 'atendida' AND NEW.document_required AND NEW.document_checked_at IS NULL THEN
    RAISE EXCEPTION 'pedido de correção de nascimento exige documento conferido para ser atendido' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- ================================================================ (2) marca da mudança da data

ALTER TABLE portal_birth_date_changes
  ADD COLUMN document_checked_role text,
  ADD CONSTRAINT portal_birth_date_changes_document_checked_role_check
    CHECK ((document_checked_by IS NULL) = (document_checked_role IS NULL)
           AND (document_checked_role IS NULL OR document_checked_role IN ('admin', 'profissional')));

-- Marca da 0052: o perfil zera junto com a conferência quando a data muda de novo na mesma transação.
CREATE OR REPLACE FUNCTION patients_birth_date_mark() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  INSERT INTO portal_birth_date_changes (tenant_id, patient_id, xact, prev_enc, last_enc)
    VALUES (NEW.tenant_id, NEW.id, txid_current(), OLD.birth_date_enc, NEW.birth_date_enc)
    ON CONFLICT (tenant_id, patient_id, xact) DO UPDATE
      SET last_enc = EXCLUDED.last_enc, consumed = false, document_checked_by = NULL, document_checked_role = NULL;
  RETURN NULL;
END;
$$;

-- 0052 + exige perfil admin/profissional (42501) e grava o perfil na marca e na trilha (sem a data).
CREATE OR REPLACE FUNCTION app_patient_birth_date_document_checked(p_patient uuid) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_tenant uuid := app_current_tenant();
  v_user   uuid := app_current_user();
  v_role   text;
BEGIN
  IF v_tenant IS NULL OR app_portal_patient() IS NOT NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'conferência de documento é do usuário da sessão da clínica' USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_role := app_document_check_role(v_user);
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'conferência de documento exige perfil admin ou profissional' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE portal_birth_date_changes SET document_checked_by = v_user, document_checked_role = v_role
   WHERE tenant_id = v_tenant AND patient_id = p_patient AND xact = txid_current() AND NOT consumed;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'conferência de documento só na transação que mudou a data de nascimento, antes do recálculo'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  INSERT INTO audit_log (tenant_id, actor_id, action, scope, metadata)
    VALUES (v_tenant, v_user, 'update', 'patients',
            jsonb_build_object('op', 'birth_date_document_checked', 'patient_id', p_patient, 'document_checked', true, 'role', v_role));
END;
$$;

-- ================================================================ conferência final

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS f, p.prosecdef, o.rolname, o.rolsuper, o.rolbypassrls
      FROM pg_proc p JOIN pg_roles o ON o.oid = p.proowner
     WHERE p.oid IN ('app_patient_birth_date_document_checked(uuid)'::regprocedure,
                     'patients_birth_date_mark()'::regprocedure)
  LOOP
    IF NOT r.prosecdef THEN
      RAISE EXCEPTION '% deveria ser SECURITY DEFINER', r.f;
    END IF;
    IF r.rolsuper OR r.rolbypassrls OR r.rolname = 'app_user' THEN
      RAISE EXCEPTION 'dono de % (%) não pode ser superusuário, BYPASSRLS nem o runtime', r.f, r.rolname;
    END IF;
  END LOOP;
END;
$$;
