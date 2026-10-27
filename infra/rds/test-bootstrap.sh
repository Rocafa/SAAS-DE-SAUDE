#!/bin/sh
# Prova local do bootstrap do RDS num Postgres 16 descartável (cluster próprio, porta própria).
# Não usa docker compose nem os containers de outras pessoas. Senhas geradas na hora.
#
#   PG_BIN=/opt/homebrew/opt/postgresql@16/bin PGPORT=55482 sh infra/rds/test-bootstrap.sh
#
# Simula o RDS: quem roda o bootstrap é um "master" SEM superusuário (CREATEROLE + CREATEDB),
# dono do banco, como o usuário master que o Terraform cria.
set -eu

PG_BIN="${PG_BIN:-$(dirname "$(command -v postgres)")}"
PORT="${PGPORT:-55482}"
DIR="$(dirname "$0")"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/r8-devops-pg.XXXXXX")"
DB=plataforma_saude
rnd() { openssl rand -hex 16; }
MASTER_PW="$(rnd)"; MIG_PW="$(rnd)"; USER_PW="$(rnd)"

"$PG_BIN/postgres" --version | grep -q ' 16\.' || { echo "precisa de PostgreSQL 16"; exit 1; }

cleanup() { "$PG_BIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT INT TERM

"$PG_BIN/initdb" -D "$WORK/data" -U postgres --auth-local=trust --auth-host=scram-sha-256 >/dev/null
"$PG_BIN/pg_ctl" -D "$WORK/data" -l "$WORK/pg.log" -w \
  -o "-p $PORT -c listen_addresses=127.0.0.1 -k $WORK -c fsync=off" start >/dev/null

su_psql() { "$PG_BIN/psql" -X -q -h "$WORK" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 "$@"; }
# conecta por TCP com senha, como a aplicação faria
as() { _u="$1"; _pw="$2"; _db="$3"; shift 3
  PGPASSWORD="$_pw" "$PG_BIN/psql" -X -q -At -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$PORT" -U "$_u" -d "$_db" "$@"; }

su_psql -d postgres -c "CREATE ROLE rds_master LOGIN CREATEROLE CREATEDB PASSWORD '$MASTER_PW'"
su_psql -d postgres -c "CREATE DATABASE $DB OWNER rds_master"
su_psql -d postgres -c "CREATE DATABASE controle OWNER rds_master"

run_bootstrap() {
  PGHOST=127.0.0.1 PGPORT="$PORT" PGDATABASE="$DB" PGUSER=rds_master PGPASSWORD="$MASTER_PW" \
  PGSSLMODE=disable APP_MIGRATOR_PASSWORD="$MIG_PW" APP_USER_PASSWORD="$USER_PW" \
  PATH="$PG_BIN:$PATH" sh "$DIR/bootstrap.sh"
}

ok=0; fail=0
check() { # check <descrição> <esperado: nega|permite> <usuário> <senha> <banco> <sql...>
  _d="$1"; _e="$2"; shift 2
  if out="$(as "$@" 2>&1)"; then _r=permite; else _r=nega; fi
  if [ "$_r" = "$_e" ]; then ok=$((ok+1)); echo "  ok    $_d${out:+  [$(echo "$out" | head -1)]}"
  else fail=$((fail+1)); echo "  FALHA $_d (esperado $_e, veio $_r: $out)"; fi
}

SHADOW="create temp table patients (display_name text)"
TEMPFN='create function pg_temp.f() returns int language sql as $$ select 1 $$'

echo "1. bootstrap (1ª execução, como master sem superusuário)"
run_bootstrap

echo "2. controle negativo: banco SEM o bootstrap (default do Postgres/RDS)"
check "app_user cria TEMP patients no banco sem REVOKE" permite app_user "$USER_PW" controle -c "$SHADOW"

echo "3. ataque da tabela temporária sombra no banco com bootstrap"
as app_migrator "$MIG_PW" "$DB" -c "create table patients (id uuid primary key default gen_random_uuid(), display_name text)"
check "app_user cria TEMP patients"            nega    app_user "$USER_PW" "$DB" -c "$SHADOW"
check "app_user cria função em pg_temp"        nega    app_user "$USER_PW" "$DB" -c "$TEMPFN"
check "app_migrator cria TEMP patients"        nega    app_migrator "$MIG_PW" "$DB" -c "$SHADOW"
check "app_user grava na tabela real (default privileges)" permite app_user "$USER_PW" "$DB" \
  -c "insert into patients (display_name) values ('Paciente Sintético')"
check "app_user lê a tabela real"              permite app_user "$USER_PW" "$DB" -c "select count(*) from patients"
check "app_user não cria tabela em public"     nega    app_user "$USER_PW" "$DB" -c "create table x (i int)"
check "app_user não é dono (não dropa)"        nega    app_user "$USER_PW" "$DB" -c "drop table patients"

echo "4. idempotência: 2ª execução sem mudança"
run_bootstrap
check "ataque segue negado após reexecução"    nega    app_user "$USER_PW" "$DB" -c "$SHADOW"

echo "5. drift: alguém devolve TEMPORARY e o bootstrap REPETE o REVOKE"
su_psql -d postgres -c "GRANT TEMPORARY ON DATABASE $DB TO PUBLIC, app_user"
check "com drift, ataque volta a funcionar (prova que o teste mede algo)" permite app_user "$USER_PW" "$DB" -c "$SHADOW"
run_bootstrap
check "após reexecução, ataque negado de novo" nega    app_user "$USER_PW" "$DB" -c "$SHADOW"

echo "6. rotação de senha"
OLD_PW="$USER_PW"; USER_PW="$(rnd)"
run_bootstrap
check "senha antiga recusada"                  nega    app_user "$OLD_PW"  "$DB" -c "select 1"
check "senha nova aceita"                      permite app_user "$USER_PW" "$DB" -c "select 1"

echo "7. senha ausente aborta"
if PGHOST=127.0.0.1 PGPORT="$PORT" PGDATABASE="$DB" PGUSER=rds_master PGPASSWORD="$MASTER_PW" \
   PGSSLMODE=disable APP_MIGRATOR_PASSWORD= APP_USER_PASSWORD= PATH="$PG_BIN:$PATH" \
   sh "$DIR/bootstrap.sh" >/dev/null 2>&1; then fail=$((fail+1)); echo "  FALHA aceitou senha vazia"
else ok=$((ok+1)); echo "  ok    recusa senha vazia"; fi

echo "resultado: $ok ok, $fail falha(s)"
[ "$fail" -eq 0 ]
