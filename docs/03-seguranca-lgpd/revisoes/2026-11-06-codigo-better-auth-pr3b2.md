# Parecer do Guardião LGPD: código do PR 3b-2 (credenciais: troca de senha, desbloqueio, conta existente no convite e recuperação pelo admin, PR #159)

> Data: 06/11/2026. Branch: `eng/better-auth-recuperacao` (`9c87624`), base `eng/better-auth-convites` (#156). Base: §14.2, §14.4 e §14.5 de `docs/04-arquitetura/autenticacao-better-auth.md`; parecer do desenho do PR 3 com a reconferência da 3b (`2026-11-05-desenho-better-auth-pr3.md`: R1, R2, R15 a R18) e parecer do código do 3b-1 (`2026-11-05-codigo-better-auth-pr3b1.md`, R2). Revisão estática do diff `origin/eng/better-auth-convites...origin/eng/better-auth-recuperacao`. O CI do PR passou (16/16), segundo o pedido. A bancada não rodou aqui.

## Veredito: **APROVADO COM RESSALVAS.** R1 e R2 entram antes do merge (são curtas). R3 a R8 vão antes do 3c. As demais vão para a fila.

O núcleo cumpre o desenho e a reconferência da 3b:
- **R1 do desenho (nenhum token dá a conta inteira):** o token de senha exige o código TOTP atual, e o de fator exige a senha atual. O admin que vê o token não entra como a pessoa. O desbloqueio só zera contadores (e-mail, fator e a trava da biblioteca). Não troca senha nem fator.
- **R15:** o código da recuperação de senha passa pela reserva atômica em `fator:<userId>` e pela marca de reuso. A senha da recuperação de fator passa por `login:<email>`. O aceite de conta existente usa `signInEmail` e `verifyTOTP` da biblioteca, com os ganchos de bloqueio. O token é consumido por `UPDATE … WHERE usado_em IS NULL AND expira_em > now() RETURNING` **depois** de a credencial conferir. O erro é o mesmo para token inválido, vencido ou usado (404), e para credencial errada ou bloqueio (409 `credencial_invalida`).
- **R16:** no aceite, o e-mail do login é o do convite, já conferido pelo HMAC. A emissão e o desbloqueio exigem vínculo ativo na clínica do admin, conferido sob RLS. Fora disso, 404 (com teste).
- **Token:** 32 bytes aleatórios. Só o SHA-256 vai ao banco. Validade de 15 min presa por CHECK no relógio do banco. Só o `app_auth` acessa. O token nasce dentro da transação da trilha e é invalidado se ela não confirmar. Ele vai no corpo, nunca na URL.
- **TOTP fora do login (`totp.ts`):** RFC 6238 com os parâmetros do plugin (SHA-1, 6 dígitos, 30 s, ±1 passo). A comparação é em tempo constante. O segredo é decifrado pela própria biblioteca com o `BETTER_AUTH_SECRET`, que vem do ambiente. O teste usa códigos reais.
- **Troca de senha pela pessoa:** exige MFA recente, confere senha vazada, derruba as outras sessões e grava trilha em todas as clínicas da pessoa.

**Mudanças do §14.5, avaliadas:**
- **Motivo em lista fechada:** **aceito, e é melhor.** Atende à minimização (art. 6º III), porque nenhum texto livre fica para sempre na trilha. Cinco motivos bastam para a investigação.
- **TOTP antigo sai no uso do token de fator:** **aceito.** Quem fica só com a senha não usa a API, porque o MFA é obrigatório para todo perfil (`PERFIS_COM_MFA_OBRIGATORIO`), nem cadastra o fator fora da sessão pendente (R8). O pior caso é a pessoa ficar sem acesso até outra emissão, não uma brecha. O efeito é o mesmo de "só sai quando o novo for confirmado" para quem tem a senha e o token.
- **Conta existente sem TOTP não aceita convite (`conta_sem_fator`):** **aceito.** A sessão aberta pela senha é apagada (com teste).
- **Código TOTP conferido fora do login:** **aceito**, com R3 (falta o contador por origem) e R4 (falta o alarme quando o store falha).

**R2 do código do 3b-1 (aceite sem sessão de cadastro):** fica **coberta pela recuperação de fator**. Ela não exige fator anterior, só a senha, e a pessoa tem vínculo ativo porque o vínculo nasceu no aceite. O token abre a sessão pendente de 15 min. Falta o teste desse caso (R8).

## Ressalvas

### Antes do merge

1. **O uso da recuperação não chega às outras clínicas da pessoa.**
   - **O problema:** `trilhaDaRecuperacao` grava só na clínica que emitiu o token. A reconferência da 3b (R2) aprovou o desenho com esta condição: "As outras clínicas recebem só o aviso, sem detalhe". O admin de A troca a senha ou o fator de uma credencial que também abre B, e B não fica sabendo. A troca pela própria pessoa já grava em todas as clínicas.
   - **Correção:** depois do uso, gravar nas **outras** clínicas do vínculo uma linha sem tipo, motivo nem clínica de origem (ex.: `op: 'credential_recovery_elsewhere'`). Pode reaproveitar `trilhaDeSessaoNasClinicas`. Se o aviso aos admins do 3b-1 já existir, a linha vai também para ele. Incluir na lista de cobertura da auditoria.
   - **Teste:** pessoa com vínculo em A e B. O token é emitido e usado em A. B recebe a linha, sem `kind` nem `reason`.
2. **O evento de segurança da recuperação está errado e não tem alarme.**
   - **O problema:** a recuperação de fator registra `MFA_CADASTRADO`, mas nada foi cadastrado: o fator foi **removido**. Os dois usos da recuperação caem em eventos de `alarme: 'volume'`, e a emissão não gera evento. A recuperação é o caminho preferido de quem toma conta alheia. Com o nome errado, a resposta a incidente procura no lugar errado.
   - **Correção:** criar os eventos `RECUPERACAO_EMITIDA` (aviso) e `RECUPERACAO_USADA` (alto, alarme imediato), com o motivo `senha` ou `fator` na lista fechada de motivos. Tirar o `MFA_CADASTRADO` desse caminho. O `MFA_CADASTRADO` de verdade sai quando o novo TOTP for confirmado, como já acontece.

### Antes do 3c

3. **Falta o contador por origem na recuperação (R15).** A R15 pede `fator:<userId>` **e origem**. O código conta só por pessoa (`fator:<userId>` e `login:<email>`). Por token, o teto de 5 em 15 min já limita, mas quem tem vários tokens (um admin comprometido) tenta de uma só origem sem limite agregado. Incluir `fator-origem` e `login-origem`, que vêm do `CABECALHO_ORIGEM` já calculado na rota, com a mesma regra de devolução (R13 do #152). **Teste:** 5 códigos errados levam a `bloqueado`, e o código certo em seguida também é recusado. Hoje nenhum teste exercita o bloqueio na recuperação.
4. **Falha aberta sem alarme.** No `usarRecuperacao`, o `reservar` engole o erro do store (`count: 0`), e a marca de reuso também (`count: 1`). Os dois seguem sem bloqueio e **sem** `RATE_LIMIT_FAIL_OPEN`, ao contrário da `protecao.ts`. Emitir o mesmo evento. Ou, melhor neste caminho (sem sessão, com token), **falhar fechado**: recusar com 503 quando o store estiver fora. A recuperação não é urgente a ponto de dispensar o teto.
5. **Conferir o vínculo e o admin também no uso.** O convite confere, no aceite, se quem convidou ainda é admin (`exigirPerfilNoBanco`). A recuperação confere só na emissão. Se o admin comprometido for rebaixado ou a pessoa for desligada da clínica, o token ainda vale por até 15 min. No uso, abrir a transação na `clinica_id` do token e conferir as duas coisas antes de consumir. Senão, `invalido`.
6. **Passos fora de transação no uso.** A ordem é: consumir o token, gravar a senha (ou apagar o fator), apagar as sessões, gravar a trilha e só então o evento de segurança. Cada passo é um comando separado. Se a trilha da clínica falhar, a senha **já mudou** e não ficam a linha de uso nem o evento. Correção: agrupar os passos do `app_auth` numa transação e emitir o evento de segurança **antes** da trilha. Se a trilha falhar, registrar a falha no log de segurança (alarme), para não haver mudança de credencial sem rastro.
7. **Retenção de `identidade.recuperacao`.** O expurgo diário (`expurgarComoSistema`) não cobre a tabela nova. O `app_auth` não tem `DELETE` nela (0068). As linhas guardam `usuario_id`, `clinica_id` e `criado_por` sem prazo, e o fato já está na trilha da clínica. Proposta: apagar 30 dias depois de `expira_em`, com `GRANT DELETE` ao papel do expurgo, e registrar na matriz de retenção (R7 do desenho do PR 3).
8. **Testes que faltam:** (a) a R2 do 3b-1: aceite que fechou sem sessão de cadastro, depois token de fator, sessão pendente e `enable` aceito; (b) token vencido (relógio injetado) dá 404; (c) dois usos em paralelo: só um passa; (d) o bloqueio da R3.

### Fila

9. **Senha atual errada na troca não conta no bloqueio.** `POST /sessao/senha` exige sessão com MFA recente, mas a senha atual errada não entra em `login:<email>`. Quem roubou um cookie de sessão recente tenta a senha atual só sob o rate limit da borda. Contar a falha no contador de login.
10. **Vários tokens ativos por pessoa.** A emissão não invalida o token anterior da mesma pessoa e do mesmo tipo, e não há teto por admin (o convite tem, R9). Invalidar os anteriores na emissão e pôr um teto, por exemplo 10 por admin por dia.
11. **Sessão completa órfã no aceite de conta existente.** `loginCompleto` abre a sessão definitiva **antes** da transação da clínica. Se a transação falhar (convite usado em paralelo ou quem convidou deixou de ser admin), a sessão fica viva sem cookie entregue. Ela não tem uso, mas o certo é encerrá-la no `catch` (mesma linha da R7 do 3b-1).
12. **Marca de reuso antes da conferência.** Na recuperação de senha, o código é marcado como usado antes de ser conferido. Um código errado "queima" esse valor por 90 s (o real, se coincidir), e um certo seguido de `senha_vazada` obriga a esperar o próximo. É inofensivo para a segurança. Marcar só depois de conferir deixa a experiência igual à do login.
13. **Pessoa sem nenhum vínculo ativo não tem recuperação.** A R16 exige vínculo ativo na clínica do admin. Quem foi desligado de todas e perdeu a senha só volta pelo suporte. Incluir esse caso no procedimento de suporte da R17 (c) e da R18 (checklist do 3c).

## Conferido sem achado

| Item | Situação |
|---|---|
| Base legal | Senha, fator e vínculo da equipe: execução do contrato e segurança (art. 7º V e IX, art. 46). Não é dado de saúde. ✅ |
| Minimização | O token guarda só o hash. A trilha leva só ids, tipo e motivo de uma lista fechada. Os contadores usam HMAC, nunca o e-mail em claro. O log de segurança leva o `userId` e a origem em HMAC. ✅ |
| Isolamento | A emissão e o desbloqueio são feitos sob RLS na clínica do admin, com 404 fora dela (teste). A tabela fica no schema `identidade`, só para o `app_auth`. A pendência entre clínicas é a R1. ✅ |
| Controle de acesso | `cadastros:gerir`, o perfil `admin` no banco e o MFA recente na emissão e no desbloqueio. A troca de senha exige MFA recente. A rota de uso, sem sessão, fica sob o rate limit e o CSRF da borda, e a origem é calculada no servidor. ✅ |
| Criptografia | O TLS vem da borda. O segredo TOTP é cifrado em repouso pela biblioteca, e a chave fica no ambiente. A senha usa o hash da plataforma (`gerarHashDeSenha`). ✅ |
| Log de auditoria | Na clínica: `credential_recovery_issued`, `credential_recovery_used`, `member_unlock` e `password_changed` (em todas as clínicas). A propagação da recuperação é a R1, e a ordem dos passos é a R6. ✅ |
| Segredos e dados reais | `BETTER_AUTH_SECRET` e a chave HMAC vêm do ambiente. O token nunca vai a log. A bancada usa só dados fictícios. ✅ |
| Retenção | A trilha segue a regra de 20 anos da clínica. A tabela de tokens é a R7. ✅ |
| CFM, ANS e ICP-Brasil | Não toca prontuário, TISS nem assinatura. O MFA obrigatório continua valendo para todo perfil (NGS2). ✅ |

## Nota do Maestro (06/11/2026)

- **R1 corrigida.** O uso da recuperação grava `credential_changed`, sem tipo nem detalhe, nas DEMAIS clínicas da pessoa, além da linha com o tipo na clínica que emitiu. Tem teste com vínculo em duas clínicas.
- **R2 corrigida.** Eventos novos: `RECUPERACAO_EMITIDA` (aviso) na emissão e `RECUPERACAO_USADA` (alto, alarme imediato) no uso. O evento sai antes da trilha, e o `MFA_CADASTRADO` incorreto saiu.
- **R11** deixa de existir no 3b-3 (#160 ou seguinte): o aceite de conta existente passa a conferir senha e TOTP **sem abrir sessão**.
- **R3 a R8** entram antes do 3c, e **R9, R10, R12 e R13** vão para a fila (registrados em `docs/00-governanca/fila.md`).

## Reconferência (06/11/2026, commit `1dc015e`)

### Veredito: **R1 e R2 resolvidas. APROVADO COM RESSALVAS** (R3 a R8 antes do 3c; R9, R10, R12 e R13 na fila; a R11 sai no 3b-3).

- **R1: resolvida.** `trilhaDaRecuperacao` grava `credential_changed` nas **demais** clínicas da pessoa. A linha vai sem tipo, sem motivo e sem a clínica de origem, e a linha com o tipo fica na clínica que emitiu. O teste com vínculo em duas clínicas confere que a linha existe e que não traz `kind`.
- **R2: resolvida.** `RECUPERACAO_EMITIDA` (aviso) sai na emissão. `RECUPERACAO_USADA` (alto, alarme imediato) sai nos dois usos, **antes** da trilha, e o `MFA_CADASTRADO` incorreto saiu. Isso também cobre parte da R6: se a trilha falhar, o evento já saiu.
- **Detalhe sem efeito no veredito:** `RECUPERACAO_EMITIDA` é registrado dentro da transação. Se ela não confirmar, o token é invalidado, mas o evento fica. É um falso positivo inofensivo para a vigilância. Se quiser, mover o evento para depois do `escreverNaClinica`.
