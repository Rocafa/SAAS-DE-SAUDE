-- 0029 — Sessão de pacote imutável, salvo o estorno (uma vez só, pelo usuário da sessão)
-- (R17 da re-revisão 3 do Guardião sobre o PR #65).
-- Executar com o papel de MIGRAÇÃO (app_migrator). Ver docs/04-arquitetura/api-dominio.md §9.
--
-- NUMERAÇÃO: 0029 é do #65 (rodada 19); 0030 do importador. 0027 e 0028 são de outras branches.
--
-- Problema: package_sessions aceitava UPDATE livre do runtime, e os checks da 0023/0025 só rodam no
-- INSERT. Um SQL injetado podia desfazer o estorno (reversed_* de volta a NULL) de uma sessão do
-- profissional Y depois da PF de X, ou trocar appointment_id/package_id — a mesma classe de falha da R15.
--
-- Regra (vale para QUALQUER papel): a única mudança aceita é o estorno.
--   * a linha ainda não estava estornada (OLD.reversed_at IS NULL): estorno acontece uma vez só;
--   * id, tenant_id, package_id, appointment_id, consumed_at e consumed_by não mudam;
--   * reversed_by = app_current_user() (o usuário da sessão; sem usuário na transação, recusa);
--   * reversal_reason preenchido (a lista fechada continua no CHECK da 0011);
--   * reversed_at é o relógio do banco: o trigger grava now(), seja qual for o valor enviado.
-- DELETE já estava revogado do runtime (0011).

CREATE FUNCTION package_sessions_so_estorno() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.reversed_at IS NOT NULL THEN
    RAISE EXCEPTION 'sessão de pacote estornada não muda mais' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.package_id IS DISTINCT FROM OLD.package_id OR NEW.appointment_id IS DISTINCT FROM OLD.appointment_id
     OR NEW.consumed_at IS DISTINCT FROM OLD.consumed_at OR NEW.consumed_by IS DISTINCT FROM OLD.consumed_by THEN
    RAISE EXCEPTION 'sessão de pacote: só o estorno é permitido' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.reversed_at IS NULL OR NEW.reversal_reason IS NULL THEN
    RAISE EXCEPTION 'sessão de pacote: só o estorno é permitido' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF app_current_user() IS NULL OR NEW.reversed_by IS DISTINCT FROM app_current_user() THEN
    RAISE EXCEPTION 'estorno de sessão de pacote só em nome do usuário da sessão' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.reversed_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER package_sessions_so_estorno BEFORE UPDATE ON package_sessions
  FOR EACH ROW EXECUTE FUNCTION package_sessions_so_estorno();
