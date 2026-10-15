-- 0014 — Remarcação não fabrica nem renova vínculo de cuidado (V2 da re-revisão do Guardião sobre o PR #61).
-- Executar com o papel de MIGRAÇÃO (app_migrator). Ver docs/04-arquitetura/api-dominio.md §"Vínculo de cuidado".
--
-- NUMERAÇÃO: 0011 (guias e pacotes, PR #62) e 0012 (prontuário, PR #63) já estão reservadas.
-- Esta migração só acrescenta colunas e uma tabela nova; não depende delas nem elas desta.
--
-- 1. appointments.rescheduled_by: último usuário que remarcou. A API trata
--    `created_by = usuário OR rescheduled_by = usuário` como AUTOAGENDAMENTO (sem vínculo antes do
--    atendimento efetivo; alerta `vinculo_autoagendado` ao atender). Só muda junto com o horário e
--    nunca volta a NULL (trigger).
-- 2. appointments.reschedule_locked: TRAVA PERMANENTE. Vira true quando o agendamento entra em
--    "em atendimento", "atendido" ou "falta" e não volta a false. Com a trava, o horário não muda
--    mais: a data real do atendimento (ou da falta) não se perde, nem depois de um "Desfazer".
-- 3. appointment_reschedules: histórico append-only de cada remarcação (de -> para, quem, quando),
--    gravado pelo PRÓPRIO banco (trigger) a cada mudança de horário. O runtime não insere direto,
--    não altera e não apaga.
--
-- Linhas antigas: rescheduled_by fica NULL (sem remarcação conhecida) e reschedule_locked = false.
-- O backfill por UPDATE não é possível aqui (RLS FORÇADO vale também para o dono, e a migração não
-- tem contexto de clínica); a trava cobre essas linhas assim que o status passar por clínico/falta,
-- e o trigger já recusa mudar o horário de linha cujo status ATUAL é clínico ou falta.

ALTER TABLE appointments ADD COLUMN rescheduled_by uuid;
ALTER TABLE appointments ADD COLUMN reschedule_locked boolean NOT NULL DEFAULT false;
-- Alvo da FK composta do histórico (mesma clínica).
ALTER TABLE appointments ADD CONSTRAINT appointments_id_tenant_key UNIQUE (id, tenant_id);

CREATE FUNCTION appointments_guarda_remarcacao() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  -- Trava permanente: status clínico ou falta, agora ou antes.
  NEW.reschedule_locked := OLD.reschedule_locked
    OR OLD.status IN ('in_progress', 'completed', 'no_show')
    OR NEW.status IN ('in_progress', 'completed', 'no_show');
  IF NEW.starts_at IS DISTINCT FROM OLD.starts_at OR NEW.ends_at IS DISTINCT FROM OLD.ends_at THEN
    IF NEW.reschedule_locked THEN
      RAISE EXCEPTION 'agendamento que já teve atendimento ou falta não muda de horário'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.rescheduled_by IS NULL THEN
      RAISE EXCEPTION 'remarcação exige rescheduled_by' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.rescheduled_by IS DISTINCT FROM OLD.rescheduled_by THEN
    RAISE EXCEPTION 'appointments.rescheduled_by só muda numa remarcação' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER appointments_guarda_remarcacao
  BEFORE UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION appointments_guarda_remarcacao();

CREATE TABLE appointment_reschedules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  appointment_id  uuid NOT NULL,
  from_starts_at  timestamptz NOT NULL,
  from_ends_at    timestamptz NOT NULL,
  to_starts_at    timestamptz NOT NULL,
  to_ends_at      timestamptz NOT NULL,
  rescheduled_by  uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT appointment_reschedules_appointment_fk FOREIGN KEY (appointment_id, tenant_id)
    REFERENCES appointments (id, tenant_id)
);
CREATE INDEX appointment_reschedules_appointment_idx ON appointment_reschedules (tenant_id, appointment_id, created_at);

ALTER TABLE appointment_reschedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointment_reschedules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON appointment_reschedules
  USING (tenant_id = (SELECT app_current_tenant()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()));

-- Append-only, camada 1: o runtime só lê e (via trigger) insere.
REVOKE UPDATE, DELETE, TRUNCATE ON appointment_reschedules FROM app_user;

-- Camada 2: só o trigger de appointments insere (INSERT direto do runtime é recusado), e ninguém
-- altera nem apaga, nem o dono.
CREATE FUNCTION appointment_reschedules_so_pelo_trigger() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'appointment_reschedules é append-only: % não permitido', TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Profundidade 1 = INSERT direto; 2 = vindo do trigger de appointments.
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'appointment_reschedules só é gravada pela remarcação do agendamento'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER appointment_reschedules_append_only
  BEFORE INSERT OR UPDATE OR DELETE ON appointment_reschedules
  FOR EACH ROW EXECUTE FUNCTION appointment_reschedules_so_pelo_trigger();
CREATE TRIGGER appointment_reschedules_no_truncate
  BEFORE TRUNCATE ON appointment_reschedules
  FOR EACH STATEMENT EXECUTE FUNCTION appointment_reschedules_so_pelo_trigger();

CREATE FUNCTION appointments_historico_remarcacao() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.starts_at IS DISTINCT FROM OLD.starts_at OR NEW.ends_at IS DISTINCT FROM OLD.ends_at THEN
    INSERT INTO appointment_reschedules
      (tenant_id, appointment_id, from_starts_at, from_ends_at, to_starts_at, to_ends_at, rescheduled_by)
    VALUES (OLD.tenant_id, OLD.id, OLD.starts_at, OLD.ends_at, NEW.starts_at, NEW.ends_at, NEW.rescheduled_by);
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER appointments_historico_remarcacao
  AFTER UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION appointments_historico_remarcacao();
