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
-- A4: responsáveis (vínculos, histórico e a pessoa) seguem a GUARDA DO PRONTUÁRIO do paciente (Lei
--     13.787/2018, art. 6º: 20 anos do último registro). `app_patient_record_retention_until` dá a data:
--     último registro do prontuário (cadastro, atendimentos, versões, adendos) OU último evento dos vínculos
--     do paciente (gravado pelo banco, não retroage) + 20 anos. Antes disso nada se elimina (trigger, qualquer
--     papel); depois, `app_patient_guardians_eliminate` (admin ou job; sem retenção legal; vínculos já
--     encerrados) marca os vínculos `eliminated_at`, apaga os campos cifrados deles e descarta a pessoa que
--     não tem mais vínculo em guarda (nome/CPF/telefone e valores anteriores do histórico). O G2 leva
--     `eliminatedAt` e a data de guarda de cada vínculo.

-- ---------------------------------------------------------------- A4: guarda do prontuário (estrutura)

CREATE FUNCTION app_record_retention_years() RETURNS integer
  LANGUAGE sql
  IMMUTABLE
  SET search_path = pg_catalog, public
AS $$ SELECT 20 $$;
REVOKE ALL ON FUNCTION app_record_retention_years() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_record_retention_years() TO app_user;

-- Fim da guarda (fuso da clínica). GREATEST ignora NULL. O último evento dos vínculos entra porque o banco
-- grava `occurred_at` (o runtime não consegue envelhecer o histórico para encurtar a guarda).
CREATE FUNCTION app_patient_record_retention_until(p_tenant uuid, p_patient uuid) RETURNS date
  LANGUAGE sql
  STABLE
  SET search_path = pg_catalog, public
AS $$
  SELECT ((GREATEST(
      (SELECT pa.created_at FROM patients pa WHERE pa.tenant_id = p_tenant AND pa.id = p_patient),
      (SELECT max(GREATEST(e.opened_at, e.updated_at, e.signed_at)) FROM encounters e WHERE e.tenant_id = p_tenant AND e.patient_id = p_patient),
      (SELECT max(v.created_at) FROM clinical_record_versions v
         JOIN encounters e ON e.tenant_id = v.tenant_id AND e.id = v.encounter_id
        WHERE e.tenant_id = p_tenant AND e.patient_id = p_patient),
      (SELECT max(a.created_at) FROM clinical_addenda a
         JOIN encounters e ON e.tenant_id = a.tenant_id AND e.id = a.encounter_id
        WHERE e.tenant_id = p_tenant AND e.patient_id = p_patient),
      (SELECT max(h.occurred_at) FROM patient_guardian_history h
         JOIN patient_guardians v ON v.tenant_id = h.tenant_id AND v.id = h.link_id
        WHERE v.tenant_id = p_tenant AND v.patient_id = p_patient AND h.event <> 'vinculo_eliminado')
    ) AT TIME ZONE 'America/Sao_Paulo')::date + make_interval(years => app_record_retention_years()))::date
$$;
REVOKE ALL ON FUNCTION app_patient_record_retention_until(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_patient_record_retention_until(uuid, uuid) TO app_user;

ALTER TABLE patient_guardians ADD COLUMN eliminated_at timestamptz;
-- Vínculo eliminado perde os campos cifrados (decisão clínica, curatela, motivo da anulação).
ALTER TABLE patient_guardians DROP CONSTRAINT patient_guardians_clinical_decision_check;
ALTER TABLE patient_guardians ADD CONSTRAINT patient_guardians_clinical_decision_check CHECK (
  NOT receives_clinical_info OR eliminated_at IS NOT NULL
  OR (clinical_info_decided_by IS NOT NULL AND clinical_info_decided_at IS NOT NULL AND clinical_info_basis_enc IS NOT NULL));
ALTER TABLE patient_guardians DROP CONSTRAINT patient_guardians_curatorship_check;
ALTER TABLE patient_guardians ADD CONSTRAINT patient_guardians_curatorship_check CHECK (
  kind <> 'curador' OR eliminated_at IS NOT NULL OR (court_decision_ref_enc IS NOT NULL AND curatorship_scope_enc IS NOT NULL));
ALTER TABLE patient_guardians DROP CONSTRAINT patient_guardians_annul_check;
ALTER TABLE patient_guardians ADD CONSTRAINT patient_guardians_annul_check CHECK (
  ((end_reason IS DISTINCT FROM 'cadastro_errado') AND annul_reason_enc IS NULL AND discard_after IS NULL)
  OR (end_reason = 'cadastro_errado' AND (annul_reason_enc IS NOT NULL OR eliminated_at IS NOT NULL)
      AND discard_after IS NOT NULL AND valid_until = valid_from));
ALTER TABLE patient_guardians ADD CONSTRAINT patient_guardians_eliminated_check CHECK (
  eliminated_at IS NULL OR (ended_at IS NOT NULL AND clinical_info_basis_enc IS NULL AND court_decision_ref_enc IS NULL
                            AND curatorship_scope_enc IS NULL AND annul_reason_enc IS NULL));

ALTER TABLE patient_guardian_history DROP CONSTRAINT patient_guardian_history_event_check;
ALTER TABLE patient_guardian_history ADD CONSTRAINT patient_guardian_history_event_check CHECK (event IN (
  'responsavel_criado', 'responsavel_alterado', 'responsavel_descartado', 'vinculo_criado', 'vinculo_alterado',
  'vinculo_encerrado', 'vinculo_eliminado'));

-- ---------------------------------------------------------------- R1: anulação de pagador com recebimentos

CREATE OR REPLACE FUNCTION patient_guardians_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := app_current_user();
  v_decide boolean;
  semDados patient_guardians;
BEGIN
  -- A4 do #67: eliminação do vínculo junto com o prontuário, vencida a guarda de 20 anos (ver abaixo).
  IF TG_OP = 'UPDATE' AND (OLD.eliminated_at IS NOT NULL OR NEW.eliminated_at IS NOT NULL) THEN
    IF OLD.eliminated_at IS NOT NULL THEN
      RAISE EXCEPTION 'patient_guardians: vínculo eliminado é terminal' USING ERRCODE = 'insufficient_privilege';
    END IF;
    semDados := NEW;
    semDados.eliminated_at := OLD.eliminated_at;
    semDados.clinical_info_basis_enc := OLD.clinical_info_basis_enc;
    semDados.court_decision_ref_enc := OLD.court_decision_ref_enc;
    semDados.curatorship_scope_enc := OLD.curatorship_scope_enc;
    semDados.annul_reason_enc := OLD.annul_reason_enc;
    IF semDados IS DISTINCT FROM OLD OR NEW.clinical_info_basis_enc IS NOT NULL OR NEW.court_decision_ref_enc IS NOT NULL
       OR NEW.curatorship_scope_enc IS NOT NULL OR NEW.annul_reason_enc IS NOT NULL THEN
      RAISE EXCEPTION 'patient_guardians: a eliminação só apaga os campos cifrados do vínculo' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT (app_is_system_session() OR (v_user IS NOT NULL AND app_user_has_role(v_user, 'admin'))) THEN
      RAISE EXCEPTION 'patient_guardians: eliminação é do dono da clínica (ou do job do sistema)' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.ended_at IS NULL THEN
      RAISE EXCEPTION 'patient_guardians: vínculo vigente não é eliminado' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF app_patient_under_legal_hold(OLD.tenant_id, OLD.patient_id) THEN
      RAISE EXCEPTION 'retencao_legal: vínculo de paciente sob retenção legal não é eliminado' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF app_patient_record_retention_until(OLD.tenant_id, OLD.patient_id) > app_fiscal_today() THEN
      RAISE EXCEPTION 'patient_guardians: guarda do prontuário do paciente ainda não venceu' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    NEW.eliminated_at := now();
    RETURN NEW;
  END IF;
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

-- ---------------------------------------------------------------- A4: eliminação junto com o prontuário

CREATE OR REPLACE FUNCTION patient_guardians_history() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_campos text[] := '{}';
  v_evento text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_evento := 'vinculo_criado';
  ELSIF NEW.eliminated_at IS NOT NULL AND OLD.eliminated_at IS NULL THEN
    -- A4: evento sem valores; autor = sessão ou sentinela do job do sistema.
    INSERT INTO patient_guardian_history (tenant_id, guardian_id, link_id, event, changed_fields, kind, is_payer,
                                          receives_clinical_info, valid_from, valid_until, end_reason, actor_id)
    VALUES (NEW.tenant_id, NEW.guardian_id, NEW.id, 'vinculo_eliminado', 'eliminated', NEW.kind, NEW.is_payer,
            NEW.receives_clinical_info, NEW.valid_from, NEW.valid_until, NEW.end_reason,
            COALESCE(app_current_user(), '00000000-0000-0000-0000-000000000000'::uuid));
    RETURN NULL;
  ELSE
    IF NEW.is_payer IS DISTINCT FROM OLD.is_payer THEN v_campos := array_append(v_campos, 'is_payer'); END IF;
    IF NEW.receives_clinical_info IS DISTINCT FROM OLD.receives_clinical_info THEN v_campos := array_append(v_campos, 'receives_clinical_info'); END IF;
    IF NEW.clinical_info_basis_enc IS DISTINCT FROM OLD.clinical_info_basis_enc THEN v_campos := array_append(v_campos, 'clinical_info_basis'); END IF;
    IF NEW.payer_patient_aware_at IS DISTINCT FROM OLD.payer_patient_aware_at THEN v_campos := array_append(v_campos, 'payer_patient_aware'); END IF;
    IF NEW.ended_at IS DISTINCT FROM OLD.ended_at THEN v_campos := array_append(v_campos, 'valid_until'); END IF;
    IF NEW.annul_reason_enc IS DISTINCT FROM OLD.annul_reason_enc THEN v_campos := array_append(v_campos, 'annul_reason'); END IF;
    IF cardinality(v_campos) = 0 THEN
      RETURN NULL;
    END IF;
    v_evento := CASE WHEN NEW.ended_at IS NOT NULL THEN 'vinculo_encerrado' ELSE 'vinculo_alterado' END;
  END IF;
  INSERT INTO patient_guardian_history (tenant_id, guardian_id, link_id, event, changed_fields, kind, is_payer,
                                        receives_clinical_info, valid_from, valid_until, end_reason, actor_id)
  VALUES (NEW.tenant_id, NEW.guardian_id, NEW.id, v_evento, array_to_string(v_campos, ','), NEW.kind, NEW.is_payer,
          NEW.receives_clinical_info, NEW.valid_from, NEW.valid_until, NEW.end_reason, app_current_user());
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION patient_guardian_history_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'patient_guardian_history só é gravada pelos triggers do cadastro de responsáveis'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Descarte e eliminação podem vir do job do sistema (sentinela da 0019): autor = sentinela.
  IF NOT (NEW.event IN ('responsavel_descartado', 'vinculo_eliminado') AND app_current_user() IS NULL AND app_is_system_session()
          AND NEW.actor_id = '00000000-0000-0000-0000-000000000000'::uuid)
     AND NEW.actor_id IS DISTINCT FROM app_current_user() THEN
    RAISE EXCEPTION 'patient_guardian_history: autor tem de ser o usuário da sessão' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.occurred_at := now();
  RETURN NEW;
END;
$$;

-- Pessoa descartável: todos os vínculos dela eliminados com o prontuário OU anulados com o prazo vencido,
-- e nenhum paciente vinculado sob retenção legal.
CREATE OR REPLACE FUNCTION app_guardian_discardable(p_tenant uuid, p_guardian uuid) RETURNS boolean
  LANGUAGE sql
  STABLE
  SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (SELECT 1 FROM patient_guardians v WHERE v.tenant_id = p_tenant AND v.guardian_id = p_guardian)
     AND NOT EXISTS (
       SELECT 1 FROM patient_guardians v
         JOIN patients pa ON pa.tenant_id = v.tenant_id AND pa.id = v.patient_id
        WHERE v.tenant_id = p_tenant AND v.guardian_id = p_guardian
          AND (pa.legal_hold_since IS NOT NULL
               OR (v.eliminated_at IS NULL
                   AND (v.end_reason IS DISTINCT FROM 'cadastro_errado' OR v.discard_after > app_fiscal_today()))))
$$;

-- Eliminação dos responsáveis do paciente com o prontuário (rota do admin ou rotina do sistema). Os
-- triggers conferem perfil, vínculo encerrado, retenção legal e guarda; aqui, só o contexto. Idempotente.
CREATE FUNCTION app_patient_guardians_eliminate(p_patient uuid) RETURNS TABLE (links_eliminated integer, guardians_discarded integer)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_tenant uuid := app_current_tenant();
  v_links  integer;
  v_people integer;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'eliminação exige o contexto de tenant' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT (app_is_system_session() OR (app_current_user() IS NOT NULL AND app_user_has_role(app_current_user(), 'admin'))) THEN
    RAISE EXCEPTION 'eliminação é do dono da clínica (ou do job do sistema)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE patient_guardians
     SET eliminated_at = now(), clinical_info_basis_enc = NULL, court_decision_ref_enc = NULL,
         curatorship_scope_enc = NULL, annul_reason_enc = NULL
   WHERE tenant_id = v_tenant AND patient_id = p_patient AND eliminated_at IS NULL;
  GET DIAGNOSTICS v_links = ROW_COUNT;
  UPDATE guardians g
     SET name_enc = NULL, cpf_enc = NULL, phone_enc = NULL, discarded_at = now()
   WHERE g.tenant_id = v_tenant AND g.discarded_at IS NULL
     AND g.id IN (SELECT v.guardian_id FROM patient_guardians v WHERE v.tenant_id = v_tenant AND v.patient_id = p_patient)
     AND app_guardian_discardable(g.tenant_id, g.id);
  GET DIAGNOSTICS v_people = ROW_COUNT;
  UPDATE patient_guardian_history h
     SET prev_name_enc = NULL, prev_cpf_enc = NULL, prev_phone_enc = NULL
    FROM guardians g
   WHERE h.tenant_id = v_tenant AND g.tenant_id = h.tenant_id AND g.id = h.guardian_id AND g.discarded_at IS NOT NULL
     AND (h.prev_name_enc IS NOT NULL OR h.prev_cpf_enc IS NOT NULL OR h.prev_phone_enc IS NOT NULL);
  RETURN QUERY SELECT v_links, v_people;
END;
$$;
REVOKE ALL ON FUNCTION app_patient_guardians_eliminate(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_patient_guardians_eliminate(uuid) TO app_user;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS f, p.prosecdef, o.rolname, o.rolsuper, o.rolbypassrls
      FROM pg_proc p JOIN pg_roles o ON o.oid = p.proowner
     WHERE p.oid = 'app_patient_guardians_eliminate(uuid)'::regprocedure
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
