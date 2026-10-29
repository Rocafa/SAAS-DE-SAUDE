-- Bootstrap dos papéis do banco no RDS (staging/prod). Equivalente ao infra/local/postgres-init.sh.
-- IDEMPOTENTE: pode rodar quantas vezes quiser; cada execução recoloca o estado esperado
-- (inclusive desfaz um GRANT TEMPORARY feito à mão depois).
--
-- Roda como o usuário master do RDS, que NÃO é superusuário (só rds_superuser + CREATEROLE) e é
-- dono do banco criado pelo Terraform. Nada aqui exige superusuário.
--
-- Senhas vêm de variáveis de ambiente lidas pelo psql (\getenv), nunca da linha de comando
-- (argv aparece no `ps`) nem deste arquivo. Ver bootstrap.sh.
\set ON_ERROR_STOP on
\getenv app_migrator_password APP_MIGRATOR_PASSWORD
\getenv app_user_password APP_USER_PASSWORD
\getenv dbname PGDATABASE

SELECT :'app_migrator_password' = '' OR :'app_user_password' = '' AS senha_vazia \gset
\if :senha_vazia
  \echo 'APP_MIGRATOR_PASSWORD e APP_USER_PASSWORD precisam estar definidas'
  \quit 3
\endif

-- 0. pgaudit (R11 do PR #61): o parameter group já o carrega (shared_preload_libraries) e
-- define pgaudit.log = 'ddl,role'. A extensão registra o pgaudit no banco; se a biblioteca não
-- estiver carregada (RDS ainda sem o reboot), o CREATE falha e o bootstrap para. Onde o pacote não
-- existe (teste local), pula.
SELECT 'CREATE EXTENSION IF NOT EXISTS pgaudit'
 WHERE EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pgaudit') \gexec

BEGIN;

-- A classe ROLE do pgaudit grava o TEXTO do comando, e o ALTER ROLE ... PASSWORD levaria a senha
-- para o log (V2 do PR #58). Só nesta transação, e só para as senhas, o pgaudit fica desligado.
-- Se o master não puder fazer isso, o SET falha e nada roda (falha fechada, nenhuma senha em log).
SET LOCAL pgaudit.log = 'none';

-- 1. Papéis: cria se não existir; se existir, só reafirma atributos e senha (rotação).
SELECT format('CREATE ROLE app_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD %L',
              :'app_migrator_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_migrator') \gexec
SELECT format('CREATE ROLE app_user LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD %L',
              :'app_user_password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') \gexec

SELECT format('ALTER ROLE app_migrator LOGIN NOCREATEDB NOCREATEROLE PASSWORD %L',
              :'app_migrator_password') \gexec
-- app_user NÃO é dono das tabelas e NÃO tem BYPASSRLS (RLS sempre aplicado).
SELECT format('ALTER ROLE app_user LOGIN NOCREATEDB NOCREATEROLE PASSWORD %L',
              :'app_user_password') \gexec

-- Fim das senhas: o resto (GRANT/REVOKE, DEFAULT PRIVILEGES) volta a ser auditado.
SET LOCAL pgaudit.log TO DEFAULT;

-- 2. Acesso ao banco e ao schema (GRANT é idempotente).
SELECT format('GRANT CONNECT ON DATABASE %I TO app_migrator, app_user', :'dbname') \gexec
GRANT ALL ON SCHEMA public TO app_migrator;
GRANT USAGE ON SCHEMA public TO app_user;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- 3. Sem objetos temporários (achado da rodada 5): pg_temp vem antes de public no search_path,
-- então uma tabela TEMP "patients" criada por SQL injetado sombrearia a real na conexão do pool.
-- O RDS cria o banco com o default do Postgres (TEMPORARY para PUBLIC); por isso o REVOKE é
-- repetido aqui. Também tira de app_user/app_migrator caso alguém tenha concedido direto.
SELECT format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', :'dbname') \gexec
SELECT format('REVOKE TEMPORARY ON DATABASE %I FROM app_user, app_migrator', :'dbname') \gexec

-- 4. Privilégios padrão: tabelas que o app_migrator criar ficam legíveis/graváveis pelo app_user.
-- ALTER DEFAULT PRIVILEGES FOR ROLE exige ser membro do papel; o master do RDS tem ADMIN OPTION
-- sobre o que criou (PG16), então se concede SET e executa como app_migrator.
SELECT format('GRANT app_migrator TO %I WITH INHERIT FALSE, SET TRUE', current_user)
 WHERE NOT pg_has_role(current_user, 'app_migrator', 'SET') \gexec
SET LOCAL ROLE app_migrator;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
RESET ROLE;

COMMIT;

-- 5. Verificação: falha (código 4) se o estado final não for o esperado.
SELECT
  has_database_privilege('app_user', :'dbname', 'TEMPORARY')     AS user_temp,
  has_database_privilege('app_migrator', :'dbname', 'TEMPORARY') AS migrator_temp,
  (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = 'app_user') AS user_privilegiado
\gset
\if :user_temp
  \echo 'FALHA: app_user ainda tem TEMPORARY'
  \quit 4
\endif
\if :migrator_temp
  \echo 'FALHA: app_migrator ainda tem TEMPORARY'
  \quit 4
\endif
\if :user_privilegiado
  \echo 'FALHA: app_user tem BYPASSRLS ou SUPERUSER'
  \quit 4
\endif
-- pgaudit, onde instalado: precisa auditar DDL e ROLE e NUNCA leitura/escrita (dado de paciente).
SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgaudit') AS tem_pgaudit \gset
\if :tem_pgaudit
  SELECT NOT (current_setting('pgaudit.log') ~* '(^|,)\s*(ddl|all)\s*(,|$)'
              AND current_setting('pgaudit.log') ~* '(^|,)\s*(role|all)\s*(,|$)')
         OR current_setting('pgaudit.log') ~* '(^|,)\s*(read|write|all)\s*(,|$)'
         OR current_setting('pgaudit.log_parameter')::boolean AS pgaudit_errado \gset
  \if :pgaudit_errado
    \echo 'FALHA: pgaudit.log precisa ser ddl,role (sem read/write/all) e log_parameter off'
    \quit 4
  \endif
\endif
\echo 'bootstrap ok: app_migrator e app_user sem TEMPORARY, app_user sem BYPASSRLS'
