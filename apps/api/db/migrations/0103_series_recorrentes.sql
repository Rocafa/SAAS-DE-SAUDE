-- 0103 — Sessões recorrentes (série de agendamentos), opcionalmente vinculadas a pacote (HU-AGD-008, AGD-02.4).
-- Executar com o papel de MIGRAÇÃO (app_migrator). Ver docs/04-arquitetura/api-dominio.md §5c.
--
-- NUMERAÇÃO: 0103 está reservada para esta frente (0100–0102 estão em outros PRs). O executor (scripts/migrate.mjs)
-- aplica todo arquivo ainda ausente de schema_migrations, em ordem de nome, então a 0103 entra mesmo que as anteriores
-- cheguem à main depois; esta migração só depende de tabelas e funções até a 0027.
--
-- - `appointment_series`: a REGRA da série (dias da semana, horário no fuso da clínica, duração, intervalo em semanas,
--   data inicial e número de sessões OU data final), o paciente, o profissional, o tipo e o pacote opcional. Só ids,
--   datas e números: nenhum texto livre, nenhum dado clínico.
-- - `appointments.series_id` (opcional): o agendamento gerado pela série. A FK composta (série, clínica, paciente,
--   profissional) garante que o agendamento é do MESMO paciente e profissional da série; o vínculo é imutável.
-- - Série não se apaga: cancela-se "a partir de uma data" (`cancelled_from`), que só pode recuar. Os agendamentos são
--   cancelados pela API, um a um, na mesma transação (e auditados).
-- - Pacote: a série só nasce ligada a pacote ATIVO do mesmo paciente (e do mesmo tipo/profissional, quando o pacote os
--   fixa). O saldo é conferido pela API sob a trava do pacote; o consumo continua sendo o de hoje (package_sessions).
-- - RLS FORÇADO, policy pelo contexto travado (app_current_tenant, 0003) e `portal_fora` (o portal não vê a série; vê
--   só os próprios agendamentos, como hoje). O runtime não tem DELETE nem TRUNCATE.
-- - FKs só NO ACTION (R11, 0035): nada se apaga em cascata.

CREATE TABLE appointment_series (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id),
  patient_id          uuid NOT NULL,
  professional_id     uuid NOT NULL,
  appointment_type_id uuid NOT NULL,
  package_id          uuid,
  -- Dias da semana (0 = domingo … 6 = sábado), ao menos um, sem repetição.
  weekdays            smallint[] NOT NULL
                        CONSTRAINT appointment_series_weekdays_check CHECK (
                          cardinality(weekdays) BETWEEN 1 AND 7 AND weekdays <@ ARRAY[0, 1, 2, 3, 4, 5, 6]::smallint[]
                          AND array_position(weekdays, NULL) IS NULL),
  -- 1 = semanal, 2 = quinzenal, … (até 4).
  interval_weeks      smallint NOT NULL DEFAULT 1 CONSTRAINT appointment_series_interval_check CHECK (interval_weeks BETWEEN 1 AND 4),
  -- HH:MM no fuso da clínica (o mesmo formato da API).
  start_time          text NOT NULL CONSTRAINT appointment_series_start_time_check CHECK (start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  duration_minutes    smallint NOT NULL CONSTRAINT appointment_series_duration_check CHECK (duration_minutes BETWEEN 5 AND 480),
  starts_on           date NOT NULL,
  -- Número de sessões OU data final (exatamente um).
  sessions            smallint CONSTRAINT appointment_series_sessions_check CHECK (sessions BETWEEN 1 AND 100),
  ends_on             date,
  created_by          uuid NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  cancelled_from      date,
  cancelled_at        timestamptz,
  cancelled_by        uuid,
  CONSTRAINT appointment_series_end_check CHECK ((sessions IS NULL) <> (ends_on IS NULL)),
  CONSTRAINT appointment_series_ends_on_check CHECK (ends_on IS NULL OR (ends_on >= starts_on AND ends_on <= starts_on + 366)),
  CONSTRAINT appointment_series_cancelled_check CHECK (
    (cancelled_from IS NULL) = (cancelled_at IS NULL) AND (cancelled_at IS NULL) = (cancelled_by IS NULL)),
  CONSTRAINT appointment_series_patient_fk FOREIGN KEY (patient_id, tenant_id) REFERENCES patients (id, tenant_id),
  CONSTRAINT appointment_series_professional_fk FOREIGN KEY (professional_id, tenant_id) REFERENCES professionals (id, tenant_id),
  CONSTRAINT appointment_series_type_fk FOREIGN KEY (appointment_type_id, tenant_id) REFERENCES appointment_types (id, tenant_id),
  CONSTRAINT appointment_series_package_fk FOREIGN KEY (package_id, tenant_id) REFERENCES session_packages (id, tenant_id),
  CONSTRAINT appointment_series_id_tenant_key UNIQUE (id, tenant_id),
  -- Alvo da FK composta de appointments: o agendamento da série é do mesmo paciente e profissional.
  CONSTRAINT appointment_series_parts_key UNIQUE (id, tenant_id, patient_id, professional_id)
);
CREATE INDEX appointment_series_patient_idx ON appointment_series (tenant_id, patient_id, created_at);
CREATE INDEX appointment_series_professional_idx ON appointment_series (tenant_id, professional_id, created_at);
CREATE INDEX appointment_series_package_idx ON appointment_series (tenant_id, package_id) WHERE package_id IS NOT NULL;

-- ---------------------------------------------------------------- guarda das escritas da série

-- INSERT: autor = usuário da sessão (0016) com perfil admin ou recepção (0020); nasce ativa; paciente ATIVO; pacote,
-- se houver, ATIVO, do mesmo paciente e coerente com o tipo/profissional que ele fixa.
-- UPDATE: só o cancelamento "a partir de" (autor = usuário da sessão), que pode recuar a data mas nunca avançar nem
-- voltar a NULL; o resto é imutável. Datas do banco.
CREATE FUNCTION appointment_series_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := app_current_user();
  pkg    session_packages;
BEGIN
  IF v_user IS NULL OR NOT (app_user_has_role(v_user, 'admin') OR app_user_has_role(v_user, 'recepcao')) THEN
    RAISE EXCEPTION 'série de sessões: só recepção ou administrador da clínica' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.created_by IS DISTINCT FROM v_user THEN
      RAISE EXCEPTION 'appointment_series.created_by tem de ser o usuário da sessão' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.cancelled_from IS NOT NULL THEN
      RAISE EXCEPTION 'série nasce ativa' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM patients p WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.patient_id AND p.active) THEN
      RAISE EXCEPTION 'série só para paciente ativo' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.package_id IS NOT NULL THEN
      SELECT * INTO pkg FROM session_packages s WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.package_id;
      IF NOT FOUND OR pkg.status <> 'active' OR pkg.patient_id <> NEW.patient_id
         OR (pkg.appointment_type_id IS NOT NULL AND pkg.appointment_type_id <> NEW.appointment_type_id)
         OR (pkg.professional_id IS NOT NULL AND pkg.professional_id <> NEW.professional_id) THEN
        RAISE EXCEPTION 'série ligada a pacote incompatível' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    NEW.created_at := now();
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'cancelled_from' - 'cancelled_at' - 'cancelled_by')
     IS DISTINCT FROM (to_jsonb(OLD) - 'cancelled_from' - 'cancelled_at' - 'cancelled_by') THEN
    RAISE EXCEPTION 'série é imutável (só se cancela a partir de uma data)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.cancelled_from IS NULL THEN
    IF OLD.cancelled_from IS NOT NULL THEN
      RAISE EXCEPTION 'cancelamento de série não se desfaz' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.cancelled_from IS NOT NULL AND NEW.cancelled_from > OLD.cancelled_from THEN
    RAISE EXCEPTION 'cancelamento de série só recua a data' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.cancelled_from IS DISTINCT FROM OLD.cancelled_from THEN
    IF NEW.cancelled_by IS DISTINCT FROM v_user THEN
      RAISE EXCEPTION 'appointment_series.cancelled_by tem de ser o usuário da sessão' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.cancelled_at := now();
  ELSIF NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at OR NEW.cancelled_by IS DISTINCT FROM OLD.cancelled_by THEN
    RAISE EXCEPTION 'cancelamento de série não se reescreve' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION appointment_series_guard() FROM PUBLIC;
CREATE TRIGGER appointment_series_guard
  BEFORE INSERT OR UPDATE ON appointment_series
  FOR EACH ROW EXECUTE FUNCTION appointment_series_guard();

-- ---------------------------------------------------------------- RLS e privilégios

ALTER TABLE appointment_series ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointment_series FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON appointment_series
  USING (tenant_id = (SELECT app_current_tenant()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()));
-- O portal do paciente não vê nem mexe na série (vê só os próprios agendamentos, como hoje; 0027).
CREATE POLICY portal_fora ON appointment_series AS RESTRICTIVE
  USING (tenant_id = (SELECT app_current_tenant()) AND (SELECT app_portal_patient()) IS NULL)
  WITH CHECK (tenant_id = (SELECT app_current_tenant()) AND (SELECT app_portal_patient()) IS NULL);
REVOKE ALL ON appointment_series FROM PUBLIC;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON appointment_series FROM app_user;
GRANT SELECT, INSERT, UPDATE ON appointment_series TO app_user;

-- ---------------------------------------------------------------- vínculo do agendamento com a série

ALTER TABLE appointments ADD COLUMN series_id uuid;
ALTER TABLE appointments ADD CONSTRAINT appointments_series_fk
  FOREIGN KEY (series_id, tenant_id, patient_id, professional_id)
  REFERENCES appointment_series (id, tenant_id, patient_id, professional_id);
CREATE INDEX appointments_series_idx ON appointments (tenant_id, series_id, starts_at) WHERE series_id IS NOT NULL;

-- O vínculo nasce no INSERT (só em série ATIVA) e não muda depois.
CREATE FUNCTION appointments_series_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.series_id IS DISTINCT FROM OLD.series_id THEN
      RAISE EXCEPTION 'appointments.series_id é imutável' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.series_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM appointment_series s
        WHERE s.tenant_id = NEW.tenant_id AND s.id = NEW.series_id AND s.cancelled_from IS NULL) THEN
    RAISE EXCEPTION 'agendamento só entra em série ativa' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION appointments_series_guard() FROM PUBLIC;
CREATE TRIGGER appointments_series_guard
  BEFORE INSERT OR UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION appointments_series_guard();
