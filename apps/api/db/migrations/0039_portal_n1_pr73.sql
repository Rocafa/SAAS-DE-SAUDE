-- 0039 — N1 da conferência das ressalvas do PR #73 (23/10). Executar com o papel de MIGRAÇÃO (app_migrator).
-- Ver docs/04-arquitetura/api-dominio.md §10e.
--
-- (a) "Troca e devolve": na MESMA transação, trocar `birth_date_enc` para X, recalcular (a marca da 0038 é
--     consumida) e devolver a cifra original. No COMMIT a cifra é igual à de antes e o recálculo valeria sem
--     artefato no cadastro. Agora a marca guarda a cifra ANTERIOR (a da 1ª mudança da transação) e a ÚLTIMA,
--     e o recálculo só a marca como consumida (não apaga). No COMMIT, se a cifra final for IGUAL à anterior, a
--     marca não vale: o sigilo FECHA (dia dos 12 = hoje, se ainda não valia) e a representação VOLTA ao valor
--     de antes da transação, com trilha `birth_date_reverted`. Os valores de antes ficam na própria marca
--     (tabela INTERNA e transitória: apagada no mesmo COMMIT), nunca na trilha.
--     Uma mudança DEPOIS do recálculo volta a exigir recálculo (a marca deixa de estar consumida).
-- (b) Transições perigosas do recálculo: o sigilo DESLIGA (valia e deixou de valer) ou a representação de quem
--     já tinha 18 anos pela data anterior LIGA ou ESTENDE. Cada uma grava um aviso (`clinical_notices`,
--     `portal_sigilo_transicao`, com o id do paciente e a transição) para os admins ativos e para os
--     profissionais ativos do paciente (agenda na janela de cuidado da clínica ou futura), e um `anomaly_alert`
--     na trilha da clínica (regra `portal_sigilo_transicao`, mesmo canal dos alertas do #61, que o encarregado
--     (DPO) acompanha; só regra, transição e contagem, sem id de paciente). A API repete o marcador de log
--     ALERTA_ANOMALIA para o alarme de operação.

-- ================================================================ (a) marca com a cifra anterior

ALTER TABLE portal_birth_date_changes
  ADD COLUMN prev_enc   text,
  ADD COLUMN last_enc   text,
  ADD COLUMN consumed   boolean NOT NULL DEFAULT false,
  ADD COLUMN prev_state jsonb   NOT NULL DEFAULT '{}'::jsonb;

CREATE OR REPLACE FUNCTION patients_birth_date_mark() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  -- A 1ª mudança da transação fixa a cifra anterior; as seguintes só atualizam a última e voltam a exigir
  -- recálculo.
  INSERT INTO portal_birth_date_changes (tenant_id, patient_id, xact, prev_enc, last_enc)
    VALUES (NEW.tenant_id, NEW.id, txid_current(), OLD.birth_date_enc, NEW.birth_date_enc)
    ON CONFLICT (tenant_id, patient_id, xact) DO UPDATE SET last_enc = EXCLUDED.last_enc, consumed = false;
  RETURN NULL;
END;
$$;

-- Recálculo: exige a marca NÃO consumida desta transação e a consome (sem apagar: o COMMIT ainda compara).
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
    v_seis := (p_confidential_from + interval '6 years')::date;
    IF p_represent_until NOT BETWEEN v_seis - 1 AND v_seis + 1 THEN
      RAISE EXCEPTION 'datas não correspondem a uma data de nascimento' USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;
  UPDATE portal_birth_date_changes SET consumed = true
   WHERE tenant_id = v_tenant AND patient_id = p_patient AND xact = txid_current() AND NOT consumed;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'recálculo do sigilo/representação só na transação que mudou a data de nascimento' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN app_portal_sigilo_aplicar(v_tenant, p_patient, p_confidential_from, p_represent_until,
                                   CASE WHEN p_confidential_from IS NULL THEN 'birth_date_cleared' ELSE 'birth_date_changed' END);
END;
$$;

-- No COMMIT (gatilho de restrição ADIADO da 0038): cifra final = anterior -> reverte; marca não consumida ->
-- fecha (como na 0038). A marca some em qualquer caso.
CREATE OR REPLACE FUNCTION patients_birth_date_portal_close() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  m portal_birth_date_changes;
BEGIN
  SELECT * INTO m FROM portal_birth_date_changes
   WHERE tenant_id = NEW.tenant_id AND patient_id = NEW.id AND xact = txid_current()
   FOR UPDATE;
  IF FOUND THEN
    IF app_current_tenant() IS DISTINCT FROM NEW.tenant_id THEN
      RAISE EXCEPTION 'data de nascimento só muda na sessão da clínica do paciente' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF m.prev_enc IS NOT DISTINCT FROM m.last_enc THEN
      PERFORM app_portal_sigilo_aplicar(NEW.tenant_id, NEW.id, NULL, NULL, 'birth_date_reverted');
    ELSIF NOT m.consumed THEN
      PERFORM app_portal_sigilo_aplicar(NEW.tenant_id, NEW.id, NULL, NULL, 'birth_date_changed_not_recalculated');
    END IF;
    DELETE FROM portal_birth_date_changes
     WHERE tenant_id = NEW.tenant_id AND patient_id = NEW.id AND xact = txid_current();
  END IF;
  RETURN NULL;
END;
$$;

-- ================================================================ (b) aviso da transição perigosa

ALTER TABLE clinical_notices DROP CONSTRAINT clinical_notices_kind_check;
ALTER TABLE clinical_notices DROP CONSTRAINT clinical_notices_shape_check;
ALTER TABLE clinical_notices
  ADD COLUMN patient_id uuid,
  ADD COLUMN portal_transition text CONSTRAINT clinical_notices_portal_transition_check
    CHECK (portal_transition IN ('sigilo_desligado', 'representacao_estendida')),
  ADD CONSTRAINT clinical_notices_patient_fk FOREIGN KEY (patient_id, tenant_id) REFERENCES patients (id, tenant_id),
  ADD CONSTRAINT clinical_notices_kind_check CHECK (kind IN (
    'sigilo_psicologia_alterado', 'perfil_alterado', 'retencao_retirada_pedida', 'retencao_retirada_aprovada',
    'pedido_titular_aberto', 'portal_sigilo_transicao')),
  ADD CONSTRAINT clinical_notices_portal_check CHECK (
    (kind = 'portal_sigilo_transicao') = (patient_id IS NOT NULL)
    AND (kind = 'portal_sigilo_transicao') = (portal_transition IS NOT NULL)),
  ADD CONSTRAINT clinical_notices_shape_check CHECK (
    CASE kind
      WHEN 'sigilo_psicologia_alterado' THEN
        from_mode IS NOT NULL AND to_mode IS NOT NULL
        AND subject_user_id IS NULL AND subject_role IS NULL AND change IS NULL AND legal_hold_id IS NULL
        AND rights_request_id IS NULL
      WHEN 'perfil_alterado' THEN
        from_mode IS NULL AND to_mode IS NULL AND restricted_existing = 0
        AND subject_user_id IS NOT NULL AND subject_role IS NOT NULL AND change IS NOT NULL AND legal_hold_id IS NULL
        AND rights_request_id IS NULL
      WHEN 'pedido_titular_aberto' THEN
        from_mode IS NULL AND to_mode IS NULL AND restricted_existing = 0
        AND subject_user_id IS NULL AND subject_role IS NULL AND change IS NULL AND legal_hold_id IS NULL
        AND rights_request_id IS NOT NULL
      WHEN 'portal_sigilo_transicao' THEN
        from_mode IS NULL AND to_mode IS NULL AND restricted_existing = 0
        AND subject_user_id IS NULL AND subject_role IS NULL AND change IS NULL AND legal_hold_id IS NULL
        AND rights_request_id IS NULL
      ELSE
        from_mode IS NULL AND to_mode IS NULL AND restricted_existing = 0
        AND subject_user_id IS NULL AND subject_role IS NULL AND change IS NULL AND legal_hold_id IS NOT NULL
        AND rights_request_id IS NULL
    END);
CREATE INDEX clinical_notices_patient_idx ON clinical_notices (tenant_id, patient_id) WHERE patient_id IS NOT NULL;

-- Aviso + alerta de UMA transição (interna; só app_portal_sigilo_aplicar chama). Destinatários: admins ativos
-- e profissionais ativos com agenda do paciente (não cancelada/falta) na janela de cuidado da clínica ou
-- futura. O aviso é criado pelo usuário da sessão (o gatilho dos avisos exige created_by = sessão).
CREATE FUNCTION app_portal_sigilo_alertar(p_tenant uuid, p_patient uuid, p_transicao text, p_n integer) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_user  uuid := app_current_user();
  v_dias  integer := (SELECT t.care_link_days FROM tenants t WHERE t.id = p_tenant);
  v_dest  integer;
BEGIN
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
  INSERT INTO audit_log (tenant_id, actor_id, action, scope, metadata)
    VALUES (p_tenant, COALESCE(v_user, '00000000-0000-0000-0000-000000000000'::uuid), 'anomaly_alert', 'portal_links',
            jsonb_build_object('rule', 'portal_sigilo_transicao', 'transition', p_transicao, 'count', p_n, 'notified', v_dest));
END;
$$;
REVOKE ALL ON FUNCTION app_portal_sigilo_alertar(uuid, uuid, text, integer) FROM PUBLIC;

-- Mesma assinatura da 0038. Novidades: guarda os valores de antes na marca (recálculo), reverte com eles
-- (`birth_date_reverted`) e alerta as transições perigosas do recálculo.
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
      -- Sigilo fecha; representação volta ao valor de antes da transação (sem recálculo, o atual já é o de antes).
      v_salvo := v_prev -> r.id::text;
      v_cf := LEAST(COALESCE((v_salvo ->> 0)::date, r.cf), v_hoje);
      v_ru := COALESCE((v_salvo ->> 1)::date, r.ru);
    ELSE
      v_cf := COALESCE(p_cf, LEAST(r.cf, v_hoje));
      v_ru := CASE WHEN p_ru IS NULL THEN LEAST(r.ru, v_hoje) ELSE LEAST(p_ru, COALESCE(r.valid_until, p_ru)) END;
    END IF;
    CONTINUE WHEN v_cf IS NOT DISTINCT FROM r.cf AND v_ru IS NOT DISTINCT FROM r.ru;  -- (R3) nada mudou
    IF p_motivo = 'birth_date_changed' THEN
      -- Valores de antes da transação (o 1º recálculo vence): só na marca interna, apagada no COMMIT.
      UPDATE portal_birth_date_changes
         SET prev_state = jsonb_build_object(r.id::text, jsonb_build_array(r.cf, r.ru)) || prev_state
       WHERE tenant_id = p_tenant AND patient_id = p_patient AND xact = txid_current();
      IF r.cf <= v_hoje AND v_cf > v_hoje THEN
        v_desliga := v_desliga + 1;
      END IF;
      IF r.ru <= v_hoje AND v_ru > r.ru THEN
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

-- ================================================================ conferência final

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS f, p.prosecdef, o.rolname, o.rolsuper, o.rolbypassrls
      FROM pg_proc p JOIN pg_roles o ON o.oid = p.proowner
     WHERE p.oid IN ('app_portal_sigilo_aplicar(uuid,uuid,date,date,text)'::regprocedure,
                     'app_portal_sigilo_alertar(uuid,uuid,text,integer)'::regprocedure,
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
