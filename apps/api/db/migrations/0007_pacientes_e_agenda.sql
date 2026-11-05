-- 0007 — Domínio mínimo de pacientes e agenda (rodada 11.1). Executar com o papel de MIGRAÇÃO (app_migrator).
-- Ver docs/04-arquitetura/api-dominio.md.
--
-- - patients ganha cadastro mínimo. CPF, telefone e nascimento ficam SÓ cifrados (formato v1 do
--   FieldCipher, chave da clínica, AAD = clínica + tabela + coluna + linha). O CHECK recusa valor em
--   claro: um INSERT que não passe pela API também não grava CPF legível.
-- - professionals: quem atende, com `capacity` (AGD-01.5: atendimentos simultâneos do profissional).
-- - appointment_types: tipo de atendimento com duração e `capacity` (ex.: grupo com até 4 pacientes).
-- - appointments: um paciente por linha (cada um com status próprio), sempre da MESMA clínica do
--   paciente, do profissional e do tipo (FK compostas com tenant_id).
-- Todas com RLS FORÇADO e policy pelo contexto travado (app_current_tenant, migração 0003).
-- Nenhuma tabela NOVA permite DELETE ao runtime: inativar/cancelar, nunca apagar (retenção).

-- Formato do campo cifrado (field-format.ts): v1:<uuid da DEK>:<iv>:<tag>:<dado>.
CREATE FUNCTION app_is_sealed_field(v text) RETURNS boolean
  LANGUAGE sql IMMUTABLE
  SET search_path = pg_catalog
AS $$
  SELECT v ~ '^v1:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]*$'
$$;

ALTER TABLE patients
  ADD COLUMN social_name    text,
  ADD COLUMN search_name    text NOT NULL DEFAULT '',
  ADD COLUMN cpf_enc        text,
  ADD COLUMN phone_enc      text,
  ADD COLUMN birth_date_enc text,
  ADD COLUMN active         boolean NOT NULL DEFAULT true,
  ADD COLUMN inactivated_at timestamptz,
  ADD COLUMN updated_at     timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT patients_display_name_check CHECK (length(display_name) BETWEEN 1 AND 200),
  ADD CONSTRAINT patients_social_name_check CHECK (social_name IS NULL OR length(social_name) BETWEEN 1 AND 200),
  ADD CONSTRAINT patients_search_name_check CHECK (length(search_name) <= 420),
  ADD CONSTRAINT patients_cpf_enc_check CHECK (cpf_enc IS NULL OR app_is_sealed_field(cpf_enc)),
  ADD CONSTRAINT patients_phone_enc_check CHECK (phone_enc IS NULL OR app_is_sealed_field(phone_enc)),
  ADD CONSTRAINT patients_birth_date_enc_check CHECK (birth_date_enc IS NULL OR app_is_sealed_field(birth_date_enc)),
  ADD CONSTRAINT patients_inactivated_check CHECK (active = (inactivated_at IS NULL)),
  -- Alvo das FK compostas: agendamento só aponta para paciente da MESMA clínica.
  ADD CONSTRAINT patients_id_tenant_key UNIQUE (id, tenant_id);
-- Busca por nome dentro da clínica (prefixo/trecho; o RLS já restringe à clínica).
CREATE INDEX patients_tenant_search_idx ON patients (tenant_id, search_name, id);

-- Retenção (front-r8 R4): a API não tem rota de exclusão de paciente; inativa. O DELETE do runtime em
-- patients continua (0001) porque as suítes de segurança/resiliência o usam como sonda; retirá-lo
-- fica para a microparte de retenção. Com agendamento, a FK de appointments já impede a exclusão.

CREATE TABLE professionals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  -- Usuário (sessão) vinculado: é o que liga o perfil "profissional" à agenda dele.
  user_id      uuid,
  display_name text NOT NULL CONSTRAINT professionals_display_name_check CHECK (length(display_name) BETWEEN 1 AND 200),
  specialty    text NOT NULL CONSTRAINT professionals_specialty_check CHECK (length(specialty) BETWEEN 1 AND 100),
  capacity     integer NOT NULL DEFAULT 1 CONSTRAINT professionals_capacity_check CHECK (capacity BETWEEN 1 AND 20),
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT professionals_id_tenant_key UNIQUE (id, tenant_id)
);
CREATE INDEX professionals_tenant_idx ON professionals (tenant_id);
CREATE UNIQUE INDEX professionals_tenant_user_idx ON professionals (tenant_id, user_id) WHERE user_id IS NOT NULL;

CREATE TABLE appointment_types (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id),
  name             text NOT NULL CONSTRAINT appointment_types_name_check CHECK (length(name) BETWEEN 1 AND 100),
  duration_minutes integer NOT NULL CONSTRAINT appointment_types_duration_check CHECK (duration_minutes BETWEEN 5 AND 480),
  capacity         integer NOT NULL DEFAULT 1 CONSTRAINT appointment_types_capacity_check CHECK (capacity BETWEEN 1 AND 20),
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT appointment_types_id_tenant_key UNIQUE (id, tenant_id)
);
CREATE INDEX appointment_types_tenant_idx ON appointment_types (tenant_id);

CREATE TABLE appointments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id),
  patient_id          uuid NOT NULL,
  professional_id     uuid NOT NULL,
  appointment_type_id uuid NOT NULL,
  starts_at           timestamptz NOT NULL,
  ends_at             timestamptz NOT NULL,
  -- Mesmos valores de AppointmentStatus (packages/shared/src/enums.ts).
  status              text NOT NULL DEFAULT 'scheduled' CONSTRAINT appointments_status_check CHECK (status IN (
                        'scheduled', 'confirmed', 'checked_in', 'in_progress', 'completed', 'cancelled', 'no_show')),
  -- Encaixe: marcado acima da capacidade do horário, por decisão explícita de quem agenda.
  is_walk_in          boolean NOT NULL DEFAULT false,
  checked_in_at       timestamptz,
  cancelled_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT appointments_period_check CHECK (ends_at > starts_at AND ends_at - starts_at <= interval '12 hours'),
  CONSTRAINT appointments_cancelled_check CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CONSTRAINT appointments_patient_fk FOREIGN KEY (patient_id, tenant_id) REFERENCES patients (id, tenant_id),
  CONSTRAINT appointments_professional_fk FOREIGN KEY (professional_id, tenant_id) REFERENCES professionals (id, tenant_id),
  CONSTRAINT appointments_type_fk FOREIGN KEY (appointment_type_id, tenant_id) REFERENCES appointment_types (id, tenant_id)
);
CREATE INDEX appointments_tenant_starts_idx ON appointments (tenant_id, starts_at);
CREATE INDEX appointments_professional_starts_idx ON appointments (tenant_id, professional_id, starts_at);
CREATE INDEX appointments_patient_idx ON appointments (tenant_id, patient_id);

ALTER TABLE professionals ENABLE ROW LEVEL SECURITY;
ALTER TABLE professionals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON professionals
  USING (tenant_id = (SELECT app_current_tenant()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()));

ALTER TABLE appointment_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointment_types FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON appointment_types
  USING (tenant_id = (SELECT app_current_tenant()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()));

ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON appointments
  USING (tenant_id = (SELECT app_current_tenant()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()));

-- Menor privilégio: os DEFAULT PRIVILEGES deram SELECT/INSERT/UPDATE/DELETE ao runtime.
REVOKE DELETE, TRUNCATE ON professionals, appointment_types, appointments FROM app_user;
