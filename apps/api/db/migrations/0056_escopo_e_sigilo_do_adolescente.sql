-- 0056 — Escopo da informação clínica ao responsável e pedido de sigilo do adolescente. Fecha a A1 (b) e (c) do
-- parecer do #67 (docs/03-seguranca-lgpd/revisoes/2026-10-20-pr67.md e 2026-10-21-pr67.md, C3). Executar com o
-- papel de MIGRAÇÃO (app_migrator).
--
-- (b) ESCOPO. A marca deixa de ser um booleano único: ligada, ela leva o escopo decidido pelo profissional.
--     - `essencial`: só o estritamente necessário para medidas em benefício do paciente (orientações, cuidados,
--       riscos; CFP art. 13). Padrão protetor.
--     - `integral`: o conteúdo clínico (CEM art. 74: quando o paciente não tem discernimento, ou a não revelação
--       pode causar dano).
--     O escopo só nasce com uma NOVA decisão do profissional e some ao desligar a marca. As marcas já ligadas
--     passam a `essencial` (o mais restrito; a decisão anterior não dizia o escopo).
-- (c) PEDIDO DE SIGILO DO ADOLESCENTE (12 a 17 anos). O adolescente pede que a informação clínica não chegue a
--     um responsável, ou a todos. O profissional com vínculo de cuidado registra (tabela abaixo: só ids e datas,
--     nenhum dado cifrado, nenhum texto). Enquanto o pedido vale, a marca não produz efeito, SALVO RISCO: o
--     profissional toma uma NOVA decisão, depois do pedido, com `clinical_info_risk_override` e a justificativa
--     cifrada da decisão (CEM art. 74, parte final; ECA arts. 13 e 245). O pedido é revogado só a pedido do
--     adolescente, pelo profissional. Aos 18 anos (ou na emancipação) a marca já não vale (regra da 0028).
--     O pedido para um responsável aponta para a PESSOA (`guardian_id`), além do vínculo em que foi feito:
--     encerrar e refazer o vínculo não apaga o sigilo (R3 do parecer de 29/10). Na eliminação da guarda de
--     20 anos, os pedidos do paciente são apagados com os vínculos (art. 16; `app_patient_guardians_eliminate`).
--     A regra de efeito fica no serviço (`informacaoClinica`), como as demais da marca.

-- ---------------------------------------------------------------- (b) escopo e (c) exceção por risco no vínculo

ALTER TABLE patient_guardians
  ADD COLUMN clinical_info_scope text CONSTRAINT patient_guardians_clinical_scope_values_check
    CHECK (clinical_info_scope IS NULL OR clinical_info_scope IN ('essencial', 'integral')),
  ADD COLUMN clinical_info_risk_override boolean NOT NULL DEFAULT false;

-- Marcas já ligadas: escopo mais restrito. Os gatilhos de usuário ficam desligados só neste UPDATE (a migração
-- não tem usuário da sessão, e o preenchimento não é uma decisão nova nem evento do histórico).
-- O runner roda a migração inteira numa transação: se algo falhar, os gatilhos não ficam desligados. A contagem
-- vai para o log do deploy (R7 do parecer de 29/10), já que o preenchimento não entra no histórico.
ALTER TABLE patient_guardians DISABLE TRIGGER USER;
DO $$
DECLARE
  v_n integer;
BEGIN
  UPDATE patient_guardians SET clinical_info_scope = 'essencial' WHERE receives_clinical_info AND clinical_info_scope IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '0056: % marca(s) de informação clínica já ligada(s) passaram ao escopo essencial', v_n;
END;
$$;
ALTER TABLE patient_guardians ENABLE TRIGGER USER;

ALTER TABLE patient_guardians
  ADD CONSTRAINT patient_guardians_clinical_scope_check CHECK (receives_clinical_info = (clinical_info_scope IS NOT NULL)),
  ADD CONSTRAINT patient_guardians_risk_override_check CHECK (NOT clinical_info_risk_override OR receives_clinical_info);

-- Escopo e exceção por risco só mudam junto com uma NOVA decisão do profissional (ligar a marca, ou trocar a
-- justificativa com ela ligada), ou ao desligar a marca. Autor e perfil da decisão: patient_guardians_guard.
CREATE FUNCTION patient_guardians_decision_extras_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND (NEW.clinical_info_scope IS DISTINCT FROM OLD.clinical_info_scope
          OR NEW.clinical_info_risk_override IS DISTINCT FROM OLD.clinical_info_risk_override)
     AND NEW.receives_clinical_info
     AND NOT (NOT OLD.receives_clinical_info OR NEW.clinical_info_basis_enc IS DISTINCT FROM OLD.clinical_info_basis_enc) THEN
    RAISE EXCEPTION 'patient_guardians: escopo e exceção por risco só mudam com uma nova decisão do profissional' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION patient_guardians_decision_extras_guard() FROM PUBLIC;

CREATE TRIGGER patient_guardians_decision_extras_guard
  BEFORE UPDATE ON patient_guardians
  FOR EACH ROW EXECUTE FUNCTION patient_guardians_decision_extras_guard();

-- ---------------------------------------------------------------- (c) pedido de sigilo do adolescente

CREATE TABLE adolescent_confidentiality_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id),
  patient_id       uuid NOT NULL,
  -- null = vale para todos os responsáveis do paciente (inclusive os vinculados depois).
  guardian_link_id uuid,
  -- A pessoa do vínculo: o pedido vale para qualquer vínculo dela com o paciente (refazer o vínculo não o apaga).
  guardian_id      uuid,
  requested_at     timestamptz NOT NULL DEFAULT now(),
  requested_by     uuid NOT NULL,
  revoked_at       timestamptz,
  revoked_by       uuid,
  CONSTRAINT adolescent_confidentiality_requests_patient_fk FOREIGN KEY (patient_id, tenant_id) REFERENCES patients (id, tenant_id),
  CONSTRAINT adolescent_confidentiality_requests_link_fk FOREIGN KEY (guardian_link_id, tenant_id) REFERENCES patient_guardians (id, tenant_id),
  CONSTRAINT adolescent_confidentiality_requests_guardian_fk FOREIGN KEY (guardian_id, tenant_id) REFERENCES guardians (id, tenant_id),
  CONSTRAINT adolescent_confidentiality_requests_target_check CHECK ((guardian_link_id IS NULL) = (guardian_id IS NULL)),
  CONSTRAINT adolescent_confidentiality_requests_revoke_check CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE INDEX adolescent_confidentiality_requests_patient_idx ON adolescent_confidentiality_requests (tenant_id, patient_id);

-- Quem registra e quem revoga: o usuário da sessão, com perfil `profissional` ATIVO na clínica. Datas do banco.
-- O vínculo, quando há, é do MESMO paciente e da MESMA pessoa. Depois de criado, só a revogação (uma vez). Nada se
-- apaga, salvo pela eliminação da guarda de 20 anos (marca transacional `app.guardians_eliminating`, gravada só por
-- `app_patient_guardians_eliminate`; o runtime nem tem DELETE na tabela).
CREATE FUNCTION adolescent_confidentiality_requests_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := app_current_user();
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('app.guardians_eliminating', true) = OLD.tenant_id::text || ':' || OLD.patient_id::text THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'pedido de sigilo do adolescente não se apaga (revogue)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_user IS NULL OR NOT app_user_has_role(v_user, 'profissional') THEN
    RAISE EXCEPTION 'pedido de sigilo do adolescente: só o profissional registra e revoga' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.requested_by IS DISTINCT FROM v_user OR NEW.revoked_at IS NOT NULL OR NEW.revoked_by IS NOT NULL THEN
      RAISE EXCEPTION 'pedido de sigilo do adolescente: nasce vigente e registrado pelo usuário da sessão' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.guardian_link_id IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM patient_guardians g
          WHERE g.tenant_id = NEW.tenant_id AND g.id = NEW.guardian_link_id AND g.patient_id = NEW.patient_id
            AND g.guardian_id = NEW.guardian_id) THEN
      RAISE EXCEPTION 'pedido de sigilo do adolescente: o vínculo tem de ser do mesmo paciente e da mesma pessoa' USING ERRCODE = 'check_violation';
    END IF;
    NEW.requested_at := now();
    RETURN NEW;
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'pedido de sigilo do adolescente: revogado é terminal' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
     OR NEW.guardian_link_id IS DISTINCT FROM OLD.guardian_link_id OR NEW.guardian_id IS DISTINCT FROM OLD.guardian_id
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by OR NEW.revoked_by IS DISTINCT FROM v_user THEN
    RAISE EXCEPTION 'pedido de sigilo do adolescente: só a revogação, pelo usuário da sessão' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.revoked_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION adolescent_confidentiality_requests_guard() FROM PUBLIC;

CREATE TRIGGER adolescent_confidentiality_requests_guard
  BEFORE INSERT OR UPDATE OR DELETE ON adolescent_confidentiality_requests
  FOR EACH ROW EXECUTE FUNCTION adolescent_confidentiality_requests_guard();
CREATE TRIGGER adolescent_confidentiality_requests_no_truncate BEFORE TRUNCATE ON adolescent_confidentiality_requests
  FOR EACH STATEMENT EXECUTE FUNCTION import_reject_mutation();

ALTER TABLE adolescent_confidentiality_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE adolescent_confidentiality_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON adolescent_confidentiality_requests
  USING (tenant_id = (SELECT app_current_tenant())) WITH CHECK (tenant_id = (SELECT app_current_tenant()));
-- O pedido nunca é visto pela sessão do portal (nem pelo responsável, nem pelo titular).
CREATE POLICY portal_fora ON adolescent_confidentiality_requests AS RESTRICTIVE
  USING (tenant_id = (SELECT app_current_tenant()) AND (SELECT app_portal_patient()) IS NULL)
  WITH CHECK (tenant_id = (SELECT app_current_tenant()) AND (SELECT app_portal_patient()) IS NULL);
REVOKE ALL ON adolescent_confidentiality_requests FROM PUBLIC;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON adolescent_confidentiality_requests FROM app_user;
GRANT SELECT, INSERT, UPDATE ON adolescent_confidentiality_requests TO app_user;

-- ---------------------------------------------------------------- eliminação com o prontuário (R3 do parecer de 29/10)

-- Mesma função da 0037 (assinatura, atributos e passos), mais os pedidos de sigilo do paciente, apagados antes dos
-- vínculos que eles referenciam. A marca transacional abre o DELETE só para este paciente desta clínica.
CREATE OR REPLACE FUNCTION app_patient_guardians_eliminate(p_patient uuid) RETURNS TABLE (links_eliminated integer, guardians_discarded integer)
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
  PERFORM * FROM app_whatsapp_patient_eliminate(p_patient);
  PERFORM set_config('app.guardians_eliminating', v_tenant::text || ':' || p_patient::text, true);
  DELETE FROM adolescent_confidentiality_requests WHERE tenant_id = v_tenant AND patient_id = p_patient;
  PERFORM set_config('app.guardians_eliminating', '', true);
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
