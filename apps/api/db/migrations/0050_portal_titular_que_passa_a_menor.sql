-- 0050 — R3 do #68 (pendência declarada na conferência de 22/10): o TITULAR do portal que passa a constar como
-- menor não emancipado perde o acesso. Executar com o papel de MIGRAÇÃO (app_migrator).
-- Ver docs/04-arquitetura/api-dominio.md §10g e §14.
--
-- A data de nascimento é cifrada: só a API sabe a idade. Por isso a decisão "é menor" é da API, e o banco:
--   * só aceita o motivo novo `titular_menor_de_idade` vindo da função `app_portal_revoke_minor_titular`
--     (dono + GUC transacional `app.portal_titular_menor`; a clínica não usa esse motivo à mão);
--   * só deixa a função agir (a) na transação que MUDOU a data de nascimento do paciente (marca da 0038/0039),
--     com o usuário da sessão como ator, ou (b) na sessão de SISTEMA (job diário de varredura, ator `sistema`);
--   * confere o que consegue ver em claro: paciente da clínica do contexto e NÃO emancipado (`emancipated_on`).
-- Revogar só reduz acesso (falha segura): confiar na API para a idade não abre nada.
--
-- Na revogação: os vínculos `titular` ativos do paciente são revogados, os convites `titular` pendentes
-- (abertos e dentro da validade) são encerrados (revogados: `expires_at` é imutável), cada um com trilha
-- (ator, paciente, alvo, motivo), e sai o aviso `portal_sigilo_transicao` (transição nova
-- `titular_menor_revogado`) para os admins ativos e os profissionais do paciente, com o `anomaly_alert` na
-- trilha da clínica para o DPO (só regra, transição e contagens; sem id de paciente), como na 0039/0040.
-- Para o job (sem usuário), o aviso é criado pelo sentinela de sistema.

-- ================================================================ motivo e transição novos

ALTER TABLE portal_links DROP CONSTRAINT portal_links_revoke_reason_check;
ALTER TABLE portal_links ADD CONSTRAINT portal_links_revoke_reason_check CHECK (revoke_reason IS NULL OR revoke_reason IN (
  'pedido_do_paciente', 'acesso_indevido', 'fim_do_vinculo', 'erro_de_cadastro', 'maioridade_do_titular', 'fim_da_representacao',
  'titular_menor_de_idade'));

ALTER TABLE clinical_notices DROP CONSTRAINT clinical_notices_portal_transition_check;
ALTER TABLE clinical_notices ADD CONSTRAINT clinical_notices_portal_transition_check
  CHECK (portal_transition IN ('sigilo_desligado', 'representacao_estendida', 'titular_menor_revogado'));

-- ================================================================ gatilhos (mesmos da 0037, com um ramo a mais)

CREATE OR REPLACE FUNCTION portal_links_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := app_current_user();
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT app_running_as_owner(TG_RELID) THEN
      RAISE EXCEPTION 'vínculo do portal nasce só do resgate do convite' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.created_at IS DISTINCT FROM now() OR NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'vínculo do portal nasce ativo' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- 0037 (N3 do #68): recálculo do sigilo/representação pela data de nascimento, só em vínculo ativo.
  IF portal_recalc_allowed(to_jsonb(NEW), to_jsonb(OLD), TG_RELID::regclass) THEN
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.patient_id IS DISTINCT FROM OLD.patient_id OR NEW.invite_id IS DISTINCT FROM OLD.invite_id
     OR NEW.acting_as IS DISTINCT FROM OLD.acting_as OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.guardian_link_id IS DISTINCT FROM OLD.guardian_link_id OR NEW.guardian_id IS DISTINCT FROM OLD.guardian_id
     OR NEW.represent_until IS DISTINCT FROM OLD.represent_until OR NEW.confidential_from IS DISTINCT FROM OLD.confidential_from THEN
    RAISE EXCEPTION 'identidade do vínculo é imutável' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'vínculo revogado não muda' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NEW.revoke_reason IN ('maioridade_do_titular', 'fim_da_representacao') THEN
    IF NOT app_running_as_owner(TG_RELID) OR NEW.revoked_by IS DISTINCT FROM '00000000-0000-0000-0000-000000000000'::uuid
       OR NEW.revoked_at IS DISTINCT FROM now() OR OLD.acting_as <> 'responsavel_legal' THEN
      RAISE EXCEPTION 'fim da representação é registrado só pelo job do sistema' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  -- 0050: titular que passa a constar menor, só pela função própria (dono + GUC), com o ator da sessão (ou o
  -- sentinela, no job).
  IF NEW.revoke_reason = 'titular_menor_de_idade' THEN
    IF NOT app_running_as_owner(TG_RELID) OR current_setting('app.portal_titular_menor', true) IS DISTINCT FROM 'on'
       OR OLD.acting_as <> 'titular' OR NEW.revoked_at IS DISTINCT FROM now()
       OR NEW.revoked_by IS DISTINCT FROM COALESCE(v_user, '00000000-0000-0000-0000-000000000000'::uuid) THEN
      RAISE EXCEPTION 'titular menor é revogado só pela correção da data de nascimento ou pelo job' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF v_user IS NULL OR app_portal_patient() IS NOT NULL OR NEW.revoked_by IS DISTINCT FROM v_user OR NEW.revoked_at IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'vínculo é revogado pelo usuário da sessão da clínica' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION portal_invites_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := app_current_user();
  g      record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF v_user IS NULL OR app_portal_patient() IS NOT NULL OR NEW.created_by IS DISTINCT FROM v_user THEN
      RAISE EXCEPTION 'convite do portal é emitido pelo usuário da sessão da clínica' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.created_at IS DISTINCT FROM now() OR NEW.redeemed_at IS NOT NULL OR NEW.revoked_at IS NOT NULL OR NEW.link_id IS NOT NULL
       OR NEW.expires_at <= now() THEN
      RAISE EXCEPTION 'convite do portal nasce aberto e válido' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.acting_as = 'responsavel_legal' THEN
      SELECT pg.kind, pg.ended_at, pg.valid_from, pg.valid_until INTO g FROM patient_guardians pg
       WHERE pg.tenant_id = NEW.tenant_id AND pg.id = NEW.guardian_link_id
         AND pg.patient_id = NEW.patient_id AND pg.guardian_id = NEW.guardian_id;
      IF NOT FOUND OR g.ended_at IS NOT NULL OR g.valid_from > app_fiscal_today()
         OR (g.valid_until IS NOT NULL AND g.valid_until <= app_fiscal_today()) THEN
        RAISE EXCEPTION 'convite de responsável exige vínculo de responsável vigente do mesmo paciente' USING ERRCODE = 'check_violation';
      END IF;
      IF g.kind <> 'curador' THEN
        IF NEW.represent_until IS NULL OR NEW.represent_until <= app_fiscal_today()
           OR (g.valid_until IS NOT NULL AND NEW.represent_until > g.valid_until)
           OR EXISTS (SELECT 1 FROM patients p WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.patient_id AND p.emancipated_on IS NOT NULL) THEN
          RAISE EXCEPTION 'responsável no portal só para menor não emancipado (ou curatela)' USING ERRCODE = 'check_violation';
        END IF;
      ELSIF NEW.represent_until IS NOT NULL THEN
        RAISE EXCEPTION 'curatela não tem data de maioridade' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  -- 0037 (N3 do #68): recálculo do sigilo/representação pela data de nascimento, só em convite aberto.
  IF portal_recalc_allowed(to_jsonb(NEW), to_jsonb(OLD), TG_RELID::regclass) AND OLD.redeemed_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash OR NEW.acting_as IS DISTINCT FROM OLD.acting_as
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.guardian_link_id IS DISTINCT FROM OLD.guardian_link_id
     OR NEW.guardian_id IS DISTINCT FROM OLD.guardian_id OR NEW.represent_until IS DISTINCT FROM OLD.represent_until
     OR NEW.confidential_from IS DISTINCT FROM OLD.confidential_from THEN
    RAISE EXCEPTION 'identidade do convite é imutável' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.redeemed_at IS NOT NULL OR OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'convite resgatado ou revogado não muda' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NEW.redeemed_at IS NOT NULL THEN
    IF NOT app_running_as_owner(TG_RELID) OR NEW.revoked_at IS NOT NULL OR NEW.redeemed_at IS DISTINCT FROM now()
       OR OLD.expires_at <= now() THEN
      RAISE EXCEPTION 'convite só é resgatado pela função de resgate, dentro da validade' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.revoked_at IS NOT NULL THEN
    -- 0050: convite titular de quem passou a constar menor, pela função própria (o job não tem usuário).
    IF app_running_as_owner(TG_RELID) AND current_setting('app.portal_titular_menor', true) = 'on'
       AND OLD.acting_as = 'titular' AND app_portal_patient() IS NULL AND NEW.revoked_at = now()
       AND NEW.revoked_by IS NOT DISTINCT FROM COALESCE(v_user, '00000000-0000-0000-0000-000000000000'::uuid) THEN
      RETURN NEW;
    END IF;
    IF v_user IS NULL OR app_portal_patient() IS NOT NULL OR NEW.revoked_by IS DISTINCT FROM v_user OR NEW.revoked_at IS DISTINCT FROM now() THEN
      RAISE EXCEPTION 'convite é revogado pelo usuário da sessão da clínica' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'alteração de convite não permitida' USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- Avisos (mesmo da 0040): o aviso gerado pelo banco também pode nascer na sessão de SISTEMA (job), criado pelo
-- sentinela. Fora disso, nada muda.
CREATE OR REPLACE FUNCTION clinical_notices_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := app_current_user();
  semLeitura clinical_notices;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'clinical_notices não se apaga' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.kind = 'pedido_titular_aberto' THEN
      IF NOT app_is_system_session() OR app_portal_patient() IS NOT NULL
         OR NEW.created_by IS DISTINCT FROM '00000000-0000-0000-0000-000000000000'::uuid OR NEW.read_at IS NOT NULL THEN
        RAISE EXCEPTION 'aviso de pedido do titular é criado pelo sistema e nasce não lido' USING ERRCODE = 'insufficient_privilege';
      END IF;
      RETURN NEW;
    END IF;
    -- Tipos gerados só pelo banco: exigem o dono (função SECURITY DEFINER) E a GUC da função.
    IF NEW.kind IN ('portal_sigilo_transicao') THEN
      IF NOT (app_running_as_owner(TG_RELID::regclass) AND current_setting('app.portal_alerta', true) = 'on') THEN
        RAISE EXCEPTION 'aviso % só é gerado pelo banco', NEW.kind USING ERRCODE = 'insufficient_privilege';
      END IF;
      IF NEW.read_at IS NULL AND app_portal_patient() IS NULL AND (
           (v_user IS NOT NULL AND NEW.created_by = v_user)
           OR (app_is_system_session() AND NEW.created_by = '00000000-0000-0000-0000-000000000000'::uuid)) THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'aviso é criado por quem está na sessão e nasce não lido' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF v_user IS NULL OR NEW.created_by <> v_user OR NEW.read_at IS NOT NULL THEN
      RAISE EXCEPTION 'aviso é criado por quem está na sessão e nasce não lido' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  semLeitura := NEW;
  semLeitura.read_at := OLD.read_at;
  IF semLeitura IS DISTINCT FROM OLD OR OLD.read_at IS NOT NULL OR NEW.read_at IS NULL
     OR v_user IS NULL OR OLD.recipient_user_id <> v_user THEN
    RAISE EXCEPTION 'só o destinatário marca o aviso como lido' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

-- Mesma função da 0040; o criador do aviso é o usuário da sessão ou, no job, o sentinela de sistema.
CREATE OR REPLACE FUNCTION app_portal_sigilo_alertar(p_tenant uuid, p_patient uuid, p_transicao text, p_n integer) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ator  uuid := COALESCE(app_current_user(), '00000000-0000-0000-0000-000000000000'::uuid);
  v_dias  integer := (SELECT t.care_link_days FROM tenants t WHERE t.id = p_tenant);
  v_dest  integer;
BEGIN
  PERFORM set_config('app.portal_alerta', 'on', true);
  INSERT INTO clinical_notices (tenant_id, recipient_user_id, kind, patient_id, portal_transition, created_by)
  SELECT p_tenant, d.user_id, 'portal_sigilo_transicao', p_patient, p_transicao, v_ator
    FROM (
      SELECT m.user_id FROM clinic_members m
       WHERE m.tenant_id = p_tenant AND m.role = 'admin' AND m.revoked_at IS NULL
      UNION
      SELECT pr.user_id FROM appointments a
        JOIN professionals pr ON pr.tenant_id = a.tenant_id AND pr.id = a.professional_id
       WHERE a.tenant_id = p_tenant AND a.patient_id = p_patient
         AND a.status NOT IN ('cancelled', 'no_show')
         AND a.starts_at >= now() - make_interval(days => COALESCE(v_dias, 90))
         AND pr.active AND pr.user_id IS NOT NULL
    ) d
   WHERE d.user_id <> '00000000-0000-0000-0000-000000000000'::uuid;
  GET DIAGNOSTICS v_dest = ROW_COUNT;
  PERFORM set_config('app.portal_alerta', 'off', true);
  INSERT INTO audit_log (tenant_id, actor_id, action, scope, metadata)
    VALUES (p_tenant, v_ator, 'anomaly_alert', 'portal_links',
            jsonb_build_object('rule', 'portal_sigilo_transicao', 'transition', p_transicao, 'count', p_n, 'notified', v_dest));
END;
$$;
REVOKE ALL ON FUNCTION app_portal_sigilo_alertar(uuid, uuid, text, integer) FROM PUBLIC;

-- ================================================================ a revogação

-- Revoga o acesso de TITULAR de `p_patient` (a API já decidiu, pela data decifrada, que ele é menor). Só na
-- clínica do contexto, fora do portal; usuário da sessão SÓ na transação que mudou a data de nascimento do
-- paciente; ou sessão de sistema (job). Paciente emancipado: nada (0, 0). Idempotente.
CREATE FUNCTION app_portal_revoke_minor_titular(p_patient uuid) RETURNS TABLE (vinculos integer, convites integer)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_tenant  uuid := app_current_tenant();
  v_user    uuid := app_current_user();
  v_sistema boolean := app_is_system_session();
  v_ator    uuid;
  v_emanc   date;
  v_origem  text;
  v_l       integer := 0;
  v_c       integer := 0;
  r         record;
BEGIN
  IF v_tenant IS NULL OR app_portal_patient() IS NOT NULL OR (v_user IS NULL AND NOT v_sistema) THEN
    RAISE EXCEPTION 'revogação do titular menor é da sessão da clínica ou do job' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT v_sistema AND NOT EXISTS (
       SELECT 1 FROM portal_birth_date_changes m
        WHERE m.tenant_id = v_tenant AND m.patient_id = p_patient AND m.xact = txid_current()) THEN
    RAISE EXCEPTION 'revogação do titular menor pelo usuário só na transação que mudou a data de nascimento' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT p.emancipated_on INTO v_emanc FROM patients p WHERE p.tenant_id = v_tenant AND p.id = p_patient;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'paciente não encontrado na clínica do contexto' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_emanc IS NOT NULL AND v_emanc <= app_fiscal_today() THEN
    vinculos := 0; convites := 0;
    RETURN NEXT;
    RETURN;
  END IF;
  v_ator := COALESCE(v_user, '00000000-0000-0000-0000-000000000000'::uuid);
  v_origem := CASE WHEN v_sistema THEN 'varredura_diaria' ELSE 'correcao_do_nascimento' END;
  PERFORM set_config('app.portal_titular_menor', 'on', true);
  FOR r IN
    SELECT l.id FROM portal_links l
     WHERE l.tenant_id = v_tenant AND l.patient_id = p_patient AND l.acting_as = 'titular' AND l.revoked_at IS NULL
     ORDER BY l.id
     FOR UPDATE
  LOOP
    UPDATE portal_links SET revoked_at = now(), revoked_by = v_ator, revoke_reason = 'titular_menor_de_idade'
     WHERE tenant_id = v_tenant AND id = r.id;
    INSERT INTO audit_log (tenant_id, actor_id, action, scope, metadata)
      VALUES (v_tenant, v_ator, 'update', 'portal_links',
              jsonb_build_object('op', 'revoke', 'link_id', r.id, 'reason', 'titular_menor_de_idade',
                                 'patient_id', p_patient, 'origin', v_origem));
    v_l := v_l + 1;
  END LOOP;
  FOR r IN
    SELECT i.id FROM portal_invites i
     WHERE i.tenant_id = v_tenant AND i.patient_id = p_patient AND i.acting_as = 'titular'
       AND i.redeemed_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
     ORDER BY i.id
     FOR UPDATE
  LOOP
    UPDATE portal_invites SET revoked_at = now(), revoked_by = v_ator WHERE tenant_id = v_tenant AND id = r.id;
    INSERT INTO audit_log (tenant_id, actor_id, action, scope, metadata)
      VALUES (v_tenant, v_ator, 'update', 'portal_invites',
              jsonb_build_object('op', 'revoke', 'invite_id', r.id, 'reason', 'titular_menor_de_idade',
                                 'patient_id', p_patient, 'origin', v_origem));
    v_c := v_c + 1;
  END LOOP;
  PERFORM set_config('app.portal_titular_menor', 'off', true);
  IF v_l + v_c > 0 THEN
    PERFORM app_portal_sigilo_alertar(v_tenant, p_patient, 'titular_menor_revogado', v_l + v_c);
  END IF;
  vinculos := v_l; convites := v_c;
  RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION app_portal_revoke_minor_titular(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_portal_revoke_minor_titular(uuid) TO app_user;

-- ================================================================ conferência final

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS f, p.prosecdef, o.rolname, o.rolsuper, o.rolbypassrls,
           pg_has_role(o.oid, (SELECT relowner FROM pg_class WHERE oid = 'portal_links'::regclass), 'MEMBER') AS dono_links,
           pg_has_role(o.oid, (SELECT relowner FROM pg_class WHERE oid = 'clinical_notices'::regclass), 'MEMBER') AS dono_avisos
      FROM pg_proc p JOIN pg_roles o ON o.oid = p.proowner
     WHERE p.oid IN ('app_portal_revoke_minor_titular(uuid)'::regprocedure,
                     'app_portal_sigilo_alertar(uuid,uuid,text,integer)'::regprocedure)
  LOOP
    IF NOT r.prosecdef THEN
      RAISE EXCEPTION '% deveria ser SECURITY DEFINER', r.f;
    END IF;
    IF r.rolsuper OR r.rolbypassrls OR r.rolname = 'app_user' THEN
      RAISE EXCEPTION 'dono de % (%) não pode ser superusuário, BYPASSRLS nem o runtime', r.f, r.rolname;
    END IF;
    IF NOT r.dono_links OR NOT r.dono_avisos THEN
      RAISE EXCEPTION 'dono de % (%) precisa ser o dono de portal_links e clinical_notices', r.f, r.rolname;
    END IF;
  END LOOP;
  IF pg_has_role('app_user', (SELECT relowner FROM pg_class WHERE oid = 'portal_links'::regclass), 'MEMBER') THEN
    RAISE EXCEPTION 'o runtime não pode ser membro do dono de portal_links';
  END IF;
END;
$$;
