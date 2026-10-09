#!/bin/sh
# Somente para ambiente LOCAL. Cria os papéis separados de migração e runtime.
# app_user NÃO é dono das tabelas e NÃO tem BYPASSRLS (RLS sempre aplicado).
set -e
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<SQL
CREATE ROLE app_migrator LOGIN PASSWORD '${POSTGRES_PASSWORD}';
CREATE ROLE app_user LOGIN NOBYPASSRLS PASSWORD '${POSTGRES_PASSWORD}';
GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO app_migrator, app_user;
GRANT ALL ON SCHEMA public TO app_migrator;
GRANT USAGE ON SCHEMA public TO app_user;
-- Sem objetos temporários: pg_temp vem antes de public no search_path, então uma tabela TEMP
-- "patients" criada por SQL injetado sombrearia a real na conexão do pool (suíte de segurança).
REVOKE TEMPORARY ON DATABASE ${POSTGRES_DB} FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
SQL
