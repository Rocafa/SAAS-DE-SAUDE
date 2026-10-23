-- 0038 — Ressalvas do parecer do PR #73 (integração da rodada 19, 22/10). Executar com o papel de MIGRAÇÃO
-- (app_migrator). Ver docs/04-arquitetura/api-dominio.md §10c.
--
-- (R1) `app_portal_recalc_sigilo` deixa de aceitar chamadas arbitrárias: reabrir OU fechar só vale na MESMA
--      transação que mudou `patients.birth_date_enc` daquele paciente. O gatilho grava a marca numa tabela
--      INTERNA (`portal_birth_date_changes`, zero privilégio para o runtime; uma GUC poderia ser forjada por
--      `set_config`), e a função exige e consome a marca. O serviço só reescreve a coluna quando a data
--      decifrada mudou de fato. A trilha é gravada DENTRO da função, com os valores antigos e novos de cada
--      vínculo/convite alterado. Se a transação mudou a coluna e não recalculou, um gatilho ADIADO (no
--      COMMIT) fecha (falha fechada), com trilha.
-- (R3) Reescrever `birth_date_enc` com a MESMA data (recifração, rotação de chave) e recalcular com as mesmas
--      datas não muda nada nem grava trilha: vínculo/convite só é tocado quando o valor novo difere.

-- ================================================================ (R1) marca da mudança da data

CREATE TABLE portal_birth_date_changes (
  tenant_id   uuid   NOT NULL,
  patient_id  uuid   NOT NULL,
  xact        bigint NOT NULL,
  PRIMARY KEY (tenant_id, patient_id, xact)
);
REVOKE ALL ON portal_birth_date_changes FROM PUBLIC;
REVOKE ALL ON portal_birth_date_changes FROM app_user;
ALTER TABLE portal_birth_date_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_birth_date_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY portal_birth_date_changes_definer_only ON portal_birth_date_changes TO CURRENT_USER USING (true) WITH CHECK (true);

-- Aplica (ou fecha) o sigilo e o fim da representação dos vínculos e convites ABERTOS de responsável (fora a
-- curatela) e grava a trilha de CADA vínculo/convite alterado. O contrato da trilha (0005) proíbe datas e
-- "antes/depois" literais (a data dos 12/18 revela a data de nascimento): o antigo e o novo vão como o ESTADO
-- (sigilo valendo? representação valendo?) antes e depois e o deslocamento em dias de cada coluna.
-- Interna: só as funções/gatilhos abaixo chamam.
CREATE FUNCTION app_portal_sigilo_aplicar(p_tenant uuid, p_patient uuid, p_cf date, p_ru date, p_motivo text) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_hoje date := app_fiscal_today();
  v_n    integer := 0;
  v_cf   date;
  v_ru   date;
  r      record;
BEGIN
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
    v_cf := COALESCE(p_cf, LEAST(r.cf, v_hoje));
    v_ru := CASE WHEN p_ru IS NULL THEN LEAST(r.ru, v_hoje) ELSE LEAST(p_ru, COALESCE(r.valid_until, p_ru)) END;
    CONTINUE WHEN v_cf IS NOT DISTINCT FROM r.cf AND v_ru IS NOT DISTINCT FROM r.ru;  -- (R3) nada mudou
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
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION app_portal_sigilo_aplicar(uuid, uuid, date, date, text) FROM PUBLIC;

-- Pública (serviço da clínica): reabrir OU fechar exige a marca desta transação (e a consome).
CREATE OR REPLACE FUNCTION app_portal_recalc_sigilo(p_patient uuid, p_confidential_from date, p_represent_until date) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_tenant uuid := app_current_tenant();
  v_seis   date;
BEGIN
  IF v_tenant IS NULL OR app_portal_patient() IS NOT NULL OR app_current_user() IS NULL THEN
    RAISE EXCEPTION 'recálculo do sigilo é do usuário da sessão da clínica' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (p_confidential_from IS NULL) <> (p_represent_until IS NULL) THEN
    RAISE EXCEPTION 'sigilo e fim da representação vêm juntos (ou os dois nulos, para fechar)' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_confidential_from IS NOT NULL THEN
    -- Dia dos 12 e dia dos 18 da MESMA data de nascimento (29/02: até um dia de diferença).
    v_seis := (p_confidential_from + interval '6 years')::date;
    IF p_represent_until NOT BETWEEN v_seis - 1 AND v_seis + 1 THEN
      RAISE EXCEPTION 'datas não correspondem a uma data de nascimento' USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;
  DELETE FROM portal_birth_date_changes
   WHERE tenant_id = v_tenant AND patient_id = p_patient AND xact = txid_current();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'recálculo do sigilo/representação só na transação que mudou a data de nascimento' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN app_portal_sigilo_aplicar(v_tenant, p_patient, p_confidential_from, p_represent_until,
                                   CASE WHEN p_confidential_from IS NULL THEN 'birth_date_cleared' ELSE 'birth_date_changed' END);
END;
$$;
REVOKE ALL ON FUNCTION app_portal_recalc_sigilo(uuid, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_portal_recalc_sigilo(uuid, date, date) TO app_user;

-- O gatilho imediato da 0037 (que fechava na hora) sai: agora o gatilho grava a marca, e o fechamento, se o
-- serviço não recalculou, acontece no COMMIT (gatilho de restrição ADIADO).
DROP TRIGGER patients_birth_date_portal_guard ON patients;
DROP FUNCTION patients_birth_date_portal_guard();

CREATE FUNCTION patients_birth_date_mark() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  INSERT INTO portal_birth_date_changes (tenant_id, patient_id, xact)
    VALUES (NEW.tenant_id, NEW.id, txid_current())
    ON CONFLICT DO NOTHING;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION patients_birth_date_mark() FROM PUBLIC;
CREATE TRIGGER patients_birth_date_mark AFTER UPDATE OF birth_date_enc ON patients
  FOR EACH ROW WHEN (NEW.birth_date_enc IS DISTINCT FROM OLD.birth_date_enc)
  EXECUTE FUNCTION patients_birth_date_mark();

CREATE FUNCTION patients_birth_date_portal_close() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  DELETE FROM portal_birth_date_changes
   WHERE tenant_id = NEW.tenant_id AND patient_id = NEW.id AND xact = txid_current();
  IF FOUND THEN
    IF app_current_tenant() IS DISTINCT FROM NEW.tenant_id THEN
      RAISE EXCEPTION 'data de nascimento só muda na sessão da clínica do paciente' USING ERRCODE = 'insufficient_privilege';
    END IF;
    PERFORM app_portal_sigilo_aplicar(NEW.tenant_id, NEW.id, NULL, NULL, 'birth_date_changed_not_recalculated');
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION patients_birth_date_portal_close() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER patients_birth_date_portal_close AFTER UPDATE OF birth_date_enc ON patients
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.birth_date_enc IS DISTINCT FROM OLD.birth_date_enc)
  EXECUTE FUNCTION patients_birth_date_portal_close();

-- ================================================================ (R2) funções *_hidden sem oráculo
-- As funções precisam de EXECUTE para o runtime (estão nas policies). Na sessão do portal, respondem IGUAL
-- (true = esconder) para "não existe", "é de outro paciente" e "existe, mas oculta": só dizem false para a
-- linha do PRÓPRIO paciente da sessão que ele pode ver. Fora do portal, a regra da 0037 fica igual.

CREATE OR REPLACE FUNCTION app_portal_charge_hidden(p_charge uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT COALESCE((
    SELECT (public.app_portal_patient() IS NOT NULL AND c.patient_id IS DISTINCT FROM public.app_portal_patient())
           OR (public.app_portal_charge_sensitive(c.id)
               AND NOT EXISTS (
                 SELECT 1 FROM public.payments p
                  WHERE p.tenant_id = c.tenant_id AND p.charge_id = c.id
                    AND p.guardian_payer_link_id IS NOT NULL
                    AND p.guardian_payer_link_id = public.app_portal_session_guardian_link()))
      FROM public.charges c
     WHERE c.tenant_id = public.app_current_tenant() AND c.id = p_charge), true)
$$;

CREATE OR REPLACE FUNCTION app_portal_payment_hidden(p_payment uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT COALESCE((
    SELECT (public.app_portal_patient() IS NOT NULL AND c.patient_id IS DISTINCT FROM public.app_portal_patient())
           OR (public.app_portal_charge_sensitive(p.charge_id)
               AND (p.guardian_payer_link_id IS NULL OR p.guardian_payer_link_id IS DISTINCT FROM public.app_portal_session_guardian_link()))
      FROM public.payments p
      JOIN public.charges c ON c.tenant_id = p.tenant_id AND c.id = p.charge_id
     WHERE p.tenant_id = public.app_current_tenant() AND p.id = p_payment), true)
$$;

-- app_portal_receipt_hidden (0037) delega a app_portal_payment_hidden e já devolve true para recibo
-- inexistente: herda a regra acima sem mudança.

-- ================================================================ conferência final

-- Funções SECURITY DEFINER desta migração: dono sem superpoder e diferente do runtime.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS f, p.prosecdef, o.rolname, o.rolsuper, o.rolbypassrls
      FROM pg_proc p JOIN pg_roles o ON o.oid = p.proowner
     WHERE p.oid IN ('app_portal_sigilo_aplicar(uuid,uuid,date,date,text)'::regprocedure,
                     'app_portal_recalc_sigilo(uuid,date,date)'::regprocedure,
                     'patients_birth_date_mark()'::regprocedure,
                     'patients_birth_date_portal_close()'::regprocedure)
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
