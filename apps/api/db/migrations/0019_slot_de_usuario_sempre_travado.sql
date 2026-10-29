-- 0019 — Slot do usuário da sessão SEMPRE travado (R10 da re-revisão 3 do Guardião sobre o PR #61).
-- Executar com o papel de MIGRAÇÃO (app_migrator). Ver docs/04-arquitetura/api-dominio.md §"Vínculo de cuidado".
--
-- NUMERAÇÃO: 0019 é reservada ao #61; 0020 ao prontuário (#63) e 0021 ao financeiro (#65).
--
-- Problema: numa transação aberta SEM usuário (job do sistema), o slot de `app_set_user` ficava livre e a
-- primeira chamada vinda de SQL injetado escolhia qualquer UUID como "usuário da sessão".
--
-- 1. `app_set_system_user()`: o withTenant chama quando não há usuário. Grava um SENTINELA explícito de
--    sistema (UUID nulo 00000000-…) no slot. Como o slot só aceita uma gravação por transação, um
--    `app_set_user(<qualquer>)` posterior dá 42501.
-- 2. `app_set_user` recusa o próprio sentinela (ninguém se declara "sistema" pela porta do usuário).
-- 3. `app_current_user()` devolve NULL para o sentinela: nenhum trigger que confere o ator (0016 e os
--    das frentes seguintes) aceita o sistema como autor — falha fechada, como antes.
-- 4. `app_is_system_session()`: verdadeiro só quando o slot tem o sentinela (para regras que precisem
--    distinguir "job do sistema" de "transação sem contexto").

CREATE OR REPLACE FUNCTION app_set_user(p_user uuid) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_xid     bigint := txid_current();
  v_current uuid;
BEGIN
  IF p_user IS NULL OR p_user = '00000000-0000-0000-0000-000000000000'::uuid THEN
    RAISE EXCEPTION 'usuário nulo ou sentinela de sistema' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT user_id INTO v_current FROM public.tenant_context WHERE xid = v_xid;
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

CREATE FUNCTION app_set_system_user() RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_xid     bigint := txid_current();
  v_current uuid;
BEGIN
  SELECT user_id INTO v_current FROM public.tenant_context WHERE xid = v_xid;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sessão de sistema exige o contexto de tenant antes' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_current IS NOT NULL THEN
    IF v_current <> '00000000-0000-0000-0000-000000000000'::uuid THEN
      RAISE EXCEPTION 'usuário da sessão já definido nesta transação' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN;
  END IF;
  UPDATE public.tenant_context SET user_id = '00000000-0000-0000-0000-000000000000'::uuid WHERE xid = v_xid;
END;
$$;

-- Sentinela de sistema => NULL: nenhuma regra de ator aceita o sistema como autor.
CREATE OR REPLACE FUNCTION app_current_user() RETURNS uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT NULLIF(user_id, '00000000-0000-0000-0000-000000000000'::uuid)
    FROM public.tenant_context WHERE xid = txid_current_if_assigned()
$$;

CREATE FUNCTION app_is_system_session() RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT COALESCE(
    (SELECT user_id = '00000000-0000-0000-0000-000000000000'::uuid
       FROM public.tenant_context WHERE xid = txid_current_if_assigned()),
    false)
$$;

REVOKE ALL ON FUNCTION app_set_system_user() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_is_system_session() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_set_system_user() TO app_user;
GRANT EXECUTE ON FUNCTION app_is_system_session() TO app_user;
