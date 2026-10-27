#!/usr/bin/env bash
# Prova K-c3 de integração (parecer revisoes/2026-10-25-pr76.md, conferência de 27/10).
#
# O que prova: uma chave de clínica criada com a key policy da API (politicaDaChaveDaClinica, K-c2)
# só abre com EncryptionContext {tenant_id: <tenant da chave>}, MESMO para um principal com kms:* no
# IAM. Sem contexto, ou com o tenant_id de outra clínica, o KMS responde AccessDeniedException.
#
# Como:
#   1. gera a política pelo código da API (politica-kc3.mjs: importa a função do .ts, sem build);
#   2. cria UMA chave fictícia com essa política e as tags da API (tenant_id fictício, UUID novo)
#      mais prova=kc3;
#   3. cria um papel temporário (tag prova=kc3) com kms:* nessa chave no IAM, assumível só pelo
#      operador, e faz as chamadas com ele;
#   4. positivos primeiro (provam que o IAM do papel já vale), depois os negativos;
#   5. grava a evidência em JSON (ids e resultados; nenhum dado pessoal, nenhum texto em claro);
#   6. limpa SEMPRE (trap): apaga o papel e agenda a exclusão da chave com 7 dias (mínimo do KMS).
#      Só toca recurso com a tag prova=kc3.
#
# Pré-requisitos: AWS CLI v2, node 22+, `pnpm install` na raiz (para o typescript), credencial SSO
# de staging com permissão de criar chave KMS e papel IAM. NÃO roda no CI (não há credencial lá).
#
# Uso: CONTA_STAGING=<id> infra/scripts/staging/prova-kc3.sh
#   EVIDENCIA_DIR  onde gravar o JSON (padrão: diretório atual)
#
# Efeito colateral esperado: o ScheduleKeyDeletion da limpeza dispara o alerta kms_administracao
# no tópico de segurança (K-c5). Avise quem recebe o alerta antes de rodar.
set -euo pipefail

DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=infra/scripts/staging/comum.sh
source "$DIR/comum.sh"

readonly PROVA=kc3
EVIDENCIA_DIR=${EVIDENCIA_DIR:-$PWD}
TMP=$(mktemp -d)
RESULTADOS="$TMP/resultados.ndjson"
: >"$RESULTADOS"

CHAVE_ARN=""
PAPEL_NOME=""
PAPEL_ARN=""
APROVADA=false
LIMPEZA_CHAVE="nada a limpar"
LIMPEZA_PAPEL="nada a limpar"
INICIO=$(agora_utc)

recusar_desvio_de_endpoint
exigir_ferramentas
CONTA=$(conferir_conta)

TENANT=$(novo_uuid)
TENANT_OUTRO=$(novo_uuid)
SUFIXO=${TENANT:0:8}

# ---------------------------------------------------------------------------------------------
limpar() {
  local rc=$?
  set +e
  trap - EXIT INT TERM
  if [ -n "$PAPEL_NOME" ]; then
    local tag
    tag=$(aws iam list-role-tags --role-name "$PAPEL_NOME" \
      --query "Tags[?Key=='prova'].Value | [0]" --output text 2>/dev/null)
    if [ "$tag" = "$PROVA" ]; then
      aws iam delete-role-policy --role-name "$PAPEL_NOME" --policy-name kms-total-na-chave-de-prova
      if aws iam delete-role --role-name "$PAPEL_NOME"; then
        LIMPEZA_PAPEL="papel apagado"
      else
        LIMPEZA_PAPEL="FALHOU: apagar o papel $PAPEL_NOME à mão"
      fi
    else
      LIMPEZA_PAPEL="RECUSADO: papel sem a tag prova=$PROVA (não apagado)"
    fi
  fi
  if [ -n "$CHAVE_ARN" ]; then
    if agendar_exclusao_chave_de_prova "$CHAVE_ARN" "$PROVA"; then
      LIMPEZA_CHAVE="exclusão agendada (7 dias)"
    else
      LIMPEZA_CHAVE="FALHOU: agendar a exclusão de $CHAVE_ARN à mão (7 dias)"
    fi
  fi
  gravar_evidencia
  rm -rf "$TMP"
  info "limpeza: chave=[$LIMPEZA_CHAVE] papel=[$LIMPEZA_PAPEL]"
  if [ "$APROVADA" = true ] && [ $rc -eq 0 ]; then
    info "K-c3: APROVADA"
    exit 0
  fi
  info "K-c3: REPROVADA ou interrompida (ver evidência)"
  exit $((rc == 0 ? 1 : rc))
}
trap limpar EXIT INT TERM

gravar_evidencia() {
  local arquivo
  arquivo="$EVIDENCIA_DIR/prova-kc3-$(date -u +%Y%m%dT%H%M%SZ).json"
  INICIO="$INICIO" FIM="$(agora_utc)" CONTA="$CONTA" CHAVE_ARN="$CHAVE_ARN" PAPEL_ARN="$PAPEL_ARN" \
    TENANT="$TENANT" TENANT_OUTRO="$TENANT_OUTRO" APROVADA="$APROVADA" \
    LIMPEZA_CHAVE="$LIMPEZA_CHAVE" LIMPEZA_PAPEL="$LIMPEZA_PAPEL" \
    POLITICA_JSON="${POLITICA_JSON:-}" \
    node -e '
      const fs = require("node:fs");
      const e = process.env;
      const linhas = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean);
      const pol = e.POLITICA_JSON ? JSON.parse(e.POLITICA_JSON) : null;
      const ev = {
        prova: "K-c3 (integração): key policy da chave da clínica exige EncryptionContext",
        parecer: "docs/03-seguranca-lgpd/revisoes/2026-10-25-pr76.md",
        inicio: e.INICIO, fim: e.FIM, regiao: "sa-east-1", conta: e.CONTA,
        chave_arn: e.CHAVE_ARN || null,
        principal_da_prova: { arn: e.PAPEL_ARN || null, iam: "kms:* na chave de prova (política inline)" },
        tenant_id_ficticio: e.TENANT, tenant_id_ficticio_outro: e.TENANT_OUTRO,
        origem_da_politica: pol ? pol.origem : null,
        politica_aplicada: pol ? JSON.parse(pol.politica) : null,
        casos: linhas.map((l) => JSON.parse(l)),
        aprovada: e.APROVADA === "true",
        limpeza: { chave: e.LIMPEZA_CHAVE, papel: e.LIMPEZA_PAPEL },
        observacao: "Sem dado pessoal: ids técnicos, UUIDs fictícios e códigos de erro. Nenhum texto em claro foi gravado."
      };
      fs.writeFileSync(process.argv[2], JSON.stringify(ev, null, 2) + "\n");
    ' "$RESULTADOS" "$arquivo"
  info "evidência: $arquivo"
}

# registrar <caso> <operacao> <contexto> <esperado> <obtido> <codigo_erro> <negacao_explicita>
registrar() {
  node -e '
    const [caso, operacao, contexto, esperado, obtido, codigo, explicita] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({ caso, operacao, contexto, esperado, obtido,
      codigo_erro: codigo || null, negacao_explicita_em_politica_de_recurso: explicita === "sim",
      ok: esperado === obtido }) + "\n");
  ' "$@" >>"$RESULTADOS"
}

# Chama a AWS com a credencial do papel de prova (kms:* no IAM).
como_prova() {
  env -u AWS_PROFILE AWS_ACCESS_KEY_ID="$P_ID" AWS_SECRET_ACCESS_KEY="$P_SEGREDO" \
    AWS_SESSION_TOKEN="$P_TOKEN" aws "$@"
}

FALHAS=0

# negativo <caso> <descrição do contexto> -- <args da aws kms ...>
# Espera AccessDeniedException. InvalidCiphertextException (o contexto entra como AAD) ou sucesso
# significam que a key policy NÃO negou: reprova.
negativo() {
  local caso="$1" ctx="$2" op="$4"
  shift 3
  local err="$TMP/err" codigo explicita=nao obtido
  if como_prova kms "$@" --query KeyId --output text >/dev/null 2>"$err"; then
    obtido=sucesso
    codigo=""
  else
    codigo=$(codigo_do_erro "$err")
    obtido=${codigo:-erro_desconhecido}
    if grep -qi 'explicit deny in a resource-based policy' "$err"; then explicita=sim; fi
  fi
  registrar "$caso" "$op" "$ctx" AccessDeniedException "$obtido" "$codigo" "$explicita"
  if [ "$obtido" = AccessDeniedException ]; then
    info "ok   $caso: $op ($ctx) negado"
    [ "$explicita" = sim ] || info "     aviso: a mensagem não cita 'explicit deny in a resource-based policy'"
  else
    info "FALHA $caso: $op ($ctx) deu $obtido"
    FALHAS=$((FALHAS + 1))
  fi
}

# ---------------------------------------------------------------------------------------------
info "1/5 gerando a key policy pelo código da API"
POLITICA_JSON=$(node "$DIR/politica-kc3.mjs" "$CONTA" "$TENANT")
POLITICA=$(printf '%s' "$POLITICA_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).politica))')

info "2/5 criando a chave de prova (tenant fictício $TENANT)"
# Mesmos parâmetros do KmsKeyProvider.createMasterKey, mais a tag prova=kc3.
# Nunca pulando a trava de lockout da key policy (proibido pela K-c2; o CI reprova a opção).
CHAVE_ARN=$(aws kms create-key \
  --description "PROVA K-c3 (chave fictícia, sem dado; exclusão agendada ao fim)" \
  --key-usage ENCRYPT_DECRYPT --key-spec SYMMETRIC_DEFAULT \
  --policy "$POLITICA" \
  --tags TagKey=tenant_id,TagValue="$TENANT" TagKey=purpose,TagValue=tenant_data TagKey=prova,TagValue="$PROVA" \
  --query KeyMetadata.Arn --output text)
info "    chave: $CHAVE_ARN"

info "3/5 criando o papel temporário com kms:* no IAM"
# Quem pode assumir: só o principal do operador (papel do SSO, resolvido com o caminho completo).
CHAMADOR=$(aws sts get-caller-identity --query Arn --output text)
if [[ "$CHAMADOR" =~ ^arn:aws:sts::[0-9]{12}:assumed-role/([^/]+)/ ]]; then
  OPERADOR_ARN=$(aws iam get-role --role-name "${BASH_REMATCH[1]}" --query Role.Arn --output text)
else
  OPERADOR_ARN="$CHAMADOR"
fi
CONFIANCA=$(OP="$OPERADOR_ARN" CONTA="$CONTA" node -e '
  process.stdout.write(JSON.stringify({ Version: "2012-10-17", Statement: [{
    Effect: "Allow", Principal: { AWS: `arn:aws:iam::${process.env.CONTA}:root` }, Action: "sts:AssumeRole",
    Condition: { ArnEquals: { "aws:PrincipalArn": process.env.OP } } }] }));')
PAPEL_NOME="prova-kc3-$SUFIXO"
PAPEL_ARN=$(aws iam create-role --role-name "$PAPEL_NOME" \
  --assume-role-policy-document "$CONFIANCA" --max-session-duration 3600 \
  --description "PROVA K-c3: kms:* no IAM numa chave fictícia; apagado ao fim" \
  --tags Key=prova,Value="$PROVA" --query Role.Arn --output text)
KMS_TOTAL=$(CHAVE="$CHAVE_ARN" node -e '
  process.stdout.write(JSON.stringify({ Version: "2012-10-17", Statement: [{
    Sid: "KmsTotalNaChaveDeProva", Effect: "Allow", Action: "kms:*", Resource: process.env.CHAVE }] }));')
aws iam put-role-policy --role-name "$PAPEL_NOME" --policy-name kms-total-na-chave-de-prova \
  --policy-document "$KMS_TOTAL"

# IAM é eventualmente consistente: tenta assumir por até ~2 min.
CRED=""
for _ in $(seq 1 24); do
  if CRED=$(aws sts assume-role --role-arn "$PAPEL_ARN" --role-session-name "prova-kc3" \
    --duration-seconds 3600 \
    --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text 2>/dev/null); then
    break
  fi
  CRED=""
  sleep 5
done
[ -n "$CRED" ] || falhar "não consegui assumir $PAPEL_ARN"
read -r P_ID P_SEGREDO P_TOKEN <<<"$CRED"
unset CRED

CTX_CERTO="tenant_id=$TENANT"
CTX_OUTRO="tenant_id=$TENANT_OUTRO"
BLOB="$TMP/dek.bin"

info "4/5 positivos (com o contexto da clínica da chave)"
# P1: GenerateDataKey com o contexto certo. Repete enquanto o IAM do papel propaga. Só o
# CiphertextBlob é guardado (em arquivo temporário); o Plaintext não é lido nem gravado.
P1=falha
for _ in $(seq 1 12); do
  if B64=$(como_prova kms generate-data-key --key-id "$CHAVE_ARN" --key-spec AES_256 \
    --encryption-context "$CTX_CERTO" --query CiphertextBlob --output text 2>"$TMP/err"); then
    printf '%s' "$B64" | base64 -d >"$BLOB"
    P1=sucesso
    break
  fi
  sleep 5
done
registrar P1 GenerateDataKey "tenant_id da chave" sucesso "$P1" "$( [ "$P1" = sucesso ] || codigo_do_erro "$TMP/err")" nao
[ "$P1" = sucesso ] || falhar "P1: GenerateDataKey com o contexto certo falhou ($(codigo_do_erro "$TMP/err")); sem positivo, os negativos não provam nada"
info "ok   P1: GenerateDataKey (contexto certo)"

P2=sucesso
como_prova kms decrypt --key-id "$CHAVE_ARN" --ciphertext-blob "fileb://$BLOB" \
  --encryption-context "$CTX_CERTO" --query KeyId --output text >/dev/null 2>"$TMP/err" || P2=falha
registrar P2 Decrypt "tenant_id da chave" sucesso "$P2" "$( [ "$P2" = sucesso ] || codigo_do_erro "$TMP/err")" nao
[ "$P2" = sucesso ] || falhar "P2: Decrypt com o contexto certo falhou ($(codigo_do_erro "$TMP/err"))"
info "ok   P2: Decrypt (contexto certo)"

info "5/5 negativos (sem contexto ou com o tenant_id de outra clínica)"
negativo N1 "sem contexto" -- generate-data-key --key-id "$CHAVE_ARN" --key-spec AES_256
negativo N2 "tenant_id de outra clínica" -- generate-data-key --key-id "$CHAVE_ARN" --key-spec AES_256 \
  --encryption-context "$CTX_OUTRO"
negativo N3 "sem contexto" -- generate-data-key-without-plaintext --key-id "$CHAVE_ARN" --key-spec AES_256
negativo N4 "sem contexto" -- decrypt --key-id "$CHAVE_ARN" --ciphertext-blob "fileb://$BLOB"
negativo N5 "tenant_id de outra clínica" -- decrypt --key-id "$CHAVE_ARN" --ciphertext-blob "fileb://$BLOB" \
  --encryption-context "$CTX_OUTRO"
negativo N6 "sem contexto" -- encrypt --key-id "$CHAVE_ARN" --plaintext "fileb://$BLOB"
negativo N7 "tenant_id de outra clínica" -- encrypt --key-id "$CHAVE_ARN" --plaintext "fileb://$BLOB" \
  --encryption-context "$CTX_OUTRO"
negativo N8 "origem certa, destino sem contexto" -- re-encrypt --ciphertext-blob "fileb://$BLOB" \
  --source-key-id "$CHAVE_ARN" --source-encryption-context "$CTX_CERTO" \
  --destination-key-id "$CHAVE_ARN"
negativo N9 "origem certa, destino de outra clínica" -- re-encrypt --ciphertext-blob "fileb://$BLOB" \
  --source-key-id "$CHAVE_ARN" --source-encryption-context "$CTX_CERTO" \
  --destination-key-id "$CHAVE_ARN" --destination-encryption-context "$CTX_OUTRO"

unset P_ID P_SEGREDO P_TOKEN
if [ "$FALHAS" -eq 0 ]; then
  APROVADA=true
else
  falhar "$FALHAS negativo(s) não deram AccessDeniedException"
fi
