-- 0034 — Responsáveis: ressalvas do 2º parecer do Guardião sobre o PR #67 (rodada 19, parecer 21/10).
-- Executar com o papel de MIGRAÇÃO (app_migrator). Ver docs/04-arquitetura/api-dominio.md §10a.
--
-- NUMERAÇÃO: 0032 é do WhatsApp e 0033 do portal (outras branches); 0034 desta rodada.
--
-- R1: anular (cadastro errado) um vínculo que já é o pagador CONGELADO de algum recebimento exige perfil
--     que opera o financeiro (admin, recepção ou financeiro — `financeiro:operar`). O congelado não muda;
--     recibo tardio e insumo do Receita Saúde passam a sair com a pendência `pagador_anulado` (API).
-- R2: saneamento de `pagador_responsavel` — recebimento SEM pagador congelado (ex.: anterior à 0031) ganha
--     o pagador UMA vez, por decisão do financeiro (admin ou financeiro, perfil ativo no banco), via
--     `app_payment_resolve_guardian_payer` (SECURITY DEFINER; o runtime segue sem UPDATE em payments).
--     O banco confere: vínculo do paciente da cobrança, vigente na DATA do recebimento, não anulado,
--     pessoa não descartada; cobrança sem pagador próprio; recebimento não estornado e no prazo fiscal.
--     Quem e quando ficam gravados (`guardian_payer_resolved_by/at`). `pagador_anulado` não se resolve
--     aqui: a correção é estorno e novo recebimento.

-- ---------------------------------------------------------------- R1: anulação de pagador com recebimentos

CREATE OR REPLACE FUNCTION patient_guardians_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := app_current_user();
  v_decide boolean;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'responsável: escrita exige o usuário da sessão' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.created_by IS DISTINCT FROM v_user OR NEW.updated_by IS DISTINCT FROM v_user THEN
      RAISE EXCEPTION 'patient_guardians: autor tem de ser o usuário da sessão' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.ended_at IS NOT NULL THEN
      RAISE EXCEPTION 'patient_guardians: vínculo nasce vigente' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.valid_from > current_date THEN
      RAISE EXCEPTION 'patient_guardians: início da vigência não pode ser futuro' USING ERRCODE = 'check_violation';
    END IF;
    v_decide := NEW.receives_clinical_info;
    IF NOT v_decide AND (NEW.clinical_info_decided_by IS NOT NULL OR NEW.clinical_info_basis_enc IS NOT NULL) THEN
      RAISE EXCEPTION 'patient_guardians: decisão clínica sem a marca' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.payer_patient_aware_by IS NOT NULL OR NEW.payer_patient_aware_at IS NOT NULL THEN
      IF NEW.payer_patient_aware_by IS DISTINCT FROM v_user THEN
        RAISE EXCEPTION 'patient_guardians: quem registra a ciência do paciente é o usuário da sessão' USING ERRCODE = 'insufficient_privilege';
      END IF;
      NEW.payer_patient_aware_at := now();
    END IF;
    NEW.created_at := now();
    NEW.updated_at := now();
  ELSE
    IF OLD.ended_at IS NOT NULL THEN
      RAISE EXCEPTION 'patient_guardians: vínculo encerrado é terminal' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.patient_id IS DISTINCT FROM OLD.patient_id OR NEW.guardian_id IS DISTINCT FROM OLD.guardian_id
       OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
       OR NEW.court_decision_ref_enc IS DISTINCT FROM OLD.court_decision_ref_enc
       OR NEW.curatorship_scope_enc IS DISTINCT FROM OLD.curatorship_scope_enc
       OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
      RAISE EXCEPTION 'patient_guardians: paciente, responsável, tipo, início e curatela são imutáveis (encerre e crie outro)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.updated_by IS DISTINCT FROM v_user THEN
      RAISE EXCEPTION 'patient_guardians: autor da alteração tem de ser o usuário da sessão' USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- Nova decisão = ligar a marca ou trocar a justificativa com a marca ligada. Desligar é livre (fail-safe).
    v_decide := NEW.receives_clinical_info
      AND (NOT OLD.receives_clinical_info OR NEW.clinical_info_basis_enc IS DISTINCT FROM OLD.clinical_info_basis_enc);
    IF NOT v_decide AND (NEW.clinical_info_decided_by IS DISTINCT FROM OLD.clinical_info_decided_by
                         OR NEW.clinical_info_decided_at IS DISTINCT FROM OLD.clinical_info_decided_at
                         OR (NEW.clinical_info_basis_enc IS DISTINCT FROM OLD.clinical_info_basis_enc AND NEW.receives_clinical_info)) THEN
      RAISE EXCEPTION 'patient_guardians: a decisão clínica só muda ao ligar a marca' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.payer_patient_aware_by IS DISTINCT FROM OLD.payer_patient_aware_by OR NEW.payer_patient_aware_at IS DISTINCT FROM OLD.payer_patient_aware_at THEN
      IF NEW.payer_patient_aware_by IS DISTINCT FROM v_user THEN
        RAISE EXCEPTION 'patient_guardians: quem registra a ciência do paciente é o usuário da sessão' USING ERRCODE = 'insufficient_privilege';
      END IF;
      NEW.payer_patient_aware_at := now();
    END IF;
    IF NEW.ended_at IS NOT NULL THEN
      IF NEW.ended_by IS DISTINCT FROM v_user THEN
        RAISE EXCEPTION 'patient_guardians: quem encerra é o usuário da sessão' USING ERRCODE = 'insufficient_privilege';
      END IF;
      IF NEW.valid_until > current_date THEN
        RAISE EXCEPTION 'patient_guardians: encerramento não pode ser futuro' USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.is_payer IS DISTINCT FROM OLD.is_payer OR NEW.receives_clinical_info IS DISTINCT FROM OLD.receives_clinical_info THEN
        RAISE EXCEPTION 'patient_guardians: encerrar não muda as marcas do vínculo' USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.discard_after IS NOT NULL AND NEW.discard_after < app_fiscal_today() THEN
        RAISE EXCEPTION 'patient_guardians: prazo de descarte não pode ser passado' USING ERRCODE = 'check_violation';
      END IF;
      -- R1 do 2º parecer do #67: anular quem já é o pagador congelado de recebimento é ato de quem opera
      -- o financeiro (`financeiro:operar` = admin, recepção ou financeiro; perfis ATIVOS no banco, 0020).
      IF NEW.end_reason = 'cadastro_errado'
         AND EXISTS (SELECT 1 FROM payments p WHERE p.tenant_id = OLD.tenant_id AND p.guardian_payer_link_id = OLD.id)
         AND NOT (app_user_has_role(v_user, 'admin') OR app_user_has_role(v_user, 'recepcao') OR app_user_has_role(v_user, 'financeiro')) THEN
        RAISE EXCEPTION 'patient_guardians: anular pagador com recebimentos exige perfil que opera o financeiro'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
      NEW.ended_at := now();
    END IF;
    NEW.updated_at := now();
  END IF;
  IF v_decide THEN
    -- Só o PROFISSIONAL (perfil no banco, 0020) decide; admin sem perfil clínico, não (A2 do #67).
    IF NOT app_user_has_role(v_user, 'profissional') THEN
      RAISE EXCEPTION 'patient_guardians: só o profissional liga a informação clínica' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.clinical_info_decided_by IS DISTINCT FROM v_user THEN
      RAISE EXCEPTION 'patient_guardians: quem decide é o usuário da sessão' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.clinical_info_decided_at := now();
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------- R2: saneamento do pagador do recebimento

ALTER TABLE payments
  ADD COLUMN guardian_payer_resolved_by uuid,
  ADD COLUMN guardian_payer_resolved_at timestamptz,
  ADD CONSTRAINT payments_guardian_payer_resolved_check CHECK (
    (guardian_payer_resolved_by IS NULL) = (guardian_payer_resolved_at IS NULL)
    AND (guardian_payer_resolved_by IS NULL OR guardian_payer_link_id IS NOT NULL));

-- No INSERT o saneamento não existe (o congelado do recebimento é da 0031).
CREATE OR REPLACE FUNCTION payments_guardian_payer_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_ok boolean;
BEGIN
  IF NEW.guardian_payer_resolved_by IS NOT NULL OR NEW.guardian_payer_resolved_at IS NOT NULL THEN
    RAISE EXCEPTION 'payments: saneamento do pagador não entra no recebimento' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.guardian_payer_link_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.guardian_payer_enc IS NULL OR NEW.guardian_payer_purged_at IS NOT NULL THEN
    RAISE EXCEPTION 'payments: o pagador do cadastro entra com o retrato cifrado' USING ERRCODE = 'check_violation';
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM charges c
      JOIN patient_guardians pg ON pg.tenant_id = c.tenant_id AND pg.patient_id = c.patient_id
     WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.charge_id AND c.payer_name IS NULL
       AND pg.id = NEW.guardian_payer_link_id AND pg.is_payer AND pg.ended_at IS NULL
       AND pg.valid_from <= app_fiscal_today())
    INTO v_ok;
  IF NOT v_ok THEN
    RAISE EXCEPTION 'payments: o vínculo não é o pagador vigente do paciente da cobrança' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- Append-only, salvo DUAS mudanças: (a) saneamento único do pagador (R2) e (b) eliminação do retrato
-- vencido o prazo fiscal (0031). Vale para qualquer papel.
CREATE OR REPLACE FUNCTION payments_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  semRetrato payments;
  v_retido   timestamptz;
  v_user     uuid;
  v_data     date;
  v_ok       boolean;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'payments é append-only: % não permitido', TG_OP USING ERRCODE = 'insufficient_privilege';
  END IF;
  semRetrato := NEW;
  semRetrato.guardian_payer_link_id := OLD.guardian_payer_link_id;
  semRetrato.guardian_payer_enc := OLD.guardian_payer_enc;
  semRetrato.guardian_payer_purged_at := OLD.guardian_payer_purged_at;
  semRetrato.guardian_payer_resolved_by := OLD.guardian_payer_resolved_by;
  semRetrato.guardian_payer_resolved_at := OLD.guardian_payer_resolved_at;
  IF semRetrato IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'payments é append-only: só o saneamento do pagador ou a eliminação do retrato' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- (a) Saneamento (R2 do 2º parecer do #67): sem congelado -> vínculo + retrato, uma única vez.
  IF OLD.guardian_payer_link_id IS NULL THEN
    IF NEW.guardian_payer_link_id IS NULL OR NEW.guardian_payer_enc IS NULL OR NEW.guardian_payer_purged_at IS NOT NULL
       OR OLD.guardian_payer_enc IS NOT NULL OR OLD.guardian_payer_resolved_by IS NOT NULL THEN
      RAISE EXCEPTION 'payments: saneamento grava vínculo e retrato juntos, uma vez' USING ERRCODE = 'insufficient_privilege';
    END IF;
    v_user := app_current_user();
    IF v_user IS NULL OR NEW.guardian_payer_resolved_by IS DISTINCT FROM v_user THEN
      RAISE EXCEPTION 'payments: quem saneia o pagador é o usuário da sessão' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT (app_user_has_role(v_user, 'admin') OR app_user_has_role(v_user, 'financeiro')) THEN
      RAISE EXCEPTION 'payments: saneamento do pagador é do financeiro' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF EXISTS (SELECT 1 FROM payment_reversals r WHERE r.tenant_id = OLD.tenant_id AND r.payment_id = OLD.id) THEN
      RAISE EXCEPTION 'payments: recebimento estornado não é saneado' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF app_fiscal_deadline(OLD.received_at) <= app_fiscal_today() THEN
      RAISE EXCEPTION 'payments: prazo fiscal do recebimento vencido' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    v_data := (OLD.received_at AT TIME ZONE 'America/Sao_Paulo')::date;
    SELECT EXISTS (
      SELECT 1 FROM charges c
        JOIN patient_guardians pg ON pg.tenant_id = c.tenant_id AND pg.patient_id = c.patient_id
        JOIN guardians g ON g.tenant_id = pg.tenant_id AND g.id = pg.guardian_id
       WHERE c.tenant_id = OLD.tenant_id AND c.id = OLD.charge_id AND c.payer_name IS NULL
         AND pg.id = NEW.guardian_payer_link_id
         AND pg.end_reason IS DISTINCT FROM 'cadastro_errado'
         AND pg.valid_from <= v_data AND (pg.valid_until IS NULL OR pg.valid_until > v_data)
         AND g.discarded_at IS NULL)
      INTO v_ok;
    IF NOT v_ok THEN
      RAISE EXCEPTION 'payments: o vínculo não era responsável vigente do paciente na data do recebimento' USING ERRCODE = 'check_violation';
    END IF;
    NEW.guardian_payer_resolved_at := now();
    RETURN NEW;
  END IF;

  -- (b) Eliminação do retrato por retenção fiscal (0031).
  IF NEW.guardian_payer_link_id IS DISTINCT FROM OLD.guardian_payer_link_id
     OR NEW.guardian_payer_resolved_by IS DISTINCT FROM OLD.guardian_payer_resolved_by
     OR NEW.guardian_payer_resolved_at IS DISTINCT FROM OLD.guardian_payer_resolved_at
     OR OLD.guardian_payer_enc IS NULL OR OLD.guardian_payer_purged_at IS NOT NULL
     OR NEW.guardian_payer_enc IS NOT NULL OR NEW.guardian_payer_purged_at IS NULL THEN
    RAISE EXCEPTION 'payments é append-only: só a eliminação do retrato do pagador por retenção fiscal' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT pa.legal_hold_since INTO v_retido
    FROM charges c JOIN patients pa ON pa.tenant_id = c.tenant_id AND pa.id = c.patient_id
   WHERE c.tenant_id = OLD.tenant_id AND c.id = OLD.charge_id;
  IF v_retido IS NOT NULL THEN
    RAISE EXCEPTION 'retencao_legal: recebimento de paciente sob retenção legal não é eliminado' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF app_fiscal_deadline(OLD.received_at) > app_fiscal_today() THEN
    RAISE EXCEPTION 'prazo de retenção fiscal do recebimento ainda não venceu' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  NEW.guardian_payer_purged_at := now();
  RETURN NEW;
END;
$$;

-- O runtime NÃO ganha UPDATE em payments: o saneamento passa por esta função (dona = migração, sem
-- BYPASSRLS; RLS vale pelo contexto de tenant). O trigger acima confere todo o resto.
CREATE FUNCTION app_payment_resolve_guardian_payer(p_payment uuid, p_link uuid, p_enc text) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_tenant uuid := app_current_tenant();
  v_n      integer;
BEGIN
  IF v_tenant IS NULL OR app_current_user() IS NULL THEN
    RAISE EXCEPTION 'saneamento do pagador exige tenant e usuário da sessão' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE payments
     SET guardian_payer_link_id = p_link, guardian_payer_enc = p_enc, guardian_payer_resolved_by = app_current_user()
   WHERE tenant_id = v_tenant AND id = p_payment AND guardian_payer_link_id IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 1;
END;
$$;
REVOKE ALL ON FUNCTION app_payment_resolve_guardian_payer(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_payment_resolve_guardian_payer(uuid, uuid, text) TO app_user;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS f, p.prosecdef, o.rolname, o.rolsuper, o.rolbypassrls
      FROM pg_proc p JOIN pg_roles o ON o.oid = p.proowner
     WHERE p.oid = 'app_payment_resolve_guardian_payer(uuid, uuid, text)'::regprocedure
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
