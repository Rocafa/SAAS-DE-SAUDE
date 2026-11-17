# Parecer do Guardião LGPD: código do endurecimento do 3b antes do 3c (PR #161)

> Data: 06/11/2026. Branch: `eng/better-auth-endurecimento`, base `eng/better-auth-desligamento` (#160). O PR fecha R3 a R8 do parecer do código do 3b-2 (`2026-11-06-codigo-better-auth-pr3b2.md`) e R2, R3, R4 e R6 do parecer do código do 3b-3 (`2026-11-06-codigo-better-auth-pr3b3.md`). Revisão estática do diff `origin/eng/better-auth-desligamento...origin/eng/better-auth-endurecimento`. O CI do PR passou (16/16), segundo o pedido. A bancada não rodou aqui.

## Veredito: **APROVADO COM RESSALVAS.** Nada bloqueia o merge. As ressalvas abaixo são pequenas: R1 e R2 entram junto com o 3c, R3 e R4 vão para a fila.

Conferi também a R1 do 3b-3, corrigida no #160 (`bbb1737` e `dace79e`): `inativa_por` com CHECK de coerência, reativação só da conta `sem_vinculo` e concessão à conta `anonimizada` recusada no banco, com teste. Está **resolvida**.

| Ressalva | Situação |
|---|---|
| **3b-2 R3** (origem) | `fator-origem` ou `login-origem` com `TETO_DE_FALHAS_POR_ORIGEM`. A origem vem do cabeçalho que o **servidor** monta (a rota cria `Headers` novos, só com o user agent e a origem calculada) e é validada como 16 hex. ✅ |
| **3b-2 R4** (store fora) | `reservarVarias` **falha fechada** (`indisponivel`, 503), devolve as reservas já feitas e alarma. ✅ (ver R2) |
| **3b-2 R5 e 3b-3 R4** (vínculo e admin no uso) | `vinculoEAdminSeguemAtivos` confere, sob RLS na clínica do token, o vínculo ativo da pessoa e se quem emitiu continua admin. Senão, 404. Isso também fecha o desligamento parcial. ✅ |
| **3b-2 R6** (atomicidade) | Consumir o token, trocar a senha ou apagar o fator e derrubar as sessões acontecem numa **única** transação do `app_auth`. O hash é calculado antes. `RECUPERACAO_USADA` sai antes da trilha. Se a trilha falhar, o evento já saiu. ✅ |
| **3b-2 R7** (retenção) | O expurgo diário apaga os tokens vencidos há mais de 30 dias. A 0070 dá `DELETE` só nessa tabela. ✅ |
| **3b-2 R8** (testes) | Token vencido dá 404. De dois usos em paralelo, só um passa. 5 códigos errados bloqueiam, até o certo, e a senha não muda. ✅ |
| **3b-3 R2** (aceite pelos contadores do login) | E-mail e origem, depois pessoa e origem, com falha fechada e os eventos `LOGIN_FALHOU`, `LOGIN_BLOQUEADO`, `MFA_FALHOU` e `MFA_BLOQUEADO`. ✅ (ver R1) |
| **3b-3 R3** (prova da anonimização) | `CONTA_ANONIMIZADA` e `account_anonymized`, só com o id, nas clínicas do vínculo. As clínicas são lidas **antes** de anonimizar. A conta fica `inativa_por = 'anonimizada'`. Há teste da linha na trilha. ✅ |
| **3b-3 R6** (tempo de resposta) | E-mail inexistente gasta o mesmo `gerarHashDeSenha`. ✅ |

## Ressalvas

### Junto com o 3c

1. **O aviso aos admins não sai quando o fator tranca pelos caminhos próprios.**
   - **O problema:** a R2 do 3b-3 pedia também o `avisarFatorBloqueado` no aceite e na recuperação. Hoje, quando `reservarVarias` devolve `bloqueado` no contador `fator:<userId>`, o `conferirCredenciais` só registra `MFA_BLOQUEADO`, e o `usarRecuperacao` não registra **nada**. O `usarRecuperacao` também não emite `MFA_FALHOU` nem `LOGIN_FALHOU` quando a credencial está errada. Assim, as tentativas com o token de recuperação ficam fora da vigilância. É justamente o caminho de quem tem o token.
   - **Correção:** ao travar o contador por pessoa, chamar `avisarFatorBloqueado(userId)`, que já limita a 1 por dia. Emitir `MFA_FALHOU` ou `LOGIN_FALHOU` em cada falha do `usarRecuperacao`.
2. **Nome do alarme na falha fechada.** O `reservarVarias` registra `RATE_LIMIT_FAIL_OPEN` com motivo `bloqueio_do_fator`, mesmo quando falha **fechado** e mesmo quando o contador é o do login. Quem atender o alarme lê "seguiu sem bloqueio", o que não é verdade aqui. Criar `RATE_LIMIT_FAIL_CLOSED` (ou um motivo `falha_fechada`) e passar o motivo certo, login ou fator. Vale um teste com o store derrubado, que dê 503 e não troque nada.

### Fila

3. **Senha nova inválida conta como tentativa.** Na recuperação de senha, `senhaNova` com menos de 12 caracteres entra no `confere = false` e gasta uma das 5 tentativas do fator. Não é falha de segurança, mas a pessoa pode se bloquear errando o tamanho da senha. Validar o tamanho antes de reservar, como fazia a versão anterior.
4. **Itens já na fila, sem mudança:** o `email_hmac` dos convites na anonimização (R3 do 3b-1); R9, R10, R12 e R13 do 3b-2; R5 e R7 do 3b-3.

## Conferido sem achado

| Item | Situação |
|---|---|
| Base legal e minimização | Sem dado novo. Os eventos levam o `userId` e a origem em HMAC, nunca o e-mail. A trilha da anonimização leva só o id. ✅ |
| Isolamento | A conferência no uso é feita sob RLS na clínica do token. As outras clínicas recebem só `credential_changed` ou `account_anonymized`. ✅ |
| Controle de acesso | O token só vale com vínculo ativo e com o emissor ainda admin. A conta inativa ou anonimizada recebe `invalido`. ✅ |
| Log de auditoria | A trilha e os eventos estão em ordem (o evento sai antes da trilha). ✅ |
| Retenção | Tokens apagados em 30 dias. A trilha segue a regra de 20 anos da clínica. ✅ |
| Segredos e dados reais | Sem mudança. Só dados fictícios na bancada. ✅ |
| CFM, ANS e ICP-Brasil | Não toca prontuário, TISS nem assinatura. ✅ |

## Nota do Maestro (06/11/2026)

- **R1 corrigida.**
  - Na recuperação, credencial errada gera `MFA_FALHOU` ou `LOGIN_FALHOU`, e a tentativa barrada gera `MFA_BLOQUEADO` ou `LOGIN_BLOQUEADO`.
  - Fator trancado, pelo token ou pelo aceite, avisa os admins (`avisarFatorBloqueado`).
- **R2 corrigida.** Evento novo `BLOQUEIO_INDISPONIVEL` (alto, alarme imediato), com o motivo do contador (login ou fator), no caminho que falha fechado. Teste novo: com o contador fora do ar, a recuperação responde "indisponível" e o TOTP continua lá.
- **R3 corrigida.** Entrada mal formada (senha nova curta, código ausente, senha atual ausente) é recusada antes de contar a tentativa.
- **R4 (fila):** os itens anteriores continuam em `docs/00-governanca/fila.md`.
