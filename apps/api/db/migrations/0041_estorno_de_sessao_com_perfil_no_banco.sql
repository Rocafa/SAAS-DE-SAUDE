-- 0041 — Estorno de sessão de pacote exige perfil da clínica NO BANCO (R19 da re-revisão 4 do Guardião
-- sobre o PR #65). Executar com o papel de MIGRAÇÃO (app_migrator). Ver docs/04-arquitetura/api-dominio.md §9.
--
-- NUMERAÇÃO: 0041 é da rodada 20 (ressalvas do #65 sobre a integração #73); 0042 é de outra branch.
--
-- Problema (R19): com SQL injetado, qualquer usuário da clínica conseguia estornar uma sessão viva em
-- nome próprio, porque o perfil autorizado (`guias:consumir` = admin, profissional, recepção, financeiro)
-- só era checado na API. Desde a 0020 o perfil está no banco (`clinic_members`), então a checagem desce.
--
-- Regra nova (soma-se às da 0029, que continuam iguais): o usuário da sessão precisa ter perfil ATIVO
-- `admin`, `profissional`, `recepcao` ou `financeiro` na clínica da transação (`app_user_has_role`, sob
-- RLS). Sem isso, 42501. O estorno automático da agenda (status que deixa de consumir) passa pelo mesmo
-- trigger e é feito por perfis da mesma lista (`agenda:escrever`/`agenda:atender`).

CREATE OR REPLACE FUNCTION package_sessions_so_estorno() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := app_current_user();
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
  IF v_user IS NULL OR NEW.reversed_by IS DISTINCT FROM v_user THEN
    RAISE EXCEPTION 'estorno de sessão de pacote só em nome do usuário da sessão' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- R19 do #65: o perfil autorizado a estornar é conferido no banco, não só na API.
  IF NOT (app_user_has_role(v_user, 'admin') OR app_user_has_role(v_user, 'profissional')
          OR app_user_has_role(v_user, 'recepcao') OR app_user_has_role(v_user, 'financeiro')) THEN
    RAISE EXCEPTION 'estorno de sessão de pacote exige perfil registrado na clínica' USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW.reversed_at := now();
  RETURN NEW;
END;
$$;
