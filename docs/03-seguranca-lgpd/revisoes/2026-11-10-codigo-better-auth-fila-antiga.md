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
