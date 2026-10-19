-- 0026 — Ressalvas do Guardião sobre o importador (PR #66, rodada 17; correções da rodada 18).
-- Executar com o papel de MIGRAÇÃO (app_migrator). Ver docs/04-arquitetura/api-dominio.md §10.
--
-- NUMERAÇÃO: 0025 é do #65 (rodada 18); esta é a 0026.
--
-- V1 (bloqueante): o desfazer apagava pacientes/agendamentos a partir do livro do lote, que o runtime
--   consegue escrever (um SQL injetado punha um paciente ANTIGO no livro e o desfazer o apagava).
--   Agora:
--   - patients.import_batch_id e appointments.import_batch_id: gravados SÓ no INSERT, e só com o lote da
--     clínica em aplicação (status 'simulado', tipo coerente, admin da sessão); IMUTÁVEIS depois (trigger
--     para qualquer papel). Um registro antigo nunca ganha a marca do lote.
--   - o desfazer (e os motivos de bloqueio) usam SÓ `import_batch_id = lote`; o livro vira proveniência e
--     só aceita registro que exista com a marca do próprio lote.
-- R8: import_reject_mutation() com search_path fixo.

ALTER FUNCTION import_reject_mutation() SET search_path = pg_catalog, public;

-- ---------------------------------------------------------------- V1: marca imutável do lote

ALTER TABLE patients
  ADD COLUMN import_batch_id uuid,
  ADD CONSTRAINT patients_import_batch_fk FOREIGN KEY (import_batch_id, tenant_id) REFERENCES import_batches (id, tenant_id);
CREATE INDEX patients_import_batch_idx ON patients (tenant_id, import_batch_id) WHERE import_batch_id IS NOT NULL;

ALTER TABLE appointments
  ADD COLUMN import_batch_id uuid,
  ADD CONSTRAINT appointments_import_batch_fk FOREIGN KEY (import_batch_id, tenant_id) REFERENCES import_batches (id, tenant_id);
CREATE INDEX appointments_import_batch_idx ON appointments (tenant_id, import_batch_id) WHERE import_batch_id IS NOT NULL;

CREATE FUNCTION import_provenance_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := app_current_user();
  b import_batches;
  esperado text := CASE TG_TABLE_NAME WHEN 'patients' THEN 'pacientes' ELSE 'agenda' END;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.import_batch_id IS DISTINCT FROM OLD.import_batch_id THEN
      RAISE EXCEPTION '%.import_batch_id é imutável', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.import_batch_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO b FROM import_batches WHERE id = NEW.import_batch_id AND tenant_id = NEW.tenant_id;
  IF NOT FOUND OR b.status <> 'simulado' OR b.kind <> esperado THEN
    RAISE EXCEPTION 'marca de lote só em registro criado pelo lote em aplicação' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF v_user IS NULL OR NOT app_user_has_role(v_user, 'admin') THEN
    RAISE EXCEPTION 'só admin da clínica aplica a importação' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER patients_import_provenance_guard BEFORE INSERT OR UPDATE ON patients
  FOR EACH ROW EXECUTE FUNCTION import_provenance_guard();
CREATE TRIGGER appointments_import_provenance_guard BEFORE INSERT OR UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION import_provenance_guard();

-- Livro: só registro que EXISTE com a marca do próprio lote (proveniência coerente).
CREATE OR REPLACE FUNCTION import_batch_records_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  situacao text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'livro do lote é append-only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT status INTO situacao FROM import_batches WHERE id = NEW.batch_id AND tenant_id = NEW.tenant_id;
  IF situacao IS DISTINCT FROM 'simulado' THEN
    RAISE EXCEPTION 'livro só recebe registro de lote em aplicação' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NEW.entity = 'patient' AND NOT EXISTS (
       SELECT 1 FROM patients p WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.record_id AND p.import_batch_id = NEW.batch_id) THEN
    RAISE EXCEPTION 'livro: paciente não foi criado por este lote' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.entity = 'appointment' AND NOT EXISTS (
       SELECT 1 FROM appointments a WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.record_id AND a.import_batch_id = NEW.batch_id) THEN
    RAISE EXCEPTION 'livro: agendamento não foi criado por este lote' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------- V1: desfazer pela marca, nunca pelo livro

CREATE OR REPLACE FUNCTION app_import_batch_blockers(p_batch uuid) RETURNS jsonb
  LANGUAGE sql
  STABLE
  SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH b AS (
    SELECT id, tenant_id, applied_at FROM import_batches WHERE id = p_batch AND tenant_id = app_current_tenant()
  ),
  pac AS (SELECT p.id FROM patients p JOIN b ON p.tenant_id = b.tenant_id AND p.import_batch_id = b.id),
  ag AS (SELECT a.id FROM appointments a JOIN b ON a.tenant_id = b.tenant_id AND a.import_batch_id = b.id)
  SELECT jsonb_build_object(
    'em_atendimento', (SELECT count(*) FROM appointments a, b WHERE a.tenant_id = b.tenant_id AND a.id IN (SELECT id FROM ag)
                         AND a.status NOT IN ('scheduled', 'confirmed', 'cancelled'))
                    + (SELECT count(*) FROM encounters e, b WHERE e.tenant_id = b.tenant_id
                         AND (e.patient_id IN (SELECT id FROM pac) OR e.appointment_id IN (SELECT id FROM ag))),
    'prontuario', (SELECT count(*) FROM private_notes n, b WHERE n.tenant_id = b.tenant_id AND n.patient_id IN (SELECT id FROM pac))
                + (SELECT count(*) FROM legal_holds h, b WHERE h.tenant_id = b.tenant_id AND h.patient_id IN (SELECT id FROM pac))
                + (SELECT count(*) FROM patients p, b WHERE p.tenant_id = b.tenant_id AND p.id IN (SELECT id FROM pac) AND p.legal_hold_since IS NOT NULL),
    'financeiro', (SELECT count(*) FROM charges c, b WHERE c.tenant_id = b.tenant_id
                     AND (c.patient_id IN (SELECT id FROM pac) OR c.appointment_id IN (SELECT id FROM ag)))
                + (SELECT count(*) FROM insurance_guides g, b WHERE g.tenant_id = b.tenant_id AND g.patient_id IN (SELECT id FROM pac))
                + (SELECT count(*) FROM session_packages s, b WHERE s.tenant_id = b.tenant_id AND s.patient_id IN (SELECT id FROM pac))
                + (SELECT count(*) FROM guide_sessions gs, b WHERE gs.tenant_id = b.tenant_id AND gs.appointment_id IN (SELECT id FROM ag))
                + (SELECT count(*) FROM package_sessions ps, b WHERE ps.tenant_id = b.tenant_id AND ps.appointment_id IN (SELECT id FROM ag)),
    'agenda_nova', (SELECT count(*) FROM appointments a, b WHERE a.tenant_id = b.tenant_id AND a.patient_id IN (SELECT id FROM pac)
                      AND a.id NOT IN (SELECT id FROM ag)),
    'alterado_depois', (SELECT count(*) FROM patients p, b WHERE p.tenant_id = b.tenant_id AND p.id IN (SELECT id FROM pac) AND p.updated_at > b.applied_at)
                     + (SELECT count(*) FROM appointments a, b WHERE a.tenant_id = b.tenant_id AND a.id IN (SELECT id FROM ag) AND a.updated_at > b.applied_at)
                     + (SELECT count(*) FROM appointment_reschedules r, b WHERE r.tenant_id = b.tenant_id AND r.appointment_id IN (SELECT id FROM ag))
  )
  FROM b
$$;

CREATE OR REPLACE FUNCTION app_undo_import_batch(p_batch uuid) RETURNS jsonb
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  t uuid := app_current_tenant();
  v_user uuid := app_current_user();
  situacao text;
  motivos jsonb;
  n_ag integer;
  n_pac integer;
BEGIN
  IF t IS NULL OR v_user IS NULL OR NOT app_user_has_role(v_user, 'admin') THEN
    RAISE EXCEPTION 'desfazer exige admin da clínica na sessão' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT status INTO situacao FROM import_batches WHERE id = p_batch AND tenant_id = t FOR UPDATE;
  IF situacao IS DISTINCT FROM 'aplicado' THEN
    RAISE EXCEPTION 'lote não está aplicado' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  motivos := app_import_batch_blockers(p_batch);
  IF EXISTS (SELECT 1 FROM jsonb_each_text(motivos) m WHERE m.value::bigint > 0) THEN
    RAISE EXCEPTION 'importacao_em_uso' USING ERRCODE = 'object_in_use';
  END IF;
  -- SÓ o que nasceu com a marca deste lote (imutável). O livro não decide o que se apaga.
  DELETE FROM appointments WHERE tenant_id = t AND import_batch_id = p_batch;
  GET DIAGNOSTICS n_ag = ROW_COUNT;
  DELETE FROM patients WHERE tenant_id = t AND import_batch_id = p_batch;
  GET DIAGNOSTICS n_pac = ROW_COUNT;
  UPDATE import_batches SET status = 'desfeito', undone_at = now(), undone_by = v_user, updated_at = now()
   WHERE id = p_batch AND tenant_id = t;
  RETURN jsonb_build_object('patients', n_pac, 'appointments', n_ag);
EXCEPTION
  WHEN foreign_key_violation THEN
    RAISE EXCEPTION 'importacao_em_uso' USING ERRCODE = 'object_in_use';
END;
$$;
