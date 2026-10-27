-- 0037 — Integração da rodada 19: ressalvas novas do portal (#68, conferência de 22/10: N2 e N3) e do
-- WhatsApp (#69, 2º parecer de 22/10: N3 + R3 parcial). Executar com o papel de MIGRAÇÃO (app_migrator).
-- Ver docs/04-arquitetura/api-dominio.md §10c e §13.
--
-- (A) PORTAL N2 — sigilo do adolescente também em cobranças e recebimentos. Com SQL arbitrário na sessão do
--     portal, o responsável lia por `charges` (professional_id, due_date e amount_cents em claro) + a marca
--     `professionals.sensitive_area` o que a policy de `appointments` esconde. Agora, policy RESTRICTIVE
--     `portal_sigilo_adolescente` em `charges`, `payments`, `receipts` e `receipt_cancellations`: com o
--     sigilo valendo (`app_portal_hides_sensitive()`), a linha de área sensível some — profissional da
--     cobrança ou da consulta; desconhecido = sensível (falha fechada). Exceção: o PAGADOR CONGELADO
--     (`payments.guardian_payer_link_id` = vínculo da 0028 da sessão) vê o que pagou (o recibo é dele, IR):
--     no recebimento/recibo, o daquele pagamento; na cobrança, se pagou algum recebimento dela.
--     As funções são SECURITY DEFINER (leem as outras tabelas sem recursão de policy) e a policy deixa o
--     DONO passar (`app_running_as_owner`), como a `portal_fora` de `patient_guardians` (0033).
-- (B) PORTAL N3 — `confidential_from` (dia dos 12) e `represent_until` (dia dos 18) não ficam congelados
--     quando a data de nascimento muda:
--     - conferência no BANCO (falha fechada): mudou `patients.birth_date_enc`, os vínculos/convites abertos de
--       responsável (fora a curatela) passam a esconder JÁ (`confidential_from` <= hoje) e a representação
--       acaba hoje (`represent_until` <= hoje). O banco não lê a data (cifrada);
--     - o SERVIÇO, na mesma transação, recalcula os valores certos pela data nova
--       (`app_portal_recalc_sigilo`, SECURITY DEFINER, só da sessão da clínica), com trilha. Sem data de
--       nascimento, fica fechado (o job revoga a representação vencida).
-- (C) WHATSAPP N3 + R3 parcial — eliminação do paciente (guarda do prontuário vencida, A4 do #67): saem os
--     registros de envio (`whatsapp_outbox`) e as respostas (`whatsapp_inbound`) dele, e o número e o HMAC
--     do opt-in (`recipient_phone_enc/hash`, com `phone_purged_at`); o opt-in vigente é revogado
--     (`eliminacao_do_titular`). A prova do opt-in (comprovante) segue a regra própria (vigente + prazo ⚖️).
--     Só pelo dono (`app_whatsapp_patient_eliminate`), chamado por `app_patient_guardians_eliminate`, que o
--     admin/job já usa para eliminar com o prontuário; o banco confere de novo a guarda e a retenção legal.

-- ================================================================ (A) Portal N2

-- Vínculo da 0028 que a sessão do portal representa (NULL fora do portal ou para o titular).
CREATE FUNCTION app_portal_session_guardian_link() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT l.guardian_link_id FROM public.portal_links l
   WHERE l.tenant_id = public.app_current_tenant() AND l.id = public.app_portal_link()
$$;
REVOKE ALL ON FUNCTION app_portal_session_guardian_link() FROM PUBLIC;

-- A cobrança é de área sensível? Profissional da cobrança ou da consulta; desconhecido = sensível.
CREATE FUNCTION app_portal_charge_sensitive(p_charge uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT COALESCE((
    SELECT pr.id IS NULL OR pr.sensitive_area
      FROM public.charges c
      LEFT JOIN public.appointments a ON a.tenant_id = c.tenant_id AND a.id = c.appointment_id
      LEFT JOIN public.professionals pr ON pr.tenant_id = c.tenant_id AND pr.id = COALESCE(c.professional_id, a.professional_id)
     WHERE c.tenant_id = public.app_current_tenant() AND c.id = p_charge), true)
$$;
REVOKE ALL ON FUNCTION app_portal_charge_sensitive(uuid) FROM PUBLIC;

-- Esconder a COBRANÇA nesta sessão? Sensível e a sessão não é pagadora congelada de nenhum recebimento dela.
CREATE FUNCTION app_portal_charge_hidden(p_charge uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT public.app_portal_charge_sensitive(p_charge)
     AND NOT EXISTS (
       SELECT 1 FROM public.payments p
        WHERE p.tenant_id = public.app_current_tenant() AND p.charge_id = p_charge
          AND p.guardian_payer_link_id IS NOT NULL
          AND p.guardian_payer_link_id = public.app_portal_session_guardian_link())
$$;
REVOKE ALL ON FUNCTION app_portal_charge_hidden(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_portal_charge_hidden(uuid) TO app_user;

-- Esconder o RECEBIMENTO nesta sessão? Cobrança sensível e o pagador congelado DESTE recebimento não é a sessão.
CREATE FUNCTION app_portal_payment_hidden(p_payment uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT COALESCE((
    SELECT public.app_portal_charge_sensitive(p.charge_id)
           AND (p.guardian_payer_link_id IS NULL OR p.guardian_payer_link_id IS DISTINCT FROM public.app_portal_session_guardian_link())
      FROM public.payments p
     WHERE p.tenant_id = public.app_current_tenant() AND p.id = p_payment), true)
$$;
REVOKE ALL ON FUNCTION app_portal_payment_hidden(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_portal_payment_hidden(uuid) TO app_user;

CREATE FUNCTION app_portal_receipt_hidden(p_receipt uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT COALESCE((
    SELECT public.app_portal_payment_hidden(r.payment_id)
      FROM public.receipts r
     WHERE r.tenant_id = public.app_current_tenant() AND r.id = p_receipt), true)
$$;
REVOKE ALL ON FUNCTION app_portal_receipt_hidden(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_portal_receipt_hidden(uuid) TO app_user;

-- Fora do portal (clínica, sistema): nada muda. Dono (funções acima): passa.
CREATE POLICY portal_sigilo_adolescente ON charges AS RESTRICTIVE
  USING (tenant_id = (SELECT app_current_tenant())
         AND ((SELECT app_portal_patient()) IS NULL
              OR (SELECT app_running_as_owner('public.charges'::regclass))
              OR NOT (SELECT app_portal_hides_sensitive())
              OR NOT app_portal_charge_hidden(id)));
CREATE POLICY portal_sigilo_adolescente ON payments AS RESTRICTIVE
  USING (tenant_id = (SELECT app_current_tenant())
         AND ((SELECT app_portal_patient()) IS NULL
              OR (SELECT app_running_as_owner('public.payments'::regclass))
              OR NOT (SELECT app_portal_hides_sensitive())
              OR NOT app_portal_payment_hidden(id)));
CREATE POLICY portal_sigilo_adolescente ON receipts AS RESTRICTIVE
  USING (tenant_id = (SELECT app_current_tenant())
         AND ((SELECT app_portal_patient()) IS NULL
              OR (SELECT app_running_as_owner('public.receipts'::regclass))
              OR NOT (SELECT app_portal_hides_sensitive())
              OR NOT app_portal_payment_hidden(payment_id)));
CREATE POLICY portal_sigilo_adolescente ON receipt_cancellations AS RESTRICTIVE
  USING (tenant_id = (SELECT app_current_tenant())
         AND ((SELECT app_portal_patient()) IS NULL
              OR (SELECT app_running_as_owner('public.receipt_cancellations'::regclass))
              OR NOT (SELECT app_portal_hides_sensitive())
              OR NOT app_portal_receipt_hidden(receipt_id)));

-- ================================================================ (B) Portal N3

-- Recalcula (ou fecha) o sigilo e o fim da representação dos vínculos e convites ABERTOS de responsável do
-- paciente (fora a curatela, em que `represent_until` é NULL). `p_confidential_from`/`p_represent_until` NULL
-- = fecha (hoje). `represent_until` nunca passa do fim da vigência do vínculo da 0028.
CREATE FUNCTION app_portal_recalc_sigilo(p_patient uuid, p_confidential_from date, p_represent_until date) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_tenant uuid := app_current_tenant();
  v_hoje   date := app_fiscal_today();
  v_links  integer;
  v_convs  integer;
BEGIN
  IF v_tenant IS NULL OR app_portal_patient() IS NOT NULL THEN
    RAISE EXCEPTION 'recálculo do sigilo é da sessão da clínica' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM set_config('app.portal_recalc', 'on', true);
  UPDATE portal_links l
     SET confidential_from = COALESCE(p_confidential_from, LEAST(l.confidential_from, v_hoje)),
         represent_until = CASE WHEN p_represent_until IS NULL THEN LEAST(l.represent_until, v_hoje)
                                ELSE LEAST(p_represent_until, COALESCE(g.valid_until, p_represent_until)) END
    FROM patient_guardians g
   WHERE l.tenant_id = v_tenant AND l.patient_id = p_patient AND l.acting_as = 'responsavel_legal'
     AND l.revoked_at IS NULL AND l.represent_until IS NOT NULL
     AND g.tenant_id = l.tenant_id AND g.id = l.guardian_link_id;
  GET DIAGNOSTICS v_links = ROW_COUNT;
  UPDATE portal_invites i
     SET confidential_from = COALESCE(p_confidential_from, LEAST(i.confidential_from, v_hoje)),
         represent_until = CASE WHEN p_represent_until IS NULL THEN LEAST(i.represent_until, v_hoje)
                                ELSE LEAST(p_represent_until, COALESCE(g.valid_until, p_represent_until)) END
    FROM patient_guardians g
   WHERE i.tenant_id = v_tenant AND i.patient_id = p_patient AND i.acting_as = 'responsavel_legal'
     AND i.redeemed_at IS NULL AND i.revoked_at IS NULL AND i.represent_until IS NOT NULL
     AND g.tenant_id = i.tenant_id AND g.id = i.guardian_link_id;
  GET DIAGNOSTICS v_convs = ROW_COUNT;
  PERFORM set_config('app.portal_recalc', 'off', true);
  RETURN v_links + v_convs;
END;
$$;
REVOKE ALL ON FUNCTION app_portal_recalc_sigilo(uuid, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_portal_recalc_sigilo(uuid, date, date) TO app_user;

-- Conferência no banco: data de nascimento mudou = fecha já (o serviço reabre com os valores certos).
CREATE FUNCTION patients_birth_date_portal_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM app_portal_recalc_sigilo(NEW.id, NULL, NULL);
  RETURN NULL;
END;
$$;
CREATE TRIGGER patients_birth_date_portal_guard AFTER UPDATE OF birth_date_enc ON patients
  FOR EACH ROW WHEN (NEW.birth_date_enc IS DISTINCT FROM OLD.birth_date_enc)
  EXECUTE FUNCTION patients_birth_date_portal_guard();

-- Os gatilhos de convite e vínculo (0033) deixam mudar SÓ essas duas colunas, SÓ pelo recálculo (dono +
-- marca da transação), em convite aberto / vínculo ativo. O resto da 0033 fica igual.
CREATE FUNCTION portal_recalc_allowed(p_new jsonb, p_old jsonb, p_table regclass) RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, public
AS $$
  SELECT app_running_as_owner(p_table) AND current_setting('app.portal_recalc', true) = 'on'
     AND (p_new - 'confidential_from' - 'represent_until') = (p_old - 'confidential_from' - 'represent_until')
     AND p_old->>'revoked_at' IS NULL
$$;

CREATE OR REPLACE FUNCTION portal_invites_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := app_current_user();
  g      record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF v_user IS NULL OR app_portal_patient() IS NOT NULL OR NEW.created_by IS DISTINCT FROM v_user THEN
      RAISE EXCEPTION 'convite do portal é emitido pelo usuário da sessão da clínica' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.created_at IS DISTINCT FROM now() OR NEW.redeemed_at IS NOT NULL OR NEW.revoked_at IS NOT NULL OR NEW.link_id IS NOT NULL
       OR NEW.expires_at <= now() THEN
      RAISE EXCEPTION 'convite do portal nasce aberto e válido' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.acting_as = 'responsavel_legal' THEN
      SELECT pg.kind, pg.ended_at, pg.valid_from, pg.valid_until INTO g FROM patient_guardians pg
       WHERE pg.tenant_id = NEW.tenant_id AND pg.id = NEW.guardian_link_id
         AND pg.patient_id = NEW.patient_id AND pg.guardian_id = NEW.guardian_id;
      IF NOT FOUND OR g.ended_at IS NOT NULL OR g.valid_from > app_fiscal_today()
         OR (g.valid_until IS NOT NULL AND g.valid_until <= app_fiscal_today()) THEN
        RAISE EXCEPTION 'convite de responsável exige vínculo de responsável vigente do mesmo paciente' USING ERRCODE = 'check_violation';
      END IF;
      IF g.kind <> 'curador' THEN
        IF NEW.represent_until IS NULL OR NEW.represent_until <= app_fiscal_today()
           OR (g.valid_until IS NOT NULL AND NEW.represent_until > g.valid_until)
           OR EXISTS (SELECT 1 FROM patients p WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.patient_id AND p.emancipated_on IS NOT NULL) THEN
          RAISE EXCEPTION 'responsável no portal só para menor não emancipado (ou curatela)' USING ERRCODE = 'check_violation';
        END IF;
      ELSIF NEW.represent_until IS NOT NULL THEN
        RAISE EXCEPTION 'curatela não tem data de maioridade' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  -- 0037 (N3 do #68): recálculo do sigilo/representação pela data de nascimento, só em convite aberto.
  IF portal_recalc_allowed(to_jsonb(NEW), to_jsonb(OLD), TG_RELID::regclass) AND OLD.redeemed_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash OR NEW.acting_as IS DISTINCT FROM OLD.acting_as
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.guardian_link_id IS DISTINCT FROM OLD.guardian_link_id
     OR NEW.guardian_id IS DISTINCT FROM OLD.guardian_id OR NEW.represent_until IS DISTINCT FROM OLD.represent_until
     OR NEW.confidential_from IS DISTINCT FROM OLD.confidential_from THEN
    RAISE EXCEPTION 'identidade do convite é imutável' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.redeemed_at IS NOT NULL OR OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'convite resgatado ou revogado não muda' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NEW.redeemed_at IS NOT NULL THEN
    IF NOT app_running_as_owner(TG_RELID) OR NEW.revoked_at IS NOT NULL OR NEW.redeemed_at IS DISTINCT FROM now()
       OR OLD.expires_at <= now() THEN
      RAISE EXCEPTION 'convite só é resgatado pela função de resgate, dentro da validade' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.revoked_at IS NOT NULL THEN
    IF v_user IS NULL OR app_portal_patient() IS NOT NULL OR NEW.revoked_by IS DISTINCT FROM v_user OR NEW.revoked_at IS DISTINCT FROM now() THEN
      RAISE EXCEPTION 'convite é revogado pelo usuário da sessão da clínica' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'alteração de convite não permitida' USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE OR REPLACE FUNCTION portal_links_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := app_current_user();
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT app_running_as_owner(TG_RELID) THEN
      RAISE EXCEPTION 'vínculo do portal nasce só do resgate do convite' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.created_at IS DISTINCT FROM now() OR NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'vínculo do portal nasce ativo' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  -- 0037 (N3 do #68): recálculo do sigilo/representação pela data de nascimento, só em vínculo ativo.
  IF portal_recalc_allowed(to_jsonb(NEW), to_jsonb(OLD), TG_RELID::regclass) THEN
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.patient_id IS DISTINCT FROM OLD.patient_id OR NEW.invite_id IS DISTINCT FROM OLD.invite_id
     OR NEW.acting_as IS DISTINCT FROM OLD.acting_as OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.guardian_link_id IS DISTINCT FROM OLD.guardian_link_id OR NEW.guardian_id IS DISTINCT FROM OLD.guardian_id
     OR NEW.represent_until IS DISTINCT FROM OLD.represent_until OR NEW.confidential_from IS DISTINCT FROM OLD.confidential_from THEN
    RAISE EXCEPTION 'identidade do vínculo é imutável' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'vínculo revogado não muda' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NEW.revoke_reason IN ('maioridade_do_titular', 'fim_da_representacao') THEN
    IF NOT app_running_as_owner(TG_RELID) OR NEW.revoked_by IS DISTINCT FROM '00000000-0000-0000-0000-000000000000'::uuid
       OR NEW.revoked_at IS DISTINCT FROM now() OR OLD.acting_as <> 'responsavel_legal' THEN
      RAISE EXCEPTION 'fim da representação é registrado só pelo job do sistema' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF v_user IS NULL OR app_portal_patient() IS NOT NULL OR NEW.revoked_by IS DISTINCT FROM v_user OR NEW.revoked_at IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'vínculo é revogado pelo usuário da sessão da clínica' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

-- ================================================================ (C) WhatsApp N3 + R3 parcial

ALTER TABLE whatsapp_opt_ins ADD COLUMN phone_purged_at timestamptz;
ALTER TABLE whatsapp_opt_ins ALTER COLUMN recipient_phone_enc DROP NOT NULL;
ALTER TABLE whatsapp_opt_ins ALTER COLUMN recipient_phone_hash DROP NOT NULL;
ALTER TABLE whatsapp_opt_ins DROP CONSTRAINT whatsapp_opt_ins_phone_check;
ALTER TABLE whatsapp_opt_ins ADD CONSTRAINT whatsapp_opt_ins_phone_check CHECK (
  (phone_purged_at IS NULL AND recipient_phone_enc IS NOT NULL AND app_is_sealed_field(recipient_phone_enc))
  OR (phone_purged_at IS NOT NULL AND recipient_phone_enc IS NULL));
ALTER TABLE whatsapp_opt_ins DROP CONSTRAINT whatsapp_opt_ins_phone_hash_check;
ALTER TABLE whatsapp_opt_ins ADD CONSTRAINT whatsapp_opt_ins_phone_hash_check CHECK (
  (phone_purged_at IS NULL AND recipient_phone_hash ~ '^[0-9a-f]{64}$')
  OR (phone_purged_at IS NOT NULL AND recipient_phone_hash IS NULL));
ALTER TABLE whatsapp_opt_ins DROP CONSTRAINT whatsapp_opt_ins_revoke_check;
ALTER TABLE whatsapp_opt_ins ADD CONSTRAINT whatsapp_opt_ins_revoke_check CHECK (revoke_method IS NULL OR revoke_method IN
  ('pedido_na_recepcao', 'resposta_sair', 'portal_do_paciente', 'troca_de_destinatario', 'numero_mudou', 'eliminacao_do_titular'));
ALTER TABLE whatsapp_opt_ins DROP CONSTRAINT whatsapp_opt_ins_revoked_check;
ALTER TABLE whatsapp_opt_ins ADD CONSTRAINT whatsapp_opt_ins_revoked_check CHECK (
  (revoked_at IS NULL AND revoke_method IS NULL AND revoked_by IS NULL)
  OR (revoked_at IS NOT NULL AND revoke_method IS NOT NULL
      AND (revoke_method NOT IN ('resposta_sair', 'eliminacao_do_titular') OR revoked_by IS NULL)
      AND (revoke_method IN ('resposta_sair', 'numero_mudou', 'eliminacao_do_titular') OR revoked_by IS NOT NULL)));

-- O gatilho do opt-in (0032) ganha o caminho da eliminação (só o dono, com a marca da transação = paciente).
CREATE OR REPLACE FUNCTION whatsapp_opt_ins_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Verificado no servidor: só um usuário da clínica registra (nunca o sistema, o webhook ou o paciente
    -- pelo canal), com o carimbo do banco, e nasce vigente.
    IF app_current_user() IS NULL OR NEW.granted_by IS DISTINCT FROM app_current_user() THEN
      RAISE EXCEPTION 'opt-in só é registrado pelo usuário da sessão' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.revoked_at IS NOT NULL OR NEW.phone_purged_at IS NOT NULL THEN
      RAISE EXCEPTION 'opt-in nasce vigente' USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- R7 do parecer #69: "pelo portal" só pode vir da sessão do PORTAL (#68), que ainda não tem esse caminho.
    IF NEW.method = 'portal_do_paciente' THEN
      RAISE EXCEPTION 'opt-in pelo portal só pela sessão do portal' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.granted_at := now();
    RETURN NEW;
  END IF;
  -- 0037: eliminação do paciente — apaga número e HMAC (e revoga, se vigente). Nada mais muda.
  IF app_running_as_owner(TG_RELID) AND current_setting('app.whatsapp_eliminacao', true) = OLD.patient_id::text THEN
    IF (to_jsonb(NEW) - 'recipient_phone_enc' - 'recipient_phone_hash' - 'phone_purged_at' - 'revoked_at' - 'revoked_by' - 'revoke_method')
         IS DISTINCT FROM (to_jsonb(OLD) - 'recipient_phone_enc' - 'recipient_phone_hash' - 'phone_purged_at' - 'revoked_at' - 'revoked_by' - 'revoke_method')
       OR NEW.recipient_phone_enc IS NOT NULL OR NEW.recipient_phone_hash IS NOT NULL OR OLD.phone_purged_at IS NOT NULL THEN
      RAISE EXCEPTION 'eliminação do opt-in: só número e HMAC' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.phone_purged_at := now();
    IF OLD.revoked_at IS NULL THEN
      NEW.revoked_at := now();
      NEW.revoked_by := NULL;
      NEW.revoke_method := 'eliminacao_do_titular';
    ELSE
      NEW.revoked_at := OLD.revoked_at;
      NEW.revoked_by := OLD.revoked_by;
      NEW.revoke_method := OLD.revoke_method;
    END IF;
    RETURN NEW;
  END IF;
  -- UPDATE: só a revogação, uma vez.
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'opt-in revogado não muda mais' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
     OR NEW.recipient_kind IS DISTINCT FROM OLD.recipient_kind OR NEW.guardian_id IS DISTINCT FROM OLD.guardian_id
     OR NEW.purpose IS DISTINCT FROM OLD.purpose OR NEW.method IS DISTINCT FROM OLD.method OR NEW.evidence_enc IS DISTINCT FROM OLD.evidence_enc
     OR NEW.recipient_phone_enc IS DISTINCT FROM OLD.recipient_phone_enc OR NEW.recipient_phone_hash IS DISTINCT FROM OLD.recipient_phone_hash
     OR NEW.phone_purged_at IS DISTINCT FROM OLD.phone_purged_at
     OR NEW.granted_at IS DISTINCT FROM OLD.granted_at OR NEW.granted_by IS DISTINCT FROM OLD.granted_by
     OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'opt-in: só a revogação é permitida' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.revoke_method IN ('portal_do_paciente', 'eliminacao_do_titular') THEN
    RAISE EXCEPTION 'revogação por esse meio não é desta sessão' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.revoke_method = 'resposta_sair' OR (NEW.revoke_method = 'numero_mudou' AND NEW.revoked_by IS NULL) THEN
    IF NOT app_is_system_session() THEN
      RAISE EXCEPTION 'revogação pelo canal (ou por número mudado, sem usuário) só pelo sistema' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF app_current_user() IS NULL OR NEW.revoked_by IS DISTINCT FROM app_current_user() THEN
    RAISE EXCEPTION 'revogação registrada pelo usuário da sessão' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.revoked_at := now();
  RETURN NEW;
END;
$$;

-- Fila e respostas: continuam sem DELETE para o runtime; só o dono, na eliminação do paciente.
CREATE FUNCTION whatsapp_reject_delete_unless_eliminating() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND app_running_as_owner(TG_RELID) AND COALESCE(current_setting('app.whatsapp_eliminacao', true), '') <> '' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '%: % não permitido', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;
DROP TRIGGER whatsapp_outbox_no_delete ON whatsapp_outbox;
CREATE TRIGGER whatsapp_outbox_no_delete BEFORE DELETE ON whatsapp_outbox FOR EACH ROW EXECUTE FUNCTION whatsapp_reject_delete_unless_eliminating();
DROP TRIGGER whatsapp_inbound_no_delete ON whatsapp_inbound;
CREATE TRIGGER whatsapp_inbound_no_delete BEFORE DELETE ON whatsapp_inbound FOR EACH ROW EXECUTE FUNCTION whatsapp_reject_delete_unless_eliminating();

-- Eliminação do WhatsApp do paciente (com o prontuário). Confere a guarda e a retenção legal de novo.
CREATE FUNCTION app_whatsapp_patient_eliminate(p_patient uuid) RETURNS TABLE (outbox_deleted integer, inbound_deleted integer, opt_ins_purged integer)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_tenant uuid := app_current_tenant();
  v_out    integer;
  v_in     integer;
  v_opt    integer;
BEGIN
  IF v_tenant IS NULL OR app_portal_patient() IS NOT NULL THEN
    RAISE EXCEPTION 'eliminação exige o contexto da clínica' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM patients p WHERE p.tenant_id = v_tenant AND p.id = p_patient AND p.legal_hold_since IS NOT NULL) THEN
    RAISE EXCEPTION 'paciente sob retenção legal' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF app_patient_record_retention_until(v_tenant, p_patient) > app_fiscal_today() THEN
    RAISE EXCEPTION 'guarda do prontuário ainda não venceu' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  PERFORM set_config('app.whatsapp_eliminacao', p_patient::text, true);
  DELETE FROM whatsapp_inbound i
   USING whatsapp_outbox o
   WHERE i.tenant_id = v_tenant AND o.tenant_id = i.tenant_id AND o.id = i.outbox_id AND o.patient_id = p_patient;
  GET DIAGNOSTICS v_in = ROW_COUNT;
  DELETE FROM whatsapp_outbox o WHERE o.tenant_id = v_tenant AND o.patient_id = p_patient;
  GET DIAGNOSTICS v_out = ROW_COUNT;
  UPDATE whatsapp_opt_ins SET recipient_phone_enc = NULL, recipient_phone_hash = NULL
   WHERE tenant_id = v_tenant AND patient_id = p_patient AND phone_purged_at IS NULL;
  GET DIAGNOSTICS v_opt = ROW_COUNT;
  PERFORM set_config('app.whatsapp_eliminacao', '', true);
  RETURN QUERY SELECT v_out, v_in, v_opt;
END;
$$;
REVOKE ALL ON FUNCTION app_whatsapp_patient_eliminate(uuid) FROM PUBLIC;

-- A eliminação com o prontuário (0034) passa a levar o WhatsApp do paciente junto, na mesma transação.
CREATE OR REPLACE FUNCTION app_patient_guardians_eliminate(p_patient uuid) RETURNS TABLE (links_eliminated integer, guardians_discarded integer)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_tenant uuid := app_current_tenant();
  v_links  integer;
  v_people integer;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'eliminação exige o contexto de tenant' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT (app_is_system_session() OR (app_current_user() IS NOT NULL AND app_user_has_role(app_current_user(), 'admin'))) THEN
    RAISE EXCEPTION 'eliminação é do dono da clínica (ou do job do sistema)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- 0037 (N3 + R3 do 2º parecer do #69): envios, respostas e número/HMAC do opt-in do paciente. Antes dos
  -- vínculos: a guarda é conferida sem os eventos que a própria eliminação grava.
  PERFORM * FROM app_whatsapp_patient_eliminate(p_patient);
  UPDATE patient_guardians
     SET eliminated_at = now(), clinical_info_basis_enc = NULL, court_decision_ref_enc = NULL,
         curatorship_scope_enc = NULL, annul_reason_enc = NULL
   WHERE tenant_id = v_tenant AND patient_id = p_patient AND eliminated_at IS NULL;
  GET DIAGNOSTICS v_links = ROW_COUNT;
  UPDATE guardians g
     SET name_enc = NULL, cpf_enc = NULL, phone_enc = NULL, discarded_at = now()
   WHERE g.tenant_id = v_tenant AND g.discarded_at IS NULL
     AND g.id IN (SELECT v.guardian_id FROM patient_guardians v WHERE v.tenant_id = v_tenant AND v.patient_id = p_patient)
     AND app_guardian_discardable(g.tenant_id, g.id);
  GET DIAGNOSTICS v_people = ROW_COUNT;
  UPDATE patient_guardian_history h
     SET prev_name_enc = NULL, prev_cpf_enc = NULL, prev_phone_enc = NULL
    FROM guardians g
   WHERE h.tenant_id = v_tenant AND g.tenant_id = h.tenant_id AND g.id = h.guardian_id AND g.discarded_at IS NOT NULL
     AND (h.prev_name_enc IS NOT NULL OR h.prev_cpf_enc IS NOT NULL OR h.prev_phone_enc IS NOT NULL);
  RETURN QUERY SELECT v_links, v_people;
END;
$$;

-- Funções SECURITY DEFINER desta migração: dono sem superpoder e diferente do runtime.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS f, p.prosecdef, o.rolname, o.rolsuper, o.rolbypassrls
      FROM pg_proc p JOIN pg_roles o ON o.oid = p.proowner
     WHERE p.oid IN ('app_portal_session_guardian_link()'::regprocedure, 'app_portal_charge_sensitive(uuid)'::regprocedure,
                     'app_portal_charge_hidden(uuid)'::regprocedure, 'app_portal_payment_hidden(uuid)'::regprocedure,
                     'app_portal_receipt_hidden(uuid)'::regprocedure, 'app_portal_recalc_sigilo(uuid,date,date)'::regprocedure,
                     'app_whatsapp_patient_eliminate(uuid)'::regprocedure, 'app_patient_guardians_eliminate(uuid)'::regprocedure)
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
