-- 0028 — Responsáveis do paciente (rodada 18.2; PAC-01.2; LGPD art. 14; R3 do #65).
-- Executar com o papel de MIGRAÇÃO (app_migrator). Ver docs/04-arquitetura/api-dominio.md §10.
--
-- NUMERAÇÃO: 0026 é do importador, 0027 do portal do paciente; 0028 desta rodada.
--
-- - guardians: a PESSOA responsável (nome, CPF e telefone SÓ CIFRADOS com a chave da clínica). Uma pessoa
--   pode ser responsável por mais de um paciente (irmãos): o vínculo é outra tabela.
-- - patient_guardians: o VÍNCULO responsável ↔ paciente, com o tipo (pai/mãe, tutor, curador,
--   representante), se é o responsável financeiro (pagador), se pode receber informação clínica e a
--   vigência [valid_from, valid_until) — valid_until EXCLUSIVO. Nada se apaga: encerrar = gravar
--   valid_until, motivo, quem e quando; vínculo encerrado é terminal. Tipo, paciente, pessoa e início
--   são imutáveis (mudou? encerre e crie outro). No máximo um vínculo vivo por (paciente, pessoa) e um
--   pagador vivo por paciente.
-- - patient_guardian_history: histórico append-only gravado SÓ pelos triggers das duas tabelas acima
--   (INSERT direto é recusado): cada criação, alteração e encerramento, com os nomes das colunas
--   alteradas, o estado do vínculo depois do evento e, quando a pessoa muda, os valores ANTERIORES ainda
--   cifrados (o mesmo AAD de guardians: a correção de um CPF não apaga o CPF antigo).
-- Autor = usuário da sessão (app_current_user, 0016/0019) em toda escrita, conferido pelo banco.
-- Todas com RLS FORÇADO pelo contexto travado (app_current_tenant, 0003), FK compostas com tenant_id
-- e sem DELETE/TRUNCATE para o runtime (histórico também sem UPDATE).
--
-- A regra da maioridade (aos 18 anos o responsável deixa de receber informação clínica, salvo curatela)
-- é aplicada pela API na leitura: a data de nascimento do paciente é cifrada e o banco não a lê.

CREATE TABLE guardians (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id),
  name_enc    text NOT NULL CONSTRAINT guardians_name_check CHECK (app_is_sealed_field(name_enc)),
  cpf_enc     text CONSTRAINT guardians_cpf_check CHECK (cpf_enc IS NULL OR app_is_sealed_field(cpf_enc)),
  phone_enc   text CONSTRAINT guardians_phone_check CHECK (phone_enc IS NULL OR app_is_sealed_field(phone_enc)),
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  uuid NOT NULL,
  CONSTRAINT guardians_id_tenant_key UNIQUE (id, tenant_id)
);

CREATE TABLE patient_guardians (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants (id),
  patient_id              uuid NOT NULL,
  guardian_id             uuid NOT NULL,
  kind                    text NOT NULL CONSTRAINT patient_guardians_kind_check
                            CHECK (kind IN ('pai_mae', 'tutor', 'curador', 'representante')),
  is_payer                boolean NOT NULL DEFAULT false,
  receives_clinical_info  boolean NOT NULL DEFAULT false,
  valid_from              date NOT NULL DEFAULT current_date,
  -- Exclusivo: vigente em d se valid_from <= d < valid_until (NULL = sem fim).
  valid_until             date,
  end_reason              text CONSTRAINT patient_guardians_end_reason_check CHECK (end_reason IS NULL OR end_reason IN (
                            'maioridade', 'fim_da_representacao', 'decisao_judicial', 'substituido', 'cadastro_errado', 'pedido_do_titular')),
  ended_at                timestamptz,
  ended_by                uuid,
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid NOT NULL,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  updated_by              uuid NOT NULL,
  CONSTRAINT patient_guardians_ended_check CHECK (
    (ended_at IS NULL AND ended_by IS NULL AND end_reason IS NULL AND valid_until IS NULL)
    OR (ended_at IS NOT NULL AND ended_by IS NOT NULL AND end_reason IS NOT NULL AND valid_until IS NOT NULL)),
  CONSTRAINT patient_guardians_range_check CHECK (valid_until IS NULL OR valid_until >= valid_from),
  CONSTRAINT patient_guardians_patient_fk FOREIGN KEY (patient_id, tenant_id) REFERENCES patients (id, tenant_id),
  CONSTRAINT patient_guardians_guardian_fk FOREIGN KEY (guardian_id, tenant_id) REFERENCES guardians (id, tenant_id),
  CONSTRAINT patient_guardians_id_tenant_key UNIQUE (id, tenant_id)
);
CREATE UNIQUE INDEX patient_guardians_live_pair_idx ON patient_guardians (tenant_id, patient_id, guardian_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX patient_guardians_live_payer_idx ON patient_guardians (tenant_id, patient_id) WHERE is_payer AND ended_at IS NULL;
CREATE INDEX patient_guardians_patient_idx ON patient_guardians (tenant_id, patient_id, valid_from);
CREATE INDEX patient_guardians_guardian_idx ON patient_guardians (tenant_id, guardian_id);

CREATE TABLE patient_guardian_history (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants (id),
  guardian_id             uuid NOT NULL,
  -- NULL: evento da pessoa (nome/CPF/telefone), que vale para todos os vínculos dela.
  link_id                 uuid,
  event                   text NOT NULL CONSTRAINT patient_guardian_history_event_check CHECK (event IN (
                            'responsavel_criado', 'responsavel_alterado', 'vinculo_criado', 'vinculo_alterado', 'vinculo_encerrado')),
  changed_fields          text NOT NULL DEFAULT '' CONSTRAINT patient_guardian_history_fields_check CHECK (changed_fields ~ '^[a-z_,]*$'),
  -- Valores ANTERIORES da pessoa, ainda cifrados (AAD de guardians): só em responsavel_alterado.
  prev_name_enc           text CONSTRAINT patient_guardian_history_prev_name_check CHECK (prev_name_enc IS NULL OR app_is_sealed_field(prev_name_enc)),
  prev_cpf_enc            text CONSTRAINT patient_guardian_history_prev_cpf_check CHECK (prev_cpf_enc IS NULL OR app_is_sealed_field(prev_cpf_enc)),
  prev_phone_enc          text CONSTRAINT patient_guardian_history_prev_phone_check CHECK (prev_phone_enc IS NULL OR app_is_sealed_field(prev_phone_enc)),
  -- Estado do vínculo DEPOIS do evento (só nos eventos de vínculo).
  kind                    text,
  is_payer                boolean,
  receives_clinical_info  boolean,
  valid_from              date,
  valid_until             date,
  end_reason              text,
  actor_id                uuid NOT NULL,
  occurred_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT patient_guardian_history_guardian_fk FOREIGN KEY (guardian_id, tenant_id) REFERENCES guardians (id, tenant_id),
  CONSTRAINT patient_guardian_history_link_fk FOREIGN KEY (link_id, tenant_id) REFERENCES patient_guardians (id, tenant_id),
  CONSTRAINT patient_guardian_history_link_check CHECK ((link_id IS NULL) = (event LIKE 'responsavel_%'))
);
CREATE INDEX patient_guardian_history_link_idx ON patient_guardian_history (tenant_id, link_id, occurred_at);
CREATE INDEX patient_guardian_history_guardian_idx ON patient_guardian_history (tenant_id, guardian_id, occurred_at);

-- ---------------------------------------------------------------- autor = sessão e imutabilidade

CREATE FUNCTION guardians_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := app_current_user();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'responsável: escrita exige o usuário da sessão' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.created_by IS DISTINCT FROM v_user OR NEW.updated_by IS DISTINCT FROM v_user THEN
      RAISE EXCEPTION 'guardians: autor tem de ser o usuário da sessão' USING ERRCODE = 'insufficient_privilege';
    END IF;
    NEW.created_at := now();
    NEW.updated_at := now();
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'guardians: identidade e criação são imutáveis' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.updated_by IS DISTINCT FROM v_user THEN
    RAISE EXCEPTION 'guardians: autor da alteração tem de ser o usuário da sessão' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER guardians_guard BEFORE INSERT OR UPDATE ON guardians FOR EACH ROW EXECUTE FUNCTION guardians_guard();

CREATE FUNCTION patient_guardians_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := app_current_user();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'responsável: escrita exige o usuário da sessão' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.created_by IS DISTINCT FROM v_user OR NEW.updated_by IS DISTINCT FROM v_user THEN
      RAISE EXCEPTION 'patient_guardians: autor tem de ser o usuário da sessão' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.ended_at IS NOT NULL THEN
      RAISE EXCEPTION 'patient_guardians: vínculo nasce vigente' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.valid_from > current_date THEN
      RAISE EXCEPTION 'patient_guardians: início da vigência não pode ser futuro' USING ERRCODE = 'check_violation';
    END IF;
    NEW.created_at := now();
    NEW.updated_at := now();
    RETURN NEW;
  END IF;
  -- UPDATE
  IF OLD.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'patient_guardians: vínculo encerrado é terminal' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.patient_id IS DISTINCT FROM OLD.patient_id OR NEW.guardian_id IS DISTINCT FROM OLD.guardian_id
     OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'patient_guardians: paciente, responsável, tipo e início são imutáveis (encerre e crie outro)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.updated_by IS DISTINCT FROM v_user THEN
    RAISE EXCEPTION 'patient_guardians: autor da alteração tem de ser o usuário da sessão' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.ended_at IS NOT NULL THEN
    IF NEW.ended_by IS DISTINCT FROM v_user THEN
      RAISE EXCEPTION 'patient_guardians: quem encerra é o usuário da sessão' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.valid_until > current_date THEN
      RAISE EXCEPTION 'patient_guardians: encerramento não pode ser futuro' USING ERRCODE = 'check_violation';
    END IF;
    -- As marcas (pagador, informação clínica) ficam como estavam: valem só DENTRO da vigência, e o
    -- pagador de um pagamento antigo continua sendo quem era o pagador vigente naquela data.
    IF NEW.is_payer IS DISTINCT FROM OLD.is_payer OR NEW.receives_clinical_info IS DISTINCT FROM OLD.receives_clinical_info THEN
      RAISE EXCEPTION 'patient_guardians: encerrar não muda as marcas do vínculo' USING ERRCODE = 'check_violation';
    END IF;
    NEW.ended_at := now();
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER patient_guardians_guard BEFORE INSERT OR UPDATE ON patient_guardians
  FOR EACH ROW EXECUTE FUNCTION patient_guardians_guard();

-- ---------------------------------------------------------------- histórico (só pelos triggers)

CREATE FUNCTION patient_guardian_history_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  -- Profundidade 1 = INSERT direto; 2 = vindo do trigger de guardians/patient_guardians.
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'patient_guardian_history só é gravada pelos triggers do cadastro de responsáveis'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.actor_id IS DISTINCT FROM app_current_user() THEN
    RAISE EXCEPTION 'patient_guardian_history: autor tem de ser o usuário da sessão' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.occurred_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER patient_guardian_history_guard BEFORE INSERT ON patient_guardian_history
  FOR EACH ROW EXECUTE FUNCTION patient_guardian_history_guard();
CREATE TRIGGER patient_guardian_history_no_update_delete BEFORE UPDATE OR DELETE ON patient_guardian_history
  FOR EACH ROW EXECUTE FUNCTION finance_reject_mutation();
CREATE TRIGGER patient_guardian_history_no_truncate BEFORE TRUNCATE ON patient_guardian_history
  FOR EACH STATEMENT EXECUTE FUNCTION finance_reject_mutation();

CREATE FUNCTION guardians_history() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_campos text[] := '{}';
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO patient_guardian_history (tenant_id, guardian_id, event, changed_fields, actor_id)
    VALUES (NEW.tenant_id, NEW.id, 'responsavel_criado', '', app_current_user());
    RETURN NULL;
  END IF;
  IF NEW.name_enc IS DISTINCT FROM OLD.name_enc THEN v_campos := v_campos || 'name'; END IF;
  IF NEW.cpf_enc IS DISTINCT FROM OLD.cpf_enc THEN v_campos := v_campos || 'cpf'; END IF;
  IF NEW.phone_enc IS DISTINCT FROM OLD.phone_enc THEN v_campos := v_campos || 'phone'; END IF;
  IF cardinality(v_campos) = 0 THEN
    RETURN NULL;
  END IF;
  INSERT INTO patient_guardian_history (tenant_id, guardian_id, event, changed_fields, prev_name_enc, prev_cpf_enc, prev_phone_enc, actor_id)
  VALUES (NEW.tenant_id, NEW.id, 'responsavel_alterado', array_to_string(v_campos, ','),
          CASE WHEN 'name' = ANY (v_campos) THEN OLD.name_enc END,
          CASE WHEN 'cpf' = ANY (v_campos) THEN OLD.cpf_enc END,
          CASE WHEN 'phone' = ANY (v_campos) THEN OLD.phone_enc END,
          app_current_user());
  RETURN NULL;
END;
$$;
CREATE TRIGGER guardians_history AFTER INSERT OR UPDATE ON guardians FOR EACH ROW EXECUTE FUNCTION guardians_history();

CREATE FUNCTION patient_guardians_history() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_campos text[] := '{}';
  v_evento text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_evento := 'vinculo_criado';
  ELSE
    IF NEW.is_payer IS DISTINCT FROM OLD.is_payer THEN v_campos := v_campos || 'is_payer'; END IF;
    IF NEW.receives_clinical_info IS DISTINCT FROM OLD.receives_clinical_info THEN v_campos := v_campos || 'receives_clinical_info'; END IF;
    IF NEW.ended_at IS DISTINCT FROM OLD.ended_at THEN v_campos := v_campos || 'valid_until'; END IF;
    IF cardinality(v_campos) = 0 THEN
      RETURN NULL;
    END IF;
    v_evento := CASE WHEN NEW.ended_at IS NOT NULL THEN 'vinculo_encerrado' ELSE 'vinculo_alterado' END;
  END IF;
  INSERT INTO patient_guardian_history (tenant_id, guardian_id, link_id, event, changed_fields, kind, is_payer,
                                        receives_clinical_info, valid_from, valid_until, end_reason, actor_id)
  VALUES (NEW.tenant_id, NEW.guardian_id, NEW.id, v_evento, array_to_string(v_campos, ','), NEW.kind, NEW.is_payer,
          NEW.receives_clinical_info, NEW.valid_from, NEW.valid_until, NEW.end_reason, app_current_user());
  RETURN NULL;
END;
$$;
CREATE TRIGGER patient_guardians_history AFTER INSERT OR UPDATE ON patient_guardians
  FOR EACH ROW EXECUTE FUNCTION patient_guardians_history();

-- Nada se apaga (nem pelo dono das tabelas por engano): DELETE/TRUNCATE recusados por trigger também.
CREATE TRIGGER guardians_no_delete BEFORE DELETE ON guardians FOR EACH ROW EXECUTE FUNCTION finance_reject_mutation();
CREATE TRIGGER guardians_no_truncate BEFORE TRUNCATE ON guardians FOR EACH STATEMENT EXECUTE FUNCTION finance_reject_mutation();
CREATE TRIGGER patient_guardians_no_delete BEFORE DELETE ON patient_guardians FOR EACH ROW EXECUTE FUNCTION finance_reject_mutation();
CREATE TRIGGER patient_guardians_no_truncate BEFORE TRUNCATE ON patient_guardians FOR EACH STATEMENT EXECUTE FUNCTION finance_reject_mutation();

-- ---------------------------------------------------------------- RLS

ALTER TABLE guardians ENABLE ROW LEVEL SECURITY;
ALTER TABLE guardians FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON guardians
  USING (tenant_id = (SELECT app_current_tenant()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()));

ALTER TABLE patient_guardians ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_guardians FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON patient_guardians
  USING (tenant_id = (SELECT app_current_tenant()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()));

ALTER TABLE patient_guardian_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_guardian_history FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON patient_guardian_history
  USING (tenant_id = (SELECT app_current_tenant()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()));

-- Menor privilégio: os DEFAULT PRIVILEGES deram SELECT/INSERT/UPDATE/DELETE ao runtime.
REVOKE DELETE, TRUNCATE ON guardians, patient_guardians, patient_guardian_history FROM app_user;
REVOKE UPDATE ON patient_guardian_history FROM app_user;
