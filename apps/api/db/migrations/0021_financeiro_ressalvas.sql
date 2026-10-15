-- 0021 — Ressalvas do parecer do Guardião sobre o financeiro (PR #65): R1, R7, R9, R10 e R11.
-- Executar com o papel de MIGRAÇÃO (app_migrator). Ver docs/04-arquitetura/api-dominio.md §9.
--
-- NUMERAÇÃO: 0019 (#61) e 0020 (#63) vêm antes; esta depende da 0016/0019 (app_current_user) e da
-- 0017 (patients.legal_hold_since).
--
-- R1  — Cobrança PF não sai em nome de profissional arbitrário: exige perfil fiscal com CPF; no
--       agendamento, o profissional é o do agendamento; no pacote, ou TODAS as sessões consumidas (≥1)
--       são dele, ou quem lança é o próprio profissional (regra explícita de confirmação).
-- R7  — Retenção fiscal: política parametrizada (proposta: 5 anos contados de 1º/1 do ano seguinte ao
--       pagamento — A CONFIRMAR COM O CONTADOR), função idempotente que elimina o retrato cifrado do
--       recibo e o pagador da cobrança vencido o prazo, salvo paciente sob retenção legal. Os triggers
--       conferem o prazo e a retenção para qualquer papel: nem o runtime nem a função eliminam antes.
-- R9  — paid_cents coerente com os recebimentos: só muda para a soma dos recebimentos não estornados,
--       nasce 0, e na hora do COMMIT cada cobrança tocada por recebimento/estorno confere a soma.
-- R10 — Contador de recibos: nasce em 1 e, no COMMIT, last_number = quantidade = maior número de
--       recibos da clínica (sequência 1..n sem buraco).
-- R11 — search_path fixo nas funções de trigger da 0018.

-- ------------------------------------------------------------------ R11

ALTER FUNCTION finance_reject_mutation() SET search_path = pg_catalog, public;
ALTER FUNCTION receipt_counters_guard() SET search_path = pg_catalog, public;
ALTER FUNCTION receipts_number_guard() SET search_path = pg_catalog, public;
ALTER FUNCTION cash_sessions_guard() SET search_path = pg_catalog, public;
ALTER FUNCTION finance_requires_open_cash() SET search_path = pg_catalog, public;

-- ------------------------------------------------------------------ R1: emitente PF não arbitrário

CREATE FUNCTION charges_emitente_coerente() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.appointment_id IS NOT NULL AND NEW.professional_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM appointments a
        WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.appointment_id AND a.professional_id = NEW.professional_id) THEN
    RAISE EXCEPTION 'cobrança do agendamento é do profissional do agendamento' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.attendance_kind <> 'pf' THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM professional_fiscal_profiles f
        WHERE f.tenant_id = NEW.tenant_id AND f.professional_id = NEW.professional_id AND f.cpf_enc IS NOT NULL) THEN
    RAISE EXCEPTION 'cobrança PF exige perfil fiscal do profissional com CPF' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.package_id IS NOT NULL THEN
    -- Pacote não tem profissional: ou as sessões consumidas (vivas, ≥1) são todas dele, ou é ele quem lança.
    IF NOT (
         (EXISTS (SELECT 1 FROM package_sessions s
                   WHERE s.tenant_id = NEW.tenant_id AND s.package_id = NEW.package_id AND s.reversed_at IS NULL)
          AND NOT EXISTS (
            SELECT 1 FROM package_sessions s
              JOIN appointments a ON a.tenant_id = s.tenant_id AND a.id = s.appointment_id
             WHERE s.tenant_id = NEW.tenant_id AND s.package_id = NEW.package_id AND s.reversed_at IS NULL
               AND a.professional_id <> NEW.professional_id))
         OR EXISTS (SELECT 1 FROM professionals p
                     WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.professional_id AND p.user_id = app_current_user())) THEN
      RAISE EXCEPTION 'cobrança PF de pacote: profissional das sessões do pacote ou o próprio profissional'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER charges_emitente_coerente BEFORE INSERT ON charges
  FOR EACH ROW EXECUTE FUNCTION charges_emitente_coerente();

-- ------------------------------------------------------------------ R9: paid_cents = recebimentos

CREATE FUNCTION app_charge_paid_total(p_tenant uuid, p_charge uuid) RETURNS bigint
  LANGUAGE sql
  STABLE
  SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE(sum(p.amount_cents), 0)::bigint
    FROM payments p
   WHERE p.tenant_id = p_tenant AND p.charge_id = p_charge
     AND NOT EXISTS (SELECT 1 FROM payment_reversals r WHERE r.tenant_id = p.tenant_id AND r.payment_id = p.id)
$$;
REVOKE ALL ON FUNCTION app_charge_paid_total(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_charge_paid_total(uuid, uuid) TO app_user;

CREATE FUNCTION charges_paid_coerente() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.paid_cents <> 0 THEN
      RAISE EXCEPTION 'cobrança nasce sem recebimento (paid_cents = 0)' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.paid_cents IS DISTINCT FROM OLD.paid_cents
        AND NEW.paid_cents <> app_charge_paid_total(NEW.tenant_id, NEW.id) THEN
    RAISE EXCEPTION 'paid_cents só acompanha a soma dos recebimentos não estornados' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER charges_paid_coerente BEFORE INSERT OR UPDATE ON charges
  FOR EACH ROW EXECUTE FUNCTION charges_paid_coerente();

-- No COMMIT: recebimento ou estorno sem o paid_cents correspondente é recusado.
CREATE FUNCTION finance_paid_confere_no_commit() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_charge uuid;
  v_paid   bigint;
BEGIN
  IF TG_TABLE_NAME = 'payments' THEN
    v_charge := NEW.charge_id;
  ELSE
    SELECT p.charge_id INTO v_charge FROM payments p WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.payment_id;
  END IF;
  SELECT c.paid_cents INTO v_paid FROM charges c WHERE c.tenant_id = NEW.tenant_id AND c.id = v_charge;
  IF v_paid IS DISTINCT FROM app_charge_paid_total(NEW.tenant_id, v_charge) THEN
    RAISE EXCEPTION 'recebimento/estorno sem o paid_cents correspondente na cobrança' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER payments_paid_confere AFTER INSERT ON payments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION finance_paid_confere_no_commit();
CREATE CONSTRAINT TRIGGER payment_reversals_paid_confere AFTER INSERT ON payment_reversals
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION finance_paid_confere_no_commit();

-- ------------------------------------------------------------------ R10: contador começa em 1 e não pula

CREATE FUNCTION receipt_counters_inicio() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.last_number <> 1 THEN
    RAISE EXCEPTION 'contador de recibos nasce em 1' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER receipt_counters_inicio BEFORE INSERT ON receipt_counters
  FOR EACH ROW EXECUTE FUNCTION receipt_counters_inicio();

-- No COMMIT: cada número entregue virou recibo (quantidade = maior número = contador): 1..n sem buraco.
CREATE FUNCTION receipt_counters_confere_no_commit() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_ultimo bigint;
  v_qtd    bigint;
  v_max    bigint;
BEGIN
  SELECT last_number INTO v_ultimo FROM receipt_counters WHERE tenant_id = NEW.tenant_id;
  SELECT count(*), COALESCE(max(number), 0) INTO v_qtd, v_max FROM receipts WHERE tenant_id = NEW.tenant_id;
  IF v_ultimo IS DISTINCT FROM v_qtd OR v_ultimo IS DISTINCT FROM v_max THEN
    RAISE EXCEPTION 'numeração de recibos com buraco (contador %, recibos %, maior %)', v_ultimo, v_qtd, v_max
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER receipt_counters_confere AFTER INSERT OR UPDATE ON receipt_counters
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION receipt_counters_confere_no_commit();

-- ------------------------------------------------------------------ R7: retenção fiscal

-- Política da PLATAFORMA (uma linha, sem tenant). O runtime só lê; muda por migração.
CREATE TABLE fiscal_retention_policy (
  id                    boolean PRIMARY KEY DEFAULT true CONSTRAINT fiscal_retention_policy_singleton CHECK (id),
  -- Piso de 5 anos: a política não encurta abaixo do prazo do art. 173 do CTN.
  years                 integer NOT NULL DEFAULT 5 CONSTRAINT fiscal_retention_policy_years_check CHECK (years BETWEEN 5 AND 30),
  start_rule            text NOT NULL DEFAULT 'primeiro_de_janeiro_do_ano_seguinte_ao_pagamento'
                          CONSTRAINT fiscal_retention_policy_start_check CHECK (start_rule = 'primeiro_de_janeiro_do_ano_seguinte_ao_pagamento'),
  accountant_confirmed  boolean NOT NULL DEFAULT false,
  note                  text NOT NULL
);
INSERT INTO fiscal_retention_policy (note)
  VALUES ('PROPOSTA: 5 anos contados de 1º/1 do ano seguinte ao pagamento. A CONFIRMAR COM O CONTADOR (perguntas 24/25).');
REVOKE ALL ON fiscal_retention_policy FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON fiscal_retention_policy FROM app_user;
GRANT SELECT ON fiscal_retention_policy TO app_user;

-- Data (no fuso da clínica) a partir da qual o dado fiscal de um fato em p_quando pode ser eliminado.
CREATE FUNCTION app_fiscal_deadline(p_quando timestamptz) RETURNS date
  LANGUAGE sql
  STABLE
  SET search_path = pg_catalog, public
AS $$
  SELECT make_date(extract(year FROM p_quando AT TIME ZONE 'America/Sao_Paulo')::int + 1 + f.years, 1, 1)
    FROM fiscal_retention_policy f
$$;
REVOKE ALL ON FUNCTION app_fiscal_deadline(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_fiscal_deadline(timestamptz) TO app_user;

-- Hoje no fuso da clínica.
CREATE FUNCTION app_fiscal_today() RETURNS date
  LANGUAGE sql
  STABLE
  SET search_path = pg_catalog, public
AS $$
  SELECT (now() AT TIME ZONE 'America/Sao_Paulo')::date
$$;

ALTER TABLE receipts ADD COLUMN fiscal_purged_at timestamptz;
ALTER TABLE receipts ALTER COLUMN content_enc DROP NOT NULL;
ALTER TABLE receipts DROP CONSTRAINT receipts_content_check;
ALTER TABLE receipts ADD CONSTRAINT receipts_content_check CHECK (
  (content_enc IS NULL AND fiscal_purged_at IS NOT NULL)
  OR (content_enc IS NOT NULL AND fiscal_purged_at IS NULL AND app_is_sealed_field(content_enc)));

ALTER TABLE charges ADD COLUMN fiscal_purged_at timestamptz;
ALTER TABLE charges ADD CONSTRAINT charges_fiscal_purge_check CHECK (
  fiscal_purged_at IS NULL OR (payer_name IS NULL AND payer_cpf_enc IS NULL));

-- Recibo: a ÚNICA mudança aceita (qualquer papel) é a eliminação do retrato vencido o prazo fiscal,
-- sem retenção legal do paciente.
CREATE FUNCTION receipts_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  semConteudo receipts;
  v_pago      timestamptz;
  v_retido    timestamptz;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'receipts é append-only: % não permitido', TG_OP USING ERRCODE = 'insufficient_privilege';
  END IF;
  semConteudo := NEW;
  semConteudo.content_enc := OLD.content_enc;
  semConteudo.fiscal_purged_at := OLD.fiscal_purged_at;
  IF semConteudo IS DISTINCT FROM OLD OR OLD.fiscal_purged_at IS NOT NULL
     OR NEW.content_enc IS NOT NULL OR NEW.fiscal_purged_at IS NULL THEN
    RAISE EXCEPTION 'receipts é append-only: só a eliminação por retenção fiscal' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT p.received_at, pa.legal_hold_since INTO v_pago, v_retido
    FROM payments p
    JOIN charges c ON c.tenant_id = p.tenant_id AND c.id = p.charge_id
    JOIN patients pa ON pa.tenant_id = c.tenant_id AND pa.id = c.patient_id
   WHERE p.tenant_id = OLD.tenant_id AND p.id = OLD.payment_id;
  IF v_retido IS NOT NULL THEN
    RAISE EXCEPTION 'retencao_legal: recibo de paciente sob retenção legal não é eliminado' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF v_pago IS NULL OR app_fiscal_deadline(v_pago) > app_fiscal_today() THEN
    RAISE EXCEPTION 'prazo de retenção fiscal do recibo ainda não venceu' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  NEW.fiscal_purged_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER receipts_no_update_delete ON receipts;
DROP TRIGGER receipts_no_truncate ON receipts;
CREATE TRIGGER receipts_guard BEFORE UPDATE OR DELETE ON receipts
  FOR EACH ROW EXECUTE FUNCTION receipts_guard();
CREATE TRIGGER receipts_no_truncate BEFORE TRUNCATE ON receipts
  FOR EACH STATEMENT EXECUTE FUNCTION receipts_guard();

-- Cobrança: além da 0018, aceita UMA transição a mais — eliminar o pagador vencido o prazo fiscal
-- (cobrança quitada ou cancelada; prazo contado do último recebimento/estorno/cancelamento) e sem
-- retenção legal do paciente.
CREATE OR REPLACE FUNCTION charges_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  semPagador charges;
  v_ref      timestamptz;
  v_retido   timestamptz;
BEGIN
  IF NEW.fiscal_purged_at IS DISTINCT FROM OLD.fiscal_purged_at THEN
    semPagador := NEW;
    semPagador.payer_name := OLD.payer_name;
    semPagador.payer_cpf_enc := OLD.payer_cpf_enc;
    semPagador.fiscal_purged_at := OLD.fiscal_purged_at;
    semPagador.updated_at := OLD.updated_at;
    IF semPagador IS DISTINCT FROM OLD OR OLD.fiscal_purged_at IS NOT NULL OR NEW.fiscal_purged_at IS NULL
       OR NEW.payer_name IS NOT NULL OR NEW.payer_cpf_enc IS NOT NULL THEN
      RAISE EXCEPTION 'eliminação fiscal da cobrança só apaga o pagador, uma vez' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.status = 'open' AND OLD.paid_cents < OLD.amount_cents THEN
      RAISE EXCEPTION 'cobrança em aberto não é eliminada' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    SELECT legal_hold_since INTO v_retido FROM patients WHERE tenant_id = OLD.tenant_id AND id = OLD.patient_id;
    IF v_retido IS NOT NULL THEN
      RAISE EXCEPTION 'retencao_legal: cobrança de paciente sob retenção legal não é eliminada' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    SELECT GREATEST(
             OLD.cancelled_at,
             (SELECT max(p.received_at) FROM payments p WHERE p.tenant_id = OLD.tenant_id AND p.charge_id = OLD.id),
             (SELECT max(r.reversed_at) FROM payment_reversals r JOIN payments p ON p.tenant_id = r.tenant_id AND p.id = r.payment_id
               WHERE p.tenant_id = OLD.tenant_id AND p.charge_id = OLD.id))
      INTO v_ref;
    IF v_ref IS NULL OR app_fiscal_deadline(v_ref) > app_fiscal_today() THEN
      RAISE EXCEPTION 'prazo de retenção fiscal da cobrança ainda não venceu' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    NEW.fiscal_purged_at := now();
    RETURN NEW;
  END IF;
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'cobrança cancelada não muda' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
     OR NEW.appointment_id IS DISTINCT FROM OLD.appointment_id OR NEW.package_id IS DISTINCT FROM OLD.package_id
     OR NEW.professional_id IS DISTINCT FROM OLD.professional_id OR NEW.attendance_kind IS DISTINCT FROM OLD.attendance_kind
     OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents OR NEW.payer_name IS DISTINCT FROM OLD.payer_name
     OR NEW.payer_cpf_enc IS DISTINCT FROM OLD.payer_cpf_enc OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'identidade da cobrança é imutável' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

-- Execução da retenção fiscal na clínica do contexto. Sem parâmetro de data (o prazo é conferido pelos
-- triggers contra now()), idempotente (só o que ainda não foi eliminado) e sem tocar paciente retido.
CREATE FUNCTION app_fiscal_retention_run() RETURNS TABLE (receipts_purged integer, charges_purged integer)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_tenant uuid := app_current_tenant();
  v_rec    integer;
  v_chg    integer;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'retenção fiscal exige o contexto de tenant' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE receipts r
     SET content_enc = NULL, fiscal_purged_at = now()
    FROM payments p
    JOIN charges c ON c.tenant_id = p.tenant_id AND c.id = p.charge_id
    JOIN patients pa ON pa.tenant_id = c.tenant_id AND pa.id = c.patient_id
   WHERE r.tenant_id = v_tenant AND r.fiscal_purged_at IS NULL
     AND p.tenant_id = r.tenant_id AND p.id = r.payment_id
     AND pa.legal_hold_since IS NULL
     AND app_fiscal_deadline(p.received_at) <= app_fiscal_today();
  GET DIAGNOSTICS v_rec = ROW_COUNT;
  UPDATE charges c
     SET payer_name = NULL, payer_cpf_enc = NULL, fiscal_purged_at = now()
    FROM patients pa
   WHERE c.tenant_id = v_tenant AND c.fiscal_purged_at IS NULL
     AND (c.payer_name IS NOT NULL OR c.payer_cpf_enc IS NOT NULL)
     AND (c.status = 'cancelled' OR c.paid_cents >= c.amount_cents)
     AND pa.tenant_id = c.tenant_id AND pa.id = c.patient_id AND pa.legal_hold_since IS NULL
     AND app_fiscal_deadline(GREATEST(
           c.cancelled_at,
           (SELECT max(p.received_at) FROM payments p WHERE p.tenant_id = c.tenant_id AND p.charge_id = c.id),
           (SELECT max(r.reversed_at) FROM payment_reversals r JOIN payments p ON p.tenant_id = r.tenant_id AND p.id = r.payment_id
             WHERE p.tenant_id = c.tenant_id AND p.charge_id = c.id))) <= app_fiscal_today();
  GET DIAGNOSTICS v_chg = ROW_COUNT;
  RETURN QUERY SELECT v_rec, v_chg;
END;
$$;
REVOKE ALL ON FUNCTION app_fiscal_retention_run() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_fiscal_retention_run() TO app_user;

DO $$
DECLARE
  r record;
BEGIN
  SELECT p.prosecdef, o.rolname, o.rolsuper, o.rolbypassrls INTO r
    FROM pg_proc p JOIN pg_roles o ON o.oid = p.proowner
   WHERE p.oid = 'app_fiscal_retention_run()'::regprocedure;
  IF NOT r.prosecdef THEN
    RAISE EXCEPTION 'app_fiscal_retention_run deveria ser SECURITY DEFINER';
  END IF;
  IF r.rolsuper OR r.rolbypassrls OR r.rolname = 'app_user' THEN
    RAISE EXCEPTION 'dono de app_fiscal_retention_run (%) não pode ser superusuário, BYPASSRLS nem o runtime', r.rolname;
  END IF;
END;
$$;
