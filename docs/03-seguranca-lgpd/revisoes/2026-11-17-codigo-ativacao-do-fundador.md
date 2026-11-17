# Parecer do Guardião LGPD: código do PR 2 do provisionamento (#203, ativação do fundador e fundação pelo sistema)

- **Data:** 17/11/2026
- **PR:** #203 (`eng/ativacao-do-fundador` → `eng/recuperacao-admin-unico`), commit `d523dc0`
- **Base:** pareceres `2026-11-16-desenho-provisionamento-da-clinica.md` (R1 a R10) e `2026-11-16-codigo-provisionamento-pr1.md` (C1 a C4, reconferência de 17/11)
- **Escopo:** migração 0078, `membros.ts`, `provisionamento.ts`, `ativacao.ts`, `provedor.ts` (`usarAtivacao`, `consumirAtivacao`, `clinicasDoUsuario`), log de segurança, lista de cobertura e `test/ativacao-do-fundador.rls.test.ts`

## Veredito: **APROVADO COM RESSALVAS**

**Condições para o merge:**

1. O job "Isolamento entre tenants (RLS)" do #203 precisa terminar verde. Ele estava *pending* quando conferi, e é nele que roda `ativacao-do-fundador.rls.test.ts`.
2. Os testes precisam deixar de passar por erro genérico (**T1**).

Os demais achados entram como condição no PR 3 (expurgo) ou ficam como observação.

R4, R5, R7 (C2), C3 e R9 estão atendidos no código. C1 continua valendo enquanto a linha de ativação existir. A 0078 não abre porta nova para fundar clínica: quem consegue gravar a trilha do provisionamento já conseguia fundar clínica com qualquer fundador antes dela (detalhe em **A1**).

## Conferência

| Item | Situação | Onde |
|---|---|---|
| R4: mesmo 404 | Token mal formado, inexistente, vencido, usado, bloqueado, e-mail diferente, conta inativa, fundador que não confere, bloqueio por origem e e-mail tomado: todos saem como `'invalido'` e viram `NaoEncontradoError`. O motivo fica só no log de segurança. As respostas que não são 404 (`codigo_obrigatorio`, `senha_vazada`, `nome_obrigatorio`, `credencial_errada`) só aparecem depois de token **e** e-mail conferidos. A validação de formato (`email_invalido`, `senha_curta`) roda antes do token e não depende dele. | `provedor.ts:751-800`; `ativacao.ts:65-66` |
| R4: oráculo por tempo | O caminho "token válido + e-mail errado" faz um UPDATE a mais que o do token inexistente. Para medir essa diferença, o atacante precisa ter o token (256 bits). A comparação do HMAC usa `timingSafeEqual`. Não há oráculo útil de existência. | `provedor.ts:785` |
| R4: contador por ativação e bloqueio na 5ª | `falhas + 1` é atômico, com `WHERE` pendente. Na 5ª falha o `email_hmac` vira `EMAIL_DESCARTADO` e sai `ATIVACAO_BLOQUEADA`. O `falhas < 5` do SELECT e do consumo impede que o e-mail certo funcione depois. Tem teste. | `provedor.ts:785-799`; `.rls.test.ts:300-314` |
| R4: contador por origem | Cada tentativa reserva uma unidade no contador `ativacao-origem` (teto 30). A reserva só volta quando o e-mail confere. Bloqueada, a resposta é 404. | `provedor.ts:761-768, 800` |
| R4: 503 sem Redis | `reservarVarias` devolve `indisponivel` → 503, com `BLOQUEIO_INDISPONIVEL`, sem gastar o token. Tem teste. | `provedor.ts:763`; `ativacao.ts`; `.rls.test.ts:361-379` |
| R4: consumo atômico | `UPDATE ... WHERE usado_em IS NULL AND expira_em > now() AND falhas < 5 RETURNING`, na mesma transação que cria a conta. Duas tentativas simultâneas se serializam pela trava da linha, e a segunda recebe 0 linhas. | `provedor.ts:851-870`; `.rls.test.ts:381-386` |
| R5: senha vazada | Conferida antes do consumo: dá 409 `senha_vazada` e o token continua válido. Se a conferência estiver indisponível, segue o padrão D, com `CONFERENCIA_DE_SENHA_INDISPONIVEL`, igual aos outros caminhos. | `provedor.ts:823-831`; `.rls.test.ts:350-359` |
| R2: conta existente | Exige senha e TOTP por `conferirCredenciais`, com os contadores de login e de fator e falha fechada. Confere `login.userId === a.usuarioId` e recusa conta inativa. Devolve `cookies: []`: não abre sessão de cadastro nem sessão comum. Tem teste. | `provedor.ts:804-819, 842`; `.rls.test.ts:278-298` |
| R7 / C2: ator sistema | `tenant_create` e `member_found` saem com ator sistema e metadata fechada `{op, via, contract}`, sem operador. O contrato é validado também na escrita. `founder_activated` sai com o fundador como ator. | `membros.ts:203-214`; 0078:30-43; `.rls.test.ts:190-206, 262-265` |
| R8: fundador admin ativo na clínica do token | Conferido dentro de `withTenant` da clínica. Se não confere, `FundadorNaoConfere` desfaz tudo e devolve 404. | `provedor.ts:876-885` |
| C3 | `clinicaJaAtivada` usa a trilha `founder_activated` ou `clinica_de_origem`. Tem teste com a linha expurgada. | `provisionamento.ts:96, 144`; `.rls.test.ts:389-409` |
| Resíduo de C1 | `clinicasDoUsuario` tira as clínicas com ativação pendente. A escolha automática volta para quem já tinha uma clínica. | `provedor.ts:1146-1160` |
| C1 | Continua valendo: a clínica fica fora do alcance com `usado_em IS NULL`, o que inclui a ativação vencida e a bloqueada (`falhas = 5`). | `provedor.ts:213-219, 1155-1159` |
| R9: eventos | `ATIVACAO_FALHOU`, `ATIVACAO_BLOQUEADA` e `FUNDADOR_ATIVADO` estão na lista fechada, sem e-mail, nome ou token. Tem teste. | `log-de-seguranca.ts`; `.rls.test.ts:266-273, 311` |
| Cobertura de auditoria | `POST /ativacao/usar` entrou em `AUDITADAS`. | `cobertura-auditoria/lista.ts` |

## Achados

### A1. 0078: quem consegue gravar a trilha `via = 'provisionamento'`? (observação, não bloqueia)

- **Resposta:** qualquer conexão com o papel `app_user`. A 0019 dá `EXECUTE` em `app_set_system_user()` para o `app_user` (0019:92). `recordAudit` grava `actor_kind = 'sistema'` sempre que o ator é o sentinela. O próprio teste prova isso: grava a trilha à mão como `app_user` e funda a clínica (`.rls.test.ts:212-231`). Portanto a 0078 é **prova de consistência** (a fundação pelo sistema sempre deixa a trilha certa), **não controle de autorização**.
- **Por que não abre brecha nova:**
  - antes da 0078, o mesmo `app_user` já fundava clínica com **qualquer** fundador, chamando `app_set_user(<uuid da vítima>)`, que só recusa o sentinela (0019:27-29);
  - nenhuma rota HTTP chega a `criarClinica` com `provisionamento`. O único chamador com esse campo é a tarefa (`provisionamento.ts:157`), e `MembrosService.criarClinica` só é usado na bancada (`test/apoio-api.ts:83`);
  - o portão real é o IAM da tarefa (R7 e C4: grupo nominal com MFA, sem `iam:PassRole` no papel da API).
- **Recomendação (PR que ligar o SSM ou depois):**
  - papel de banco próprio para a tarefa (`app_provisionamento`, com `NOINHERIT` e só os grants da 0078);
  - a 0078 passa a exigir `pg_has_role(session_user, 'app_provisionamento', 'MEMBER')` na fundação pelo sistema, no mesmo padrão da 0047 com `app_migrator`.
  - Com isso, um comprometimento da API deixa de conseguir fundar clínica "pelo provisionamento". Registre no RIPD como risco residual até lá.
- **Resíduo antigo, não introduzido aqui:** na sessão de sistema, `INSERT` em `tenants` com `founder_user_id NULL` passa sem trilha (0078:55, `IS NOT NULL AND ...`). Já era assim na 0047. Sugiro fechar no mesmo ajuste: na sessão de sistema, `founder_user_id` passa a ser obrigatório.

### A2. A clínica fica fora do alcance só enquanto a linha de ativação existir (média; condição para o PR 3)

- C1 e o resíduo dependem de haver linha com `usado_em IS NULL` (`provedor.ts:219, 1159`).
- Quando o expurgo de 30 dias do PR 3 apagar a linha **vencida ou bloqueada e nunca usada**, o fundador com conta existente passa a ver a clínica e entrar como admin **sem ter ativado**, ou seja, sem token e sem conferência do e-mail. É exatamente o cenário da C1, só que adiado.
- **Correção (no PR 3), uma das três:**
  - (a) o expurgo nunca apaga linha não usada de clínica sem `founder_activated`;
  - (b) a lápide da C3 guarda `clinica_id`, `usuario_id` e o estado;
  - (c) `clinicaLiberada` e `clinicasDoUsuario` passam a exigir a prova durável (`founder_activated` na trilha) em vez da ausência de pendência.
- **Teste:** conta existente, ativação vencida, linha expurgada → a clínica continua fora da lista e da escolha.

### A3. Dois bancos, dois COMMITs (baixa)

- `consumirAtivacao` abre a transação do `app_auth` e, dentro dela, `withTenant(dbClinica)`, que usa outro pool e outra transação. `founder_activated` é confirmado **antes** do COMMIT do `app_auth` (`provedor.ts:876-892`).
- Se o COMMIT externo falhar depois:
  - a trilha diz "ativado", mas o token não foi consumido e a conta nova não existe;
  - `clinicaJaAtivada` passa a recusar a reemissão (`ja_provisionado`), embora o token continue valendo;
  - um segundo uso grava outro `founder_activated`.
- Não dá acesso indevido. A recusa com `FundadorNaoConfere` acontece dentro da transação interna e desfaz as duas, o que está correto.
- **Correção sugerida:**
  - no runbook, explicar que `founder_activated` sem `FUNDADOR_ATIVADO` no log indica ativação incompleta;
  - ou fazer `clinicaJaAtivada` cruzar a trilha com a conta (`usuario.id` existe).

### A4. Lacuna declarada: e-mail tomado por outra conta depois do provisionamento (baixa; ajuste de log)

- **Comportamento:** a violação do índice único em `usuario.email` vira `'token_invalido'` → 404, e o token não é consumido (`provedor.ts:899`).
- **Do lado da segurança está certo:**
  - a conta que tomou o e-mail não é reaproveitada, porque a ativação procura pelo `usuario_id` reservado (`provedor.ts:802`), nunca pelo e-mail;
  - não há tomada de conta, e o fundador não é empurrado para o login de outra pessoa.
- **Impacto:** só disponibilidade. Para tomar o e-mail, alguém precisaria de um convite de outra clínica ou de outro provisionamento com o mesmo endereço.
- **Problema:**
  - o motivo no log é `token_invalido`, igual ao de um token forjado, e a equipe não consegue diagnosticar;
  - a reemissão não resolve, porque o próximo uso também viola o índice.
- **Correção:**
  - motivo próprio `email_em_uso` em `MOTIVOS_DE_SEGURANCA` no `ATIVACAO_FALHOU`;
  - entrada no runbook: cancelar o pedido e reprovisionar como conta existente, depois de confirmar fora de banda que a conta é do fundador;
  - teste na bancada.

### A5. Rate limit global por IP (observação)

- A borda tem um limitador único por IP (`http-security.ts:114-152`), sem grupo por rota. Ele **falha aberto** se o store cair. O "mesmo grupo de `/convites/aceitar` e `/recuperacao/usar`" da R4 é, na prática, esse limitador global, o mesmo das rotas irmãs.
- Isso é aceitável por três motivos:
  - o token tem 256 bits;
  - o contador `ativacao-origem` da aplicação **falha fechado** (503);
  - o contador por ativação corta em 5.
- **Pontos a acompanhar:**
  - **NAT compartilhado:** 30 falhas de uma origem bloqueiam por 404 todo mundo que sai pelo mesmo IP. É risco de disponibilidade, não de acesso;
  - **`sem-origem`:** sem `req.ip`, todas as tentativas caem no mesmo balde (`provedor.ts:761`). Um único atacante tranca a ativação para todos. Atrás do ALB isso não acontece, mas vale um alarme se `ATIVACAO_FALHOU` aparecer sem `origem`.

### T1. Testes que podem dar verde falso (condição para o merge, correção barata)

- `.rls.test.ts:226-229`: `rejects.toThrow()` aceita qualquer erro. Confira o código `42501` e a mensagem (`'clínica criada pelo sistema sem a trilha'` ou `'fundação pelo sistema sem a trilha'`). O caso `membroDe = randomUUID()` hoje falha no BEFORE do `clinic_members_guard`, não na trilha, e o teste deve dizer qual regra está provando. O caso positivo da linha 231 ajuda, mas não basta.
- `.rls.test.ts:283, 285`: `toBeInstanceOf(ConflitoError)` sem o código. Confira `conta_existente_exige_login` e `credenciais_invalidas`. Do jeito que está, um `entrada_invalida` também passaria.
- `.rls.test.ts:381-386`: confira que o perdedor da corrida rejeitou com `NaoEncontradoError` (não com erro de pool ou 23505 sem tratamento) e que existe exatamente uma conta e um `founder_activated`.

### T2. Testes que faltam (entram no PR 3, junto com A2 e A4)

- Fundador revogado ou trocado antes da ativação (`FundadorNaoConfere`) → 404, conta nova não criada, token não consumido.
- Conta existente cujo login resolve para outra conta (`login.userId !== a.usuarioId`) → 404.
- Contador por origem no teto → 404 sem tocar a linha.
- C1 depois do bloqueio na 5ª: a conta existente continua sem ver a clínica.
- Resíduo de C1: pessoa com uma clínica e uma ativação pendente mantém a escolha automática.
- Mapeamento HTTP do controller: 404, 503, token só no corpo e `exigirObjeto` recusando campo extra.

## Checklist LGPD

| Item | Situação |
|---|---|
| Base legal | Art. 7º V (execução do contrato com a clínica) para a ativação; art. 7º II e IX para contadores e log. Sem dado sensível (art. 11) no fluxo. |
| Minimização | Só o HMAC do e-mail, zerado no consumo e no bloqueio. O token fica só no corpo. Eventos só com ids, contrato e origem em HMAC. |
| Consentimento | Não se aplica (execução de contrato). |
| Criptografia | TLS na borda. HMAC com chave por uso (`ativacao-email`). Senha com o hash padrão. |
| Isolamento por clínica | `withTenant` na clínica do token. RLS intacto. A0078 só na fundação (A1). |
| Controle de acesso | R2 e R8 atendidos. C1 vale enquanto a linha existir (A2). |
| Trilha de auditoria | Ator sistema na fundação, fundador em `founder_activated`, rota na lista de cobertura. A3 é baixa. |
| Retenção | Prontuário não é tocado (20 anos). O expurgo de 30 dias do PR 3 depende de A2. |
| Segredos e dados reais | Nenhum segredo no código. Dados de teste fictícios (`@exemplo.test`). |
| CFM, ANS e ICP-Brasil | MFA desde o primeiro acesso (sessão de cadastro só para o TOTP; conta existente com TOTP). ICP-Brasil não é tocada. |
