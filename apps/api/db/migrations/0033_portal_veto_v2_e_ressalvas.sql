-- 0033 — Portal do paciente: correção do veto V2 e das ressalvas A2 (preparo), A3, A4 do parecer
-- docs/03-seguranca-lgpd/revisoes/2026-10-20-portal.md (PR #68). Executar com o papel de MIGRAÇÃO (app_migrator).
-- Ver docs/04-arquitetura/api-dominio.md §10.
--
-- NUMERAÇÃO E DEPENDÊNCIAS: 0028/0031 são dos responsáveis legais e 0032 do WhatsApp (outra branch). Esta
-- migração DEPENDE de 0028 e 0031 (seção V1: FKs para `patient_guardians`/`guardians`, vigência, curatela e
-- emancipação); aplique-as antes. Não depende da 0032.
--
-- HISTÓRICO (R7 do parecer 2026-10-22-pr68): o commit 529490e, publicado com a mensagem "wip: trabalho em
-- andamento salvo antes da retomada", é o MERGE DA FASE B (V1: responsável legal no portal sobre 0028/0031).
-- Já publicado, não será reescrito; este registro faz as vezes da mensagem descritiva.

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
  -- V1 (seção V1 abaixo): responsável legal só enquanto a representação vale HOJE.
  IF NOT public.app_portal_representation_ok(v.tenant_id, p_link) THEN
    RAISE EXCEPTION 'representação do responsável encerrada: portal indisponível' USING ERRCODE = 'insufficient_privilege';
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
    -- V1: qual responsável agiu sai do vínculo (nunca de quem grava).
    NEW.guardian_id := (SELECT l.guardian_id FROM portal_links l WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.link_id);
    NEW.due_at := NEW.created_at + interval '15 days';
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
     OR NEW.link_id IS DISTINCT FROM OLD.link_id OR NEW.account_id IS DISTINCT FROM OLD.account_id OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.acting_as IS DISTINCT FROM OLD.acting_as OR NEW.protocol IS DISTINCT FROM OLD.protocol
     OR NEW.detail_enc IS DISTINCT FROM OLD.detail_enc OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.due_at IS DISTINCT FROM OLD.due_at OR NEW.guardian_id IS DISTINCT FROM OLD.guardian_id THEN
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

-- ================================================================ A2 (preparo). o token sozinho não prova identidade
--
-- O resgate passa a ter DOIS passos, os dois por funções SECURITY DEFINER sem contexto prévio:
--   1. `app_portal_invite_challenge(conta, hash_do_token, hash_do_codigo)`: confere o convite (aberto, válido,
--      paciente ativo, com telefone no cadastro), guarda o HASH de um código de uso único ligado à CONTA e ao
--      convite (10 min, 5 tentativas, no máximo 5 envios por convite) e devolve o telefone CIFRADO do
--      cadastro para a API decifrar e enviar o código pela porta de OTP (dev/test em memória; envio real
--      com a D4). O destino é sempre o do cadastro da clínica, nunca um informado por quem resgata.
--   2. `app_portal_redeem_invite(conta, hash_do_token, hash_do_codigo)`: só resgata com o código certo, da
--      mesma conta, dentro do prazo. Código errado conta tentativa. A versão antiga (só o token) é removida.
-- O hash do código é HMAC-SHA256 com o próprio token como chave (calculado na API): o banco não guarda nada
-- que, sozinho, permita adivinhar o código. Toda falha devolve vazio/NULL, sem dizer o motivo.
-- Responsável legal: o código vai para o telefone do cadastro DO RESPONSÁVEL (0028), não do paciente.
CREATE TABLE portal_invite_otp (
  invite_id  uuid PRIMARY KEY,
  tenant_id  uuid NOT NULL,
  account_id uuid NOT NULL,
  code_hash  text NOT NULL CONSTRAINT portal_invite_otp_code_hash_check CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  attempts   integer NOT NULL DEFAULT 0 CONSTRAINT portal_invite_otp_attempts_check CHECK (attempts BETWEEN 0 AND 5),
  sends      integer NOT NULL DEFAULT 1 CONSTRAINT portal_invite_otp_sends_check CHECK (sends BETWEEN 1 AND 5)
);
REVOKE ALL ON portal_invite_otp FROM PUBLIC;
REVOKE ALL ON portal_invite_otp FROM app_user;
ALTER TABLE portal_invite_otp ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_invite_otp FORCE ROW LEVEL SECURITY;
CREATE POLICY portal_invite_otp_definer_only ON portal_invite_otp TO CURRENT_USER USING (true) WITH CHECK (true);

CREATE FUNCTION app_portal_invite_challenge(p_account uuid, p_token_hash text, p_code_hash text)
  RETURNS TABLE (tenant_id uuid, patient_id uuid, invite_id uuid, phone_enc text, phone_guardian_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  l     record;
  inv   record;
  v_tel text;
  o     record;
BEGIN
  IF p_account IS NULL OR p_account = '00000000-0000-0000-0000-000000000000'::uuid
     OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' OR p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.tenant_context c WHERE c.xid = txid_current_if_assigned()) THEN
    RAISE EXCEPTION 'resgate do convite exige transação própria' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT k.tenant_id, k.invite_id INTO l FROM public.portal_invite_lookup k WHERE k.token_hash = p_token_hash;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  PERFORM public.app_set_tenant(l.tenant_id);
  PERFORM public.app_set_system_user();
  SELECT * INTO inv FROM public.portal_invites i WHERE i.tenant_id = l.tenant_id AND i.id = l.invite_id FOR UPDATE;
  IF NOT FOUND OR inv.redeemed_at IS NOT NULL OR inv.revoked_at IS NOT NULL OR inv.expires_at <= now() THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.patients p WHERE p.tenant_id = inv.tenant_id AND p.id = inv.patient_id AND p.active) THEN
    RETURN;
  END IF;
  -- Titular: telefone do cadastro do paciente. Responsável (V1): telefone do cadastro DO RESPONSÁVEL (0028).
  IF inv.guardian_id IS NULL THEN
    SELECT p.phone_enc INTO v_tel FROM public.patients p WHERE p.tenant_id = inv.tenant_id AND p.id = inv.patient_id;
  ELSE
    SELECT g.phone_enc INTO v_tel FROM public.guardians g WHERE g.tenant_id = inv.tenant_id AND g.id = inv.guardian_id;
  END IF;
  IF v_tel IS NULL THEN
    RETURN;
  END IF;
  SELECT * INTO o FROM public.portal_invite_otp x WHERE x.invite_id = inv.id FOR UPDATE;
  IF FOUND THEN
    IF o.sends >= 5 THEN
      RETURN;
    END IF;
    UPDATE public.portal_invite_otp x
       SET account_id = p_account, code_hash = p_code_hash, expires_at = now() + interval '10 minutes', attempts = 0, sends = o.sends + 1
     WHERE x.invite_id = inv.id;
  ELSE
    INSERT INTO public.portal_invite_otp (invite_id, tenant_id, account_id, code_hash, expires_at)
      VALUES (inv.id, inv.tenant_id, p_account, p_code_hash, now() + interval '10 minutes');
  END IF;
  RETURN QUERY SELECT inv.tenant_id, inv.patient_id, inv.id, v_tel, inv.guardian_id;
END;
$$;

DROP FUNCTION app_portal_redeem_invite(uuid, text);
CREATE FUNCTION app_portal_redeem_invite(p_account uuid, p_token_hash text, p_code_hash text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  l      record;
  inv    record;
  o      record;
  v_link uuid;
BEGIN
  IF p_account IS NULL OR p_account = '00000000-0000-0000-0000-000000000000'::uuid
     OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' OR p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM public.tenant_context WHERE xid = txid_current_if_assigned()) THEN
    RAISE EXCEPTION 'resgate do convite exige transação própria' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT tenant_id, invite_id INTO l FROM public.portal_invite_lookup WHERE token_hash = p_token_hash;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  PERFORM public.app_set_tenant(l.tenant_id);
  PERFORM public.app_set_system_user();
  SELECT * INTO inv FROM public.portal_invites WHERE tenant_id = l.tenant_id AND id = l.invite_id FOR UPDATE;
  IF NOT FOUND OR inv.redeemed_at IS NOT NULL OR inv.revoked_at IS NOT NULL OR inv.expires_at <= now() THEN
    RETURN NULL;
  END IF;
  -- Prova de posse do telefone do cadastro: código da MESMA conta, no prazo, dentro das tentativas.
  SELECT * INTO o FROM public.portal_invite_otp WHERE invite_id = inv.id FOR UPDATE;
  IF NOT FOUND OR o.account_id IS DISTINCT FROM p_account OR o.expires_at <= now() OR o.attempts >= 5 THEN
    RETURN NULL;
  END IF;
  IF o.code_hash IS DISTINCT FROM p_code_hash THEN
    UPDATE public.portal_invite_otp SET attempts = o.attempts + 1 WHERE invite_id = inv.id;
    RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.patients p WHERE p.tenant_id = inv.tenant_id AND p.id = inv.patient_id AND p.active) THEN
    RETURN NULL;
  END IF;
  -- Código usado: não serve de novo (mesmo que o resgate abaixo falhe por outro motivo).
  UPDATE public.portal_invite_otp SET attempts = 5 WHERE invite_id = inv.id;
  SELECT id INTO v_link FROM public.portal_links
   WHERE tenant_id = inv.tenant_id AND account_id = p_account AND patient_id = inv.patient_id AND revoked_at IS NULL;
  IF NOT FOUND THEN
    INSERT INTO public.portal_links (tenant_id, account_id, patient_id, invite_id, acting_as, guardian_link_id, guardian_id, represent_until, confidential_from)
      VALUES (inv.tenant_id, p_account, inv.patient_id, inv.id, inv.acting_as, inv.guardian_link_id, inv.guardian_id, inv.represent_until, inv.confidential_from)
      RETURNING id INTO v_link;
  END IF;
  UPDATE public.portal_invites SET redeemed_at = now(), redeemed_account_id = p_account, link_id = v_link
   WHERE tenant_id = inv.tenant_id AND id = inv.id;
  INSERT INTO public.audit_log (tenant_id, actor_id, actor_kind, action, scope, metadata)
    VALUES (inv.tenant_id, p_account, 'paciente_portal', 'create', 'portal_links',
            jsonb_build_object('op', 'invite_redeemed', 'invite_id', inv.id, 'link_id', v_link,
                               'patient_id', inv.patient_id, 'acting_as', inv.acting_as, 'guardian_id', inv.guardian_id, 'otp', true));
  RETURN v_link;
END;
$$;

REVOKE ALL ON FUNCTION app_portal_invite_challenge(uuid, text, text), app_portal_redeem_invite(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_portal_invite_challenge(uuid, text, text), app_portal_redeem_invite(uuid, text, text) TO app_user;

-- ================================================================ V1. responsável legal no portal
--
-- Depende da 0028/0031 (responsáveis). Antes (0027) `responsavel_legal` era só um rótulo: qualquer paciente,
-- qualquer idade, sem saber QUAL responsável. Agora:
--   - convite e vínculo de responsável apontam para o vínculo de responsável da 0028 (`guardian_link_id`,
--     FK composta) e para a pessoa (`guardian_id`); titular não aponta para nada;
--   - só para MENOR não emancipado (pai/mãe, tutor, representante) ou CURATELA (a 0031 exige a decisão
--     judicial e o escopo no vínculo do curador). A data de nascimento é cifrada, então a API calcula o
--     fim da representação (`represent_until` = dia dos 18 anos, ou o fim da vigência do vínculo, o que vier
--     antes) e o banco exige a data, confere que é futura, que o vínculo da 0028 está vigente e que o
--     paciente não foi emancipado; curatela não tem data (vale a vigência do vínculo);
--   - `app_set_portal_session` recusa (42501) vínculo de responsável cuja representação não vale HOJE (fez 18,
--     emancipado, vínculo da 0028 encerrado): o acesso cai no dia, sem depender de job. O job
--     `app_portal_close_ended_representations` registra a revogação (motivos novos `maioridade_do_titular` e
--     `fim_da_representacao`), com trilha;
--   - consentimentos e pedidos gravam QUAL responsável agiu (`guardian_id`, preenchido pelo gatilho a partir
--     do vínculo) e o consentimento guarda até quando a representação valia (`represent_until`): depois
--     dela, o evento do responsável deixa de valer e o estado volta a "não respondido" até o titular responder;
--   - as tabelas dos responsáveis (0028) ficam fora da sessão do portal (`portal_fora`); só as funções do
--     dono leem o vínculo da 0028.

-- Tabelas da 0028 (criadas depois da 0027): fora do portal. O dono (funções SECURITY DEFINER) lê o vínculo.
CREATE POLICY portal_fora ON patient_guardians AS RESTRICTIVE
  USING (tenant_id = (SELECT app_current_tenant())
         AND ((SELECT app_portal_patient()) IS NULL OR (SELECT app_running_as_owner('public.patient_guardians'::regclass))))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()) AND (SELECT app_portal_patient()) IS NULL);
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
       AND c.relname NOT IN ('tenant_context', 'portal_invite_lookup', 'portal_link_index', 'portal_invite_otp')
       AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname
                        AND p.permissive = 'RESTRICTIVE' AND p.policyname ~ '^portal_(titular|fora|liberada)')
     ORDER BY c.relname
  LOOP
    EXECUTE format('CREATE POLICY portal_fora ON %I AS RESTRICTIVE '
      'USING (tenant_id = (SELECT app_current_tenant()) AND (SELECT app_portal_patient()) IS NULL) '
      'WITH CHECK (tenant_id = (SELECT app_current_tenant()) AND (SELECT app_portal_patient()) IS NULL)', t);
  END LOOP;
END;
$$;

ALTER TABLE portal_invites
  ADD COLUMN guardian_link_id uuid,
  ADD COLUMN guardian_id      uuid,
  ADD COLUMN represent_until  date,
  ADD COLUMN confidential_from date,
  ADD CONSTRAINT portal_invites_guardian_link_fk FOREIGN KEY (guardian_link_id, tenant_id) REFERENCES patient_guardians (id, tenant_id),
  ADD CONSTRAINT portal_invites_guardian_fk FOREIGN KEY (guardian_id, tenant_id) REFERENCES guardians (id, tenant_id),
  ADD CONSTRAINT portal_invites_acting_shape_check CHECK (
    (acting_as = 'titular' AND guardian_link_id IS NULL AND guardian_id IS NULL AND represent_until IS NULL AND confidential_from IS NULL)
    OR (acting_as = 'responsavel_legal' AND guardian_link_id IS NOT NULL AND guardian_id IS NOT NULL AND confidential_from IS NOT NULL));
ALTER TABLE portal_links
  ADD COLUMN guardian_link_id uuid,
  ADD COLUMN guardian_id      uuid,
  ADD COLUMN represent_until  date,
  ADD COLUMN confidential_from date,
  ADD CONSTRAINT portal_links_guardian_link_fk FOREIGN KEY (guardian_link_id, tenant_id) REFERENCES patient_guardians (id, tenant_id),
  ADD CONSTRAINT portal_links_guardian_fk FOREIGN KEY (guardian_id, tenant_id) REFERENCES guardians (id, tenant_id),
  ADD CONSTRAINT portal_links_acting_shape_check CHECK (
    (acting_as = 'titular' AND guardian_link_id IS NULL AND guardian_id IS NULL AND represent_until IS NULL AND confidential_from IS NULL)
    OR (acting_as = 'responsavel_legal' AND guardian_link_id IS NOT NULL AND guardian_id IS NOT NULL AND confidential_from IS NOT NULL));
ALTER TABLE portal_links DROP CONSTRAINT portal_links_revoke_reason_check;
ALTER TABLE portal_links ADD CONSTRAINT portal_links_revoke_reason_check CHECK (revoke_reason IS NULL OR revoke_reason IN (
  'pedido_do_paciente', 'acesso_indevido', 'fim_do_vinculo', 'erro_de_cadastro', 'maioridade_do_titular', 'fim_da_representacao'));
ALTER TABLE portal_consents
  ADD COLUMN guardian_id     uuid,
  ADD COLUMN represent_until date,
  ADD COLUMN guardian_link_id uuid,
  ADD COLUMN representation_ended_at timestamptz,
  ADD CONSTRAINT portal_consents_guardian_fk FOREIGN KEY (guardian_id, tenant_id) REFERENCES guardians (id, tenant_id),
  ADD CONSTRAINT portal_consents_guardian_link_fk FOREIGN KEY (guardian_link_id, tenant_id) REFERENCES patient_guardians (id, tenant_id),
  ADD CONSTRAINT portal_consents_guardian_check CHECK ((acting_as = 'responsavel_legal') = (guardian_id IS NOT NULL)),
  ADD CONSTRAINT portal_consents_guardian_link_check CHECK ((acting_as = 'responsavel_legal') = (guardian_link_id IS NOT NULL)),
  ADD CONSTRAINT portal_consents_ended_check CHECK (representation_ended_at IS NULL OR acting_as = 'responsavel_legal');
ALTER TABLE portal_rights_requests
  ADD COLUMN guardian_id uuid,
  ADD CONSTRAINT portal_rights_requests_guardian_fk FOREIGN KEY (guardian_id, tenant_id) REFERENCES guardians (id, tenant_id),
  ADD CONSTRAINT portal_rights_requests_guardian_check CHECK ((acting_as = 'responsavel_legal') = (guardian_id IS NOT NULL));
CREATE INDEX portal_links_guardian_idx ON portal_links (tenant_id, guardian_link_id) WHERE guardian_link_id IS NOT NULL;

-- A representação do vínculo do portal vale HOJE? Titular: sempre. Responsável: vínculo da 0028 vigente e,
-- fora a curatela, paciente não emancipado e antes de `represent_until`. Lida pelo dono (RLS da clínica do
-- contexto); não exposta ao runtime.
CREATE FUNCTION app_portal_representation_ok(p_tenant uuid, p_link uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE WHEN l.acting_as = 'titular' THEN true ELSE COALESCE((
    SELECT g.ended_at IS NULL AND g.end_reason IS NULL
           AND g.valid_from <= public.app_fiscal_today()
           AND (g.valid_until IS NULL OR g.valid_until > public.app_fiscal_today())
           AND (g.kind = 'curador'
                OR (l.represent_until IS NOT NULL AND l.represent_until > public.app_fiscal_today()
                    AND (SELECT p.emancipated_on IS NULL FROM public.patients p WHERE p.tenant_id = l.tenant_id AND p.id = l.patient_id)))
      FROM public.patient_guardians g
     WHERE g.tenant_id = l.tenant_id AND g.id = l.guardian_link_id AND g.patient_id = l.patient_id AND g.guardian_id = l.guardian_id), false) END
    FROM public.portal_links l
   WHERE l.tenant_id = p_tenant AND l.id = p_link
$$;
REVOKE ALL ON FUNCTION app_portal_representation_ok(uuid, uuid) FROM PUBLIC;

-- Convite: além da 0027, o de responsável exige o vínculo vigente da 0028 do MESMO paciente e pessoa e, fora
-- a curatela, paciente não emancipado e fim da representação futuro. Colunas novas imutáveis.
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

-- Vínculo: colunas novas imutáveis; além da clínica, o dono (job) revoga com os motivos da representação.
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

-- Consentimento: além da 0027, grava qual responsável agiu e até quando a representação valia (do vínculo).
CREATE OR REPLACE FUNCTION portal_consents_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  l record;
BEGIN
  IF app_portal_patient() IS NULL OR NEW.patient_id IS DISTINCT FROM app_portal_patient()
     OR NEW.link_id IS DISTINCT FROM app_portal_link() OR NEW.account_id IS DISTINCT FROM app_portal_account() THEN
    RAISE EXCEPTION 'consentimento do portal é do titular da sessão do portal' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT pl.acting_as, pl.guardian_id, pl.guardian_link_id, pl.represent_until INTO l FROM portal_links pl
   WHERE pl.tenant_id = NEW.tenant_id AND pl.id = NEW.link_id AND pl.revoked_at IS NULL;
  IF NOT FOUND OR NEW.created_at IS DISTINCT FROM now() OR NEW.acting_as IS DISTINCT FROM l.acting_as
     OR NEW.representation_ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'consentimento fora do vínculo ativo' USING ERRCODE = 'check_violation';
  END IF;
  NEW.guardian_id := l.guardian_id;
  NEW.guardian_link_id := l.guardian_link_id;
  NEW.represent_until := l.represent_until;
  RETURN NEW;
END;
$$;

-- Job (sistema): registra a revogação dos vínculos de responsável cuja representação acabou (o acesso já
-- caiu no dia, pela sessão). Uma clínica por transação, que tem de começar aqui. Devolve quantos revogou.
CREATE FUNCTION app_portal_close_ended_representations(p_tenant uuid) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  r     record;
  v_n   integer := 0;
  v_mot text;
BEGIN
  IF EXISTS (SELECT 1 FROM public.tenant_context WHERE xid = txid_current_if_assigned()) THEN
    RAISE EXCEPTION 'job de representação exige transação própria' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM public.app_set_tenant(p_tenant);
  PERFORM public.app_set_system_user();
  FOR r IN
    SELECT l.id, l.patient_id, l.guardian_id, l.represent_until FROM public.portal_links l
     WHERE l.tenant_id = p_tenant AND l.acting_as = 'responsavel_legal' AND l.revoked_at IS NULL
     ORDER BY l.id
     FOR UPDATE
  LOOP
    CONTINUE WHEN public.app_portal_representation_ok(p_tenant, r.id);
    v_mot := CASE WHEN r.represent_until IS NOT NULL AND r.represent_until <= public.app_fiscal_today()
                  THEN 'maioridade_do_titular' ELSE 'fim_da_representacao' END;
    UPDATE public.portal_links SET revoked_at = now(), revoked_by = '00000000-0000-0000-0000-000000000000'::uuid, revoke_reason = v_mot
     WHERE tenant_id = p_tenant AND id = r.id;
    INSERT INTO public.audit_log (tenant_id, actor_id, actor_kind, action, scope, metadata)
      VALUES (p_tenant, '00000000-0000-0000-0000-000000000000'::uuid, 'sistema', 'update', 'portal_links',
              jsonb_build_object('op', 'revoke', 'link_id', r.id, 'reason', v_mot, 'patient_id', r.patient_id, 'guardian_id', r.guardian_id));
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END;
$$;
-- Clínicas com vínculo de portal ativo (só ids), para o job percorrer.
CREATE FUNCTION app_portal_tenants_with_links() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT DISTINCT i.tenant_id FROM public.portal_link_index i WHERE i.revoked_at IS NULL ORDER BY 1
$$;
REVOKE ALL ON FUNCTION app_portal_close_ended_representations(uuid), app_portal_tenants_with_links() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_portal_close_ended_representations(uuid), app_portal_tenants_with_links() TO app_user;

-- ================================================================ R2 (re-revisão do #68). área sensível ESTRUTURADA
--
-- Antes, o sigilo do adolescente dependia de regex na especialidade em TEXTO LIVRE ("Saúde mental",
-- "Terapeuta" ou um erro de digitação escapavam). Agora a fonte é `professionals.sensitive_area` (boolean,
-- marcado pela clínica no cadastro do profissional: psicologia, psiquiatria, saúde mental...). A especialidade
-- em texto livre fica só como REFORÇO: se ela parecer de área sensível, o banco liga a marca sozinho (nunca
-- desliga). Na sessão do portal, `professionals` passa a ser só leitura (a `portal_liberada` era FOR ALL).
ALTER TABLE professionals ADD COLUMN sensitive_area boolean NOT NULL DEFAULT false;

CREATE FUNCTION app_specialty_looks_sensitive(p text) RETURNS boolean
  LANGUAGE sql IMMUTABLE
  SET search_path = pg_catalog
AS $$
  SELECT translate(lower(coalesce(p, '')), 'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc')
         ~ '(psic|psiq|saude mental|(^|[^a-z])tcc([^a-z]|$))'
$$;

UPDATE professionals SET sensitive_area = true WHERE app_specialty_looks_sensitive(specialty);

CREATE FUNCTION professionals_sensitive_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF app_portal_patient() IS NOT NULL THEN
    RAISE EXCEPTION 'professionals: % não permitido na sessão do portal', TG_OP USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF app_specialty_looks_sensitive(NEW.specialty) THEN
    NEW.sensitive_area := true;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER zz_professionals_sensitive_guard BEFORE INSERT OR UPDATE ON professionals
  FOR EACH ROW EXECUTE FUNCTION professionals_sensitive_guard();

-- ================================================================ Sigilo do adolescente também no BANCO (pendência da agenda)
--
-- Antes, a regra de idade era só do serviço: a data de nascimento é cifrada e o banco não a lê. Com SQL
-- arbitrário na sessão do portal, o responsável lia pela `portal_titular` as consultas de psicologia do
-- adolescente. Agora:
--   - `confidential_from` (em claro, no convite e no vínculo de responsável; NULL para o titular): a partir de
--     que dia o sigilo vale. Gravado pela API no convite (dia dos 12 anos; curatela = dia do convite, o
--     curatelado é adulto), copiado para o vínculo no resgate e imutável. É a mesma natureza de
--     `represent_until`, que já está em claro (dia dos 18).
--   - `app_portal_hides_sensitive()`: na sessão do portal, o vínculo é de responsável e o sigilo já vale hoje
--     (vínculo não achado = esconde, falha fechada). Fora do portal, falso.
--   - policy RESTRICTIVE `portal_sigilo_adolescente` em `appointments`: com o sigilo valendo, a consulta com
--     profissional de área sensível (`professionals.sensitive_area`, R2) não aparece para o responsável, para
--     ler nem para mudar. Criança: aparece. Titular: aparece.
-- Recibos e cobranças continuam com a regra no serviço (R1: o responsável que não é o pagador vê o recibo sem
-- profissional, especialidade e data): esconder a linha no banco tiraria o recibo de quem tem direito a ele, e
-- o conteúdo do recibo é um retrato cifrado que o banco não lê.
CREATE FUNCTION app_portal_hides_sensitive() RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, public
AS $$
  SELECT CASE WHEN public.app_portal_patient() IS NULL THEN false ELSE COALESCE((
    SELECT l.acting_as = 'responsavel_legal' AND (l.confidential_from IS NULL OR l.confidential_from <= public.app_fiscal_today())
      FROM public.portal_links l
     WHERE l.tenant_id = public.app_current_tenant() AND l.id = public.app_portal_link()), true) END
$$;
REVOKE ALL ON FUNCTION app_portal_hides_sensitive() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_portal_hides_sensitive() TO app_user;

CREATE POLICY portal_sigilo_adolescente ON appointments AS RESTRICTIVE
  USING (tenant_id = (SELECT app_current_tenant())
         AND ((SELECT app_portal_patient()) IS NULL
              OR NOT (SELECT app_portal_hides_sensitive())
              OR NOT EXISTS (SELECT 1 FROM professionals pr
                              WHERE pr.tenant_id = appointments.tenant_id AND pr.id = appointments.professional_id AND pr.sensitive_area)));

-- ================================================================ R4 (re-revisão do #68). o consentimento do responsável expira com o vínculo
--
-- Antes, `eventoVale` tratava `represent_until` nulo (curatela) como "vale para sempre": com a curatela
-- levantada, o vínculo da 0028 encerrado e o portal revogado, o "sim" do curador continuava valendo para o
-- escriba e para os lembretes. Agora:
--   - o evento grava QUAL vínculo da 0028 representava (`guardian_link_id`, pelo gatilho, a partir do vínculo
--     do portal) e vale só enquanto esse vínculo estiver VIGENTE: conferido no momento do uso por
--     `app_portal_guardian_link_ok` (portal, clínica e `consentimentoIaDoPaciente`);
--   - o JOB `app_portal_expire_guardian_consents` marca `representation_ended_at` nos eventos de responsável
--     cujo vínculo acabou (curatela levantada, fim da vigência, anulação), com trilha do sistema. Única
--     mudança aceita em `portal_consents` (append-only no resto), só pelo dono, uma vez.
CREATE FUNCTION app_portal_guardian_link_ok(p_tenant uuid, p_guardian_link uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT CASE WHEN p_guardian_link IS NULL OR p_tenant IS DISTINCT FROM public.app_current_tenant() THEN NULL ELSE COALESCE((
    SELECT g.ended_at IS NULL AND g.end_reason IS NULL
           AND g.valid_from <= public.app_fiscal_today()
           AND (g.valid_until IS NULL OR g.valid_until > public.app_fiscal_today())
      FROM public.patient_guardians g
     WHERE g.tenant_id = p_tenant AND g.id = p_guardian_link), false) END
$$;
REVOKE ALL ON FUNCTION app_portal_guardian_link_ok(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_portal_guardian_link_ok(uuid, uuid) TO app_user;

DROP TRIGGER portal_consents_no_update_delete ON portal_consents;
CREATE TRIGGER portal_consents_no_delete BEFORE DELETE ON portal_consents FOR EACH ROW EXECUTE FUNCTION portal_reject_mutation();
CREATE FUNCTION portal_consents_expire_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT app_running_as_owner(TG_RELID) OR OLD.representation_ended_at IS NOT NULL OR NEW.representation_ended_at IS DISTINCT FROM now()
     OR OLD.acting_as <> 'responsavel_legal'
     OR (to_jsonb(NEW) - 'representation_ended_at') IS DISTINCT FROM (to_jsonb(OLD) - 'representation_ended_at') THEN
    RAISE EXCEPTION 'portal_consents: só o job do sistema encerra o consentimento do responsável' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER portal_consents_expire_guard BEFORE UPDATE ON portal_consents FOR EACH ROW EXECUTE FUNCTION portal_consents_expire_guard();

-- Job (sistema): uma clínica por transação, que tem de começar aqui. Devolve quantos eventos encerrou.
CREATE FUNCTION app_portal_expire_guardian_consents(p_tenant uuid) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  r   record;
  v_n integer := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM public.tenant_context WHERE xid = txid_current_if_assigned()) THEN
    RAISE EXCEPTION 'job de consentimento exige transação própria' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM public.app_set_tenant(p_tenant);
  PERFORM public.app_set_system_user();
  FOR r IN
    SELECT c.id, c.patient_id, c.guardian_id, c.guardian_link_id, c.purpose FROM public.portal_consents c
     WHERE c.tenant_id = p_tenant AND c.acting_as = 'responsavel_legal' AND c.representation_ended_at IS NULL
     ORDER BY c.id
     FOR UPDATE
  LOOP
    CONTINUE WHEN public.app_portal_guardian_link_ok(p_tenant, r.guardian_link_id);
    UPDATE public.portal_consents SET representation_ended_at = now() WHERE tenant_id = p_tenant AND id = r.id;
    INSERT INTO public.audit_log (tenant_id, actor_id, actor_kind, action, scope, metadata)
      VALUES (p_tenant, '00000000-0000-0000-0000-000000000000'::uuid, 'sistema', 'update', 'portal_consents',
              jsonb_build_object('op', 'guardian_consent_expired', 'consent_id', r.id, 'purpose', r.purpose,
                                 'patient_id', r.patient_id, 'guardian_id', r.guardian_id, 'guardian_link_id', r.guardian_link_id));
    v_n := v_n + 1;
  END LOOP;
  RETURN v_n;
END;
$$;
-- Clínicas com algum vínculo de portal (ativo ou não; só ids): o consentimento sobrevive à revogação do vínculo.
CREATE FUNCTION app_portal_tenants_with_any_link() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT DISTINCT i.tenant_id FROM public.portal_link_index i ORDER BY 1
$$;
REVOKE ALL ON FUNCTION app_portal_expire_guardian_consents(uuid), app_portal_tenants_with_any_link() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_portal_expire_guardian_consents(uuid), app_portal_tenants_with_any_link() TO app_user;
