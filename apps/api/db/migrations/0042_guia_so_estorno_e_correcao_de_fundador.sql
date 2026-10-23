-- 0042 — Consumo de guia de convênio imutável, salvo o estorno (R20 da conferência de 23/10/2026 do
-- Guardião sobre o PR #65). Executar com o papel de MIGRAÇÃO (app_migrator). Ver
-- docs/04-arquitetura/api-dominio.md §9.
--
-- NUMERAÇÃO: 0042 é da rodada 20 (ressalvas #65 R20/R21 e #63 R17 sobre a integração #73).
--
-- Problema (R20): guide_sessions não tinha trigger de UPDATE (só RLS por clínica e o REVOKE DELETE/
-- TRUNCATE da 0011). Com SQL injetado, qualquer papel da clínica podia desfazer um estorno, trocar
-- guide_id/appointment_id, reescrever consumed_by/override_reason ou estornar em nome de outra pessoa:
-- o saldo da guia e o lote de faturamento ao convênio (TISS) ficavam inexatos.
--
-- Regra (vale para QUALQUER papel), a mesma da 0029 + 0041 para package_sessions:
--   * a linha ainda não estava estornada (OLD.reversed_at IS NULL): estorno acontece uma vez só;
--   * id, tenant_id, guide_id, appointment_id, consumed_at, consumed_by e override_reason não mudam;
--   * reversed_by = app_current_user() (sem usuário na transação, recusa);
--   * reversal_reason preenchido (a lista fechada continua no CHECK da 0011);
--   * o usuário tem perfil ATIVO admin, profissional, recepcao ou financeiro na clínica da transação
--     (a lista de `guias:consumir`; o estorno automático da agenda é feito por perfis da mesma lista);
--   * reversed_at é o relógio do banco: o trigger grava now(), seja qual for o valor enviado.

-- ------------------------------------------------------------------ R20: guide_sessions só estorno

CREATE FUNCTION guide_sessions_so_estorno() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := app_current_user();
BEGIN
  IF OLD.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'consumo de guia estornado não muda mais' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.guide_id IS DISTINCT FROM OLD.guide_id OR NEW.appointment_id IS DISTINCT FROM OLD.appointment_id
     OR NEW.consumed_at IS DISTINCT FROM OLD.consumed_at OR NEW.consumed_by IS DISTINCT FROM OLD.consumed_by
     OR NEW.override_reason IS DISTINCT FROM OLD.override_reason THEN
    RAISE EXCEPTION 'consumo de guia: só o estorno é permitido' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.reversed_at IS NULL OR NEW.reversal_reason IS NULL THEN
    RAISE EXCEPTION 'consumo de guia: só o estorno é permitido' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_user IS NULL OR NEW.reversed_by IS DISTINCT FROM v_user THEN
    RAISE EXCEPTION 'estorno de consumo de guia só em nome do usuário da sessão' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT (app_user_has_role(v_user, 'admin') OR app_user_has_role(v_user, 'profissional')
          OR app_user_has_role(v_user, 'recepcao') OR app_user_has_role(v_user, 'financeiro')) THEN
    RAISE EXCEPTION 'estorno de consumo de guia exige perfil registrado na clínica' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.reversed_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER guide_sessions_so_estorno BEFORE UPDATE ON guide_sessions
  FOR EACH ROW EXECUTE FUNCTION guide_sessions_so_estorno();
