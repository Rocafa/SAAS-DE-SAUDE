-- 0023 — Profissional fixado na venda do pacote (R13 da re-revisão do Guardião sobre o PR #65).
-- Executar com o papel de MIGRAÇÃO (app_migrator). Ver docs/04-arquitetura/api-dominio.md §9.
--
-- NUMERAÇÃO: 0021 é do financeiro, 0022 do prontuário (#63), 0023 desta rodada do #65; 0024 do importador.
--
-- Problema: o pacote não tinha profissional. A primeira sessão consumida atribuía a cobrança PF do pacote
-- (e o Receita Saúde) ao profissional X, e um consumo posterior por Y deixava o lançamento fiscal inexato.
--
-- 1. session_packages.professional_id (opcional), fixado NA VENDA. Com ele presente:
--    - o consumo só aceita agendamento desse profissional (para qualquer papel);
--    - a cobrança do pacote só sai em nome dele (PF: a recepção já cobra na venda, sem esperar sessão).
--    Sem ele, vale a regra da 0021 (sessões consumidas todas do profissional, ou o próprio lança).
-- 2. Troca do profissional só com registro explícito em package_professional_changes (append-only, com
--    motivo e autor = usuário da sessão) NA MESMA transação; o UPDATE de session_packages sem esse registro
--    é recusado. A troca é recusada enquanto houver cobrança PF viva do pacote em nome de outro profissional
--    (cancele a cobrança antes: o recibo já emitido e o Receita Saúde seguem o profissional da venda).
--    Não se volta a "sem profissional".

ALTER TABLE session_packages
  ADD COLUMN professional_id uuid,
  ADD CONSTRAINT session_packages_professional_fk FOREIGN KEY (professional_id, tenant_id) REFERENCES professionals (id, tenant_id);

CREATE TABLE package_professional_changes (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants (id),
  package_id            uuid NOT NULL,
  -- NULL: pacote antigo (anterior à 0023) que ganha o profissional agora.
  from_professional_id  uuid,
  to_professional_id    uuid NOT NULL,
  reason                text NOT NULL CONSTRAINT package_professional_changes_reason_check
                          CHECK (reason IN ('profissional_desligado', 'pedido_do_paciente', 'lancamento_errado', 'fixar_pacote_antigo')),
  changed_by            uuid NOT NULL,
  changed_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT package_professional_changes_distinct_check CHECK (from_professional_id IS DISTINCT FROM to_professional_id),
  CONSTRAINT package_professional_changes_package_fk FOREIGN KEY (package_id, tenant_id) REFERENCES session_packages (id, tenant_id),
  CONSTRAINT package_professional_changes_from_fk FOREIGN KEY (from_professional_id, tenant_id) REFERENCES professionals (id, tenant_id),
  CONSTRAINT package_professional_changes_to_fk FOREIGN KEY (to_professional_id, tenant_id) REFERENCES professionals (id, tenant_id)
);
CREATE INDEX package_professional_changes_package_idx ON package_professional_changes (tenant_id, package_id, changed_at);
ALTER TABLE package_professional_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE package_professional_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON package_professional_changes
  USING (tenant_id = (SELECT app_current_tenant()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()));
REVOKE UPDATE, DELETE, TRUNCATE ON package_professional_changes FROM app_user;
CREATE TRIGGER package_professional_changes_no_update_delete BEFORE UPDATE OR DELETE ON package_professional_changes
  FOR EACH ROW EXECUTE FUNCTION finance_reject_mutation();
CREATE TRIGGER package_professional_changes_no_truncate BEFORE TRUNCATE ON package_professional_changes
  FOR EACH STATEMENT EXECUTE FUNCTION finance_reject_mutation();

-- O registro da troca: autor = sessão, "de" = profissional atual do pacote, carimbo do banco.
CREATE FUNCTION package_professional_changes_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := app_current_user();
BEGIN
  IF v_user IS NULL OR NEW.changed_by IS DISTINCT FROM v_user THEN
    RAISE EXCEPTION 'troca de profissional do pacote é registrada por quem está na sessão' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM session_packages p
                  WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.package_id
                    AND p.professional_id IS NOT DISTINCT FROM NEW.from_professional_id) THEN
    RAISE EXCEPTION 'troca de profissional: "de" não é o profissional atual do pacote' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF (NEW.from_professional_id IS NULL) <> (NEW.reason = 'fixar_pacote_antigo') THEN
    RAISE EXCEPTION 'fixar_pacote_antigo só vale para pacote sem profissional' USING ERRCODE = 'check_violation';
  END IF;
  NEW.changed_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER package_professional_changes_guard BEFORE INSERT ON package_professional_changes
  FOR EACH ROW EXECUTE FUNCTION package_professional_changes_guard();

-- O profissional do pacote só muda com o registro da troca na mesma transação.
CREATE FUNCTION session_packages_professional_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.professional_id IS NOT DISTINCT FROM OLD.professional_id THEN
    RETURN NEW;
  END IF;
  IF NEW.professional_id IS NULL THEN
    RAISE EXCEPTION 'o pacote não volta a ficar sem profissional' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM package_professional_changes c
        WHERE c.tenant_id = NEW.tenant_id AND c.package_id = NEW.id
          AND c.from_professional_id IS NOT DISTINCT FROM OLD.professional_id
          AND c.to_professional_id = NEW.professional_id
          AND c.changed_by = app_current_user() AND c.changed_at = now()) THEN
    RAISE EXCEPTION 'troca do profissional do pacote exige o registro explícito da troca' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF EXISTS (
       SELECT 1 FROM charges ch
        WHERE ch.tenant_id = NEW.tenant_id AND ch.package_id = NEW.id AND ch.attendance_kind = 'pf'
          AND ch.status <> 'cancelled' AND ch.professional_id IS DISTINCT FROM NEW.professional_id) THEN
    RAISE EXCEPTION 'pacote com cobrança PF viva de outro profissional: cancele a cobrança antes da troca'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER session_packages_professional_guard BEFORE UPDATE OF professional_id ON session_packages
  FOR EACH ROW EXECUTE FUNCTION session_packages_professional_guard();

-- Consumo: só agendamento do profissional do pacote (quando fixado).
CREATE FUNCTION package_sessions_professional_check() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF EXISTS (
       SELECT 1 FROM session_packages p
         JOIN appointments a ON a.tenant_id = NEW.tenant_id AND a.id = NEW.appointment_id
        WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.package_id
          AND p.professional_id IS NOT NULL AND a.professional_id <> p.professional_id) THEN
    RAISE EXCEPTION 'consumo do pacote só por agendamento do profissional do pacote' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER package_sessions_professional_check BEFORE INSERT ON package_sessions
  FOR EACH ROW EXECUTE FUNCTION package_sessions_professional_check();

-- Cobrança: com profissional fixado, a cobrança do pacote é dele (e a PF já pode sair na venda).
CREATE OR REPLACE FUNCTION charges_emitente_coerente() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_fixado uuid;
BEGIN
  IF NEW.appointment_id IS NOT NULL AND NEW.professional_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM appointments a
        WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.appointment_id AND a.professional_id = NEW.professional_id) THEN
    RAISE EXCEPTION 'cobrança do agendamento é do profissional do agendamento' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.package_id IS NOT NULL THEN
    SELECT p.professional_id INTO v_fixado FROM session_packages p WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.package_id;
    IF v_fixado IS NOT NULL AND NEW.professional_id IS NOT NULL AND NEW.professional_id <> v_fixado THEN
      RAISE EXCEPTION 'cobrança do pacote é do profissional fixado na venda' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF NEW.attendance_kind <> 'pf' THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
       SELECT 1 FROM professional_fiscal_profiles f
        WHERE f.tenant_id = NEW.tenant_id AND f.professional_id = NEW.professional_id AND f.cpf_enc IS NOT NULL) THEN
    RAISE EXCEPTION 'cobrança PF exige perfil fiscal do profissional com CPF' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.package_id IS NOT NULL AND v_fixado IS NULL THEN
    -- Pacote sem profissional fixado (regra da 0021): ou as sessões consumidas (vivas, ≥1) são todas dele,
    -- ou é ele quem lança.
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
