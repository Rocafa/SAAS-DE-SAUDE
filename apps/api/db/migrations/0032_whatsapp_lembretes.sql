-- 0032 — Lembretes e confirmação por WhatsApp (rodada 18.3; HU-COM-003, 004, 010 e 011).
-- Executar com o papel de MIGRAÇÃO (app_migrator). Ver docs/04-arquitetura/api-dominio.md §11 e
-- docs/03-seguranca-lgpd/RIPD-whatsapp.md.
--
-- NUMERAÇÃO: 0032 desta rodada; 0027–0031 estão em outras branches (portal, responsáveis, importador...).
--
-- Tabelas (todas com RLS FORÇADO pelo contexto travado da 0003, FK compostas com tenant_id e sem
-- DELETE/TRUNCATE para o runtime; um trigger recusa DELETE/TRUNCATE para qualquer papel):
-- - whatsapp_settings: canal da clínica (desligado por padrão), nome de remetente NEUTRO, antecedência
--   do lembrete (padrão 24 h = D-1), horário permitido de envio e janela de resposta.
-- - whatsapp_routes (INTERNA): número de negócio -> clínica, para o webhook (que chega sem sessão) achar
--   a clínica. O runtime não lê nem grava: só a função SECURITY DEFINER app_whatsapp_tenant_for_number.
-- - whatsapp_phone_keys: chave da clínica (cifrada) para o HMAC de comparação de número (V1 do #69).
-- - whatsapp_opt_ins: opt-in por paciente e finalidade, com PROVA (quando, como, quem registrou, a
--   referência do comprovante cifrada e o NÚMERO QUE CONSENTIU, cifrado e com HMAC) e revogação única. Só um usuário da clínica registra (o sistema
--   e o webhook nunca concedem); o paciente revoga respondendo SAIR (sistema) ou na recepção.
-- - modelos: SÓ os da plataforma (lista fechada no código: nome na Meta + texto aprovado, conferidos
--   juntos); a clínica não cria modelo (V3 do parecer #69). A fila guarda o nome do modelo usado.
-- - whatsapp_outbox: fila de envios (agendado, enviando, enviado, entregue, lido, falhou, cancelado).
--   Idempotência: um lembrete por (consulta, horário). O INSERT e a reserva para envio exigem opt-in
--   VIGENTE do mesmo paciente e destinatário PARA O MESMO NÚMERO (HMAC igual): barreira no banco.
-- - whatsapp_inbound: respostas recebidas, SÓ o metadado (interpretação e resultado; R1 do parecer #69:
--   texto e número de quem respondeu NÃO são guardados enquanto não houver inbox com leitor);
--   idempotência pelo id da mensagem no provedor; só o sistema (webhook) grava; nada muda depois.
-- Conteúdo do envio (texto renderizado e número) fica SÓ cifrado e sai em 30 dias
-- (app_whatsapp_content_retention_run): o metadado (status, datas, interpretação) fica.

-- ---------------------------------------------------------------------------------------------------
-- Texto neutro (defesa em profundidade; a lista principal está em lembretes-regras.ts e o teste
-- confere que cada termo de lá também é recusado aqui).
-- ---------------------------------------------------------------------------------------------------
CREATE FUNCTION app_whatsapp_text_is_neutral(t text) RETURNS boolean
  LANGUAGE sql IMMUTABLE
  SET search_path = pg_catalog
AS $$
  SELECT t IS NULL OR NOT (
    lower(translate(t, 'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ', 'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC'))
    ~ '(psiq|psicol|psicot|psicanal|psicopedag|terapi|terapeut|oncol|cancer|quimiot|radiot|\mhiv\M|\maids\M|infectol|hepatit|sifilis|\mist\M|\mdst\M|ginecol|obstetr|pre-?natal|aborto|fertilid|reproducao|urolog|proctolog|dependencia|alcool|droga|reabilit|saude mental|neurol|cardiol|dermatol|endocrin|nutri|fonoaud|fisiot|odont|dentist|pediatr|geriatr|ortoped|oftalm|otorrino|mastol|hematol|nefrol|dialise|transtorno|depress|ansiedade|autismo|\mtea\M|tdah|bipolar|esquizof|\mdra?\M|doutor|especialid|sexolog|estetic|\mcid\M|diagnost|exame)'
  )
$$;

-- ---------------------------------------------------------------------------------------------------
-- Configuração do canal por clínica
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE whatsapp_settings (
  tenant_id              uuid PRIMARY KEY REFERENCES tenants (id),
  enabled                boolean NOT NULL DEFAULT false,
  -- Nome exibido no texto ({clinica}): NEUTRO e escolhido pela clínica, nunca a razão social por padrão.
  sender_name            text CONSTRAINT whatsapp_settings_sender_check
                           CHECK (sender_name IS NULL OR (char_length(sender_name) BETWEEN 2 AND 40 AND app_whatsapp_text_is_neutral(sender_name))),
  -- phone_number_id do número de negócio no provedor (identificador público, não é segredo).
  business_number_id     text CONSTRAINT whatsapp_settings_number_check CHECK (business_number_id IS NULL OR business_number_id ~ '^[0-9]{5,32}$'),
  reminder_hours_before  smallint NOT NULL DEFAULT 24 CONSTRAINT whatsapp_settings_hours_check CHECK (reminder_hours_before BETWEEN 2 AND 72),
  send_from_hour         smallint NOT NULL DEFAULT 8 CONSTRAINT whatsapp_settings_from_check CHECK (send_from_hour BETWEEN 0 AND 23),
  send_until_hour        smallint NOT NULL DEFAULT 20 CONSTRAINT whatsapp_settings_until_check CHECK (send_until_hour BETWEEN 1 AND 24),
  reply_window_hours     smallint NOT NULL DEFAULT 48 CONSTRAINT whatsapp_settings_reply_check CHECK (reply_window_hours BETWEEN 1 AND 72),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  updated_by             uuid NOT NULL,
  CONSTRAINT whatsapp_settings_window_check CHECK (send_until_hour > send_from_hour),
  CONSTRAINT whatsapp_settings_enabled_check CHECK (NOT enabled OR (sender_name IS NOT NULL AND business_number_id IS NOT NULL))
);

-- Rota do webhook: interna (o runtime não toca; só as funções SECURITY DEFINER abaixo).
CREATE TABLE whatsapp_routes (
  business_number_id  text PRIMARY KEY,
  tenant_id           uuid NOT NULL UNIQUE REFERENCES tenants (id)
);
REVOKE ALL ON whatsapp_routes FROM PUBLIC;
REVOKE ALL ON whatsapp_routes FROM app_user;
ALTER TABLE whatsapp_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_routes FORCE ROW LEVEL SECURITY;
CREATE POLICY whatsapp_routes_definer_only ON whatsapp_routes TO CURRENT_USER USING (true) WITH CHECK (true);

-- Quem altera a configuração é o usuário da sessão; a rota acompanha o número (outra clínica não toma
-- um número já registrado: 23505).
CREATE FUNCTION whatsapp_settings_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF app_current_user() IS NULL OR NEW.updated_by IS DISTINCT FROM app_current_user() THEN
    RAISE EXCEPTION 'configuração do WhatsApp só pelo usuário da sessão' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'clínica da configuração é imutável' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER whatsapp_settings_guard BEFORE INSERT OR UPDATE ON whatsapp_settings
  FOR EACH ROW EXECUTE FUNCTION whatsapp_settings_guard();

CREATE FUNCTION whatsapp_settings_route() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_dono uuid;
BEGIN
  -- Só a clínica do contexto travado mexe na própria rota.
  IF NEW.tenant_id IS DISTINCT FROM app_current_tenant() THEN
    RAISE EXCEPTION 'rota do WhatsApp fora da clínica do contexto' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.business_number_id IS NOT NULL THEN
    SELECT tenant_id INTO v_dono FROM public.whatsapp_routes WHERE business_number_id = NEW.business_number_id;
    IF FOUND AND v_dono <> NEW.tenant_id THEN
      RAISE EXCEPTION 'número de WhatsApp já registrado' USING ERRCODE = 'unique_violation';
    END IF;
  END IF;
  DELETE FROM public.whatsapp_routes WHERE tenant_id = NEW.tenant_id;
  IF NEW.business_number_id IS NOT NULL THEN
    INSERT INTO public.whatsapp_routes (business_number_id, tenant_id) VALUES (NEW.business_number_id, NEW.tenant_id);
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION whatsapp_settings_route() FROM PUBLIC;
CREATE TRIGGER whatsapp_settings_route AFTER INSERT OR UPDATE OF business_number_id ON whatsapp_settings
  FOR EACH ROW EXECUTE FUNCTION whatsapp_settings_route();

-- Webhook (sem sessão): número de negócio -> clínica. Devolve só o id. NÃO confere se o canal está ligado
-- (a função não enxerga whatsapp_settings, que tem RLS forçado): o serviço confere `enabled` já dentro do
-- contexto da clínica, antes de agir. O runtime só chega aqui pelo provider estreito RotaDoWhatsapp.
CREATE FUNCTION app_whatsapp_tenant_for_number(p_number text) RETURNS uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT r.tenant_id FROM public.whatsapp_routes r
   WHERE r.business_number_id = p_number AND p_number ~ '^[0-9]{5,32}$'
$$;
REVOKE ALL ON FUNCTION app_whatsapp_tenant_for_number(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_whatsapp_tenant_for_number(text) TO app_user;

-- ---------------------------------------------------------------------------------------------------
-- Chave de comparação de número, por clínica (V1 do parecer #69). O número fica cifrado; para comparar
-- "o número de agora é o que consentiu?" sem decifrar tudo, guarda-se HMAC-SHA256(chave da clínica,
-- número normalizado). A chave é aleatória, cifrada com a chave da clínica (FieldCipher, KMS), nunca sai
-- do servidor e não muda (só INSERT).
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE whatsapp_phone_keys (
  tenant_id   uuid PRIMARY KEY REFERENCES tenants (id),
  key_enc     text NOT NULL CONSTRAINT whatsapp_phone_keys_key_check CHECK (app_is_sealed_field(key_enc)),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------------------------------
-- Opt-in com prova
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE whatsapp_opt_ins (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id),
  patient_id       uuid NOT NULL,
  -- Titular x destinatário (R10 do RIPD): menor recebe pelo responsável.
  recipient_kind   text NOT NULL CONSTRAINT whatsapp_opt_ins_recipient_check CHECK (recipient_kind IN ('paciente', 'responsavel')),
  -- Pessoa responsável (guardians, migração 0028 de outra branch): sem FK nesta migração; a FK entra
  -- quando as duas branches se encontrarem.
  guardian_id      uuid,
  purpose          text NOT NULL DEFAULT 'lembrete_consulta' CONSTRAINT whatsapp_opt_ins_purpose_check CHECK (purpose IN ('lembrete_consulta')),
  method           text NOT NULL CONSTRAINT whatsapp_opt_ins_method_check
                     CHECK (method IN ('verbal_na_recepcao', 'formulario_assinado', 'portal_do_paciente')),
  -- Referência do comprovante (nº do termo, protocolo), cifrada com a chave da clínica.
  -- Obrigatório em qualquer meio (R7 do parecer #69): sem comprovante não há prova.
  evidence_enc     text NOT NULL CONSTRAINT whatsapp_opt_ins_evidence_check CHECK (app_is_sealed_field(evidence_enc)),
  -- O NÚMERO QUE CONSENTIU (V1 do #69): cifrado, e o HMAC da clínica para comparar com o número de agora.
  -- Número diferente = o opt-in perde a validade (revogado como numero_mudou) e nada sai.
  recipient_phone_enc  text NOT NULL CONSTRAINT whatsapp_opt_ins_phone_check CHECK (app_is_sealed_field(recipient_phone_enc)),
  recipient_phone_hash text NOT NULL CONSTRAINT whatsapp_opt_ins_phone_hash_check CHECK (recipient_phone_hash ~ '^[0-9a-f]{64}$'),
  granted_at       timestamptz NOT NULL DEFAULT now(),
  granted_by       uuid NOT NULL,
  revoked_at       timestamptz,
  -- NULL quando o próprio titular revogou pelo canal (SAIR), processado pelo sistema.
  revoked_by       uuid,
  revoke_method    text CONSTRAINT whatsapp_opt_ins_revoke_check
                     CHECK (revoke_method IS NULL OR revoke_method IN ('pedido_na_recepcao', 'resposta_sair', 'portal_do_paciente', 'troca_de_destinatario', 'numero_mudou')),
  CONSTRAINT whatsapp_opt_ins_guardian_check CHECK ((recipient_kind = 'responsavel') = (guardian_id IS NOT NULL)),
  CONSTRAINT whatsapp_opt_ins_revoked_check CHECK (
    (revoked_at IS NULL AND revoke_method IS NULL AND revoked_by IS NULL)
    -- SAIR: sempre o sistema (NULL). numero_mudou: o sistema (job) ou o usuário que rodou o envio. Demais: usuário.
    OR (revoked_at IS NOT NULL AND revoke_method IS NOT NULL
        AND (revoke_method <> 'resposta_sair' OR revoked_by IS NULL)
        AND (revoke_method IN ('resposta_sair', 'numero_mudou') OR revoked_by IS NOT NULL))),
  CONSTRAINT whatsapp_opt_ins_patient_fk FOREIGN KEY (patient_id, tenant_id) REFERENCES patients (id, tenant_id),
  CONSTRAINT whatsapp_opt_ins_id_tenant_key UNIQUE (id, tenant_id)
);
CREATE UNIQUE INDEX whatsapp_opt_ins_live_idx ON whatsapp_opt_ins (tenant_id, patient_id, purpose) WHERE revoked_at IS NULL;
CREATE INDEX whatsapp_opt_ins_phone_idx ON whatsapp_opt_ins (tenant_id, recipient_phone_hash) WHERE revoked_at IS NULL;

CREATE FUNCTION whatsapp_opt_ins_guard() RETURNS trigger
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
    IF NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'opt-in nasce vigente' USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- R7 do parecer #69: "pelo portal" só pode vir da sessão do PORTAL (#68), que ainda não está integrada
    -- aqui; a recepção não declara que o portal participou.
    IF NEW.method = 'portal_do_paciente' THEN
      RAISE EXCEPTION 'opt-in pelo portal só pela sessão do portal' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.granted_at := now();
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
     OR NEW.granted_at IS DISTINCT FROM OLD.granted_at OR NEW.granted_by IS DISTINCT FROM OLD.granted_by
     OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'opt-in: só a revogação é permitida' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.revoke_method = 'portal_do_paciente' THEN
    RAISE EXCEPTION 'revogação pelo portal só pela sessão do portal' USING ERRCODE = 'insufficient_privilege';
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
CREATE TRIGGER whatsapp_opt_ins_guard BEFORE INSERT OR UPDATE ON whatsapp_opt_ins
  FOR EACH ROW EXECUTE FUNCTION whatsapp_opt_ins_guard();

-- ---------------------------------------------------------------------------------------------------
-- Modelos: SÓ os da plataforma (V3 do parecer #69). A clínica não cria modelo. A lista fechada e
-- versionada está em lembretes-regras.ts (MODELOS_DA_PLATAFORMA: nome na Meta + texto aprovado pelo
-- Guardião, conferidos juntos); o banco repete a lista de NOMES e o teste confere que as duas batem.
-- Modelo novo = nova versão no código + aprovação do Guardião + esta função numa migração nova.
-- ---------------------------------------------------------------------------------------------------
CREATE FUNCTION app_whatsapp_platform_templates() RETURNS text[]
  LANGUAGE sql IMMUTABLE
  SET search_path = pg_catalog
AS $$ SELECT ARRAY['lembrete_neutro_v1']::text[] $$;

-- ---------------------------------------------------------------------------------------------------
-- Fila de envios
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE whatsapp_outbox (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL REFERENCES tenants (id),
  appointment_id         uuid NOT NULL,
  -- Horário da consulta no momento do envio: a resposta só vale para ESTE horário (remarcou = outro envio).
  appointment_starts_at  timestamptz NOT NULL,
  patient_id             uuid NOT NULL,
  opt_in_id              uuid NOT NULL,
  -- Modelo da PLATAFORMA (nome na Meta), da lista fechada versionada no código.
  template_name          text NOT NULL CONSTRAINT whatsapp_outbox_template_check CHECK (template_name = ANY (app_whatsapp_platform_templates())),
  kind                   text NOT NULL DEFAULT 'lembrete_consulta' CONSTRAINT whatsapp_outbox_kind_check CHECK (kind IN ('lembrete_consulta')),
  recipient_kind         text NOT NULL CONSTRAINT whatsapp_outbox_recipient_check CHECK (recipient_kind IN ('paciente', 'responsavel')),
  guardian_id            uuid,
  -- Conteúdo (cifrado; NULL depois da retenção de 30 dias).
  recipient_phone_enc    text CONSTRAINT whatsapp_outbox_phone_check CHECK (recipient_phone_enc IS NULL OR app_is_sealed_field(recipient_phone_enc)),
  -- HMAC do número de destino: tem de ser o do opt-in (V1). Metadado: fica depois da retenção.
  recipient_phone_hash   text NOT NULL CONSTRAINT whatsapp_outbox_phone_hash_check CHECK (recipient_phone_hash ~ '^[0-9a-f]{64}$'),
  body_enc               text CONSTRAINT whatsapp_outbox_body_check CHECK (body_enc IS NULL OR app_is_sealed_field(body_enc)),
  status                 text NOT NULL DEFAULT 'agendado' CONSTRAINT whatsapp_outbox_status_check
                           CHECK (status IN ('agendado', 'enviando', 'enviado', 'entregue', 'lido', 'falhou', 'cancelado')),
  attempts               smallint NOT NULL DEFAULT 0 CONSTRAINT whatsapp_outbox_attempts_check CHECK (attempts BETWEEN 0 AND 5),
  provider_message_id    text CONSTRAINT whatsapp_outbox_provider_check CHECK (provider_message_id IS NULL OR provider_message_id ~ '^[A-Za-z0-9._=:+/-]{1,128}$'),
  sent_at                timestamptz,
  delivered_at           timestamptz,
  read_at                timestamptz,
  failed_at              timestamptz,
  -- Quando a linha foi reservada para envio (agendado -> enviando). Presa em "enviando" há mais de 24 h
  -- (queda do processo no meio do envio) a retenção a encerra como "falhou" (R2 do parecer #69).
  dispatch_started_at    timestamptz,
  -- Código do provedor ou nosso (nunca a mensagem de erro, que pode ecoar o número).
  failure_code           text CONSTRAINT whatsapp_outbox_failure_check CHECK (failure_code IS NULL OR failure_code ~ '^[a-z0-9_]{1,32}$'),
  -- Falhou: a recepção precisa avisar por outro meio (fila da recepção; SMS/e-mail entram com COM-04).
  needs_fallback         boolean NOT NULL DEFAULT false,
  content_purged_at      timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  -- NULL: job do sistema.
  created_by             uuid,
  CONSTRAINT whatsapp_outbox_guardian_check CHECK ((recipient_kind = 'responsavel') = (guardian_id IS NOT NULL)),
  CONSTRAINT whatsapp_outbox_appointment_fk FOREIGN KEY (appointment_id, tenant_id) REFERENCES appointments (id, tenant_id),
  CONSTRAINT whatsapp_outbox_patient_fk FOREIGN KEY (patient_id, tenant_id) REFERENCES patients (id, tenant_id),
  CONSTRAINT whatsapp_outbox_opt_in_fk FOREIGN KEY (opt_in_id, tenant_id) REFERENCES whatsapp_opt_ins (id, tenant_id),
  CONSTRAINT whatsapp_outbox_id_tenant_key UNIQUE (id, tenant_id),
  -- Idempotência: um lembrete por consulta e horário.
  CONSTRAINT whatsapp_outbox_idempotency_key UNIQUE (tenant_id, appointment_id, kind, appointment_starts_at),
  CONSTRAINT whatsapp_outbox_provider_key UNIQUE (tenant_id, provider_message_id)
);
CREATE INDEX whatsapp_outbox_pending_idx ON whatsapp_outbox (tenant_id, status, created_at);

-- Fila: transições do status só para frente; conteúdo só sai pela retenção.
CREATE FUNCTION whatsapp_outbox_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_ok boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'agendado' OR NEW.attempts <> 0 OR NEW.provider_message_id IS NOT NULL OR NEW.sent_at IS NOT NULL
       OR NEW.delivered_at IS NOT NULL OR NEW.read_at IS NOT NULL OR NEW.failed_at IS NOT NULL OR NEW.content_purged_at IS NOT NULL
       OR NEW.needs_fallback OR NEW.dispatch_started_at IS NOT NULL THEN
      RAISE EXCEPTION 'envio nasce agendado' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.created_by IS DISTINCT FROM app_current_user() THEN
      RAISE EXCEPTION 'autor do envio é o usuário da sessão (ou o sistema)' USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- Opt-in VIGENTE do mesmo paciente, do mesmo destinatário e PARA O MESMO NÚMERO (V1): sem ele o banco
    -- recusa o envio.
    IF NOT EXISTS (
         SELECT 1 FROM whatsapp_opt_ins o
          WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.opt_in_id AND o.patient_id = NEW.patient_id
            AND o.revoked_at IS NULL AND o.purpose = NEW.kind
            AND o.recipient_kind = NEW.recipient_kind AND o.guardian_id IS NOT DISTINCT FROM NEW.guardian_id
            AND o.recipient_phone_hash = NEW.recipient_phone_hash
          FOR SHARE) THEN
      RAISE EXCEPTION 'envio sem opt-in vigente do destinatário' USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- A consulta é deste paciente, ainda está marcada e o horário é o atual.
    IF NOT EXISTS (
         SELECT 1 FROM appointments a
          WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.appointment_id AND a.patient_id = NEW.patient_id
            AND a.starts_at = NEW.appointment_starts_at AND a.status IN ('scheduled', 'confirmed')) THEN
      RAISE EXCEPTION 'envio para consulta inexistente, de outro paciente ou não marcada' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.created_at := now();
    RETURN NEW;
  END IF;

  -- UPDATE: identidade imutável.
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.appointment_id IS DISTINCT FROM OLD.appointment_id
     OR NEW.appointment_starts_at IS DISTINCT FROM OLD.appointment_starts_at OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
     OR NEW.opt_in_id IS DISTINCT FROM OLD.opt_in_id OR NEW.template_name IS DISTINCT FROM OLD.template_name OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.recipient_kind IS DISTINCT FROM OLD.recipient_kind OR NEW.guardian_id IS DISTINCT FROM OLD.guardian_id
     OR NEW.recipient_phone_hash IS DISTINCT FROM OLD.recipient_phone_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'envio: identidade imutável' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Conteúdo: só sai (NULL), pela retenção, depois de 30 dias; nunca é trocado.
  IF (NEW.body_enc IS DISTINCT FROM OLD.body_enc AND NEW.body_enc IS NOT NULL)
     OR (NEW.recipient_phone_enc IS DISTINCT FROM OLD.recipient_phone_enc AND NEW.recipient_phone_enc IS NOT NULL AND OLD.recipient_phone_enc IS NOT NULL) THEN
    RAISE EXCEPTION 'envio: conteúdo não é reescrito' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.content_purged_at IS DISTINCT FROM OLD.content_purged_at THEN
    IF OLD.content_purged_at IS NOT NULL OR NEW.body_enc IS NOT NULL OR NEW.recipient_phone_enc IS NOT NULL
       OR OLD.created_at > now() - make_interval(days => app_whatsapp_content_retention_days()) THEN
      RAISE EXCEPTION 'envio: retenção do conteúdo fora da regra' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.content_purged_at := now();
  ELSIF (NEW.body_enc IS NULL AND OLD.body_enc IS NOT NULL) OR (NEW.recipient_phone_enc IS NULL AND OLD.recipient_phone_enc IS NOT NULL) THEN
    RAISE EXCEPTION 'envio: conteúdo só sai pela retenção' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Status: só as transições da fila (o webhook nunca volta status).
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    v_ok := CASE OLD.status
      WHEN 'agendado' THEN NEW.status IN ('enviando', 'cancelado')
      WHEN 'enviando' THEN NEW.status IN ('enviado', 'agendado', 'falhou')
      WHEN 'enviado'  THEN NEW.status IN ('entregue', 'lido', 'falhou')
      WHEN 'entregue' THEN NEW.status IN ('lido', 'falhou')
      ELSE false END;
    IF NOT v_ok THEN
      RAISE EXCEPTION 'envio: transição de status inválida' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.status = 'enviando' THEN
      -- Reserva para envio: o opt-in ainda vale e é do MESMO número (V1), conferido de novo aqui.
      IF NOT EXISTS (
           SELECT 1 FROM whatsapp_opt_ins o
            WHERE o.tenant_id = NEW.tenant_id AND o.id = NEW.opt_in_id AND o.revoked_at IS NULL
              AND o.recipient_phone_hash = NEW.recipient_phone_hash
            FOR SHARE) THEN
        RAISE EXCEPTION 'envio sem opt-in vigente para este número' USING ERRCODE = 'insufficient_privilege';
      END IF;
      NEW.attempts := OLD.attempts + 1;
      NEW.dispatch_started_at := now();
    ELSIF NEW.status = 'enviado' THEN
      NEW.sent_at := now();
    ELSIF NEW.status = 'entregue' THEN
      NEW.delivered_at := now();
    ELSIF NEW.status = 'lido' THEN
      NEW.read_at := now();
      NEW.delivered_at := COALESCE(OLD.delivered_at, now());
    ELSIF NEW.status = 'falhou' THEN
      NEW.failed_at := now();
      NEW.needs_fallback := true;
    END IF;
  ELSIF NEW.attempts IS DISTINCT FROM OLD.attempts OR NEW.sent_at IS DISTINCT FROM OLD.sent_at OR NEW.delivered_at IS DISTINCT FROM OLD.delivered_at
     OR NEW.dispatch_started_at IS DISTINCT FROM OLD.dispatch_started_at
     OR NEW.read_at IS DISTINCT FROM OLD.read_at OR NEW.failed_at IS DISTINCT FROM OLD.failed_at OR NEW.needs_fallback IS DISTINCT FROM OLD.needs_fallback THEN
    RAISE EXCEPTION 'envio: carimbos só mudam com o status' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- id do provedor: gravado uma vez, junto da ida para "enviado".
  IF NEW.provider_message_id IS DISTINCT FROM OLD.provider_message_id
     AND (OLD.provider_message_id IS NOT NULL OR NEW.status <> 'enviado' OR OLD.status <> 'enviando') THEN
    RAISE EXCEPTION 'envio: id do provedor gravado só no envio' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION app_whatsapp_content_retention_days() RETURNS integer
  LANGUAGE sql IMMUTABLE
  SET search_path = pg_catalog
AS $$ SELECT 30 $$;

-- Linha presa em "enviando" além disto é encerrada como "falhou" (com fallback) pela retenção (R2).
CREATE FUNCTION app_whatsapp_stuck_sending_hours() RETURNS integer
  LANGUAGE sql IMMUTABLE
  SET search_path = pg_catalog
AS $$ SELECT 24 $$;

CREATE TRIGGER whatsapp_outbox_guard BEFORE INSERT OR UPDATE ON whatsapp_outbox
  FOR EACH ROW EXECUTE FUNCTION whatsapp_outbox_guard();

-- ---------------------------------------------------------------------------------------------------
-- Respostas recebidas
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE whatsapp_inbound (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants (id),
  provider_message_id  text NOT NULL CONSTRAINT whatsapp_inbound_provider_check CHECK (provider_message_id ~ '^[A-Za-z0-9._=:+/-]{1,128}$'),
  -- Envio a que a resposta foi associada (NULL: nenhum envio vigente para aquele número).
  outbox_id            uuid,
  -- Sem texto e sem número de quem respondeu (R1 do #69): o envio casado já diz o número, e "outro" é
  -- respondido com texto fixo (ligue para a clínica) sem guardar o que o paciente escreveu.
  interpretation       text NOT NULL CONSTRAINT whatsapp_inbound_interpretation_check CHECK (interpretation IN ('confirmar', 'cancelar', 'sair', 'outro')),
  outcome              text NOT NULL CONSTRAINT whatsapp_inbound_outcome_check CHECK (outcome IN (
                         'confirmado', 'cancelado', 'ja_estava', 'fora_da_janela', 'consulta_alterada', 'status_nao_permite',
                         'sem_envio', 'opt_out', 'sem_acao')),
  received_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT whatsapp_inbound_outbox_fk FOREIGN KEY (outbox_id, tenant_id) REFERENCES whatsapp_outbox (id, tenant_id),
  -- Idempotência do webhook (a Meta reentrega).
  CONSTRAINT whatsapp_inbound_provider_key UNIQUE (tenant_id, provider_message_id)
);
CREATE INDEX whatsapp_inbound_outbox_idx ON whatsapp_inbound (tenant_id, outbox_id);

CREATE FUNCTION whatsapp_inbound_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Só o processamento do webhook (sistema) registra resposta: usuário nenhum fabrica "o paciente disse 1".
    IF NOT app_is_system_session() THEN
      RAISE EXCEPTION 'resposta só é registrada pelo webhook' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.received_at := now();
    RETURN NEW;
  END IF;
  -- UPDATE: nada muda (não há conteúdo a reter; o runtime nem tem UPDATE).
  RAISE EXCEPTION 'resposta registrada não muda' USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER whatsapp_inbound_guard BEFORE INSERT OR UPDATE ON whatsapp_inbound
  FOR EACH ROW EXECUTE FUNCTION whatsapp_inbound_guard();

-- ---------------------------------------------------------------------------------------------------
-- RLS, privilégios e "nada se apaga" nas tabelas da clínica
-- ---------------------------------------------------------------------------------------------------
ALTER TABLE whatsapp_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON whatsapp_settings
  USING (tenant_id = (SELECT app_current_tenant())) WITH CHECK (tenant_id = (SELECT app_current_tenant()));
ALTER TABLE whatsapp_opt_ins ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_opt_ins FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON whatsapp_opt_ins
  USING (tenant_id = (SELECT app_current_tenant())) WITH CHECK (tenant_id = (SELECT app_current_tenant()));
ALTER TABLE whatsapp_phone_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_phone_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON whatsapp_phone_keys
  USING (tenant_id = (SELECT app_current_tenant())) WITH CHECK (tenant_id = (SELECT app_current_tenant()));
REVOKE ALL ON whatsapp_phone_keys FROM PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON whatsapp_phone_keys FROM app_user;
GRANT SELECT, INSERT ON whatsapp_phone_keys TO app_user;
CREATE TRIGGER whatsapp_phone_keys_no_update_delete BEFORE UPDATE OR DELETE ON whatsapp_phone_keys FOR EACH ROW EXECUTE FUNCTION finance_reject_mutation();
CREATE TRIGGER whatsapp_phone_keys_no_truncate BEFORE TRUNCATE ON whatsapp_phone_keys FOR EACH STATEMENT EXECUTE FUNCTION finance_reject_mutation();
ALTER TABLE whatsapp_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON whatsapp_outbox
  USING (tenant_id = (SELECT app_current_tenant())) WITH CHECK (tenant_id = (SELECT app_current_tenant()));
ALTER TABLE whatsapp_inbound ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_inbound FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON whatsapp_inbound
  USING (tenant_id = (SELECT app_current_tenant())) WITH CHECK (tenant_id = (SELECT app_current_tenant()));

REVOKE ALL ON whatsapp_settings, whatsapp_opt_ins, whatsapp_outbox, whatsapp_inbound FROM PUBLIC;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON whatsapp_settings, whatsapp_opt_ins, whatsapp_outbox, whatsapp_inbound FROM app_user;
REVOKE UPDATE ON whatsapp_inbound FROM app_user;
GRANT SELECT, INSERT, UPDATE ON whatsapp_settings, whatsapp_opt_ins, whatsapp_outbox TO app_user;
GRANT SELECT, INSERT ON whatsapp_inbound TO app_user;

CREATE TRIGGER whatsapp_settings_no_delete BEFORE DELETE ON whatsapp_settings FOR EACH ROW EXECUTE FUNCTION finance_reject_mutation();
CREATE TRIGGER whatsapp_settings_no_truncate BEFORE TRUNCATE ON whatsapp_settings FOR EACH STATEMENT EXECUTE FUNCTION finance_reject_mutation();
CREATE TRIGGER whatsapp_opt_ins_no_delete BEFORE DELETE ON whatsapp_opt_ins FOR EACH ROW EXECUTE FUNCTION finance_reject_mutation();
CREATE TRIGGER whatsapp_opt_ins_no_truncate BEFORE TRUNCATE ON whatsapp_opt_ins FOR EACH STATEMENT EXECUTE FUNCTION finance_reject_mutation();
CREATE TRIGGER whatsapp_outbox_no_delete BEFORE DELETE ON whatsapp_outbox FOR EACH ROW EXECUTE FUNCTION finance_reject_mutation();
CREATE TRIGGER whatsapp_outbox_no_truncate BEFORE TRUNCATE ON whatsapp_outbox FOR EACH STATEMENT EXECUTE FUNCTION finance_reject_mutation();
CREATE TRIGGER whatsapp_inbound_no_delete BEFORE DELETE ON whatsapp_inbound FOR EACH ROW EXECUTE FUNCTION finance_reject_mutation();
CREATE TRIGGER whatsapp_inbound_no_truncate BEFORE TRUNCATE ON whatsapp_inbound FOR EACH STATEMENT EXECUTE FUNCTION finance_reject_mutation();

-- ---------------------------------------------------------------------------------------------------
-- Limpeza (job da clínica; R2/R3 do parecer #69). Roda na clínica do contexto (RLS) e com o relógio do
-- banco; sem parâmetro de data; idempotente. Nesta ordem:
-- 1. "agendado" de consulta que já começou nunca vai sair: vira "cancelado" (failure_code expirado);
-- 2. "enviando" há mais de 24 h (queda no meio do envio; não se reenvia, para não mandar duas vezes): vira
--    "falhou" (envio_interrompido) com fallback para a recepção;
-- 3. CONTEÚDO (texto renderizado e número, cifrados) de envio com mais de 30 dias sai; ficam status,
--    datas, códigos e o HMAC do número (metadado; prazo em matriz-retencao.md §3, R3).
-- Depois de 1 e 2 nenhuma linha fica presa: toda linha antiga entra no passo 3.
-- ---------------------------------------------------------------------------------------------------
CREATE FUNCTION app_whatsapp_content_retention_run()
  RETURNS TABLE (scheduled_expired integer, sending_interrupted integer, outbox_purged integer)
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_exp integer;
  v_int integer;
  v_out integer;
  v_limite timestamptz := now() - make_interval(days => app_whatsapp_content_retention_days());
BEGIN
  IF app_current_tenant() IS NULL THEN
    RAISE EXCEPTION 'retenção do WhatsApp sem clínica no contexto' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.whatsapp_outbox SET status = 'cancelado', failure_code = 'expirado'
   WHERE tenant_id = app_current_tenant() AND status = 'agendado' AND appointment_starts_at <= now();
  GET DIAGNOSTICS v_exp = ROW_COUNT;
  UPDATE public.whatsapp_outbox SET status = 'falhou', failure_code = 'envio_interrompido'
   WHERE tenant_id = app_current_tenant() AND status = 'enviando'
     AND dispatch_started_at <= now() - make_interval(hours => app_whatsapp_stuck_sending_hours());
  GET DIAGNOSTICS v_int = ROW_COUNT;
  UPDATE public.whatsapp_outbox SET body_enc = NULL, recipient_phone_enc = NULL, content_purged_at = now()
   WHERE tenant_id = app_current_tenant() AND content_purged_at IS NULL AND created_at <= v_limite
     AND status NOT IN ('agendado', 'enviando');
  GET DIAGNOSTICS v_out = ROW_COUNT;
  RETURN QUERY SELECT v_exp, v_int, v_out;
END;
$$;
REVOKE ALL ON FUNCTION app_whatsapp_content_retention_run() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_whatsapp_content_retention_run() TO app_user;
