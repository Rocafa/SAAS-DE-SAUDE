-- 0048 — Importador: responsáveis no lote de pacientes (R5 do parecer do importador, rodada 22).
-- Executar com o papel de MIGRAÇÃO (app_migrator). Ver docs/04-arquitetura/api-dominio.md §12c (R5).
--
-- NUMERAÇÃO: 0046 e 0047 são de outras branches da rodada 22; esta é a 0048.
--
-- O lote de PACIENTES passa a trazer o responsável (nome, CPF, telefone, tipo pai/mãe/tutor/curador,
-- referência e escopo da curatela e "é pagador"). O aplicar cria a pessoa (`guardians`) e o vínculo
-- (`patient_guardians`) pelas MESMAS tabelas e gatilhos do cadastro (0028/0031/0034: autor = sessão,
-- histórico append-only, curatela com decisão e escopo cifrados, decisão clínica só do profissional).
--
-- - `guardians.import_batch_id` e `patient_guardians.import_batch_id`: a marca do lote, com a regra da V1
--   da 0026 — gravada SÓ no INSERT, só com o lote da clínica em aplicação (`simulado`, tipo `pacientes`) e
--   por admin da sessão; IMUTÁVEL depois (qualquer papel). Pessoa que já existia (deduplicada por CPF) NÃO
--   ganha a marca: só o vínculo novo a leva.
-- - O vínculo marcado nasce SÓ para paciente criado pelo MESMO lote e NUNCA com a informação clínica
--   ligada (nem decisão/justificativa): ligar a marca clínica continua sendo decisão do profissional, no
--   cadastro, depois.
-- - Desfazer (app_undo_import_batch) apaga, pela marca, os vínculos do lote (e o histórico deles), as pessoas
--   criadas pelo lote (e o evento `responsavel_criado`), os agendamentos e os pacientes. Pessoa que já
--   existia fica intacta, com o histórico dela. Os gatilhos "nada se apaga" da 0028/0031 só abrem para
--   esse DELETE, dentro da função SECURITY DEFINER (marca transacional `app.import_undo_batch` = lote; o
--   runtime nem tem DELETE nessas tabelas).
-- - Motivos de bloqueio do desfazer ganham `responsavel_em_uso` (pessoa do lote vinculada a paciente fora
--   do lote, ou pessoa/vínculo do lote usado por recebimento, portal ou WhatsApp) e `responsavel_novo`
--   (vínculo criado no cadastro para paciente do lote); `alterado_depois` passa a contar pessoa e vínculo
--   do lote alterados depois do aplicar.

-- ---------------------------------------------------------------- marca imutável do lote

ALTER TABLE guardians
  ADD COLUMN import_batch_id uuid,
  ADD CONSTRAINT guardians_import_batch_fk FOREIGN KEY (import_batch_id, tenant_id) REFERENCES import_batches (id, tenant_id);
CREATE INDEX guardians_import_batch_idx ON guardians (tenant_id, import_batch_id) WHERE import_batch_id IS NOT NULL;

ALTER TABLE patient_guardians
  ADD COLUMN import_batch_id uuid,
  ADD CONSTRAINT patient_guardians_import_batch_fk FOREIGN KEY (import_batch_id, tenant_id) REFERENCES import_batches (id, tenant_id);
CREATE INDEX patient_guardians_import_batch_idx ON patient_guardians (tenant_id, import_batch_id) WHERE import_batch_id IS NOT NULL;

CREATE FUNCTION guardian_import_provenance_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := app_current_user();
  b import_batches;
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
  IF NOT FOUND OR b.status <> 'simulado' OR b.kind <> 'pacientes' THEN
    RAISE EXCEPTION 'marca de lote só em registro criado pelo lote em aplicação' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF v_user IS NULL OR NOT app_user_has_role(v_user, 'admin') THEN
    RAISE EXCEPTION 'só admin da clínica aplica a importação' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_TABLE_NAME = 'patient_guardians' THEN
    -- Vínculo do lote só para paciente criado pelo MESMO lote.
    IF NOT EXISTS (SELECT 1 FROM patients p WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.patient_id
                     AND p.import_batch_id = NEW.import_batch_id) THEN
      RAISE EXCEPTION 'vínculo do lote só para paciente criado pelo lote' USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- A importação nunca liga a informação clínica (decisão do profissional, A1/A2 do #67).
    IF NEW.receives_clinical_info OR NEW.clinical_info_decided_by IS NOT NULL OR NEW.clinical_info_basis_enc IS NOT NULL THEN
      RAISE EXCEPTION 'a importação não liga a informação clínica do responsável' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guardians_import_provenance_guard BEFORE INSERT OR UPDATE ON guardians
  FOR EACH ROW EXECUTE FUNCTION guardian_import_provenance_guard();
CREATE TRIGGER patient_guardians_import_provenance_guard BEFORE INSERT OR UPDATE ON patient_guardians
  FOR EACH ROW EXECUTE FUNCTION guardian_import_provenance_guard();

-- ---------------------------------------------------------------- "nada se apaga", salvo o desfazer do lote

-- Lote cujo desfazer está em curso NESTA transação (marca local gravada só por app_undo_import_batch).
CREATE FUNCTION app_import_undo_batch_in_progress() RETURNS uuid
  LANGUAGE sql
  STABLE
  SET search_path = pg_catalog, public
AS $$
  SELECT NULLIF(current_setting('app.import_undo_batch', true), '')::uuid
$$;
REVOKE ALL ON FUNCTION app_import_undo_batch_in_progress() FROM PUBLIC;

CREATE FUNCTION guardian_reject_delete_unless_undo() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_lote uuid := app_import_undo_batch_in_progress();
BEGIN
  IF TG_OP = 'DELETE' AND v_lote IS NOT NULL AND OLD.import_batch_id = v_lote THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% é append-only: % não permitido', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;
DROP TRIGGER guardians_no_delete ON guardians;
DROP TRIGGER patient_guardians_no_delete ON patient_guardians;
CREATE TRIGGER guardians_no_delete BEFORE DELETE ON guardians FOR EACH ROW EXECUTE FUNCTION guardian_reject_delete_unless_undo();
CREATE TRIGGER patient_guardians_no_delete BEFORE DELETE ON patient_guardians FOR EACH ROW EXECUTE FUNCTION guardian_reject_delete_unless_undo();

-- Histórico: o da 0031 (append-only, salvo apagar os valores anteriores de pessoa descartada) + o DELETE do
-- desfazer: eventos de vínculo do lote, ou eventos da PESSOA criada pelo lote.
CREATE OR REPLACE FUNCTION patient_guardian_history_mutation() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  semPrev patient_guardian_history;
  v_lote uuid := app_import_undo_batch_in_progress();
BEGIN
  IF TG_OP = 'DELETE' AND v_lote IS NOT NULL AND (
       EXISTS (SELECT 1 FROM patient_guardians l WHERE l.tenant_id = OLD.tenant_id AND l.id = OLD.link_id AND l.import_batch_id = v_lote)
       OR (OLD.link_id IS NULL AND EXISTS (SELECT 1 FROM guardians g WHERE g.tenant_id = OLD.tenant_id AND g.id = OLD.guardian_id
                                             AND g.import_batch_id = v_lote))) THEN
    RETURN OLD;
  END IF;
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'patient_guardian_history é append-only: % não permitido', TG_OP USING ERRCODE = 'insufficient_privilege';
  END IF;
  semPrev := NEW;
  semPrev.prev_name_enc := OLD.prev_name_enc;
  semPrev.prev_cpf_enc := OLD.prev_cpf_enc;
  semPrev.prev_phone_enc := OLD.prev_phone_enc;
  IF semPrev IS DISTINCT FROM OLD OR NEW.prev_name_enc IS NOT NULL OR NEW.prev_cpf_enc IS NOT NULL OR NEW.prev_phone_enc IS NOT NULL
     OR NOT EXISTS (SELECT 1 FROM guardians g WHERE g.tenant_id = OLD.tenant_id AND g.id = OLD.guardian_id AND g.discarded_at IS NOT NULL) THEN
    RAISE EXCEPTION 'patient_guardian_history é append-only: só o descarte dos valores anteriores de pessoa descartada'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------- desfazer: motivos e execução

CREATE OR REPLACE FUNCTION app_import_batch_blockers(p_batch uuid) RETURNS jsonb
  LANGUAGE sql
  STABLE
  SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH b AS (
    SELECT id, tenant_id, applied_at FROM import_batches WHERE id = p_batch AND tenant_id = app_current_tenant()
  ),
  pac AS (SELECT p.id FROM patients p JOIN b ON p.tenant_id = b.tenant_id AND p.import_batch_id = b.id),
  ag AS (SELECT a.id FROM appointments a JOIN b ON a.tenant_id = b.tenant_id AND a.import_batch_id = b.id),
  resp AS (SELECT g.id FROM guardians g JOIN b ON g.tenant_id = b.tenant_id AND g.import_batch_id = b.id),
  vinc AS (SELECT l.id FROM patient_guardians l JOIN b ON l.tenant_id = b.tenant_id AND l.import_batch_id = b.id)
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
                     + (SELECT count(*) FROM guardians g, b WHERE g.tenant_id = b.tenant_id AND g.id IN (SELECT id FROM resp) AND g.updated_at > b.applied_at)
                     + (SELECT count(*) FROM patient_guardians l, b WHERE l.tenant_id = b.tenant_id AND l.id IN (SELECT id FROM vinc) AND l.updated_at > b.applied_at),
    -- 0048: pessoa criada pelo lote vinculada a paciente fora do lote (cadastro), ou pessoa/vínculo do lote
    -- já usado por recebimento (pagador congelado), portal ou WhatsApp.
    'responsavel_em_uso', (SELECT count(*) FROM patient_guardians l, b WHERE l.tenant_id = b.tenant_id AND l.guardian_id IN (SELECT id FROM resp)
                             AND l.import_batch_id IS DISTINCT FROM b.id)
                        + (SELECT count(*) FROM payments y, b WHERE y.tenant_id = b.tenant_id AND y.guardian_payer_link_id IN (SELECT id FROM vinc))
                        + (SELECT count(*) FROM portal_invites i, b WHERE i.tenant_id = b.tenant_id
                             AND (i.guardian_id IN (SELECT id FROM resp) OR i.guardian_link_id IN (SELECT id FROM vinc)))
                        + (SELECT count(*) FROM portal_links pl, b WHERE pl.tenant_id = b.tenant_id
                             AND (pl.guardian_id IN (SELECT id FROM resp) OR pl.guardian_link_id IN (SELECT id FROM vinc)))
                        + (SELECT count(*) FROM portal_consents pc, b WHERE pc.tenant_id = b.tenant_id
                             AND (pc.guardian_id IN (SELECT id FROM resp) OR pc.guardian_link_id IN (SELECT id FROM vinc)))
                        + (SELECT count(*) FROM portal_rights_requests pr, b WHERE pr.tenant_id = b.tenant_id AND pr.guardian_id IN (SELECT id FROM resp))
                        + (SELECT count(*) FROM whatsapp_opt_ins w, b WHERE w.tenant_id = b.tenant_id AND w.guardian_id IN (SELECT id FROM resp))
                        + (SELECT count(*) FROM whatsapp_outbox wo, b WHERE wo.tenant_id = b.tenant_id AND wo.guardian_id IN (SELECT id FROM resp)),
    -- 0048: vínculo criado no cadastro (fora do lote) para paciente do lote.
    'responsavel_novo', (SELECT count(*) FROM patient_guardians l, b WHERE l.tenant_id = b.tenant_id AND l.patient_id IN (SELECT id FROM pac)
                           AND l.import_batch_id IS DISTINCT FROM b.id)
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
  n_vinc integer;
  n_resp integer;
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
  PERFORM set_config('app.import_undo_batch', p_batch::text, true);
  -- Responsáveis (0048): histórico dos vínculos do lote e da pessoa criada pelo lote, vínculos, pessoas.
  DELETE FROM patient_guardian_history h
   WHERE h.tenant_id = t
     AND (h.link_id IN (SELECT l.id FROM patient_guardians l WHERE l.tenant_id = t AND l.import_batch_id = p_batch)
          OR (h.link_id IS NULL AND h.guardian_id IN (SELECT g.id FROM guardians g WHERE g.tenant_id = t AND g.import_batch_id = p_batch)));
  DELETE FROM patient_guardians WHERE tenant_id = t AND import_batch_id = p_batch;
  GET DIAGNOSTICS n_vinc = ROW_COUNT;
  DELETE FROM guardians WHERE tenant_id = t AND import_batch_id = p_batch;
  GET DIAGNOSTICS n_resp = ROW_COUNT;
  PERFORM set_config('app.import_undo_batch', '', true);
  DELETE FROM appointments WHERE tenant_id = t AND import_batch_id = p_batch;
  GET DIAGNOSTICS n_ag = ROW_COUNT;
  DELETE FROM patients WHERE tenant_id = t AND import_batch_id = p_batch;
  GET DIAGNOSTICS n_pac = ROW_COUNT;
  UPDATE import_batches SET status = 'desfeito', undone_at = now(), undone_by = v_user, updated_at = now()
   WHERE id = p_batch AND tenant_id = t;
  RETURN jsonb_build_object('patients', n_pac, 'appointments', n_ag, 'guardian_links', n_vinc, 'guardians', n_resp);
EXCEPTION
  WHEN foreign_key_violation THEN
    RAISE EXCEPTION 'importacao_em_uso' USING ERRCODE = 'object_in_use';
END;
$$;
REVOKE ALL ON FUNCTION app_undo_import_batch(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_undo_import_batch(uuid) TO app_user;

-- Dono da função SECURITY DEFINER: nunca superusuário, BYPASSRLS nem o runtime.
DO $$
DECLARE
  r record;
BEGIN
  SELECT p.prosecdef, o.rolname, o.rolsuper, o.rolbypassrls INTO r
    FROM pg_proc p JOIN pg_roles o ON o.oid = p.proowner
   WHERE p.oid = 'app_undo_import_batch(uuid)'::regprocedure;
  IF NOT r.prosecdef OR r.rolsuper OR r.rolbypassrls OR r.rolname = 'app_user' THEN
    RAISE EXCEPTION 'app_undo_import_batch: SECURITY DEFINER com dono indevido (%)', r.rolname;
  END IF;
END;
$$;
