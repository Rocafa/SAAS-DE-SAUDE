-- 0024 — Importador de planilha para clínicas que trocam de sistema (rodada 17.3; MIG-01.1, MIG-01.2,
-- MIG-02.1, MIG-02.2 e a parte técnica de MIG-02.4; HU-MIG-001/002/006; garantia G8).
-- Executar com o papel de MIGRAÇÃO (app_migrator). Ver docs/04-arquitetura/api-dominio.md §10.
--
-- NUMERAÇÃO: 0022/0023 são das ressalvas de #63/#65 (rodada 17); esta é a 0024 e não depende delas.
--
-- Fluxo: recebido -> validado -> simulado -> aplicado -> desfeito; recebido/validado/simulado -> expirado.
-- - import_batches: o lote (tipo pacientes|agenda), o ACEITE DO TERMO DE MIGRAÇÃO (versão, quem, quando),
--   o mapeamento de colunas (campo -> ÍNDICE da coluna; nunca o texto do cabeçalho, que numa planilha sem
--   cabeçalho seria a primeira linha de dados), contagens, hash da simulação aprovada e as datas de cada
--   etapa. Só ADMIN ativo da clínica (clinic_members, 0020) cria, aplica e desfaz: o banco confere.
-- - import_raw_files: o ARQUIVO BRUTO, SÓ cifrado com a chave da clínica (formato v1 do FieldCipher,
--   AAD = clínica + tabela + coluna + lote), com expiração em no máximo 7 dias (CHECK). O runtime só lê e
--   insere: nem UPDATE nem DELETE. O descarte é da função app_purge_import_raw_files() (SECURITY DEFINER,
--   idempotente), chamada ao aplicar e pela rotina diária; ela deixa a evidência em raw_discarded_at.
-- - import_issues: divergências por linha, SÓ código (linha, campo, código, gravidade), nunca o valor.
--   Uma rodada por validação/simulação (`run`); a função de expurgo apaga as rodadas antigas.
-- - import_batch_records: livro do lote (entidade, id criado, linha), base do DESFAZER e da proveniência.
-- - Desfazer: app_undo_import_batch(lote) (SECURITY DEFINER) apaga o que o lote criou SÓ se nada foi usado
--   (atendimento, prontuário, financeiro, guia/pacote, agenda nova, alteração posterior, retenção legal);
--   senão recusa. app_import_batch_blockers(lote) devolve os motivos (só contagens) para a API explicar.
-- RLS FORÇADO (app_current_tenant, 0003), FK compostas com tenant_id, sem DELETE/TRUNCATE para o runtime.
-- Não toca o CHECK de audit_log.action (usa create/update/read com escopos novos).

-- ---------------------------------------------------------------- lote

CREATE TABLE import_batches (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id),
  kind              text NOT NULL CONSTRAINT import_batches_kind_check CHECK (kind IN ('pacientes', 'agenda')),
  status            text NOT NULL DEFAULT 'recebido' CONSTRAINT import_batches_status_check
                      CHECK (status IN ('recebido', 'validado', 'simulado', 'aplicado', 'desfeito', 'expirado')),
  -- Aceite do termo de migração (MIG-02.4): instrução do controlador para esta importação.
  term_version      text NOT NULL CONSTRAINT import_batches_term_version_check CHECK (term_version ~ '^[a-z0-9][a-z0-9.-]{2,31}$'),
  term_accepted_by  uuid NOT NULL,
  term_accepted_at  timestamptz NOT NULL DEFAULT now(),
  file_format       text NOT NULL DEFAULT 'csv' CONSTRAINT import_batches_format_check CHECK (file_format IN ('csv')),
  byte_size         integer NOT NULL CONSTRAINT import_batches_size_check CHECK (byte_size BETWEEN 1 AND 5242880),
  row_count         integer NOT NULL CONSTRAINT import_batches_rows_check CHECK (row_count BETWEEN 0 AND 10000),
  column_count      smallint NOT NULL CONSTRAINT import_batches_columns_check CHECK (column_count BETWEEN 1 AND 60),
  -- {campo: índice da coluna}. Só nomes de campo conhecidos e inteiros (conferido na API e aqui).
  column_mapping    jsonb CONSTRAINT import_batches_mapping_check CHECK (
                      column_mapping IS NULL OR (jsonb_typeof(column_mapping) = 'object'
                        AND NOT jsonb_path_exists(column_mapping, '$.* ? (@.type() != "number" || @ < 0 || @ > 59)'))),
  current_run       smallint NOT NULL DEFAULT 0 CONSTRAINT import_batches_run_check CHECK (current_run BETWEEN 0 AND 10000),
  valid_rows        integer,
  error_rows        integer,
  warning_count     integer,
  planned_creates   integer,
  planned_skips     integer,
  -- Hash da simulação (dry-run) que o admin aprovou: aplicar exige o mesmo hash (G8).
  simulation_hash   text CONSTRAINT import_batches_hash_check CHECK (simulation_hash IS NULL OR simulation_hash ~ '^[0-9a-f]{64}$'),
  created_records   integer,
  raw_expires_at    timestamptz NOT NULL,
  raw_discarded_at  timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  validated_at      timestamptz,
  simulated_at      timestamptz,
  applied_at        timestamptz,
  applied_by        uuid,
  undone_at         timestamptz,
  undone_by         uuid,
  expired_at        timestamptz,
  CONSTRAINT import_batches_expiry_check CHECK (raw_expires_at > created_at AND raw_expires_at <= created_at + interval '7 days'),
  CONSTRAINT import_batches_term_actor_check CHECK (term_accepted_by = created_by),
  CONSTRAINT import_batches_validated_check CHECK (status NOT IN ('validado', 'simulado', 'aplicado', 'desfeito') OR validated_at IS NOT NULL),
  CONSTRAINT import_batches_simulated_check CHECK (status NOT IN ('simulado', 'aplicado', 'desfeito') OR (simulated_at IS NOT NULL AND simulation_hash IS NOT NULL)),
  CONSTRAINT import_batches_applied_check CHECK ((status IN ('aplicado', 'desfeito')) = (applied_at IS NOT NULL AND applied_by IS NOT NULL)),
  CONSTRAINT import_batches_undone_check CHECK ((status = 'desfeito') = (undone_at IS NOT NULL AND undone_by IS NOT NULL)),
  CONSTRAINT import_batches_expired_check CHECK ((status = 'expirado') = (expired_at IS NOT NULL)),
  CONSTRAINT import_batches_id_tenant_key UNIQUE (id, tenant_id)
);
CREATE INDEX import_batches_tenant_created_idx ON import_batches (tenant_id, created_at);
CREATE INDEX import_batches_raw_pending_idx ON import_batches (tenant_id, raw_expires_at) WHERE raw_discarded_at IS NULL;

-- ---------------------------------------------------------------- arquivo bruto (cifrado, expira)

CREATE TABLE import_raw_files (
  batch_id     uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  content_enc  text NOT NULL CONSTRAINT import_raw_files_content_check CHECK (app_is_sealed_field(content_enc)),
  -- SHA-256 do arquivo recebido (integridade/evidência; não revela o conteúdo).
  sha256       text NOT NULL CONSTRAINT import_raw_files_sha_check CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_raw_files_expiry_check CHECK (expires_at > created_at AND expires_at <= created_at + interval '7 days'),
  CONSTRAINT import_raw_files_batch_fk FOREIGN KEY (batch_id, tenant_id) REFERENCES import_batches (id, tenant_id)
);
CREATE INDEX import_raw_files_tenant_expiry_idx ON import_raw_files (tenant_id, expires_at);

-- ---------------------------------------------------------------- divergências (só códigos)

CREATE TABLE import_issues (
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  batch_id     uuid NOT NULL,
  run          smallint NOT NULL CONSTRAINT import_issues_run_check CHECK (run BETWEEN 1 AND 10000),
  line_number  integer NOT NULL CONSTRAINT import_issues_line_check CHECK (line_number BETWEEN 1 AND 10002),
  field        text NOT NULL CONSTRAINT import_issues_field_check CHECK (field ~ '^[a-z][a-zA-Z]{0,31}$'),
  code         text NOT NULL CONSTRAINT import_issues_code_check CHECK (code ~ '^[a-z][a-z_]{1,47}$'),
  severity     text NOT NULL CONSTRAINT import_issues_severity_check CHECK (severity IN ('erro', 'aviso')),
  PRIMARY KEY (tenant_id, batch_id, run, line_number, field, code),
  CONSTRAINT import_issues_batch_fk FOREIGN KEY (batch_id, tenant_id) REFERENCES import_batches (id, tenant_id)
);

-- ---------------------------------------------------------------- livro do lote (rollback e proveniência)

CREATE TABLE import_batch_records (
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  batch_id     uuid NOT NULL,
  entity       text NOT NULL CONSTRAINT import_batch_records_entity_check CHECK (entity IN ('patient', 'appointment')),
  -- Sem FK para patients/appointments: o desfazer apaga o registro e o livro fica como histórico.
  record_id    uuid NOT NULL,
  line_number  integer NOT NULL CONSTRAINT import_batch_records_line_check CHECK (line_number BETWEEN 1 AND 10002),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, entity, record_id),
  CONSTRAINT import_batch_records_batch_fk FOREIGN KEY (batch_id, tenant_id) REFERENCES import_batches (id, tenant_id)
);
CREATE INDEX import_batch_records_batch_idx ON import_batch_records (tenant_id, batch_id, entity);

-- ---------------------------------------------------------------- integridade

CREATE FUNCTION import_reject_mutation() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%: % não permitido', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- Lote: só admin ativo cria; termo e identidade imutáveis; transições do fluxo; terminal é terminal.
CREATE FUNCTION import_batches_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := app_current_user();
  permitido boolean;
  so_descarte import_batches;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Data de criação no futuro esticaria a vida do arquivo bruto além dos 7 dias.
    IF NEW.created_at > now() THEN
      RAISE EXCEPTION 'lote não nasce no futuro' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status <> 'recebido' OR NEW.current_run <> 0 OR NEW.applied_at IS NOT NULL OR NEW.raw_discarded_at IS NOT NULL THEN
      RAISE EXCEPTION 'lote nasce recebido' USING ERRCODE = 'check_violation';
    END IF;
    IF v_user IS NULL OR NEW.created_by <> v_user OR NOT app_user_has_role(v_user, 'admin') THEN
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
  IF OLD.status IN ('desfeito', 'expirado') THEN
    -- Única mudança aceita num lote terminal: registrar o descarte do arquivo bruto (expurgo).
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
  -- Antes de aplicar, o arquivo bruto precisa existir (expirado não se aplica).
  IF OLD.status <> 'aplicado' AND NEW.status IN ('validado', 'simulado', 'aplicado') AND OLD.raw_discarded_at IS NOT NULL THEN
    RAISE EXCEPTION 'arquivo bruto já descartado' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NEW.status = 'aplicado' AND OLD.status <> 'aplicado' THEN
    IF v_user IS NULL OR NEW.applied_by <> v_user OR NOT app_user_has_role(v_user, 'admin') THEN
      RAISE EXCEPTION 'só admin da clínica aplica a importação' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.simulation_hash IS DISTINCT FROM OLD.simulation_hash THEN
      RAISE EXCEPTION 'aplicar não muda a simulação aprovada' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF OLD.status = 'aplicado' AND (NEW.applied_at <> OLD.applied_at OR NEW.applied_by <> OLD.applied_by
     OR NEW.simulation_hash IS DISTINCT FROM OLD.simulation_hash OR NEW.created_records IS DISTINCT FROM OLD.created_records) THEN
    RAISE EXCEPTION 'lote aplicado: aplicação é imutável' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status = 'desfeito' AND (v_user IS NULL OR NEW.undone_by <> v_user OR NOT app_user_has_role(v_user, 'admin')) THEN
    RAISE EXCEPTION 'só admin da clínica desfaz a importação' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.current_run < OLD.current_run THEN
    RAISE EXCEPTION 'rodada de validação só avança' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER import_batches_guard BEFORE INSERT OR UPDATE ON import_batches
  FOR EACH ROW EXECUTE FUNCTION import_batches_guard();
CREATE TRIGGER import_batches_no_delete BEFORE DELETE ON import_batches
  FOR EACH ROW EXECUTE FUNCTION import_reject_mutation();
CREATE TRIGGER import_batches_no_truncate BEFORE TRUNCATE ON import_batches
  FOR EACH STATEMENT EXECUTE FUNCTION import_reject_mutation();

-- Arquivo bruto: só nasce com o lote recebido, com a MESMA expiração do lote; nunca muda; só se apaga
-- vencido ou com o lote já aplicado/terminal (e só a função de expurgo tem DELETE).
CREATE FUNCTION import_raw_files_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  b import_batches;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'arquivo bruto não muda' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO b FROM import_batches WHERE id = NEW.batch_id AND tenant_id = NEW.tenant_id;
    IF NOT FOUND OR b.status <> 'recebido' OR b.raw_discarded_at IS NOT NULL OR NEW.expires_at <> b.raw_expires_at
       OR NEW.created_at > now() THEN
      RAISE EXCEPTION 'arquivo bruto só com o lote recebido e a mesma expiração' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO b FROM import_batches WHERE id = OLD.batch_id AND tenant_id = OLD.tenant_id;
  IF OLD.expires_at > now() AND b.status NOT IN ('aplicado', 'desfeito', 'expirado') THEN
    RAISE EXCEPTION 'arquivo bruto só se apaga vencido ou com o lote encerrado' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER import_raw_files_guard BEFORE INSERT OR UPDATE OR DELETE ON import_raw_files
  FOR EACH ROW EXECUTE FUNCTION import_raw_files_guard();
CREATE TRIGGER import_raw_files_no_truncate BEFORE TRUNCATE ON import_raw_files
  FOR EACH STATEMENT EXECUTE FUNCTION import_reject_mutation();

-- Divergências: append-only; só a rodada CORRENTE recebe linhas; só rodadas antigas se apagam.
CREATE FUNCTION import_issues_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  corrente smallint;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'divergência não muda' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT current_run INTO corrente FROM import_batches
   WHERE id = COALESCE(NEW.batch_id, OLD.batch_id) AND tenant_id = COALESCE(NEW.tenant_id, OLD.tenant_id);
  IF TG_OP = 'INSERT' THEN
    IF corrente IS NULL OR NEW.run <> corrente THEN
      RAISE EXCEPTION 'divergência só na rodada corrente do lote' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF corrente IS NOT NULL AND OLD.run >= corrente THEN
    RAISE EXCEPTION 'só se apagam divergências de rodadas antigas' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER import_issues_guard BEFORE INSERT OR UPDATE OR DELETE ON import_issues
  FOR EACH ROW EXECUTE FUNCTION import_issues_guard();
CREATE TRIGGER import_issues_no_truncate BEFORE TRUNCATE ON import_issues
  FOR EACH STATEMENT EXECUTE FUNCTION import_reject_mutation();

-- Livro: só entra enquanto o lote está sendo aplicado (simulado, na mesma transação que o marca
-- aplicado) e nunca muda nem sai.
CREATE FUNCTION import_batch_records_guard() RETURNS trigger
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
  RETURN NEW;
END;
$$;
CREATE TRIGGER import_batch_records_guard BEFORE INSERT OR UPDATE OR DELETE ON import_batch_records
  FOR EACH ROW EXECUTE FUNCTION import_batch_records_guard();
CREATE TRIGGER import_batch_records_no_truncate BEFORE TRUNCATE ON import_batch_records
  FOR EACH STATEMENT EXECUTE FUNCTION import_reject_mutation();

-- ---------------------------------------------------------------- expurgo do arquivo bruto

-- Idempotente, na clínica do contexto travado: apaga o arquivo bruto vencido (expires_at <= agora) ou de
-- lote já aplicado/encerrado; marca expirado o lote que venceu antes de aplicar; registra a evidência
-- (raw_discarded_at) e apaga divergências de rodadas antigas. Devolve quantos arquivos apagou.
CREATE FUNCTION app_purge_import_raw_files() RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  t uuid := app_current_tenant();
  n integer;
BEGIN
  IF t IS NULL THEN
    RAISE EXCEPTION 'expurgo exige o contexto da clínica' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE import_batches
     SET status = 'expirado', expired_at = now(), updated_at = now()
   WHERE tenant_id = t AND status IN ('recebido', 'validado', 'simulado') AND raw_expires_at <= now();
  WITH apagados AS (
    DELETE FROM import_raw_files f
     USING import_batches b
     WHERE f.tenant_id = t AND b.tenant_id = t AND b.id = f.batch_id
       AND (f.expires_at <= now() OR b.status IN ('aplicado', 'desfeito', 'expirado'))
    RETURNING f.batch_id
  )
  UPDATE import_batches b SET raw_discarded_at = now(), updated_at = now()
    FROM apagados a WHERE b.tenant_id = t AND b.id = a.batch_id AND b.raw_discarded_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  -- Lote terminal sem arquivo (ex.: expirado antes de ter linha) também registra o descarte.
  UPDATE import_batches SET raw_discarded_at = now(), updated_at = now()
   WHERE tenant_id = t AND raw_discarded_at IS NULL AND status IN ('aplicado', 'desfeito', 'expirado')
     AND NOT EXISTS (SELECT 1 FROM import_raw_files f WHERE f.tenant_id = t AND f.batch_id = import_batches.id);
  DELETE FROM import_issues i USING import_batches b
   WHERE i.tenant_id = t AND b.tenant_id = t AND b.id = i.batch_id AND i.run < b.current_run;
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION app_purge_import_raw_files() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_purge_import_raw_files() TO app_user;

-- ---------------------------------------------------------------- desfazer

-- Motivos que impedem desfazer (só contagens). Roda com os privilégios de quem chama (RLS da clínica).
CREATE FUNCTION app_import_batch_blockers(p_batch uuid) RETURNS jsonb
  LANGUAGE sql
  STABLE
  SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH b AS (
    SELECT id, tenant_id, applied_at FROM import_batches WHERE id = p_batch AND tenant_id = app_current_tenant()
  ),
  pac AS (SELECT r.record_id AS id FROM import_batch_records r JOIN b ON r.batch_id = b.id AND r.tenant_id = b.tenant_id WHERE r.entity = 'patient'),
  ag AS (SELECT r.record_id AS id FROM import_batch_records r JOIN b ON r.batch_id = b.id AND r.tenant_id = b.tenant_id WHERE r.entity = 'appointment')
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
REVOKE ALL ON FUNCTION app_import_batch_blockers(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_import_batch_blockers(uuid) TO app_user;

-- Desfaz o lote APLICADO da clínica do contexto: confere admin, trava o lote, recalcula os motivos e,
-- sem nenhum, apaga agendamentos e depois pacientes criados pelo lote (FK de qualquer tabela que
-- passe a referenciá-los também barra), marca o lote desfeito e devolve as contagens.
CREATE FUNCTION app_undo_import_batch(p_batch uuid) RETURNS jsonb
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
  DELETE FROM appointments a USING import_batch_records r
   WHERE a.tenant_id = t AND r.tenant_id = t AND r.batch_id = p_batch AND r.entity = 'appointment' AND a.id = r.record_id;
  GET DIAGNOSTICS n_ag = ROW_COUNT;
  DELETE FROM patients p USING import_batch_records r
   WHERE p.tenant_id = t AND r.tenant_id = t AND r.batch_id = p_batch AND r.entity = 'patient' AND p.id = r.record_id;
  GET DIAGNOSTICS n_pac = ROW_COUNT;
  UPDATE import_batches SET status = 'desfeito', undone_at = now(), undone_by = v_user, updated_at = now()
   WHERE id = p_batch AND tenant_id = t;
  RETURN jsonb_build_object('patients', n_pac, 'appointments', n_ag);
EXCEPTION
  WHEN foreign_key_violation THEN
    RAISE EXCEPTION 'importacao_em_uso' USING ERRCODE = 'object_in_use';
END;
$$;
REVOKE ALL ON FUNCTION app_undo_import_batch(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_undo_import_batch(uuid) TO app_user;

-- Dono das funções SECURITY DEFINER: nunca superusuário, BYPASSRLS nem o runtime (mesma regra da R11).
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS fn, p.prosecdef, o.rolname, o.rolsuper, o.rolbypassrls
      FROM pg_proc p JOIN pg_roles o ON o.oid = p.proowner
     WHERE p.oid IN ('app_purge_import_raw_files()'::regprocedure, 'app_undo_import_batch(uuid)'::regprocedure)
  LOOP
    IF NOT r.prosecdef THEN
      RAISE EXCEPTION '% deveria ser SECURITY DEFINER', r.fn;
    END IF;
    IF r.rolsuper OR r.rolbypassrls OR r.rolname = 'app_user' THEN
      RAISE EXCEPTION 'dono de % (%) não pode ser superusuário, BYPASSRLS nem o runtime', r.fn, r.rolname;
    END IF;
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------- RLS

ALTER TABLE import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON import_batches
  USING (tenant_id = (SELECT app_current_tenant()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()));

ALTER TABLE import_raw_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_raw_files FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON import_raw_files
  USING (tenant_id = (SELECT app_current_tenant()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()));

ALTER TABLE import_issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_issues FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON import_issues
  USING (tenant_id = (SELECT app_current_tenant()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()));

ALTER TABLE import_batch_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_batch_records FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON import_batch_records
  USING (tenant_id = (SELECT app_current_tenant()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()));

-- Menor privilégio: os DEFAULT PRIVILEGES deram SELECT/INSERT/UPDATE/DELETE ao runtime.
REVOKE DELETE, TRUNCATE ON import_batches, import_raw_files, import_issues, import_batch_records FROM app_user;
-- Arquivo bruto, divergências e livro: o runtime só lê e insere.
REVOKE UPDATE ON import_raw_files, import_issues, import_batch_records FROM app_user;
