# Runbook: primeiro dia do staging

Ordem do primeiro dia do staging, do plano verde até as provas que o Guardião exige antes do piloto (K-c3 de integração e K-c5). Base: [infra-staging.md](infra-staging.md) §3 e §4.5, parecer [`revisoes/2026-10-25-pr76.md`](../03-seguranca-lgpd/revisoes/2026-10-25-pr76.md), conferências de 27/10.

> ⚠️ Staging só recebe **dado fictício**. Nenhum dado real de paciente entra antes do piloto, e o piloto continua bloqueado até a K-c3 e a K-c5 aprovadas **e** a D4.
> ⚠️ Mudança em produção exige aprovação dos sócios. O staging também é aplicado com **um sócio acompanhando**.

**Quem faz o quê**

| Papel | Responsabilidade no dia |
|---|---|
| **devops-ci** (executor) | roda os comandos, guarda as saídas, abre o PR com a evidência |
| **Sócio** (N0) | acompanha o `plan`/`apply`, aprova o apply, preenche os segredos que dependem de conta externa |
| **Guardião LGPD** (N1) | confere a evidência das provas e registra o resultado no parecer (é ele quem escreve o novo item) |
| **ENG** (N2) | só se o boot falhar por outro motivo que não a D4 |

Todo comando abaixo roda com **SSO de curta duração e MFA** na conta de staging, em `sa-east-1`. Nunca chave de acesso de longa duração, e nenhuma credencial vai para o git, para o chat ou para arquivo versionado.

---

## 0. Pré-requisitos (antes de marcar o dia)

| # | Item | Quem confere |
|---|---|---|
| 0.1 | **CI verde** no PR #58 (`infra.yml`: `fmt`, `validate`, `tflint`, `checkov`, travas do projeto e travas dos scripts de prova). Hoje o Actions está parado por cobrança: **sem CI verde, não há dia 1** | devops-ci |
| 0.2 | **C1-a:** plano verde no CI (parecer do #76). Sem plano verde, não aplicar | devops-ci + Guardião |
| 0.3 | #73 (API: K-c2, cursor v2, KMS por clínica) e #76 com merge na `main`, e a imagem da API publicada no ECR com o SHA de 40 caracteres | devops-ci |
| 0.4 | Conta de staging no AWS Organizations, SSO com MFA (I1); certificado ACM (I10) | sócios |
| 0.5 | Na máquina de quem roda: AWS CLI v2, Terraform 1.16.5, node 22+, `pnpm install` na raiz (as provas usam o pacote `typescript` para ler a política do código da API) | devops-ci |
| 0.6 | Aviso a quem assina `alertas_seguranca`: o dia gera alertas **esperados** (DDL das migrações, `ScheduleKeyDeletion`, `DisableKey` e `PutKeyPolicy` das provas) | devops-ci |

## 1. Estado e plano (devops-ci, com um sócio)

Igual à §3 de `infra-staging.md`, passos 2 a 4:

```bash
export AWS_PROFILE=<perfil-sso-staging> && aws sso login
terraform -chdir=infra/terraform/bootstrap-state init
terraform -chdir=infra/terraform/bootstrap-state apply -var conta_aws_id=<id>   # uma vez só
# backend.hcl e staging.tfvars ficam FORA do git (.gitignore)
cd infra/terraform/staging
terraform init -backend-config=backend.hcl
terraform plan -var-file=staging.tfvars -out=plano
```

O sócio revisa o plano junto, olhando em especial:
- `aws_s3_bucket_object_lock_configuration` (o modo COMPLIANCE não se desfaz);
- nada fora de `sa-east-1`;
- nenhum segredo em texto no plano (os segredos são write-only).

## 2. Apply (devops-ci, com aprovação do sócio)

```bash
terraform apply plano
terraform output        # guardar fora do git: só ARNs e nomes, nenhum segredo
```

## 3. Segredos preenchidos fora do git (devops-ci e sócio)

- `DATABASE_URL`, `REDIS_URL`, `PAGINATION_CURSOR_KEY` e `RATE_LIMIT_HASH_KEY` nascem do próprio apply (efêmeros e write-only). **Não há nada para digitar.**
- WhatsApp fica desligado (`whatsapp_provedor = "desligado"`). Se um dia for ligado, o sócio gera os tokens no painel da Meta e grava com `aws secretsmanager put-secret-value`, no terminal, nunca em arquivo (§4.5).
- Assinatura de e-mail do `alerta_seguranca_email`: quem recebe confirma o e-mail do SNS.

## 4. Banco: bootstrap e migrações (devops-ci)

1. Confirmar que a instância RDS já reiniciou com o parameter group (`pgaudit` só vale depois do reboot).
2. Rodar `infra/rds/bootstrap.sh` de dentro da VPC (tarefa ECS avulsa ou SSM), com papel de máquina (§3, passo 6). Se for manual, só pelo `break-glass`, que gera alerta.
3. Rodar as migrações (`pnpm --filter api db:migrate`) na mesma tarefa avulsa, como `app_migrator`, com TLS `verify-full`.
4. O alarme `*-ddl-sensivel` **vai disparar**: é o esperado. Responder no alerta com o SHA das migrações e fazer a conferência pós-deploy com `verificar-guardas.sh` (`infra-staging.md`, seção do pgaudit, passos 2 a 4). Uma diferença no `comparar` é incidente: chamar o Guardião.

## 5. Subir a API e fazer o smoke (devops-ci)

```bash
aws ecs update-service --cluster <cluster> --service api --force-new-deployment
aws logs tail <log-group-da-api> --since 10m
```

**Resultado esperado hoje: a API NÃO sobe, e só por causa da D4.** Com `NODE_ENV=production`, o boot falha fechado em `createAuthProvider` e `createPortalAuthProvider`/`createPortalOtpSender`, porque ainda não existe provedor real de login nem de OTP (§4.5, "Bloqueios do boot").

| Situação no log | Leitura | Ação |
|---|---|---|
| Erro só do provedor de autenticação ou de OTP (D4) | **esperado** | anotar o trecho do erro (sem dado pessoal) e seguir |
| Falta de variável, segredo ilegível, `AWS_REGION` errada, falha de KMS, TLS do RDS/Redis | **não esperado** | parar e acionar a ENG (e o devops-ci, se for ambiente) |
| A API sobe | **não esperado** (alguém ligou um provedor de dev?) | parar e acionar o Guardião |

- `/health` pelo ALB: com a tarefa caindo no boot, o alvo fica `unhealthy` (esperado enquanto houver a D4). Quando a D4 estiver resolvida, `/health` deve responder 200 e `/health/ready` deve mostrar `jobs=bullmq`.
- Para não deixar a tarefa em ciclo de reinício o dia inteiro, depois de anotar o erro: `aws ecs update-service --cluster <cluster> --service api --desired-count 0`. Isso gera desvio do Terraform, que é desfeito no próximo apply.

As provas abaixo **não dependem da API rodando**: elas criam a chave pelo mesmo formato da API.

## 6. As duas provas (devops-ci roda; Guardião confere)

Os dois scripts ficam em `infra/scripts/staging/`, usam a região fixa `sa-east-1`, recusam rodar fora da conta de staging (`CONTA_STAGING`), criam só recursos com a tag `prova=kc3`/`prova=kc5` e **limpam sempre** ao final (`trap`): a chave tem a exclusão agendada com 7 dias (o mínimo do KMS), e o papel, a fila e a assinatura são apagados. Nunca tocam uma chave sem a tag de prova. A evidência sai em JSON, sem dado pessoal.

### 6.1 K-c3 de integração: a chave da clínica só abre com o contexto certo

```bash
CONTA_STAGING=<id> EVIDENCIA_DIR=/tmp/evidencias \
  KMS_PAPEIS_HUMANOS_EXTRA="<mesmo valor da tarefa da API; omitir se papeis_humanos_extra = []>" \
  infra/scripts/staging/prova-kc3.sh
```

- **Quem roda: a sessão SSO do operador.** O script confere que o principal em uso é um papel `role/aws-reserved/sso.amazonaws.com/*` (`AWSReservedSSO_*`) da conta de staging e **recusa rodar** com qualquer outro (usuário IAM, papel comum, chave de longa duração), antes de criar qualquer recurso. Na evidência vai só o ARN do papel do permission set, nunca o nome da sessão (que pode ter e-mail).
- **A política vem do código da API.** `politica-kc3.mjs` lê `apps/api/src/modules/crypto/kms-key-provider.ts`, separa pela AST do TypeScript a função `politicaDaChaveDaClinica`, a `papeisHumanosExtraDoAmbiente` e as constantes de que elas dependem, tira os tipos e a executa. Assim, a prova usa o JSON que a API passa no `CreateKey`, não uma cópia. Rode de um checkout com o #73 na `main`, ou aponte `KMS_PROVIDER_TS=<caminho do arquivo>`. O arquivo tem de estar **versionado num checkout git limpo** (nenhuma mudança em arquivo versionado): senão o script recusa. A evidência traz o caminho, o SHA-256 do arquivo, o **commit** (`git rev-parse HEAD` desse checkout) e se ele já está na `origin/main` local (faça `git fetch` antes).
- **Política efetiva = política gerada.** Logo depois do `CreateKey`, o script lê `aws kms get-key-policy` da chave de prova e compara o SHA-256 do JSON canonicalizado (chaves ordenadas, sem espaços) com o da política gerada. Diferença reprova. Os dois hashes vão em `politica_efetiva`.
- **Política aplicada** (formato da K-c2, com conta e tenant da prova): o statement padrão da conta (`kms:*` para `arn:aws:iam::<conta>:root`), mais `Deny` para `"*"` em `kms:Encrypt`, `kms:Decrypt`, `kms:ReEncrypt*` e `kms:GenerateDataKey*` quando `kms:EncryptionContext:tenant_id` está ausente (`Null`) ou é diferente do tenant da chave (`StringNotEquals`). E, desde o #73 `15e3303` (R4 do #58), o `HumanoNaoDecifra`: `Deny` de `kms:Decrypt` e `kms:ReEncrypt*` quando `aws:PrincipalArn` casa (`ArnLike`) com SSO, usuário IAM, root ou um dos extras (`KMS_PAPEIS_HUMANOS_EXTRA`, lida e validada pelo código da API).
- **Os principais com `kms:*` no IAM** são dois papéis temporários, com `kms:*` na chave de prova, que só o operador pode assumir: o de máquina (`prova-kc3-<id>`) e o "humano" (`prova-kc3-h-<id>`), cujo ARN exato entra na política como padrão humano extra de prova, depois dos extras reais. Nenhum extra real pode casar com `role/prova-kc3-*`, senão P2 cai.
- **Casos:** primeiro os positivos, P1 (`GenerateDataKey`) e P2 (`Decrypt`) com o `tenant_id` da chave, que provam que o IAM do papel já vale. Depois, nove negativos (N1 a N9): `GenerateDataKey`, `GenerateDataKeyWithoutPlaintext`, `Decrypt`, `Encrypt` e `ReEncrypt`, sem contexto ou com o `tenant_id` de outra clínica. Todos têm de dar `AccessDeniedException`. Um `InvalidCiphertextException` reprova: significa que o KMS deixou passar e só a criptografia barrou. Por fim, o R4 com o contexto **certo**: H0 (`GenerateDataKeyWithoutPlaintext` pelo papel humano, positivo, prova que o IAM dele vale), os negativos H1 (`Decrypt`) e H2 (`ReEncrypt`) pelo papel humano (caminho dos extras) e **H3** (`Decrypt`) pela **própria sessão SSO do operador** (caminho do padrão fixo `role/aws-reserved/sso.amazonaws.com/*`, o de verdade dos humanos).
- **H1, H2 e H3 exigem a negação explícita da key policy.** Não basta `AccessDeniedException`: a mensagem tem de citar `explicit deny in a resource-based policy` (variações aceitas: "with an …"/"because of an …", com ou sem artigo). Sem ela, a falta de `kms:Decrypt` no permission set explicaria a negação e o caso **reprova**. Não valem "explicit deny in an identity-based policy", "… in a service control policy", "… in a session policy", "… in a permissions boundary" nem o formato antigo sem o tipo de política. Se a AWS responder num formato fora da lista, o caso reprova e o Guardião decide. Para N1 a N9, `negacao_explicita_em_politica_de_recurso` segue informativo.
- **Aprovada** quando P1, P2, N1 a N9, H0 a H3 batem com o esperado, a política efetiva é igual à gerada, a limpeza não tem `FALHOU`/`RECUSADO` e a releitura do JSON passa (§6.3).

### 6.2 K-c5: o alerta de administração da chave chega ao tópico de segurança

```bash
CONTA_STAGING=<id> EVIDENCIA_DIR=/tmp/evidencias infra/scripts/staging/prova-kc5.sh
```

- Confere que a regra `plataforma-saude-staging-kms-administracao` está `ENABLED` e aponta para o tópico `alertas-seguranca`.
- Cria uma fila SQS temporária que só aceita o tópico, assina a fila no tópico com filtro (só eventos `aws.kms` das quatro ações da regra), cria uma chave fictícia e provoca **`DisableKey`** e **`PutKeyPolicy`** (reaplica a mesma política padrão, sem mudança real).
- Espera até 20 min (`PRAZO_MIN`): o caminho CloudTrail → EventBridge → SNS leva alguns minutos.
- **Aprovada** quando os dois eventos dessa chave chegam pela fila com `TopicArn` igual ao tópico de segurança, a limpeza não tem `FALHOU`/`RECUSADO` e a releitura do JSON passa (§6.3). O bloco `eventos` traz, para `DisableKey` e `PutKeyPolicy`: o horário da ação (`acao_provocada_em`), o `eventID` e o `eventTime` do CloudTrail, o `MessageId` e o `Timestamp` do SNS e o horário de chegada na fila. Não grava `userIdentity`, IP nem user agent, porque o nome da sessão do SSO pode conter e-mail.
- **Canal humano (condição 4): o operador anota o horário do e-mail.** Quem assina o tópico por e-mail recebe os alertas. Quando os dois chegarem, o operador pega o horário de cada um no cabeçalho do e-mail, converte para UTC e roda (não fala com a AWS, só preenche `eventos.<ação>.email_recebido_em` e relê o JSON):

  ```bash
  infra/scripts/staging/prova-kc5.sh --anotar-email /tmp/evidencias/prova-kc5-<data>.json \
    <AAAA-MM-DDTHH:MM:SSZ do DisableKey> <AAAA-MM-DDTHH:MM:SSZ do PutKeyPolicy>
  ```

  O script recusa horário em outro formato ou anterior à própria ação. Sem o e-mail anotado, a K-c5 fica com a condição 4 pendente (o e-mail do assinante nunca entra no JSON, só o horário).

### 6.3 Se uma prova reprovar

- **Não repetir até passar.** A evidência reprovada também vai para o Guardião.
- K-c3 reprovada: o piloto continua bloqueado. A ENG revê `politicaDaChaveDaClinica`, e o Guardião decide o próximo passo.
- K-c5 reprovada: conferir com `aws events describe-rule`, a política do tópico (`aws:SourceArn`) e a key policy da chave `alertas` (o EventBridge precisa poder cifrar no tópico). Corrigir no Terraform, com novo plano e apply.
- Se a limpeza falhar (o log mostra `FALHOU`), apagar à mão o que ficou: agendar a exclusão da chave com 7 dias, apagar o papel, a fila e a assinatura. Conferir antes a tag `prova`. **A prova sai reprovada** (`aprovada = false`, motivo em `evidencia_reprovada_por`) mesmo com todos os casos certos; registrar a limpeza manual junto da evidência para o Guardião.
- **Releitura automática da evidência.** Ao fim, os dois scripts releem o JSON gravado. Se acharem e-mail, token de sessão, AccessKeyId ou IP, trocam o valor por `[REMOVIDO:<tipo>]`, marcam `aprovada = false` e dizem o motivo em `evidencia_reprovada_por`. A reprovação **também é evidência**: anexar do mesmo jeito (§7), sem repetir a prova até passar.

### 6.4 Passo pendente: condição 3 (depois da D4, antes do piloto)

> ⏳ **Pendente.** A K-c3 deste kit prova o **formato** da key policy (gerada pelo código da API), não que a imagem da API que roda em staging usa esse formato.

Quando a D4 estiver feita e a API estiver de pé em staging:

1. Criar **pela própria API** uma clínica fictícia (staging só tem dado fictício) e anotar o `tenant_id` dela.
2. Achar a chave dessa clínica pela tag (`aws kms list-resource-tags` com `tenant_id=<tenant fictício>`) e ler a política: `aws kms get-key-policy --key-id <chave> --policy-name default --query Policy --output text`.
3. Conferir que ela contém o `HumanoNaoDecifra` (com os 3 padrões fixos e os extras de `KMS_PAPEIS_HUMANOS_EXTRA`) e os dois `Deny` de contexto (`NegarSemContextoDaClinica` e `NegarContextoDeOutraClinica`) com o **tenant literal** da clínica.
4. Registrar na evidência só o **SHA-256 do JSON canonicalizado** dessa política (mesmo método da §6.1, `sha256_json_canonico` de `comum.sh`) e a **lista de `Sid`**. Nada de nome, e-mail ou dado da clínica.
5. Anexar como na §7. O Guardião registra no parecer. Sem este passo, o piloto segue bloqueado.

## 7. Onde anexar a evidência (devops-ci → Guardião)

1. O devops-ci abre um PR curto `devops/evidencias-staging-kc3-kc5` com os dois JSON em `docs/03-seguranca-lgpd/evidencias/` (são só ids técnicos, UUIDs fictícios e códigos de erro). Antes do commit, reler os arquivos para confirmar que não há e-mail, nome nem IP.
2. O **Guardião** confere a evidência e escreve **o novo item no parecer** `revisoes/2026-10-25-pr76.md` ("Prova K-c3 de integração e K-c5 em staging"), com o resultado e o link para os JSON. Só o Guardião registra a aprovação; o devops-ci não edita o parecer.
3. O piloto continua bloqueado até esse item aprovado, a D4 **e** a condição 3 (§6.4).

## 8. Rollback

| O que deu errado | Como voltar | Quem |
|---|---|---|
| Plano inesperado | não aplicar; corrigir no PR e gerar novo plano | devops-ci |
| Apply parcial ou com erro | corrigir e reaplicar (`terraform apply` é idempotente). Para desmontar: `terraform destroy -var-file=staging.tfvars`, **exceto** o bucket com Object Lock COMPLIANCE, que não se apaga antes do prazo (está no custo) | devops-ci, com sócio |
| Migração com problema | staging não tem dado real: recriar o banco a partir do snapshot inicial ou de um RDS novo, refazer o bootstrap e as migrações. Nunca editar o catálogo à mão | devops-ci + ENG |
| Deploy da API ruim | `aws ecs update-service ... --desired-count 0`, ou voltar `api_imagem_tag` para o SHA anterior e aplicar | devops-ci |
| Chave de prova esquecida | `aws kms schedule-key-deletion --pending-window-in-days 7` só depois de confirmar a tag `prova` | devops-ci |
| Suspeita de vazamento de segredo | rotacionar na hora (§3 de `infra-staging.md`, "Rotação") e avisar o Guardião | devops-ci + Guardião |

## 9. Ponto encontrado ao escrever este runbook (resolvido)

> ✅ **Resolvido no #73, commit `15e3303`:** a `politicaDaChaveDaClinica` passou a incluir o `HumanoNaoDecifra` na key policy de cada chave de clínica e de lote, com os 3 padrões fixos + `KMS_PAPEIS_HUMANOS_EXTRA`. O Terraform injeta essa variável na tarefa da API quando `papeis_humanos_extra` não é vazio, o CI compara os padrões fixos dos dois lados e a K-c3 prova o `Deny` com H0 a H3 (§6.1; H3 pela sessão SSO real, desde 27/10). Texto original abaixo, para histórico.

~~O comentário de `kms.tf` e o output `kms_deny_humanos` dizem que o `KmsKeyProvider` inclui o statement `HumanoNaoDecifra` (R4 do #58) na key policy de cada KEK de clínica. A `politicaDaChaveDaClinica` do #73 **não** inclui esse statement: tem só o da conta e os dois `Deny` de contexto. A K-c3 prova o que a API faz hoje. Fica para a ENG e o Guardião decidir se o `Deny` de humanos entra na política da API ou se o comentário do Terraform deve ser corrigido.~~
