# Parecer do Guardião LGPD: código do PR 3b-1 (convite da equipe e cadastro do fator preso ao convite, PR #156)

> Data: 05/11/2026. Branch: `eng/better-auth-convites`, base `eng/better-auth-equipe`. Base: §14.2 revista e o parecer do desenho do PR 3 com a reconferência da 3b (`2026-11-05-desenho-better-auth-pr3.md`: R1, R2, R8, R9, R15 a R17). Revisão estática do diff `origin/eng/better-auth-equipe...origin/eng/better-auth-convites`. O CI do PR passou (16/16), segundo o pedido. A bancada não rodou aqui.

## Veredito: **APROVADO COM RESSALVAS.** A R1 entra antes do merge, porque é curta e evita uma conta órfã que trava a pessoa. As demais vão antes do 3c ou para a fila.

O núcleo está certo e fecha o veto do desenho:
- **R2:** o convite vive só em `team_invites`, da clínica, com RLS forçada, política que barra o portal e sem `DELETE` para o `app_user`. Ele não toca `identidade.usuario`, não concede perfil e guarda só o SHA-256 do token e o HMAC do e-mail. A lista não traz e-mail. O vínculo nasce no aceite, na transação da clínica do token, como o admin que convidou. Se ele deixou de ser admin, a resposta é o mesmo 404.
- **R16:** o aceite confere o HMAC do e-mail do convite.
- **R8:** a sessão do aceite leva `cadastro_pendente_ate` (15 min). Com ela, o `resolver` e o `sessaoDePessoa` devolvem `null`. O `enable` só é aceito nela e dentro do prazo (`CADASTRO_SO_PELO_CONVITE`). Com isso, quem tem só a senha não cadastra o próprio autenticador.
- **R9:** teto de 20 convites por admin por dia.
- **R17 (a):** a conta guarda `clinica_de_origem` e `convite_de_origem`.
- **Senha vazada:** conferida explicitamente na conta nova (R5 do #152), com falha aberta e alarme.
- **Concorrência:** o aceite em paralelo é serializado pelo `UPDATE … WHERE accepted_at IS NULL`.
- **Conta existente:** sai como 409 sem criar nada (o 3b-2 trata). O resíduo já está registrado na R18.

Os testes cobrem cada um desses pontos, inclusive o isolamento entre clínicas.

## Ressalvas

### Antes do merge

1. **Conta órfã se a transação da clínica falhar depois de criá-la.**
   - **O problema:** `criarContaDoConvite` grava `identidade.usuario` e `conta` numa transação **própria** do pool `app_auth`, que confirma na hora, no meio da transação da clínica. Se `gravarConcessao` falhar depois (ex.: índice único de perfil ativo, trilha, aviso aos admins) ou se o `COMMIT` da clínica falhar, o convite e o vínculo voltam, mas a conta fica. Na nova tentativa, a pessoa recebe `conta_existente_exige_login`. Ela não tem TOTP e não consegue cadastrar, porque o `enable` só vale na sessão pendente. Fica presa até a recuperação, e o e-mail fica ocupado.
   - **Correção:** gravar a concessão **antes** e criar a conta como **último** passo da transação da clínica (o vínculo não depende de FK para `identidade`). Se mesmo assim o `COMMIT` da clínica falhar depois de a conta existir, compensar: marcar `ativo = false` e apagar a `conta` (credencial) pelo provedor, que é o que o `app_auth` pode fazer (R18).
   - **Teste:** forçar a falha da concessão depois da criação da conta e conferir que, em seguida, o mesmo convite é aceito normalmente.

### Antes do 3c

2. **Aceite sem sessão de cadastro.** Se `abrirSessaoDeCadastro` falhar **depois** do commit (sign-in recusado por bloqueio de origem, Redis, erro da biblioteca), a conta e o vínculo existem, o convite está usado, e a pessoa não tem como cadastrar o fator. Ou o aceite devolve um caminho para reabrir a sessão pendente com o próprio token (idempotente por 15 min, só para quem acabou de aceitar), ou isso fica documentado como caso da recuperação de fator do 3b-2, com teste.
3. **Retenção de `team_invites`.** O expurgo do 3a cobre só o schema `identidade`. Os convites vencidos, revogados e aceitos (HMAC do e-mail, que é pseudônimo) precisam de prazo: por exemplo, apagar ou anonimizar o `email_hmac` 30 dias depois do estado final. O `invite_id` continua na trilha. Entra na matriz de retenção (R7 do desenho do PR 3), num job por clínica.
4. **R17 (c) a (e) no papel.** Faltam o procedimento de disputa de e-mail no suporte, o compromisso de verificação de e-mail obrigatória quando houver provedor e o registro no RIPD e no contrato. Isso cabe no checklist do 3c (R13 do desenho), não no código.

### Fila

5. **Chave do HMAC do e-mail.** `hmacDoEmail` usa a `RATE_LIMIT_HASH_KEY` com prefixo de domínio (`convite-email:`). Isso é aceitável, mas a rotação dessa chave **invalida os convites pendentes** (o aceite passa a dar 404). Registrar no runbook de rotação, junto da derivação por uso (HKDF) já pedida no parecer do PR 1.
6. **Teto diário com corrida.** Duas criações simultâneas podem passar de 20 em 1, porque a contagem e a inserção não são atômicas. É irrelevante como controle de abuso, mas se quiser fechar, `pg_advisory_xact_lock` por admin.
7. **Sessão normal antes da marca.** `abrirSessaoDeCadastro` cria a sessão pelo `signInEmail` e só depois grava `cadastro_pendente_ate`. Entre os dois passos ela é uma sessão comum, mas o cookie só sai depois da marca, então não há uso possível. Se a marca falhar, a sessão fica órfã (sem cookie entregue) e o expurgo a apaga. Mesmo assim, apagar a sessão no `catch` é o mais limpo.

## Conferido sem achado

| Item | Situação |
|---|---|
| Base legal | E-mail e nome de quem foi convidado: execução do contrato de trabalho e do contrato com a clínica, mais segurança (art. 7º V e IX, art. 46). Não é dado de saúde. ✅ |
| Minimização | Na clínica, só o HMAC do e-mail e o hash do token. A lista mostra perfil, datas e quem convidou. A trilha leva só ids e perfil. A exportação da clínica exclui `team_invites`, com motivo. ✅ |
| Isolamento | RLS com `FORCE` e a política `portal_fora`. O aceite abre a transação na clínica que vem do token, e o token só vale nela. O teste confere que a clínica B não lê nem altera o convite de A. ✅ |
| Token | 32 bytes aleatórios mais o id da clínica (que não é segredo). Só o SHA-256 vai ao banco. O mesmo 404 para token inválido, vencido, usado, revogado ou e-mail diferente. O prazo de 72 h é travado por CHECK com o relógio do banco. ✅ |
| R1 (nenhum token dá a conta inteira) | O token do convite só cria uma conta **nova** sem fator, numa sessão que só serve ao cadastro. Conta existente não é tocada. Recuperação e conta existente ficam no 3b-2. ✅ |
| R8 | A sessão pendente não passa no `resolver` nem no `sessaoDePessoa`, e o `enable` fora dela é recusado (teste). É liberada só quando o código é aceito. ✅ |
| R15 | No aceite de pessoa nova não há senha a conferir. O `signInEmail` da sessão de cadastro passa pelos ganchos de bloqueio. A parte do TOTP e da senha atual é do 3b-2. ✅ |
| Segredos e dados reais | Só dados fictícios na bancada. O token aparece só na resposta ao admin, nunca em log. ✅ |
| CFM, ANS e ICP-Brasil | Não toca prontuário. A autoria (R18) segue em `professionals`. ✅ |

## Nota do Maestro (05/11/2026)

- **R1 corrigida.**
  - Dentro da transação da clínica, o vínculo (`gravarConcessao`) é gravado **antes**, e a conta é criada **por último**.
  - Se a clínica não confirmar depois de a conta existir, a conta fica inativa, sem senha e sem sessões (o `app_auth` não apaga identidade, R18).
  - O mesmo convite reaproveita essa conta abandonada na próxima tentativa (`idParaContaDoConvite`): inativa, sem senha, sem vínculo e nascida de convite.
  - Teste novo na bancada: a conta abandonada é reaproveitada e passa a ter o vínculo.
- **R2 a R4** vão para o 3b-2 e para o checklist do 3c; **R5 a R7** vão para a fila.
