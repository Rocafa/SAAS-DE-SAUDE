# Runbook: provisionamento da clínica e entrega do token do fundador (B11)

> Desenho: [provisionamento-da-clinica.md](provisionamento-da-clinica.md). Pareceres do Guardião: `docs/03-seguranca-lgpd/revisoes/2026-11-16-desenho-provisionamento-da-clinica.md` (R1 a R10), `2026-11-16-codigo-provisionamento-pr1.md` (C1 a C4), `2026-11-17-codigo-ativacao-do-fundador.md` e `2026-11-17-codigo-infra-ops-provisionamento.md` (C1 a C3). Código: `apps/api/src/ops/provisionar-clinica.ts`, `apps/api/src/ops/parametros-ssm.ts`, `apps/api/src/modules/auth/better-auth/provisionamento.ts`. Terraform: `infra/terraform/staging/ops-provisionamento.tf`.

**Quando usar:** contrato `CTR-<número>` assinado, clínica nova, fundador conhecido. A tarefa cria a clínica, o vínculo de admin do fundador (bloqueado até a ativação) e um token de ativação de **72 h**, uso único.

**Quando NÃO usar:**
- A clínica já foi ativada: depois da ativação não há reemissão. Repetir o pedido dá `ja_provisionado`.
- Troca de admin de clínica que já existe: é outro procedimento, com o signatário do contrato.
- O admin único perdeu o fator: é a recuperação ([runbook-recuperacao-admin-unico.md](runbook-recuperacao-admin-unico.md)).

## Pré-requisitos (uma vez por ambiente)

- `endpoint_ssm = true` no tfvars do ambiente (#204). Sem o endpoint, a tarefa não alcança o SSM e falha fechado.
- Listas `principais_ops_provisionamento_executor` e `principais_ops_provisionamento_entrega` preenchidas, **disjuntas** (a precondição do Terraform recusa a mesma pessoa nas duas).
- A definição da tarefa traz `SSM_KMS_KEY_ID` (chave `ops-provisionamento`) e `AWS_REGION=sa-east-1`. Sem elas a saída é `ssm_nao_configurado`.

## Quem faz (duas pessoas, R3 e C1)

| Papel | Papel AWS | O quê |
|---|---|---|
| **Executor** | `<ambiente>-ops-provisionamento-executor` | cria o pedido no SSM, roda a tarefa, confere a saída. **Não** lê a entrega (Deny no IAM e na key policy). |
| **Entregador** (outra pessoa) | `<ambiente>-ops-provisionamento-entrega` | lê a entrega **uma vez**, entrega o token ao fundador fora de banda e apaga. **Não** roda a tarefa e não grava nada. |

Os ARNs vêm do output `papeis_ops_provisionamento` (`terraform output papeis_ops_provisionamento`). Os dois nomes vão no chamado.

## Chamado `CTR-<número>`

Só ids, datas e nomes de quem executou e entregou: o uuid do pedido, o uuid da clínica da saída, o `SourceIdentity` de cada um e a hora da entrega. **Nunca** o e-mail do fundador, o nome da clínica ou o token.

## 1. Assumir o papel (executor)

```bash
aws sts assume-role --role-arn <arn do papel ops-provisionamento-executor> --role-session-name CTR-<n> \
  --source-identity <seu usuário> --serial-number <arn do seu MFA> --token-code <código>
```

A sessão dura 1 h. Sem MFA, nada roda (Deny `SemMfaNada`). Fora de `sa-east-1`, nada roda (`SomenteSaoPaulo`).

## 2. Criar o pedido (executor)

Gere um uuid novo para o pedido (`uuidgen | tr A-Z a-z`). O pedido é SecureString com a chave **própria** do fluxo, camada Advanced e **vencimento de 72 h** (C2): se a tarefa não rodar, o e-mail some sozinho.

```bash
VENCE=$(date -u -d '+72 hours' +%Y-%m-%dT%H:%M:%S.000Z)
aws ssm put-parameter --name /provisionamento/<pedido> --type SecureString \
  --key-id alias/<ambiente>-ops-provisionamento --tier Advanced --no-overwrite \
  --policies "[{\"Type\":\"Expiration\",\"Version\":\"1.0\",\"Attributes\":{\"Timestamp\":\"$VENCE\"}}]" \
  --value file://pedido.json
```

`pedido.json` tem **só** `{"email": "...", "clinica": "..."}` e é apagado do disco logo depois (`shred -u pedido.json`). Nunca passe o e-mail em `--value` direto: ele iria para o histórico do shell. Se digitou errado, apague o pedido (`aws ssm delete-parameter --name /provisionamento/<pedido>`) e crie outro com uuid novo.

## 3. Rodar (executor)

O override leva **só** o uuid do pedido e o contrato; a única variável é a trava:

```bash
aws ecs run-task --cluster <cluster> --task-definition <ops_provisionamento_task_definition> --launch-type FARGATE \
  --network-configuration 'awsvpcConfiguration={subnets=[<subnets>],securityGroups=[<security_group>],assignPublicIp=DISABLED}' \
  --overrides '{"containerOverrides":[{"name":"ops-provisionamento","command":["--pedido","<pedido>","--contrato","CTR-<n>"],"environment":[{"name":"CONFIRMA_PROVISIONAMENTO","value":"<pedido>"}]}]}'
```

Cluster, sub-redes e grupo de segurança vêm do output `ops_provisionamento_rede`; a definição, de `ops_provisionamento_task_definition`. A tarefa tem **rede própria** (só o banco e os endpoints da VPC). Não use a rede da API. Cada execução gera alerta no tópico de segurança; variável além da trava, troca de papel ou ECS Exec gera alerta **crítico**.

**Saída** (uma linha, no log `ops-provisionamento/*`): `ok <clinica> <pedido>` ou um código fixo. Código diferente de 0 na falha.

| Código | O que fazer |
|---|---|
| `ok` | Avise o entregador com o uuid do pedido. |
| `parametro_ausente` | O pedido não existe (venceu ou nome errado). Crie de novo (passo 2). |
| `parametro_invalido` | JSON com outra forma, e-mail inválido ou e-mail diferente da conta do fundador já reservada. O pedido **já foi apagado**: crie outro com o JSON certo. |
| `ja_provisionado` | A clínica já tem ativação pendente ou já foi ativada. Pare e confira o chamado. |
| `conta_inativa` | A conta do e-mail está inativa ou anonimizada. Não se reaproveita: o caso vai ao DPO. |
| `entrega_pendente` | Há uma entrega de rodada anterior no SSM, que nunca é sobrescrita. O token dela não vale (a linha desta rodada foi desfeita). O **entregador** apaga `/provisionamento/<pedido>/entrega` **sem ler** e o executor recria o pedido e roda de novo. |
| `erro_parcial_rodar_de_novo` | Banco ou SSM fora. A tarefa é idempotente: recrie o pedido (ele é apagado também na falha) e rode de novo. |
| `trava_incorreta`, `uso_incorreto`, `contrato_invalido` | Override errado. Nada foi lido nem gravado. |
| `ssm_nao_configurado` | Falta `SSM_KMS_KEY_ID`/`AWS_REGION` na definição ou há variável AWS proibida. Infra, não insista. |

## 4. Entregar (entregador, outra pessoa)

```bash
aws sts assume-role --role-arn <arn do papel ops-provisionamento-entrega> --role-session-name CTR-<n> \
  --source-identity <seu usuário> --serial-number <arn do seu MFA> --token-code <código>
aws ssm get-parameter --name /provisionamento/<pedido>/entrega --with-decryption --query Parameter.Value --output text
aws ssm delete-parameter --name /provisionamento/<pedido>/entrega
```

1. Leia **uma vez**, sem gravar em arquivo, nota ou mensagem.
2. Entregue o token ao fundador pelo canal combinado no contrato (ligação para o telefone do contrato ou vídeo). **Nunca** por e-mail em claro junto do link. O token vai no corpo do POST ou no fragmento (`#`) do link de ativação.
3. Apague a entrega logo depois. Se ninguém apagar, o SSM a apaga sozinho em 72 h (política `Expiration`, gravada pela tarefa); toda leitura e todo apagamento geram alerta (`<ambiente>-ops-provisionamento-entrega`).
4. Depois do `FUNDADOR_ATIVADO`, confirme com o fundador fora de banda. **O importador só roda depois dessa confirmação.**

## 5. Conferir no CloudTrail (no chamado)

- `RunTask` da definição `ops-provisionamento`: principal `ops-provisionamento-executor` e `SourceIdentity` = o executor do chamado.
- `GetParameter` e `DeleteParameter` de `*/entrega`: principal `ops-provisionamento-entrega` e `SourceIdentity` = o entregador do chamado.
- Os dois `SourceIdentity` **têm de ser diferentes** e bater com os dois nomes do chamado. Se não baterem, trate como o alerta crítico abaixo.

## Alerta crítico (override suspeito ou entrega lida por quem não está no chamado)

1. Não entregue o token. O entregador apaga a entrega.
2. Avise o Guardião e o DPO; registre no chamado o alerta, a hora e os dois `SourceIdentity`.
3. O token pendente fica inválido quando a ativação for reemitida (só antes da ativação) ou quando vencer em 72 h; se já houve `FUNDADOR_ATIVADO` sem confirmação do fundador, o caso é incidente (`docs/03-seguranca-lgpd/`), e a clínica não recebe importação.

## Prova (R6, R7)

- **Trilha da clínica:** `tenant_create` e `member_found` com ator **sistema** e `{ op, via: 'provisionamento', contract }`; `founder_activated` com o fundador como ator. Nunca o operador.
- **Log de segurança:** `CLINICA_PROVISIONADA`, `ATIVACAO_EMITIDA` (com o pedido) e, na ativação, `FUNDADOR_ATIVADO`.
- **CloudTrail:** o `RunTask` e o `GetParameter` da entrega com os principais nominais.

## Custo do SSM (ESTIMATIVA)

Parâmetro Advanced: da ordem de US$ 0,05 por parâmetro por mês, rateado pelas horas em que existe, mais US$ 0,05 por 10 mil chamadas. Pedido e entrega vivem no máximo 72 h: menos de US$ 0,01 por clínica. O endpoint `ssm` da VPC custa à parte (comentário em `rede.tf`). As chaves KMS do provisionamento e da recuperação (uma por fluxo, `kms.tf` do #204) custam cerca de US$ 1 por chave por mês, mais as chamadas. Conferir nas páginas de preços do AWS Systems Manager e do KMS para sa-east-1 antes do orçamento.
