-- 0080 — Papel de banco dedicado à tarefa de provisionamento da clínica (B11; A1 do parecer do Guardião de 17/11/2026
-- sobre a ativação do fundador e R5 do parecer do expurgo da ativação). Executar com o papel de MIGRAÇÃO (app_migrator).
--
-- Antes: a tarefa avulsa usava `app_auth` (schema identidade, com UPDATE e DELETE em `ativacao_do_fundador` e acesso a
-- conta, sessão e fator) e `app_user` (runtime inteiro da clínica). E a fundação pela sessão de sistema da 0078 era
-- aceita de QUALQUER conexão `app_user`: a trilha `via = 'provisionamento'` provava consistência, não autorização.
--
-- Agora:
-- 1. `app_provisionamento` (criado pelo bootstrap, como `app_auth`: LOGIN com senha do Secrets Manager, NOINHERIT,
--    NOBYPASSRLS, sem CREATEDB/CREATEROLE e membro de nenhum papel) recebe SÓ o que `provisionarClinica` usa:
--    - identidade.ativacao_do_fundador: SELECT do `id` (repetição do pedido) e INSERT. Sem UPDATE, sem DELETE e sem
--      leitura do hash do token ou do HMAC do e-mail;
--    - identidade.usuario: SELECT de `id` e `clinica_de_origem` (C3); a conta pelo e-mail (R2) e a conferência do
--      e-mail (A2) só por duas funções pela chave, sem listar e-mails (R1 do parecer do #207);
--    - tenants, clinic_members e audit_log: SELECT e INSERT, sob o RLS da clínica do contexto;
--    - EXECUTE só nas funções do contexto (clínica e sessão de SISTEMA; sem `app_set_user`), nas lidas pelas policies e
--      triggers desse caminho e na prova da trilha (0078).
--    Nenhuma outra tabela, nem conta, sessão, fator, convite ou dado de paciente.
-- 2. A fundação pela sessão de sistema (0078) passa a exigir que o LOGIN da conexão seja membro de
--    `app_provisionamento` (`pg_has_role(session_user, ...)`, padrão da 0047 com `app_migrator`). Um comprometimento da
--    API (`app_user`) deixa de fundar clínica "pelo provisionamento", mesmo gravando a trilha certa.
--
-- A lista exata dos privilégios fica cobrada pela guarda `test/guarda-papeis.rls.test.ts` (R4 do parecer do expurgo).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_provisionamento') THEN
    RAISE EXCEPTION 'papel app_provisionamento ausente: rode o bootstrap (infra/rds/bootstrap.sql ou infra/local/postgres-init.sh) antes da 0080';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles
              WHERE rolname = 'app_provisionamento'
                AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication)) THEN
    RAISE EXCEPTION 'app_provisionamento precisa ser NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION';
  END IF;
END;
$$;

-- ------------------------------------------------------------------ 1. privilégios

-- Schema identidade (USAGE vem do bootstrap, como o do app_auth).
GRANT SELECT (id) ON identidade.ativacao_do_fundador TO app_provisionamento;
GRANT INSERT ON identidade.ativacao_do_fundador TO app_provisionamento;
-- Sem a coluna `email` (R1 do parecer do #207): a busca pelo e-mail e a conferência do e-mail da conta são funções
-- pela chave, abaixo; a tarefa não lista os e-mails das contas.
GRANT SELECT (id, clinica_de_origem) ON identidade.usuario TO app_provisionamento;

-- Conta pelo e-mail (R2): id e situação da conta com aquele e-mail, sem diferenciar maiúsculas. Só pela chave.
CREATE FUNCTION identidade.conta_por_email(p_email text) RETURNS TABLE (id uuid, ativo boolean)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, identidade, pg_temp
AS $$
  SELECT u.id, u.ativo FROM identidade.usuario u WHERE lower(u.email) = lower(p_email)
$$;

-- A2 do parecer do #195: o e-mail do parâmetro recriado é o da conta do fundador? Só sim ou não.
CREATE FUNCTION identidade.email_da_conta_confere(p_conta uuid, p_email text) RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, identidade, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM identidade.usuario u WHERE u.id = p_conta AND lower(u.email) = lower(p_email))
$$;

REVOKE ALL ON FUNCTION identidade.conta_por_email(text), identidade.email_da_conta_confere(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION identidade.conta_por_email(text), identidade.email_da_conta_confere(uuid, text) TO app_provisionamento;

-- Clínica (RLS forçado; USAGE em public vem do bootstrap).
GRANT SELECT, INSERT ON tenants, clinic_members, audit_log TO app_provisionamento;

-- Contexto da transação: só a clínica e a sessão de sistema (withTenant sem usuário). Mais as lidas pelas policies
-- (`app_portal_patient`, sempre nula fora do portal) e pelos triggers desse caminho (encadeamento da trilha, 0033, e
-- a prova da 0078).
GRANT EXECUTE ON FUNCTION
  app_set_tenant(uuid),
  app_current_tenant(),
  app_set_system_user(),
  app_is_system_session(),
  app_current_user(),
  app_portal_patient(),
  app_audit_chain_tail(uuid),
  app_trilha_do_provisionamento(uuid, text, text, uuid)
TO app_provisionamento;

-- ------------------------------------------------------------------ 2. fundação pelo sistema só pelo provisionamento

-- Base: 0078. Única mudança: a sessão de sistema só funda clínica com o login membro de app_provisionamento.
CREATE OR REPLACE FUNCTION tenants_founder_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.founder_user_id IS NOT NULL AND NEW.founder_user_id IS DISTINCT FROM app_current_user() THEN
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

-- Base: 0078. Única mudança: a fundação pela sessão de sistema exige o login membro de app_provisionamento.
CREATE OR REPLACE FUNCTION clinic_members_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user uuid := app_current_user();
  semRevogacao clinic_members;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'clinic_members não se apaga (revogue)' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_user IS NULL THEN
    -- 0078/0080: fundação pelo provisionamento, na sessão de sistema e pelo papel próprio. Só o admin do fundador
    -- registrado, numa clínica sem nenhuma linha, concedido pelo sentinela de sistema; a trilha vai no COMMIT.
    IF TG_OP = 'INSERT' AND app_is_system_session() AND pg_has_role(session_user, 'app_provisionamento', 'MEMBER') THEN
      PERFORM pg_advisory_xact_lock(hashtextextended('clinic_members:' || NEW.tenant_id::text, 0));
      IF NEW.role = 'admin'
         AND NEW.granted_by = '00000000-0000-0000-0000-000000000000'::uuid
         AND NEW.revoked_by IS NULL AND NEW.revoked_at IS NULL
         AND EXISTS (SELECT 1 FROM tenants t WHERE t.id = NEW.tenant_id AND t.founder_user_id = NEW.user_id)
         AND NOT EXISTS (SELECT 1 FROM clinic_members m WHERE m.tenant_id = NEW.tenant_id) THEN
        NEW.granted_at := now();
        RETURN NEW;
      END IF;
    END IF;
    RAISE EXCEPTION 'perfil da clínica exige o usuário da sessão' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('clinic_members:' || COALESCE(NEW.tenant_id, OLD.tenant_id)::text, 0));
  IF TG_OP = 'INSERT' THEN
    IF NEW.granted_by IS DISTINCT FROM v_user OR NEW.revoked_by IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'perfil é concedido por quem está na sessão e nasce ativo' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT app_user_has_role(v_user, 'admin') THEN
      -- Fundação (R15): só o FUNDADOR registrado em tenants, numa clínica sem nenhuma linha; ou a
      -- correção do fundador sob incidente (0042), em que o novo fundador se registra como admin.
      IF NOT (NEW.role = 'admin' AND NEW.user_id = v_user
              AND EXISTS (SELECT 1 FROM tenants t WHERE t.id = NEW.tenant_id AND t.founder_user_id = v_user)
              AND (NOT EXISTS (SELECT 1 FROM clinic_members m WHERE m.tenant_id = NEW.tenant_id)
                   OR app_runbook_corrigindo_fundador(NEW.tenant_id))) THEN
        RAISE EXCEPTION 'só um admin ativo da clínica concede perfil' USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
    NEW.granted_at := now();
    RETURN NEW;
  END IF;
  semRevogacao := NEW;
  semRevogacao.revoked_by := OLD.revoked_by;
  semRevogacao.revoked_at := OLD.revoked_at;
  IF semRevogacao IS DISTINCT FROM OLD OR OLD.revoked_at IS NOT NULL
     OR NEW.revoked_by IS DISTINCT FROM v_user OR NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'perfil só se revoga, uma vez, por quem está na sessão' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT app_user_has_role(v_user, 'admin') AND NOT app_runbook_corrigindo_fundador(OLD.tenant_id) THEN
    RAISE EXCEPTION 'só um admin ativo da clínica revoga perfil' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.role = 'admin' AND NOT EXISTS (
       SELECT 1 FROM clinic_members m
        WHERE m.tenant_id = OLD.tenant_id AND m.role = 'admin' AND m.revoked_at IS NULL AND m.id <> OLD.id) THEN
    RAISE EXCEPTION 'a clínica não fica sem admin ativo' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  NEW.revoked_at := now();
  RETURN NEW;
END;
$$;
