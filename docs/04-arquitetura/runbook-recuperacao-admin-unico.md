# Runbook: recuperação do fator do admin único pelo suporte (B12)

> Desenho: [recuperacao-do-admin-unico.md](recuperacao-do-admin-unico.md). Pareceres do Guardião: `docs/03-seguranca-lgpd/revisoes/2026-11-16-desenho-recuperacao-do-admin-unico.md` (R1 a R10) e `2026-11-17-codigo-infra-ops-provisionamento.md` (C1 a C3). Código: `apps/api/src/ops/recuperar-admin-unico.ts`, `apps/api/src/ops/parametros-ssm.ts`, `apps/api/src/modules/auth/better-auth/recuperacao-pelo-suporte.ts`, migração `0077`. Terraform: `infra/terraform/staging/ops-recuperacao.tf`.

**Quando usar:** o **único** admin de uma clínica perdeu o segundo fator (TOTP) e **ainda sabe a senha**. Só o fator volta: o token exige a senha atual no uso.

**Quando NÃO usar (recuse e encerre o chamado):**
- Há outro admin ativo com fator na clínica: ele emite a recuperação pelo app (#159). O comando recusa com `ha_outro_admin`.
- A pessoa perdeu **senha e fator**: a recuperação completa é **vetada**. O caminho é a conta nova pelo provisionamento (B13).
- Quem pede **não é o titular da conta** (o admin saiu, faleceu ou não responde): isso é troca de admin pela clínica, pelo provisionamento (R9).

## Pré-requisitos (uma vez por ambiente)

- `endpoint_ssm = true` no tfvars do ambiente (#204). Sem o endpoint, a tarefa não alcança o SSM e falha fechado.
- Listas `principais_ops_recuperacao_executor` e `principais_ops_recuperacao_entrega` preenchidas e **disjuntas** (a precondição do Terraform recusa a mesma pessoa nas duas).
- A definição da tarefa traz `SSM_KMS_KEY_ID` (chave `ops-recuperacao`) e `AWS_REGION=sa-east-1`. Sem elas a saída é `ssm_nao_configurado`.

## Quem faz (duas pessoas, R6 e C1)

| Papel | Papel AWS | O quê |
|---|---|---|
| **DPO** (ou quem ele designar) | nenhum | confere a identidade do titular, decide se cabe, consulta o log de segurança |
| **Executor** | `<ambiente>-ops-recuperacao-executor` | roda a tarefa avulsa do ECS. **Não** lê nem grava a entrega (Deny no IAM e na key policy). |
| **Entregador** (outra pessoa, nunca o executor) | `<ambiente>-ops-recuperacao-entrega` | lê o parâmetro do SSM **uma vez**, entrega o token ao titular e apaga o parâmetro. **Não** roda a tarefa e não grava nada. |

Os ARNs vêm do output `papeis_ops_recuperacao` (`terraform output papeis_ops_recuperacao`). Os dois nomes (executor e entregador) vão no chamado.

## Chamado `SUP-<número>`

Só ids, datas e nomes de quem executou e entregou. Registra: tipo de documento conferido (**sem número**), hora da ligação de retorno, resultado da consulta do log de segurança, motivo (lista fechada) e se as sessões foram derrubadas. **Nunca** cópia de documento, nome do titular ou e-mail.

## Conferência de identidade (R1 e R3 do parecer)

1. **A pessoa conferida é o titular da conta**: o nome no documento é o nome da conta. O documento é **só exibido**, nunca copiado (RIPD §5 item 1). Se o titular não é o signatário do contrato, o signatário confirma também, pelo canal do contrato.
2. **Ligação de retorno** só para o telefone do contrato cadastrado **antes** do chamado. Pedido para mudar o contato do contrato no mesmo chamado, ou nos 30 dias anteriores, **suspende** a recuperação até revisão do DPO.
3. **Log de segurança da conta, últimos 7 dias**: `LOGIN_FALHOU`, `MFA_FALHOU`, `MFA_BLOQUEADO`, origens novas. Sinal de ataque: **para** e o caso vai ao DPO.
4. **Roteiro de recusa à pressão** ("é urgente", "sou o dono", "o médico está esperando"): a resposta é o prazo do procedimento, sem exceção. Não há break-glass.

## Motivo e sessões (R5)

`--motivo` da lista fechada: `perdeu_o_aparelho`, `troca_de_aparelho`, `suspeita_de_invasao` ou `conta_bloqueada`. `--derrubar-sessoes` é **obrigatório** em todo motivo, menos `troca_de_aparelho` (C1 do parecer de 17/11): aparelho perdido, conta bloqueada ou suspeita de invasão podem deixar sessão aberta na mão de terceiro. O comando recusa sem ele.

## Rodar

Tarefa avulsa do ECS, definição própria só com `app_auth` e `app_user` (sem `BETTER_AUTH_SECRET`). O executor assume o papel `ops-recuperacao-executor` com MFA e `--source-identity <seu usuário>` (sessão de 1 h; sem MFA ou fora de `sa-east-1`, nada roda):

```bash
aws sts assume-role --role-arn <arn do papel ops-recuperacao-executor> --role-session-name SUP-<n> \
  --source-identity <seu usuário> --serial-number <arn do seu MFA> --token-code <código>
```

O override leva **só** uuids, o chamado e o motivo; a única variável é a trava. Cluster, sub-redes e grupo de segurança vêm do output `ops_recuperacao_rede`; a definição, de `ops_recuperacao_task_definition`. A tarefa tem **rede própria**; não use a rede da API. Cada execução gera alerta; variável além da trava, troca de papel ou ECS Exec gera alerta **crítico**.

```bash
aws ecs run-task --cluster <cluster> --task-definition <ops_recuperacao_task_definition> --launch-type FARGATE \
  --network-configuration 'awsvpcConfiguration={subnets=[<subnets>],securityGroups=[<security_group>],assignPublicIp=DISABLED}' \
  --overrides '{"containerOverrides":[{"name":"ops-recuperacao","command":["--clinica","<uuid>","--usuario","<uuid>","--chamado","SUP-<n>","--operador","<uuid do executor>","--motivo","perdeu_o_aparelho"],"environment":[{"name":"CONFIRMA_RECUPERACAO","value":"<uuid do usuário>"}]}]}'
```

**Saída** (uma linha): `ok <usuario> expira=<data> sessoes=<n>` ou um código fixo: `ha_outro_admin`, `nao_e_admin`, `conta_inativa`, `clinica_nao_encontrada`, `teto`, `chamado_invalido`, `motivo_invalido`, `derrubar_sessoes_obrigatorio`, `trava_incorreta`, `uso_incorreto`, `entrega_pendente`, `ssm_nao_configurado`, `erro`. Código diferente de 0 na falha.

- `entrega_pendente`: a entrega de uma rodada anterior ainda está no SSM e nunca é sobrescrita; esta rodada foi desfeita (não consome o teto nem invalida o token anterior). **Decida pelo log da rodada anterior** (C1 do parecer 2026-11-17-codigo-cliente-ssm):
  - **Há `RECUPERACAO_PELO_SUPORTE` da rodada anterior para este chamado:** o token pendente é válido. **Não rode de novo** (a nova rodada sairia `teto` ou gastaria a 2ª emissão do ano). O **entregador** retira e entrega normalmente, pelo passo de entrega.
  - **Não há o evento** (a rodada anterior falhou depois de gravar): o **entregador** apaga `/recuperacao-suporte/<usuario>/entrega` **sem ler** e o executor roda de novo (a emissão nova invalida qualquer pendente, R4).
- `erro`: banco ou SSM fora. Se a entrega chegou a ser gravada, o comando a apagou. Rode de novo.
- `ssm_nao_configurado`: falta `SSM_KMS_KEY_ID`/`AWS_REGION` na definição ou há variável AWS proibida. É problema de infra; não insista.

**Teto:** uma por clínica a cada 30 dias e duas por pessoa em 12 meses. Acima disso, revisão manual pelo DPO e pelos dois sócios, registrada no chamado com os três nomes (o comando ainda não aceita exceção).

## Entregar

1. O token fica no SecureString `/recuperacao-suporte/<usuario>/entrega` (chave KMS própria `ops-recuperacao`, camada Advanced) e vale **24 h**. O SSM apaga o parâmetro sozinho no vencimento (política `Expiration` gravada pela tarefa, C2).
2. O **entregador** assume o papel `ops-recuperacao-entrega` e lê o parâmetro uma vez, sem gravar em arquivo, nota ou mensagem:

   ```bash
   aws sts assume-role --role-arn <arn do papel ops-recuperacao-entrega> --role-session-name SUP-<n> \
     --source-identity <seu usuário> --serial-number <arn do seu MFA> --token-code <código>
   aws ssm get-parameter --name /recuperacao-suporte/<usuario>/entrega --with-decryption --query Parameter.Value --output text
   aws ssm delete-parameter --name /recuperacao-suporte/<usuario>/entrega
   ```

   Entrega o token e entrega o token **só ao titular**: pela ligação de retorno (telefone do contrato) ou por vídeo com o titular presente. **Nunca** por e-mail, mensagem ou número informado no pedido.
3. Apaga o parâmetro logo depois (o `delete-parameter` acima). Se a tarefa falhou depois de gravar, o próprio comando já o apagou. Toda leitura e todo apagamento geram alerta (`<ambiente>-ops-recuperacao-entrega`).
4. Aviso ao signatário pelo canal do contrato: "recuperação de fator emitida, chamado SUP-<n>; se não reconhece, responda" (R8).

**No uso**, o titular entra em `POST /recuperacao/usar` com o token e a senha atual. O TOTP antigo sai, as sessões caem e uma sessão de cadastro de 15 min serve só para cadastrar o TOTP novo. Se a pessoa deixou de ser admin ativo entre a emissão e o uso, o token não vale.

## Prova (R6)

- **Trilha da clínica:** `credential_recovery_issued` com ator **sistema** e `{ op, user_id, kind: 'fator', reason, via: 'suporte', ticket }`. Nunca o operador.
- **Log de segurança:** `RECUPERACAO_PELO_SUPORTE` na emissão (alarme imediato, com operador e chamado) e `RECUPERACAO_USADA` com `motivo: recuperacao_pelo_suporte` no uso.
- **CloudTrail:** o `RunTask` com o principal `ops-recuperacao-executor` e o `GetParameter`/`DeleteParameter` de `*/entrega` com o principal `ops-recuperacao-entrega`. Os dois `SourceIdentity` **têm de ser diferentes** e bater com os nomes do chamado. Se não baterem, ou se disparar o alerta crítico de override: não entregue, o entregador apaga a entrega, e o caso vai ao Guardião e ao DPO com o alerta, a hora e os dois `SourceIdentity` no chamado.

## Custo do SSM (ESTIMATIVA)

Parâmetro Advanced: da ordem de US$ 0,05 por parâmetro por mês, rateado pelas horas em que existe, mais US$ 0,05 por 10 mil chamadas. A entrega vive no máximo 24 h: menos de US$ 0,01 por recuperação. O endpoint `ssm` da VPC custa à parte (comentário em `rede.tf`). As chaves KMS do provisionamento e da recuperação (uma por fluxo, `kms.tf` do #204) custam cerca de US$ 1 por chave por mês, mais as chamadas. Conferir nas páginas de preços do AWS Systems Manager e do KMS para sa-east-1.
