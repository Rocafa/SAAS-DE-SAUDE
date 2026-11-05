-- 0012 — Atendimento e prontuário do MVP (rodada 14.1: PRO-02.1, 02.3, 02.6, 02.7, 03.7, 03.8 —
-- fisio/TO e psicologia). Executar com o papel de MIGRAÇÃO (app_migrator).
-- Ver docs/04-arquitetura/api-dominio.md §8.
--
-- - clinical_settings: configuração de sigilo da clínica. `psych_compartment` decide se o registro de
--   sessão de psicologia fica num compartimento que SÓ o autor lê ('restrito_ao_autor', padrão e mais
--   protetor) ou se segue a regra geral do prontuário único com vínculo de cuidado ('prontuario_unico').
--   Configurável porque a pergunta 1.11 do pacote do advogado (Res. CFP 001/2009, art. 6º) está aberta.
-- - encounters: o atendimento, aberto a partir do agendamento (um por agendamento). Modelo por nicho
--   (fisio, to, psicologia), compartimento derivado do modelo, estado aberto/finalizado e o registro
--   da finalização (versão finalizada + hash). Finalizado é TERMINAL: o banco recusa qualquer UPDATE.
-- - clinical_record_versions: cada salvamento da evolução é uma VERSÃO nova (append-only; nada é
--   apagado nem reescrito). O conteúdo é um JSON validado pelo modelo na API e fica SÓ cifrado
--   (FieldCipher v1, chave da clínica). O banco recusa versão nova em atendimento finalizado.
-- - clinical_addenda: adendo datado depois da finalização (append-only, cifrado). O banco recusa
--   adendo em atendimento ainda aberto.
-- - private_notes: anotações privadas do profissional (HU-PRO-009), em TABELA SEPARADA do prontuário.
--   Só o autor lê/edita (regra na API: toda consulta filtra author_user_id = usuário da sessão).
--   `export_consent` é a decisão expressa do autor de incluir a nota no pacote G2 (padrão: não).
-- Todas com RLS FORÇADO pelo contexto travado (app_current_tenant, 0003), FK compostas com tenant_id
-- e sem DELETE/TRUNCATE para o runtime. Versões e adendos: sem UPDATE também, e triggers que recusam
-- UPDATE/DELETE/TRUNCATE para QUALQUER papel (como a audit_log).
--
-- Empilhamento: vem depois da 0011. NÃO toca o CHECK de audit_log.action: a auditoria usa só ações já
-- existentes (read/create/update/sign/permission_change/consent_change) com escopos novos; 'anomaly_alert'
-- (0010) e todas as outras continuam válidas.

-- Alvo da FK composta de encounters: o atendimento tem o MESMO paciente e profissional do agendamento.
ALTER TABLE appointments ADD CONSTRAINT appointments_encounter_key UNIQUE (id, tenant_id, patient_id, professional_id);

CREATE TABLE clinical_settings (
  tenant_id          uuid PRIMARY KEY REFERENCES tenants (id),
  psych_compartment  text NOT NULL DEFAULT 'restrito_ao_autor'
                     CONSTRAINT clinical_settings_psych_check CHECK (psych_compartment IN ('restrito_ao_autor', 'prontuario_unico')),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid NOT NULL
);

CREATE TABLE encounters (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id),
  patient_id       uuid NOT NULL,
  professional_id  uuid NOT NULL,
  appointment_id   uuid NOT NULL,
  -- Usuário da sessão que abriu (o user_id do profissional do agendamento, R1). Autor do registro.
  author_user_id   uuid NOT NULL,
  template         text NOT NULL CONSTRAINT encounters_template_check CHECK (template IN ('fisio', 'to', 'psicologia')),
  compartment      text NOT NULL CONSTRAINT encounters_compartment_check CHECK (compartment IN ('geral', 'psicologia')),
  -- Consentimento de IA do paciente neste atendimento, nos 3 estados do RIPD do escriba (R12):
  -- 'nao_informado' NEGA. Sem IA nesta rodada: o campo fica registrado para o escriba futuro.
  ai_consent       text NOT NULL DEFAULT 'nao_informado'
                   CONSTRAINT encounters_ai_consent_check CHECK (ai_consent IN ('nao_informado', 'informado_nao_recusou', 'recusou')),
  status           text NOT NULL DEFAULT 'open' CONSTRAINT encounters_status_check CHECK (status IN ('open', 'signed')),
  current_version  integer NOT NULL DEFAULT 0 CONSTRAINT encounters_version_check CHECK (current_version >= 0),
  opened_at        timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  signed_at        timestamptz,
  signed_by        uuid,
  signed_version   integer,
  -- SHA-256 (hex) do registro canônico da finalização (ids, versão, modelo, conteúdo CIFRADO, instante).
  signed_hash      text,
  CONSTRAINT encounters_compartment_template_check CHECK (compartment = CASE WHEN template = 'psicologia' THEN 'psicologia' ELSE 'geral' END),
  CONSTRAINT encounters_signed_check CHECK (
    (status = 'open' AND signed_at IS NULL AND signed_by IS NULL AND signed_version IS NULL AND signed_hash IS NULL)
    OR (status = 'signed' AND signed_at IS NOT NULL AND signed_by IS NOT NULL AND signed_version >= 1
        AND signed_version = current_version AND signed_hash ~ '^[0-9a-f]{64}$')),
  CONSTRAINT encounters_appointment_fk FOREIGN KEY (appointment_id, tenant_id, patient_id, professional_id)
    REFERENCES appointments (id, tenant_id, patient_id, professional_id),
  CONSTRAINT encounters_patient_fk FOREIGN KEY (patient_id, tenant_id) REFERENCES patients (id, tenant_id),
  CONSTRAINT encounters_professional_fk FOREIGN KEY (professional_id, tenant_id) REFERENCES professionals (id, tenant_id),
  CONSTRAINT encounters_appointment_key UNIQUE (tenant_id, appointment_id),
  CONSTRAINT encounters_id_tenant_key UNIQUE (id, tenant_id)
);
CREATE INDEX encounters_tenant_patient_idx ON encounters (tenant_id, patient_id, opened_at DESC, id);

CREATE TABLE clinical_record_versions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id),
  encounter_id      uuid NOT NULL,
  version           integer NOT NULL CONSTRAINT clinical_record_versions_version_check CHECK (version >= 1),
  template          text NOT NULL CONSTRAINT clinical_record_versions_template_check CHECK (template IN ('fisio', 'to', 'psicologia')),
  -- Versão do modelo (PRO-01.4): o registro antigo é lido com o modelo com que foi gravado.
  template_version  integer NOT NULL CONSTRAINT clinical_record_versions_template_version_check CHECK (template_version >= 1),
  content_enc       text NOT NULL CONSTRAINT clinical_record_versions_content_check CHECK (app_is_sealed_field(content_enc)),
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid NOT NULL,
  CONSTRAINT clinical_record_versions_encounter_fk FOREIGN KEY (encounter_id, tenant_id) REFERENCES encounters (id, tenant_id),
  CONSTRAINT clinical_record_versions_version_key UNIQUE (tenant_id, encounter_id, version)
);

CREATE TABLE clinical_addenda (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id),
  encounter_id  uuid NOT NULL,
  text_enc      text NOT NULL CONSTRAINT clinical_addenda_text_check CHECK (app_is_sealed_field(text_enc)),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid NOT NULL,
  CONSTRAINT clinical_addenda_encounter_fk FOREIGN KEY (encounter_id, tenant_id) REFERENCES encounters (id, tenant_id)
);
CREATE INDEX clinical_addenda_tenant_encounter_idx ON clinical_addenda (tenant_id, encounter_id, created_at);

CREATE TABLE private_notes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  patient_id      uuid NOT NULL,
  author_user_id  uuid NOT NULL,
  encounter_id    uuid,
  content_enc     text NOT NULL CONSTRAINT private_notes_content_check CHECK (app_is_sealed_field(content_enc)),
  -- Decisão expressa do autor de incluir a nota na exportação G2 da clínica (HU-PRO-009). Padrão: não.
  export_consent  boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- Descartada pelo autor: some da API; a linha (cifrada) segue a retenção definida no RIPD.
  discarded_at    timestamptz,
  CONSTRAINT private_notes_patient_fk FOREIGN KEY (patient_id, tenant_id) REFERENCES patients (id, tenant_id),
  CONSTRAINT private_notes_encounter_fk FOREIGN KEY (encounter_id, tenant_id) REFERENCES encounters (id, tenant_id)
);
CREATE INDEX private_notes_tenant_author_patient_idx ON private_notes (tenant_id, author_user_id, patient_id, created_at DESC);

-- ---------------------------------------------------------------- integridade (vale para qualquer papel)

-- Versões e adendos são registro de prontuário: nem o runtime nem o dono alteram ou apagam.
CREATE FUNCTION clinical_reject_mutation() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% é append-only: % não permitido', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER clinical_record_versions_no_update_delete BEFORE UPDATE OR DELETE ON clinical_record_versions
  FOR EACH ROW EXECUTE FUNCTION clinical_reject_mutation();
CREATE TRIGGER clinical_record_versions_no_truncate BEFORE TRUNCATE ON clinical_record_versions
  FOR EACH STATEMENT EXECUTE FUNCTION clinical_reject_mutation();
CREATE TRIGGER clinical_addenda_no_update_delete BEFORE UPDATE OR DELETE ON clinical_addenda
  FOR EACH ROW EXECUTE FUNCTION clinical_reject_mutation();
CREATE TRIGGER clinical_addenda_no_truncate BEFORE TRUNCATE ON clinical_addenda
  FOR EACH STATEMENT EXECUTE FUNCTION clinical_reject_mutation();
CREATE TRIGGER encounters_no_delete BEFORE DELETE ON encounters
  FOR EACH ROW EXECUTE FUNCTION clinical_reject_mutation();
CREATE TRIGGER encounters_no_truncate BEFORE TRUNCATE ON encounters
  FOR EACH STATEMENT EXECUTE FUNCTION clinical_reject_mutation();
CREATE TRIGGER private_notes_no_delete BEFORE DELETE ON private_notes
  FOR EACH ROW EXECUTE FUNCTION clinical_reject_mutation();
CREATE TRIGGER private_notes_no_truncate BEFORE TRUNCATE ON private_notes
  FOR EACH STATEMENT EXECUTE FUNCTION clinical_reject_mutation();

-- Atendimento: identidade imutável, versão só avança, finalizado é terminal.
CREATE FUNCTION encounters_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
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
CREATE TRIGGER encounters_guard BEFORE UPDATE ON encounters FOR EACH ROW EXECUTE FUNCTION encounters_guard();

-- Versão nova: só em atendimento aberto, em sequência (sem buraco) e no modelo do atendimento.
-- FOR SHARE espera uma finalização concorrente terminar: a versão nunca entra depois da finalização.
CREATE FUNCTION clinical_record_versions_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  e record;
BEGIN
  SELECT status, current_version, template INTO e FROM encounters
    WHERE id = NEW.encounter_id AND tenant_id = NEW.tenant_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'atendimento inexistente' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF e.status <> 'open' THEN
    RAISE EXCEPTION 'atendimento finalizado não aceita versão nova (use adendo)' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NEW.version <> e.current_version + 1 OR NEW.template <> e.template THEN
    RAISE EXCEPTION 'versão fora de sequência ou de outro modelo' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER clinical_record_versions_guard BEFORE INSERT ON clinical_record_versions
  FOR EACH ROW EXECUTE FUNCTION clinical_record_versions_guard();

-- Adendo: só depois da finalização (antes dela, edita-se o próprio registro).
CREATE FUNCTION clinical_addenda_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  st text;
BEGIN
  SELECT status INTO st FROM encounters WHERE id = NEW.encounter_id AND tenant_id = NEW.tenant_id FOR SHARE;
  IF st IS DISTINCT FROM 'signed' THEN
    RAISE EXCEPTION 'adendo só em atendimento finalizado' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER clinical_addenda_guard BEFORE INSERT ON clinical_addenda
  FOR EACH ROW EXECUTE FUNCTION clinical_addenda_guard();

-- Nota privada: autor, paciente e clínica imutáveis; descartada é terminal.
CREATE FUNCTION private_notes_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.patient_id <> OLD.patient_id OR NEW.author_user_id <> OLD.author_user_id
     OR NEW.encounter_id IS DISTINCT FROM OLD.encounter_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'identidade da nota privada é imutável' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.discarded_at IS NOT NULL THEN
    RAISE EXCEPTION 'nota privada descartada não muda' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER private_notes_guard BEFORE UPDATE ON private_notes FOR EACH ROW EXECUTE FUNCTION private_notes_guard();

-- ---------------------------------------------------------------- RLS

ALTER TABLE clinical_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinical_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON clinical_settings
  USING (tenant_id = (SELECT app_current_tenant()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()));

ALTER TABLE encounters ENABLE ROW LEVEL SECURITY;
ALTER TABLE encounters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON encounters
  USING (tenant_id = (SELECT app_current_tenant()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()));

ALTER TABLE clinical_record_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinical_record_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON clinical_record_versions
  USING (tenant_id = (SELECT app_current_tenant()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()));

ALTER TABLE clinical_addenda ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinical_addenda FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON clinical_addenda
  USING (tenant_id = (SELECT app_current_tenant()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()));

ALTER TABLE private_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON private_notes
  USING (tenant_id = (SELECT app_current_tenant()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()));

-- Menor privilégio: os DEFAULT PRIVILEGES deram SELECT/INSERT/UPDATE/DELETE ao runtime.
REVOKE DELETE, TRUNCATE ON clinical_settings, encounters, clinical_record_versions, clinical_addenda, private_notes FROM app_user;
-- Versões e adendos: append-only também no privilégio (além do trigger).
REVOKE UPDATE ON clinical_record_versions, clinical_addenda FROM app_user;
