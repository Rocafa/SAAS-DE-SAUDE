# Parecer do Guardião — desenho da anonimização de conta pelo suporte

> 12/11/2026 · Guardião LGPD & Segurança · parecer de **desenho** (sem código), branch `eng/hmac-por-uso`.
> Objeto: [`docs/04-arquitetura/anonimizacao-pelo-suporte.md`](../../04-arquitetura/anonimizacao-pelo-suporte.md).
> Base: [`RIPD-identidade.md`](../RIPD-identidade.md) §3 e §5 item 2; [`runbook-fundador-clinicas-existentes.md`](../../04-arquitetura/runbook-fundador-clinicas-existentes.md) (padrão de procedimento operacional); `apps/api/src/modules/audit/ator-suporte.ts` (Decisão 1 do #57); `autorizacao-suporte.ts` (0059).

## Veredito: **APROVADO COM RESSALVAS**

A lacuna é real e o caminho (comando operacional, sem rota) está certo. O desenho não vira código como está: ele **descreve errado o ator da trilha atual** (R1), propõe gravar o **id cru do operador** na trilha da clínica, o que contraria a Decisão 1 (R2), e promete uma **idempotência que o método não tem** (R3). As ressalvas abaixo são condição para o PR de código.

## Conferência no código

- `grep -rn anonimizarConta` (fora de `node_modules`): só a definição (`provedor.ts:845`) e chamadas em `test/contrato-provedor-better-auth.rls.test.ts`. **Nenhuma** rota, comando, job ou script. Confirmado: hoje o §5 item 2 do RIPD descreve um procedimento que não existe.
- Trilha `account_anonymized` (`provedor.ts`, laço de `clinicasAntes`): grava com `recordAudit(tx, { userId: <o próprio titular> })`, então `actorKindOf` dá `usuario_clinica` e o **ator é o titular**, não o sistema. O desenho diz "hoje leva só o ator de sistema": está errado. Só o `invite_pseudonym_dropped` (clínicas do espelho 0073) usa `SYSTEM_ACTOR_ID`.
- Ordem real: (1) transação no `identidade` (nome, e-mail, senha, TOTP, sessões, recuperação); (2) evento `CONTA_ANONIMIZADA`; (3) por clínica com vínculo: zera HMAC do convite e grava a trilha **sem `catch`** (uma falha para o laço e o espelho não roda); (4) clínicas só do espelho, com `catch` e erro no fim; (5) apaga o espelho.
- Repetição: o vínculo (`identidade.vinculo`) continua, então rodar de novo refaz o passo 3 em todas as clínicas e grava **outro** `account_anonymized` em cada uma e **outro** `CONTA_ANONIMIZADA`. O `update` do passo 3 não tem o filtro `email_hmac <> EMAIL_DESCARTADO` que o passo 4 tem.
- `userId` inexistente: os `update` não tocam linha nenhuma e o método termina sem erro, e ainda grava o evento de "conta anonimizada".
- `BetterAuthProvider` depende de `d.auth` (instância do Better Auth, com `BETTER_AUTH_SECRET`). A anonimização não usa `d.auth`.

## Respostas às perguntas

**1. Tarefa avulsa do ECS ou rota interna com MFA e break-glass? Decisão: tarefa avulsa, com condições.** Uma rota cria superfície permanente na API pública para uma operação rara e irreversível. A tarefa avulsa segue o padrão do runbook do fundador (papel de operação, duas pessoas, chamado), mas o desenho precisa de três ajustes para chegar ao mesmo nível:
- **Quem roda é provado pela AWS, não declarado.** `--operador` é texto livre e não prova nada. A prova é o principal IAM do `ecs:RunTask` no CloudTrail. Só um grupo IAM nominal (`ops-lgpd`, uma pessoa por usuário, sem papel compartilhado) pode rodar esta definição de tarefa, com `aws:MultiFactorAuthPresent` na política (é o MFA da opção "rota"). O papel da API não pode ter `iam:PassRole` para o papel desta tarefa nem `ecs:RunTask` nela.
- **Duas pessoas registradas.** Quem roda e quem confere o uuid são pessoas diferentes e os dois nomes vão no chamado (como no runbook do fundador). O controle duplo verificado pelo banco (como a 0047) não é exigido agora; fica como risco residual aceito pelo DPO, com revisão quando houver mais de duas pessoas em `ops-lgpd`.
- **Sem break-glass.** Anonimizar não é urgência; não há motivo para um atalho.

**2. `chamado` e `operador` na trilha da clínica? Decisão: o chamado sim; o operador não.**
- O id do operador **não entra** no banco da clínica: a Decisão 1 (`ator-suporte.ts`) só admite a nossa equipe na trilha da clínica já pseudonimizada por clínica, e a trilha sai no pacote de exportação (G2). Também não serve usar `recordSupportAudit`: ele exige `SUP-`, motivo `pedido_da_clinica`/`break_glass` e autorização vigente da clínica (gatilho da 0059), e o pedido do titular não depende da clínica.
- Na trilha da clínica: ator **sistema** (`SYSTEM_ACTOR_ID`, `actor_kind = sistema`), metadata fechada `{ op: 'account_anonymized', ticket: 'LGPD-<n>', via: 'ops' }`, como o `member_found` do runbook do fundador. O titular deixa de figurar como ator (R1).
- O operador fica no **evento de segurança** (`CONTA_ANONIMIZADA`, com o id interno do atendente e o chamado), no CloudTrail e no chamado. É a nossa prova, 180 dias no log e o chamado com retenção própria (R7).

**3. Antes ou depois da abertura do login real? Decisão: ANTES, como item B10 do checklist, sem prazo depois.** O RIPD vai ser assinado dizendo que o procedimento existe, e um pedido pode chegar no primeiro dia com prazo curto (R6). Antes da abertura também não há conta real para testar por acidente. O B10 entra junto do B8: a fumaça do staging inclui uma anonimização de conta fictícia pelo comando real.

## Ressalvas (condições para o PR de código)

- **R1 — Corrigir o desenho e o ator.** Trocar "hoje leva só o ator de sistema" pelo fato (ator = titular) e, no código, gravar `account_anonymized` com ator sistema e `ticket` (Q2). O teste confere `actor_kind = 'sistema'` e `actor_id <> userId`.
- **R2 — Operador fora da clínica.** Nenhum id de pessoa da nossa equipe em `audit_log` da clínica (nem em metadata). Teste: a metadata do `account_anonymized` tem só as chaves `op`, `ticket`, `via`.
- **R3 — Idempotência de verdade.** (a) Conferir no início: a conta existe (senão sai com `nao_encontrada`, código ≠ 0, **sem evento**); não é `SYSTEM_ACTOR_ID`. (b) Passo 3 com o mesmo filtro `email_hmac <> EMAIL_DESCARTADO` do passo 4. (c) Por clínica, só grava `account_anonymized` se ainda não houver um daquela conta naquela clínica (a trilha é encadeada por hash: não se apaga, consulta-se antes). (d) `CONTA_ANONIMIZADA` só na primeira vez; repetição gera `ANONIMIZACAO_REPETIDA` com o chamado. (e) O passo 3 ganha o mesmo tratamento de falha do passo 4 (cada clínica isolada, erro no fim), para uma clínica com problema não deixar as outras sem trilha nem o espelho sem limpeza.
- **R4 — Ordem e saída.** A ordem do método fica (credenciais primeiro: o acesso cai antes de qualquer trilha, e uma falha depois só deixa trilha a completar, que a repetição completa). O comando: valida entradas → confere a trava → roda → **confere depois** no banco (conta `inativa_por = 'anonimizada'`, 0 sessões, 0 TOTP, senha nula, 0 linhas no espelho) e só então imprime `ok <uuid> clinicas=<n>`. Em falha imprime só um código fixo (`erro_parcial_rodar_de_novo`, `trava_incorreta`, `chamado_invalido`, `nao_encontrada`) e sai com código ≠ 0; **nunca** a mensagem ou a pilha do driver (podem trazer parâmetros da consulta). A conferência por `GET /sessao` do item 4 do desenho não funciona (as sessões foram apagadas e ninguém tem o cookie): substituir pela conferência no banco feita pelo próprio comando.
- **R5 — Segredos mínimos na tarefa.** Definição de tarefa própria, com papel de tarefa próprio e **só** as credenciais de banco (`app_auth` e `app_user`) e o que o log de segurança exigir. Não carregar `BETTER_AUTH_SECRET`, KMS do pseudônimo nem segredos de terceiros "por ser a mesma imagem". Para isso, extrair a anonimização para uma função que receba só `dbAuth` e `dbClinica` (o provedor passa a delegar para ela). `CONFIRMA_ANONIMIZACAO`, `--usuario` e `--chamado` vão parar no CloudTrail (`containerOverrides`): só uuid e número do chamado, nunca nome ou e-mail. Saída no CloudWatch com a retenção do log de segurança.
- **R6 — Prazo e fluxo do art. 18.** Escrever o prazo: enquanto a ANPD não regulamentar o art. 18 §5, prazo interno de **15 dias corridos** do recebimento (paralelo ao art. 19 II), com as datas de recebido, identidade confirmada, executado e respondido no chamado. A resposta ao titular diz o que **fica** e por quê (art. 16 I e art. 18 §4): o id da conta (autoria do prontuário, 20 anos, CFM 1.821/2007), o nome e o registro em `professionals` de cada clínica (controladora desses dados; o pedido sobre eles vai à clínica) e os eventos do log de segurança até o fim dos 180 dias (Marco Civil). Avisar as clínicas com vínculo (art. 18 §6) só com o id e o fato, sem motivo do pedido.
- **R7 — "Antes de rodar" refeito.** (a) Identidade do titular conferida como no §5 item 1 do RIPD (documento só exibido, nunca copiado). (b) Trocar "não tem obrigação de guarda que impeça" por: não há bloqueio legal ativo (ordem judicial, incidente em investigação, disputa de e-mail do item 3); a guarda do prontuário nunca impede, porque o id fica. (c) Se a conta tem **vínculo ativo**, o titular é avisado de que perde o acesso a todas as clínicas na hora. (d) Separar dois registros: o pedido no canal do DPO (tem o contato para responder; retenção definida na `matriz-retencao.md`, proposta 5 anos após o atendimento, prova do art. 37) e o chamado operacional `LGPD-<n>` (só ids, datas e nomes de quem executou e conferiu). "Sem dado pessoal no chamado" vale só para o operacional.
- **R8 — Testes (bancada RLS, conta fictícia), além dos do desenho:** conta inexistente recusa sem evento; `SYSTEM_ACTOR_ID` recusa; ator da trilha é sistema; metadata só com `op/ticket/via`; repetir não duplica `account_anonymized` nem `CONTA_ANONIMIZADA`; falha simulada numa clínica com vínculo não impede as outras e a repetição completa; a saída não contém nome nem e-mail (fixar o stdout no teste); trava com uuid diferente recusa antes de qualquer escrita.
- **R9 — Atualizar o RIPD.** §5 item 2 aponta para o runbook do comando; §5a ganha a linha "Atendimento ao titular executável" com o teste e o B10; §3 cita o prazo de R6.

## Checagens LGPD

- **Base legal:** a anonimização atende o art. 18 IV; o que fica tem base no art. 7º II (clínica, CFM 1.821/2007) e no art. 16 I. Nada do art. 11 é tocado.
- **Minimização:** melhora com R2 e R5; piora sem elas (id do operador exportado com a trilha; segredos à toa na tarefa).
- **Isolamento por clínica:** mantido (`withTenant` por clínica; espelho só da pessoa).
- **Controle de acesso:** R1 da pergunta 1 (IAM nominal com MFA, sem `PassRole` pela API).
- **Auditoria:** trilha por clínica com ator correto (R1), evento de segurança com operador e CloudTrail.
- **Retenção:** prontuário e autoria 20 anos inalterados; registro do pedido com prazo a definir (R7).
- **Segredos e dados fora do git:** o comando não recebe nem imprime dado pessoal; teste só com conta fictícia.
- **CFM/ICP-Brasil:** a autoria do prontuário não depende da conta; nenhuma assinatura é afetada.
