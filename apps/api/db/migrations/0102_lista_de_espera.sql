-- 0102 — Lista de espera da agenda (HU-AGD-009, AGD-02.5). Executar com o papel de MIGRAÇÃO (app_migrator).
-- Ver docs/04-arquitetura/api-dominio.md §5b.
--
-- NUMERAÇÃO: 0102 está reservada para esta frente (a pilha aberta usa 0066–0082 e outros PRs, 0100 e 0101). O
-- executor (scripts/migrate.mjs) aplica todo arquivo ainda ausente de schema_migrations, em ordem de nome, então a
-- 0102 entra mesmo que a 0066–0101 cheguem à main depois; esta migração só depende de tabelas até a 0059.
--
-- - Um item por paciente na espera, com profissional OPCIONAL e preferências ESTRUTURADAS (dias da semana 0–6,
--   domingo = 0, e período manhã/tarde/noite). A observação é curta (até 120 caracteres na API), administrativa
--   (nunca clínica: aviso na doc da rota) e fica SÓ cifrada (formato v1 do FieldCipher; o CHECK recusa texto em claro).
-- - Sai da lista por remoção lógica (`removed_at`/`removed_by`/`removal_reason`); "agendado" guarda o agendamento
--   criado a partir da espera. Retirado por engano volta (desfazer), agendado não.
-- - Retenção: o item removido (e o de paciente inativado) é APAGADO 30 dias depois pelo job `lista-espera-retencao`
--   (app_waitlist_purge_run, SECURITY DEFINER). O runtime não tem DELETE: fora do job, nada se apaga.
-- - RLS FORÇADO, policy pelo contexto travado (app_current_tenant, 0003) e `portal_fora` (o portal não vê a espera).
-- - FK só NO ACTION para patients/appointments (R11, 0035): o desfazer de um lote com paciente na espera é recusado
--   (`importacao_em_uso`, pela violação de FK tratada em app_undo_import_batch), nunca apaga a espera em cascata.

CREATE TABLE waitlist_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id),
  patient_id      uuid NOT NULL,
  professional_id uuid,
  -- Dias da semana aceitos (0 = domingo … 6 = sábado); vazio = qualquer dia.
  weekdays        smallint[] NOT NULL DEFAULT '{}'
                    CONSTRAINT waitlist_entries_weekdays_check CHECK (
                      cardinality(weekdays) <= 7 AND weekdays <@ ARRAY[0, 1, 2, 3, 4, 5, 6]::smallint[]
                      AND array_position(weekdays, NULL) IS NULL),
  -- Período do dia; NULL = qualquer período.
  period          text CONSTRAINT waitlist_entries_period_check CHECK (period IN ('manha', 'tarde', 'noite')),
  note_enc        text CONSTRAINT waitlist_entries_note_enc_check CHECK (note_enc IS NULL OR app_is_sealed_field(note_enc)),
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  removed_at      timestamptz,
  removed_by      uuid,
  removal_reason  text CONSTRAINT waitlist_entries_removal_reason_check CHECK (removal_reason IN ('agendado', 'retirado', 'desistencia')),
  appointment_id  uuid,
  CONSTRAINT waitlist_entries_removed_check CHECK (
    (removed_at IS NULL) = (removed_by IS NULL) AND (removed_at IS NULL) = (removal_reason IS NULL)),
  CONSTRAINT waitlist_entries_appointment_check CHECK ((removal_reason = 'agendado') = (appointment_id IS NOT NULL)),
  CONSTRAINT waitlist_entries_patient_fk FOREIGN KEY (patient_id, tenant_id) REFERENCES patients (id, tenant_id),
  CONSTRAINT waitlist_entries_professional_fk FOREIGN KEY (professional_id, tenant_id) REFERENCES professionals (id, tenant_id),
  CONSTRAINT waitlist_entries_appointment_fk FOREIGN KEY (appointment_id, tenant_id) REFERENCES appointments (id, tenant_id)
);
-- Ordem de entrada (cenário "candidatos compatíveis em ordem de entrada"), só os que estão na lista.
CREATE INDEX waitlist_entries_open_idx ON waitlist_entries (tenant_id, created_at, id) WHERE removed_at IS NULL;
-- Um item vivo por paciente e profissional (sem profissional conta como um "qualquer profissional").
CREATE UNIQUE INDEX waitlist_entries_one_open_idx
  ON waitlist_entries (tenant_id, patient_id, coalesce(professional_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE removed_at IS NULL;
-- Retenção: o job procura os removidos antigos.
CREATE INDEX waitlist_entries_removed_idx ON waitlist_entries (tenant_id, removed_at) WHERE removed_at IS NOT NULL;
CREATE INDEX waitlist_entries_patient_idx ON waitlist_entries (tenant_id, patient_id);

-- ---------------------------------------------------------------- guarda das escritas

-- INSERT: autor = usuário da sessão (0016), nasce na lista e só para paciente ATIVO da clínica.
-- UPDATE: só a saída (com autor = usuário da sessão) e o desfazer da saída que não foi agendamento; o resto é imutável.
CREATE FUNCTION waitlist_entries_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := app_current_user();
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF v_user IS NULL OR NEW.created_by IS DISTINCT FROM v_user THEN
      RAISE EXCEPTION 'waitlist_entries.created_by tem de ser o usuário da sessão' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.removed_at IS NOT NULL THEN
      RAISE EXCEPTION 'item da lista de espera nasce na lista' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM patients p WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.patient_id AND p.active) THEN
      RAISE EXCEPTION 'paciente inativo não entra na lista de espera' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.patient_id IS DISTINCT FROM OLD.patient_id OR NEW.professional_id IS DISTINCT FROM OLD.professional_id
     OR NEW.weekdays IS DISTINCT FROM OLD.weekdays OR NEW.period IS DISTINCT FROM OLD.period
     OR NEW.note_enc IS DISTINCT FROM OLD.note_enc OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'item da lista de espera é imutável (só sai ou volta)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.removed_at IS NULL AND NEW.removed_at IS NOT NULL THEN
    IF v_user IS NULL OR NEW.removed_by IS DISTINCT FROM v_user THEN
      RAISE EXCEPTION 'waitlist_entries.removed_by tem de ser o usuário da sessão' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.removed_at IS NOT NULL AND NEW.removed_at IS NULL THEN
    IF OLD.removal_reason = 'agendado' THEN
      RAISE EXCEPTION 'item agendado a partir da espera não volta para a lista' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM patients p WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.patient_id AND p.active) THEN
      RAISE EXCEPTION 'paciente inativo não volta para a lista de espera' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.removed_at IS DISTINCT FROM OLD.removed_at OR NEW.removed_by IS DISTINCT FROM OLD.removed_by
     OR NEW.removal_reason IS DISTINCT FROM OLD.removal_reason OR NEW.appointment_id IS DISTINCT FROM OLD.appointment_id THEN
    RAISE EXCEPTION 'saída da lista de espera não se reescreve' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION waitlist_entries_guard() FROM PUBLIC;
CREATE TRIGGER waitlist_entries_guard
  BEFORE INSERT OR UPDATE ON waitlist_entries
  FOR EACH ROW EXECUTE FUNCTION waitlist_entries_guard();

-- ---------------------------------------------------------------- RLS e privilégios

ALTER TABLE waitlist_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE waitlist_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON waitlist_entries
  USING (tenant_id = (SELECT app_current_tenant()))
  WITH CHECK (tenant_id = (SELECT app_current_tenant()));
-- O portal do paciente não vê nem mexe na lista de espera (padrão do portal: não ver; 0027).
CREATE POLICY portal_fora ON waitlist_entries AS RESTRICTIVE
  USING (tenant_id = (SELECT app_current_tenant()) AND (SELECT app_portal_patient()) IS NULL)
  WITH CHECK (tenant_id = (SELECT app_current_tenant()) AND (SELECT app_portal_patient()) IS NULL);
REVOKE ALL ON waitlist_entries FROM PUBLIC;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON waitlist_entries FROM app_user;
GRANT SELECT, INSERT, UPDATE ON waitlist_entries TO app_user;

-- ---------------------------------------------------------------- retenção

-- Apaga, na clínica do contexto, os itens que SAÍRAM da lista há mais de 30 dias e os de paciente INATIVADO há mais de
-- 30 dias (a API já os esconde; relógio do banco, sem parâmetro), salvo paciente sob retenção legal. O resto da lista
-- não vence. Idempotente; devolve
-- quantos apagou (a trilha, só com a contagem, é gravada pela API na mesma transação).
CREATE FUNCTION app_waitlist_purge_run() RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_tenant uuid := app_current_tenant();
  v_n      integer;
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'retenção da lista de espera exige o contexto de tenant' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- V1 do parecer do #245: paciente sob retenção legal (legal_hold_since, 0015) não perde nada, nos DOIS ramos
  -- (mesma regra das eliminações da 0031/0034).
  DELETE FROM waitlist_entries w
   WHERE w.tenant_id = v_tenant
     AND ((w.removed_at IS NOT NULL AND w.removed_at < now() - interval '30 days'
           AND EXISTS (SELECT 1 FROM patients pa
                        WHERE pa.tenant_id = w.tenant_id AND pa.id = w.patient_id AND pa.legal_hold_since IS NULL))
          OR EXISTS (SELECT 1 FROM patients pa
                      WHERE pa.tenant_id = w.tenant_id AND pa.id = w.patient_id AND pa.legal_hold_since IS NULL
                        AND NOT pa.active AND pa.inactivated_at < now() - interval '30 days'));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION app_waitlist_purge_run() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_waitlist_purge_run() TO app_user;

DO $$
DECLARE
  r record;
BEGIN
  SELECT p.prosecdef, o.rolname, o.rolsuper, o.rolbypassrls INTO r
    FROM pg_proc p JOIN pg_roles o ON o.oid = p.proowner
   WHERE p.oid = 'app_waitlist_purge_run()'::regprocedure;
  IF NOT r.prosecdef THEN
    RAISE EXCEPTION 'app_waitlist_purge_run deveria ser SECURITY DEFINER';
  END IF;
  IF r.rolsuper OR r.rolbypassrls OR r.rolname = 'app_user' THEN
    RAISE EXCEPTION 'dono de app_waitlist_purge_run (%) não pode ser superusuário, BYPASSRLS nem o runtime', r.rolname;
  END IF;
END;
$$;
