# shellcheck shell=bash
# Funções comuns das provas de staging (K-c3, K-c5). Carregado com `source` pelos scripts prova-*.sh.
# Nada aqui cria recurso: só checagens, registro de evidência e as travas de segurança.

# Região fixa: a prova só vale em sa-east-1 (residência de dados) e nunca deve cair em outra.
readonly REGIAO=sa-east-1
export AWS_REGION="$REGIAO" AWS_DEFAULT_REGION="$REGIAO"
export AWS_PAGER=""

falhar() {
  echo "ERRO: $*" >&2
  # Lido pela limpeza (trap) para registrar o motivo da reprovação na evidência.
  # shellcheck disable=SC2034
  ULTIMO_ERRO="$*"
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

# Negação EXPLÍCITA por política de recurso (a key policy) na mensagem de erro da AWS CLI. Sem ela,
# a falta de permissão no IAM (negação implícita) ou um Deny de SCP/permission set explicaria o
# AccessDenied, e a prova do Deny da key policy não vale. Variações documentadas pela AWS
# ("Access denied error messages"): "with an explicit deny in a resource-based policy" e
# "because of an explicit deny in a resource-based policy" (com ou sem artigo, maiúsculas à parte).
# NÃO aceita "explicit deny in an identity-based policy", "... in a service control policy",
# "... in a session policy", "... in a permissions boundary" nem o formato antigo sem o tipo.
negacao_explicita_da_key_policy() {
  grep -qiE 'explicit deny in (a |the )?resource[- ]based polic(y|ies)' "$1"
}

# SHA-256 do JSON canonicalizado (chaves de objeto ordenadas, sem espaços; ordem dos arrays mantida),
# lido do arquivo $1. O KMS pode devolver a política com outra formatação; o conteúdo tem de ser o mesmo.
sha256_json_canonico() {
  node -e '
    const fs = require("node:fs");
    const can = (v) => Array.isArray(v) ? v.map(can)
      : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, can(v[k])])) : v;
    const txt = JSON.stringify(can(JSON.parse(fs.readFileSync(process.argv[1], "utf8"))));
    process.stdout.write(require("node:crypto").createHash("sha256").update(txt).digest("hex"));
  ' "$1"
}

# Relê o JSON de evidência antes de anexar (§7 do runbook): não pode conter e-mail, token de sessão,
# AccessKeyId nem IP. Se contiver, troca o valor por "[REMOVIDO:<tipo>]", marca aprovada=false com o
# motivo em evidencia_reprovada_por e devolve 1. A reprovação continua sendo evidência anexável.
sanear_evidencia() {
  # shellcheck disable=SC2016 # o código entre aspas simples é JavaScript do node -e; o $ é dele
  node -e '
    const fs = require("node:fs");
    const arq = process.argv[1];
    let txt = fs.readFileSync(arq, "utf8");
    const padroes = [
      ["e-mail", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
      ["AccessKeyId", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
      ["token de sessão", /\b(?:IQoJb3JpZ2lu|FwoGZXIvYXdz)[A-Za-z0-9+/=]*|[A-Za-z0-9+/]{100,}={0,2}/g],
      ["IPv4", /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g],
      ["IPv6", /\b[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{0,4}){4,7}\b/g],
    ];
    const achados = [];
    for (const [tipo, re] of padroes) {
      const n = (txt.match(re) || []).length;
      if (n) { achados.push(`${tipo} (${n})`); txt = txt.replace(re, `[REMOVIDO:${tipo}]`); }
    }
    if (!achados.length) process.exit(0);
    const ev = JSON.parse(txt);
    ev.aprovada = false;
    ev.evidencia_reprovada_por = [...(ev.evidencia_reprovada_por || []),
      `a evidência continha ${achados.join(", ")}; valores removidos antes de gravar`];
    fs.writeFileSync(arq, JSON.stringify(ev, null, 2) + "\n");
    console.error(`RELEITURA: a evidência continha ${achados.join(", ")} (removido; prova REPROVADA)`);
    process.exit(1);
  ' "$1"
}

# Algum resultado de limpeza com FALHOU ou RECUSADO? Então a prova não sai aprovada.
limpeza_falhou() {
  local v
  for v in "$@"; do
    case "$v" in FALHOU* | RECUSADO*) return 0 ;; esac
  done
  return 1
}
