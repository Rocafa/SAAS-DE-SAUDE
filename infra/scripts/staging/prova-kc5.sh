#!/usr/bin/env bash
# Prova K-c5 (parecer revisoes/2026-10-25-pr76.md, "Conferência K-c4a, F-1 e K-c5", 27/10).
#
# O que prova: DisableKey e PutKeyPolicy numa chave KMS chegam ao tópico SNS de segurança
# (alertas_seguranca) pela regra do EventBridge kms_administracao (kms-clinicas.tf).
#
# Como:
#   1. confere que a regra existe, está ligada e aponta para o tópico;
#   2. cria uma fila SQS temporária (tag prova=kc5), com política que só aceita o próprio tópico,
#      e a assina no tópico com filtro (só eventos aws.kms das ações da regra);
#   3. cria uma chave fictícia (tag prova=kc5, sem tenant_id: não é chave de clínica);
#   4. faz DisableKey e PutKeyPolicy (reaplica a MESMA política padrão: nada muda de fato);
#   5. lê a fila até achar os dois eventos DESSA chave (CloudTrail → EventBridge leva minutos);
#   6. grava a evidência em JSON: para DisableKey e PutKeyPolicy, o horário da ação, o eventID e o
#      eventTime do CloudTrail, o MessageId e o Timestamp do SNS e o horário de chegada na fila, mais
#      o campo email_recebido_em (canal humano), que o OPERADOR preenche depois com --anotar-email.
#      Não grava userIdentity, IP nem user agent: o nome da sessão do SSO pode conter e-mail. Relê o
#      JSON ao fim e reprova se achar e-mail, token de sessão, AccessKeyId ou IP;
#   7. limpa SEMPRE (trap): agenda a exclusão da chave (7 dias), cancela a assinatura e apaga a
#      fila. Só toca recurso com a tag prova=kc5. A chave fica desabilitada: nunca EnableKey.
#      Limpeza com FALHOU/RECUSADO reprova a prova.
#
# Pré-requisitos: AWS CLI v2, node 22+, credencial SSO de staging com permissão de KMS, SQS e
# sns:Subscribe/Unsubscribe no tópico. NÃO roda no CI (não há credencial lá).
#
# Uso: CONTA_STAGING=<id> infra/scripts/staging/prova-kc5.sh
#   EVIDENCIA_DIR  onde gravar o JSON (padrão: diretório atual)
#   PRAZO_MIN      quanto esperar pelos alertas, em minutos (padrão: 20)
#   NOME_BASE      prefixo dos recursos do Terraform (padrão: plataforma-saude-staging)
#
# Depois que os e-mails do tópico chegarem (horário do cabeçalho do e-mail, em UTC):
#   infra/scripts/staging/prova-kc5.sh --anotar-email <evidência.json> <horário DisableKey> <horário PutKeyPolicy>
#   (formato AAAA-MM-DDTHH:MM:SSZ; não fala com a AWS, só preenche email_recebido_em e relê o JSON)
#
# Efeito colateral esperado: os assinantes do tópico (e-mail de segurança) recebem 3 alertas:
# DisableKey, PutKeyPolicy e o ScheduleKeyDeletion da limpeza. Avise antes de rodar.
set -euo pipefail

DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=infra/scripts/staging/comum.sh
source "$DIR/comum.sh"

readonly PROVA=kc5

# Modo --anotar-email: o operador registra quando o e-mail de cada alerta chegou (canal humano,
# condição 4 da conferência de 27/10). Não cria nada nem fala com a AWS.
if [ "${1:-}" = --anotar-email ]; then
  [ $# -eq 4 ] || falhar "uso: $0 --anotar-email <evidência.json> <horário DisableKey> <horário PutKeyPolicy>"
  [ -f "$2" ] || falhar "evidência $2 não existe"
  node -e '
    const fs = require("node:fs");
    const [arq, tDisable, tPut] = process.argv.slice(1);
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
    const ev = JSON.parse(fs.readFileSync(arq, "utf8"));
    if (!ev.eventos) { console.error("evidência sem o bloco eventos (não é da prova-kc5 atual)"); process.exit(1); }
    for (const [acao, t] of [["DisableKey", tDisable], ["PutKeyPolicy", tPut]]) {
      if (!iso.test(t) || Number.isNaN(Date.parse(t))) { console.error(`${acao}: horário inválido (${t}); use AAAA-MM-DDTHH:MM:SSZ`); process.exit(1); }
      const e = ev.eventos[acao];
      if (!e || !e.sns_message_id) { console.error(`${acao}: a evidência não tem o alerta pelo SNS; nada a anotar`); process.exit(1); }
      if (e.acao_provocada_em && Date.parse(t) < Date.parse(e.acao_provocada_em)) {
        console.error(`${acao}: e-mail (${t}) antes da própria ação (${e.acao_provocada_em})`); process.exit(1);
      }
      e.email_recebido_em = t;
    }
    ev.email_anotado_pelo_operador_em = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    fs.writeFileSync(arq, JSON.stringify(ev, null, 2) + "\n");
  ' "$2" "$3" "$4" || falhar "anotação recusada"
  sanear_evidencia "$2" || falhar "a evidência continha dado proibido (removido; K-c5 REPROVADA)"
  info "e-mail anotado em $2"
  exit 0
fi

EVIDENCIA_DIR=${EVIDENCIA_DIR:-$PWD}
PRAZO_MIN=${PRAZO_MIN:-20}
NOME_BASE=${NOME_BASE:-plataforma-saude-staging}
[[ "$PRAZO_MIN" =~ ^[0-9]+$ ]] || falhar "PRAZO_MIN inválido"
TMP=$(mktemp -d)
EVENTOS="$TMP/eventos.ndjson"
: >"$EVENTOS"

CHAVE_ARN=""
FILA_URL=""
FILA_ARN=""
ASSINATURA_ARN=""
APROVADA=false
REGRA_ESTADO=""
REGRA_ALVO_OK=false
T_DISABLE=""
T_PUT=""
LIMPEZA_CHAVE="nada a limpar"
LIMPEZA_FILA="nada a limpar"
LIMPEZA_ASSINATURA="nada a limpar"
ULTIMO_ERRO=""
REPROVADA_POR=""
EVIDENCIA_ARQUIVO=""
INICIO=$(agora_utc)

recusar_desvio_de_endpoint
exigir_ferramentas
CONTA=$(conferir_conta)
SUFIXO=$(novo_uuid)
SUFIXO=${SUFIXO:0:8}
TOPICO_ARN="arn:aws:sns:$REGIAO:$CONTA:$NOME_BASE-alertas-seguranca"
REGRA="$NOME_BASE-kms-administracao"

# ---------------------------------------------------------------------------------------------
limpar() {
  local rc=$?
  set +e
  trap - EXIT INT TERM
  if [ -n "$CHAVE_ARN" ]; then
    if agendar_exclusao_chave_de_prova "$CHAVE_ARN" "$PROVA"; then
      LIMPEZA_CHAVE="exclusão agendada (7 dias)"
    else
      LIMPEZA_CHAVE="FALHOU: agendar a exclusão de $CHAVE_ARN à mão (7 dias)"
    fi
  fi
  if [ -n "$ASSINATURA_ARN" ] && [[ "$ASSINATURA_ARN" == arn:* ]]; then
    if aws sns unsubscribe --subscription-arn "$ASSINATURA_ARN"; then
      LIMPEZA_ASSINATURA="assinatura cancelada"
    else
      LIMPEZA_ASSINATURA="FALHOU: cancelar $ASSINATURA_ARN à mão"
    fi
  fi
  if [ -n "$FILA_URL" ]; then
    local tag
    tag=$(aws sqs list-queue-tags --queue-url "$FILA_URL" --query 'Tags.prova' --output text 2>/dev/null)
    if [ "$tag" = "$PROVA" ]; then
      if aws sqs delete-queue --queue-url "$FILA_URL"; then
        LIMPEZA_FILA="fila apagada"
      else
        LIMPEZA_FILA="FALHOU: apagar $FILA_URL à mão"
      fi
    else
      LIMPEZA_FILA="RECUSADO: fila sem a tag prova=$PROVA (não apagada)"
    fi
  fi
  [ -z "$ULTIMO_ERRO" ] || REPROVADA_POR+="$ULTIMO_ERRO"$'\n'
  if limpeza_falhou "$LIMPEZA_CHAVE" "$LIMPEZA_ASSINATURA" "$LIMPEZA_FILA"; then
    APROVADA=false
    REPROVADA_POR+="limpeza com FALHOU/RECUSADO (ver campo limpeza; registrar a limpeza manual)"$'\n'
  fi
  [ $rc -eq 0 ] || APROVADA=false
  gravar_evidencia
  # Relê o JSON gravado: e-mail, token, AccessKeyId ou IP reprovam (o valor sai do arquivo).
  sanear_evidencia "$EVIDENCIA_ARQUIVO" || APROVADA=false
  rm -rf "$TMP"
  info "limpeza: chave=[$LIMPEZA_CHAVE] assinatura=[$LIMPEZA_ASSINATURA] fila=[$LIMPEZA_FILA]"
  if [ "$APROVADA" = true ] && [ $rc -eq 0 ]; then
    info "K-c5: APROVADA"
    exit 0
  fi
  info "K-c5: REPROVADA ou interrompida (ver evidência)"
  exit $((rc == 0 ? 1 : rc))
}
trap limpar EXIT INT TERM

gravar_evidencia() {
  local arquivo
  arquivo="$EVIDENCIA_DIR/prova-kc5-$(date -u +%Y%m%dT%H%M%SZ).json"
  EVIDENCIA_ARQUIVO="$arquivo"
  REPROVADA_POR="$REPROVADA_POR" \
  INICIO="$INICIO" FIM="$(agora_utc)" CONTA="$CONTA" CHAVE_ARN="$CHAVE_ARN" TOPICO_ARN="$TOPICO_ARN" \
    REGRA="$REGRA" REGRA_ESTADO="$REGRA_ESTADO" REGRA_ALVO_OK="$REGRA_ALVO_OK" \
    T_DISABLE="$T_DISABLE" T_PUT="$T_PUT" APROVADA="$APROVADA" \
    LIMPEZA_CHAVE="$LIMPEZA_CHAVE" LIMPEZA_FILA="$LIMPEZA_FILA" LIMPEZA_ASSINATURA="$LIMPEZA_ASSINATURA" \
    node -e '
      const fs = require("node:fs");
      const e = process.env;
      const eventos = fs.readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      // Um bloco por ação provocada: o 1º alerta dela vindo do tópico de segurança.
      const resumo = (acao, t) => {
        const a = eventos.find((x) => x.eventName === acao && x.sns && x.sns.do_topico_de_seguranca);
        return {
          acao_provocada_em: t || null,
          do_topico_de_seguranca: !!a,
          cloudtrail_event_id: a ? a.eventID || null : null,
          cloudtrail_event_time: a ? a.eventTime || null : null,
          sns_message_id: a ? a.sns.message_id || null : null,
          sns_timestamp: a ? a.sns.timestamp || null : null,
          recebido_na_fila: a ? a.recebido_na_fila : null,
          email_recebido_em: null,
        };
      };
      const ev = {
        prova: "K-c5: DisableKey/PutKeyPolicy chegam ao tópico de segurança (regra kms_administracao)",
        parecer: "docs/03-seguranca-lgpd/revisoes/2026-10-25-pr76.md",
        inicio: e.INICIO, fim: e.FIM, regiao: "sa-east-1", conta: e.CONTA,
        regra: { nome: e.REGRA, estado: e.REGRA_ESTADO || null, alvo_e_o_topico: e.REGRA_ALVO_OK === "true" },
        topico_arn: e.TOPICO_ARN,
        chave_ficticia_arn: e.CHAVE_ARN || null,
        acoes_provocadas: { DisableKey: e.T_DISABLE || null, PutKeyPolicy: e.T_PUT || null },
        eventos: { DisableKey: resumo("DisableKey", e.T_DISABLE), PutKeyPolicy: resumo("PutKeyPolicy", e.T_PUT) },
        email_recebido_em_como_preencher: "Operador: horário (UTC) do cabeçalho do e-mail de cada alerta, com prova-kc5.sh --anotar-email <este arquivo> <DisableKey> <PutKeyPolicy> (runbook §6.2). Sem e-mail anotado, a condição 4 fica pendente.",
        alertas_recebidos: eventos,
        aprovada: e.APROVADA === "true",
        evidencia_reprovada_por: e.REPROVADA_POR.split("\n").filter(Boolean),
        limpeza: { chave: e.LIMPEZA_CHAVE, assinatura: e.LIMPEZA_ASSINATURA, fila: e.LIMPEZA_FILA },
        observacao: "Sem dado pessoal: userIdentity, sourceIPAddress e userAgent do evento não são gravados. JSON relido ao fim (sem e-mail, token, AccessKeyId nem IP)."
      };
      fs.writeFileSync(process.argv[2], JSON.stringify(ev, null, 2) + "\n");
    ' "$EVENTOS" "$arquivo"
  info "evidência: $arquivo"
}

# ---------------------------------------------------------------------------------------------
info "1/6 conferindo a regra $REGRA e o tópico"
aws sns get-topic-attributes --topic-arn "$TOPICO_ARN" --query Attributes.TopicArn --output text >/dev/null \
  || falhar "tópico $TOPICO_ARN não existe (o apply foi feito?)"
REGRA_ESTADO=$(aws events describe-rule --name "$REGRA" --query State --output text)
[ "$REGRA_ESTADO" = ENABLED ] || falhar "regra $REGRA com estado $REGRA_ESTADO"
ALVOS=$(aws events list-targets-by-rule --rule "$REGRA" --query 'Targets[].Arn' --output text)
if printf '%s\n' "$ALVOS" | tr '\t' '\n' | grep -qxF "$TOPICO_ARN"; then
  REGRA_ALVO_OK=true
else
  falhar "a regra $REGRA não aponta para $TOPICO_ARN"
fi

info "2/6 criando a fila temporária e assinando o tópico"
FILA_NOME="prova-kc5-$SUFIXO"
FILA_URL=$(aws sqs create-queue --queue-name "$FILA_NOME" \
  --attributes SqsManagedSseEnabled=true,MessageRetentionPeriod=7200 \
  --tags prova="$PROVA" --query QueueUrl --output text)
FILA_ARN=$(aws sqs get-queue-attributes --queue-url "$FILA_URL" --attribute-names QueueArn \
  --query Attributes.QueueArn --output text)
# Política da fila: só o tópico de segurança envia. Vai num arquivo de atributos (JSON dentro de JSON).
FILA_ARN="$FILA_ARN" TOPICO_ARN="$TOPICO_ARN" node -e '
  const e = process.env;
  const pol = { Version: "2012-10-17", Statement: [{ Sid: "SoOTopicoDeSeguranca", Effect: "Allow",
    Principal: { Service: "sns.amazonaws.com" }, Action: "sqs:SendMessage", Resource: e.FILA_ARN,
    Condition: { ArnEquals: { "aws:SourceArn": e.TOPICO_ARN } } }] };
  process.stdout.write(JSON.stringify({ Policy: JSON.stringify(pol) }));
' >"$TMP/atributos-fila.json"
aws sqs set-queue-attributes --queue-url "$FILA_URL" --attributes "file://$TMP/atributos-fila.json"

# Filtro no corpo: só eventos do KMS com as ações da regra (a fila não recebe os demais alertas).
node -e '
  const filtro = { source: ["aws.kms"],
    detail: { eventName: ["PutKeyPolicy", "ScheduleKeyDeletion", "DisableKey", "CreateGrant"] } };
  process.stdout.write(JSON.stringify({ FilterPolicyScope: "MessageBody", FilterPolicy: JSON.stringify(filtro) }));
' >"$TMP/atributos-assinatura.json"
ASSINATURA_ARN=$(aws sns subscribe --topic-arn "$TOPICO_ARN" --protocol sqs \
  --notification-endpoint "$FILA_ARN" --return-subscription-arn \
  --attributes "file://$TMP/atributos-assinatura.json" \
  --query SubscriptionArn --output text)

# Na mesma conta a assinatura costuma nascer confirmada. Se ficar pendente, confirma com o token
# que o SNS manda para a própria fila.
for _ in $(seq 1 12); do
  PENDENTE=$(aws sns get-subscription-attributes --subscription-arn "$ASSINATURA_ARN" \
    --query Attributes.PendingConfirmation --output text 2>/dev/null || echo true)
  [ "$PENDENTE" = false ] && break
  TOKEN=$(aws sqs receive-message --queue-url "$FILA_URL" --wait-time-seconds 5 --max-number-of-messages 10 \
    --output json | node -e '
      let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
        const r = s.trim() ? JSON.parse(s) : {};
        for (const m of r.Messages || []) {
          const b = JSON.parse(m.Body);
          if (b.Type === "SubscriptionConfirmation") { process.stdout.write(b.Token); return; }
        }
      });')
  if [ -n "$TOKEN" ]; then
    aws sns confirm-subscription --topic-arn "$TOPICO_ARN" --token "$TOKEN" \
      --query SubscriptionArn --output text >/dev/null
  fi
done
[ "$PENDENTE" = false ] || falhar "a assinatura da fila no tópico não foi confirmada"
# A política de filtro leva até alguns minutos para valer (documentação do SNS).
sleep 60

info "3/6 criando a chave fictícia"
CHAVE_ARN=$(aws kms create-key \
  --description "PROVA K-c5 (chave fictícia, sem dado; exclusão agendada ao fim)" \
  --key-usage ENCRYPT_DECRYPT --key-spec SYMMETRIC_DEFAULT \
  --tags TagKey=purpose,TagValue=prova TagKey=prova,TagValue="$PROVA" \
  --query KeyMetadata.Arn --output text)
CHAVE_ID=${CHAVE_ARN##*/}
info "    chave: $CHAVE_ARN"

info "4/6 provocando DisableKey e PutKeyPolicy"
exigir_tag_prova_kms "$CHAVE_ARN" "$PROVA" || falhar "tag de prova ausente na chave recém-criada"
aws kms get-key-policy --key-id "$CHAVE_ARN" --policy-name default --query Policy --output text >"$TMP/politica.json"
T_DISABLE=$(agora_utc)
aws kms disable-key --key-id "$CHAVE_ARN"
T_PUT=$(agora_utc)
# Reaplica a política padrão que acabou de ler (sem mudança real). Sem bypass do lockout.
aws kms put-key-policy --key-id "$CHAVE_ARN" --policy-name default --policy "file://$TMP/politica.json"

info "5/6 esperando os alertas no tópico (até $PRAZO_MIN min)"
FIM_ESPERA=$(($(date +%s) + PRAZO_MIN * 60))
ACHOU_DISABLE=false
ACHOU_PUT=false
while [ "$(date +%s)" -lt "$FIM_ESPERA" ]; do
  aws sqs receive-message --queue-url "$FILA_URL" --wait-time-seconds 20 --max-number-of-messages 10 \
    --attribute-names SentTimestamp --output json >"$TMP/lote.json"
  # Para cada mensagem: extrai só campos técnicos do evento DESTA chave e lista os receipt handles.
  CHAVE_ARN="$CHAVE_ARN" CHAVE_ID="$CHAVE_ID" TOPICO_ARN="$TOPICO_ARN" node -e '
    const fs = require("node:fs");
    const e = process.env;
    const txt = fs.readFileSync(process.argv[1], "utf8").trim();
    const r = txt ? JSON.parse(txt) : {};
    const saida = [], handles = [];
    for (const m of r.Messages || []) {
      handles.push(m.ReceiptHandle);
      let sns; try { sns = JSON.parse(m.Body); } catch { continue; }
      if (sns.Type !== "Notification") continue;
      let ev; try { ev = JSON.parse(sns.Message); } catch { continue; }
      const d = ev.detail || {};
      const rp = d.requestParameters || {};
      const arns = [...(ev.resources || []), ...((d.resources || []).map((x) => x.ARN))];
      const daChave = rp.keyId === e.CHAVE_ARN || rp.keyId === e.CHAVE_ID || arns.includes(e.CHAVE_ARN);
      if (!daChave) continue;
      saida.push({
        eventName: d.eventName, eventID: d.eventID, eventTime: d.eventTime,
        eventSource: d.eventSource, regiao_do_evento: d.awsRegion, detail_type: ev["detail-type"],
        sns: { topico: sns.TopicArn, message_id: sns.MessageId, timestamp: sns.Timestamp,
               do_topico_de_seguranca: sns.TopicArn === e.TOPICO_ARN },
        recebido_na_fila: m.Attributes && m.Attributes.SentTimestamp
          ? new Date(Number(m.Attributes.SentTimestamp)).toISOString() : null,
      });
    }
    fs.appendFileSync(process.argv[2], saida.map((x) => JSON.stringify(x) + "\n").join(""));
    fs.writeFileSync(process.argv[3], handles.map((h) => h + "\n").join(""));
  ' "$TMP/lote.json" "$EVENTOS" "$TMP/handles.txt"
  while IFS= read -r h; do
    if [ -n "$h" ]; then
      aws sqs delete-message --queue-url "$FILA_URL" --receipt-handle "$h"
    fi
  done <"$TMP/handles.txt"
  grep -q '"eventName":"DisableKey".*"do_topico_de_seguranca":true' "$EVENTOS" && ACHOU_DISABLE=true
  grep -q '"eventName":"PutKeyPolicy".*"do_topico_de_seguranca":true' "$EVENTOS" && ACHOU_PUT=true
  if [ "$ACHOU_DISABLE" = true ] && [ "$ACHOU_PUT" = true ]; then
    break
  fi
done

info "6/6 resultado: DisableKey=$ACHOU_DISABLE PutKeyPolicy=$ACHOU_PUT"
if [ "$ACHOU_DISABLE" = true ] && [ "$ACHOU_PUT" = true ]; then
  APROVADA=true
else
  falhar "alerta não chegou em $PRAZO_MIN min (DisableKey=$ACHOU_DISABLE, PutKeyPolicy=$ACHOU_PUT)"
fi
