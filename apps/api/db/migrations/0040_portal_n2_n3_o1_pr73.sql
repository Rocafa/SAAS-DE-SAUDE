-- 0040 — N2, N3 e O1 da conferência da N1 do PR #73 (23/10). Executar com o papel de MIGRAÇÃO (app_migrator).
-- Ver docs/04-arquitetura/api-dominio.md §10f.
--
-- (N2) `representacao_estendida` dispara sempre que o recálculo ESTENDE a representação (`novo fim > fim
--      atual`) e ela vale depois do recálculo (`novo fim > hoje`), e não só quando já tinha acabado. Ex.: 17
--      anos "corrigido" para 13: o sigilo segue ligado, mas a representação vai ~4 anos além dos 18 reais.
-- (N3) `clinical_notices_guard`: tipos que SÓ o banco gera (hoje `portal_sigilo_transicao`) só entram quando
--      o INSERT vem de `app_portal_sigilo_alertar`: o gatilho roda como DONO da tabela (função SECURITY
--      DEFINER) com a GUC transacional `app.portal_alerta` ligada pela função. A GUC sozinha não basta (o
--      runtime consegue ligá-la, mas não é o dono), no mesmo padrão de `app.portal_recalc` (0037).
-- (O1) RLS de `clinical_notices` por DESTINATÁRIO: ler e marcar como lido só o próprio aviso
--      (`recipient_user_id = app_current_user()`), além do tenant. Criar continua por tenant (o aviso é para
--      outra pessoa) e o gatilho segue conferindo o criador. Sessão sem usuário (sistema) não lê aviso.

-- ================================================================ (N3) guard

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
    IF NEW.kind IN ('portal_sigilo_transicao')
       AND NOT (app_running_as_owner(TG_RELID::regclass) AND current_setting('app.portal_alerta', true) = 'on') THEN
      RAISE EXCEPTION 'aviso % só é gerado pelo banco', NEW.kind USING ERRCODE = 'insufficient_privilege';
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

-- Mesma função da 0039; liga/desliga a GUC em volta do INSERT.
CREATE OR REPLACE FUNCTION app_portal_sigilo_alertar(p_tenant uuid, p_patient uuid, p_transicao text, p_n integer) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_user  uuid := app_current_user();
  v_dias  integer := (SELECT t.care_link_days FROM tenants t WHERE t.id = p_tenant);
  v_dest  integer;
BEGIN
  PERFORM set_config('app.portal_alerta', 'on', true);
  INSERT INTO clinical_notices (tenant_id, recipient_user_id, kind, patient_id, portal_transition, created_by)
  SELECT p_tenant, d.user_id, 'portal_sigilo_transicao', p_patient, p_transicao, v_user
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
    VALUES (p_tenant, COALESCE(v_user, '00000000-0000-0000-0000-000000000000'::uuid), 'anomaly_alert', 'portal_links',
            jsonb_build_object('rule', 'portal_sigilo_transicao', 'transition', p_transicao, 'count', p_n, 'notified', v_dest));
END;
$$;
REVOKE ALL ON FUNCTION app_portal_sigilo_alertar(uuid, uuid, text, integer) FROM PUBLIC;

-- ================================================================ (N2) critério da extensão

CREATE OR REPLACE FUNCTION app_portal_sigilo_aplicar(p_tenant uuid, p_patient uuid, p_cf date, p_ru date, p_motivo text) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_hoje     date := app_fiscal_today();
  v_n        integer := 0;
  v_desliga  integer := 0;
  v_estende  integer := 0;
  v_prev     jsonb := '{}'::jsonb;
  v_salvo    jsonb;
  v_cf       date;
  v_ru       date;
  r          record;
BEGIN
  IF p_motivo = 'birth_date_reverted' THEN
    SELECT m.prev_state INTO v_prev FROM portal_birth_date_changes m
     WHERE m.tenant_id = p_tenant AND m.patient_id = p_patient AND m.xact = txid_current();
    v_prev := COALESCE(v_prev, '{}'::jsonb);
  END IF;
  PERFORM set_config('app.portal_recalc', 'on', true);
  FOR r IN
    SELECT 'link'::text AS tipo, l.id, l.confidential_from AS cf, l.represent_until AS ru, g.valid_until
      FROM portal_links l JOIN patient_guardians g ON g.tenant_id = l.tenant_id AND g.id = l.guardian_link_id
     WHERE l.tenant_id = p_tenant AND l.patient_id = p_patient AND l.acting_as = 'responsavel_legal'
       AND l.revoked_at IS NULL AND l.represent_until IS NOT NULL
    UNION ALL
    SELECT 'invite', i.id, i.confidential_from, i.represent_until, g.valid_until
      FROM portal_invites i JOIN patient_guardians g ON g.tenant_id = i.tenant_id AND g.id = i.guardian_link_id
     WHERE i.tenant_id = p_tenant AND i.patient_id = p_patient AND i.acting_as = 'responsavel_legal'
       AND i.redeemed_at IS NULL AND i.revoked_at IS NULL AND i.represent_until IS NOT NULL
  LOOP
    IF p_motivo = 'birth_date_reverted' THEN
      v_salvo := v_prev -> r.id::text;
      v_cf := LEAST(COALESCE((v_salvo ->> 0)::date, r.cf), v_hoje);
      v_ru := COALESCE((v_salvo ->> 1)::date, r.ru);
    ELSE
      v_cf := COALESCE(p_cf, LEAST(r.cf, v_hoje));
      v_ru := CASE WHEN p_ru IS NULL THEN LEAST(r.ru, v_hoje) ELSE LEAST(p_ru, COALESCE(r.valid_until, p_ru)) END;
    END IF;
    CONTINUE WHEN v_cf IS NOT DISTINCT FROM r.cf AND v_ru IS NOT DISTINCT FROM r.ru;  -- (R3) nada mudou
    IF p_motivo = 'birth_date_changed' THEN
      UPDATE portal_birth_date_changes
         SET prev_state = jsonb_build_object(r.id::text, jsonb_build_array(r.cf, r.ru)) || prev_state
       WHERE tenant_id = p_tenant AND patient_id = p_patient AND xact = txid_current();
      IF r.cf <= v_hoje AND v_cf > v_hoje THEN
        v_desliga := v_desliga + 1;
      END IF;
      -- (N2) Qualquer extensão que deixa a representação valendo, tenha ela acabado ou não.
      IF v_ru > r.ru AND v_ru > v_hoje THEN
        v_estende := v_estende + 1;
      END IF;
    END IF;
    IF r.tipo = 'link' THEN
      UPDATE portal_links SET confidential_from = v_cf, represent_until = v_ru WHERE tenant_id = p_tenant AND id = r.id;
    ELSE
      UPDATE portal_invites SET confidential_from = v_cf, represent_until = v_ru WHERE tenant_id = p_tenant AND id = r.id;
    END IF;
    INSERT INTO audit_log (tenant_id, actor_id, action, scope, metadata)
      VALUES (p_tenant, COALESCE(app_current_user(), '00000000-0000-0000-0000-000000000000'::uuid), 'update', 'portal_links',
              jsonb_build_object('op', 'confidentiality_recalculated', 'patient_id', p_patient,
                                 'kind', r.tipo, 'target_id', r.id, 'closed', p_cf IS NULL, 'reason', p_motivo,
                                 'confidential_shift_days', v_cf - r.cf, 'represent_shift_days', v_ru - r.ru,
                                 'confidential_was_on', r.cf <= v_hoje, 'confidential_now_on', v_cf <= v_hoje,
                                 'representing_was_on', r.ru > v_hoje, 'representing_now_on', v_ru > v_hoje));
    v_n := v_n + 1;
  END LOOP;
  PERFORM set_config('app.portal_recalc', 'off', true);
  IF v_desliga > 0 THEN
    PERFORM app_portal_sigilo_alertar(p_tenant, p_patient, 'sigilo_desligado', v_desliga);
  END IF;
  IF v_estende > 0 THEN
    PERFORM app_portal_sigilo_alertar(p_tenant, p_patient, 'representacao_estendida', v_estende);
  END IF;
  RETURN v_n;
END;
$$;

-- ================================================================ (O1) RLS por destinatário

DROP POLICY tenant_isolation ON clinical_notices;
CREATE POLICY notices_insert ON clinical_notices FOR INSERT
  WITH CHECK (tenant_id = (SELECT app_current_tenant()));
CREATE POLICY notices_recipient_select ON clinical_notices FOR SELECT
  USING (tenant_id = (SELECT app_current_tenant()) AND recipient_user_id = (SELECT app_current_user()));
CREATE POLICY notices_recipient_update ON clinical_notices FOR UPDATE
  USING (tenant_id = (SELECT app_current_tenant()) AND recipient_user_id = (SELECT app_current_user()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()) AND recipient_user_id = (SELECT app_current_user()));

-- ================================================================ conferência final

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS f, p.prosecdef, o.rolname, o.rolsuper, o.rolbypassrls,
           pg_has_role(o.oid, (SELECT relowner FROM pg_class WHERE oid = 'clinical_notices'::regclass), 'MEMBER') AS dono_tabela
      FROM pg_proc p JOIN pg_roles o ON o.oid = p.proowner
     WHERE p.oid IN ('app_portal_sigilo_aplicar(uuid,uuid,date,date,text)'::regprocedure,
                     'app_portal_sigilo_alertar(uuid,uuid,text,integer)'::regprocedure)
  LOOP
    IF NOT r.prosecdef THEN
      RAISE EXCEPTION '% deveria ser SECURITY DEFINER', r.f;
    END IF;
    IF r.rolsuper OR r.rolbypassrls OR r.rolname = 'app_user' THEN
      RAISE EXCEPTION 'dono de % (%) não pode ser superusuário, BYPASSRLS nem o runtime', r.f, r.rolname;
    END IF;
    IF NOT r.dono_tabela THEN
      RAISE EXCEPTION 'dono de % (%) precisa ser o dono de clinical_notices (N3)', r.f, r.rolname;
    END IF;
  END LOOP;
  IF pg_has_role('app_user', (SELECT relowner FROM pg_class WHERE oid = 'clinical_notices'::regclass), 'MEMBER') THEN
    RAISE EXCEPTION 'o runtime não pode ser membro do dono de clinical_notices (N3)';
  END IF;
END;
$$;
