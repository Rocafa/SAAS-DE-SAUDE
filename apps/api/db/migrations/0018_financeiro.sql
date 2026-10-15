-- 0018 — Financeiro do MVP (rodada 15.2; FIN-01.1 a 01.4 e FIN-01.8; HU-FIN-001/002/003/006).
-- Executar com o papel de MIGRAÇÃO (app_migrator). Ver docs/04-arquitetura/api-dominio.md §9.
--
-- SEM PSP de Pix (D5 pendente): Pix é registrado à mão (`pix_manual`). Valores SEMPRE em centavos
-- inteiros. Nada é apagado: cobrança se cancela, recebimento se estorna (linha própria), recibo se
-- cancela (linha própria). Caixa fechado é terminal.
--
-- - finance_settings: por clínica, o TEXTO NEUTRO do recibo/cobrança (padrão "Atendimento"; nunca
--   diagnóstico, especialidade ou procedimento), o tipo de atendimento padrão (pf/pj), o emitente PJ e
--   se o registro no conselho aparece no recibo PF (padrão: não, porque o conselho revela a profissão).
-- - professional_fiscal_profiles: CPF (só cifrado) e registro no conselho do profissional que atende
--   como PESSOA FÍSICA (emitente do Receita Saúde).
-- - cash_sessions: caixa por dia (fuso da clínica) e turno; um por (dia, turno); fechado é terminal.
-- - charges: conta a receber ligada a UM agendamento OU a UM pacote; pf × pj (insumo do Receita
--   Saúde); pagador terceiro opcional (CPF só cifrado). `paid_cents` com CHECK 0..amount: nem um bug
--   nem uma corrida recebem além do valor.
-- - payments: recebimento (dinheiro, cartão, Pix manual, transferência, convênio) num caixa ABERTO.
-- - payment_reversals: estorno total de um recebimento, registrado no caixa aberto do momento.
-- - receipt_counters / receipts / receipt_cancellations: recibo numerado por clínica, SEM BURACO (o
--   número sai do contador na MESMA transação do INSERT; rollback devolve o número), imutável (o
--   conteúdo é um retrato cifrado do momento da emissão) e cancelado só por registro próprio.
-- Todas com RLS FORÇADO pela policy do contexto travado (app_current_tenant, 0003), FK compostas com
-- tenant_id e sem DELETE/TRUNCATE para o runtime. Não toca o CHECK de audit_log.action.
--
-- Empilhamento: vem depois da 0016/0017 (#61/#63) e DEPENDE da 0016 (app_current_user: o banco confere
-- que quem lança é o usuário da sessão).

-- Alvos das FK compostas já existem: patients/professionals (0007), appointments e session_packages (0011).

-- ---------------------------------------------------------------- configuração e perfil fiscal

CREATE TABLE finance_settings (
  tenant_id               uuid PRIMARY KEY REFERENCES tenants (id),
  -- Texto que vai no recibo e na descrição da cobrança. Neutro por padrão (bases-legais l.32).
  receipt_description     text NOT NULL DEFAULT 'Atendimento'
                          CONSTRAINT finance_settings_description_check CHECK (length(receipt_description) BETWEEN 3 AND 60),
  default_attendance_kind text NOT NULL DEFAULT 'pj'
                          CONSTRAINT finance_settings_kind_check CHECK (default_attendance_kind IN ('pf', 'pj')),
  -- Emitente PJ (razão social e CNPJ da clínica; CNPJ não é dado pessoal).
  issuer_name             text CONSTRAINT finance_settings_issuer_name_check CHECK (issuer_name IS NULL OR length(issuer_name) BETWEEN 2 AND 120),
  issuer_cnpj             text CONSTRAINT finance_settings_issuer_cnpj_check CHECK (issuer_cnpj IS NULL OR issuer_cnpj ~ '^[0-9]{14}$'),
  show_council_on_receipt boolean NOT NULL DEFAULT false,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  updated_by              uuid NOT NULL
);

CREATE TABLE professional_fiscal_profiles (
  tenant_id           uuid NOT NULL REFERENCES tenants (id),
  professional_id     uuid NOT NULL,
  cpf_enc             text CONSTRAINT professional_fiscal_profiles_cpf_check CHECK (cpf_enc IS NULL OR app_is_sealed_field(cpf_enc)),
  council_registration text CONSTRAINT professional_fiscal_profiles_council_check
                      CHECK (council_registration IS NULL OR council_registration ~ '^[A-Za-z0-9][A-Za-z0-9 ./-]{1,39}$'),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid NOT NULL,
  PRIMARY KEY (tenant_id, professional_id),
  CONSTRAINT professional_fiscal_profiles_professional_fk FOREIGN KEY (professional_id, tenant_id) REFERENCES professionals (id, tenant_id)
);

-- ---------------------------------------------------------------- caixa

CREATE TABLE cash_sessions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants (id),
  business_date        date NOT NULL,
  shift                text NOT NULL CONSTRAINT cash_sessions_shift_check CHECK (shift IN ('manha', 'tarde', 'noite', 'unico')),
  opening_float_cents  integer NOT NULL DEFAULT 0 CONSTRAINT cash_sessions_float_check CHECK (opening_float_cents BETWEEN 0 AND 10000000),
  status               text NOT NULL DEFAULT 'open' CONSTRAINT cash_sessions_status_check CHECK (status IN ('open', 'closed')),
  opened_at            timestamptz NOT NULL DEFAULT now(),
  opened_by            uuid NOT NULL,
  closed_at            timestamptz,
  closed_by            uuid,
  expected_cash_cents  bigint,
  counted_cash_cents   bigint CONSTRAINT cash_sessions_counted_check CHECK (counted_cash_cents IS NULL OR counted_cash_cents BETWEEN 0 AND 1000000000),
  CONSTRAINT cash_sessions_closed_check CHECK (
    (status = 'open' AND closed_at IS NULL AND closed_by IS NULL AND expected_cash_cents IS NULL AND counted_cash_cents IS NULL)
    OR (status = 'closed' AND closed_at IS NOT NULL AND closed_by IS NOT NULL AND expected_cash_cents IS NOT NULL AND counted_cash_cents IS NOT NULL)),
  CONSTRAINT cash_sessions_day_shift_key UNIQUE (tenant_id, business_date, shift),
  CONSTRAINT cash_sessions_id_tenant_key UNIQUE (id, tenant_id)
);
CREATE INDEX cash_sessions_tenant_open_idx ON cash_sessions (tenant_id, status, business_date);

-- ---------------------------------------------------------------- contas a receber

CREATE TABLE charges (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id),
  patient_id       uuid NOT NULL,
  appointment_id   uuid,
  package_id       uuid,
  professional_id  uuid,
  -- pf: profissional pessoa física (recibo do Receita Saúde); pj: clínica/CNPJ (NFS-e, fora do MVP).
  attendance_kind  text NOT NULL CONSTRAINT charges_kind_check CHECK (attendance_kind IN ('pf', 'pj')),
  amount_cents     integer NOT NULL CONSTRAINT charges_amount_check CHECK (amount_cents BETWEEN 1 AND 100000000),
  paid_cents       integer NOT NULL DEFAULT 0,
  due_date         date NOT NULL,
  -- Pagador diferente do paciente (ex.: responsável). Nome em claro como o do paciente; CPF só cifrado.
  payer_name       text CONSTRAINT charges_payer_name_check CHECK (payer_name IS NULL OR length(payer_name) BETWEEN 2 AND 120),
  payer_cpf_enc    text CONSTRAINT charges_payer_cpf_check CHECK (payer_cpf_enc IS NULL OR app_is_sealed_field(payer_cpf_enc)),
  status           text NOT NULL DEFAULT 'open' CONSTRAINT charges_status_check CHECK (status IN ('open', 'cancelled')),
  cancelled_at     timestamptz,
  cancelled_by     uuid,
  cancel_reason    text CONSTRAINT charges_cancel_reason_check CHECK (cancel_reason IS NULL OR cancel_reason IN (
                     'lancamento_errado', 'cortesia', 'atendimento_nao_realizado', 'cobranca_duplicada')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid NOT NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- Exatamente um alvo: o atendimento (agendamento) ou o pacote.
  CONSTRAINT charges_target_check CHECK (num_nonnulls(appointment_id, package_id) = 1),
  CONSTRAINT charges_paid_check CHECK (paid_cents >= 0 AND paid_cents <= amount_cents),
  CONSTRAINT charges_payer_check CHECK (payer_cpf_enc IS NULL OR payer_name IS NOT NULL),
  -- Cobrança paga (no todo ou em parte) não se cancela: estorne antes.
  CONSTRAINT charges_cancelled_check CHECK (
    (status = 'open' AND cancelled_at IS NULL AND cancelled_by IS NULL AND cancel_reason IS NULL)
    OR (status = 'cancelled' AND cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL AND cancel_reason IS NOT NULL AND paid_cents = 0)),
  -- PF exige o profissional (emitente do Receita Saúde).
  CONSTRAINT charges_pf_professional_check CHECK (attendance_kind = 'pj' OR professional_id IS NOT NULL),
  CONSTRAINT charges_patient_fk FOREIGN KEY (patient_id, tenant_id) REFERENCES patients (id, tenant_id),
  CONSTRAINT charges_appointment_fk FOREIGN KEY (appointment_id, tenant_id) REFERENCES appointments (id, tenant_id),
  CONSTRAINT charges_package_fk FOREIGN KEY (package_id, tenant_id) REFERENCES session_packages (id, tenant_id),
  CONSTRAINT charges_professional_fk FOREIGN KEY (professional_id, tenant_id) REFERENCES professionals (id, tenant_id),
  CONSTRAINT charges_id_tenant_key UNIQUE (id, tenant_id)
);
-- Um atendimento/pacote tem no máximo UMA cobrança viva (cancelar libera).
CREATE UNIQUE INDEX charges_active_appointment_idx ON charges (tenant_id, appointment_id) WHERE status = 'open' AND appointment_id IS NOT NULL;
CREATE UNIQUE INDEX charges_active_package_idx ON charges (tenant_id, package_id) WHERE status = 'open' AND package_id IS NOT NULL;
CREATE INDEX charges_tenant_due_idx ON charges (tenant_id, due_date);
CREATE INDEX charges_tenant_patient_idx ON charges (tenant_id, patient_id);

CREATE TABLE payments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id),
  charge_id        uuid NOT NULL,
  cash_session_id  uuid NOT NULL,
  method           text NOT NULL CONSTRAINT payments_method_check CHECK (method IN (
                     'dinheiro', 'cartao_credito', 'cartao_debito', 'pix_manual', 'transferencia', 'convenio')),
  amount_cents     integer NOT NULL CONSTRAINT payments_amount_check CHECK (amount_cents BETWEEN 1 AND 100000000),
  received_at      timestamptz NOT NULL DEFAULT now(),
  received_by      uuid NOT NULL,
  CONSTRAINT payments_charge_fk FOREIGN KEY (charge_id, tenant_id) REFERENCES charges (id, tenant_id),
  CONSTRAINT payments_cash_session_fk FOREIGN KEY (cash_session_id, tenant_id) REFERENCES cash_sessions (id, tenant_id),
  CONSTRAINT payments_id_tenant_key UNIQUE (id, tenant_id)
);
CREATE INDEX payments_tenant_charge_idx ON payments (tenant_id, charge_id);
CREATE INDEX payments_tenant_session_idx ON payments (tenant_id, cash_session_id);
CREATE INDEX payments_tenant_received_idx ON payments (tenant_id, received_at);

CREATE TABLE payment_reversals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id),
  payment_id       uuid NOT NULL,
  -- Caixa ABERTO no momento do estorno (o dinheiro sai da gaveta de hoje, não da de ontem).
  cash_session_id  uuid NOT NULL,
  reason           text NOT NULL CONSTRAINT payment_reversals_reason_check CHECK (reason IN (
                     'lancamento_errado', 'devolucao_ao_pagador', 'pagamento_nao_compensado', 'forma_errada')),
  reversed_at      timestamptz NOT NULL DEFAULT now(),
  reversed_by      uuid NOT NULL,
  CONSTRAINT payment_reversals_payment_fk FOREIGN KEY (payment_id, tenant_id) REFERENCES payments (id, tenant_id),
  CONSTRAINT payment_reversals_cash_session_fk FOREIGN KEY (cash_session_id, tenant_id) REFERENCES cash_sessions (id, tenant_id),
  -- Estorno é total e único por recebimento.
  CONSTRAINT payment_reversals_payment_key UNIQUE (tenant_id, payment_id)
);
CREATE INDEX payment_reversals_tenant_session_idx ON payment_reversals (tenant_id, cash_session_id);

-- ---------------------------------------------------------------- recibos

CREATE TABLE receipt_counters (
  tenant_id    uuid PRIMARY KEY REFERENCES tenants (id),
  last_number  bigint NOT NULL CONSTRAINT receipt_counters_positive_check CHECK (last_number >= 1)
);

CREATE TABLE receipts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants (id),
  number       bigint NOT NULL CONSTRAINT receipts_number_check CHECK (number >= 1),
  payment_id   uuid NOT NULL,
  -- Retrato do recibo no momento da emissão (emitente, pagador, beneficiário, CPFs, valor, forma,
  -- data e o texto neutro), JSON SÓ cifrado: mudar o cadastro depois não muda o recibo emitido.
  content_enc  text NOT NULL CONSTRAINT receipts_content_check CHECK (app_is_sealed_field(content_enc)),
  issued_at    timestamptz NOT NULL DEFAULT now(),
  issued_by    uuid NOT NULL,
  CONSTRAINT receipts_payment_fk FOREIGN KEY (payment_id, tenant_id) REFERENCES payments (id, tenant_id),
  CONSTRAINT receipts_number_key UNIQUE (tenant_id, number),
  CONSTRAINT receipts_id_tenant_key UNIQUE (id, tenant_id)
);
CREATE INDEX receipts_tenant_payment_idx ON receipts (tenant_id, payment_id);
CREATE INDEX receipts_tenant_issued_idx ON receipts (tenant_id, issued_at);

CREATE TABLE receipt_cancellations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id),
  receipt_id    uuid NOT NULL,
  reason        text NOT NULL CONSTRAINT receipt_cancellations_reason_check CHECK (reason IN (
                  'dados_incorretos', 'emitido_por_engano', 'recebimento_estornado')),
  cancelled_at  timestamptz NOT NULL DEFAULT now(),
  cancelled_by  uuid NOT NULL,
  CONSTRAINT receipt_cancellations_receipt_fk FOREIGN KEY (receipt_id, tenant_id) REFERENCES receipts (id, tenant_id),
  CONSTRAINT receipt_cancellations_receipt_key UNIQUE (tenant_id, receipt_id)
);

-- ---------------------------------------------------------------- integridade (vale para qualquer papel)

-- Recebimento, estorno, recibo e cancelamento de recibo são registro financeiro: ninguém altera ou apaga.
CREATE FUNCTION finance_reject_mutation() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% é append-only: % não permitido', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER payments_no_update_delete BEFORE UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION finance_reject_mutation();
CREATE TRIGGER payments_no_truncate BEFORE TRUNCATE ON payments
  FOR EACH STATEMENT EXECUTE FUNCTION finance_reject_mutation();
CREATE TRIGGER payment_reversals_no_update_delete BEFORE UPDATE OR DELETE ON payment_reversals
  FOR EACH ROW EXECUTE FUNCTION finance_reject_mutation();
CREATE TRIGGER payment_reversals_no_truncate BEFORE TRUNCATE ON payment_reversals
  FOR EACH STATEMENT EXECUTE FUNCTION finance_reject_mutation();
CREATE TRIGGER receipts_no_update_delete BEFORE UPDATE OR DELETE ON receipts
  FOR EACH ROW EXECUTE FUNCTION finance_reject_mutation();
CREATE TRIGGER receipts_no_truncate BEFORE TRUNCATE ON receipts
  FOR EACH STATEMENT EXECUTE FUNCTION finance_reject_mutation();
CREATE TRIGGER receipt_cancellations_no_update_delete BEFORE UPDATE OR DELETE ON receipt_cancellations
  FOR EACH ROW EXECUTE FUNCTION finance_reject_mutation();
CREATE TRIGGER receipt_cancellations_no_truncate BEFORE TRUNCATE ON receipt_cancellations
  FOR EACH STATEMENT EXECUTE FUNCTION finance_reject_mutation();
CREATE TRIGGER charges_no_delete BEFORE DELETE ON charges
  FOR EACH ROW EXECUTE FUNCTION finance_reject_mutation();
CREATE TRIGGER charges_no_truncate BEFORE TRUNCATE ON charges
  FOR EACH STATEMENT EXECUTE FUNCTION finance_reject_mutation();
CREATE TRIGGER cash_sessions_no_delete BEFORE DELETE ON cash_sessions
  FOR EACH ROW EXECUTE FUNCTION finance_reject_mutation();
CREATE TRIGGER cash_sessions_no_truncate BEFORE TRUNCATE ON cash_sessions
  FOR EACH STATEMENT EXECUTE FUNCTION finance_reject_mutation();
CREATE TRIGGER receipt_counters_no_delete BEFORE DELETE ON receipt_counters
  FOR EACH ROW EXECUTE FUNCTION finance_reject_mutation();
CREATE TRIGGER receipt_counters_no_truncate BEFORE TRUNCATE ON receipt_counters
  FOR EACH STATEMENT EXECUTE FUNCTION finance_reject_mutation();

-- Contador só avança de 1 em 1 (nunca volta, nunca pula).
CREATE FUNCTION receipt_counters_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.last_number <> OLD.last_number + 1 THEN
    RAISE EXCEPTION 'contador de recibos só avança de 1 em 1' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER receipt_counters_guard BEFORE UPDATE ON receipt_counters FOR EACH ROW EXECUTE FUNCTION receipt_counters_guard();

-- O recibo só entra com o número que o contador acabou de entregar (na mesma transação, com a linha
-- do contador travada pelo UPDATE): o número nasce em sequência, sem buraco nem repetição.
CREATE FUNCTION receipts_number_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  ultimo bigint;
BEGIN
  SELECT last_number INTO ultimo FROM receipt_counters WHERE tenant_id = NEW.tenant_id;
  IF ultimo IS NULL OR NEW.number <> ultimo THEN
    RAISE EXCEPTION 'número de recibo fora da sequência' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER receipts_number_guard BEFORE INSERT ON receipts FOR EACH ROW EXECUTE FUNCTION receipts_number_guard();

-- Caixa fechado é terminal; enquanto aberto, só o fechamento muda a linha (dia, turno e troco ficam).
CREATE FUNCTION cash_sessions_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'caixa fechado não muda' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.business_date IS DISTINCT FROM OLD.business_date
     OR NEW.shift IS DISTINCT FROM OLD.shift OR NEW.opening_float_cents IS DISTINCT FROM OLD.opening_float_cents
     OR NEW.opened_at IS DISTINCT FROM OLD.opened_at OR NEW.opened_by IS DISTINCT FROM OLD.opened_by THEN
    RAISE EXCEPTION 'identidade do caixa é imutável' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cash_sessions_guard BEFORE UPDATE ON cash_sessions FOR EACH ROW EXECUTE FUNCTION cash_sessions_guard();

-- Recebimento e estorno só em caixa ABERTO. FOR SHARE espera um fechamento em curso (que trava a linha
-- FOR UPDATE) e relê: o que entra depois do fechamento é recusado, e o fechamento soma tudo o que entrou.
CREATE FUNCTION finance_requires_open_cash() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  situacao text;
BEGIN
  SELECT status INTO situacao FROM cash_sessions
    WHERE id = NEW.cash_session_id AND tenant_id = NEW.tenant_id FOR SHARE;
  IF situacao IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'caixa fechado não recebe lançamento' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payments_open_cash BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION finance_requires_open_cash();
CREATE TRIGGER payment_reversals_open_cash BEFORE INSERT ON payment_reversals FOR EACH ROW EXECUTE FUNCTION finance_requires_open_cash();

-- Cobrança: alvo, paciente, valor, tipo e pagador não mudam depois de lançada (cancele e lance outra);
-- cancelada é terminal.
CREATE FUNCTION charges_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'cancelled' THEN
    RAISE EXCEPTION 'cobrança cancelada não muda' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.patient_id IS DISTINCT FROM OLD.patient_id
     OR NEW.appointment_id IS DISTINCT FROM OLD.appointment_id OR NEW.package_id IS DISTINCT FROM OLD.package_id
     OR NEW.professional_id IS DISTINCT FROM OLD.professional_id OR NEW.attendance_kind IS DISTINCT FROM OLD.attendance_kind
     OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents OR NEW.payer_name IS DISTINCT FROM OLD.payer_name
     OR NEW.payer_cpf_enc IS DISTINCT FROM OLD.payer_cpf_enc OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'identidade da cobrança é imutável' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER charges_guard BEFORE UPDATE ON charges FOR EACH ROW EXECUTE FUNCTION charges_guard();

-- Quem lança é o USUÁRIO DA SESSÃO travado na transação (app_current_user, migração 0016): o banco
-- recusa created_by/received_by/reversed_by/issued_by/cancelled_by/opened_by/closed_by/updated_by de
-- outra pessoa (ou sem usuário na transação: falha fechada). No UPDATE só confere a coluna que mudou.
-- Nome com prefixo `zz_`: os gatilhos BEFORE disparam em ordem alfabética, então as regras de negócio
-- (sequência do recibo, caixa aberto) respondem primeiro.
CREATE FUNCTION finance_ator_da_sessao() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := app_current_user();
  coluna text;
  novo   text;
BEGIN
  FOREACH coluna IN ARRAY TG_ARGV LOOP
    novo := to_jsonb(NEW) ->> coluna;
    CONTINUE WHEN novo IS NULL;
    CONTINUE WHEN TG_OP = 'UPDATE' AND novo IS NOT DISTINCT FROM (to_jsonb(OLD) ->> coluna);
    IF v_user IS NULL OR novo::uuid <> v_user THEN
      RAISE EXCEPTION '%.% tem de ser o usuário da sessão', TG_TABLE_NAME, coluna USING ERRCODE = 'insufficient_privilege';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
CREATE TRIGGER zz_finance_settings_ator BEFORE INSERT OR UPDATE ON finance_settings
  FOR EACH ROW EXECUTE FUNCTION finance_ator_da_sessao('updated_by');
CREATE TRIGGER zz_professional_fiscal_profiles_ator BEFORE INSERT OR UPDATE ON professional_fiscal_profiles
  FOR EACH ROW EXECUTE FUNCTION finance_ator_da_sessao('updated_by');
CREATE TRIGGER zz_cash_sessions_ator BEFORE INSERT OR UPDATE ON cash_sessions
  FOR EACH ROW EXECUTE FUNCTION finance_ator_da_sessao('opened_by', 'closed_by');
CREATE TRIGGER zz_charges_ator BEFORE INSERT OR UPDATE ON charges
  FOR EACH ROW EXECUTE FUNCTION finance_ator_da_sessao('created_by', 'cancelled_by');
CREATE TRIGGER zz_payments_ator BEFORE INSERT ON payments
  FOR EACH ROW EXECUTE FUNCTION finance_ator_da_sessao('received_by');
CREATE TRIGGER zz_payment_reversals_ator BEFORE INSERT ON payment_reversals
  FOR EACH ROW EXECUTE FUNCTION finance_ator_da_sessao('reversed_by');
CREATE TRIGGER zz_receipts_ator BEFORE INSERT ON receipts
  FOR EACH ROW EXECUTE FUNCTION finance_ator_da_sessao('issued_by');
CREATE TRIGGER zz_receipt_cancellations_ator BEFORE INSERT ON receipt_cancellations
  FOR EACH ROW EXECUTE FUNCTION finance_ator_da_sessao('cancelled_by');

-- ---------------------------------------------------------------- RLS

ALTER TABLE finance_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON finance_settings
  USING (tenant_id = (SELECT app_current_tenant()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()));

ALTER TABLE professional_fiscal_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE professional_fiscal_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON professional_fiscal_profiles
  USING (tenant_id = (SELECT app_current_tenant()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()));

ALTER TABLE cash_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cash_sessions
  USING (tenant_id = (SELECT app_current_tenant()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()));

ALTER TABLE charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE charges FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON charges
  USING (tenant_id = (SELECT app_current_tenant()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()));

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payments
  USING (tenant_id = (SELECT app_current_tenant()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()));

ALTER TABLE payment_reversals ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_reversals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_reversals
  USING (tenant_id = (SELECT app_current_tenant()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()));

ALTER TABLE receipt_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE receipt_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON receipt_counters
  USING (tenant_id = (SELECT app_current_tenant()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()));

ALTER TABLE receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON receipts
  USING (tenant_id = (SELECT app_current_tenant()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()));

ALTER TABLE receipt_cancellations ENABLE ROW LEVEL SECURITY;
ALTER TABLE receipt_cancellations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON receipt_cancellations
  USING (tenant_id = (SELECT app_current_tenant()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()));

-- Menor privilégio: os DEFAULT PRIVILEGES deram SELECT/INSERT/UPDATE/DELETE ao runtime.
REVOKE DELETE, TRUNCATE ON finance_settings, professional_fiscal_profiles, cash_sessions, charges, payments,
  payment_reversals, receipt_counters, receipts, receipt_cancellations FROM app_user;
-- Registros financeiros append-only: depois de gravados, nem o runtime altera.
REVOKE UPDATE ON payments, payment_reversals, receipts, receipt_cancellations FROM app_user;
