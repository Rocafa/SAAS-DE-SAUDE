# shellcheck shell=bash
# Funções comuns das provas de staging (K-c3, K-c5). Carregado com `source` pelos scripts prova-*.sh.
# Nada aqui cria recurso: só checagens, registro de evidência e as travas de segurança.

# Região fixa: a prova só vale em sa-east-1 (residência de dados) e nunca deve cair em outra.
readonly REGIAO=sa-east-1
export AWS_REGION="$REGIAO" AWS_DEFAULT_REGION="$REGIAO"
export AWS_PAGER=""

falhar() {
  echo "ERRO: $*" >&2
  exit 1
}

info() {
  echo "[$(date -u +%H:%M:%SZ)] $*" >&2
}

# Variáveis que desviam o tráfego da AWS para outro endpoint invalidariam a prova.
recusar_desvio_de_endpoint() {
  local v
  for v in $(env | sed -n 's/^\(AWS_ENDPOINT_URL[A-Z_]*\)=.*/\1/p'); do
    falhar "a variável $v está definida; a prova precisa falar com o KMS real de $REGIAO"
  done
  [ -z "${KMS_ENDPOINT:-}" ] || falhar "KMS_ENDPOINT definida; remova antes da prova"
}

exigir_ferramentas() {
  local f
  for f in aws node "$@"; do
    command -v "$f" >/dev/null 2>&1 || falhar "ferramenta ausente: $f"
  done
  aws --version 2>&1 | grep -q '^aws-cli/2\.' || falhar "precisa da AWS CLI v2"
}

# Trava contra rodar na conta errada (produção!): CONTA_STAGING é obrigatória e tem de bater
# com a credencial em uso. Saída: o id da conta.
conferir_conta() {
  [ -n "${CONTA_STAGING:-}" ] || falhar "defina CONTA_STAGING=<id de 12 dígitos da conta de staging>"
  [[ "$CONTA_STAGING" =~ ^[0-9]{12}$ ]] || falhar "CONTA_STAGING inválida"
  local conta
  conta=$(aws sts get-caller-identity --query Account --output text) \
    || falhar "sem credencial válida (faça aws sso login)"
  [ "$conta" = "$CONTA_STAGING" ] || falhar "a credencial é da conta $conta, não da de staging"
  printf '%s' "$conta"
}

novo_uuid() {
  node -e 'process.stdout.write(require("node:crypto").randomUUID())'
}

agora_utc() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

# Código do erro da AWS CLI ("An error occurred (AccessDeniedException) when calling ...").
codigo_do_erro() {
  sed -n 's/.*An error occurred (\([A-Za-z0-9.]*\)).*/\1/p' "$1" | head -n1
}

# Só toca chave KMS que tenha a tag prova=<valor>. Qualquer outra chave: recusa.
exigir_tag_prova_kms() {
  local chave="$1" valor="$2" tag="" _
  # Tenta 3 vezes: a tag pode demorar alguns segundos a aparecer logo após o CreateKey.
  for _ in 1 2 3; do
    tag=$(aws kms list-resource-tags --key-id "$chave" \
      --query "Tags[?TagKey=='prova'].TagValue | [0]" --output text 2>/dev/null || true)
    if [ "$tag" = "$valor" ]; then
      return 0
    fi
    sleep 3
  done
  echo "RECUSADO: chave sem a tag prova=$valor" >&2
  return 1
}

# Agenda a exclusão (janela mínima de 7 dias) só de chave de prova. Idempotente.
agendar_exclusao_chave_de_prova() {
  local chave="$1" valor="$2" estado
  exigir_tag_prova_kms "$chave" "$valor" || return 1
  estado=$(aws kms describe-key --key-id "$chave" --query KeyMetadata.KeyState --output text)
  if [ "$estado" = PendingDeletion ]; then
    return 0
  fi
  aws kms schedule-key-deletion --key-id "$chave" --pending-window-in-days 7 \
    --query DeletionDate --output text >/dev/null
}
