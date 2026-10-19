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

-- ---------------------------------------------------------------- R1: o banco amarra o plano aprovado
-- O hash do plano (API) passa a incluir o mapeamento canônico e o SHA-256 do arquivo bruto. Aqui:
-- - mudar column_mapping exige voltar a 'recebido' e zerar simulation_hash (simular de novo);
-- - qualquer UPDATE do lote exige admin da sessão, salvo o formato exato do expurgo (status 'expirado'
--   com o arquivo vencido; raw_discarded_at de NULL para preenchido com o arquivo vencido ou lote encerrado).
CREATE OR REPLACE FUNCTION import_batches_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := app_current_user();
  v_admin boolean := v_user IS NOT NULL AND app_user_has_role(v_user, 'admin');
  permitido boolean;
  so_descarte import_batches;
  so_expurgo import_batches;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.created_at > now() THEN
      RAISE EXCEPTION 'lote não nasce no futuro' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status <> 'recebido' OR NEW.current_run <> 0 OR NEW.applied_at IS NOT NULL OR NEW.raw_discarded_at IS NOT NULL THEN
      RAISE EXCEPTION 'lote nasce recebido' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT v_admin OR NEW.created_by <> v_user THEN
      RAISE EXCEPTION 'só admin da clínica, como usuário da sessão, cria lote de importação' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.kind <> OLD.kind OR NEW.term_version <> OLD.term_version
     OR NEW.term_accepted_by <> OLD.term_accepted_by OR NEW.term_accepted_at <> OLD.term_accepted_at
     OR NEW.created_at <> OLD.created_at OR NEW.created_by <> OLD.created_by OR NEW.byte_size <> OLD.byte_size
     OR NEW.row_count <> OLD.row_count OR NEW.column_count <> OLD.column_count OR NEW.file_format <> OLD.file_format
     OR NEW.raw_expires_at <> OLD.raw_expires_at THEN
    RAISE EXCEPTION 'identidade e termo do lote são imutáveis' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT v_admin THEN
    so_expurgo := NEW;
    so_expurgo.status := OLD.status;
    so_expurgo.expired_at := OLD.expired_at;
    so_expurgo.raw_discarded_at := OLD.raw_discarded_at;
    so_expurgo.updated_at := OLD.updated_at;
    IF so_expurgo IS DISTINCT FROM OLD
       OR (NEW.status IS DISTINCT FROM OLD.status AND NOT (NEW.status = 'expirado' AND OLD.raw_expires_at <= now()))
       OR (NEW.raw_discarded_at IS DISTINCT FROM OLD.raw_discarded_at
           AND NOT (OLD.raw_discarded_at IS NULL
                    AND (OLD.raw_expires_at <= now() OR OLD.status IN ('aplicado', 'desfeito', 'expirado') OR NEW.status = 'expirado'))) THEN
      RAISE EXCEPTION 'só admin da clínica altera o lote de importação' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF NEW.column_mapping IS DISTINCT FROM OLD.column_mapping AND (NEW.status <> 'recebido' OR NEW.simulation_hash IS NOT NULL) THEN
    RAISE EXCEPTION 'mudar o mapeamento volta o lote a recebido e descarta a simulação' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status IN ('desfeito', 'expirado') THEN
    so_descarte := NEW;
    so_descarte.raw_discarded_at := OLD.raw_discarded_at;
    so_descarte.updated_at := OLD.updated_at;
    IF so_descarte IS NOT DISTINCT FROM OLD AND OLD.raw_discarded_at IS NULL AND NEW.raw_discarded_at IS NOT NULL THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'lote % não muda', OLD.status USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF OLD.raw_discarded_at IS NOT NULL AND NEW.raw_discarded_at IS NULL THEN
    RAISE EXCEPTION 'descarte do arquivo bruto não se desfaz' USING ERRCODE = 'insufficient_privilege';
  END IF;
  permitido := CASE OLD.status
    WHEN 'recebido' THEN NEW.status IN ('recebido', 'validado', 'expirado')
    WHEN 'validado' THEN NEW.status IN ('recebido', 'validado', 'simulado', 'expirado')
    WHEN 'simulado' THEN NEW.status IN ('recebido', 'validado', 'simulado', 'aplicado', 'expirado')
    WHEN 'aplicado' THEN NEW.status IN ('aplicado', 'desfeito')
    ELSE false
  END;
  IF NOT permitido THEN
    RAISE EXCEPTION 'transição de lote % -> % não permitida', OLD.status, NEW.status USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF OLD.status <> 'aplicado' AND NEW.status IN ('validado', 'simulado', 'aplicado') AND OLD.raw_discarded_at IS NOT NULL THEN
    RAISE EXCEPTION 'arquivo bruto já descartado' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NEW.status = 'aplicado' AND OLD.status <> 'aplicado' THEN
    IF NOT v_admin OR NEW.applied_by <> v_user THEN
      RAISE EXCEPTION 'só admin da clínica aplica a importação' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.simulation_hash IS DISTINCT FROM OLD.simulation_hash THEN
      RAISE EXCEPTION 'aplicar não muda a simulação aprovada' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF OLD.status = 'aplicado' AND (NEW.applied_at <> OLD.applied_at OR NEW.applied_by <> OLD.applied_by
     OR NEW.simulation_hash IS DISTINCT FROM OLD.simulation_hash OR NEW.created_records IS DISTINCT FROM OLD.created_records
     OR NEW.column_mapping IS DISTINCT FROM OLD.column_mapping) THEN
    RAISE EXCEPTION 'lote aplicado: aplicação é imutável' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status = 'desfeito' AND (NOT v_admin OR NEW.undone_by <> v_user) THEN
    RAISE EXCEPTION 'só admin da clínica desfaz a importação' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.current_run < OLD.current_run THEN
    RAISE EXCEPTION 'rodada de validação só avança' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------- R4: o aceite aponta para o TEXTO do termo
-- term_sha256 = SHA-256 do texto aceito (docs/03-seguranca-lgpd/termo-migracao.md, servido pela API).
-- Obrigatório no lote novo e imutável. (Lotes anteriores à 0026 ficam com NULL: aceitaram versão sem texto.)
ALTER TABLE import_batches
  ADD COLUMN term_sha256 text CONSTRAINT import_batches_term_sha_check CHECK (term_sha256 IS NULL OR term_sha256 ~ '^[0-9a-f]{64}$');

CREATE FUNCTION import_batches_term_text_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.term_sha256 IS NULL THEN
    RAISE EXCEPTION 'aceite do termo exige o hash do texto aceito' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.term_sha256 IS DISTINCT FROM OLD.term_sha256 THEN
    RAISE EXCEPTION 'texto aceito do termo é imutável' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER import_batches_term_text_guard BEFORE INSERT OR UPDATE ON import_batches
  FOR EACH ROW EXECUTE FUNCTION import_batches_term_text_guard();
