#!/bin/sh
# Conferência pós-deploy das guardas do banco (R12 do parecer do PR #61).
# Compara a impressão digital (verificar-guardas.sql) do banco com a esperada, gerada a partir
# das migrações do repositório num Postgres 16 descartável. Só lê catálogo; nada de dado.
#
#   sh infra/rds/verificar-guardas.sh referencia > esperado.tsv   # PG16 local: bootstrap + migrações
#   sh infra/rds/verificar-guardas.sh banco      > obtido.tsv     # banco alvo pelas variáveis PG*
#   sh infra/rds/verificar-guardas.sh comparar esperado.tsv obtido.tsv
#   sh infra/rds/verificar-guardas.sh autoteste                   # prova que a adulteração aparece (CI)
#
# "banco" roda de dentro da VPC (mesma tarefa ECS do bootstrap/migração), com o papel de máquina,
# PGSSLMODE=verify-full por padrão (rds.force_ssl=1). Qualquer papel lê o catálogo: use o
# app_migrator, nunca o master. "referencia" e "autoteste" pedem PG_BIN com PostgreSQL 16.
set -eu

DIR="$(cd "$(dirname "$0")" && pwd)"
MIGRACOES="$DIR/../../apps/api/db/migrations"
SQL="$DIR/verificar-guardas.sql"

impressao() { psql --no-psqlrc -X -q -At -F "$(printf '\t')" -v ON_ERROR_STOP=1 -f "$SQL"; }

# Sobe PG16 descartável, roda o bootstrap como master sem superusuário (igual ao RDS) e aplica as
# migrações como app_migrator, cada arquivo numa transação (igual a apps/api/scripts/migrate.mjs).
# Deixa PG* apontando para o banco como app_migrator e chama "$1" (função) antes de desligar.
com_banco_descartavel() {
  PG_BIN="${PG_BIN:-$(dirname "$(command -v postgres)")}"
  "$PG_BIN/postgres" --version | grep -q ' 16\.' || { echo "precisa de PostgreSQL 16" >&2; exit 1; }
  PORTA="${PGPORT_REFERENCIA:-55483}"
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/guardas-pg.XXXXXX")"
  trap '"$PG_BIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT INT TERM
  rnd() { openssl rand -hex 16; }
  MASTER_PW="$(rnd)"; MIG_PW="$(rnd)"; USER_PW="$(rnd)"

  "$PG_BIN/initdb" -D "$WORK/data" -U postgres -E UTF8 --locale=C \
    --auth-local=trust --auth-host=scram-sha-256 >/dev/null
  "$PG_BIN/pg_ctl" -D "$WORK/data" -l "$WORK/pg.log" -w \
    -o "-p $PORTA -c listen_addresses=127.0.0.1 -k $WORK -c fsync=off" start >/dev/null
  "$PG_BIN/psql" -X -q -h "$WORK" -p "$PORTA" -U postgres -d postgres -v ON_ERROR_STOP=1 \
    -c "CREATE ROLE rds_master LOGIN CREATEROLE CREATEDB PASSWORD '$MASTER_PW'" \
    -c "CREATE DATABASE plataforma_saude OWNER rds_master"

  export PATH="$PG_BIN:$PATH" PGHOST=127.0.0.1 PGPORT="$PORTA" PGDATABASE=plataforma_saude PGSSLMODE=disable
  PGUSER=rds_master PGPASSWORD="$MASTER_PW" APP_MIGRATOR_PASSWORD="$MIG_PW" APP_USER_PASSWORD="$USER_PW" \
    sh "$DIR/bootstrap.sh" >/dev/null

  export PGUSER=app_migrator PGPASSWORD="$MIG_PW"
  psql --no-psqlrc -X -q -v ON_ERROR_STOP=1 \
    -c "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())" \
    -c "REVOKE ALL ON schema_migrations FROM PUBLIC, app_user"
  for f in $(cd "$MIGRACOES" && ls -- *.sql | LC_ALL=C sort); do
    psql --no-psqlrc -X -q -v ON_ERROR_STOP=1 -1 -f "$MIGRACOES/$f" \
      -c "INSERT INTO schema_migrations (name) VALUES ('$f')" >/dev/null
  done
  "$1"
}

comparar() {
  if diff -u "$1" "$2"; then
    echo "guardas conferem: $(wc -l < "$2" | tr -d ' ') objetos iguais ao repositório." >&2
  else
    echo "DIVERGÊNCIA: o banco não bate com as migrações do repositório. Abrir incidente (runbook em docs/04-arquitetura/infra-staging.md)." >&2
    return 1
  fi
}

autoteste() {
  impressao > "$WORK/antes.tsv"
  [ "$(grep -c . "$WORK/antes.tsv")" -gt 0 ] || { echo "impressão vazia" >&2; exit 1; }
  impressao > "$WORK/de-novo.tsv"
  comparar "$WORK/antes.tsv" "$WORK/de-novo.tsv" >/dev/null || { echo "FALHA: impressão não determinística" >&2; exit 1; }
  # Adulterações que o alarme de DDL avisa; a conferência tem de apontar cada uma.
  psql --no-psqlrc -X -q -v ON_ERROR_STOP=1 \
    -c 'CREATE OR REPLACE FUNCTION public.audit_log_reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$' \
    -c 'ALTER FUNCTION public.app_current_tenant() SET work_mem = '"'1MB'" \
    -c 'ALTER POLICY tenant_isolation ON public.patients USING (true)' \
    -c 'ALTER TABLE public.patients NO FORCE ROW LEVEL SECURITY'
  impressao > "$WORK/depois.tsv"
  esperadas="funcao	public.app_current_tenant()
funcao	public.audit_log_reject_mutation()
policy	public.patients/tenant_isolation
tabela	public.patients"
  achadas="$(diff "$WORK/antes.tsv" "$WORK/depois.tsv" | sed -n 's/^> //p' | cut -f1,2)"
  if [ "$achadas" = "$esperadas" ]; then
    echo "autoteste ok: $(grep -c . "$WORK/antes.tsv") objetos; as 4 adulterações apareceram."
  else
    printf 'FALHA no autoteste. Esperado:\n%s\nVeio:\n%s\n' "$esperadas" "$achadas" >&2; exit 1
  fi
}

case "${1:-}" in
  referencia) com_banco_descartavel impressao ;;
  banco)
    : "${PGHOST:?defina PGHOST}"; : "${PGDATABASE:?defina PGDATABASE}"; : "${PGUSER:?defina PGUSER}"
    export PGSSLMODE="${PGSSLMODE:-verify-full}"
    impressao ;;
  comparar) [ $# -eq 3 ] || { echo "uso: $0 comparar <esperado> <obtido>" >&2; exit 2; }; comparar "$2" "$3" ;;
  autoteste) com_banco_descartavel autoteste ;;
  *) echo "uso: $0 referencia | banco | comparar <esperado> <obtido> | autoteste" >&2; exit 2 ;;
esac
