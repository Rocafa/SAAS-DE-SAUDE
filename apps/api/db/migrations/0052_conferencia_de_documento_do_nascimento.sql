-- 0052 — C1-b′ da conferência C1–C5 (24/10/2026): a conferência de documento trava a MUDANÇA da data, não só o
-- status do pedido. Executar com o papel de MIGRAÇÃO (app_migrator). Ver docs/04-arquitetura/api-dominio.md
-- §10d e §10h e docs/03-seguranca-lgpd/revisoes/2026-10-24-front-vetos.md ("Conferência C1–C5").
--
-- (1) `portal_rights_requests.document_required`: decidido NA ABERTURA do pedido de correção, contra a data
--     vigente naquele momento (a API decifra e aplica `correcaoDeNascimentoExigeDocumento`). Imutável depois
--     (gatilho da 0051). Sem valor na gravação: falha fechada (exige quando há data proposta). Atender pedido
--     com `document_required` exige a conferência gravada (`document_checked_at`), mesmo que o cadastro já
--     tenha sido alterado antes pelo PATCH (fecha o contorno "corrige o cadastro e depois atende").
-- (2) `PATCH /pacientes/:id`: reduzir a idade de paciente com 12 anos ou mais exige documento conferido. A data
--     é cifrada, então a regra completa é da API. O banco trava o que consegue ver: no recálculo da 0038/0039
--     (que recebe o dia dos 12 e o dos 18 em claro), empurrar para depois o dia dos 12 de um vínculo/convite
--     de responsável cujo sigilo JÁ VALIA (= reduzir a idade de quem hoje tem 12+, ou de data desconhecida,
--     que a 0038 fechou com sigilo = hoje) exige a marca de conferência DESTA transação, posta por
--     `app_patient_birth_date_document_checked` na marca da mudança da data (a mesma tabela INTERNA da 0038,
--     que o runtime não grava direto; uma GUC poderia ser forjada por `set_config`). A marca tem o usuário da
--     sessão, some no COMMIT junto com a da 0038 e é zerada se a data mudar de novo depois da conferência.
--     Sem recálculo, a 0038 fecha (sigilo liga, representação acaba): a direção segura não exige nada.
--     Limite: paciente sem vínculo/convite de responsável aberto não tem o que o banco comparar; aí vale só a API.

-- ================================================================ (1) document_required no pedido

ALTER TABLE portal_rights_requests ADD COLUMN document_required boolean;
UPDATE portal_rights_requests SET document_required = (birth_date_proposed_enc IS NOT NULL);  -- falha fechada
ALTER TABLE portal_rights_requests
  ALTER COLUMN document_required SET NOT NULL,
  ADD CONSTRAINT portal_rights_requests_document_required_check
    CHECK (NOT document_required OR birth_date_proposed_enc IS NOT NULL);

-- Gatilho da 0051 com `document_required` (preenchido na abertura se vier nulo; imutável) e a exigência da
-- conferência para ATENDER.
CREATE OR REPLACE FUNCTION portal_rights_requests_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := app_current_user();
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF app_portal_patient() IS NULL OR NEW.patient_id IS DISTINCT FROM app_portal_patient()
       OR NEW.link_id IS DISTINCT FROM app_portal_link() OR NEW.account_id IS DISTINCT FROM app_portal_account() THEN
      RAISE EXCEPTION 'pedido do titular é aberto pela sessão do portal' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.created_at IS DISTINCT FROM now() OR NEW.status <> 'aberta' OR NEW.handled_by IS NOT NULL OR NEW.answer_enc IS NOT NULL
       OR NEW.document_checked_by IS NOT NULL OR NEW.document_checked_at IS NOT NULL
       OR NEW.acting_as IS DISTINCT FROM
          (SELECT l.acting_as FROM portal_links l WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.link_id AND l.revoked_at IS NULL) THEN
      RAISE EXCEPTION 'pedido do titular nasce aberto, no vínculo ativo' USING ERRCODE = 'check_violation';
    END IF;
    -- C1-b′ (0052): sem decisão da API, falha fechada (com data proposta, exige documento).
    NEW.document_required := COALESCE(NEW.document_required, NEW.birth_date_proposed_enc IS NOT NULL);
    -- Teto diário por vínculo (A3c do #68). Trava o vínculo para a contagem não correr.
    PERFORM pg_advisory_xact_lock(hashtextextended('portal_rights:' || NEW.link_id::text, 0));
    IF (SELECT count(*) FROM portal_rights_requests r
         WHERE r.tenant_id = NEW.tenant_id AND r.link_id = NEW.link_id AND r.created_at > now() - interval '1 day') >= 5 THEN
      RAISE EXCEPTION 'teto diário de pedidos do titular atingido' USING ERRCODE = 'program_limit_exceeded';
    END IF;
    -- V1: qual responsável agiu sai do vínculo (nunca de quem grava).
    NEW.guardian_id := (SELECT l.guardian_id FROM portal_links l WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.link_id);
    NEW.due_at := NEW.created_at + interval '15 days';
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
     OR NEW.link_id IS DISTINCT FROM OLD.link_id OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.acting_as IS DISTINCT FROM OLD.acting_as OR NEW.protocol IS DISTINCT FROM OLD.protocol
     OR NEW.detail_enc IS DISTINCT FROM OLD.detail_enc OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.due_at IS DISTINCT FROM OLD.due_at OR NEW.guardian_id IS DISTINCT FROM OLD.guardian_id
     OR NEW.birth_date_proposed_enc IS DISTINCT FROM OLD.birth_date_proposed_enc
     OR NEW.document_required IS DISTINCT FROM OLD.document_required THEN
    RAISE EXCEPTION 'pedido do titular: identidade e detalhe são imutáveis' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_user IS NULL OR app_portal_patient() IS NOT NULL OR NEW.handled_by IS DISTINCT FROM v_user OR NEW.handled_at IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'só o usuário da sessão da clínica atende o pedido' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status IN ('atendida', 'recusada') THEN
    RAISE EXCEPTION 'pedido encerrado não muda' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NOT ((OLD.status = 'aberta' AND NEW.status IN ('em_andamento', 'atendida', 'recusada'))
          OR (OLD.status = 'em_andamento' AND NEW.status IN ('atendida', 'recusada'))) THEN
    RAISE EXCEPTION 'transição de pedido do titular inválida' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IN ('atendida', 'recusada') AND NEW.answer_enc IS NULL THEN
    RAISE EXCEPTION 'pedido atendido ou recusado exige resposta ao titular' USING ERRCODE = 'check_violation';
  END IF;
  -- C1: conferência do documento da data proposta: uma vez, pelo usuário da sessão, agora; depois imutável.
  IF OLD.document_checked_at IS NOT NULL THEN
    IF NEW.document_checked_by IS DISTINCT FROM OLD.document_checked_by OR NEW.document_checked_at IS DISTINCT FROM OLD.document_checked_at THEN
      RAISE EXCEPTION 'conferência de documento do pedido é imutável' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NEW.document_checked_at IS NOT NULL
        AND (NEW.document_checked_by IS DISTINCT FROM v_user OR NEW.document_checked_at IS DISTINCT FROM now()) THEN
    RAISE EXCEPTION 'conferência de documento: autor e hora são da sessão da clínica' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- C1-b′ (0052): atender pedido que exigia documento só com a conferência gravada.
  IF NEW.status = 'atendida' AND NEW.document_required AND NEW.document_checked_at IS NULL THEN
    RAISE EXCEPTION 'pedido de correção de nascimento exige documento conferido para ser atendido' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- ================================================================ (2) conferência na mudança da data

ALTER TABLE portal_birth_date_changes ADD COLUMN document_checked_by uuid;

-- Marca da mudança (0039) + a conferência zera quando a data muda de novo na mesma transação.
CREATE OR REPLACE FUNCTION patients_birth_date_mark() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  INSERT INTO portal_birth_date_changes (tenant_id, patient_id, xact, prev_enc, last_enc)
    VALUES (NEW.tenant_id, NEW.id, txid_current(), OLD.birth_date_enc, NEW.birth_date_enc)
    ON CONFLICT (tenant_id, patient_id, xact) DO UPDATE
      SET last_enc = EXCLUDED.last_enc, consumed = false, document_checked_by = NULL;
  RETURN NULL;
END;
$$;

-- Pública (serviço da clínica): "o documento da data nova foi conferido por quem está na sessão". Só na
-- transação que mudou a data (depois do UPDATE, antes do recálculo). Grava a trilha (sem a data).
CREATE FUNCTION app_patient_birth_date_document_checked(p_patient uuid) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_tenant uuid := app_current_tenant();
  v_user   uuid := app_current_user();
BEGIN
  IF v_tenant IS NULL OR app_portal_patient() IS NOT NULL OR v_user IS NULL THEN
    RAISE EXCEPTION 'conferência de documento é do usuário da sessão da clínica' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE portal_birth_date_changes SET document_checked_by = v_user
   WHERE tenant_id = v_tenant AND patient_id = p_patient AND xact = txid_current() AND NOT consumed;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'conferência de documento só na transação que mudou a data de nascimento, antes do recálculo'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  INSERT INTO audit_log (tenant_id, actor_id, action, scope, metadata)
    VALUES (v_tenant, v_user, 'update', 'patients',
            jsonb_build_object('op', 'birth_date_document_checked', 'patient_id', p_patient, 'document_checked', true));
END;
$$;
REVOKE ALL ON FUNCTION app_patient_birth_date_document_checked(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_patient_birth_date_document_checked(uuid) TO app_user;

-- Recálculo da 0039 + a trava: empurrar para depois o dia dos 12 de vínculo/convite cujo sigilo já valia exige
-- a conferência desta transação.
CREATE OR REPLACE FUNCTION app_portal_recalc_sigilo(p_patient uuid, p_confidential_from date, p_represent_until date) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_tenant uuid := app_current_tenant();
  v_hoje   date := app_fiscal_today();
  v_seis   date;
  v_doc    uuid;
BEGIN
  IF v_tenant IS NULL OR app_portal_patient() IS NOT NULL OR app_current_user() IS NULL THEN
    RAISE EXCEPTION 'recálculo do sigilo é do usuário da sessão da clínica' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (p_confidential_from IS NULL) <> (p_represent_until IS NULL) THEN
    RAISE EXCEPTION 'sigilo e fim da representação vêm juntos (ou os dois nulos, para fechar)' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_confidential_from IS NOT NULL THEN
    v_seis := (p_confidential_from + interval '6 years')::date;
    IF p_represent_until NOT BETWEEN v_seis - 1 AND v_seis + 1 THEN
      RAISE EXCEPTION 'datas não correspondem a uma data de nascimento' USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;
  UPDATE portal_birth_date_changes SET consumed = true
   WHERE tenant_id = v_tenant AND patient_id = p_patient AND xact = txid_current() AND NOT consumed
   RETURNING document_checked_by INTO v_doc;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'recálculo do sigilo/representação só na transação que mudou a data de nascimento' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_confidential_from IS NOT NULL AND v_doc IS NULL AND EXISTS (
       SELECT 1 FROM portal_links l
        WHERE l.tenant_id = v_tenant AND l.patient_id = p_patient AND l.acting_as = 'responsavel_legal'
          AND l.revoked_at IS NULL AND l.represent_until IS NOT NULL
          AND l.confidential_from <= v_hoje AND p_confidential_from > l.confidential_from
       UNION ALL
       SELECT 1 FROM portal_invites i
        WHERE i.tenant_id = v_tenant AND i.patient_id = p_patient AND i.acting_as = 'responsavel_legal'
          AND i.redeemed_at IS NULL AND i.revoked_at IS NULL AND i.represent_until IS NOT NULL
          AND i.confidential_from <= v_hoje AND p_confidential_from > i.confidential_from) THEN
    RAISE EXCEPTION 'reduzir a idade de paciente com 12 anos ou mais exige documento conferido' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN app_portal_sigilo_aplicar(v_tenant, p_patient, p_confidential_from, p_represent_until,
                                   CASE WHEN p_confidential_from IS NULL THEN 'birth_date_cleared' ELSE 'birth_date_changed' END);
END;
$$;

-- ================================================================ conferência final

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS f, p.prosecdef, o.rolname, o.rolsuper, o.rolbypassrls
      FROM pg_proc p JOIN pg_roles o ON o.oid = p.proowner
     WHERE p.oid IN ('app_patient_birth_date_document_checked(uuid)'::regprocedure,
                     'app_portal_recalc_sigilo(uuid,date,date)'::regprocedure,
                     'patients_birth_date_mark()'::regprocedure)
  LOOP
    IF NOT r.prosecdef THEN
      RAISE EXCEPTION '% deveria ser SECURITY DEFINER', r.f;
    END IF;
    IF r.rolsuper OR r.rolbypassrls OR r.rolname = 'app_user' THEN
      RAISE EXCEPTION 'dono de % (%) não pode ser superusuário, BYPASSRLS nem o runtime', r.f, r.rolname;
    END IF;
  END LOOP;
END;
$$;
