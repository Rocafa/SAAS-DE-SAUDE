-- 0033 — Portal do paciente: correção do veto V2 e das ressalvas A2 (preparo), A3, A4 do parecer
-- docs/03-seguranca-lgpd/revisoes/2026-10-20-portal.md (PR #68). Executar com o papel de MIGRAÇÃO (app_migrator).
-- Ver docs/04-arquitetura/api-dominio.md §10.
--
-- NUMERAÇÃO: 0028/0031 são dos responsáveis legais (outra branch) e 0032 do WhatsApp. Esta não depende delas.

-- ================================================================ V2. sessão do portal: trilha e chaves
--
-- Antes (0027:297-305): na sessão do portal, `audit_log` era legível por inteiro (tenant só) e as chaves de
-- dados aceitavam INSERT/UPDATE. Agora, com SQL arbitrário dentro da transação do portal:
--   - audit_log: SELECT devolve ZERO linhas (nem as do próprio paciente; o titular vê a própria trilha por
--     pedido de acesso, art. 18 II, atendido pela clínica). INSERT continua: toda ação do portal é auditada.
--     O gatilho da cadeia (invocador) lê o último elo por `app_audit_chain_tail`, SECURITY DEFINER com
--     search_path fixo, que devolve só (seq, hash) do elo final da clínica do contexto e só de dentro de
--     um gatilho (pg_trigger_depth() > 0): chamada direta devolve vazio.
--   - tenant_master_keys / tenant_data_keys: só leitura (decifrar/cifrar o próprio dado). INSERT recusado
--     (o portal não provisiona nem gira chave: falha e a clínica provisiona) e UPDATE recusado, exceto somar
--     o contador de uso da DEK (encrypt_count só cresce, em lote limitado), que a cifragem faz em lotes.

-- Último elo da cadeia da clínica do contexto, para o gatilho `audit_log_chain` (que roda como invocador).
CREATE FUNCTION app_audit_chain_tail(p_tenant uuid, OUT seq bigint, OUT hash text)
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT a.seq, a.hash
    FROM public.audit_log a
   WHERE a.tenant_id = p_tenant
     AND p_tenant = public.app_current_tenant()
     AND pg_catalog.pg_trigger_depth() > 0
     AND a.seq IS NOT NULL
   ORDER BY a.seq DESC
   LIMIT 1
$$;
REVOKE ALL ON FUNCTION app_audit_chain_tail(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_audit_chain_tail(uuid) TO app_user;

-- Mesma trigger da 0008, lendo o último elo pela função acima (o resto é idêntico).
CREATE OR REPLACE FUNCTION audit_log_chain() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_seq  bigint;
  v_hash text;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'audit_log exige transação READ COMMITTED (a cadeia de hash lê o último elo)'
      USING ERRCODE = 'feature_not_supported';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('audit_chain:' || NEW.tenant_id::text, 0));

  SELECT t.seq, t.hash INTO v_seq, v_hash FROM public.app_audit_chain_tail(NEW.tenant_id) t;

  IF NEW.seq IS NOT NULL OR NEW.prev_hash IS NOT NULL OR NEW.hash IS NOT NULL THEN
    IF NOT pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = TG_RELID), 'MEMBER') THEN
      RAISE EXCEPTION 'seq/prev_hash/hash de audit_log são definidos pelo banco'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.seq IS DISTINCT FROM COALESCE(v_seq, 0) + 1
       OR NEW.prev_hash IS DISTINCT FROM COALESCE(v_hash, repeat('0', 64))
       OR NEW.hash IS DISTINCT FROM encode(sha256(convert_to(audit_log_canonical(NEW), 'UTF8')), 'hex') THEN
      RAISE EXCEPTION 'linha de audit_log não continua a cadeia da clínica'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.actor_kind IS NULL THEN
    NEW.actor_kind := CASE WHEN NEW.actor_id = '00000000-0000-0000-0000-000000000000'::uuid
                           THEN 'sistema' ELSE 'usuario_clinica' END;
  END IF;

  NEW.created_at := now();
  NEW.seq := COALESCE(v_seq, 0) + 1;
  NEW.prev_hash := COALESCE(v_hash, repeat('0', 64));
  NEW.hash := encode(sha256(convert_to(audit_log_canonical(NEW), 'UTF8')), 'hex');
  RETURN NEW;
END;
$$;

-- Trilha: na sessão do portal, nenhuma linha (exceto para o dono, i.e. dentro de app_audit_chain_tail).
DROP POLICY portal_liberada_select ON audit_log;
CREATE POLICY portal_fora_select ON audit_log AS RESTRICTIVE FOR SELECT
  USING (tenant_id = (SELECT app_current_tenant())
         AND ((SELECT app_portal_patient()) IS NULL OR (SELECT app_running_as_owner('public.audit_log'::regclass))));

-- Chaves: leitura liberada; INSERT só fora do portal; UPDATE conferido pelo gatilho abaixo.
DROP POLICY portal_liberada ON tenant_data_keys;
DROP POLICY portal_liberada ON tenant_master_keys;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_data_keys', 'tenant_master_keys'] LOOP
    EXECUTE format('CREATE POLICY portal_liberada_select ON %I AS RESTRICTIVE FOR SELECT '
      'USING (tenant_id = (SELECT app_current_tenant()))', t);
    EXECUTE format('CREATE POLICY portal_fora_insert ON %I AS RESTRICTIVE FOR INSERT '
      'WITH CHECK (tenant_id = (SELECT app_current_tenant()) AND (SELECT app_portal_patient()) IS NULL)', t);
    EXECUTE format('CREATE POLICY portal_liberada_update ON %I AS RESTRICTIVE FOR UPDATE '
      'USING (tenant_id = (SELECT app_current_tenant())) WITH CHECK (tenant_id = (SELECT app_current_tenant()))', t);
  END LOOP;
END;
$$;

-- Na sessão do portal: nada de criar ou alterar chave; da DEK só o contador de uso cresce (lote <= 4096).
CREATE FUNCTION tenant_keys_portal_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF app_portal_patient() IS NULL THEN
    RETURN NEW;
  END IF;
  -- Via jsonb (o gatilho serve às duas tabelas e só a DEK tem encrypt_count).
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'tenant_data_keys' THEN
    IF (to_jsonb(NEW) - 'encrypt_count') = (to_jsonb(OLD) - 'encrypt_count')
       AND (to_jsonb(NEW) ->> 'encrypt_count')::bigint - (to_jsonb(OLD) ->> 'encrypt_count')::bigint BETWEEN 1 AND 4096 THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION '%: % não permitido na sessão do portal', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER zz_tenant_master_keys_portal_guard BEFORE INSERT OR UPDATE ON tenant_master_keys
  FOR EACH ROW EXECUTE FUNCTION tenant_keys_portal_guard();
CREATE TRIGGER zz_tenant_data_keys_portal_guard BEFORE INSERT OR UPDATE ON tenant_data_keys
  FOR EACH ROW EXECUTE FUNCTION tenant_keys_portal_guard();

-- ================================================================ A4. paciente inativo perde o portal
--
-- Antes (0027:325-329) só o resgate conferia `patients.active`. Agora a própria abertura da sessão do
-- portal confere, depois de travar o contexto (o RLS do dono enxerga só o paciente do vínculo): paciente
-- inativo = 42501, igual a vínculo revogado (a API responde 403 vinculo_inativo). Reativar devolve o acesso;
-- a revogação definitiva do vínculo continua sendo ato da clínica (motivo fim_do_vinculo).
CREATE OR REPLACE FUNCTION app_set_portal_session(p_account uuid, p_link uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_xid bigint := txid_current();
  v     record;
  c     record;
BEGIN
  IF p_account IS NULL OR p_link IS NULL THEN
    RAISE EXCEPTION 'sessão do portal incompleta' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT tenant_id, patient_id INTO v FROM public.portal_link_index
   WHERE link_id = p_link AND account_id = p_account AND revoked_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'vínculo do portal inexistente, revogado ou de outra conta' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO c FROM public.tenant_context WHERE xid = v_xid;
  IF FOUND THEN
    IF c.portal_link_id IS NOT DISTINCT FROM p_link AND c.portal_account_id IS NOT DISTINCT FROM p_account THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'contexto já definido nesta transação' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.tenant_context (xid, tenant_id, user_id, portal_account_id, portal_link_id, portal_patient_id)
    VALUES (v_xid, v.tenant_id, '00000000-0000-0000-0000-000000000000'::uuid, p_account, p_link, v.patient_id);
  IF NOT EXISTS (SELECT 1 FROM public.patients p WHERE p.tenant_id = v.tenant_id AND p.id = v.patient_id AND p.active) THEN
    RAISE EXCEPTION 'paciente inativo: portal indisponível' USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;

-- ================================================================ A3. pedidos do titular
--
-- (a) LGPD art. 18 §4º e art. 19: recusa e atendimento comunicam as razões ou o resultado. Resposta
--     (cifrada) obrigatória nos dois estados finais, no banco e no serviço.
-- (b) Aviso aos admins ativos da clínica a cada pedido novo (clinical_notices `pedido_titular_aberto`, só o
--     id do pedido; nada do paciente nem do texto). Gravado pela API numa transação de SISTEMA da clínica
--     logo depois do pedido (a sessão do portal não vê a equipe): o gatilho dos avisos aceita o sentinela de
--     sistema só para este tipo. O atraso aparece na lista da clínica (`atrasado`).
-- (c) Teto diário: no máximo 5 pedidos por vínculo (conta + paciente) em 24 h. A API responde 429 e grava
--     UM anomaly_alert; o gatilho é a segunda barreira (SQL direto na sessão do portal).
ALTER TABLE portal_rights_requests
  ADD CONSTRAINT portal_rights_requests_answer_required_check
  CHECK (status NOT IN ('atendida', 'recusada') OR answer_enc IS NOT NULL);

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
       OR NEW.acting_as IS DISTINCT FROM
          (SELECT l.acting_as FROM portal_links l WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.link_id AND l.revoked_at IS NULL) THEN
      RAISE EXCEPTION 'pedido do titular nasce aberto, no vínculo ativo' USING ERRCODE = 'check_violation';
    END IF;
    -- Teto diário por vínculo (A3c do #68). Trava o vínculo para a contagem não correr.
    PERFORM pg_advisory_xact_lock(hashtextextended('portal_rights:' || NEW.link_id::text, 0));
    IF (SELECT count(*) FROM portal_rights_requests r
         WHERE r.tenant_id = NEW.tenant_id AND r.link_id = NEW.link_id AND r.created_at > now() - interval '1 day') >= 5 THEN
      RAISE EXCEPTION 'teto diário de pedidos do titular atingido' USING ERRCODE = 'program_limit_exceeded';
    END IF;
    NEW.due_at := NEW.created_at + interval '15 days';
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
     OR NEW.link_id IS DISTINCT FROM OLD.link_id OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.acting_as IS DISTINCT FROM OLD.acting_as OR NEW.protocol IS DISTINCT FROM OLD.protocol
     OR NEW.detail_enc IS DISTINCT FROM OLD.detail_enc OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.due_at IS DISTINCT FROM OLD.due_at THEN
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
  RETURN NEW;
END;
$$;

-- (b) aviso aos admins: novo tipo, com o id do pedido (FK composta, mesma clínica).
ALTER TABLE portal_rights_requests ADD CONSTRAINT portal_rights_requests_id_tenant_key UNIQUE (id, tenant_id);
ALTER TABLE clinical_notices DROP CONSTRAINT clinical_notices_kind_check;
ALTER TABLE clinical_notices DROP CONSTRAINT clinical_notices_shape_check;
ALTER TABLE clinical_notices
  ADD COLUMN rights_request_id uuid,
  ADD CONSTRAINT clinical_notices_rights_request_fk FOREIGN KEY (rights_request_id, tenant_id)
    REFERENCES portal_rights_requests (id, tenant_id),
  ADD CONSTRAINT clinical_notices_kind_check CHECK (kind IN (
    'sigilo_psicologia_alterado', 'perfil_alterado', 'retencao_retirada_pedida', 'retencao_retirada_aprovada',
    'pedido_titular_aberto')),
  ADD CONSTRAINT clinical_notices_shape_check CHECK (
    CASE kind
      WHEN 'sigilo_psicologia_alterado' THEN
        from_mode IS NOT NULL AND to_mode IS NOT NULL
        AND subject_user_id IS NULL AND subject_role IS NULL AND change IS NULL AND legal_hold_id IS NULL
        AND rights_request_id IS NULL
      WHEN 'perfil_alterado' THEN
        from_mode IS NULL AND to_mode IS NULL AND restricted_existing = 0
        AND subject_user_id IS NOT NULL AND subject_role IS NOT NULL AND change IS NOT NULL AND legal_hold_id IS NULL
        AND rights_request_id IS NULL
      WHEN 'pedido_titular_aberto' THEN
        from_mode IS NULL AND to_mode IS NULL AND restricted_existing = 0
        AND subject_user_id IS NULL AND subject_role IS NULL AND change IS NULL AND legal_hold_id IS NULL
        AND rights_request_id IS NOT NULL
      ELSE
        from_mode IS NULL AND to_mode IS NULL AND restricted_existing = 0
        AND subject_user_id IS NULL AND subject_role IS NULL AND change IS NULL AND legal_hold_id IS NOT NULL
        AND rights_request_id IS NULL
    END);

-- Mesmo gatilho da 0017, com uma exceção: a transação de SISTEMA da clínica (sentinela, fora do portal)
-- cria o aviso `pedido_titular_aberto` (created_by = sentinela). Nenhum outro tipo aceita o sistema.
CREATE OR REPLACE FUNCTION clinical_notices_guard() RETURNS trigger
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
    IF NEW.kind = 'pedido_titular_aberto' THEN
      IF NOT app_is_system_session() OR app_portal_patient() IS NOT NULL
         OR NEW.created_by IS DISTINCT FROM '00000000-0000-0000-0000-000000000000'::uuid OR NEW.read_at IS NOT NULL THEN
        RAISE EXCEPTION 'aviso de pedido do titular é criado pelo sistema e nasce não lido' USING ERRCODE = 'insufficient_privilege';
      END IF;
      RETURN NEW;
    END IF;
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
