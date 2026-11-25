-- 0100 — Grade semanal, bloqueios e feriados da agenda (HU-AGD-001 e HU-AGD-003). Executar com o papel de MIGRAÇÃO
-- (app_migrator).
--
-- Número 0100 reservado: a pilha aberta usa 0066–0082. O executor (scripts/migrate.mjs) aplica todo arquivo ainda
-- ausente de schema_migrations, em ordem de nome, sem exigir sequência contígua; esta migração não depende de nada
-- daquela pilha (só de tenants, professionals, app_current_tenant/app_current_user, app_portal_patient e
-- import_reject_mutation, todos na main).
--
-- * professional_schedules: janelas semanais de atendimento de cada profissional (dia da semana 0 = domingo, início e
--   fim no fuso da clínica, duração padrão do horário). O intervalo de almoço é a falta de janela (08–12 e 14–18).
--   Trocar a grade = desativar as janelas vigentes e inserir as novas (nada se apaga).
-- * schedule_blocks: bloqueio de um profissional (professional_id) ou da clínica inteira (professional_id NULL), num
--   intervalo [starts_at, ends_at). Motivo é lista FECHADA (sem texto livre: nunca leva dado de paciente). Remover =
--   marcar removed_at/removed_by, uma vez.
-- * clinic_holidays: feriados da clínica (nacionais pré-carregados ou da clínica). Um feriado vigente por data.
--   Remover = marcar removed_at/removed_by, uma vez.
-- Nenhuma das três guarda dado de paciente: só ids, horários, datas e nomes de feriado.

-- ---------------------------------------------------------------- grade semanal

CREATE TABLE professional_schedules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  professional_id uuid NOT NULL,
  weekday         smallint NOT NULL CONSTRAINT professional_schedules_weekday_check CHECK (weekday BETWEEN 0 AND 6),
  start_time      time NOT NULL,
  end_time        time NOT NULL,
  slot_minutes    integer NOT NULL CONSTRAINT professional_schedules_slot_check CHECK (slot_minutes BETWEEN 5 AND 480),
  active          boolean NOT NULL DEFAULT true,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT professional_schedules_range_check CHECK (end_time > start_time),
  CONSTRAINT professional_schedules_professional_fk FOREIGN KEY (professional_id, tenant_id) REFERENCES professionals (id, tenant_id)
);
CREATE INDEX professional_schedules_active_idx ON professional_schedules (tenant_id, professional_id, weekday) WHERE active;

-- Nasce ativa e pelo usuário da sessão; depois, só desativar (uma vez). Nada se apaga.
CREATE FUNCTION professional_schedules_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'grade da agenda não se apaga (desative)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT NEW.active OR NEW.created_by IS DISTINCT FROM app_current_user() THEN
      RAISE EXCEPTION 'grade da agenda: nasce ativa e criada pelo usuário da sessão' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.created_at := now();
    RETURN NEW;
  END IF;
  IF NOT OLD.active OR NEW.active
     OR (to_jsonb(NEW) - 'active') IS DISTINCT FROM (to_jsonb(OLD) - 'active') THEN
    RAISE EXCEPTION 'grade da agenda: só a desativação, uma vez' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION professional_schedules_guard() FROM PUBLIC;
CREATE TRIGGER professional_schedules_guard
  BEFORE INSERT OR UPDATE OR DELETE ON professional_schedules
  FOR EACH ROW EXECUTE FUNCTION professional_schedules_guard();
CREATE TRIGGER professional_schedules_no_truncate BEFORE TRUNCATE ON professional_schedules
  FOR EACH STATEMENT EXECUTE FUNCTION import_reject_mutation();

-- ---------------------------------------------------------------- bloqueios

CREATE TABLE schedule_blocks (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  -- NULL = clínica inteira.
  professional_id uuid,
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  reason          text NOT NULL CONSTRAINT schedule_blocks_reason_check
                    CHECK (reason IN ('ferias', 'congresso', 'manutencao', 'reuniao', 'pessoal', 'outro')),
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  removed_by      uuid,
  removed_at      timestamptz,
  CONSTRAINT schedule_blocks_range_check CHECK (ends_at > starts_at AND ends_at <= starts_at + interval '366 days'),
  CONSTRAINT schedule_blocks_removed_check CHECK ((removed_by IS NULL) = (removed_at IS NULL)),
  CONSTRAINT schedule_blocks_professional_fk FOREIGN KEY (professional_id, tenant_id) REFERENCES professionals (id, tenant_id)
);
CREATE INDEX schedule_blocks_range_idx ON schedule_blocks (tenant_id, starts_at, ends_at) WHERE removed_at IS NULL;

-- ---------------------------------------------------------------- feriados

CREATE TABLE clinic_holidays (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  holiday_date date NOT NULL,
  name         text NOT NULL CONSTRAINT clinic_holidays_name_check CHECK (length(name) BETWEEN 1 AND 60),
  source       text NOT NULL CONSTRAINT clinic_holidays_source_check CHECK (source IN ('nacional', 'clinica')),
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  removed_by   uuid,
  removed_at   timestamptz,
  CONSTRAINT clinic_holidays_removed_check CHECK ((removed_by IS NULL) = (removed_at IS NULL))
);
CREATE UNIQUE INDEX clinic_holidays_date_idx ON clinic_holidays (tenant_id, holiday_date) WHERE removed_at IS NULL;

-- Bloqueio e feriado: nascem vigentes e pelo usuário da sessão; depois, só a remoção (uma vez, pelo usuário da
-- sessão, data do banco). Nada se apaga.
CREATE FUNCTION schedule_removable_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := app_current_user();
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '%: não se apaga (remova)', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.created_by IS DISTINCT FROM v_user OR NEW.removed_by IS NOT NULL OR NEW.removed_at IS NOT NULL THEN
      RAISE EXCEPTION '%: nasce vigente e criado pelo usuário da sessão', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.created_at := now();
    RETURN NEW;
  END IF;
  IF OLD.removed_at IS NOT NULL OR NEW.removed_by IS DISTINCT FROM v_user
     OR (to_jsonb(NEW) - 'removed_by' - 'removed_at') IS DISTINCT FROM (to_jsonb(OLD) - 'removed_by' - 'removed_at') THEN
    RAISE EXCEPTION '%: só a remoção, uma vez, pelo usuário da sessão', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.removed_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION schedule_removable_guard() FROM PUBLIC;
CREATE TRIGGER schedule_blocks_guard
  BEFORE INSERT OR UPDATE OR DELETE ON schedule_blocks
  FOR EACH ROW EXECUTE FUNCTION schedule_removable_guard();
CREATE TRIGGER schedule_blocks_no_truncate BEFORE TRUNCATE ON schedule_blocks
  FOR EACH STATEMENT EXECUTE FUNCTION import_reject_mutation();
CREATE TRIGGER clinic_holidays_guard
  BEFORE INSERT OR UPDATE OR DELETE ON clinic_holidays
  FOR EACH ROW EXECUTE FUNCTION schedule_removable_guard();
CREATE TRIGGER clinic_holidays_no_truncate BEFORE TRUNCATE ON clinic_holidays
  FOR EACH STATEMENT EXECUTE FUNCTION import_reject_mutation();

-- ---------------------------------------------------------------- RLS (padrão da 0059) e privilégios

ALTER TABLE professional_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE professional_schedules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON professional_schedules
  USING (tenant_id = (SELECT app_current_tenant())) WITH CHECK (tenant_id = (SELECT app_current_tenant()));
CREATE POLICY portal_fora ON professional_schedules AS RESTRICTIVE
  USING (tenant_id = (SELECT app_current_tenant()) AND (SELECT app_portal_patient()) IS NULL)
  WITH CHECK (tenant_id = (SELECT app_current_tenant()) AND (SELECT app_portal_patient()) IS NULL);

ALTER TABLE schedule_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_blocks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON schedule_blocks
  USING (tenant_id = (SELECT app_current_tenant())) WITH CHECK (tenant_id = (SELECT app_current_tenant()));
CREATE POLICY portal_fora ON schedule_blocks AS RESTRICTIVE
  USING (tenant_id = (SELECT app_current_tenant()) AND (SELECT app_portal_patient()) IS NULL)
  WITH CHECK (tenant_id = (SELECT app_current_tenant()) AND (SELECT app_portal_patient()) IS NULL);

ALTER TABLE clinic_holidays ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinic_holidays FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON clinic_holidays
  USING (tenant_id = (SELECT app_current_tenant())) WITH CHECK (tenant_id = (SELECT app_current_tenant()));
CREATE POLICY portal_fora ON clinic_holidays AS RESTRICTIVE
  USING (tenant_id = (SELECT app_current_tenant()) AND (SELECT app_portal_patient()) IS NULL)
  WITH CHECK (tenant_id = (SELECT app_current_tenant()) AND (SELECT app_portal_patient()) IS NULL);

REVOKE ALL ON professional_schedules, schedule_blocks, clinic_holidays FROM PUBLIC;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON professional_schedules, schedule_blocks, clinic_holidays FROM app_user;
GRANT SELECT, INSERT, UPDATE ON professional_schedules, schedule_blocks, clinic_holidays TO app_user;
