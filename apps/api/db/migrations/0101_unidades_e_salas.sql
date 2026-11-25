-- 0101 — Unidades e salas (HU-NUC-002) e sala sem conflito na agenda (HU-AGD-004).
-- Executar com o papel de MIGRAÇÃO (app_migrator). Ver docs/04-arquitetura/api-dominio.md (Unidades e salas).
--
-- NUMERAÇÃO: 0101 é reservado para não colidir com a pilha aberta (0066–0082) nem com a grade de horários (0100).
-- scripts/migrate.mjs aplica TODO arquivo ainda ausente de schema_migrations, em ordem de nome, então uma
-- migração de número menor que chegue depois desta ainda é aplicada (não há "maior número aplicado").
--
-- - units: unidade da clínica (nome, ativa). rooms: sala da unidade (nome, capacidade, ativa), sempre da MESMA
--   clínica da unidade (FK composta com tenant_id). Nada se apaga: inativar.
-- - appointments.room_id: sala opcional do agendamento, FK composta (room_id, tenant_id) -> rooms: a sala é
--   sempre da mesma clínica do agendamento (MATCH SIMPLE: sem sala, sem conferência).
-- - Conflito de sala (HU-AGD-004): agendamento não cancelado numa sala conta uma vaga em [starts_at, ends_at).
--   Ocupados que se sobrepõem >= capacidade da sala: recusa (SQLSTATE 23P01, constraint
--   appointments_room_conflict). Sala com capacidade 1 = nenhum par sobreposto.
--
-- DECISÃO: gatilho com trava, e não EXCLUDE USING gist (tstzrange &&) com btree_gist. A extensão existe no
-- postgres:16 (contrib) e no RDS, mas a exclusion constraint só expressa "nenhum par sobreposto": não expressa
-- capacidade N > 1 (ginásio, sala de grupo), que é por sala e mora em outra tabela. Um mecanismo só, no banco,
-- para os dois casos: pg_advisory_xact_lock por (clínica, sala) e contagem depois da trava. Em READ COMMITTED
-- (o padrão da API) cada comando do PL/pgSQL tira snapshot novo, então quem esperava a trava enxerga a linha
-- que a outra transação acabou de gravar. A contagem é a mesma da capacidade do profissional (ocupados que se
-- sobrepõem ao intervalo inteiro): conservadora, nunca deixa passar acima da capacidade.
-- Encaixe (is_walk_in) passa da capacidade do PROFISSIONAL, não da sala (a sala é física).
-- Ordem das travas: agenda do profissional (serviço) -> sala (este gatilho) -> audit_chain. Nenhum caminho toma
-- a da sala antes da do profissional, então não há ciclo.

CREATE TABLE units (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  name       text NOT NULL CONSTRAINT units_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 100 AND length(name) <= 100),
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Alvo da FK composta: sala só aponta para unidade da MESMA clínica.
  CONSTRAINT units_id_tenant_key UNIQUE (id, tenant_id)
);
CREATE UNIQUE INDEX units_tenant_name_idx ON units (tenant_id, lower(name));

CREATE TABLE rooms (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants (id),
  unit_id    uuid NOT NULL,
  name       text NOT NULL CONSTRAINT rooms_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 100 AND length(name) <= 100),
  -- Atendimentos simultâneos na sala (1 = sala individual; > 1 = ginásio, sala de grupo).
  capacity   integer NOT NULL DEFAULT 1 CONSTRAINT rooms_capacity_check CHECK (capacity BETWEEN 1 AND 20),
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Alvo da FK composta de appointments: agendamento só aponta para sala da MESMA clínica.
  CONSTRAINT rooms_id_tenant_key UNIQUE (id, tenant_id),
  CONSTRAINT rooms_unit_fk FOREIGN KEY (unit_id, tenant_id) REFERENCES units (id, tenant_id)
);
CREATE UNIQUE INDEX rooms_unit_name_idx ON rooms (tenant_id, unit_id, lower(name));

-- A sala não muda de unidade (o histórico da agenda continuaria apontando para outro lugar): crie outra.
CREATE FUNCTION rooms_unidade_imutavel() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.unit_id IS DISTINCT FROM OLD.unit_id THEN
    RAISE EXCEPTION 'sala não muda de unidade: crie outra' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION rooms_unidade_imutavel() FROM PUBLIC;
CREATE TRIGGER rooms_unidade_imutavel BEFORE UPDATE OF unit_id ON rooms
  FOR EACH ROW EXECUTE FUNCTION rooms_unidade_imutavel();

ALTER TABLE appointments
  ADD COLUMN room_id uuid,
  ADD CONSTRAINT appointments_room_fk FOREIGN KEY (room_id, tenant_id) REFERENCES rooms (id, tenant_id);
CREATE INDEX appointments_room_starts_idx ON appointments (tenant_id, room_id, starts_at) WHERE room_id IS NOT NULL;

CREATE FUNCTION appointments_sala_sem_conflito() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_capacidade integer;
  v_ocupados   integer;
BEGIN
  -- Agendamento que já teve atendimento, falta ou foi cancelado não troca de sala (nem perde a sala).
  IF TG_OP = 'UPDATE' AND NEW.room_id IS DISTINCT FROM OLD.room_id
     AND (OLD.reschedule_locked OR OLD.status IN ('in_progress', 'completed', 'no_show', 'cancelled')) THEN
    RAISE EXCEPTION 'agendamento encerrado ou cancelado não muda de sala' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.room_id IS NULL OR NEW.status = 'cancelled' THEN
    RETURN NEW;
  END IF;
  -- Mudança que não altera a ocupação (ex.: agendado -> confirmado -> chegou): nada a conferir.
  IF TG_OP = 'UPDATE' AND NEW.room_id = OLD.room_id AND NEW.starts_at = OLD.starts_at
     AND NEW.ends_at = OLD.ends_at AND OLD.status <> 'cancelled' THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('sala:' || NEW.tenant_id::text || ':' || NEW.room_id::text, 0));

  -- Sala e unidade ativas (o RLS já restringe à clínica do contexto; a FK composta garante a mesma clínica).
  SELECT r.capacity INTO v_capacidade
    FROM rooms r
    JOIN units u ON u.id = r.unit_id AND u.tenant_id = r.tenant_id
   WHERE r.id = NEW.room_id AND r.tenant_id = NEW.tenant_id AND r.active AND u.active;
  IF v_capacidade IS NULL THEN
    RAISE EXCEPTION 'sala inativa, de unidade inativa ou inexistente'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'appointments_room_active';
  END IF;

  SELECT count(*) INTO v_ocupados
    FROM appointments a
   WHERE a.tenant_id = NEW.tenant_id
     AND a.room_id = NEW.room_id
     AND a.status <> 'cancelled'
     AND a.id <> NEW.id
     AND a.starts_at < NEW.ends_at
     AND a.ends_at > NEW.starts_at;
  IF v_ocupados >= v_capacidade THEN
    RAISE EXCEPTION 'sala ocupada no horário' USING ERRCODE = 'exclusion_violation', CONSTRAINT = 'appointments_room_conflict';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION appointments_sala_sem_conflito() FROM PUBLIC;
CREATE TRIGGER appointments_sala_sem_conflito BEFORE INSERT OR UPDATE OF room_id, starts_at, ends_at, status ON appointments
  FOR EACH ROW EXECUTE FUNCTION appointments_sala_sem_conflito();

-- RLS FORÇADO, policy pelo contexto travado (0003) e fora da sessão do portal (padrão do portal é não ver).
ALTER TABLE units ENABLE ROW LEVEL SECURITY;
ALTER TABLE units FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON units
  USING (tenant_id = (SELECT app_current_tenant()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()));
CREATE POLICY portal_fora ON units AS RESTRICTIVE
  USING (tenant_id = (SELECT app_current_tenant()) AND (SELECT app_portal_patient()) IS NULL)
  WITH CHECK (tenant_id = (SELECT app_current_tenant()) AND (SELECT app_portal_patient()) IS NULL);

ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE rooms FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON rooms
  USING (tenant_id = (SELECT app_current_tenant()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()));
CREATE POLICY portal_fora ON rooms AS RESTRICTIVE
  USING (tenant_id = (SELECT app_current_tenant()) AND (SELECT app_portal_patient()) IS NULL)
  WITH CHECK (tenant_id = (SELECT app_current_tenant()) AND (SELECT app_portal_patient()) IS NULL);

-- Menor privilégio: inativar, nunca apagar.
REVOKE ALL ON units, rooms FROM PUBLIC;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON units, rooms FROM app_user;
GRANT SELECT, INSERT, UPDATE ON units, rooms TO app_user;
