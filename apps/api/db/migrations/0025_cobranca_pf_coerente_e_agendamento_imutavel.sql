-- 0025 — Cobrança PF de pacote coerente com as sessões e agendamento com profissional/paciente imutáveis
-- (R14 e R15 da re-revisão 2 do Guardião sobre o PR #65).
-- Executar com o papel de MIGRAÇÃO (app_migrator). Ver docs/04-arquitetura/api-dominio.md §9.
--
-- NUMERAÇÃO: 0025 é do #65 (rodada 18); 0026 do importador.
--
-- R14 — REGRA DEFINIDA: a cobrança PF de um pacote tem UM emitente e só cobre sessões DELE.
--   (1) Cobrança PF de pacote (fixado ou não) é recusada se houver sessão VIVA do pacote consumida por
--       agendamento de outro profissional. Fecha (a) "fixar_pacote_antigo" com sessões de X e Y e (b)
--       cancelar, trocar para Y e cobrar PF de Y depois de X ter atendido.
--   (2) "fixar_pacote_antigo" é recusado se houver sessão viva de profissional diferente do novo (fixar
--       em X um pacote que Y atendeu seria declarar algo falso). A troca comum (desligamento, pedido do
--       paciente, lançamento errado) continua possível, porque a regra (1) impede a cobrança PF inexata
--       depois dela; com sessões de dois profissionais o pacote só sai como PJ ou com o estorno das
--       sessões do outro profissional.
--   (3) Consumo: havendo cobrança PF viva do pacote em nome de P, só agendamento de P consome (vale
--       também para pacote não fixado, que antes só era conferido na cobrança).
-- R15 — appointments.professional_id e appointments.patient_id são IMUTÁVEIS para qualquer papel. A API
--   nunca os altera (troca de profissional = cancelar e criar outro agendamento); um SQL injetado que os
--   trocasse depois de consumo, cobrança ou atendimento contornaria os checks que só rodam no INSERT.

-- ---------------------------------------------------------------------------------------------------
-- R15: agendamento não muda de profissional nem de paciente.
CREATE FUNCTION appointments_partes_imutaveis() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.professional_id IS DISTINCT FROM OLD.professional_id OR NEW.patient_id IS DISTINCT FROM OLD.patient_id THEN
    RAISE EXCEPTION 'agendamento não muda de profissional nem de paciente: cancele e crie outro'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER appointments_partes_imutaveis BEFORE UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION appointments_partes_imutaveis();

-- ---------------------------------------------------------------------------------------------------
-- R14 (1): cobrança PF de pacote só com sessões vivas do próprio emitente.
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
  IF NEW.package_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM package_sessions s
         JOIN appointments a ON a.tenant_id = s.tenant_id AND a.id = s.appointment_id
        WHERE s.tenant_id = NEW.tenant_id AND s.package_id = NEW.package_id AND s.reversed_at IS NULL
          AND a.professional_id IS DISTINCT FROM NEW.professional_id) THEN
    RAISE EXCEPTION 'cobrança PF de pacote com sessão viva de outro profissional' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.package_id IS NOT NULL AND v_fixado IS NULL THEN
    -- Pacote sem profissional fixado (regra da 0021): ou há sessão viva (todas dele, conferido acima),
    -- ou é ele quem lança.
    IF NOT (
         EXISTS (SELECT 1 FROM package_sessions s
                  WHERE s.tenant_id = NEW.tenant_id AND s.package_id = NEW.package_id AND s.reversed_at IS NULL)
         OR EXISTS (SELECT 1 FROM professionals p
                     WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.professional_id AND p.user_id = app_current_user())) THEN
      RAISE EXCEPTION 'cobrança PF de pacote: profissional das sessões do pacote ou o próprio profissional'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------------------------------
-- R14 (2): fixar pacote antigo só se as sessões vivas forem todas do novo profissional.
CREATE OR REPLACE FUNCTION session_packages_professional_guard() RETURNS trigger
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
  IF OLD.professional_id IS NULL AND EXISTS (
       SELECT 1 FROM package_sessions s
         JOIN appointments a ON a.tenant_id = s.tenant_id AND a.id = s.appointment_id
        WHERE s.tenant_id = NEW.tenant_id AND s.package_id = NEW.id AND s.reversed_at IS NULL
          AND a.professional_id <> NEW.professional_id) THEN
    RAISE EXCEPTION 'fixar pacote antigo: há sessão viva de outro profissional (estorne-a antes)'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------------------------------
-- R14 (3): consumo coerente com o profissional fixado E com a cobrança PF viva do pacote.
CREATE OR REPLACE FUNCTION package_sessions_professional_check() RETURNS trigger
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
  IF EXISTS (
       SELECT 1 FROM charges ch
         JOIN appointments a ON a.tenant_id = NEW.tenant_id AND a.id = NEW.appointment_id
        WHERE ch.tenant_id = NEW.tenant_id AND ch.package_id = NEW.package_id AND ch.attendance_kind = 'pf'
          AND ch.status <> 'cancelled' AND ch.professional_id IS DISTINCT FROM a.professional_id) THEN
    RAISE EXCEPTION 'pacote com cobrança PF viva de outro profissional: consumo só por agendamento do emitente'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
