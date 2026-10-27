-- 0027 — Portal do paciente (rodada 18.1; veto B3 do parecer front-r8: contrato próprio, o SERVIDOR descobre
-- o titular pela sessão). Executar com o papel de MIGRAÇÃO (app_migrator).
-- Ver docs/04-arquitetura/api-dominio.md §10.
--
-- NUMERAÇÃO: 0026 é do importador e 0028 dos responsáveis (rodada 18, em paralelo). Esta não depende delas.
--
-- 1. Vínculo conta↔paciente↔clínica. A conta do portal é a pessoa que entrou (login real com a D4); ela só
--    enxerga um paciente depois que a CLÍNICA emite um convite (token de uso único, só o SHA-256 fica no
--    banco, validade de até 7 dias) e a conta o resgata. Tudo auditado.
--    - portal_invites (da clínica): quem convidou é o usuário da sessão; o resgate só passa pela função
--      `app_portal_redeem_invite` (SECURITY DEFINER), uma vez, dentro da validade; revogar é da clínica.
--    - portal_links (da clínica): criado SÓ pelo resgate; a clínica revoga (com motivo), nunca apaga.
--    - portal_invite_lookup / portal_link_index (INTERNAS, zero privilégio para o runtime): índices
--      mantidos por trigger para achar a clínica de um token/vínculo ANTES de haver contexto de clínica.
-- 2. Sessão do portal no banco: `app_set_portal_session(conta, vínculo)` confere o vínculo ATIVO da conta e
--    trava, na transação, a clínica, o paciente e a conta (mesmo desenho da 0003/0016/0019: uma vez por
--    transação, slot de usuário com o sentinela de sistema, então nenhum gatilho de "usuário da sessão" da
--    clínica aceita o portal como autor). `app_portal_patient()`/`app_portal_account()`/`app_portal_link()`.
-- 3. Defesa em profundidade (o paciente A nunca vê o B, mesmo com SQL injetado na transação do portal):
--    - policy RESTRITIVA `portal_titular` em patients, appointments, charges, payments, receipts,
--      receipt_cancellations e nas tabelas do portal: na sessão do portal, só as linhas do PRÓPRIO paciente;
--    - policy RESTRITIVA `portal_fora` em TODAS as demais tabelas da clínica (prontuário, notas, guias,
--      pacotes, financeiro interno, membros, convites...): na sessão do portal, nenhuma linha. Fora do
--      portal (`app_portal_patient()` NULL) as duas não mudam nada. A guarda de schema cobra uma das duas
--      em toda tabela da aplicação com tenant_id (tabela nova sem decisão reprova o test:rls);
--    - trigger em appointments: na sessão do portal, só confirmar/desfazer confirmação/cancelar consulta
--      FUTURA do próprio paciente, mudando só o status (nunca a função genérica de status da clínica).
-- 4. portal_consents: consentimento como HISTÓRICO (R15 do front-r8): append-only, versão e hash do texto
--    apresentado, canal, conta e "agindo como" (titular ou responsável legal, LGPD art. 14). O estado atual é
--    o último evento; `desfeito` volta a "não respondido", que vale como NÃO.
-- 5. portal_rights_requests: pedidos do titular (LGPD art. 18) REGISTRADOS para a clínica atender (nada é
--    executado automaticamente). Detalhe e resposta só cifrados (v1:). Prazo de 15 dias. Só a clínica muda
--    a situação; o portal só abre.
-- 6. audit_log: tipo de ator `paciente_portal` (ator = a conta do portal). Só amplia o CHECK.

-- ---------------------------------------------------------------- 6. tipo de ator na trilha

ALTER TABLE audit_log DROP CONSTRAINT audit_log_actor_kind_check;
ALTER TABLE audit_log
  ADD CONSTRAINT audit_log_actor_kind_check CHECK (
    actor_kind IN ('usuario_clinica', 'suporte_plataforma', 'sistema', 'paciente_portal')
  ) NOT VALID;
ALTER TABLE audit_log VALIDATE CONSTRAINT audit_log_actor_kind_check;

-- ---------------------------------------------------------------- 2. sessão do portal no banco

ALTER TABLE tenant_context
  ADD COLUMN portal_account_id uuid,
  ADD COLUMN portal_link_id    uuid,
  ADD COLUMN portal_patient_id uuid;

CREATE FUNCTION app_portal_patient() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT portal_patient_id FROM public.tenant_context WHERE xid = txid_current_if_assigned()
$$;

CREATE FUNCTION app_portal_account() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT portal_account_id FROM public.tenant_context WHERE xid = txid_current_if_assigned()
$$;

CREATE FUNCTION app_portal_link() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT portal_link_id FROM public.tenant_context WHERE xid = txid_current_if_assigned()
$$;

-- Transação do portal não é "job do sistema" (o slot do usuário tem o sentinela só para travá-lo).
CREATE OR REPLACE FUNCTION app_is_system_session() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT COALESCE(
    (SELECT user_id = '00000000-0000-0000-0000-000000000000'::uuid AND portal_account_id IS NULL
       FROM public.tenant_context WHERE xid = txid_current_if_assigned()),
    false)
$$;

-- ---------------------------------------------------------------- 1. convites e vínculos

CREATE TABLE portal_invites (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id),
  patient_id          uuid NOT NULL,
  -- SHA-256 (hex) do token de uso único. O token em si nunca é gravado.
  token_hash          text NOT NULL CONSTRAINT portal_invites_token_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  acting_as           text NOT NULL CONSTRAINT portal_invites_acting_as_check CHECK (acting_as IN ('titular', 'responsavel_legal')),
  expires_at          timestamptz NOT NULL,
  created_by          uuid NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  redeemed_at         timestamptz,
  redeemed_account_id uuid,
  link_id             uuid,
  revoked_at          timestamptz,
  revoked_by          uuid,
  CONSTRAINT portal_invites_id_tenant_key UNIQUE (id, tenant_id),
  CONSTRAINT portal_invites_token_hash_key UNIQUE (token_hash),
  CONSTRAINT portal_invites_patient_fk FOREIGN KEY (patient_id, tenant_id) REFERENCES patients (id, tenant_id),
  CONSTRAINT portal_invites_validity_check CHECK (expires_at > created_at AND expires_at <= created_at + interval '7 days'),
  CONSTRAINT portal_invites_redeem_check CHECK (
    (redeemed_at IS NULL) = (redeemed_account_id IS NULL) AND (redeemed_at IS NULL) = (link_id IS NULL)),
  CONSTRAINT portal_invites_revoke_check CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  CONSTRAINT portal_invites_terminal_check CHECK (redeemed_at IS NULL OR revoked_at IS NULL)
);
CREATE INDEX portal_invites_patient_idx ON portal_invites (tenant_id, patient_id);

CREATE TABLE portal_links (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id),
  account_id    uuid NOT NULL CONSTRAINT portal_links_account_check CHECK (account_id <> '00000000-0000-0000-0000-000000000000'::uuid),
  patient_id    uuid NOT NULL,
  invite_id     uuid NOT NULL,
  acting_as     text NOT NULL CONSTRAINT portal_links_acting_as_check CHECK (acting_as IN ('titular', 'responsavel_legal')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  revoked_by    uuid,
  revoke_reason text CONSTRAINT portal_links_revoke_reason_check
                CHECK (revoke_reason IS NULL OR revoke_reason IN ('pedido_do_paciente', 'acesso_indevido', 'fim_do_vinculo', 'erro_de_cadastro')),
  CONSTRAINT portal_links_id_tenant_key UNIQUE (id, tenant_id),
  CONSTRAINT portal_links_invite_key UNIQUE (tenant_id, invite_id),
  CONSTRAINT portal_links_patient_fk FOREIGN KEY (patient_id, tenant_id) REFERENCES patients (id, tenant_id),
  CONSTRAINT portal_links_invite_fk FOREIGN KEY (invite_id, tenant_id) REFERENCES portal_invites (id, tenant_id),
  CONSTRAINT portal_links_revoke_check CHECK (
    (revoked_at IS NULL) = (revoked_by IS NULL) AND (revoked_at IS NULL) = (revoke_reason IS NULL))
);
-- Um vínculo ativo por (clínica, conta, paciente).
CREATE UNIQUE INDEX portal_links_active_idx ON portal_links (tenant_id, account_id, patient_id) WHERE revoked_at IS NULL;
CREATE INDEX portal_links_patient_idx ON portal_links (tenant_id, patient_id);
ALTER TABLE portal_invites
  ADD CONSTRAINT portal_invites_link_fk FOREIGN KEY (link_id, tenant_id) REFERENCES portal_links (id, tenant_id)
  DEFERRABLE INITIALLY DEFERRED;

-- Índices INTERNOS (sem privilégio para o runtime; só as funções SECURITY DEFINER leem/gravam).
CREATE TABLE portal_invite_lookup (
  token_hash text PRIMARY KEY,
  tenant_id  uuid NOT NULL,
  invite_id  uuid NOT NULL
);
CREATE TABLE portal_link_index (
  link_id    uuid PRIMARY KEY,
  account_id uuid NOT NULL,
  tenant_id  uuid NOT NULL,
  patient_id uuid NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX portal_link_index_account_idx ON portal_link_index (account_id) WHERE revoked_at IS NULL;
REVOKE ALL ON portal_invite_lookup, portal_link_index FROM PUBLIC;
REVOKE ALL ON portal_invite_lookup, portal_link_index FROM app_user;
ALTER TABLE portal_invite_lookup ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_invite_lookup FORCE ROW LEVEL SECURITY;
CREATE POLICY portal_invite_lookup_definer_only ON portal_invite_lookup TO CURRENT_USER USING (true) WITH CHECK (true);
ALTER TABLE portal_link_index ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_link_index FORCE ROW LEVEL SECURITY;
CREATE POLICY portal_link_index_definer_only ON portal_link_index TO CURRENT_USER USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------- 4 e 5. consentimentos e pedidos do titular

CREATE TABLE portal_consents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  patient_id   uuid NOT NULL,
  link_id      uuid NOT NULL,
  account_id   uuid NOT NULL,
  purpose      text NOT NULL CONSTRAINT portal_consents_purpose_check
               CHECK (purpose IN ('lembretes_whatsapp', 'escriba_ia', 'pesquisa')),
  response     text NOT NULL CONSTRAINT portal_consents_response_check CHECK (response IN ('sim', 'nao', 'desfeito')),
  acting_as    text NOT NULL CONSTRAINT portal_consents_acting_as_check CHECK (acting_as IN ('titular', 'responsavel_legal')),
  -- Texto apresentado: versão e SHA-256 (o texto fica no código, versionado).
  text_version text NOT NULL CONSTRAINT portal_consents_text_version_check CHECK (text_version ~ '^[a-z0-9_.-]{1,40}$'),
  text_hash    text NOT NULL CONSTRAINT portal_consents_text_hash_check CHECK (text_hash ~ '^[0-9a-f]{64}$'),
  channel      text NOT NULL DEFAULT 'portal' CONSTRAINT portal_consents_channel_check CHECK (channel IN ('portal')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT portal_consents_patient_fk FOREIGN KEY (patient_id, tenant_id) REFERENCES patients (id, tenant_id),
  CONSTRAINT portal_consents_link_fk FOREIGN KEY (link_id, tenant_id) REFERENCES portal_links (id, tenant_id)
);
CREATE INDEX portal_consents_patient_idx ON portal_consents (tenant_id, patient_id, purpose, created_at);

CREATE TABLE portal_rights_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  patient_id  uuid NOT NULL,
  link_id     uuid NOT NULL,
  account_id  uuid NOT NULL,
  -- LGPD art. 18: II acesso, III correção, V portabilidade, VI eliminação, VII compartilhamento.
  kind        text NOT NULL CONSTRAINT portal_rights_requests_kind_check
              CHECK (kind IN ('acesso', 'correcao', 'portabilidade', 'eliminacao', 'compartilhamento')),
  acting_as   text NOT NULL CONSTRAINT portal_rights_requests_acting_as_check CHECK (acting_as IN ('titular', 'responsavel_legal')),
  protocol    text NOT NULL CONSTRAINT portal_rights_requests_protocol_check CHECK (protocol ~ '^[0-9]{8}-[0-9A-F]{8}$'),
  detail_enc  text CONSTRAINT portal_rights_requests_detail_check CHECK (detail_enc IS NULL OR app_is_sealed_field(detail_enc)),
  status      text NOT NULL DEFAULT 'aberta' CONSTRAINT portal_rights_requests_status_check
              CHECK (status IN ('aberta', 'em_andamento', 'atendida', 'recusada')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  due_at      timestamptz NOT NULL DEFAULT now() + interval '15 days',
  handled_by  uuid,
  handled_at  timestamptz,
  answer_enc  text CONSTRAINT portal_rights_requests_answer_check CHECK (answer_enc IS NULL OR app_is_sealed_field(answer_enc)),
  CONSTRAINT portal_rights_requests_protocol_key UNIQUE (tenant_id, protocol),
  CONSTRAINT portal_rights_requests_patient_fk FOREIGN KEY (patient_id, tenant_id) REFERENCES patients (id, tenant_id),
  CONSTRAINT portal_rights_requests_link_fk FOREIGN KEY (link_id, tenant_id) REFERENCES portal_links (id, tenant_id),
  CONSTRAINT portal_rights_requests_due_check CHECK (due_at = created_at + interval '15 days'),
  CONSTRAINT portal_rights_requests_handled_check CHECK ((handled_by IS NULL) = (handled_at IS NULL)),
  CONSTRAINT portal_rights_requests_final_check CHECK (status NOT IN ('atendida', 'recusada') OR handled_at IS NOT NULL)
);
CREATE INDEX portal_rights_requests_status_idx ON portal_rights_requests (tenant_id, status, created_at);

-- ---------------------------------------------------------------- RLS das tabelas da aplicação

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['portal_invites', 'portal_links', 'portal_consents', 'portal_rights_requests'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = (SELECT app_current_tenant())) '
                   'WITH CHECK (tenant_id = (SELECT app_current_tenant()))', t);
    EXECUTE format('REVOKE DELETE, TRUNCATE ON %I FROM app_user', t);
  END LOOP;
END;
$$;
-- Vínculo nasce só pelo resgate (função SECURITY DEFINER); consentimento é append-only.
REVOKE INSERT ON portal_links FROM app_user;
REVOKE UPDATE ON portal_consents FROM app_user;

-- ---------------------------------------------------------------- 3. policies restritivas do portal

-- Na sessão do portal, só as linhas do PRÓPRIO paciente. Fora dela (NULL), não muda nada.
CREATE POLICY portal_titular ON patients AS RESTRICTIVE
  USING (tenant_id = (SELECT app_current_tenant()) AND ((SELECT app_portal_patient()) IS NULL OR id = (SELECT app_portal_patient())))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()) AND ((SELECT app_portal_patient()) IS NULL OR id = (SELECT app_portal_patient())));
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['appointments', 'charges', 'portal_consents'] LOOP
    EXECUTE format('CREATE POLICY portal_titular ON %I AS RESTRICTIVE '
      'USING (tenant_id = (SELECT app_current_tenant()) AND ((SELECT app_portal_patient()) IS NULL OR patient_id = (SELECT app_portal_patient()))) '
      'WITH CHECK (tenant_id = (SELECT app_current_tenant()) AND ((SELECT app_portal_patient()) IS NULL OR patient_id = (SELECT app_portal_patient())))', t);
  END LOOP;
  -- Vínculos e pedidos: além do paciente, só os da PRÓPRIA conta (dois responsáveis não veem os pedidos um do outro).
  FOREACH t IN ARRAY ARRAY['portal_links', 'portal_rights_requests'] LOOP
    EXECUTE format('CREATE POLICY portal_titular ON %I AS RESTRICTIVE '
      'USING (tenant_id = (SELECT app_current_tenant()) AND ((SELECT app_portal_patient()) IS NULL OR '
      '(patient_id = (SELECT app_portal_patient()) AND account_id = (SELECT app_portal_account())))) '
      'WITH CHECK (tenant_id = (SELECT app_current_tenant()) AND ((SELECT app_portal_patient()) IS NULL OR '
      '(patient_id = (SELECT app_portal_patient()) AND account_id = (SELECT app_portal_account()))))', t);
  END LOOP;
END;
$$;
CREATE POLICY portal_titular ON payments AS RESTRICTIVE
  USING (tenant_id = (SELECT app_current_tenant()) AND ((SELECT app_portal_patient()) IS NULL OR EXISTS (
    SELECT 1 FROM charges c WHERE c.tenant_id = payments.tenant_id AND c.id = payments.charge_id
       AND c.patient_id = (SELECT app_portal_patient()))))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()) AND (SELECT app_portal_patient()) IS NULL);
CREATE POLICY portal_titular ON receipts AS RESTRICTIVE
  USING (tenant_id = (SELECT app_current_tenant()) AND ((SELECT app_portal_patient()) IS NULL OR EXISTS (
    SELECT 1 FROM payments p JOIN charges c ON c.tenant_id = p.tenant_id AND c.id = p.charge_id
     WHERE p.tenant_id = receipts.tenant_id AND p.id = receipts.payment_id AND c.patient_id = (SELECT app_portal_patient()))))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()) AND (SELECT app_portal_patient()) IS NULL);
CREATE POLICY portal_titular ON receipt_cancellations AS RESTRICTIVE
  USING (tenant_id = (SELECT app_current_tenant()) AND ((SELECT app_portal_patient()) IS NULL OR EXISTS (
    SELECT 1 FROM receipts r JOIN payments p ON p.tenant_id = r.tenant_id AND p.id = r.payment_id
      JOIN charges c ON c.tenant_id = p.tenant_id AND c.id = p.charge_id
     WHERE r.tenant_id = receipt_cancellations.tenant_id AND r.id = receipt_cancellations.receipt_id
       AND c.patient_id = (SELECT app_portal_patient()))))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()) AND (SELECT app_portal_patient()) IS NULL);

-- Todas as DEMAIS tabelas da clínica: nenhuma linha na sessão do portal. Liberadas sem restrição só as que
-- o portal precisa e que não têm dado de outro paciente: professionals (nome do profissional), as chaves
-- de dados (decifrar o próprio dado) e audit_log (o gatilho da cadeia lê o último elo como invocador).
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
       AND c.relname NOT IN ('patients', 'appointments', 'charges', 'payments', 'receipts', 'receipt_cancellations',
                             'portal_links', 'portal_consents', 'portal_rights_requests',
                             'professionals', 'tenant_data_keys', 'tenant_master_keys', 'audit_log',
                             'tenant_context', 'portal_invite_lookup', 'portal_link_index')
     ORDER BY c.relname
  LOOP
    EXECUTE format('CREATE POLICY portal_fora ON %I AS RESTRICTIVE '
      'USING (tenant_id = (SELECT app_current_tenant()) AND (SELECT app_portal_patient()) IS NULL) '
      'WITH CHECK (tenant_id = (SELECT app_current_tenant()) AND (SELECT app_portal_patient()) IS NULL)', t);
  END LOOP;
END;
$$;
-- Liberadas (sem dado de outro paciente), mas a policy explícita documenta a decisão e satisfaz a guarda.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['professionals', 'tenant_data_keys', 'tenant_master_keys'] LOOP
    EXECUTE format('CREATE POLICY portal_liberada ON %I AS RESTRICTIVE '
      'USING (tenant_id = (SELECT app_current_tenant())) WITH CHECK (tenant_id = (SELECT app_current_tenant()))', t);
  END LOOP;
END;
$$;
-- audit_log continua sem policy de UPDATE/DELETE/ALL (append-only): uma por comando.
CREATE POLICY portal_liberada_select ON audit_log AS RESTRICTIVE FOR SELECT
  USING (tenant_id = (SELECT app_current_tenant()));
CREATE POLICY portal_liberada_insert ON audit_log AS RESTRICTIVE FOR INSERT
  WITH CHECK (tenant_id = (SELECT app_current_tenant()));

-- ---------------------------------------------------------------- funções do portal (SECURITY DEFINER)

-- Abre a sessão do portal na transação: confere o vínculo ATIVO da conta e trava clínica, paciente e conta.
-- Tem de ser a primeira coisa da transação (sem app_set_tenant antes). Uma vez por transação.
CREATE FUNCTION app_set_portal_session(p_account uuid, p_link uuid) RETURNS void
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
END;
$$;

-- Vínculos ATIVOS da conta, em qualquer clínica (para a escolha de clínica na sessão). Só ids.
CREATE FUNCTION app_portal_links_of_account(p_account uuid)
  RETURNS TABLE (link_id uuid, tenant_id uuid, patient_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT i.link_id, i.tenant_id, i.patient_id FROM public.portal_link_index i
   WHERE i.account_id = p_account AND i.revoked_at IS NULL
   ORDER BY i.link_id
$$;

-- Resgate do convite pela conta: uso único, dentro da validade, paciente ativo. Abre o contexto da clínica
-- do convite NESTA transação, cria o vínculo, marca o convite e audita (ator = a conta). Qualquer falha
-- (token desconhecido, expirado, usado, revogado, paciente inativo) devolve NULL, sem dizer qual.
CREATE FUNCTION app_portal_redeem_invite(p_account uuid, p_token_hash text) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  l      record;
  inv    record;
  v_link uuid;
BEGIN
  IF p_account IS NULL OR p_account = '00000000-0000-0000-0000-000000000000'::uuid
     OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
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
  IF NOT EXISTS (SELECT 1 FROM public.patients p WHERE p.tenant_id = inv.tenant_id AND p.id = inv.patient_id AND p.active) THEN
    RETURN NULL;
  END IF;
  -- Já vinculado (mesma conta e paciente): o convite é consumido e o vínculo existente volta.
  SELECT id INTO v_link FROM public.portal_links
   WHERE tenant_id = inv.tenant_id AND account_id = p_account AND patient_id = inv.patient_id AND revoked_at IS NULL;
  IF NOT FOUND THEN
    INSERT INTO public.portal_links (tenant_id, account_id, patient_id, invite_id, acting_as)
      VALUES (inv.tenant_id, p_account, inv.patient_id, inv.id, inv.acting_as)
      RETURNING id INTO v_link;
  END IF;
  UPDATE public.portal_invites SET redeemed_at = now(), redeemed_account_id = p_account, link_id = v_link
   WHERE tenant_id = inv.tenant_id AND id = inv.id;
  INSERT INTO public.audit_log (tenant_id, actor_id, actor_kind, action, scope, metadata)
    VALUES (inv.tenant_id, p_account, 'paciente_portal', 'create', 'portal_links',
            jsonb_build_object('op', 'invite_redeemed', 'invite_id', inv.id, 'link_id', v_link,
                               'patient_id', inv.patient_id, 'acting_as', inv.acting_as));
  RETURN v_link;
END;
$$;

REVOKE ALL ON FUNCTION app_portal_patient(), app_portal_account(), app_portal_link(),
  app_set_portal_session(uuid, uuid), app_portal_links_of_account(uuid), app_portal_redeem_invite(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_portal_patient(), app_portal_account(), app_portal_link(),
  app_set_portal_session(uuid, uuid), app_portal_links_of_account(uuid), app_portal_redeem_invite(uuid, text) TO app_user;

-- ---------------------------------------------------------------- gatilhos de integridade (qualquer papel)

-- Executa como o DONO? Só o resgate (SECURITY DEFINER) grava vínculo e marca convite como resgatado.
CREATE FUNCTION app_running_as_owner(p_table regclass) RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = pg_catalog, public
AS $$
  SELECT pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = p_table), 'MEMBER')
$$;

CREATE FUNCTION portal_reject_mutation() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION '%: % não permitido', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE FUNCTION portal_invites_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := app_current_user();
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF v_user IS NULL OR app_portal_patient() IS NOT NULL OR NEW.created_by IS DISTINCT FROM v_user THEN
      RAISE EXCEPTION 'convite do portal é emitido pelo usuário da sessão da clínica' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.created_at IS DISTINCT FROM now() OR NEW.redeemed_at IS NOT NULL OR NEW.revoked_at IS NOT NULL OR NEW.link_id IS NOT NULL
       OR NEW.expires_at <= now() THEN
      RAISE EXCEPTION 'convite do portal nasce aberto e válido' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash OR NEW.acting_as IS DISTINCT FROM OLD.acting_as
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'identidade do convite é imutável' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.redeemed_at IS NOT NULL OR OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'convite resgatado ou revogado não muda' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NEW.redeemed_at IS NOT NULL THEN
    -- Resgate: só pela função (dono), uma vez, dentro da validade.
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
CREATE TRIGGER portal_invites_guard BEFORE INSERT OR UPDATE ON portal_invites FOR EACH ROW EXECUTE FUNCTION portal_invites_guard();
CREATE TRIGGER portal_invites_no_delete BEFORE DELETE ON portal_invites FOR EACH ROW EXECUTE FUNCTION portal_reject_mutation();
CREATE TRIGGER portal_invites_no_truncate BEFORE TRUNCATE ON portal_invites FOR EACH STATEMENT EXECUTE FUNCTION portal_reject_mutation();

-- Índice interno do token: gravado pelo dono (SECURITY DEFINER) a cada convite novo.
CREATE FUNCTION portal_invites_index() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  INSERT INTO public.portal_invite_lookup (token_hash, tenant_id, invite_id) VALUES (NEW.token_hash, NEW.tenant_id, NEW.id);
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION portal_invites_index() FROM PUBLIC;
CREATE TRIGGER portal_invites_index AFTER INSERT ON portal_invites FOR EACH ROW EXECUTE FUNCTION portal_invites_index();

CREATE FUNCTION portal_links_guard() RETURNS trigger
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
     OR NEW.acting_as IS DISTINCT FROM OLD.acting_as OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'identidade do vínculo é imutável' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'vínculo revogado não muda' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF v_user IS NULL OR app_portal_patient() IS NOT NULL OR NEW.revoked_by IS DISTINCT FROM v_user OR NEW.revoked_at IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'vínculo é revogado pelo usuário da sessão da clínica' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER portal_links_guard BEFORE INSERT OR UPDATE ON portal_links FOR EACH ROW EXECUTE FUNCTION portal_links_guard();
CREATE TRIGGER portal_links_no_delete BEFORE DELETE ON portal_links FOR EACH ROW EXECUTE FUNCTION portal_reject_mutation();
CREATE TRIGGER portal_links_no_truncate BEFORE TRUNCATE ON portal_links FOR EACH STATEMENT EXECUTE FUNCTION portal_reject_mutation();

CREATE FUNCTION portal_links_index() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  INSERT INTO public.portal_link_index (link_id, account_id, tenant_id, patient_id, revoked_at)
    VALUES (NEW.id, NEW.account_id, NEW.tenant_id, NEW.patient_id, NEW.revoked_at)
  ON CONFLICT (link_id) DO UPDATE SET revoked_at = EXCLUDED.revoked_at;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION portal_links_index() FROM PUBLIC;
CREATE TRIGGER portal_links_index AFTER INSERT OR UPDATE ON portal_links FOR EACH ROW EXECUTE FUNCTION portal_links_index();

-- Consentimento: só a sessão do portal grava, para o próprio vínculo; append-only para qualquer papel.
CREATE FUNCTION portal_consents_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF app_portal_patient() IS NULL OR NEW.patient_id IS DISTINCT FROM app_portal_patient()
     OR NEW.link_id IS DISTINCT FROM app_portal_link() OR NEW.account_id IS DISTINCT FROM app_portal_account() THEN
    RAISE EXCEPTION 'consentimento do portal é do titular da sessão do portal' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.created_at IS DISTINCT FROM now() OR NEW.acting_as IS DISTINCT FROM
     (SELECT l.acting_as FROM portal_links l WHERE l.tenant_id = NEW.tenant_id AND l.id = NEW.link_id AND l.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'consentimento fora do vínculo ativo' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER portal_consents_guard BEFORE INSERT ON portal_consents FOR EACH ROW EXECUTE FUNCTION portal_consents_guard();
CREATE TRIGGER portal_consents_no_update_delete BEFORE UPDATE OR DELETE ON portal_consents FOR EACH ROW EXECUTE FUNCTION portal_reject_mutation();
CREATE TRIGGER portal_consents_no_truncate BEFORE TRUNCATE ON portal_consents FOR EACH STATEMENT EXECUTE FUNCTION portal_reject_mutation();

-- Pedido do titular: o portal abre (para o próprio vínculo); só a clínica muda a situação.
CREATE FUNCTION portal_rights_requests_guard() RETURNS trigger
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
    -- O prazo é do banco (15 dias da abertura), não de quem grava.
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
  RETURN NEW;
END;
$$;
CREATE TRIGGER portal_rights_requests_guard BEFORE INSERT OR UPDATE ON portal_rights_requests FOR EACH ROW EXECUTE FUNCTION portal_rights_requests_guard();
CREATE TRIGGER portal_rights_requests_no_delete BEFORE DELETE ON portal_rights_requests FOR EACH ROW EXECUTE FUNCTION portal_reject_mutation();
CREATE TRIGGER portal_rights_requests_no_truncate BEFORE TRUNCATE ON portal_rights_requests FOR EACH STATEMENT EXECUTE FUNCTION portal_reject_mutation();

-- Agenda na sessão do portal: só confirmar, desfazer a confirmação ou cancelar consulta FUTURA do próprio
-- paciente, mudando só o status (e a data do cancelamento). Nunca criar, remarcar ou atender.
CREATE FUNCTION appointments_portal_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_pac uuid := app_portal_patient();
BEGIN
  IF v_pac IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' OR OLD.patient_id IS DISTINCT FROM v_pac THEN
    RAISE EXCEPTION 'portal só altera consulta do próprio paciente' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (to_jsonb(NEW) - 'status' - 'updated_at' - 'cancelled_at') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'updated_at' - 'cancelled_at')
     OR (NEW.status <> 'cancelled' AND NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at) THEN
    RAISE EXCEPTION 'portal só muda o status da consulta' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT ((OLD.status = 'scheduled' AND NEW.status = 'confirmed')
          OR (OLD.status = 'confirmed' AND NEW.status = 'scheduled')
          OR (OLD.status IN ('scheduled', 'confirmed') AND NEW.status = 'cancelled' AND NEW.cancelled_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'transição de status não permitida no portal' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.starts_at <= now() THEN
    RAISE EXCEPTION 'consulta que já começou não muda pelo portal' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER zz_appointments_portal_guard BEFORE INSERT OR UPDATE ON appointments FOR EACH ROW EXECUTE FUNCTION appointments_portal_guard();
