-- 0057 — Confirmação de pai/mãe ou tutor de paciente MAIOR no próprio vínculo (R4 do parecer de 29/10/2026 sobre o
-- apoiador, docs/03-seguranca-lgpd/revisoes/2026-10-29-apoiador.md). Executar com o papel de MIGRAÇÃO (app_migrator).
--
-- Antes: a confirmação (`confirmaPacienteMaior`) ficava só na trilha. Um vínculo de pai/mãe ou tutor criado com o
-- paciente sem data de nascimento, ou de um paciente que fez 18 anos depois, continuava vigente sem ninguém revisar.
-- Agora a confirmação fica no vínculo (`adult_confirmed_by`/`adult_confirmed_at`: quem e quando), e a lista de
-- responsáveis acusa a pendência `revisar_pai_mae_tutor_de_maior` enquanto houver, para paciente maior, vínculo
-- vigente de pai/mãe ou tutor sem confirmação. A recepção resolve encerrando o vínculo (ex.: motivo `maioridade`)
-- ou confirmando que ele continua (o vínculo não representa: portal e lembrete já exigem menor).
-- A pendência é calculada no serviço (o banco não lê a data de nascimento cifrada).

ALTER TABLE patient_guardians
  ADD COLUMN adult_confirmed_by uuid,
  ADD COLUMN adult_confirmed_at timestamptz,
  ADD CONSTRAINT patient_guardians_adult_confirmed_pair_check CHECK ((adult_confirmed_by IS NULL) = (adult_confirmed_at IS NULL)),
  ADD CONSTRAINT patient_guardians_adult_confirmed_kind_check CHECK (adult_confirmed_by IS NULL OR kind IN ('pai_mae', 'tutor'));

-- Quem confirma é o usuário da sessão, a data é do banco, e a confirmação só nasce (uma vez) e nunca muda.
CREATE FUNCTION patient_guardians_adult_confirmed_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.adult_confirmed_by IS NOT DISTINCT FROM OLD.adult_confirmed_by
     AND NEW.adult_confirmed_at IS NOT DISTINCT FROM OLD.adult_confirmed_at THEN
    RETURN NEW;
  END IF;
  IF NEW.adult_confirmed_by IS NULL AND NEW.adult_confirmed_at IS NULL THEN
    IF TG_OP = 'UPDATE' THEN
      RAISE EXCEPTION 'patient_guardians: a confirmação de paciente maior não se desfaz' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.adult_confirmed_by IS NOT NULL THEN
    RAISE EXCEPTION 'patient_guardians: a confirmação de paciente maior não muda' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.adult_confirmed_by IS DISTINCT FROM app_current_user() THEN
    RAISE EXCEPTION 'patient_guardians: quem confirma é o usuário da sessão' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.adult_confirmed_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION patient_guardians_adult_confirmed_guard() FROM PUBLIC;

CREATE TRIGGER patient_guardians_adult_confirmed_guard
  BEFORE INSERT OR UPDATE ON patient_guardians
  FOR EACH ROW EXECUTE FUNCTION patient_guardians_adult_confirmed_guard();
