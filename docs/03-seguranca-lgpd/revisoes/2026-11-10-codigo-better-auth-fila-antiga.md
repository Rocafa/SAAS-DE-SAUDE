# Parecer do Guardião LGPD: ressalvas antigas da fila do 3b (teto de convites, sessão de cadastro órfã, reuso do TOTP, conta ativa sem vínculo, anonimização dos convites, PR #176)

> Data: 10/11/2026. Branch: `eng/better-auth-fila-antiga` (`6243789`), base `eng/better-auth-fila-173` (#175). Base: R5 a R7 de `2026-11-05-codigo-better-auth-pr3b1.md`, R12 e R13 de `2026-11-06-codigo-better-auth-pr3b2.md`, R5 e R7 de `2026-11-06-codigo-better-auth-pr3b3.md`, `RIPD-identidade.md` §3 e §5. Revisão estática do diff `origin/eng/better-auth-fila-173...HEAD`. A bancada RLS não rodou aqui (sem Postgres). O veredito vale com o CI verde, em especial os três testes novos do `describe` "Fila do 3b".

## Veredito: **APROVADO COM RESSALVAS.** As ressalvas R5, R6 e R7 do 3b-1, R12 do 3b-2 e R7 do 3b-3 estão resolvidas. A R5 do 3b-3 e a R13 do 3b-2 estão resolvidas em parte. **G1 e G2 entram antes do merge** (são pequenas); G3 a G5 vão para a fila.

O que está certo:

- **R6 do 3b-1 ✅ (teto de convites atômico).** `pg_advisory_xact_lock(hashtextextended('convite:' || admin, 0))` logo depois de `exigirPerfilNoBanco`, antes da contagem.
  - **Deadlock:** não há ciclo. A transação de `criar` só faz leituras simples antes da trava (`temPerfilNoBanco` não usa `FOR UPDATE`) e, depois dela, só insere o convite e grava a trilha (trava `audit_chain:<clínica>`, sempre pega **depois** da `convite:`). Nenhum outro caminho pega `convite:` , então nenhum caminho espera na ordem inversa. A revogação de membro (`FOR UPDATE` em `clinic_members`) não conflita com o que `criar` segura. A espera é um comando, limitada pelo `statement_timeout`.
  - **Escopo:** o teto conta por clínica e admin; a trava é por admin, entre clínicas. Serializa um pouco mais que o necessário, sem efeito de segurança. O prefixo `convite:` não colide com `recuperacao:`, `audit_chain:`, `clinic_members:` e `portal_rights:`. Colisão de hash só serializa.
  - **Teste:** 23 criações em paralelo geram exatamente 20 linhas.
- **R7 do 3b-1 ✅ (sessão de cadastro órfã).** Se a marca `cadastro_pendente_ate` falhar, a sessão é apagada e o erro sobe; o cookie nunca chega ao cliente. A falha do `delete` é engolida, e nesse caso a sessão continua sem marca, então `cadastroLiberado` recusa o `enable` do TOTP. Sem teste (falha de banco difícil de simular); aceitável.
- **R12 do 3b-2 e R7 do 3b-3 ✅ (marca de reuso depois da conferência).** O código errado não queima o valor. O replay continua barrado: duas conferências simultâneas do mesmo código certo passam pela decifragem, mas o `hit` é atômico e só a primeira recebe `count = 1`. O `catch` do `hit` continua com falha aberta (`count: 1`), como antes (ver G5).
- **R5 do 3b-1 ✅ (runbook).** Os três efeitos da rotação da `RATE_LIMIT_HASH_KEY` estão corretos: o aceite de convite pendente vira 404 (HMAC diverge), os contadores do bloqueio recomeçam e a correlação da origem no log se quebra. A separação por HKDF continua na fila, registrada.
- **R5 do 3b-3 (conta ativa sem vínculo), em parte.** O `UPDATE` é uma só instrução com `ativo = true`, `created_at < 1 dia` e `not exists` em `identidade.vinculo` (espelho só dos vínculos **ativos**, então pega exatamente a conta da corrida). As sessões caem e o trigger da 0071 grava `inativa_desde`. Conferi os casos legítimos:
  - **Aceite de conta nova em andamento:** a conta nasce com `created_at = now()` antes do commit da clínica. O filtro de 1 dia protege. ✅
  - **Conta reaproveitada (`convite_desfeito`, `created_at` antigo):** fica `ativo = false` até `completarContaReaproveitada`, que roda **depois** do commit da clínica, quando o vínculo já está visível. ✅ (O comentário em `criarContaDoConvite` diz que "a concessão já reativou a conta (trigger da 0069)", mas o trigger só reativa `sem_vinculo`; o comentário está errado, o código está certo. Corrigir o comentário.)
  - **Conta de plataforma ou suporte:** não existe em `identidade.usuario` hoje (`disableSignUp: true`; só o convite cria conta). ⚠️ Ver G4 para o fundador da clínica.
  - **Anonimizada, expurgada, desfeita:** já estão `ativo = false`, fora do filtro. ✅
  - ⚠️ A corrida com uma concessão simultânea abre um caminho novo para o quadro "vínculo ativo em conta inativa" (G1).
- **Anonimização, em parte.** O `email_hmac` do convite aceito vira `EMAIL_DESCARTADO` na mesma transação da trilha, sob RLS da clínica, filtrando `tenant_id` e `accepted_user_id`. O valor é o mesmo do `convites-descarte`. Mas o laço só passa pelas clínicas com vínculo **ativo** (G3).

## Checklist

| Item | Situação |
|---|---|
| Base legal | Sem tratamento novo. O desligamento da conta sem vínculo e o descarte do HMAC são segurança e minimização (art. 6º III, art. 46); a anonimização atende ao art. 18 IV. ✅ |
| Minimização e retenção | O HMAC do convite aceito sai na anonimização (nas clínicas com vínculo, G3). A conta sem vínculo entra no relógio de 90 dias. ✅ |
| Consentimento | Não se aplica. |
| Criptografia | Nada novo. O TOTP continua cifrado com o segredo da instância. ✅ |
| Isolamento por tenant | O `update` de `team_invites` roda sob `withTenant` e filtra `tenant_id`. ✅ |
| Controle de acesso | O teto de convites não passa numa rajada. A sessão de cadastro órfã não fica. ⚠️ G1. |
| Log de auditoria | ⚠️ O desligamento pelo expurgo não gera evento nem trilha (G2). |
| Prontuário (20 anos) | O id da conta fica em todos os caminhos. ✅ |
| Segredos e dados reais | Nada no git. Os testes usam `@exemplo.test` e nomes fictícios. ✅ |
| CFM, ANS e ICP-Brasil | Sem mudança. A autoria clínica segue em `professionals`. |

## Ressalvas

**G1 (antes do merge). O expurgo de conta sem vínculo pode desligar quem acabou de ganhar um vínculo, e o expurgo de 90 dias não confere o vínculo.** A conta da corrida (ativa, sem vínculo, `created_at` antigo) recebe uma concessão (convite com conta existente ou `MembrosService.conceder`) no mesmo instante do job. O trigger insere o vínculo sem commit e não trava a linha de `usuario` (o `UPDATE ... WHERE ativo = false` não acha nada, porque a conta ainda está ativa). O expurgo não enxerga o vínculo e grava `ativo = false, 'sem_vinculo'`. Depois do commit da clínica, fica um vínculo ativo numa conta inativa. A pessoa não entra, e **90 dias depois o expurgo apaga senha e TOTP, libera o e-mail e troca o nome**, porque o passo de 90 dias só confere `ativo = false`, `'sem_vinculo'` e `inativa_desde`. A janela é estreita (uma vez por dia, sobre contas que já estão no estado da corrida), mas o dano é perder a credencial de quem está trabalhando.
- **Correção:**
  - No passo de 90 dias, acrescentar `not exists (select 1 from identidade.vinculo v where v.usuario_id = usuario.id)` ao `UPDATE` que grava `'expurgada'` (o que já tem a condição repetida, F1 do #175).
  - No expurgo diário, antes do passo sem vínculo, reativar a conta `ativo = false, 'sem_vinculo'` que **tem** vínculo (`ativo = true, inativa_por = NULL`; o trigger da 0071 zera `inativa_desde`). Isso corrige o quadro no dia seguinte.
- **Teste:** conta `ativo = false, 'sem_vinculo'`, com `inativa_desde` de 91 dias e um vínculo ativo; depois do expurgo, a senha continua e a conta volta a ativa.

**G2 (antes do merge). O RIPD §5 ficou com dois itens 4, e o novo descreve um caminho que não funciona antes dos 90 dias.**
- O item antigo ("**Sem vínculo em nenhuma clínica (R13 do 3b-2):** ... Vale o item 1.") continua depois do item 5. Apagar.
- O item novo diz que a pessoa desligada de todas as clínicas "recebe um convite novo e cria a credencial no aceite". Antes dos 90 dias, a conta desligada ainda segura o e-mail, `idParaContaDoConvite` responde `conta_existente` (B2: a desligada nunca é reaproveitada) e o aceite exige senha e TOTP, que a pessoa perdeu. Reescrever: **antes dos 90 dias**, convite novo com **outro e-mail**, como no item 1 (o histórico fica no id antigo); **depois dos 90 dias**, o expurgo liberou o e-mail e o convite para o mesmo e-mail cria conta nova.

**G3 (fila). A anonimização deixa de fora os convites aceitos nas clínicas onde a pessoa já não tem vínculo.** `clinicasDoUsuario` lê `identidade.vinculo`, que só tem vínculos ativos. Um convite aceito na clínica A, seguido de desligamento em A em menos de 30 dias, fica com o HMAC até o `convites-descarte` (no máximo 30 dias depois do aceite). O dano é limitado (pseudônimo, prazo curto), mas o RIPD §3 e a §14.7 dizem "na hora".
- **Correção mínima:** incluir `usuario.clinica_de_origem` no conjunto de clínicas do laço (cobre o primeiro convite, o caso mais comum) e ajustar o RIPD: "nas clínicas com vínculo ativo e na de origem; nas demais, pelo `convites-descarte` em até 30 dias".
- **Correção completa:** o job de anonimização percorre todas as clínicas como sistema (como o `convites-descarte` já faz) com o mesmo `update ... where accepted_user_id = $1`.

**G4 (fila). Sem evento nem trilha no desligamento pelo expurgo.** O job devolve só a contagem. Quem foi desligado, e quando, só aparece em `inativa_desde`. Registrar `CONTA_DESLIGADA_SEM_VINCULO` (só o `userId`, nível `medio`, motivo na lista fechada) por conta, como as outras mudanças de estado da conta (art. 37 e art. 6º X). Apagar as sessões na mesma transação do `UPDATE`: hoje, se o `delete` falhar, a conta já está inativa e não volta ao filtro (sem dano de acesso, porque `resolver` exige perfil e o hook de sessão exige `ativo`, mas a sessão fica até vencer).
- **Fundador da clínica:** `criarClinica` exige um usuário que já existe, e ainda não há fluxo de provisionamento. Quando houver, a conta do fundador criada mais de 1 dia antes da clínica será desligada pelo expurgo (a concessão do `member_found` a reativa, mas as sessões caem). Registrar isso no desenho do provisionamento.

**G5 (fila, já existia). Falha aberta da marca de reuso.** Se o Redis falhar, o `catch` devolve `count: 1` e o mesmo código TOTP pode ser usado de novo dentro da janela. O risco é baixo (exige o código válido e o Redis fora), mas o bloqueio 5/15 no mesmo caminho também abre. Avaliar falha fechada para o reuso (recusar e registrar `BLOQUEIO_INDISPONIVEL`) junto com a decisão do bloqueio.

**Menores (sem número):**
- Teste R5: acrescentar `inativa_desde` não nulo na conta velha e que as sessões dela foram apagadas.
- Teste R5: o `UPDATE` é global; uma fixture de outro teste com `created_at` antigo e sem vínculo seria desligada. Hoje não há; manter as fixtures recentes.

## Nota do Maestro (10/11/2026)

- **G1:** o expurgo de 90 dias só marca a conta que não tem vínculo (`not exists` no UPDATE da marca). O job diário também reativa a conta inativa `sem_vinculo` que tem vínculo, e o trigger da 0071 limpa `inativa_desde`. Teste: conta nesse estado, com `inativa_desde` de 91 dias, volta ativa e mantém a senha.
- **G2:** o RIPD §5 ficou com um item 4 só. O texto agora separa o caso antes dos 90 dias (convite com outro e-mail) do caso depois deles (conta nova com o mesmo e-mail).
- **G3 (mínima):** a clínica de origem também tem o HMAC zerado na anonimização. O RIPD e a §14.7 dizem que, nas demais clínicas, o HMAC some em até 30 dias.
- **G4:** cada conta é desligada numa transação própria, junto com as sessões, e gera o evento `CONTA_DESLIGADA_SEM_VINCULO` (aviso, motivo `conta_sem_vinculo`). Fica para o desenho do provisionamento a conta do fundador criada antes da clínica.
- **G5:** com o contador fora do ar, a marca de reuso conta como reuso (falha fechada).
- **Menores:** o teste da R5 confere `inativa_desde` e as sessões. O comentário de `criarContaDoConvite` não mudou.

## Reconferência (10/11/2026)

> Commits `5a1b707` (G1 a G5) e `52b6480` (R3 e R5 de `2026-11-05-codigo-better-auth-pr3a.md`). Revisão estática de `git show 5a1b707` e `git diff 8962b07..HEAD`, com leitura do código da biblioteca instalada (`better-auth` 1.7.12: `plugins/two-factor/totp/index.mjs`, `verify-two-factor.mjs`, `api/routes/session.mjs`). A bancada RLS não rodou aqui; o veredito vale com o CI verde nos testes novos do `describe` "Fila do 3b".

### Veredito: **APROVADO COM RESSALVAS.** G1, G2, G3 (mínima) e G4 estão certas. R3 e R5 do 3a estão resolvidas. **G5 ficou pela metade** (H1). **H1 e H2 entram antes do merge** (pequenas); H3 e H4 vão para a fila.

O que está certo:

- **G1 ✅.** O `UPDATE` da marca `'expurgada'` tem o `not exists` em `identidade.vinculo`, e o job reativa a conta `ativo = false, 'sem_vinculo'` que tem vínculo, **antes** do passo de 90 dias. Os outros motivos (`anonimizada`, `expurgada`, `convite_desfeito`) ficam de fora pelo filtro. O teste cobre o quadro e confere que a senha fica.
  - Corrida inversa (reativação junto com a revogação do último vínculo): no `READ COMMITTED`, a rechecagem da linha usa o `exists` com o retrato do início do comando, então a conta pode voltar ativa sem vínculo. É o quadro da R5, que o próprio job desliga no dia seguinte, e sem acesso nesse meio-tempo (`resolver` exige perfil). Aceitável.
- **G2 ✅.** O RIPD §5 tem um item 4 só, e o texto separa o antes e o depois dos 90 dias como pedido.
- **G3 (mínima) ✅.** A clínica de origem é lida **depois** da anonimização, mas a transação não mexe em `clinica_de_origem`, então o valor está lá. O `update` roda sob `withTenant` e filtra `tenant_id` e `accepted_user_id`. O RIPD e a §14.7 dizem "nas demais, em até 30 dias". (Menor: usar a constante `EMAIL_DESCARTADO` em vez de `'0'.repeat(32)` nos dois `update`.)
- **G4 ✅.** Uma transação por conta, com o `UPDATE` (condição repetida) e o `delete` das sessões juntos; o evento só sai se a linha mudou. `CONTA_DESLIGADA_SEM_VINCULO` leva só o `userId` e o motivo `conta_sem_vinculo`, que entrou na lista fechada.
- **R3 do 3a ✅ (clínica cancelada).** `clinicaLiberada` usa `canRead` com `EXIT_WINDOW_DAYS`, a mesma regra de `transacao-clinica.ts` e do `portal.service.ts`: `cancelled` só dentro da janela de 90 dias, qualquer status desconhecido fecha. A lista e a escolha seguem a regra; a escolha fora da janela responde 404, igual à clínica sem vínculo (não confirma que a clínica existe). Teste com uma clínica a 200 dias e outra a 10. Ver H3 para a escolha automática.
- **R5 do 3a ✅ (`LOGIN_OK` do cadastro).** A detecção não marca errado um login em duas etapas. Na 1.7.12, o `/two-factor/verify-totp` só cria sessão em dois casos:
  - **Login em duas etapas:** `verifyTwoFactor` chama `getSessionFromCtx`, que, sem sessão, grava `ctx.context.session = null`. A sessão nova nasce no `valid()` do caminho do cookie `two_factor`. `!!null` é falso, então sai `LOGIN_OK` sem motivo. ✅
  - **Cadastro:** só no caminho com sessão, e só se `twoFactor.verified !== true` e `twoFactorEnabled` falso. Aí `ctx.context.session` está preenchida. ✅
  - **Cookie de sessão válido junto com o `two_factor`** (cliente forjado): a biblioteca vai pelo caminho com sessão; com o fator já verificado, **não cria sessão**, então não há `LOGIN_OK` nenhum para marcar errado. ✅
  - O `protecao.ts` também usa `getSessionFromCtx` (mesmo cache em `ctx.context.session`), então o gancho e a biblioteca enxergam o mesmo estado. O login em duas etapas com cadastro não existe (`isSignIn && verified === false` é recusado).

### Ressalvas

**H1 (antes do merge). G5 só valeu para o caminho do provedor; a rota de login segue com falha aberta na marca de reuso.** A mudança para `count: 2` está em `totpDaPessoaConfere` (`provedor.ts`), usado na recuperação por token e no aceite com conta existente. A rota `/two-factor/verify-totp` (login em duas etapas, reverificação e cadastro) passa pelo `antes` do `protecao.ts`, que no `catch` do `hit` de `totp-usado` mantém `usado = false` e só registra `RATE_LIMIT_FAIL_OPEN`. Com o Redis fora, o mesmo código serve duas vezes no login. A arquitetura diz, sem restrição, que a marca "com o contador fora do ar conta como reuso".
- **Correção:** no `catch` do `protecao.ts`, `usado = true` e registrar `BLOQUEIO_INDISPONIVEL` (motivo `codigo_reutilizado`), como no provedor; ou, se a decisão for manter o login aberto até a decisão do bloqueio 5/15, restringir a frase da arquitetura ao provedor e deixar a rota na fila com o bloqueio. O provedor também não registra evento no `catch` (o login para por "código inválido" sem sinal para a operação): acrescentar `BLOQUEIO_INDISPONIVEL`.
- Observação (fila, já existia): no `protecao.ts` a marca de reuso continua **antes** da conferência, então um código errado na rota de login queima o valor por 90 s. Só afeta quem tem o cookie `two_factor` ou a sessão (a própria pessoa); o R12 do 3b-2 foi resolvido no provedor.

**H2 (antes do merge). Teste negativo da R5.** O teste cobre só o cadastro. Acrescentar o login em duas etapas de quem já tem TOTP: exatamente um `LOGIN_OK` para o `userId`, **sem** `"motivo"`, e um `LOGIN_SENHA_OK`. Protege contra mudança da biblioteca: o critério depende de `ctx.context.session` estar vazia no caminho do cookie `two_factor`.

**H3 (fila). A escolha automática da clínica não passa pela regra de leitura.** No `resolver`, com uma clínica só, `definirClinica` é chamada direto: a clínica cancelada fora da janela vira `clinicaAtiva` e recebe `session_tenant_selected` na trilha, embora suma da lista. Não vaza dado (a `transacao-clinica` barra a leitura com `ExitWindowClosedError`), mas a regra fica em dois lugares. Além disso, `escolherClinica` lê a linha de `tenants` de uma clínica **antes** de conferir o vínculo.
- **Correção:** levar a checagem de `canRead` para dentro de `definirClinica`, **depois** da conferência do vínculo. Cobre a escolha manual, a automática e evita ler a clínica alheia.

**H4 (fila). Reativação pelo job sem evento.** O passo da G1 muda o estado da conta (`ativo = true`) sem registro, ao contrário do desligamento (G4). Registrar `CONTA_REATIVADA_COM_VINCULO` (só `userId`, motivo na lista fechada), pelo mesmo motivo do art. 37: quem mudou o estado da conta e quando.

**Menores (sem número):**
- Teste da G1: conferir `inativa_desde` nulo depois da reativação (trigger da 0071). O `not exists` do passo de 90 dias não é exercitado sozinho, porque a reativação roda antes; aceitável como defesa em profundidade.
- O comentário de `criarContaDoConvite` ("a concessão já reativou a conta (trigger da 0069)") continua errado (a Nota do Maestro registra que não mudou). Corrigir quando passar por ali.

### Checklist

| Item | Situação |
|---|---|
| Base legal | Sem tratamento novo. ✅ |
| Minimização | HMAC do convite sai também na clínica de origem. ⚠️ H3 (lê `tenants` antes do vínculo). |
| Consentimento | Não se aplica. |
| Criptografia | Sem mudança. ✅ |
| Isolamento por tenant | `withTenant` com `tenant_id` nos `update`; leitura de `tenants` sob RLS. ✅ |
| Controle de acesso | Clínica cancelada fora da janela fora da lista e da escolha. ⚠️ H1 (reuso aberto no login com Redis fora), H3. |
| Log de auditoria | `CONTA_DESLIGADA_SEM_VINCULO` ✅; `LOGIN_OK` do cadastro separado ✅. ⚠️ H4. |
| Prontuário (20 anos) | O id fica em todos os caminhos; o expurgo nunca toca quem tem vínculo. ✅ |
| Segredos e dados reais | Nada no git; testes com dados fictícios. ✅ |
| CFM, ANS e ICP-Brasil | Sem mudança. |

### Nota do Maestro sobre a reconferência (10/11/2026)

- **H1:** segui a segunda saída. O texto da arquitetura ficou restrito aos caminhos do provedor, e o `catch` do provedor agora registra `BLOQUEIO_INDISPONIVEL` (motivo `codigo_reutilizado`). A rota de login fica na fila junto com a decisão do bloqueio 5/15, que também abre com o contador fora: fechar só o reuso derrubaria todo login com TOTP numa queda do Redis, e essa escolha de disponibilidade é dos sócios.
- **H2:** o teste da R5 cobre também o login em duas etapas de quem já tem TOTP: um `LOGIN_SENHA_OK` e um `LOGIN_OK` sem `motivo`.
- **H3:** o `canRead` foi para dentro do `definirClinica`, depois da conferência do vínculo. Assim vale também para a escolha automática do `resolver`. Os testes de unidade do provedor simulam a clínica liberada.
- **H4:** `CONTA_REATIVADA_COM_VINCULO` (aviso, motivo `conta_com_vinculo`).
- **Menores:**
  - O teste da G1 confere que `inativa_desde` volta a nulo.
  - `EMAIL_DESCARTADO` foi para `convites-retencao.ts` (sem ciclo de import) e é usado pelo provedor.
  - O comentário do `criarContaDoConvite` foi corrigido.
  - A marca de reuso antes da conferência no login vai para a fila.
