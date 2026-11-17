# Parecer do Guardião: cliente SSM real das tarefas de provisionamento (B11) e recuperação do admin único (B12)

> 17/11/2026 · Guardião LGPD & Segurança · revisão de **código** do PR #206 (`eng/cliente-ssm`, commit `310a3b3`, diff `origin/eng/expurgo-da-ativacao...HEAD`).
> Base: C4 de [`2026-11-16-codigo-provisionamento-pr1.md`](2026-11-16-codigo-provisionamento-pr1.md) (C2 e C3 já fechadas no #195/#205), "SSM real" e R7 de [`2026-11-17-codigo-recuperacao-admin-unico.md`](2026-11-17-codigo-recuperacao-admin-unico.md), C1 a C3 de `2026-11-17-codigo-infra-ops-provisionamento.md` (no #204, `eng/infra-ops-provisionamento`, head `a3e9d22`).

## Veredito: **APROVADO COM RESSALVAS**. O merge depende de C1 (texto do runbook da recuperação) e dos checks pendentes verdes. A primeira execução real depende de C2.

O cliente cumpre C4 e a parte de código de C2 do #204. Ele grava SecureString com a chave KMS do fluxo, camada Advanced, `Expiration` de 72 h ou 24 h e `Overwrite: false`. O erro do SDK nunca sai, e a configuração inválida falha fechada. A troca de `Overwrite: true` por `false` está **aprovada**: ela é mais segura que o texto de C4, porque nenhuma entrega é trocada em silêncio. Para o provisionamento, a correção que vem com ela está certa. Para a recuperação, o código também está certo, mas o runbook manda fazer a coisa errada no `entrega_pendente` (C1). Rodei localmente os três arquivos de teste do cliente e das tarefas: 40 de 40 passaram.

## Condições

- **C1. O runbook da recuperação manda apagar uma entrega válida e rodar de novo, o que bate no teto. Bloqueia o merge (é só texto).**
  - **Onde:** `runbook-recuperacao-admin-unico.md`, item `entrega_pendente`.
  - **Problema:** o texto diz que, se o token anterior não foi entregue, quem entrega apaga sem ler e o executor roda de novo. O que acontece é outra coisa.
    - Se a rodada anterior deu `ok`, ela já conta no teto (1 por clínica em 30 dias). A nova rodada sai `teto`, dispara `RECUPERACAO_TETO` e cai na revisão manual do DPO e dos sócios. O titular fica sem token, que foi apagado sem motivo, e o runbook passa a empurrar para a exceção.
    - O ramo "se já foi entregue, encerre" quase não acontece, porque quem entrega apaga a entrega logo depois de ler.
  - **Correção:** decidir pela prova do log de segurança, sem ler o parâmetro.
    - Há `RECUPERACAO_PELO_SUPORTE` desse usuário nas últimas 24 h? Então a entrega é válida. Quem entrega segue o fluxo normal (lê uma vez, entrega só ao titular, apaga) e **não se roda de novo**.
    - Não há? Então a entrega é órfã de uma rodada desfeita (ver A1). Quem entrega apaga sem ler e o executor roda de novo.
    - Apagar uma entrega válida só se justifica por suspeita. Nesse caso o caminho é o alerta crítico, não uma nova rodada.
  - Corrigir também a frase duplicada "Entrega o token e entrega o token" no passo 2 de "Entregar".

- **C2. Antes da primeira execução real (não bloqueia o merge).**
  - O #204 (hoje `OPEN`, head `a3e9d22`) precisa estar mergeado e aplicado, com `endpoint_ssm = true` e as listas executor/entrega preenchidas e disjuntas.
  - A regra `<nome>-ops-entrega-vencida` (`Parameter Store Policy Action`, `Expiration`, nos dois prefixos de `*/entrega`) **já está no #204** (`ops-provisionamento.tf`, commit `a3e9d22`). Isso atende o reforço de C2 do parecer do #204. A descrição do #206 ainda diz que ela está pendente: atualizar a descrição.
  - **Fumaça no staging, com dado fictício:**
    - uma rodada de cada fluxo;
    - conferir no console que o parâmetro é Advanced e tem a política `Expiration`;
    - conferir que o `PutParameter` no CloudTrail não traz o valor;
    - conferir que o alerta de entrega dispara na leitura;
    - conferir que o de vencida dispara (parâmetro de teste com `Expiration` de poucos minutos).
  - Depois disso, a mudança volta ao Guardião, como a própria descrição do PR prevê.
  - Seguem valendo para a primeira recuperação **real** a R10 (RIPD e checklist) e a retenção de 13 meses no RIPD §3, ambas do parecer de 17/11 da recuperação.

## Conferência dos pontos pedidos

| Ponto | Situação | Evidência |
|---|---|---|
| Token fora de log, exceção, `cause` e stdout | **OK.** O erro do SDK vira `FalhaDoSsm`/`EntregaPendente`, com mensagem fixa e sem `cause`. O teste confere que o nome do parâmetro e o token não estão na mensagem nem no `stack`. Pelo Logger sai só `saida.linha`, e `principal().catch` imprime um código fixo. O `SSMClient` usa o logger padrão do SDK, que não registra nada. No CloudTrail, o `PutParameter` de SecureString não traz o valor (conferir na fumaça, C2). O nome do parâmetro só tem uuids pseudônimos. | `parametros-ssm.ts:70-104`, `parametros-ssm.test.ts:45-55` |
| Compensação na falha do SSM | **OK.** **Provisionamento:** `guardarToken` roda dentro da transação, então a falha ao gravar desfaz a linha e o token nunca valeu. O pedido (com o e-mail) é apagado com sucesso ou falha (R9). Uma entrega órfã que tenha ficado expira em 72 h ou cai no `entrega_pendente`. **Recuperação:** a falha ambígua apaga a entrega desta rodada (`gravou` continua `true`). O `EntregaPendente` não apaga a entrega da rodada anterior. A transação interna e a trilha externa são desfeitas, então o teto não é consumido e os tokens pendentes não são invalidados. | `provisionamento.ts:178-196`; `recuperacao-pelo-suporte.ts:131-183`; `recuperar-admin-unico.ts:100-133` e testes novos |
| C4: `Overwrite: false` + `entrega_pendente` | **Aprovado.** No provisionamento, o `entrega_pendente` do mesmo pedido só aparece quando a linha anterior não gravou. Se gravou, o `ja` (`provisionamento.ts:135`) recusa antes, e um pedido novo tem outra clínica e outro caminho. Por isso o runbook está certo ao dizer que aquele token não vale. Na recuperação, o código está certo, mas o runbook não (C1). Como `DeleteParameter` apaga o histórico, nenhum token antigo sobra no `GetParameterHistory`. | `parametros-ssm.ts:82-98`; `provisionar-clinica.ts:129-131` |
| Runbooks × papéis executor/entrega do #204 | **OK nos papéis.** Os nomes `<ambiente>-ops-*-executor`/`-entrega` batem com o Terraform. O executor cria e apaga o pedido (`CriarEApagarOPedido`, `CifrarOPedido` com `GenerateDataKey`, necessário no Advanced). Quem entrega lê e apaga só `*/entrega`. Os Deny cruzados e a key policy (`chaves_ops_ssm`) batem com o que o runbook promete. O alias `alias/<ambiente>-ops-provisionamento` é igual a `alias/${local.nome}-${each.key}`. O CloudTrail exige `SourceIdentity` diferente nos dois papéis. **Falha só na C1.** | `runbook-provisionamento-da-clinica.md`; `ops-provisionamento.tf` e `kms.tf` do #204 |
| Custo | **OK (ESTIMATIVA).** Advanced custa cerca de US$ 0,05 por parâmetro por mês, rateado, mais US$ 0,05 por 10 mil chamadas. Isso dá menos de US$ 0,01 por execução. O custo que pesa é o endpoint `ssm` (cerca de US$ 7 a 12 por mês por AZ), que já está no #204. Falta citar a chave KMS: cerca de US$ 1 por mês por chave, duas chaves (A4). | descrição do PR; runbooks; `rede.tf` |
| Alerta de expiração no EventBridge | **Feito no #204**, pendente de merge e de apply (C2). | `ops-provisionamento.tf` (#204), recurso `ops_entrega_vencida` |
| Configuração falha fechada | **OK.** Só `sa-east-1`. A chave tem de ser ARN na mesma região. Regiões divergentes são recusadas. Fora de development/test, vale a mesma lista de variáveis proibidas da API, e `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` continua permitida. | `parametros-ssm.ts:120-129`, testes `:85-107` |

## Recomendações (não bloqueiam)

- **A1. A nova tentativa do SDK pode transformar a gravação da própria rodada em `EntregaPendente`.**
  - **Como acontece:** com `maxAttempts: 3`, o primeiro `PutParameter` grava, mas a resposta se perde. A nova tentativa recebe `ParameterAlreadyExists`.
  - **Efeito:** a transação é desfeita e o token gravado não vale. Mas o parâmetro fica, e na recuperação ele **não** é apagado (`gravou = false`). O comentário de `recuperar-admin-unico.ts:101-102` ("só a recusa por entrega pendente garante que nada desta rodada ficou") não é verdade nesse caso.
  - **Risco:** baixo. O valor é inútil, está cifrado e vence em 24 h ou 72 h. A C1 cobre a parte operacional, porque não haverá `RECUPERACAO_PELO_SUPORTE` e a entrega será apagada sem ler.
  - **Correção:** corrigir o comentário. Se der, usar um cliente com `maxAttempts: 1` só para o `PutParameter`.
- **A2. Runbook do provisionamento, `ja_provisionado` depois de `erro_parcial_rodar_de_novo`.**
  - **Como acontece:** o COMMIT pode ter entrado sem resposta. Nesse caso a entrega válida está no SSM e a rodada nova sai `ja_provisionado`.
  - **Correção:** dizer no runbook que, se houver `ATIVACAO_EMITIDA` do pedido no log de segurança (ele só é registrado depois do commit), quem entrega segue o passo 4 normalmente.
- **A3. Aceitar só o ARN de chave em `SSM_KMS_KEY_ID`.** Hoje o regex também aceita ARN de alias (`parametros-ssm.ts:31`). O Terraform passa o ARN da chave, e prender a chave impede que um alias redirecionado leve a entrega para outra chave.
- **A4. Completar o custo** com as duas chaves KMS (cerca de US$ 1 por mês cada; ESTIMATIVA, conferir na página de preços do KMS).
- **A5. Pedido sem arquivo em disco.** No passo 2 do runbook do provisionamento, preferir `--value file:///dev/stdin` (ou `read -s`) a `pedido.json` seguido de `shred`. O `shred` não garante apagamento em SSD nem em sistema de arquivos com diário.

## Checklist

| Item | Situação |
|---|---|
| Base legal | Sem mudança: art. 7º V (contrato) no provisionamento; art. 7º II e IX e art. 46 nos controles. |
| Minimização | E-mail só no pedido transitório, que é apagado no fim e vence em 72 h. Token só na entrega, que vence em 72 h ou 24 h. |
| Consentimento | Não se aplica. |
| Criptografia em trânsito e em repouso | SecureString com KMS própria por fluxo e rotação. TLS pelo endpoint privado. |
| Isolamento por tenant | Não muda (RLS e `withTenant` já revisados). |
| Controle de acesso | Papéis executor e entrega separados (#204). A tarefa da recuperação não lê. A key policy limita quem decifra. |
| Log de auditoria | Trilha com ator sistema; log de segurança; CloudTrail com `SourceIdentity`; alertas de execução, de entrega lida e de entrega vencida (#204). |
| Retenção | `Expiration` de 72 h e 24 h, e apagamento na falha. Prontuário (20 anos) não é tocado. |
| Segredos fora do código | Conforme. A chave vem do Terraform. Os testes usam conta `000000000000` e token fictício. gitleaks verde. |
| Dados reais fora do git e de prompts | Conforme. |
| CFM/ANS/ICP-Brasil | Não se aplica. |
| CI | Lint, typecheck e testes, CodeQL, gitleaks e ofensivos verdes. **RLS, Build/Trivy, Carga e Playwright pendentes** na hora desta revisão: o merge espera esses checks. |
