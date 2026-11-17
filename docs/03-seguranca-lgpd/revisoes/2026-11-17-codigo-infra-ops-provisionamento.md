# Parecer de código: Terraform das tarefas avulsas do provisionamento (B11) e da recuperação do admin único (B12)

> 17/11/2026 · Guardião LGPD & Segurança · PR #204 (`eng/infra-ops-provisionamento`, empilhado sobre `eng/ativacao-do-fundador`).
> Diff conferido: `git diff origin/eng/ativacao-do-fundador...HEAD` em `infra/terraform/staging/` (`ops-provisionamento.tf`, `ops-recuperacao.tf`, `kms.tf`, `rede.tf`, `acesso-humano.tf`, `variables.tf`, `outputs.tf`).
> Base: padrão aprovado do B10 (`ops-anonimizacao.tf` e [`2026-11-12-codigo-anonimizacao-pelo-suporte.md`](2026-11-12-codigo-anonimizacao-pelo-suporte.md), reconferência de 13/11); R3, R7 e R8 de [`2026-11-16-desenho-provisionamento-da-clinica.md`](2026-11-16-desenho-provisionamento-da-clinica.md); C4 de [`2026-11-16-codigo-provisionamento-pr1.md`](2026-11-16-codigo-provisionamento-pr1.md); R4, R6 e R7 de [`2026-11-16-desenho-recuperacao-do-admin-unico.md`](2026-11-16-desenho-recuperacao-do-admin-unico.md); [`2026-11-17-codigo-recuperacao-admin-unico.md`](2026-11-17-codigo-recuperacao-admin-unico.md).

## Veredito: **APROVADO COM RESSALVAS**. O merge está liberado. A primeira execução real (o PR que liga o cliente SSM) fica bloqueada até C1 a C3.

O Terraform segue o B10 em tudo que foi aprovado lá: entryPoint fixo, papéis próprios, papel humano com MFA de menos de 1 h e `SourceIdentity`, lista de principais fora do git, Deny nos papéis de máquina, as duas regras do EventBridge no tópico de alertas e grupo de rede próprio sem entrada. Acrescenta o que o B10 não tinha: uma chave KMS por fluxo, com Deny na key policy para quem não opera, e Deny cruzado no SSM (a tarefa não lê a entrega e o humano não a grava). As duas tarefas continuam falhando fechado (`ssm_nao_configurado`), então nada daqui roda hoje. O que falta é **separar por máquina quem roda de quem entrega** (C1), o **vencimento no parâmetro** (C2) e o **runbook do provisionamento** (C3). Nada disso dá para corrigir no Terraform deste PR sem o cliente SSM, e por isso não bloqueia o merge.

Os checks de Terraform (fmt, validate, tflint e checkov) estão verdes no #204. "Isolamento entre tenants", "Lint, typecheck e testes" e "Carga" estavam pendentes na hora desta revisão, mas este PR não mexe em código da API.

## O que está conforme

| Ponto | Evidência |
|---|---|
| Programa fixo; o override troca só argumentos (R-A do B10) | `ops-provisionamento.tf:78`, `:258-259`; `ops-recuperacao.tf:71`, `:225-226` |
| Segredos fechados por precondição | Provisionamento: só `DATABASE_AUTH_URL`, `DATABASE_URL` e `RATE_LIMIT_HASH_KEY` (`ops-provisionamento.tf:51-60`, `:277-286`). Recuperação: só os dois bancos, sem chave HMAC nem `BETTER_AUTH_SECRET` (R4) (`ops-recuperacao.tf:46-53`, `:244-253`). Ambiente fechado, e a trava `CONFIRMA_*` vem só pelo override (`:289-292` / `:256-259`). |
| Papel de execução mínimo | Só o ECR da API, o stream de log com prefixo próprio, os segredos do mapa e `kms:Decrypt` em `segredos`/`ecr` (`ops-provisionamento.tf:135-161`; `ops-recuperacao.tf:128-160`). |
| A tarefa só toca o que precisa | Provisionamento: lê e apaga o pedido, só grava a entrega, e tem Deny de leitura, histórico e apagamento da entrega (`ops-provisionamento.tf:176-193`). O KMS fica preso a `kms:ViaService` = SSM e ao `PARAMETER_ARN` (`:194-223`). Recuperação: só grava e apaga a entrega, sem Get e sem Decrypt por IAM (`ops-recuperacao.tf:169-191`). Bate com o código: o provisionamento apaga só o pedido (`provisionar-clinica.ts:133`) e a recuperação apaga a própria entrega na falha (`recuperar-admin-unico.ts:110`). |
| O humano não grava a entrega e não relê o e-mail (C4) | Provisionamento: Put só no pedido, Deny de Put na entrega e Get só na entrega (`ops-provisionamento.tf:415-437`). O e-mail em claro do pedido não volta para ninguém além da tarefa. Recuperação: Deny de Put em todo `/recuperacao-suporte/*` (`ops-recuperacao.tf:387-392`). |
| Chave KMS por fluxo, com key policy | `kms.tf:13-14` (chaves `ops-provisionamento` e `ops-recuperacao`, com rotação, `kms.tf:189`). O Deny `SoQuemOperaDecifra` (`kms.tf:144-163`) barra Decrypt, ReEncrypt e CreateGrant de qualquer principal fora de `local.chaves_ops_ssm` (`kms.tf:20-23`), inclusive o SSO de administrador e o break-glass. O ARN do papel humano é fixo, então a policy vale mesmo com o papel ausente. Como o SSM chama o KMS com a credencial de quem pede, `aws:PrincipalArn` é o papel certo. |
| MFA, `SourceIdentity` e sessão (R7, R4) | A confiança é idêntica à do `ops-lgpd`: MFA com menos de 3600 s, `SourceIdentity` = `${aws:username}` para usuário IAM e obrigatório no SSO, `max_session_duration = 3600` e o papel só existe com a lista preenchida (`ops-provisionamento.tf:302-379`; `ops-recuperacao.tf:269-345`). Há defesa em profundidade com `SemMfaNada` e `SomenteSaoPaulo`. A validação recusa curinga (`variables.tf:105-123`). |
| RunTask só na revisão atual e no cluster | `ops-provisionamento.tf:383-392`; `ops-recuperacao.tf:350-359`. O PassRole é só para `ecs-tasks`. |
| Deny nos papéis de máquina | API (tarefa e execução), `github_deploy`, `gestor_chaves` e `ancora_publicador` não rodam, não passam os papéis, não tocam os parâmetros e não usam a chave (`ops-provisionamento.tf:560-594`; `ops-recuperacao.tf:500-534`). |
| Alertas | Toda execução gera alerta, e o override suspeito gera alerta crítico (variável fora da trava, `environmentFiles`, troca de papel, ECS Exec), tudo no tópico com a política atualizada (`ops-provisionamento.tf:516-554`; `ops-recuperacao.tf:456-494`; `acesso-humano.tf:224-229`). O limite é o mesmo aceito no B10 (A1: forma do `command` só pelo conferente). |
| Rede | SG próprio só com saída para 443 na VPC, S3 pelo gateway e 5432 no RDS, sem entrada e sem Redis (`ops-provisionamento.tf:83-124`; `ops-recuperacao.tf:76-117`). Os outputs mandam `assign_public_ip = DISABLED`. |
| Segredos e dados fora do git | Os principais vêm do tfvars, nada sensível foi commitado e o gitleaks está verde. |

## Achados

### Condições para a primeira execução real (bloqueiam o PR do cliente SSM, não este)

- **C1. Quem roda e quem entrega é o mesmo papel. Médio-alto.**
  - **Onde:** `ops-provisionamento.tf:381-437` (o mesmo papel tem RunTask, cria o pedido e lê a entrega) e `ops-recuperacao.tf:348-392` (o mesmo papel tem RunTask e lê a entrega).
  - **Risco:** uma só pessoa cria o pedido com o e-mail que quiser, roda a tarefa e lê o token. É exatamente o risco residual da R3 (quem entrega pode ativar no lugar do fundador) e da R6 do B12 (token que, com a senha, devolve conta de admin). Hoje a separação depende só do chamado e de alguém comparar o `SourceIdentity` depois. Nenhum alerta dispara se a mesma pessoa fizer as duas coisas.
  - **Correção (escolher uma):**
    - (a) **Preferida:** separar em dois papéis por fluxo, `ops-*-executor` (RunTask, PassRole, criar o pedido) e `ops-*-entrega` (Get/Delete só na entrega e Decrypt só na entrega), com listas próprias (`principais_ops_*_entrega`) e uma `precondition` que exija listas **disjuntas** e com ao menos uma pessoa em cada uma. A key policy (`kms.tf:20-23`) passa a citar o papel de entrega no Decrypt.
    - (b) **Mínimo:** detecção por máquina. Ligar os eventos de leitura do CloudTrail para `ssm:GetParameter` em `*/entrega`, criar uma regra ou filtro de métrica que alerte quando o `SourceIdentity` do `GetParameter` for igual ao do `RunTask` do mesmo pedido, e pôr esse passo no runbook.
  - Em qualquer caso, a validação de `variables.tf:105-123` deve recusar uma lista com uma pessoa só ("ao menos duas pessoas" hoje está só na descrição).
- **C2. O vencimento do parâmetro ainda não existe (C4 do PR 1, R7 do B12).**
  - **Onde:** comentário em `ops-provisionamento.tf:20-25` e `ops-recuperacao.tf:17-20`.
  - O Terraform não tem como garantir isso. O cliente SSM real deve gravar com `Tier=Advanced` e `Expiration` (72 h e 24 h) e ter teste com dublê do SDK que confira `Policies`. O runbook deve exigir o mesmo `Expiration` no pedido criado pelo operador.
  - **Reforço barato pedido junto:** uma regra do EventBridge para `Parameter Store Policy Action` (expiração) nos dois prefixos, com alerta. Um token que venceu sem ser entregue é um evento a registrar no chamado.
- **C3. Falta o runbook do provisionamento.**
  - Ele deve ter: `assume-role --source-identity`, o JSON do override, o `put-parameter` do pedido (SecureString, `--key-id` da chave própria, Advanced e `Expiration`), quem entrega lê uma vez e apaga, a conferência do CloudTrail (principal e `SourceIdentity` do RunTask e do GetParameter contra os dois nomes do `CTR-`) e o que fazer quando o alerta crítico dispara.
  - O runbook da recuperação já existe. Ele precisa ser atualizado para o papel `ops-recuperacao` (hoje fala em "grupo nominal", `runbook-recuperacao-admin-unico.md:17`) e para o comando de leitura e apagamento do SSM.

### Recomendações (não bloqueiam)

- **A1. `RATE_LIMIT_HASH_KEY` é a raiz, não "a chave do HMAC por uso" (R8).**
  - **Onde:** `ops-provisionamento.tf:54`, `:59`.
  - O código precisa dela hoje: `provisionamento.ts` deriva `chaveDeHmac('ativacao-email')` da raiz por HKDF (`rate-limit-store.ts:150-152`). Só que com a raiz a tarefa consegue derivar todos os usos (`rate-limit`, `bloqueio`, `sessao-ua`, `convite-email`) e ligar IPs, sessões e convites. É o que o `eng/hmac-por-uso` quer evitar.
  - O risco é baixo: programa fixo, operador com MFA e alerta a cada execução.
  - **Correção:** criar um segredo próprio com a chave já derivada do uso `ativacao-email` (gerado uma vez por script e gravado write-only). A tarefa lê `ATIVACAO_EMAIL_HMAC_KEY` no lugar da raiz, e a precondição troca `RATE_LIMIT_HASH_KEY` por esse segredo. A rotação da raiz passa a exigir derivar de novo (anotar no runbook de rotação).
- **A2. A key policy da recuperação deixa a tarefa decifrar sem precisar** (`kms.tf:22`).
  - A tarefa da recuperação só cifra. Tirar `aws_iam_role.ops_recuperacao_tarefa.arn` do Decrypt da key policy. Se a lista ficar dividida por ação, o `ReEncrypt`/`CreateGrant` seguem negados a todos.
  - Pelo mesmo motivo, acrescentar em `ops-recuperacao.tf:169-191` o Deny explícito `EntregaNaoVolta` (Get, GetParameters, GetParameterHistory), igual ao do provisionamento (`ops-provisionamento.tf:188-193`). Hoje a proibição é só implícita e se perde com uma ampliação futura por curinga.
- **A3. O Decrypt da tarefa do provisionamento cobre a entrega no KMS** (`ops-provisionamento.tf:203-207`).
  - O `ArnLike` em `/provisionamento/*` também casa `*/entrega`. O Deny do SSM fecha o caminho, mas vale acrescentar `ArnNotLike kms:EncryptionContext:PARAMETER_ARN = */entrega` para que as duas camadas digam a mesma coisa.
- **A4. O endpoint `ssm` não tem política nem condição** (`rede.tf:130`).
  - **Custo (ESTIMATIVA, conferir na página de preços do AWS PrivateLink para sa-east-1):** a ordem de grandeza é de US$ 7 a 12 por mês por AZ, mais o tráfego. No staging é uma AZ (`zonas_dos_endpoints = 1`), e em prod seriam três.
  - **Correção:**
    - criar o endpoint `ssm` só quando `ops_prov_ativo || ops_rec_ativo`;
    - dar a ele uma política de endpoint que aceite só `aws:PrincipalAccount` e `aws:ResourceAccount` iguais à conta e só os ARNs `parameter/provisionamento*` e `parameter/recuperacao-suporte*`. Sem isso, o endpoint abre na VPC um canal novo para o SSM de **outra** conta (exfiltração com credencial de fora).
  - Fica como pendência geral levar a mesma política aos endpoints que já existem.
- **A5. Os papéis humanos `ops-*` não estão em `local.principais_humanos`** (`acesso-humano.tf:14-20`).
  - Isso vale para o `ops-lgpd`, `ops-provisionamento` e `ops-recuperacao`. As chaves "sem humanos" (`rds`, `segredos`, `s3`...) e as KEKs das clínicas só barram esses papéis por falta de Allow, não pelo Deny `HumanoNaoDecifra`.
  - **Correção:** pôr os três ARNs fixos no padrão humano (e em `papeis_humanos_extra`, para a API levar às KEKs). Nenhum deles precisa dessas chaves. A pendência vem do B10 e vale para os três.
- **A6. Não há alerta na leitura e no apagamento da entrega.** Isso fica coberto por C1 (b). Se a opção escolhida for C1 (a), o alerta de `GetParameter` na entrega continua útil como trilha de "entregue em".

## Checklist

| Item | Situação |
|---|---|
| Base legal | Sem mudança: art. 7º V (contrato com a clínica) para o provisionamento; art. 7º II e IX e art. 46 para os controles de segurança. |
| Minimização | E-mail só no pedido transitório, lido só pela tarefa. Token só na entrega. A1: a tarefa recebe a raiz do HMAC, mais do que precisa. |
| Consentimento | Não se aplica (operação contratual e de segurança). |
| Criptografia em trânsito e em repouso | SecureString com KMS própria e rotação, TLS pelo endpoint privado e `sslmode=verify-full` no banco. |
| Isolamento por clínica | Não muda aqui (RLS e `withTenant` no código já revisado). |
| Controle de acesso | Menor privilégio por papel, MFA, `SourceIdentity` e Deny nos papéis de máquina. **C1:** quem roda e quem entrega ainda não estão separados por máquina. |
| Log de auditoria | CloudTrail com principal nominal e alerta a cada RunTask. A6/C1: falta alerta na leitura da entrega. |
| Retenção | **C2:** expiração de 72 h e 24 h pendente no cliente SSM. Prontuário (20 anos) não é tocado. |
| Segredos fora do código | Conforme (Secrets Manager, tfvars fora do git, gitleaks verde). |
| Dados reais fora do git e de prompts | Conforme. |
| CFM/ANS/ICP-Brasil | Não se aplica a este PR. |
