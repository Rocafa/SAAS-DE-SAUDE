-- 0031 — Responsáveis: correções do parecer do Guardião sobre o PR #67 (rodada 19).
-- Executar com o papel de MIGRAÇÃO (app_migrator). Ver docs/04-arquitetura/api-dominio.md §10.
--
-- NUMERAÇÃO: 0029/0030 são de outra branch; 0027 é do portal; 0031 desta rodada.
--
-- V1 (pagador sem retroatividade): o pagador do cadastro é CONGELADO no recebimento. `payments` ganha
--   o vínculo pagador daquele momento e um retrato cifrado (nome + CPF) — a única fonte do recibo tardio
--   e do insumo do Receita Saúde. Trocar/encerrar/anular o pagador depois só vale para recebimentos
--   futuros. O banco confere, no INSERT, que o vínculo é o pagador VIVO do paciente da cobrança (sem
--   pagador próprio na cobrança); o retrato só sai pela retenção fiscal (mesmo prazo do recibo).
-- A1/A2 (sigilo do adolescente): ligar a informação clínica é DECISÃO do profissional (perfil
--   `profissional` no banco), com justificativa cifrada, autor e data gravados pelo banco. A regra por
--   faixa etária (até 11 / 12–17) é aplicada pela API na leitura (data de nascimento cifrada).
-- A3: curatela exige referência da decisão judicial e escopo (cifrados, imutáveis); emancipação no
--   paciente (data + documento cifrado, imutável) e motivo de encerramento `emancipacao`.
-- A4: anulação de cadastro errado com motivo cifrado e prazo de descarte; `app_guardians_discard_run()`
--   descarta a pessoa (nome/CPF/telefone e valores anteriores do histórico) vencido o prazo, sem tocar
--   recibos nem o retrato do pagador nos recebimentos.
-- A7: ciência do paciente adulto quando um terceiro é marcado pagador (autor e data pelo banco).

-- ---------------------------------------------------------------- V1: pagador congelado no recebimento

ALTER TABLE payments
  ADD COLUMN guardian_payer_link_id uuid,
  ADD COLUMN guardian_payer_enc text,
  ADD COLUMN guardian_payer_purged_at timestamptz,
  ADD CONSTRAINT payments_guardian_payer_fk FOREIGN KEY (guardian_payer_link_id, tenant_id) REFERENCES patient_guardians (id, tenant_id),
  ADD CONSTRAINT payments_guardian_payer_sealed_check CHECK (guardian_payer_enc IS NULL OR app_is_sealed_field(guardian_payer_enc)),
  ADD CONSTRAINT payments_guardian_payer_check CHECK (
    (guardian_payer_link_id IS NULL AND guardian_payer_enc IS NULL AND guardian_payer_purged_at IS NULL)
    OR (guardian_payer_link_id IS NOT NULL AND (guardian_payer_enc IS NULL) = (guardian_payer_purged_at IS NOT NULL)));
CREATE INDEX payments_guardian_payer_idx ON payments (tenant_id, guardian_payer_link_id) WHERE guardian_payer_link_id IS NOT NULL;

CREATE FUNCTION payments_guardian_payer_insert() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_ok boolean;
BEGIN
  IF NEW.guardian_payer_link_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.guardian_payer_enc IS NULL OR NEW.guardian_payer_purged_at IS NOT NULL THEN
    RAISE EXCEPTION 'payments: o pagador do cadastro entra com o retrato cifrado' USING ERRCODE = 'check_violation';
  END IF;
  -- O vínculo tem de ser o pagador VIVO do paciente da cobrança AGORA, e a cobrança não pode ter pagador próprio.
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
CREATE TRIGGER payments_guardian_payer_insert BEFORE INSERT ON payments
  FOR EACH ROW EXECUTE FUNCTION payments_guardian_payer_insert();

-- Recebimento continua append-only; a ÚNICA mudança aceita (qualquer papel) é a eliminação do retrato do
-- pagador vencido o prazo fiscal, sem retenção legal do paciente (mesma regra do recibo, 0021).
CREATE FUNCTION payments_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  semRetrato payments;
  v_retido   timestamptz;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'payments é append-only: % não permitido', TG_OP USING ERRCODE = 'insufficient_privilege';
  END IF;
  semRetrato := NEW;
  semRetrato.guardian_payer_enc := OLD.guardian_payer_enc;
  semRetrato.guardian_payer_purged_at := OLD.guardian_payer_purged_at;
  IF semRetrato IS DISTINCT FROM OLD OR OLD.guardian_payer_enc IS NULL OR OLD.guardian_payer_purged_at IS NOT NULL
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
DROP TRIGGER payments_no_update_delete ON payments;
DROP TRIGGER payments_no_truncate ON payments;
CREATE TRIGGER payments_guard BEFORE UPDATE OR DELETE ON payments FOR EACH ROW EXECUTE FUNCTION payments_guard();
CREATE TRIGGER payments_no_truncate BEFORE TRUNCATE ON payments FOR EACH STATEMENT EXECUTE FUNCTION payments_guard();

-- Retenção fiscal: agora também o retrato do pagador nos recebimentos (nova coluna de contagem).
DROP FUNCTION app_fiscal_retention_run();
CREATE FUNCTION app_fiscal_retention_run() RETURNS TABLE (receipts_purged integer, charges_purged integer, payers_purged integer)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_tenant uuid := app_current_tenant();
  v_rec    integer;
  v_chg    integer;
  v_pay    integer;
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
  UPDATE payments p
     SET guardian_payer_enc = NULL, guardian_payer_purged_at = now()
    FROM charges c
    JOIN patients pa ON pa.tenant_id = c.tenant_id AND pa.id = c.patient_id
   WHERE p.tenant_id = v_tenant AND p.guardian_payer_enc IS NOT NULL
     AND c.tenant_id = p.tenant_id AND c.id = p.charge_id
     AND pa.legal_hold_since IS NULL
     AND app_fiscal_deadline(p.received_at) <= app_fiscal_today();
  GET DIAGNOSTICS v_pay = ROW_COUNT;
  RETURN QUERY SELECT v_rec, v_chg, v_pay;
END;
$$;
REVOKE ALL ON FUNCTION app_fiscal_retention_run() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_fiscal_retention_run() TO app_user;

-- ---------------------------------------------------------------- A3: emancipação no paciente

ALTER TABLE patients
  ADD COLUMN emancipated_on date,
  ADD COLUMN emancipation_ref_enc text,
  ADD COLUMN emancipation_recorded_by uuid,
  ADD COLUMN emancipation_recorded_at timestamptz,
  ADD CONSTRAINT patients_emancipation_check CHECK (
    (emancipated_on IS NULL AND emancipation_ref_enc IS NULL AND emancipation_recorded_by IS NULL AND emancipation_recorded_at IS NULL)
    OR (emancipated_on IS NOT NULL AND emancipation_ref_enc IS NOT NULL AND emancipation_recorded_by IS NOT NULL
        AND emancipation_recorded_at IS NOT NULL AND app_is_sealed_field(emancipation_ref_enc)));

CREATE FUNCTION patients_emancipation_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.emancipated_on IS NOT NULL THEN
      RAISE EXCEPTION 'patients: emancipação é registrada depois do cadastro' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.emancipated_on IS NOT NULL THEN
    IF NEW.emancipated_on IS DISTINCT FROM OLD.emancipated_on OR NEW.emancipation_ref_enc IS DISTINCT FROM OLD.emancipation_ref_enc
       OR NEW.emancipation_recorded_by IS DISTINCT FROM OLD.emancipation_recorded_by
       OR NEW.emancipation_recorded_at IS DISTINCT FROM OLD.emancipation_recorded_at THEN
      RAISE EXCEPTION 'patients: emancipação registrada é imutável' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.emancipated_on IS NOT NULL THEN
    IF app_current_user() IS NULL OR NEW.emancipation_recorded_by IS DISTINCT FROM app_current_user() THEN
      RAISE EXCEPTION 'patients: quem registra a emancipação é o usuário da sessão' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.emancipated_on > app_fiscal_today() THEN
      RAISE EXCEPTION 'patients: emancipação não pode ser futura' USING ERRCODE = 'check_violation';
    END IF;
    NEW.emancipation_recorded_at := now();
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER patients_emancipation_guard BEFORE INSERT OR UPDATE ON patients
  FOR EACH ROW EXECUTE FUNCTION patients_emancipation_guard();

-- ---------------------------------------------------------------- vínculo: decisão clínica, curatela, ciência, anulação

ALTER TABLE patient_guardians
  ADD COLUMN clinical_info_decided_by uuid,
  ADD COLUMN clinical_info_decided_at timestamptz,
  ADD COLUMN clinical_info_basis_enc text,
  ADD COLUMN court_decision_ref_enc text,
  ADD COLUMN curatorship_scope_enc text,
  ADD COLUMN payer_patient_aware_by uuid,
  ADD COLUMN payer_patient_aware_at timestamptz,
  ADD COLUMN annul_reason_enc text,
  ADD COLUMN discard_after date,
  ADD CONSTRAINT patient_guardians_sealed_check CHECK (
    (clinical_info_basis_enc IS NULL OR app_is_sealed_field(clinical_info_basis_enc))
    AND (court_decision_ref_enc IS NULL OR app_is_sealed_field(court_decision_ref_enc))
    AND (curatorship_scope_enc IS NULL OR app_is_sealed_field(curatorship_scope_enc))
    AND (annul_reason_enc IS NULL OR app_is_sealed_field(annul_reason_enc))),
  -- Informação clínica ligada = decisão registrada (quem, quando e a justificativa).
  ADD CONSTRAINT patient_guardians_clinical_decision_check CHECK (
    NOT receives_clinical_info
    OR (clinical_info_decided_by IS NOT NULL AND clinical_info_decided_at IS NOT NULL AND clinical_info_basis_enc IS NOT NULL)),
  ADD CONSTRAINT patient_guardians_curatorship_check CHECK (
    kind <> 'curador' OR (court_decision_ref_enc IS NOT NULL AND curatorship_scope_enc IS NOT NULL)),
  ADD CONSTRAINT patient_guardians_aware_check CHECK ((payer_patient_aware_by IS NULL) = (payer_patient_aware_at IS NULL)),
  -- Anulação (cadastro errado): motivo cifrado, prazo de descarte e vigência vazia (nunca vigente).
  ADD CONSTRAINT patient_guardians_annul_check CHECK (
    ((end_reason IS DISTINCT FROM 'cadastro_errado') AND annul_reason_enc IS NULL AND discard_after IS NULL)
    OR (end_reason = 'cadastro_errado' AND annul_reason_enc IS NOT NULL AND discard_after IS NOT NULL AND valid_until = valid_from));

ALTER TABLE patient_guardians DROP CONSTRAINT patient_guardians_end_reason_check;
ALTER TABLE patient_guardians ADD CONSTRAINT patient_guardians_end_reason_check CHECK (end_reason IS NULL OR end_reason IN (
  'maioridade', 'fim_da_representacao', 'decisao_judicial', 'substituido', 'cadastro_errado', 'pedido_do_titular', 'emancipacao'));

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

-- ---------------------------------------------------------------- A4: descarte da pessoa de cadastro errado

ALTER TABLE guardians ADD COLUMN discarded_at timestamptz;
ALTER TABLE guardians ALTER COLUMN name_enc DROP NOT NULL;
ALTER TABLE guardians ADD CONSTRAINT guardians_discard_check CHECK (
  (discarded_at IS NULL AND name_enc IS NOT NULL)
  OR (discarded_at IS NOT NULL AND name_enc IS NULL AND cpf_enc IS NULL AND phone_enc IS NULL));

ALTER TABLE patient_guardian_history DROP CONSTRAINT patient_guardian_history_event_check;
ALTER TABLE patient_guardian_history ADD CONSTRAINT patient_guardian_history_event_check CHECK (event IN (
  'responsavel_criado', 'responsavel_alterado', 'responsavel_descartado', 'vinculo_criado', 'vinculo_alterado', 'vinculo_encerrado'));

-- Pessoa descartável: TODOS os vínculos dela anulados (cadastro errado) com o prazo vencido, e nenhum
-- paciente vinculado sob retenção legal.
CREATE FUNCTION app_guardian_discardable(p_tenant uuid, p_guardian uuid) RETURNS boolean
  LANGUAGE sql
  STABLE
  SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (SELECT 1 FROM patient_guardians v WHERE v.tenant_id = p_tenant AND v.guardian_id = p_guardian)
     AND NOT EXISTS (
       SELECT 1 FROM patient_guardians v
         JOIN patients pa ON pa.tenant_id = v.tenant_id AND pa.id = v.patient_id
        WHERE v.tenant_id = p_tenant AND v.guardian_id = p_guardian
          AND (v.end_reason IS DISTINCT FROM 'cadastro_errado' OR v.discard_after > app_fiscal_today() OR pa.legal_hold_since IS NOT NULL))
$$;
REVOKE ALL ON FUNCTION app_guardian_discardable(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_guardian_discardable(uuid, uuid) TO app_user;

CREATE OR REPLACE FUNCTION guardians_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := app_current_user();
  semDados guardians;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.discarded_at IS NOT NULL THEN
    RAISE EXCEPTION 'guardians: pessoa descartada é terminal' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Descarte (A4 do #67): só apaga os dados, uma vez, vencido o prazo; vale para o job do sistema.
  IF TG_OP = 'UPDATE' AND NEW.discarded_at IS NOT NULL THEN
    semDados := NEW;
    semDados.name_enc := OLD.name_enc;
    semDados.cpf_enc := OLD.cpf_enc;
    semDados.phone_enc := OLD.phone_enc;
    semDados.discarded_at := OLD.discarded_at;
    semDados.updated_at := OLD.updated_at;
    semDados.updated_by := OLD.updated_by;
    IF semDados IS DISTINCT FROM OLD OR NEW.name_enc IS NOT NULL OR NEW.cpf_enc IS NOT NULL OR NEW.phone_enc IS NOT NULL THEN
      RAISE EXCEPTION 'guardians: o descarte só apaga nome, CPF e telefone' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT app_guardian_discardable(OLD.tenant_id, OLD.id) THEN
      RAISE EXCEPTION 'guardians: descarte só de cadastro anulado com o prazo vencido' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    NEW.discarded_at := now();
    NEW.updated_at := now();
    NEW.updated_by := COALESCE(v_user, OLD.updated_by);
    RETURN NEW;
  END IF;
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'responsável: escrita exige o usuário da sessão' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.discarded_at IS NOT NULL THEN
      RAISE EXCEPTION 'guardians: pessoa nasce com dados' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.created_by IS DISTINCT FROM v_user OR NEW.updated_by IS DISTINCT FROM v_user THEN
      RAISE EXCEPTION 'guardians: autor tem de ser o usuário da sessão' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.created_at := now();
    NEW.updated_at := now();
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'guardians: identidade e criação são imutáveis' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.updated_by IS DISTINCT FROM v_user THEN
    RAISE EXCEPTION 'guardians: autor da alteração tem de ser o usuário da sessão' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guardians_history() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_campos text[] := '{}';
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO patient_guardian_history (tenant_id, guardian_id, event, changed_fields, actor_id)
    VALUES (NEW.tenant_id, NEW.id, 'responsavel_criado', '', app_current_user());
    RETURN NULL;
  END IF;
  -- Descarte: registra o evento SEM copiar os valores (que estão sendo eliminados).
  IF NEW.discarded_at IS NOT NULL AND OLD.discarded_at IS NULL THEN
    INSERT INTO patient_guardian_history (tenant_id, guardian_id, event, changed_fields, actor_id)
    VALUES (NEW.tenant_id, NEW.id, 'responsavel_descartado', 'name,cpf,phone',
            COALESCE(app_current_user(), '00000000-0000-0000-0000-000000000000'::uuid));
    RETURN NULL;
  END IF;
  IF NEW.name_enc IS DISTINCT FROM OLD.name_enc THEN v_campos := array_append(v_campos, 'name'); END IF;
  IF NEW.cpf_enc IS DISTINCT FROM OLD.cpf_enc THEN v_campos := array_append(v_campos, 'cpf'); END IF;
  IF NEW.phone_enc IS DISTINCT FROM OLD.phone_enc THEN v_campos := array_append(v_campos, 'phone'); END IF;
  IF cardinality(v_campos) = 0 THEN
    RETURN NULL;
  END IF;
  INSERT INTO patient_guardian_history (tenant_id, guardian_id, event, changed_fields, prev_name_enc, prev_cpf_enc, prev_phone_enc, actor_id)
  VALUES (NEW.tenant_id, NEW.id, 'responsavel_alterado', array_to_string(v_campos, ','),
          CASE WHEN 'name' = ANY (v_campos) THEN OLD.name_enc END,
          CASE WHEN 'cpf' = ANY (v_campos) THEN OLD.cpf_enc END,
          CASE WHEN 'phone' = ANY (v_campos) THEN OLD.phone_enc END,
          app_current_user());
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
  -- O descarte pode vir do job do sistema (sentinela da 0019): autor = sentinela.
  IF NOT (NEW.event = 'responsavel_descartado' AND app_current_user() IS NULL AND app_is_system_session()
          AND NEW.actor_id = '00000000-0000-0000-0000-000000000000'::uuid)
     AND NEW.actor_id IS DISTINCT FROM app_current_user() THEN
    RAISE EXCEPTION 'patient_guardian_history: autor tem de ser o usuário da sessão' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.occurred_at := now();
  RETURN NEW;
END;
$$;

-- Histórico: append-only, salvo apagar os valores ANTERIORES da pessoa já descartada.
CREATE FUNCTION patient_guardian_history_mutation() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  semPrev patient_guardian_history;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'patient_guardian_history é append-only: % não permitido', TG_OP USING ERRCODE = 'insufficient_privilege';
  END IF;
  semPrev := NEW;
  semPrev.prev_name_enc := OLD.prev_name_enc;
  semPrev.prev_cpf_enc := OLD.prev_cpf_enc;
  semPrev.prev_phone_enc := OLD.prev_phone_enc;
  IF semPrev IS DISTINCT FROM OLD OR NEW.prev_name_enc IS NOT NULL OR NEW.prev_cpf_enc IS NOT NULL OR NEW.prev_phone_enc IS NOT NULL
     OR NOT EXISTS (SELECT 1 FROM guardians g WHERE g.tenant_id = OLD.tenant_id AND g.id = OLD.guardian_id AND g.discarded_at IS NOT NULL) THEN
    RAISE EXCEPTION 'patient_guardian_history é append-only: só o descarte dos valores anteriores de pessoa descartada'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER patient_guardian_history_no_update_delete ON patient_guardian_history;
DROP TRIGGER patient_guardian_history_no_truncate ON patient_guardian_history;
CREATE TRIGGER patient_guardian_history_no_update_delete BEFORE UPDATE OR DELETE ON patient_guardian_history
  FOR EACH ROW EXECUTE FUNCTION patient_guardian_history_mutation();
CREATE TRIGGER patient_guardian_history_no_truncate BEFORE TRUNCATE ON patient_guardian_history
  FOR EACH STATEMENT EXECUTE FUNCTION patient_guardian_history_mutation();

-- Execução do descarte na clínica do contexto (rota do admin ou job do sistema). Sem parâmetro de data:
-- o prazo é conferido pelo trigger contra o relógio do banco. Idempotente.
CREATE FUNCTION app_guardians_discard_run() RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_tenant uuid := app_current_tenant();
  v_n      integer;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'descarte exige o contexto de tenant' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE guardians g
     SET name_enc = NULL, cpf_enc = NULL, phone_enc = NULL, discarded_at = now()
   WHERE g.tenant_id = v_tenant AND g.discarded_at IS NULL AND app_guardian_discardable(g.tenant_id, g.id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  UPDATE patient_guardian_history h
     SET prev_name_enc = NULL, prev_cpf_enc = NULL, prev_phone_enc = NULL
    FROM guardians g
   WHERE h.tenant_id = v_tenant AND g.tenant_id = h.tenant_id AND g.id = h.guardian_id AND g.discarded_at IS NOT NULL
     AND (h.prev_name_enc IS NOT NULL OR h.prev_cpf_enc IS NOT NULL OR h.prev_phone_enc IS NOT NULL);
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION app_guardians_discard_run() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_guardians_discard_run() TO app_user;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS f, p.prosecdef, o.rolname, o.rolsuper, o.rolbypassrls
      FROM pg_proc p JOIN pg_roles o ON o.oid = p.proowner
     WHERE p.oid IN ('app_fiscal_retention_run()'::regprocedure, 'app_guardians_discard_run()'::regprocedure)
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
