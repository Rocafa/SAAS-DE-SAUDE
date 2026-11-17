# Parecer do Guardião LGPD: expurgo das ativações do fundador (PR #205)

**Veredito: VETADO, só pelos testes.** O código fecha a A2 do parecer `2026-11-17-codigo-ativacao-do-fundador.md` pela correção (a) e não precisa mudar. Faltam dois testes que provem o que o PR afirma: a falha ao ler a trilha (V1) e a janela de 30 dias do ramo que apaga (V2). Com os dois verdes, o PR fica aprovado sem nova rodada de código.

- PR: #205, branch `eng/expurgo-da-ativacao`, base `eng/ativacao-do-fundador`.
- Revisado: `git diff origin/eng/ativacao-do-fundador...HEAD` (6 arquivos, +195/-8).
- Os testes não foram rodados nesta revisão. Os números (885/885 RLS, 1194 unidade) são os informados no PR.

## O que foi conferido

### A2: fecha

- `apps/api/src/modules/auth/better-auth/provedor.ts:470-486`: a linha **não usada** com mais de 30 dias só é apagada se `fundadorAtivadoNaTrilha` der `true`. Sem prova, ela fica e entra em `ativacoesRetidas`.
- Falha ao ler a trilha: `provedor.ts:477` trata a rejeição com `.catch(() => false)`, então a linha fica. É falha fechada correta, porque `fundadorAtivadoNaTrilha` (`provisionamento.ts:97`) é `async` e qualquer erro, inclusive do `withTenant`, vira rejeição.
- O DELETE de `provedor.ts:481-484` repete `usado_em IS NULL` e `expira_em < 30 dias` junto com o `id`. Se a linha mudou entre a leitura e o DELETE, nada é apagado.
- A prova (`founder_activated` em `audit_log`) é append-only (`guarda-schema.rls.test.ts:276`) e só é gravada pela ativação depois de conferir o token, o e-mail e a senha. Ninguém da clínica consegue forjá-la enquanto a clínica está fora do alcance.
- C3 continua com a mesma prova: `clinicaJaAtivada` agora chama `fundadorAtivadoNaTrilha` (`provisionamento.ts:113`), e a conta nascida da ativação continua servindo de alternativa.

### DELETE ao `app_auth` (0079): é o mínimo possível no desenho atual

- `apps/api/db/migrations/0079_expurgo_da_ativacao.sql:11`: o grant vale só para `identidade.ativacao_do_fundador`, como a 0070 fez em `identidade.recuperacao`. O `app_user` continua sem acesso (0076:31-32).
- No nível da tabela, o grant alcança **todas** as linhas: o banco não impede o `app_auth` de apagar uma pendente de clínica não ativada. A regra está só no job. O argumento do PR procede: o `app_auth` já tem UPDATE na tabela e poderia preencher `usado_em`, e a prova está sob o RLS da clínica, fora do alcance de um trigger do schema identidade. O risco que sobra é o do papel amplo, ou seja, a A1 (`app_provisionamento`), que continua aberta.

### Retenção

- Linha usada: o HMAC já é zerado na ativação, e a linha é apagada 30 dias depois do uso (`provedor.ts:466-469`).
- Linha vencida: o HMAC é zerado na primeira rodada diária depois do vencimento (`provedor.ts:459-465`), ou seja, até cerca de 24 h depois. Como o token já não serve, isso é aceitável.
- Linha bloqueada: o HMAC já é zerado no bloqueio. `expira_em` como marco está correto, porque o CHECK de 72 h da 0076:27 garante que ela vence no máximo 72 h depois de emitida.
- Linha retida (A2): fica **sem prazo**, com `usuario_id`, `clinica_id`, `contrato`, `token_hash` e o HMAC zerado. Não há identificador direto e a finalidade é legítima (manter a clínica fora do alcance), mas o prazo indefinido precisa estar no RIPD e ter um destino (R1).
- Trilha (`founder_activated`) e eventos: seguem a retenção da trilha. Prontuário não é tocado (20 anos).

### Trilha do próprio expurgo

- Zerar o HMAC gera `ATIVACAO_VENCIDA` (`provedor.ts:465`), uma vez por linha graças ao filtro `ne(email_hmac, EMAIL_DESCARTADO)`. Leva só `tenantId` e `pedido`, os dois na lista fechada (`log-de-seguranca.ts:165, 183`). O teste confere que não vai `@` nem `userId`.
- As linhas apagadas e retidas saem só como contagens no resultado do job, que é da plataforma e não tem trilha de clínica (`registro-de-jobs.ts:126-128`). É o mesmo padrão da `recuperacao` (0070), e é suficiente porque a linha não traz identificador direto e o fato relevante (`founder_activated`) fica na trilha da clínica.
- Uma retenção causada por **falha de leitura** não se distingue de uma por **clínica nunca ativada** (R2).

## Vetos (bloqueiam o merge)

### V1. A falha ao ler a trilha não tem teste

- O PR afirma que a linha fica se a leitura da trilha falhar (descrição e `provedor.ts:455`), mas nenhum dos 5 testes passa por `provedor.ts:477`.
- **Correção:** em `apps/api/test/ativacao-do-fundador.rls.test.ts`, usar uma clínica **com** `founder_activated` e a linha pendente envelhecida 40 dias, como no teste de `:683`. Rodar o expurgo com um provedor cujo `dbClinica` falhe (por exemplo, um handle de `createDatabase` já fechado, ou um `withTenant` que rejeita). Esperar a linha intacta e `ativacoesRetidas >= 1`. Depois, rodar com o provedor normal e esperar a linha apagada. O teste usa clínica com prova de propósito: assim só a falha de leitura explica a linha ter ficado.

### V2. "Dentro dos 30 dias nada é apagado" não prova a janela do ramo que apaga

- `ativacao-do-fundador.rls.test.ts:668-681`: a vencida há 29 dias é de clínica **sem** `founder_activated`, e a A2 a reteria com qualquer idade. O teste passaria mesmo se o corte de `provedor.ts:473` (`expira_em < 30 dias`) fosse removido.
- **Correção:** acrescentar uma pendente de clínica **com** `founder_activated` (montada como em `:683-690`), envelhecida 29 dias, e esperar que ela continue lá. A usada há 29 dias já cobre a janela do outro ramo.

## Recomendações (não bloqueiam)

- **R1. Destino da linha retida.** Registrar no RIPD da identidade e em `docs/04-arquitetura/provisionamento-da-clinica.md` que a linha não usada de clínica nunca ativada fica sem prazo, enquanto a clínica existir. Levar ao runbook do PR que o tira de fora (A3/A4) o caminho de encerramento da clínica nunca ativada (contrato desfeito): reemissão ou desativação da clínica, e só então o expurgo.
- **R2. Retenção por falha precisa aparecer.** Contar à parte (por exemplo, `ativacoesSemLeituraDaTrilha`) e emitir `TRILHA_NAO_GRAVADA` ou um evento próprio de alarme por volume quando a leitura falhar. Sem isso, um erro permanente de papel ou de RLS faz as linhas de clínicas ativadas se acumularem sem prazo e sem sinal (`provedor.ts:477`).
- **R3. "Uma vez por linha" sem prova.** No teste A2, a segunda rodada (`:647-650`) só confere a linha. Envolva-a em `eventosDurante` e espere zero `ATIVACAO_VENCIDA`.
- **R4. Guarda dos grants do `app_auth`.** `guarda-schema.rls.test.ts` só confere o `app_user`. Uma asserção de que, no schema identidade, o `app_auth` só tem DELETE nas tabelas permitidas (`recuperacao`, `ativacao_do_fundador` e as do Better Auth) evita que um grant futuro passe sem ninguém ver.
- **R5. A1 continua aberta.** O papel dedicado `app_provisionamento` é o que reduziria de verdade o alcance do DELETE e do UPDATE nesta tabela.

## Checklist LGPD

| Item | Situação |
|---|---|
| Base legal | Execução de contrato (art. 7º V) e legítimo interesse em segurança (art. 7º IX). Não há dado de saúde (art. 11). |
| Minimização | HMAC zerado no uso, no bloqueio e no vencimento. A linha retida não tem identificador direto. |
| Consentimento | Não se aplica. |
| Criptografia | Sem mudança: só o hash do token e o HMAC, que acaba zerado. |
| Isolamento por tenant | A prova é lida com `withTenant` da clínica. O schema identidade continua fora do `app_user`. |
| Controle de acesso | A2 fechada pela correção (a). DELETE só nesta tabela. O papel amplo (A1) continua aberto. |
| Log de auditoria | `ATIVACAO_VENCIDA` com campos da lista fechada. Expurgo em contagens, como na 0070. A retenção por falha não aparece (R2). |
| Retenção | 30 dias para a usada e para a pendente de clínica ativada. Sem prazo para a pendente de clínica nunca ativada (R1). Prontuário não é tocado. |
| Segredos e dados reais | Nada no código. Dados fictícios (`@exemplo.test`). |
| CFM, ANS e ICP-Brasil | Não são tocados. |

## Reconferência (17/11, commit `da0041b`)

**Veredito: APROVADO.** V1 e V2 estão fechados por testes que falhariam se o código regredisse. R1, R2 e R3 foram feitos. R4 e R5 continuam abertos, fora deste PR.

- Revisado: `git diff c5d9f2d..HEAD` (5 arquivos, +101/-17) e a resposta no PR.
- Os testes não foram rodados nesta reconferência. Os números (886/886 RLS, 1194 unidade) são os informados no PR.

### V1: fecha

- O teste "V1/R2" usa uma clínica **com** `founder_activated` e a linha envelhecida 40 dias, como pedido. O `dbClinicaSemLeitura()` faz todo `select` dentro da transação lançar erro. Com isso, `withTenant` rejeita, `fundadorAtivadoNaTrilha` rejeita e a rejeição passa pelo `.catch(() => null)` de `provedor.ts:482`, exatamente o caminho que estava sem teste.
- O teste confere que a linha fica, que `ativacoesRetidas` e `ativacoesSemLeituraDaTrilha` são `>= 1` e que sai **um** `TRILHA_NAO_LIDA` com aquele `pedido`, o motivo da lista fechada, o `tenantId` e nenhum `@`. Depois, o provedor normal apaga a mesma linha. Se o `catch` voltasse a dar `true`, ou se a falha apagasse a linha, o teste falharia.

### V2: fecha

- `recente` (29 dias) e `antiga` (31 dias) são pendentes de clínica com prova, então só o corte de `expira_em < 30 dias` separa as duas. Sem o corte, `recente` seria apagada e o teste falharia. A `antiga` mostra que o ramo que apaga funciona no mesmo teste.

### R1, R2 e R3: feitos

- R1: a linha nova do RIPD-identidade §3 e a do desenho registram a retenção sem prazo, até a ativação ou o encerramento do contrato, com os campos que ficam. O caminho de encerramento no runbook fica para o PR do runbook, como combinado.
- R2: `TRILHA_NAO_LIDA` (alto, alarme por volume) entrou na lista fechada e leva só `motivo`, `tenantId` e `pedido`. Um erro permanente gera o evento a cada rodada diária para cada linha, então o alarme por volume pega o acúmulo. A contagem à parte separa a retenção por falha da retenção da clínica nunca ativada.
- R3: a segunda rodada roda dentro de `eventosDurante` e confere que não sai `ATIVACAO_VENCIDA` para as duas linhas. Se o filtro `ne(email_hmac, EMAIL_DESCARTADO)` sumisse, o teste falharia.

### Instabilidade do V1 com expurgo concorrente

- `vitest.rls.config.mts` não desliga o paralelismo entre arquivos, e o banco é o mesmo. `contrato-provedor-better-auth.rls.test.ts` (`:811`, `:1266`, `:1276`, `:1404`, `:1418`) roda `expurgarComoSistema` com o provedor normal, e `jobs.rls.test.ts` cita `identidade-expurgo`. A linha do V1 (40 dias, clínica com prova) pode ser apagada por um desses expurgos entre o `pendenteDeClinicaAtivada(40)` e a rodada sem leitura, ou entre essa rodada e o `linhaDa`. Aí o teste falha: falta a linha e falta o `TRILHA_NAO_LIDA`.
- A falha só pode dar **vermelho falso**, nunca verde falso. Nenhum expurgo concorrente recria a linha nem emite `TRILHA_NAO_LIDA` neste worker, porque o espião do `Logger` é por processo. Se o código regredir, o teste continua pegando. Por isso isso não bloqueia o merge. A janela tem centenas de milissegundos e coincide com poucos expurgos de outro arquivo, então a falha deve ser rara, mas pode acontecer.
- Os outros testes novos são estáveis contra concorrência: `recente` (29 dias) nenhum expurgo apaga, `antiga` (31 dias) termina apagada de qualquer jeito, e o teste da ativação incompleta espera a linha apagada.
- **R6 (não bloqueia):** serializar quem roda `expurgarComoSistema` na bancada RLS. Pode ser um `pg_advisory_lock` comum num helper usado pelos três arquivos ou `fileParallelism: false` só para esses arquivos. Se o V1 falhar de forma intermitente na CI, a causa é esta e não o código.

### Pendências que continuam (não bloqueiam)

- R4 (guarda dos grants do `app_auth`), R5 (A1, `app_provisionamento`), R6 (acima) e o caminho de encerramento da clínica nunca ativada no runbook (R1).
