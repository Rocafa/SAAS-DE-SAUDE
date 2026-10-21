-- 0034 — Responsáveis: ressalvas do 2º parecer do Guardião sobre o PR #67 (rodada 19, parecer 21/10).
-- Executar com o papel de MIGRAÇÃO (app_migrator). Ver docs/04-arquitetura/api-dominio.md §10a.
--
-- NUMERAÇÃO: 0032 é do WhatsApp e 0033 do portal (outras branches); 0034 desta rodada.
--
-- R1: anular (cadastro errado) um vínculo que já é o pagador CONGELADO de algum recebimento exige perfil
--     que opera o financeiro (admin, recepção ou financeiro — `financeiro:operar`). O congelado não muda;
--     recibo tardio e insumo do Receita Saúde passam a sair com a pendência `pagador_anulado` (API).

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
