-- 0011 — Controle de guia de convênio SIMPLES (sem XML TISS) e pacotes de sessões (rodada 13.2,
-- EP-24: CNV-04.1 a 04.6 e FIN-01.5). Executar com o papel de MIGRAÇÃO (app_migrator).
-- Ver docs/04-arquitetura/api-dominio.md §7.
--
-- - insurers: convênios da clínica (nome, registro ANS opcional, valor por sessão, exigências).
-- - insurance_guides: guia do paciente num convênio. Número da guia, senha de autorização e nº da
--   carteirinha são identificadores do paciente na operadora: ficam SÓ cifrados (formato v1 do
--   FieldCipher, chave da clínica; o CHECK recusa valor em claro). `used_sessions` é o contador do
--   saldo, com CHECK 0 <= usadas <= autorizadas: nem um bug nem uma corrida deixam o saldo negativo.
-- - guide_sessions: consumo de 1 sessão da guia por agendamento; estorno marca reversed_at (nunca
--   apaga). Um agendamento tem no máximo UM consumo ativo por guia (índice único parcial).
-- - guide_session_signatures: confirmação do paciente por sessão (registro, sem biometria), com hash.
--   Append-only: o runtime só tem SELECT/INSERT (alterar ou apagar a assinatura é recusado pelo banco).
-- - session_packages / package_sessions: pacote particular de sessões com saldo e histórico.
-- Todas com RLS FORÇADO, policy pelo contexto travado (app_current_tenant, 0003), FK compostas com
-- tenant_id (nada aponta para outra clínica) e sem DELETE/TRUNCATE para o runtime (retenção).

-- Alvo das FK compostas de guide_sessions/package_sessions (consumo só de agendamento da MESMA clínica).
ALTER TABLE appointments ADD CONSTRAINT appointments_id_tenant_key UNIQUE (id, tenant_id);

CREATE TABLE insurers (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants (id),
  name                  text NOT NULL CONSTRAINT insurers_name_check CHECK (length(name) BETWEEN 1 AND 120),
  -- Registro da operadora na ANS (6 dígitos), opcional.
  ans_code              text CONSTRAINT insurers_ans_code_check CHECK (ans_code IS NULL OR ans_code ~ '^[0-9]{6}$'),
  -- Valor por sessão em centavos (até R$ 100.000,00), opcional.
  session_value_cents   integer CONSTRAINT insurers_session_value_check CHECK (session_value_cents IS NULL OR session_value_cents BETWEEN 0 AND 10000000),
  requires_password     boolean NOT NULL DEFAULT false,
  requires_signature    boolean NOT NULL DEFAULT false,
  default_validity_days integer CONSTRAINT insurers_validity_days_check CHECK (default_validity_days IS NULL OR default_validity_days BETWEEN 1 AND 365),
  active                boolean NOT NULL DEFAULT true,
  inactivated_at        timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT insurers_inactivated_check CHECK (active = (inactivated_at IS NULL)),
  CONSTRAINT insurers_id_tenant_key UNIQUE (id, tenant_id)
);
CREATE UNIQUE INDEX insurers_tenant_name_idx ON insurers (tenant_id, lower(name));

CREATE TABLE insurance_guides (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants (id),
  patient_id              uuid NOT NULL,
  insurer_id              uuid NOT NULL,
  number_enc              text NOT NULL CONSTRAINT insurance_guides_number_enc_check CHECK (app_is_sealed_field(number_enc)),
  authorization_code_enc  text CONSTRAINT insurance_guides_authorization_enc_check CHECK (authorization_code_enc IS NULL OR app_is_sealed_field(authorization_code_enc)),
  card_number_enc         text CONSTRAINT insurance_guides_card_enc_check CHECK (card_number_enc IS NULL OR app_is_sealed_field(card_number_enc)),
  authorized_sessions     integer NOT NULL CONSTRAINT insurance_guides_authorized_check CHECK (authorized_sessions BETWEEN 1 AND 200),
  used_sessions           integer NOT NULL DEFAULT 0,
  issued_on               date,
  valid_until             date NOT NULL,
  status                  text NOT NULL DEFAULT 'active' CONSTRAINT insurance_guides_status_check CHECK (status IN ('active', 'cancelled')),
  cancelled_at            timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  -- Saldo nunca negativo: barreira final, além da trava de linha na API.
  CONSTRAINT insurance_guides_used_check CHECK (used_sessions >= 0 AND used_sessions <= authorized_sessions),
  CONSTRAINT insurance_guides_dates_check CHECK (issued_on IS NULL OR issued_on <= valid_until),
  CONSTRAINT insurance_guides_cancelled_check CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CONSTRAINT insurance_guides_patient_fk FOREIGN KEY (patient_id, tenant_id) REFERENCES patients (id, tenant_id),
  CONSTRAINT insurance_guides_insurer_fk FOREIGN KEY (insurer_id, tenant_id) REFERENCES insurers (id, tenant_id),
  CONSTRAINT insurance_guides_id_tenant_key UNIQUE (id, tenant_id)
);
CREATE INDEX insurance_guides_tenant_patient_idx ON insurance_guides (tenant_id, patient_id);
CREATE INDEX insurance_guides_tenant_insurer_idx ON insurance_guides (tenant_id, insurer_id, status);
CREATE INDEX insurance_guides_tenant_valid_idx ON insurance_guides (tenant_id, status, valid_until);

CREATE TABLE guide_sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id),
  guide_id         uuid NOT NULL,
  appointment_id   uuid NOT NULL,
  consumed_at      timestamptz NOT NULL DEFAULT now(),
  consumed_by      uuid NOT NULL,
  -- Consumo de guia vencida só com override e motivo (código; nunca texto livre).
  override_reason  text CONSTRAINT guide_sessions_override_check CHECK (override_reason IS NULL OR override_reason IN (
                     'prorrogacao_da_operadora', 'renovacao_em_andamento', 'decisao_da_clinica')),
  reversed_at      timestamptz,
  reversed_by      uuid,
  reversal_reason  text CONSTRAINT guide_sessions_reversal_check CHECK (reversal_reason IS NULL OR reversal_reason IN (
                     'status_corrigido', 'lancamento_errado', 'guia_errada')),
  CONSTRAINT guide_sessions_reversed_check CHECK (
    (reversed_at IS NULL AND reversed_by IS NULL AND reversal_reason IS NULL)
    OR (reversed_at IS NOT NULL AND reversed_by IS NOT NULL AND reversal_reason IS NOT NULL)),
  CONSTRAINT guide_sessions_guide_fk FOREIGN KEY (guide_id, tenant_id) REFERENCES insurance_guides (id, tenant_id),
  CONSTRAINT guide_sessions_appointment_fk FOREIGN KEY (appointment_id, tenant_id) REFERENCES appointments (id, tenant_id),
  CONSTRAINT guide_sessions_id_tenant_key UNIQUE (id, tenant_id)
);
-- Um agendamento consome no máximo uma sessão de guia por vez (o estorno libera).
CREATE UNIQUE INDEX guide_sessions_active_appointment_idx ON guide_sessions (tenant_id, appointment_id) WHERE reversed_at IS NULL;
CREATE INDEX guide_sessions_tenant_guide_idx ON guide_sessions (tenant_id, guide_id, consumed_at);
CREATE INDEX guide_sessions_tenant_consumed_idx ON guide_sessions (tenant_id, consumed_at);

CREATE TABLE guide_session_signatures (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id),
  guide_session_id uuid NOT NULL,
  -- 'tela': o paciente confirmou na tela (tablet/celular); 'papel': assinou a folha de frequência.
  method           text NOT NULL CONSTRAINT guide_session_signatures_method_check CHECK (method IN ('tela', 'papel')),
  -- Rótulo do dispositivo cadastrado pela clínica (ex.: "tablet-recepcao-1"); nunca dado do paciente.
  device_label     text CONSTRAINT guide_session_signatures_device_check CHECK (device_label IS NULL OR device_label ~ '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$'),
  signed_at        timestamptz NOT NULL DEFAULT now(),
  recorded_by      uuid NOT NULL,
  -- SHA-256 (hex) do registro canônico (clínica, sessão, agendamento, guia, meio, dispositivo, instante).
  record_hash      text NOT NULL CONSTRAINT guide_session_signatures_hash_check CHECK (record_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT guide_session_signatures_session_fk FOREIGN KEY (guide_session_id, tenant_id) REFERENCES guide_sessions (id, tenant_id),
  CONSTRAINT guide_session_signatures_session_key UNIQUE (tenant_id, guide_session_id)
);

CREATE TABLE session_packages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id),
  patient_id          uuid NOT NULL,
  appointment_type_id uuid,
  name                text NOT NULL CONSTRAINT session_packages_name_check CHECK (length(name) BETWEEN 1 AND 100),
  total_sessions      integer NOT NULL CONSTRAINT session_packages_total_check CHECK (total_sessions BETWEEN 1 AND 200),
  used_sessions       integer NOT NULL DEFAULT 0,
  valid_until         date,
  status              text NOT NULL DEFAULT 'active' CONSTRAINT session_packages_status_check CHECK (status IN ('active', 'cancelled')),
  cancelled_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT session_packages_used_check CHECK (used_sessions >= 0 AND used_sessions <= total_sessions),
  CONSTRAINT session_packages_cancelled_check CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CONSTRAINT session_packages_patient_fk FOREIGN KEY (patient_id, tenant_id) REFERENCES patients (id, tenant_id),
  CONSTRAINT session_packages_type_fk FOREIGN KEY (appointment_type_id, tenant_id) REFERENCES appointment_types (id, tenant_id),
  CONSTRAINT session_packages_id_tenant_key UNIQUE (id, tenant_id)
);
CREATE INDEX session_packages_tenant_patient_idx ON session_packages (tenant_id, patient_id);

CREATE TABLE package_sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id),
  package_id       uuid NOT NULL,
  appointment_id   uuid NOT NULL,
  consumed_at      timestamptz NOT NULL DEFAULT now(),
  consumed_by      uuid NOT NULL,
  reversed_at      timestamptz,
  reversed_by      uuid,
  reversal_reason  text CONSTRAINT package_sessions_reversal_check CHECK (reversal_reason IS NULL OR reversal_reason IN (
                     'status_corrigido', 'lancamento_errado', 'pacote_errado')),
  CONSTRAINT package_sessions_reversed_check CHECK (
    (reversed_at IS NULL AND reversed_by IS NULL AND reversal_reason IS NULL)
    OR (reversed_at IS NOT NULL AND reversed_by IS NOT NULL AND reversal_reason IS NOT NULL)),
  CONSTRAINT package_sessions_package_fk FOREIGN KEY (package_id, tenant_id) REFERENCES session_packages (id, tenant_id),
  CONSTRAINT package_sessions_appointment_fk FOREIGN KEY (appointment_id, tenant_id) REFERENCES appointments (id, tenant_id)
);
CREATE UNIQUE INDEX package_sessions_active_appointment_idx ON package_sessions (tenant_id, appointment_id) WHERE reversed_at IS NULL;
CREATE INDEX package_sessions_tenant_package_idx ON package_sessions (tenant_id, package_id, consumed_at);

ALTER TABLE insurers ENABLE ROW LEVEL SECURITY;
ALTER TABLE insurers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON insurers
  USING (tenant_id = (SELECT app_current_tenant()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()));

ALTER TABLE insurance_guides ENABLE ROW LEVEL SECURITY;
ALTER TABLE insurance_guides FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON insurance_guides
  USING (tenant_id = (SELECT app_current_tenant()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()));

ALTER TABLE guide_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE guide_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON guide_sessions
  USING (tenant_id = (SELECT app_current_tenant()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()));

ALTER TABLE guide_session_signatures ENABLE ROW LEVEL SECURITY;
ALTER TABLE guide_session_signatures FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON guide_session_signatures
  USING (tenant_id = (SELECT app_current_tenant()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()));

ALTER TABLE session_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_packages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON session_packages
  USING (tenant_id = (SELECT app_current_tenant()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()));

ALTER TABLE package_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE package_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON package_sessions
  USING (tenant_id = (SELECT app_current_tenant()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()));

-- Menor privilégio: os DEFAULT PRIVILEGES deram SELECT/INSERT/UPDATE/DELETE ao runtime.
REVOKE DELETE, TRUNCATE ON insurers, insurance_guides, guide_sessions, guide_session_signatures,
  session_packages, package_sessions FROM app_user;
-- Assinatura é registro de prova: depois de gravada, nem o runtime altera.
REVOKE UPDATE ON guide_session_signatures FROM app_user;
