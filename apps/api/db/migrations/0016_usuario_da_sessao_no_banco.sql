-- 0016 — Usuário da sessão travado na transação; o banco confere quem cria e quem remarca
-- (R9 da re-revisão 2 do Guardião sobre o PR #61). Executar com o papel de MIGRAÇÃO (app_migrator).
-- Ver docs/04-arquitetura/api-dominio.md §"Vínculo de cuidado".
--
-- NUMERAÇÃO: 0015 é do prontuário (PR #63) e 0018 do financeiro. Esta migração não depende delas.
--
-- 1. tenant_context.user_id + app_set_user(uuid) / app_current_user(): mesmo desenho da 0003. O
--    withTenant grava, uma única vez por transação e DEPOIS do tenant, o usuário da sessão numa tabela
--    que o runtime não acessa. Uma segunda chamada com outro usuário é recusada. A GUC não tem efeito.
-- 2. appointments: no INSERT, `created_by` tem de ser o usuário da sessão; numa remarcação (mudança
--    de horário), `rescheduled_by` tem de ser o usuário da sessão. Sem usuário na transação, o banco
--    recusa as duas operações (falha fechada). Antes só a API garantia isso.
--
-- Linhas antigas não mudam: created_by NULL continua valendo como "origem desconhecida".

ALTER TABLE tenant_context ADD COLUMN user_id uuid;

CREATE FUNCTION app_set_user(p_user uuid) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_xid     bigint := txid_current();
  v_tenant  uuid;
  v_current uuid;
BEGIN
  IF p_user IS NULL THEN
    RAISE EXCEPTION 'usuário nulo' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT tenant_id, user_id INTO v_tenant, v_current FROM public.tenant_context WHERE xid = v_xid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'usuário da sessão exige o contexto de tenant antes' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_current IS NOT NULL THEN
    IF v_current <> p_user THEN
      RAISE EXCEPTION 'usuário da sessão já definido nesta transação' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN;
  END IF;
  UPDATE public.tenant_context SET user_id = p_user WHERE xid = v_xid;
END;
$$;

-- Sem app_set_user nesta transação => NULL (as regras que dependem dele falham fechadas).
CREATE FUNCTION app_current_user() RETURNS uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT user_id FROM public.tenant_context WHERE xid = txid_current_if_assigned()
$$;

REVOKE ALL ON FUNCTION app_set_user(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_current_user() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_set_user(uuid) TO app_user;
GRANT EXECUTE ON FUNCTION app_current_user() TO app_user;

-- Criador = usuário da sessão.
CREATE FUNCTION appointments_criador_da_sessao() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := app_current_user();
BEGIN
  IF v_user IS NULL OR NEW.created_by IS DISTINCT FROM v_user THEN
    RAISE EXCEPTION 'appointments.created_by tem de ser o usuário da sessão' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER appointments_criador_da_sessao
  BEFORE INSERT ON appointments
  FOR EACH ROW EXECUTE FUNCTION appointments_criador_da_sessao();

-- Remarcador = usuário da sessão (mesma função da 0014, com a conferência a mais).
CREATE OR REPLACE FUNCTION appointments_guarda_remarcacao() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  -- Trava permanente: status clínico ou falta, agora ou antes.
  NEW.reschedule_locked := OLD.reschedule_locked
    OR OLD.status IN ('in_progress', 'completed', 'no_show')
    OR NEW.status IN ('in_progress', 'completed', 'no_show');
  IF NEW.starts_at IS DISTINCT FROM OLD.starts_at OR NEW.ends_at IS DISTINCT FROM OLD.ends_at THEN
    IF NEW.reschedule_locked THEN
      RAISE EXCEPTION 'agendamento que já teve atendimento ou falta não muda de horário'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.rescheduled_by IS NULL THEN
      RAISE EXCEPTION 'remarcação exige rescheduled_by' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.rescheduled_by IS DISTINCT FROM app_current_user() THEN
      RAISE EXCEPTION 'appointments.rescheduled_by tem de ser o usuário da sessão'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NEW.rescheduled_by IS DISTINCT FROM OLD.rescheduled_by THEN
    RAISE EXCEPTION 'appointments.rescheduled_by só muda numa remarcação' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
