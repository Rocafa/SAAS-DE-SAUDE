#!/bin/sh
# Bootstrap dos papéis app_migrator/app_user no RDS. Idempotente (ver bootstrap.sql).
#
# Uso (de uma máquina com acesso à VPC, ex.: tarefa ECS one-off ou bastion via SSM):
#   export PGHOST=<endpoint do RDS> PGPORT=5432 PGDATABASE=plataforma_saude
#   export PGUSER=<master>          # senha do master: PGPASSWORD vinda do Secrets Manager
#   export APP_MIGRATOR_PASSWORD=... APP_USER_PASSWORD=...   # também do Secrets Manager
#   sh infra/rds/bootstrap.sh
#
# TLS: o RDS tem rds.force_ssl=1. Por padrão exige verify-full com o bundle da AWS
# (https://truststore.pki.rds.amazonaws.com/sa-east-1/sa-east-1-bundle.pem) em PGSSLROOTCERT.
# Só o teste local (test-bootstrap.sh) sobrescreve PGSSLMODE.
set -eu

: "${PGHOST:?defina PGHOST}"
: "${PGDATABASE:?defina PGDATABASE}"
: "${PGUSER:?defina PGUSER (master)}"
: "${APP_MIGRATOR_PASSWORD:?defina APP_MIGRATOR_PASSWORD}"
: "${APP_USER_PASSWORD:?defina APP_USER_PASSWORD}"
export PGSSLMODE="${PGSSLMODE:-verify-full}"

exec psql --no-psqlrc -X -q -f "$(dirname "$0")/bootstrap.sql"
