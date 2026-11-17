# Parecer do Guardião LGPD: 3c parcial, segredos do login e RIPD da identidade (PR #162, rascunho)

> Data: 08/11/2026. Branch: `eng/better-auth-producao` (`0e2e4c0`), base `eng/better-auth-endurecimento` (#161; merge-base `0122392`). Revisão estática do diff `origin/eng/better-auth-endurecimento...origin/eng/better-auth-producao`: Terraform (`dados.tf`, `app.tf`, `variables.tf`), comentário do `infra/rds/bootstrap.sh`, `RIPD-identidade.md` e relatório da rodada 33. Referências: §14.3 e §14.4 do desenho; R12 a R18 do parecer do desenho do PR 3; R4, R5 e R9 do parecer do código do #152; pareceres do 3b-3 e do endurecimento. O CI do PR passou (15/15, inclusive `fmt, validate, tflint e checkov`, gitleaks e a trava de TLS). Não houve `plan` nem `apply` aqui.

## Veredito: **APROVADO COM RESSALVAS como entrega parcial.** O que está no PR pode seguir. **A produção continua fechada:** este parecer não é o parecer final do 3c (R13 do desenho), e `AUTH_PROVIDER` segue proibido no Terraform.

| Item | Situação |
|---|---|
| **Segredos novos** | `banco-app-auth` e `better-auth-secret` seguem o padrão dos existentes: `ephemeral "random_password"`, `secret_string_wo` com versão, KMS próprio dos segredos, `recovery_window` de 7 dias. Nada vai para o state nem para o git. ✅ |
| **TLS na URL do `app_auth`** | `sslmode=verify-full`, igual à do `app_user` (R12). ✅ (ver R1: o caminho da CA está errado na tarefa) |
| **Acesso aos segredos** | A política de execução usa `local.api_segredos_arns`, que passa a incluir só os dois novos. A tarefa de migração não recebe `DATABASE_AUTH_URL`, e a API não recebe o `banco-app-migrator`. ✅ |
| **Abertura travada** | `AUTH_PROVIDER` e `PORTAL_AUTH_PROVIDER` continuam em `api_variaveis_proibidas`, com precondição. ✅ |
| **Bootstrap** | O script já exigia `APP_AUTH_PASSWORD`; o PR só corrige o comentário de uso. ✅ |
| **Rotação** | A descrição do `better_auth_secret_versao` avisa que, até os segredos versionados, trocar a versão apaga o TOTP de todos. ✅ (fica bloqueante, ver B1) |
| **RIPD** | Cobre o que a R14 e a R17(e) pedem: schema `identidade`, e-mail não verificado, prefixo do SHA-1 que não é dado pessoal, contadores em HMAC, anonimização (R18) e procedimentos de suporte (R13 do 3b-2, R17(c), R18). Ainda é rascunho (ver R2 a R6). |

## Ressalvas deste PR (entram antes do parecer final do 3c)

1. **O caminho da CA do RDS na tarefa não existe na imagem.** O `app.tf` (linha 217) põe `NODE_EXTRA_CA_CERTS=/app/certs/rds-sa-east-1-bundle.pem`, e o `infra-staging.md` (linha 286) repete esse caminho. Mas o Dockerfile grava o bundle em `/etc/ssl/certs/rds-sa-east-1-bundle.pem` e define a variável com esse caminho. A variável da tarefa **sobrepõe** a da imagem. O Node ignora o arquivo que não existe, e o `verify-full` falha com a CA da AWS, que não está no repositório padrão. O defeito é anterior ao PR e falha fechado: a API não conecta, e nada sai sem TLS. Mesmo assim, a R12 não pode ser verificada no staging assim. **Correção:** apontar a tarefa para `/etc/ssl/certs/rds-sa-east-1-bundle.pem` (ou tirar a variável da tarefa e deixar a da imagem), corrigir o `infra-staging.md` e incluir no teste de fumaça uma conexão de cada papel (`app_user` e `app_auth`) com `verify-full`. Nunca resolver com `NODE_TLS_REJECT_UNAUTHORIZED` ou `sslmode=require`.
2. **Base legal e papéis.**
   - O art. 7º, V pede um contrato **do qual o titular seja parte**. A equipe não é parte do contrato entre a plataforma e a clínica. Para o schema `identidade`, a plataforma decide o prazo, o meio e a anonimização, e a conta sobrevive à saída de uma clínica. Por isso, nesse schema, a plataforma é **controladora**. A clínica é controladora do vínculo e da trilha dela.
   - O art. 46 é dever de segurança, não base legal.
   - **Proposta para o advogado ⚖️:**
     - art. 7º, IX (legítimo interesse: autenticar e proteger o acesso ao prontuário), com o teste de balanceamento (LIA) anexado, como pede o art. 10;
     - para a clínica, art. 7º, II (obrigação de controlar o acesso ao prontuário, CFM 1.821/2007 e NGS2).
   - Preencher a §0 do `RIPD-modelo.md`: controlador, operador, encarregado, partes consultadas e motivo do RIPD.
3. **O RIPD não segue o modelo inteiro.** Faltam:
   - a tabela de controles da §5, com evidência, que é o que o art. 38, parágrafo único, pede. Ela deve cobrir: TLS verificado no banco e no Redis; criptografia em repouso (RDS e ElastiCache com KMS); TOTP cifrado; segredos no Secrets Manager; RLS e papel `app_auth` separado; trilha; teste de restauração;
   - a classificação do risco residual e a aprovação da §8 (encarregado, controlador, ciência do Guardião);
   - a tabela de revisão da §9.
   A conclusão hoje é "proposta", e assim deve continuar até o checklist.
4. **Credencial de conta inativa sem prazo.** A R11 do desenho do PR 3 pedia que o RIPD fixasse um prazo: depois de N dias com a conta inativa (`sem_vinculo` ou desligada em todas as clínicas), apagar o hash da senha, o TOTP, as sessões e os tokens, mesmo sem pedido do titular. Pela tabela de retenção, só a anonimização a pedido apaga a credencial. Credencial de quem saiu não tem finalidade (art. 15, I, e art. 16).
   - **Correção:** fixar N no RIPD (proposta: 90 dias).
   - A recontratação depois disso é um cadastro do zero, com convite.
   - O job pode vir depois da abertura, mas com prazo na fila.
5. **Matriz de retenção e contrato não foram alterados.** O RIPD diz que os prazos "entram na `matriz-retencao.md`", e diz que "o contrato com a clínica diz" que o admin responde pelo e-mail que declara e pela entrega dos tokens. Nenhum dos dois arquivos mudou: o `dpa-minuta.md` não tem essa cláusula (R14 e R17(e)).
   - **Correção:** neste PR, acrescentar à matriz as linhas do schema `identidade`, a retenção de `team_invites` (R3 do 3b-1, hoje "a definir") e o prazo da R4.
   - Acrescentar a cláusula ao DPA, marcada ⚖️.
   - Até lá, escrever no RIPD "o contrato **dirá**".
6. **Ajustes de texto do RIPD.**
   - **Egresso no presente.** O RIPD diz "o egresso fica liberado só para `api.pwnedpasswords.com:443`". Hoje a API não tem saída para a internet nenhuma (ver B2). Escrever como condição.
   - **Prazo da anonimização.** O art. 19 trata de confirmação e acesso. O pedido de anonimização é do art. 18, IV. Fixar um prazo interno (proposta: 15 dias), citando o art. 18, §§ 3º a 5º.
   - **Suporte, item 1.** O documento conferido não é copiado nem guardado. A trilha registra só o tipo de documento conferido e quem conferiu.
   - **Suporte, item 3 (R17(c)).** A conta fica **suspensa** durante a investigação, e o resultado vai para a trilha das clínicas envolvidas.
   - **Log de segurança.** O IP está em HMAC. Dizer como se atende a uma ordem judicial do Marco Civil (art. 15): por exemplo, pela correlação com o log do ALB. Ou dizer que a guarda do IP em claro fica só no log do ALB, com prazo próprio.
7. **O job `identidade-expurgo` está sem alarme.** O job está no registro da API, mas não em `jobs_de_retencao` (`jobs.tf`, linha 131). Assim, `JOB_ATRASADO` e `JOB_ALARME` não geram métrica nem alarme. É um job de retenção: se ele parar, sessões e tokens vencidos ficam no banco, e ninguém percebe. **Correção:** incluir o job na lista.
8. **Precondição na abertura.** Quando `AUTH_PROVIDER` sair da lista proibida, `DATABASE_AUTH_URL` e `BETTER_AUTH_SECRET` precisam entrar em `api_segredos_obrigatorios`, condicionados a `AUTH_PROVIDER = better-auth`. Assim, o plano falha se um dos dois faltar ou se for posto em `environment`.

## O que bloqueia a abertura de produção

A abertura é a inclusão de `production` em `AMBIENTES_POR_TIPO['better-auth']` e a liberação de `AUTH_PROVIDER` no Terraform. Ela só acontece depois de **todos** estes itens e do parecer final do Guardião:

- **B1. Segredos versionados (R9 do #152, R12 do desenho).**
  - `secretConfig.keys` com o envelope `$ba$<versão>$`.
  - Teste automatizado: um fator cifrado com a versão 1 continua sendo conferido quando a versão 2 vira a atual.
  - O mesmo teste repetido no staging.
  - Runbook de rotação escrito: a versão antiga sai só depois da recifra ou do recadastro.
  - O Terraform passa a guardar as versões (ex.: um JSON `{atual, chaves}`), e não um único valor que o `_versao` sobrescreve.
  - **Sem isso, a primeira rotação, ou um vazamento do segredo, apaga o MFA de todos em produção.**
- **B2. Egresso para a base de senhas vazadas (R5 do #152).**
  - Hoje a API não tem NAT (`habilitar_nat = false`). O security group só sai para a VPC, o S3, o RDS e o Redis. A conferência de senha vazada **nunca roda**: toda senha passa em falha aberta.
  - Um security group não filtra por nome, e o serviço está atrás de IPs de CDN. Por isso, **não é aceitável** abrir `0.0.0.0/0:443` na API.
  - Fazer o filtro por domínio: AWS Network Firewall com lista de domínios por SNI, ou proxy de saída com allowlist (só `api.pwnedpasswords.com:443`). DNS Firewall só complementa, não basta sozinho.
  - Teste no staging: a conferência funciona, e outro domínio qualquer é recusado.
  - **Alternativa aceitável só por decisão escrita de N0:** abrir sem a conferência. Nesse caso, valem a marca "conferência pendente" e a reconferência no próximo login, recomendadas na R5. O RIPD e o checklist registram que esse controle está ausente.
- **B3. `HTTP_TRUST_PROXY_HOPS` conferido no staging (R4 do #152, R13 do desenho).**
  - O valor `1` está no Terraform, mas falta a prova atrás do ALB real: duas origens diferentes geram HMACs de origem diferentes.
  - 30 falhas de uma origem não trancam a outra.
  - Sem isso, o teto por origem pode trancar a plataforma inteira.
- **B4. TLS verificado (R12).**
  - A R1 deste parecer está corrigida.
  - Conexão `verify-full` provada para `app_user` e `app_auth`.
  - Redis com `rediss://` e AUTH, com o certificado validado.
  - `RATE_LIMIT_HASH_KEY` e `BETTER_AUTH_SECRET` lidos do Secrets Manager na tarefa.
  - A evidência vai no checklist.
- **B5. RIPD e contrato fechados (R14, R17(e)).**
  - As ressalvas R2 a R6 estão resolvidas.
  - O advogado confirmou a base legal ⚖️.
  - A cláusula do admin está no DPA.
  - A §8 está assinada pelo encarregado.
- **B6. Checklist assinado (R13 do desenho).**
  - Uma linha por pendência "antes do PR 3", com o PR de cada uma: #149 (RIPD, retenção, segredos, `Set-Cookie`) e #152 (R3 a R9).
  - Também entram as condições da D4 que estão na fila: CSRF com a sessão real (R1 e R6 do #132), eventos do fator (R5 e R6 do #123), auditoria dos ganchos (R6 do #117) e os alvos distintos (#153, que tem de estar em `main` antes).
  - Cada item da fila do 3b-1, do 3b-2, do 3b-3 e do endurecimento leva a decisão "antes" ou "depois", com o prazo.
- **B7. Merge da pilha.** #149 → #152 → #155 → #156 → #159 → #160 → #161, e o #153, em `main`, com a aprovação do outro sócio, antes da abertura.
- **B8. Teste de fumaça no staging, só com contas fictícias (R13).**
  - O fluxo completo: convite, aceite, cadastro do TOTP, escolha de clínica, rota sensível com reverificação, logout global.
  - Mais: bloqueio por e-mail e por origem atrás do ALB, recuperação pelo admin e desligamento derrubando a sessão.
  - Nenhum dado real, nenhuma conta real e nenhum e-mail real de pessoa.

## Pode ir depois da abertura (com prazo na fila)

- O job que apaga a credencial da conta inativa (R4; a **definição** do prazo entra antes, no RIPD).
- O alarme do `identidade-expurgo` (R7), se não entrar neste PR. Prazo: o primeiro deploy em produção.
- Os itens de fila já classificados como "depois" no checklist (B6): R9, R10 e R12 do 3b-2; R5 e R7 do 3b-3; R12 do #152 (`issuer`); `email_hmac` dos convites na anonimização (R3 do 3b-1).
- A verificação de e-mail obrigatória quando houver provedor (R17(d)), com revisão do RIPD.

## Conferido sem achado

| Item | Situação |
|---|---|
| Minimização | Nenhum dado novo. Os segredos têm o mínimo de campos (`chave`; `username`, `password`, `url`). ✅ |
| Consentimento | Não se aplica: a base não é consentimento. ✅ |
| Criptografia em trânsito e repouso | `verify-full` no `app_auth`, `rediss://` com AUTH, segredos com KMS. ✅ (R1 pendente para funcionar) |
| Isolamento por clínica | Papel `app_auth` separado, só no schema `identidade`; a clínica (`app_user`) não lê nada dele. ✅ |
| Controle de acesso | O IAM lê só os segredos referenciados pela tarefa; o migrator fica fora da API. ✅ |
| Log de auditoria | Sem mudança no código. ✅ |
| Retenção do prontuário (20 anos) | A conta não é apagada (R18); o autor fica em `professionals`. ✅ |
| Segredos fora do código | Gerados no `apply`, write-only, fora do state. O gitleaks passou. ✅ |
| Dados reais | Nenhum, no diff e no relatório. ✅ |
| CFM, ANS e ICP-Brasil | O MFA obrigatório atende ao NGS2 (CFM 1.821/2007). Não toca TISS nem assinatura. ✅ |

## Nota do Maestro (08/11/2026)

- **Ressalva 1:** a tarefa aponta para `/etc/ssl/certs/rds-sa-east-1-bundle.pem`, o mesmo caminho do Dockerfile, e o `infra-staging.md` foi corrigido. Falta provar o `verify-full` no staging (B4).
- **Ressalvas 2 a 6:** o RIPD ganhou:
  - a §0;
  - a base legal proposta (art. 7º IX com o teste de balanceamento; art. 7º II do lado da clínica);
  - a tabela de controles e evidências;
  - a §8 com o risco residual e a assinatura pendente, e a §9;
  - o prazo de 90 dias para a credencial de conta inativa;
  - o egresso descrito como ele é hoje;
  - a citação do art. 18;
  - o documento do suporte só exibido, nunca guardado;
  - a conta suspensa durante a disputa de e-mail;
  - a ordem judicial.
  - Também a linha na `matriz-retencao.md` e a cláusula no `dpa-minuta.md`.
- **Ressalva 7:** `identidade-expurgo` entrou em `jobs_de_retencao`, com o alarme.
- **Ressalva 8** entra no PR que abrir a produção.
- **B1:** o código e o teste de rotação (`segredos.ts`, `segredos.test.ts`) estão feitos; o Terraform tem o segredo `BETTER_AUTH_SECRETS` opcional, e o runbook está em `docs/04-arquitetura/runbook-rotacao-better-auth.md`.
- **B6:** o checklist está em `docs/03-seguranca-lgpd/prontidao-producao.md`.
- **B2, B3, B4, B5, B7 e B8** dependem da AWS, dos sócios, do advogado ou da aprovação do @Lopesloro, e estão marcados no checklist.
