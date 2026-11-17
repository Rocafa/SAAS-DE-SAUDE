# Parecer do Guardião LGPD: código do PR 3b-3 (desligamento, anonimização, aceite sem sessão e aviso de fator bloqueado, PR #160)

> Data: 06/11/2026. Branch: `eng/better-auth-desligamento` (`43b86cd`), base `eng/better-auth-recuperacao` (#159). Base: desenho §14.2 (R10, R11 e R18 do parecer do desenho do PR 3), R6 do parecer do código do #152 e o parecer do código do 3b-2 (`2026-11-06-codigo-better-auth-pr3b2.md`, R3, R4, R11 e R12). Revisão estática do diff `origin/eng/better-auth-recuperacao...origin/eng/better-auth-desligamento`. O CI do PR passou (16/16), segundo o pedido. A bancada não rodou aqui.

## Veredito: **APROVADO COM RESSALVAS.** A R1 entra antes do merge, porque é curta e preserva a anonimização. R2 a R4 vão antes do 3c. As demais vão para a fila.

O que está certo:
- **R10 (desligamento):** o trigger de espelho age na **mesma transação** da revogação. Ao revogar o último perfil de sessão numa clínica, ele apaga só as sessões com **essa** clínica ativa, e as das outras ficam (com teste). Sem vínculo em nenhuma clínica, a conta fica inativa e todas as sessões caem. O `resolver` e o `usarRecuperacao` já recusam conta inativa, então um token pendente morre junto.
- **R11 e R18 (anonimização):** o id continua, porque a autoria fica em `professionals` da clínica, com a retenção de 20 anos. Saem o e-mail, o nome e a imagem. A senha, o TOTP e as sessões são apagados, e os tokens de recuperação são invalidados, tudo numa transação do `app_auth` (com teste).
- **R11 do 3b-2 resolvida:** o aceite por conta existente confere a senha e o TOTP **sem abrir sessão** (`conferirCredenciais`), pelos contadores `login:<email>` e `fator:<userId>`, com reserva e devolução e com a marca de reuso. Não sobra sessão órfã. A pessoa entra depois pelo login normal. O mesmo erro serve para credencial errada e para bloqueio.
- **R6 do #152:** o fator trancado por pessoa identificada vira aviso aos admins de cada clínica dela, no máximo 1 por dia, com a regra `fator_bloqueado` na lista fechada (CHECK da 0069 e `REGRAS_DE_SEGURANCA`). Leva só ids, e o teste lê o aviso como o admin destinatário, sob RLS. Se falhar, registra `TRILHA_NAO_GRAVADA` e não derruba a resposta.
- **Conta reaproveitada:** a marca passou a ser "senha ausente". O nome e a origem são gravados depois do commit da clínica, o que evita o travamento entre as duas conexões. A R17 (a) continua atendida, porque o reaproveitamento só acontece pelo mesmo convite.

## Ressalvas

### Antes do merge

1. **A concessão reativa qualquer conta inativa, inclusive a anonimizada.**
   - **O problema:** o trigger faz `UPDATE identidade.usuario SET ativo = true` em **toda** concessão de perfil de sessão. Hoje `ativo = false` tem três causas: sem vínculo (desligamento), conta de convite desfeita e **anonimizada a pedido do titular**. Ainda virá uma quarta, a suspensão da disputa de e-mail (R17 c). O `POST /clinica/membros` aceita qualquer `usuarioId`, e a clínica conhece o id, que fica no prontuário. Assim, o admin reativa a conta anonimizada: ela continua sem credencial, mas a garantia da R11 deixa de valer, e uma conta suspensa volta a entrar. Há um efeito colateral: a conta de convite desfeita, se reativada, deixa de ser "abandonada", e o mesmo convite passa a dar `conta_existente`.
   - **Correção:** a reativação só vale para a conta desligada por falta de vínculo. Por exemplo, uma coluna `inativa_por` (`sem_vinculo`, `convite_desfeito`, `anonimizada`, `suspensa`), ou ao menos `anonimizada_em`. O trigger só reativa `sem_vinculo`, e a concessão a uma conta anonimizada é recusada (404 no `membros`).
   - **Teste:** anonimizar, conceder um perfil e conferir que a conta continua inativa e sem login.

### Antes do 3c

2. **`conferirCredenciais` perdeu o que o caminho da biblioteca tinha.** Antes, o `signInEmail` e o `verifyTOTP` passavam pela `protecao.ts`. Agora este caminho não tem:
   - os contadores **por origem** (`login-origem` e `fator-origem`), que a R15 pedia (é a mesma R3 do 3b-2, agora também no convite);
   - o alarme quando o store está fora (`count: 0` sem `RATE_LIMIT_FAIL_OPEN`, R4 do 3b-2);
   - os eventos `LOGIN_FALHOU`, `MFA_FALHOU` e `MFA_BLOQUEADO`;
   - o `avisarFatorBloqueado` quando é **este** caminho, ou o `usarRecuperacao`, que tranca o fator.

   Com isso, as tentativas pelo convite ficam invisíveis à vigilância. **Correção:** extrair a reserva, a devolução e os eventos da `protecao.ts` para uma função comum, usada pelo `conferirCredenciais` e pelo `usarRecuperacao`, que hoje duplicam a lógica. **Teste:** 5 códigos errados pelo aceite levam a `bloqueado`, ao evento e ao aviso.
3. **Anonimização sem registro.** Ela sai como `LOGOUT conta_inativa`, sem trilha. O atendimento ao pedido do titular (art. 18 IV) precisa de prova (art. 37): um evento próprio (`CONTA_ANONIMIZADA`) e uma linha, só com o id, nas clínicas do vínculo. Ao ligar a rota, ela precisa de MFA recente e de confirmação, e a pessoa não pode estar no meio de uma recuperação. O expurgo também precisa alcançar o resto do e-mail: `verificacao`, se houver linha com o e-mail, e o `email_hmac` de `team_invites` (R3 do 3b-1).
4. **Desligamento parcial deixa o token de recuperação da clínica vivo.** O desligamento total já mata o token, porque a conta fica inativa. No parcial, revogar a pessoa só na clínica A não invalida o token que A emitiu. Ele vale por até 15 min e troca uma credencial que ainda abre B. Isso cabe na R5 do 3b-2 (conferir o vínculo no uso). Basta também invalidar, no trigger ou na revogação, os tokens de `clinica_id = NEW.tenant_id` daquela pessoa.

### Fila

5. **Corrida no desligamento total.** Duas revogações simultâneas em clínicas diferentes (READ COMMITTED): cada uma vê o vínculo da outra, e a conta fica ativa sem vínculo. Não há acesso, porque o `resolver` exige perfil, mas o objetivo "conta inativa" falha. O expurgo diário pode inativar as contas ativas sem vínculo.
6. **Tempo de resposta revela o e-mail em `conferirCredenciais`.** Sem usuário, não há custo de hash. O resíduo da R18 já aceita que o convite revela a conta, e o e-mail precisa casar com o HMAC do convite. Mesmo assim, chamar `gerarHashDeSenha` quando não há usuário custa uma linha.
7. **Marca de reuso antes da conferência** em `totpDaPessoaConfere`: a mesma R12 do 3b-2.

## Conferido sem achado

| Item | Situação |
|---|---|
| Base legal | Gestão de acesso da equipe e segurança (art. 7º V e IX, art. 46). A anonimização atende ao art. 18 IV, e a retenção da autoria se apoia no art. 16 I e na regra de 20 anos do prontuário. ✅ |
| Minimização | O aviso de fator bloqueado leva só ids e a regra. A anonimização tira o e-mail, o nome e a imagem e mantém só o id. ✅ |
| Isolamento | O desligamento numa clínica não derruba as sessões das outras (teste). O aviso é gravado em cada clínica sob RLS. ✅ |
| Controle de acesso | A conta inativa não passa no `resolver` nem na recuperação. O aceite não entrega sessão. ✅ |
| Log de auditoria | Concessão e revogação seguem na trilha da clínica. `fator_bloqueado` entra na lista fechada. A anonimização é a R3. ✅ |
| Criptografia e segredos | Sem mudança. O segredo do TOTP é decifrado pela biblioteca com o `BETTER_AUTH_SECRET`, que vem do ambiente. ✅ |
| Dados reais | Só dados fictícios na bancada. ✅ |
| CFM, ANS e ICP-Brasil | O id continua ligado à autoria do prontuário (R18), com a retenção de 20 anos. Não toca TISS nem assinatura. ✅ |

## Nota do Maestro (06/11/2026)

- **R1 corrigida.** A conta guarda o motivo da inatividade em `inativa_por`: `sem_vinculo`, `anonimizada` ou `convite_desfeito`.
  - Um CHECK amarra o motivo à conta inativa.
  - O trigger reativa **só** a conta `sem_vinculo`.
  - A concessão a uma conta `anonimizada` é recusada no banco (42501).
  - A conta de convite desfeito volta apenas pelo reaproveitamento do mesmo convite, que zera o motivo.
  - Teste novo: a clínica tenta conceder perfil à conta anonimizada, e o banco recusa.
- **R2 a R4** entram antes do 3c. A R5 do 3b-2 e a R4 deste parecer já estão no PR de endurecimento (`eng/better-auth-endurecimento`): no uso do token, o vínculo e o admin são conferidos.
- **R5 a R7** vão para a fila.
