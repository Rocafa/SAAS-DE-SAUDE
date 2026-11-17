# Parecer do Guardião: código do provisionamento da clínica, PR 1 (#195, B11)

> 16/11/2026 · Guardião LGPD & Segurança · revisão de **código**, branch `eng/provisionamento-clinica` (diff contra `origin/eng/anonimizacao-suporte`).
> Base: parecer de desenho [`2026-11-16-desenho-provisionamento-da-clinica.md`](2026-11-16-desenho-provisionamento-da-clinica.md) (R1 a R10, branch `eng/hmac-por-uso`).
> Arquivos: `apps/api/db/migrations/0076_ativacao_do_fundador.sql`, `apps/api/src/db/identidade.ts`, `apps/api/src/modules/auth/better-auth/provisionamento.ts`, `apps/api/src/modules/auth/membros.ts`, `apps/api/src/ops/provisionar-clinica.ts` (+ `.test.ts`), `apps/api/test/provisionamento.rls.test.ts`, `apps/api/src/security/log-de-seguranca.ts`.

## Veredito: **APROVADO COM RESSALVAS** (merge liberado; a tarefa não pode rodar em ambiente nenhum até as condições C1 a C4)

O PR cumpre o que promete de R1, R2 (parte da emissão), R3, R8 e R9 (parte da tarefa). O que me impede de vetar é que a tarefa real **não roda**: `parametrosDoSsm()` devolve `null` (`provisionar-clinica.ts:147`) e a saída é `ssm_nao_configurado`. Esse fechamento é a trava de fato. Por isso as condições C1 a C4 abaixo **não bloqueiam este merge**, mas **bloqueiam o PR que ligar o cliente SSM** e o PR 2. Quem ligar o SSM sem C1 a C4 recebe veto.

## O que está conforme

| Ressalva | Evidência |
|---|---|
| R1: sem e-mail em claro nem cifrado | 0076 só tem `email_hmac` (CHECK `^[0-9a-f]{32}$`, linha 18) e `token_hash` (CHECK de 64 hex, linha 20). O teste RLS (`provisionamento.rls.test.ts:81-84`) confere que a linha não contém o token, o e-mail nem o nome. |
| R1: só `app_auth` | 0076:31-32 (`REVOKE ... FROM PUBLIC`, `GRANT SELECT, INSERT, UPDATE ... TO app_auth`). Há teste negativo para o `app_user` (`rls.test.ts:181-184`). |
| R2: conta nova não nasce no provisionamento | O uuid é reservado (`provisionamento.ts:130`) e o teste confere que não há linha em `usuario` (`rls.test.ts:86`). |
| R2: conta existente vs. nova | Busca por `lower(email)`. O `conta_existente` é calculado (`provisionamento.ts:138-139`) e testado com e-mail em maiúsculas (`rls.test.ts:125-134`). |
| R2: conta inativa recusada | `provisionamento.ts:129`, sem criar clínica (`rls.test.ts:136-143`). A anonimizada já não tem e-mail. |
| R3: token só em hash | 32 bytes aleatórios. No banco vai o SHA-256 com UNIQUE. `guardarToken` roda **dentro** da transação da linha (`provisionamento.ts:143-157`): se o SSM falha, a linha não fica (`rls.test.ts:108-123`). O token não vai para log, retorno, evento nem exceção. |
| R3: segundo parâmetro | `/provisionamento/<pedido>/entrega` (`provisionar-clinica.ts:66`). |
| R8: idempotência real | `ja_provisionado` pela PK = pedido (`:106`). A clínica já existente é reaproveitada (`:114-120`). Na corrida, o índice parcial e a PK viram `ja_provisionado` (`:160`). Há teste de repetição sem segunda clínica nem segundo token (`rls.test.ts:98-106`). |
| R8: uma pendente por clínica e 72 h no banco | Índice parcial (0076:29) e CHECK de validade (0076:27), testados (`rls.test.ts:167-179`). |
| R8: RLS da clínica | `criarClinica` roda por `withTenant(app_user)` da clínica nova. A leitura de conferência usa o usuário de sistema, só leitura (`:114`). |
| R8: saída de código fixo e trava | Uma linha só pelo Logger (`provisionar-clinica.ts:173`). A trava é conferida antes de tocar no SSM (`:100`). A mensagem do driver nunca sai (`:127-129`, `:181-184`). O teste injeta um erro com o e-mail e o token na mensagem e confere a linha (`.test.ts:109-115`). |
| R9: parâmetro apagado inclusive na falha | `finally` lógico em `:131-136`. Falha ao apagar não sai como `ok` (`.test.ts:125-129`). Há teste para cada recusa (`.test.ts:100-107`). |
| R9: eventos e campo | `CLINICA_PROVISIONADA` e `ATIVACAO_EMITIDA` estão na lista fechada. O campo `contrato` tem formato fechado (`log-de-seguranca.ts`). |
| Testes sem verde falso | Os CHECKs do banco são testados com uma violação por vez. O caminho de falha do SSM usa o banco real. Os dados são fictícios (`exemplo.test`). |

## Achados

### Condições para o PR que ligar o cliente SSM ou para o PR 2 (bloqueiam lá, não aqui)

- **C1. Fundador com conta existente vira admin ativo antes da ativação. Alto.**
  - **Causa:** `criarClinica` (`membros.ts:197`) grava `clinic_members` admin. O trigger `zz_espelhar_vinculo` (0064:112) espelha em `identidade.vinculo`. `clinicasDoUsuario` (`provedor.ts:901-903`) passa a listar a clínica nova.
  - **Efeito:** para a conta **existente**, a clínica fica acessível só com o login atual, sem token e sem conferir o e-mail. Com uma clínica só, a escolha é automática (`provedor.ts:131-137`); com várias, basta a rota de escolha do PR 3.
  - **Consequências:**
    - um e-mail digitado errado no parâmetro, que caia na conta de **outra pessoa existente**, dá a ela admin da clínica nova;
    - a ativação da conta existente (R2) perde o sentido;
    - a confirmação fora de banda da R3 deixa de ser porta.
  - **Efeito colateral de disponibilidade:** quem tinha uma clínica passa a ter duas e perde a escolha automática até o PR 3.
  - **Correção (uma das duas):**
    - (a) o vínculo do fundador nasce bloqueado: um perfil fora de `perfisNoBanco`, ou `revoked_at` preenchido até a ativação, desde que a 0022 aceite;
    - (b) `resolverSessao`/`perfisNoBanco` recusam a clínica que tem ativação pendente (`usado_em IS NULL`) para o `usuario_id` dela, com teste na bancada.
  - Isso vale também para o "admin ativo" que a R8 exige conferir na ativação.

- **C2. R7: ator e metadata da trilha.**
  - Hoje `tenant_create` e `member_found` saem com o fundador como ator e sem `{ via: 'provisionamento', contract }` (TODO em `provisionamento.ts:131-133`).
  - Aceito **só** porque a tarefa não roda. O ajuste da 0022 (ator sistema só com `via: 'provisionamento'`) e o teste "metadata só com as chaves fechadas, sem id de operador" entram **antes ou junto** do cliente SSM, nunca depois.
  - Quando o fundador é uma conta reservada, a trilha guarda como ator um uuid que ainda não tem conta. Isso é mais um motivo para o ator sistema.

- **C3. A idempotência pela clínica já existente vira reemissão depois da ativação quando a linha for expurgada (R6/PR 3).**
  - **Causa:** o ramo `existente?.fundador` (`provisionamento.ts:119`) só é barrado pelo `ja` (`:106`), que procura a linha de ativação. Quando o expurgo de 30 dias apagar a linha usada, repetir o mesmo `--pedido` emite **token novo** para uma clínica já ativada. O desenho proíbe isso (P2: "depois da ativação, não há reemissão").
  - **Correção:** o expurgo mantém uma lápide (`id`, `clinica_id`, `usado_em`, sem hash nem HMAC), ou o ramo de clínica existente só segue se a clínica nunca teve ativação usada (marca durável no `tenants` ou na trilha `founder_activated`).
  - Teste: repetir o pedido depois da ativação e do expurgo dá `ja_provisionado`.

- **C4. Requisitos do cliente SSM real (`provisionar-clinica.ts:140-149`).**
  - **`ler`:** `GetParameter` com `WithDecryption`.
  - **`gravar`:**
    - `PutParameter` `SecureString` com a chave KMS própria;
    - **política `Expiration` de 72 h** (camada Advanced). É a rede de segurança da R3, que ainda não existe;
    - `Overwrite` só no parâmetro de entrega.
  - **`apagar`:** `DeleteParameter`, que apaga também o histórico de versões. Por isso o `Overwrite` não deixa token antigo no `GetParameterHistory`.
  - **Erros:** os erros do SDK nunca são impressos.
  - **IAM:**
    - o papel da tarefa fica restrito a `/provisionamento/*`;
    - quem entrega só lê e apaga `/provisionamento/*/entrega`, nunca o parâmetro do e-mail;
    - o papel da API não tem `iam:PassRole` (R7).
  - Testes de unidade do cliente com dublê do SDK.

### Corrigir neste PR (pequenos; não impedem o merge, mas devem entrar antes do PR 2)

- **A1. Uso de HMAC compartilhado com o convite.**
  - `chaveDeHmac('convite-email')` (`provisionamento.ts:109`) faz o `email_hmac` da ativação igual ao `email_hmac` de `team_invites` para a mesma pessoa. Isso permite ligar as duas tabelas, o que o `eng/hmac-por-uso` existe para evitar. O desenho pediu derivação própria.
  - **Correção:** novo uso `ativacao-email` em `VERSOES_DE_HMAC` (`rate-limit-store.ts:144`), usado pela emissão e pela conferência do PR 2. Não há linha real, então o custo é zero agora.
- **A2. Repetir depois de falha parcial com o parâmetro refeito.**
  - O parâmetro é apagado na falha. A nova rodada exige que o operador recrie o parâmetro, e nada confere que o e-mail é o mesmo.
  - Com clínica existente e fundador de conta existente, um e-mail diferente grava o HMAC de B junto do `usuario_id` da conta de A (`:119-120`).
  - **Correção:** no ramo existente, se `contaDoFundador` existe, exigir `lower(usuario.email) = email`. Se não bate, `parametro_invalido`.
  - Documentar no runbook que `erro_parcial_rodar_de_novo` pede recriar o parâmetro.
- **A3. Correlação do evento com o CloudTrail.**
  - `CLINICA_PROVISIONADA` não leva o `pedido`. A ligação com o `RunTask` depende de recalcular `clinicaDoPedido`.
  - **Correção:** campo `pedido` (formato UUID, lista fechada) nos dois eventos.

### Observações (sem ação obrigatória)

- **O1. Id da clínica derivado do pedido: aceito.**
  - O SHA-256 com prefixo de domínio não é segredo e não precisa ser; o isolamento é a RLS.
  - Não é UUIDv5 de verdade (não usa SHA-1 nem namespace), mas o formato passa em `isTenantId`. Basta corrigir o comentário em `provisionamento.ts:72`.
- **O2. Nome da clínica no mesmo parâmetro SSM: aceito.** É o que a resposta 1 do desenho pediu. Ele só fica em `tenants.display_name`, que precisa existir de qualquer forma.
- **O3. Grants da 0076.** O `app_auth` não tem `DELETE`, então o expurgo do PR 3 precisa de grant próprio (ou da lápide da C3). Está correto por ora.
- **O4. Cobertura de log.** O teste de unidade confere a linha do comando, não o payload de `registrarEventoDeSeguranca`. Sugiro um spy na bancada que confira que nenhum evento leva e-mail, nome ou token (R9, "o log não contém"). Os formatos fechados já impedem isso por construção.
- **O5. Corrida concorrente do mesmo pedido.** O erro de PK no `tenants` cai fora do `try` (`:134`) e vira `erro_parcial_rodar_de_novo`. A falha é segura e, ao repetir, o resultado converge.

## Checklist mínimo

| Item | Situação |
|---|---|
| Base legal (art. 7º e 11) | Art. 7º V (contrato) para o e-mail e o nome. Nada do art. 11. O registro no RIPD fica para a R10 (PR 3). |
| Minimização | Conforme: HMAC e hash, sem e-mail recuperável, conta só na ativação. Ressalva A1 (uso próprio do HMAC). |
| Consentimento | Não se aplica (contrato). |
| Criptografia em trânsito e em repouso | SecureString/KMS (requisito C4), SHA-256 e HMAC no banco. Conforme. |
| Isolamento por clínica | `withTenant` e RLS. Conforme. **C1** antes de ligar a tarefa. |
| Controle de acesso | Só `app_auth` na tabela. Trava `CONFIRMA_PROVISIONAMENTO`. IAM fica com C4 e R7. |
| Log de auditoria | Eventos fechados. Ator da trilha pendente (**C2**). Correlação (A3). |
| Retenção | Prontuário não é tocado (20 anos). O expurgo de 30 dias vem no PR 3 com a **C3**. |
| Segredos fora do código e dados reais fora do git | Conforme: nenhum segredo, testes com `exemplo.test`, token e e-mail fora de argumento, log e stdout. |
| CFM, ANS e ICP-Brasil | MFA do admin desde o primeiro acesso, que depende do PR 2 e da **C1**. ICP-Brasil não é tocada. |

## Reconferência (17/11/2026)

Commits conferidos: `e2a003d` (C1) e `9da9910` (A1 a A3). O merge do #196 (trilha dos jobs de retenção) entrou no branch e não toca o provisionamento.

### Veredito: **APROVADO COM RESSALVAS**. C1 resolvida. A1 e A3 resolvidas. A2 resolvida no código, sem teste e sem runbook. C2, C3 e C4 seguem abertas e continuam bloqueando o PR que ligar o cliente SSM e o PR 2.

- **C1: resolvida (opção b).** `clinicaLiberada` (`provedor.ts:193`) recusa a clínica com ativação de `usado_em IS NULL` para aquele `usuario_id`. Conferi as rotas por onde a conta existente chegaria à clínica antes de ativar:
  - a escolha automática do `resolver` (`provedor.ts:131-137`) e a de `aposMfaVerificado` (`:1047`) passam por `definirClinica`, que chama `clinicaLiberada` (`:976`);
  - a lista e a escolha do PR 3a (`clinicasDaPessoa`, `escolherClinica`) passam pelo mesmo filtro;
  - `sessao.clinica_ativa` só é gravada por `definirClinica`, e o `SessaoGuard` não lê cabeçalho de clínica. Por isso o `resolver`, que não repete `clinicaLiberada` quando já há clínica ativa, não vira atalho.
  - As outras leituras de `clinicasDoUsuario` (`:259`, `:679`, `:894`) só gravam trilha ou aviso na clínica pendente e não dão acesso.
  - O teste de bancada cobre: fora da lista antes, dentro depois de `usado_em`.
- **Resíduo de C1 (média, entra no PR 2).** `clinicasDoUsuario` ainda conta a clínica pendente. Quem tinha uma clínica passa a ter duas e perde a escolha automática no `resolver` e no MFA (`sem_clinica`) até ativar. Isso afeta a disponibilidade, não o acesso.
  - **Correção:** a escolha automática usa a lista já filtrada (`clinicasDaPessoa` ou um filtro de pendente em `clinicasDoUsuario`).
  - **Teste:** pessoa com uma clínica e uma ativação pendente continua com escolha automática.
- **A1: resolvida.** `ativacao-email` foi incluído em `VERSOES_DE_HMAC`, e a emissão usa a chave própria. O prefixo `convite-email:` dentro de `hmacDoEmail` é só cosmético, porque a separação vem da chave. A conferência do PR 2 tem de usar `chaveDeHmac('ativacao-email')`.
- **A2: resolvida no código.** `provisionamento.ts:142` compara com o e-mail já normalizado (`:101`).
  - **Pendências:** não há teste do caso (clínica existente + conta existente + e-mail diferente dá `parametro_invalido`), e o runbook ainda não diz que `erro_parcial_rodar_de_novo` pede recriar o parâmetro. Os dois entram antes do PR 2.
- **A3: resolvida.** O campo `pedido` usa formato UUID na lista fechada e aparece em `CLINICA_PROVISIONADA` e em `ATIVACAO_EMITIDA`.
- **Não executei a bancada nesta reconferência.** A leitura é do código e do teste.
