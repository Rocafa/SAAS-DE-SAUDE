-- 0081 — Clínica nova SEM fundador só pelo papel de migração (G3 do parecer do Guardião de 17/11/2026 sobre o #207,
-- `docs/03-seguranca-lgpd/revisoes/2026-11-17-codigo-papel-provisionamento.md`). Executar com o papel de MIGRAÇÃO
-- (app_migrator).
--
-- Antes: `tenants_founder_guard` (0080) só olhava o INSERT com `founder_user_id` preenchido. Com o fundador NULL, a
-- linha passava para QUALQUER conexão (`app_user` na sessão de sistema ou de usuário, `app_auth` e
-- `app_provisionamento`): criação de clínica sem trilha (art. 37 da LGPD) e ruído operacional, ainda que inerte
-- (o `clinic_members_guard` recusa qualquer vínculo e o fundador só sai de NULL pelo runbook da 0047).
--
-- Agora: o INSERT com `founder_user_id IS NULL` exige que o LOGIN da conexão seja membro de `app_migrator`
-- (`pg_has_role(session_user, ...)`, padrão da 0047): migrações, seeds e operadores nominais do runbook. O runtime,
-- mesmo dentro de função SECURITY DEFINER do app_migrator, nunca passa, porque `session_user` segue o login.
-- `app_user`, `app_auth` e `app_provisionamento` recebem 42501. O provisionamento continua fundando SÓ com o
-- fundador, pela sessão de sistema, com o vínculo e a trilha provados no COMMIT (0078/0080), sem mudança.

-- Base: 0080. Única mudança: o ramo do INSERT com fundador NULL.
CREATE OR REPLACE FUNCTION tenants_founder_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.founder_user_id IS NULL THEN
      -- 0081 (G3 do #207): clínica sem fundador só pelo papel de migração (migrações e seeds), nunca pelo runtime.
      IF pg_has_role(session_user, 'app_migrator', 'MEMBER') THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'clínica nova nasce com o fundador (sem fundador, só pelo papel de migração)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.founder_user_id IS DISTINCT FROM app_current_user() THEN
      -- 0078/0080: o provisionamento cria a clínica na sessão de sistema, pelo papel próprio; a trilha vai no COMMIT.
      IF app_is_system_session() AND pg_has_role(session_user, 'app_provisionamento', 'MEMBER') THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'o fundador é quem está na sessão ao criar a clínica' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.founder_user_id IS DISTINCT FROM OLD.founder_user_id THEN
    -- Correção sob incidente (0042/0047): só dentro de app_runbook_confirmar_correcao_fundador, por operador nominal.
    IF OLD.founder_user_id IS NOT NULL AND app_runbook_corrigindo_fundador(OLD.id)
       AND NEW.founder_user_id IS NOT NULL AND NEW.founder_user_id = app_current_user() THEN
      RETURN NEW;
    END IF;
    -- Registro do fundador de clínica antiga, uma vez: só o papel de operação (lista branca: quem escreve E
    -- o login da sessão são membros de app_migrator; o runtime, mesmo via SECURITY DEFINER, nunca).
    IF OLD.founder_user_id IS NOT NULL
       OR NOT (pg_has_role(current_user, 'app_migrator', 'MEMBER') AND pg_has_role(session_user, 'app_migrator', 'MEMBER'))
       OR NEW.founder_user_id IS DISTINCT FROM app_current_user() THEN
      RAISE EXCEPTION 'fundador da clínica é imutável' USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
