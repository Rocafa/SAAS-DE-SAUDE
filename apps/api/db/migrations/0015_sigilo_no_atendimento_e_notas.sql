-- 0015 — Sigilo gravado no atendimento (B1 do parecer do Guardião sobre o PR #63) e ciclo de vida
-- das notas privadas (decisões D1 e D2 do mesmo parecer). Executar com o papel de MIGRAÇÃO.
-- Ver docs/04-arquitetura/api-dominio.md §8 ("Sigilo da psicologia" e "Notas privadas: descarte,
-- expurgo e desligamento").
--
-- 1. encounters.confidentiality: o modo de sigilo da psicologia VIGENTE NA ABERTURA do atendimento,
--    gravado na linha. A leitura decide por ele, não pela configuração atual da clínica: trocar a
--    configuração só vale para atendimentos NOVOS. Imutável, com uma exceção: pode ficar MAIS
--    restrito (prontuario_unico -> restrito_ao_autor), mesmo depois de finalizado, porque só restringe
--    (B1-c). Linhas anteriores recebem o padrão mais protetor ('restrito_ao_autor').
-- 2. patients.legal_hold_since: marca de RETENÇÃO LEGAL (requisição judicial, da ANPD ou processo
--    ético em curso sobre o paciente). Enquanto marcada, nada do paciente é expurgado (D1.4).
-- 3. private_notes.custody_state / custody_deadline (D2): 'ativa'; 'aguardando_decisao' (autor
--    desligado: 30 dias para decidir nota a nota); 'lacrada' (psicologia sem decisão: lacrada para o
--    psicólogo substituto, prazo de 90 dias para a custódia decidir); 'guarda_clinica' (o autor marcou
--    para exportar: acompanha o prontuário, ilegível no aplicativo, sai só no G2).
-- 4. Expurgo das notas descartadas (D1.2): a linha descartada há mais de 30 dias é apagada, salvo
--    retenção legal, SÓ pela função app_purge_discarded_private_notes() (SECURITY DEFINER, idempotente,
--    na clínica do contexto). O runtime continua sem DELETE; o trigger só deixa apagar linha elegível.

-- ------------------------------------------------------------------ 1. sigilo no atendimento

ALTER TABLE encounters ADD COLUMN confidentiality text NOT NULL DEFAULT 'restrito_ao_autor'
  CONSTRAINT encounters_confidentiality_check CHECK (confidentiality IN ('restrito_ao_autor', 'prontuario_unico'));

CREATE OR REPLACE FUNCTION encounters_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  semSigilo encounters;
BEGIN
  IF NEW.confidentiality IS DISTINCT FROM OLD.confidentiality THEN
    -- Só restringe: prontuario_unico -> restrito_ao_autor, e nada mais muda na mesma operação.
    IF NOT (OLD.confidentiality = 'prontuario_unico' AND NEW.confidentiality = 'restrito_ao_autor') THEN
      RAISE EXCEPTION 'sigilo do atendimento só pode ficar mais restrito' USING ERRCODE = 'insufficient_privilege';
    END IF;
    semSigilo := NEW;
    semSigilo.confidentiality := OLD.confidentiality;
    IF semSigilo IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'restringir o sigilo não muda outro campo' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'signed' THEN
    RAISE EXCEPTION 'atendimento finalizado não muda (use adendo)' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.patient_id <> OLD.patient_id OR NEW.professional_id <> OLD.professional_id
     OR NEW.appointment_id <> OLD.appointment_id OR NEW.author_user_id <> OLD.author_user_id
     OR NEW.template <> OLD.template OR NEW.compartment <> OLD.compartment OR NEW.opened_at <> OLD.opened_at THEN
    RAISE EXCEPTION 'identidade do atendimento é imutável' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.current_version < OLD.current_version THEN
    RAISE EXCEPTION 'versão do registro só avança' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- ------------------------------------------------------------------ 2. retenção legal

ALTER TABLE patients ADD COLUMN legal_hold_since timestamptz;

-- ------------------------------------------------------------------ 3. custódia das notas privadas

ALTER TABLE private_notes ADD COLUMN custody_state text NOT NULL DEFAULT 'ativa'
  CONSTRAINT private_notes_custody_check CHECK (custody_state IN ('ativa', 'aguardando_decisao', 'lacrada', 'guarda_clinica'));
ALTER TABLE private_notes ADD COLUMN custody_deadline timestamptz;
ALTER TABLE private_notes ADD CONSTRAINT private_notes_custody_deadline_check
  CHECK ((custody_state IN ('aguardando_decisao', 'lacrada')) = (custody_deadline IS NOT NULL));

CREATE OR REPLACE FUNCTION private_notes_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.patient_id <> OLD.patient_id OR NEW.author_user_id <> OLD.author_user_id
     OR NEW.encounter_id IS DISTINCT FROM OLD.encounter_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'identidade da nota privada é imutável' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.discarded_at IS NOT NULL THEN
    RAISE EXCEPTION 'nota privada descartada não muda' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- Lacrada e guarda da clínica não voltam a ser editáveis pelo aplicativo; só podem ser descartadas
  -- (lacrada: decisão da custódia ou fim do prazo).
  IF OLD.custody_state IN ('lacrada', 'guarda_clinica') AND NEW.custody_state <> OLD.custody_state THEN
    RAISE EXCEPTION 'nota lacrada ou sob guarda não muda de estado' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END;
$$;

-- ------------------------------------------------------------------ 4. expurgo das descartadas

DROP TRIGGER private_notes_no_delete ON private_notes;

CREATE FUNCTION private_notes_delete_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.discarded_at IS NULL OR OLD.discarded_at >= now() - interval '30 days' THEN
    RAISE EXCEPTION 'private_notes: só se apaga nota descartada há mais de 30 dias'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM patients p WHERE p.id = OLD.patient_id AND p.tenant_id = OLD.tenant_id AND p.legal_hold_since IS NOT NULL) THEN
    RAISE EXCEPTION 'private_notes: paciente sob retenção legal' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER private_notes_delete_guard BEFORE DELETE ON private_notes
  FOR EACH ROW EXECUTE FUNCTION private_notes_delete_guard();

-- Idempotente: apaga, na clínica do contexto travado, as notas descartadas há mais de 30 dias de
-- pacientes sem retenção legal, e devolve quantas. Chamar de novo devolve 0.
CREATE FUNCTION app_purge_discarded_private_notes() RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  t uuid := app_current_tenant();
  n integer;
BEGIN
  IF t IS NULL THEN
    RAISE EXCEPTION 'expurgo exige o contexto da clínica' USING ERRCODE = 'insufficient_privilege';
  END IF;
  DELETE FROM private_notes pn
   WHERE pn.tenant_id = t
     AND pn.discarded_at IS NOT NULL
     AND pn.discarded_at < now() - interval '30 days'
     AND NOT EXISTS (
       SELECT 1 FROM patients p WHERE p.id = pn.patient_id AND p.tenant_id = pn.tenant_id AND p.legal_hold_since IS NOT NULL);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION app_purge_discarded_private_notes() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_purge_discarded_private_notes() TO app_user;
