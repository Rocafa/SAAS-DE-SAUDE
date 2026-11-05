# Parecer do Guardião LGPD: recusa por MFA em rota comum e alvos distintos (PR #153)

> Data: 05/11/2026. Branch: `eng/mfa-recusa-rota-comum` (base `main`). Base: R5 e a nota (a) da R9 do parecer `2026-11-03-mfa-politica.md`, R14 do parecer do desenho do Better Auth (`2026-11-05-desenho-better-auth.md`) e R6 do parecer do código do PR 2 (`2026-11-05-codigo-better-auth-pr2.md`), que separou este escopo. Revisão estática do diff `origin/main...origin/eng/mfa-recusa-rota-comum` (`sessao.guard.ts`, `mfa.rls.test.ts`, fila). A bancada RLS não rodou aqui.

## Veredito: **APROVADO**, com notas de fila que não bloqueiam.

O PR fecha o que faltava da R5 do #123 e da nota (a) da R9, sem abrir caminho para inundar a trilha.

- **Rota sensível:** fica 1 linha por usuário, rota, motivo e **alvo distinto** na janela de 60 s. A mesma tentativa repetida não grava de novo.
- **Teto por usuário:** acima de 20 recusas, a resposta é 429 e nenhuma linha a mais é gravada. Sai 1 único `anomaly_alert`, agora com `distinct_targets`.
- **Rota comum:** a recusa `mfa_obrigatorio` entra **agregada**, com no máximo 1 linha por usuário e motivo a cada 60 s, e não conta para o 429.
- **Testes:** cobrem as três situações e a repetição do mesmo alvo.

## Conferência

| Item | Situação |
|---|---|
| Base legal | Trilha de acesso e de tentativa de acesso: segurança e prestação de contas (LGPD art. 6º X, art. 7º II e IX, art. 46 e art. 37). É o mesmo tratamento do B2, aprovado no #123. ✅ |
| Minimização | A linha leva só `op` (handler), `reason` e `target_id` (só se for UUID, agora validado **antes** de entrar na chave e na linha). O alerta leva só contagens. Nenhum conteúdo clínico, nome ou e-mail. As chaves do contador ficam em sha256 com prefixo da clínica (como na R9). ✅ |
| Isolamento | A contagem de `distinct_targets` roda dentro de `db.run(tenantId)`, sob RLS, e ainda filtra `tenant_id` e `actor_id` da própria sessão. Não lê linhas de outra clínica nem de outra pessoa. ✅ |
| Teto de volume | Rota sensível: no máximo cerca de 20 linhas por usuário por minuto, mais 1 alerta. Rota comum: 1 linha por usuário e motivo por minuto. Antes, cada repetição na mesma rota já era cortada; agora o corte é por alvo, que é a informação útil para a investigação. ✅ |
| Ordem do 429 | O teto do usuário agora é conferido **antes** de gravar a linha. Acima do teto, só o alerta. É o comportamento correto: a pessoa já não recebe nada (403 ou 429) e o alerta registra o volume. ✅ |
| Store fora | O store ativo é o `FallbackRateLimitStore`, que cai para a memória. O `catch → null` (grava a linha) só acontece se os dois falharem. É o mesmo comportamento aceito na R9. ✅ (nota 2) |
| Consulta da trilha | As linhas novas são `read` com escopo `mfa_denied`. A rota comum não leva `target_id`, então não aparecem no filtro por paciente. A contagem do alerta fica fora do que a clínica vê (`CHAVES_VISIVEIS`). ✅ |
| Segredos e dados reais | Só UUIDs aleatórios nos testes. ✅ |
| CFM, ANS e ICP-Brasil | Reforça a rastreabilidade de acesso ao prontuário (CFM 1.821/2007, NGS2). Não toca TISS nem assinatura. ✅ |

## Notas (fila, não bloqueiam)

1. **`distinct_targets` é aproximado.** O contador do store usa janela fixa, e a contagem no banco usa `now() - 60 s`. Como o 429 corta as linhas no teto, o valor nunca passa de 20. Alvos tentados depois do 429 não aparecem. Para investigar, o `count` e o próprio alerta bastam. Registrar no guia da trilha que `distinct_targets` é "alvos distintos registrados na janela, até o teto".
2. **Rota comum com o store fora.** Se o primário e o fallback falharem juntos, cada requisição de uma sessão sem MFA grava 1 linha. No caso do front em polling, o volume é maior do que na rota sensível. É improvável, porque o fallback é memória. Se acontecer, trocar o `catch → null` da rota comum por `registrarNoMaximoUmaVez` (memória do processo) antes de gravar.
3. **Agregação por usuário, não por sessão.** A R5 dizia "amostragem ou agregação por sessão". Agregar por usuário e motivo é mais conservador (menos linhas) e atende. Duas sessões da mesma pessoa na mesma janela geram 1 linha só, o que é aceitável. Com o id de sessão do provedor real (E9), dá para acrescentar a sessão à chave se a investigação precisar.
4. **Quando o Better Auth subir**, conferir que a sessão provisória do login com TOTP (apagada na mesma requisição) nunca chega ao guard. Pelo desenho do PR 2, ela não chega, e então não gera recusa comum espúria.
