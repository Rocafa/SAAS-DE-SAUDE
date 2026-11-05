-- 0017 — Retenção legal que bloqueia eliminação, custódia do psicólogo substituto, caixa de avisos do
-- sigilo e retirada da retenção por duas pessoas (R10, R2, R9, R11 e R12 do parecer do Guardião sobre
-- o PR #63). Executar com o papel de MIGRAÇÃO (app_migrator). Depende da 0015 e da 0016
-- (app_current_user). A 0018 é do financeiro.
-- Ver docs/04-arquitetura/api-dominio.md §8.
--
-- 1. R10: com o paciente sob retenção legal, nenhuma nota privada dele é descartada (lápide) nem tem o
--    conteúdo trocado, por ninguém (autor, ciclo automático, custódia). O expurgo já era barrado (0015).
--    O prontuário (atendimentos, versões, adendos) não tem caminho de eliminação nem DELETE.
-- 2. R12: legal_holds guarda cada retenção com a REFERÊNCIA do processo/ofício cifrada. Retirar exige
--    pedido com MOTIVO cifrado (admin A) e aprovação de OUTRO admin (B). O banco confere que A e B são o
--    usuário da sessão e que B <> A. patients.legal_hold_since passa a ser mantida só por este fluxo.
-- 3. R2: note_custodies — o admin designa um psicólogo substituto para as notas lacradas de um autor
--    desligado; só o substituto aceita (aceite explícito) e, aceito, só ele lê e decide (guarda da
--    clínica, com o prontuário, ou eliminação). Sem substituto, o lacre segue a regra da D2.
-- 4. R9: clinical_notices — caixa de avisos interna (sem dado de paciente nem conteúdo clínico). A troca
--    do sigilo da psicologia gera um aviso para cada psicólogo ativo da clínica; só o destinatário lê e
--    marca como lido.
-- 5. R11: função de expurgo com search_path fixo (com pg_temp por último) e dono conferido: nem
--    superusuário nem BYPASSRLS (a migração falha se for). O runtime continua sem DELETE.

-- ------------------------------------------------------------------ apoio

CREATE FUNCTION app_patient_under_legal_hold(p_tenant uuid, p_patient uuid) RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (SELECT 1 FROM patients p WHERE p.id = p_patient AND p.tenant_id = p_tenant AND p.legal_hold_since IS NOT NULL)
$$;

-- ------------------------------------------------------------------ 1/3. guarda das notas privadas

CREATE OR REPLACE FUNCTION private_notes_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.patient_id <> OLD.patient_id OR NEW.author_user_id <> OLD.author_user_id
     OR NEW.encounter_id IS DISTINCT FROM OLD.encounter_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'identidade da nota privada é imutável' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.discarded_at IS NOT NULL THEN
    RAISE EXCEPTION 'nota privada descartada não muda' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- R10: retenção legal suspende a eliminação E a troca de conteúdo (a nota não é versionada).
  IF (NEW.discarded_at IS NOT NULL OR NEW.content_enc IS DISTINCT FROM OLD.content_enc)
     AND app_patient_under_legal_hold(OLD.tenant_id, OLD.patient_id) THEN
    RAISE EXCEPTION 'retencao_legal: nota de paciente sob retenção legal não é eliminada nem alterada'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF OLD.custody_state = 'guarda_clinica' AND NEW.custody_state <> OLD.custody_state THEN
    RAISE EXCEPTION 'nota sob guarda não muda de estado' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF OLD.custody_state = 'lacrada' AND NEW.custody_state <> OLD.custody_state THEN
    -- R2: só o psicólogo substituto com custódia ACEITA leva a lacrada para a guarda da clínica.
    IF NOT (NEW.custody_state = 'guarda_clinica' AND EXISTS (
      SELECT 1 FROM note_custodies c
       WHERE c.tenant_id = OLD.tenant_id AND c.author_user_id = OLD.author_user_id
         AND c.substitute_user_id = app_current_user() AND c.accepted_at IS NOT NULL)) THEN
      RAISE EXCEPTION 'nota lacrada só muda de estado pela custódia aceita' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ------------------------------------------------------------------ 2. retenção legal (R12)

CREATE TABLE legal_holds (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants (id),
  patient_id            uuid NOT NULL,
  reference_enc         text NOT NULL CONSTRAINT legal_holds_reference_check CHECK (app_is_sealed_field(reference_enc)),
  placed_by             uuid NOT NULL,
  placed_at             timestamptz NOT NULL DEFAULT now(),
  release_reason_enc    text CONSTRAINT legal_holds_release_reason_check CHECK (release_reason_enc IS NULL OR app_is_sealed_field(release_reason_enc)),
  release_requested_by  uuid,
  release_requested_at  timestamptz,
  released_by           uuid,
  released_at           timestamptz,
  CONSTRAINT legal_holds_patient_fk FOREIGN KEY (patient_id, tenant_id) REFERENCES patients (id, tenant_id),
  CONSTRAINT legal_holds_request_check CHECK (
    (release_requested_by IS NULL) = (release_reason_enc IS NULL)
    AND (release_requested_by IS NULL) = (release_requested_at IS NULL)),
  CONSTRAINT legal_holds_release_check CHECK (
    (released_by IS NULL) = (released_at IS NULL)
    AND (released_by IS NULL OR (release_requested_by IS NOT NULL AND released_by <> release_requested_by)))
);
-- Uma retenção ativa por paciente.
CREATE UNIQUE INDEX legal_holds_active_idx ON legal_holds (tenant_id, patient_id) WHERE released_at IS NULL;

ALTER TABLE legal_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_holds FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON legal_holds
  USING (tenant_id = (SELECT app_current_tenant()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()));
REVOKE DELETE, TRUNCATE ON legal_holds FROM app_user;

CREATE FUNCTION legal_holds_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := app_current_user();
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'legal_holds não se apaga' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'retenção legal exige o usuário da sessão' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.placed_by <> v_user OR NEW.release_requested_by IS NOT NULL OR NEW.released_by IS NOT NULL THEN
      RAISE EXCEPTION 'retenção nasce ativa e marcada por quem está na sessão' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.placed_at := now();
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.patient_id <> OLD.patient_id
     OR NEW.reference_enc <> OLD.reference_enc OR NEW.placed_by <> OLD.placed_by OR NEW.placed_at <> OLD.placed_at THEN
    RAISE EXCEPTION 'identidade da retenção legal é imutável' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'retenção legal retirada é terminal' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- Pedido de retirada (1ª pessoa): com motivo; ou cancelamento do pedido pendente.
  IF NEW.release_requested_by IS DISTINCT FROM OLD.release_requested_by THEN
    IF NEW.released_by IS NOT NULL THEN
      RAISE EXCEPTION 'pedido e aprovação da retirada são etapas distintas' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.release_requested_by IS NOT NULL THEN
      IF OLD.release_requested_by IS NOT NULL OR NEW.release_requested_by <> v_user THEN
        RAISE EXCEPTION 'pedido de retirada é de quem está na sessão' USING ERRCODE = 'insufficient_privilege';
      END IF;
      NEW.release_requested_at := now();
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.release_reason_enc IS DISTINCT FROM OLD.release_reason_enc OR NEW.release_requested_at IS DISTINCT FROM OLD.release_requested_at THEN
    RAISE EXCEPTION 'o pedido de retirada não muda' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Aprovação (2ª pessoa, outra que não a do pedido).
  IF NEW.released_by IS DISTINCT FROM OLD.released_by THEN
    IF OLD.release_requested_by IS NULL OR NEW.released_by IS NULL OR NEW.released_by <> v_user
       OR NEW.released_by = OLD.release_requested_by THEN
      RAISE EXCEPTION 'retirada da retenção exige aprovação de outra pessoa' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.released_at := now();
  ELSIF NEW.released_at IS DISTINCT FROM OLD.released_at THEN
    RAISE EXCEPTION 'released_at acompanha a aprovação' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER legal_holds_guard BEFORE INSERT OR UPDATE OR DELETE ON legal_holds
  FOR EACH ROW EXECUTE FUNCTION legal_holds_guard();
CREATE TRIGGER legal_holds_no_truncate BEFORE TRUNCATE ON legal_holds
  FOR EACH STATEMENT EXECUTE FUNCTION legal_holds_guard();

-- patients.legal_hold_since espelha as retenções ativas (mantida só pelo trigger abaixo).
CREATE FUNCTION legal_holds_sync_patient() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE patients p
     SET legal_hold_since = (SELECT min(h.placed_at) FROM legal_holds h
                              WHERE h.tenant_id = NEW.tenant_id AND h.patient_id = NEW.patient_id AND h.released_at IS NULL)
   WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.patient_id;
  RETURN NULL;
END;
$$;
CREATE TRIGGER legal_holds_sync_patient AFTER INSERT OR UPDATE OF released_at ON legal_holds
  FOR EACH ROW EXECUTE FUNCTION legal_holds_sync_patient();

CREATE FUNCTION patients_legal_hold_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
AS $$
BEGIN
  -- Profundidade 1 = UPDATE direto do runtime; 2 = vindo de legal_holds_sync_patient.
  IF NEW.legal_hold_since IS DISTINCT FROM OLD.legal_hold_since AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'retenção legal só muda pelo fluxo de legal_holds' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER patients_legal_hold_guard BEFORE UPDATE OF legal_hold_since ON patients
  FOR EACH ROW EXECUTE FUNCTION patients_legal_hold_guard();

-- ------------------------------------------------------------------ 3. custódia (R2)

CREATE TABLE note_custodies (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id),
  author_user_id      uuid NOT NULL,
  substitute_user_id  uuid NOT NULL,
  designated_by       uuid NOT NULL,
  designated_at       timestamptz NOT NULL DEFAULT now(),
  accepted_at         timestamptz,
  CONSTRAINT note_custodies_pessoas_check CHECK (substitute_user_id <> author_user_id AND substitute_user_id <> designated_by),
  CONSTRAINT note_custodies_author_key UNIQUE (tenant_id, author_user_id)
);
ALTER TABLE note_custodies ENABLE ROW LEVEL SECURITY;
ALTER TABLE note_custodies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON note_custodies
  USING (tenant_id = (SELECT app_current_tenant()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()));
REVOKE DELETE, TRUNCATE ON note_custodies FROM app_user;

CREATE FUNCTION note_custodies_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := app_current_user();
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'note_custodies não se apaga' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'custódia exige o usuário da sessão' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.designated_by <> v_user OR NEW.accepted_at IS NOT NULL THEN
      RAISE EXCEPTION 'designação é de quem está na sessão e nasce sem aceite' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.designated_at := now();
    RETURN NEW;
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.author_user_id <> OLD.author_user_id
     OR NEW.substitute_user_id <> OLD.substitute_user_id OR NEW.designated_by <> OLD.designated_by
     OR NEW.designated_at <> OLD.designated_at THEN
    RAISE EXCEPTION 'custódia é imutável' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.accepted_at IS NOT NULL OR NEW.accepted_at IS NULL OR OLD.substitute_user_id <> v_user THEN
    RAISE EXCEPTION 'só o substituto aceita a custódia, uma vez' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.accepted_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER note_custodies_guard BEFORE INSERT OR UPDATE OR DELETE ON note_custodies
  FOR EACH ROW EXECUTE FUNCTION note_custodies_guard();
CREATE TRIGGER note_custodies_no_truncate BEFORE TRUNCATE ON note_custodies
  FOR EACH STATEMENT EXECUTE FUNCTION note_custodies_guard();

-- ------------------------------------------------------------------ 4. caixa de avisos (R9)

CREATE TABLE clinical_notices (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants (id),
  recipient_user_id    uuid NOT NULL,
  kind                 text NOT NULL CONSTRAINT clinical_notices_kind_check CHECK (kind IN ('sigilo_psicologia_alterado')),
  -- Só configuração: modos de sigilo e contagem de atendimentos restringidos. Nunca dado de paciente.
  from_mode            text NOT NULL CONSTRAINT clinical_notices_from_check CHECK (from_mode IN ('restrito_ao_autor', 'prontuario_unico')),
  to_mode              text NOT NULL CONSTRAINT clinical_notices_to_check CHECK (to_mode IN ('restrito_ao_autor', 'prontuario_unico')),
  restricted_existing  integer NOT NULL DEFAULT 0 CONSTRAINT clinical_notices_restricted_check CHECK (restricted_existing >= 0),
  created_by           uuid NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  read_at              timestamptz
);
CREATE INDEX clinical_notices_recipient_idx ON clinical_notices (tenant_id, recipient_user_id, created_at DESC);
ALTER TABLE clinical_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinical_notices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON clinical_notices
  USING (tenant_id = (SELECT app_current_tenant()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()));
REVOKE DELETE, TRUNCATE ON clinical_notices FROM app_user;

CREATE FUNCTION clinical_notices_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := app_current_user();
  semLeitura clinical_notices;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'clinical_notices não se apaga' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF v_user IS NULL OR NEW.created_by <> v_user OR NEW.read_at IS NOT NULL THEN
      RAISE EXCEPTION 'aviso é criado por quem está na sessão e nasce não lido' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  semLeitura := NEW;
  semLeitura.read_at := OLD.read_at;
  IF semLeitura IS DISTINCT FROM OLD OR OLD.read_at IS NOT NULL OR NEW.read_at IS NULL
     OR v_user IS NULL OR OLD.recipient_user_id <> v_user THEN
    RAISE EXCEPTION 'só o destinatário marca o aviso como lido' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER clinical_notices_guard BEFORE INSERT OR UPDATE OR DELETE ON clinical_notices
  FOR EACH ROW EXECUTE FUNCTION clinical_notices_guard();
CREATE TRIGGER clinical_notices_no_truncate BEFORE TRUNCATE ON clinical_notices
  FOR EACH STATEMENT EXECUTE FUNCTION clinical_notices_guard();

-- ------------------------------------------------------------------ 5. dono da função de expurgo (R11)

ALTER FUNCTION app_purge_discarded_private_notes() SET search_path = pg_catalog, public, pg_temp;
DO $$
DECLARE
  r record;
BEGIN
  SELECT p.prosecdef, o.rolname, o.rolsuper, o.rolbypassrls INTO r
    FROM pg_proc p JOIN pg_roles o ON o.oid = p.proowner
   WHERE p.oid = 'app_purge_discarded_private_notes()'::regprocedure;
  IF NOT r.prosecdef THEN
    RAISE EXCEPTION 'app_purge_discarded_private_notes deveria ser SECURITY DEFINER';
  END IF;
  IF r.rolsuper OR r.rolbypassrls OR r.rolname = 'app_user' THEN
    RAISE EXCEPTION 'dono de app_purge_discarded_private_notes (%) não pode ser superusuário, BYPASSRLS nem o runtime', r.rolname;
  END IF;
END;
$$;
