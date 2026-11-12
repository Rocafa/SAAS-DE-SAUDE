# Parecer do Guardião LGPD: código da fila do 3b (credencial de conta desligada, descarte do pseudônimo do convite, tetos da troca e da recuperação, PR #173)

> Data: 10/11/2026. Branch: `eng/better-auth-fila-3b` (`5d439e8`), base `eng/better-auth-producao` (#171; merge-base `f82fab7`). Base: ressalva 4 do parecer do 3c parcial (`2026-11-08-codigo-better-auth-pr3c-parcial.md`), R3 do código do 3b-1, R9 e R10 do código do 3b-2 (`2026-11-06-codigo-better-auth-pr3b2.md`), R17 e R18 do desenho do PR 3 e `RIPD-identidade.md` §3. Revisão estática do diff `origin/eng/better-auth-producao...origin/eng/better-auth-fila-3b`. O CI do PR passou (16/16), segundo o pedido. A bancada não rodou aqui.

## Veredito: **VETADO.** Dois defeitos na parte da ressalva 4 (recontratação depois do expurgo). R3 do 3b-1, R9 e R10 do 3b-2 estão certas e podem seguir como estão. As correções B1 e B2 são curtas.

O que está certo:
- **0071:** `inativa_desde` com CHECK amarrado a `ativo = false`. O trigger marca a data só na transição `true → false` e limpa na reativação. As contas já inativas começam a contar agora, e nada é apagado retroativamente sem aviso. ✅
- **Expurgo da credencial:** só `inativa_por = 'sem_vinculo'` com mais de 90 dias. A conta anonimizada e a de convite desfeito ficam de fora. A conta e o id ficam (R18). O job devolve só contagens. ✅ (ver B1)
- **R3 do 3b-1 (`convites-descarte`):** o job roda por clínica, com `tenant_id` explícito, além do RLS. O convite aceito, revogado ou vencido há mais de 30 dias troca o `email_hmac` por um valor fixo, que passa no CHECK e não corresponde a e-mail nenhum. O convite pendente fica (com teste). Não há índice único em `email_hmac`, e a trilha do convite não guarda o HMAC. O job está em `jobs_de_retencao` (alarme) e no `api-dominio` §14. ✅
- **R9 do 3b-2:** a senha atual conferida na troca reserva o contador `login:<email>`, com teto de 5. A reserva é devolvida no sucesso, na senha vazada e na exceção. A senha errada gera `LOGIN_FALHOU`. O bloqueio responde igual à senha errada, e o store fora do ar falha fechado (503). Há teste com 5 erros que travam a 6ª tentativa, mesmo com a senha certa. ✅
- **R10 do 3b-2:** o token novo marca os pendentes da mesma pessoa como usados, pelo mesmo mecanismo do `invalidarRecuperacao`. O teto é de 10 por admin em 24 h. O teto barrado desfaz a transação da trilha, e o token não é emitido. A invalidação vem antes da emissão: se a emissão falhar, ninguém fica com token válido, o que falha fechado. ✅

## Bloqueia o merge

**B1. O expurgo apaga o TOTP mas deixa `dois_fatores_ativo = true`.**
- **O problema:** o expurgo zera a senha e apaga a linha de `doisFatores`, mas não mexe em `usuario.twoFactorEnabled`. Na vida real, toda conta desligada concluiu o cadastro do TOTP, porque ele é obrigatório. Na recontratação, `criarContaDoConvite` grava a senha, e `completarContaReaproveitada` não zera a marca. Então o `signInEmail` de `abrirSessaoDeCadastro` cai no segundo passo do plugin, sem cookie de sessão, e não há segredo para conferir. O aceite lança `sessao_de_cadastro_nao_abriu`, e a conta fica presa num estado incoerente: "fator ativo" sem fator. O `usarRecuperacao` do tipo `fator` (linha 442) já faz certo: apaga a linha **e** zera a marca.
- **Por que o teste não pegou:** `novaPessoa` cria a conta sem TOTP, e o `entrar` devolve 200 mesmo quando o plugin pede o segundo passo.
- **Correção:**
  1. No expurgo, numa **única** transação do `app_auth` por conta: `password = null`, `delete doisFatores`, `twoFactorEnabled = false`, `delete sessao` da pessoa e invalidação das recuperações pendentes. A ressalva 4 pedia "senha, TOTP, sessões e tokens". Hoje as sessões e os tokens só somem porque vencem antes, sem garantia escrita.
  2. Filtrar no `select` só as contas que ainda têm algo a apagar (senha não nula ou fator ativo). Hoje o job relê todas as contas desligadas há mais de 90 dias, todo dia, para sempre.
- **Teste:** a pessoa **com TOTP cadastrado** (`cadastrarFator`) é desligada e passa pelo expurgo. Depois, `dois_fatores_ativo = false`, não há linha em `doisFatores` nem sessão, e o aceite abre a sessão de cadastro pendente (R8), que exige um TOTP novo.

**B2. O reaproveitamento deixa o admin de qualquer clínica tomar o id de quem saiu de outra.**
- **O problema:** o e-mail é declarado pelo admin e **não é verificado**, e o admin entrega o token fora da plataforma (R17; `RIPD-identidade` §4). Antes deste PR, convidar o e-mail de uma conta desligada dava `conta_existente`, e o aceite pedia senha e TOTP da própria pessoa (`conferirCredenciais`). O RIPD conta com isso: "o aceite de conta existente pede login completo". Agora, depois de 90 dias, qualquer convite com esse e-mail **reaproveita o id** com a senha que quem aceita escolher. Por exemplo:
  - o admin da clínica B convida o e-mail de uma profissional que saiu da clínica A, aceita o próprio convite e passa a controlar o id dela;
  - esse id é o autor de registros no prontuário de A (R18, guarda de 20 anos) e aparece nas trilhas de A;
  - se A recontratar a profissional pela concessão direta do id (trigger da 0069), quem entra é o admin de B, com acesso aos dados de A.

  É tomada de conta de uma identidade ligada à autoria do prontuário (art. 46 da LGPD; integridade e autenticidade do prontuário, CFM 1.821/2007).
- **Correção (escolher uma e registrar no RIPD §3):**
  - **(a)** Reaproveitar a conta `sem_vinculo` só quando o convite vier de uma clínica onde esse id **já teve vínculo**. A prova é uma linha revogada em `clinic_members` daquela clínica, conferida na transação do aceite. Fora disso, a conta antiga vira esqueleto: o e-mail troca por um marcador `.invalid`, com o mesmo bloqueio de concessão da anonimizada, e o convite cria um id **novo**. Isso é o "cadastro do zero" da ressalva 4. O histórico fica no id antigo.
  - **(b)** Nunca reaproveitar. O expurgo dos 90 dias já libera o e-mail e transforma a conta em esqueleto, e toda recontratação nasce com id novo. A clínica que recontrata usa o convite, e não a concessão do id antigo.
- **Teste:** o admin de B convida o e-mail da conta expurgada vinda de A. O id **não** é reaproveitado, e a concessão de A ao id antigo não abre login com a senha escolhida em B.

## Ressalvas (fila, antes do parecer final do 3c)

1. **O trigger da 0071 não tem teste.** O teste grava `inativaDesde` à mão depois do desligamento. Conferir que o desligamento grava a data, que a recontratação a limpa e que o UPDATE de `ativo` sem mudança não zera a contagem.
2. **O teto de recuperações não tem teste e pode passar de 10 numa rajada.** A contagem e a inserção não são atômicas (READ COMMITTED). Usar `pg_advisory_xact_lock` por `criado_por`, ou contar e inserir na mesma transação do `app_auth`. Teste: a 11ª emissão do mesmo admin dá 409 e não deixa token.
3. **O teto atingido não deixa rastro.** Registrar `registrarEventoDeSeguranca('RECUPERACAO_TETO', { tenantId, userId: admin })`, como no teto de convites. Admin batendo no teto é sinal de abuso.
4. **Na troca, um erro que não é de senha conta como senha errada.** Qualquer status diferente de 200 que não seja `PASSWORD_COMPROMISED` (ex.: senha nova curta, sessão vencida) vira `senha_atual_errada` e gasta uma tentativa do bloqueio. Só contar o código de senha inválida da biblioteca. Os outros devolvem a reserva e respondem com o próprio erro. Validar a senha nova no DTO antes da reserva.
5. **A invalidação dos pendentes atravessa clínicas.** O admin de B invalida um token pendente que A emitiu para a mesma pessoa. O efeito é só negar serviço, e a pessoa recebe o token de B. Registrar no RIPD como risco residual, ou limitar a invalidação a `clinica_id = ctx.tenantId`.
6. **O RIPD e a matriz não acompanharam.** O `RIPD-identidade.md` §3 (linhas 38 e 40) ainda diz "a definir" e "proposta" para o convite (30 dias) e para a credencial de conta inativa (90 dias). Passar os dois para "vigente", com o job, e registrar a decisão da B2. Fazer o mesmo na `matriz-retencao.md`.

## Checklist

| Item | Situação |
|---|---|
| Base legal | Sem tratamento novo. O expurgo e o descarte **reduzem** dados (art. 15, I; art. 16). ✅ |
| Minimização e retenção | 90 dias para a credencial e 30 dias para o pseudônimo do convite, com job e alarme. Falta apagar a marca do fator (B1) e atualizar o RIPD e a matriz (R6). ⚠️ |
| Consentimento | Não se aplica. |
| Criptografia | O hash e o TOTP são apagados, não recifrados. Sem chave nova. ✅ |
| Isolamento por tenant | `convites-descarte` usa RLS e `tenant_id` explícito. O reaproveitamento cruza clínicas (B2). ❌ |
| Controle de acesso | R9 e R10 fecham o teste de senha pela sessão e o abuso da recuperação. A B2 reabre a tomada de conta. ❌ |
| Log de auditoria | A emissão segue na trilha da clínica. A troca com senha errada gera `LOGIN_FALHOU`. O teto atingido não deixa rastro (R3). ⚠️ |
| Prontuário (20 anos) | O id e a autoria ficam. A B2 é justamente o risco à autenticidade dessa autoria. ❌ |
| Segredos e dados reais | Nada no git. A bancada usa e-mails `@exemplo.test` e "Pessoa Ficticia". ✅ |
| CFM, ANS e ICP-Brasil | CFM 1.821/2007: autenticidade da autoria (B2). Não toca TISS nem assinatura. |

## Nota do Maestro (10/11/2026)

- **B1 corrigido.** O expurgo trata cada conta numa transação: apaga a senha e o TOTP, **desmarca o fator** (`twoFactorEnabled = false`), derruba as sessões e invalida as recuperações pendentes. Só processa a conta que ainda não foi liberada, então uma segunda passada não refaz nada (há teste).
- **B2 corrigido, pela opção (b).** A conta desligada **nunca** é reaproveitada. Aos 90 dias, o expurgo **libera o e-mail** (`desligada-<id>@desligada.invalid`), e a recontratação pelo convite cria uma **conta nova**, com outro id. O id antigo fica só como autor no histórico clínico. O teste usa uma pessoa **com TOTP** e confere o id novo.
- **Ressalva 6:** o RIPD §3 passa a ter os prazos definitivos de 30 e 90 dias.
- **Ressalvas 1 a 5** vão para a fila: teste do trigger da 0071, teto atômico e com evento, erro não-senha na troca, invalidação limitada à própria clínica.

## Reconferência (10/11/2026, commit `a10da1a`)

Revisão estática do diff `5d439e8...a10da1a`, que mexe em `provedor.ts`, no teste `Fila do 3b` e no `RIPD-identidade.md` §3. O CI passou (16/16), segundo o pedido.

### Veredito: **APROVADO COM RESSALVAS.** B1 e B2 estão resolvidos. As ressalvas 1 a 5 seguem na fila, com as duas abaixo. Nada disso bloqueia o merge.

- **B1 ✅** O expurgo trata cada conta numa transação do `app_auth`: apaga a senha, a linha de `doisFatores` e as sessões, zera `twoFactorEnabled` e invalida as recuperações pendentes. A conta já liberada sai do `select`, e o teste confere que a segunda passada processa 0 contas. O teste usa uma pessoa **com TOTP cadastrado**, e confere que o fator foi desmarcado e que não sobra linha em `doisFatores`.
- **B2 ✅ (opção b)** `idParaContaDoConvite` só reaproveita a conta de `convite_desfeito`. A conta desligada dá `conta_existente` antes dos 90 dias (o aceite pede a senha e o TOTP da própria pessoa). Depois dos 90 dias, o e-mail vira `desligada-<id>@desligada.invalid`, e o convite cria um **id novo**, o que o teste confere. Ninguém consegue mais assumir o id que é autor no prontuário pelo convite.
  - **Concessão direta ao id expurgado:** o trigger da 0069 ainda reativa a conta `sem_vinculo` quando a clínica concede um perfil a ela. Mesmo assim, não há tomada de conta, porque a conta reativada não tem como entrar:
    - o e-mail não é real;
    - não há senha;
    - não há TOTP;
    - a recuperação do tipo `senha` exige o TOTP, e a do tipo `fator` exige a senha atual.
- **Ressalva 6 ✅ no RIPD** O §3 passa a ter os prazos de 30 e 90 dias como vigentes, com o job de cada um e a regra da conta nova.

### Fila (somam-se às ressalvas 1 a 5)

7. **Concessão a conta expurgada.** O trigger da 0069 reativa uma conta que ninguém consegue usar, e a clínica pensa que recontratou a pessoa. Recusar a concessão ao id com e-mail `desligada-…@desligada.invalid`, como já se faz com a anonimizada (42501). Uma alternativa é uma marca `inativa_por = 'expurgada'` gravada pelo expurgo, que também dispensa o filtro por `like` no e-mail. Teste: conceder um perfil à conta expurgada dá 42501.
8. **A matriz de retenção ainda diz "proposta".** A linha de 08/11 da `matriz-retencao.md` fala em "proposta de 30 dias" para o `team_invites`. Acrescentar uma linha de histórico com os prazos vigentes. Também falta decidir, e registrar no RIPD, se o **nome** fica no esqueleto do id expurgado. Ele não é necessário à autoria, que está em `professionals` da clínica. Se não for, sai junto com o e-mail (art. 16).
