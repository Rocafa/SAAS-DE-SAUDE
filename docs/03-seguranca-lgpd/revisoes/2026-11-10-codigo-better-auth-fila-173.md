# Parecer do Guardião LGPD: fila da reconferência do #173 (conta expurgada, teto atômico de recuperações, troca de senha, invalidação por clínica, PR #175)

> Data: 10/11/2026. Branch: `eng/better-auth-fila-173` (`d6bef5e`), base `eng/better-auth-fila-3b` (#173). Base: ressalvas 1 a 5, 7 e 8 da reconferência em `2026-11-10-codigo-better-auth-fila-3b.md`, `RIPD-identidade.md` §3 e `logs-de-seguranca.md`. Revisão estática do diff `origin/eng/better-auth-fila-3b...HEAD`. A bancada RLS não rodou aqui (sem Postgres). O veredito vale com o CI verde, em especial o `describe` "Fila do 3b" e o teste R9 de 5 erros na troca.

## Veredito: **APROVADO COM RESSALVAS.** As ressalvas 1 a 5, 7 e a parte do nome da 8 estão resolvidas. Nada abaixo bloqueia o merge. As ressalvas F1 a F4 vão para a fila.

O que está certo:

- **Ressalva 1 ✅ (trigger da 0071).** O teste confere três coisas: o desligamento pela rota grava `inativa_desde`, um `UPDATE ativo = false` sobre conta já inativa mantém a data envelhecida, e a recontratação antes dos 90 dias zera a data. Isso bate com o trigger, que só age na transição `true → false` e quando `ativo = true`.
- **Ressalva 2 ✅ (teto atômico).** A contagem, a invalidação e a inserção ficam numa transação do `app_auth`, serializadas por `pg_advisory_xact_lock(hashtextextended('recuperacao:' || admin, 0))`. O teste dispara 13 emissões em paralelo (o pool da bancada tem 2 conexões, então há concorrência real) e confere que só 10 são gravadas.
  - **Permissão:** `pg_advisory_xact_lock` e `hashtextextended` são executáveis por `PUBLIC`, e nenhuma migração revoga isso. O padrão já é usado nas 0005, 0020 e 0033. O prefixo `recuperacao:` não colide com `audit_chain:`, `clinic_members:` e `portal_rights:`.
  - **Deadlock:** não há ciclo. O serviço grava a trilha na transação da clínica (conexão A, que pega a trava `audit_chain:<clínica>`) e depois abre a transação do `app_auth` (conexão B, trava `recuperacao:<admin>`). A transação B nunca espera nada da A. Duas clínicas diferentes invalidam linhas disjuntas, porque o filtro inclui `clinica_id`. Na mesma clínica, a trava da trilha já serializa. A espera na trava é um comando, então o `statement_timeout` de cada conexão limita o tempo.
  - **Relógio:** a janela de 24 h passou a usar o `now()` do banco, o mesmo relógio do `criado_em`. Isso é coerente.
- **Ressalva 3 ✅ (evento do teto).** `RECUPERACAO_TETO` é `alto` com alarme `imediato`, e o motivo `teto_diario` entrou na lista fechada no mesmo PR. Os campos são `tenantId` e `userId` do **admin**, ambos ids com formato validado. Não há e-mail, nome nem id da pessoa-alvo, o que respeita a minimização (art. 6º III). O evento sai fora da transação, então sobrevive ao rollback da trilha. O teste confere uma linha com o id do admin, e confere que nenhum token novo foi gravado. A tabela da `logs-de-seguranca.md` agora traz também `RECUPERACAO_EMITIDA` e `RECUPERACAO_USADA`, que faltavam.
- **Ressalva 4 ✅ (troca de senha).** Conferi a ordem do `changePassword` da better-auth 1.7.12 (`dist/api/routes/update-user.mjs`). O tamanho das senhas e a existência da conta são checados **antes** de conferir a senha atual. Depois da conferência, só sobra a transação de gravação. Por isso, `recusada` não serve de oráculo para a senha atual, e só `INVALID_PASSWORD` gasta tentativa.
  - O código `INVALID_PASSWORD` é o mesmo que o `protecao.ts` já usa no cadastro do fator.
  - O teste R9, com 5 erros que travam a 6ª tentativa, continua cobrindo o caminho que conta.
  - O controlador já recusa senha nova com menos de 12 ou mais de 128 caracteres antes da reserva.
- **Ressalva 5 ✅ (invalidação por clínica).** A invalidação filtra `clinica_id = ctx.tenantId`, e o teste confere que os dois pendentes coexistem e que o de A continua usável. O risco residual está registrado no RIPD §3.
- **Ressalva 7 ✅ (concessão a conta expurgada).** A 0072 acrescenta `'expurgada'` ao CHECK. O nome da constraint confere com a 0069. A `app_espelhar_vinculo` foi recriada **idêntica** à da 0069, exceto pelo `IN ('anonimizada', 'expurgada')`. Ela continua `SECURITY DEFINER`, com `search_path` fixo e `REVOKE ... FROM PUBLIC`.
  - O expurgo grava a marca na mesma transação que apaga a credencial.
  - O `select` do expurgo passa a depender só de `inativa_por = 'sem_vinculo'`, então a conta marcada não volta ao job.
  - O teste confere que a concessão de um perfil dá erro e que `clinicasDoUsuario` fica vazia.
  - `idParaContaDoConvite` só reaproveita conta `convite_desfeito`, então a marca nova não abre caminho.
- **Ressalva 8 (nome) ✅.** O expurgo troca o nome por "Conta desligada" e zera `imagem` (art. 16). A decisão está no RIPD §3, e a matriz ganhou a linha de 10/11 com os prazos vigentes.
  - **Backfill:** roda como `app_migrator` e não mexe em `ativo`, então o trigger da 0071 não dispara e `inativa_desde` fica. O CHECK de coerência é respeitado (`ativo = false`). Fora o `imagem` (F3), está certo.
- **Checklist geral:**

| Item | Situação |
|---|---|
| Base legal | Sem tratamento novo. O nome sai no expurgo (art. 16), e o evento do teto é segurança do tratamento (art. 46). ✅ |
| Minimização e retenção | Nome e imagem saem aos 90 dias. O id fica pelo prontuário (20 anos; autoria em `professionals`). RIPD §3 e matriz atualizados. ✅ |
| Consentimento | Não se aplica. |
| Criptografia | Nada novo. O token continua só como SHA-256. ✅ |
| Isolamento por tenant | A invalidação deixou de atravessar clínicas. O teto por admin vale entre clínicas, o que está correto. ✅ |
| Controle de acesso | A conta expurgada é terminal (42501). A troca não vira oráculo. ⚠️ Há uma janela de corrida (F1). |
| Log de auditoria | `RECUPERACAO_TETO` com contrato fechado e sem dado pessoal além de ids. ✅ |
| Prontuário (20 anos) | O id fica, e a autoria está na clínica. ✅ |
| Segredos e dados reais | Nada no git. A bancada usa dados fictícios. ✅ |
| CFM, ANS e ICP-Brasil | CFM 1.821/2007: a autenticidade da autoria fica preservada, porque o id expurgado não volta a ter dono. Não toca TISS nem assinatura. |

## Ressalvas (fila, não bloqueiam)

**F1. Corrida entre o expurgo e a concessão.** O expurgo escolhe as contas num `select` e depois atualiza **sem** repetir a condição.
- **(a) Recontratação entre o `select` e a transação.** A conta volta a `ativo = true` e `inativa_por = NULL`, e o expurgo grava `'expurgada'`. O CHECK `usuario_inativa_coerente_check` recusa a gravação, a transação desfaz tudo, a senha **não** é apagada e o job aborta o resto do lote até o dia seguinte. Não há dano ao dado, mas o job falha.
- **(b) Concessão durante a transação do expurgo.** O trigger lê `'sem_vinculo'` antes do commit do expurgo, insere o `vinculo` e não reativa a conta (o `UPDATE ... WHERE inativa_por = 'sem_vinculo'` não acha a linha depois do commit). Fica um vínculo ativo numa conta expurgada, que é o quadro que a ressalva 7 quis evitar. A janela é de milissegundos, uma vez por dia, e a conta não tem como entrar.
- **Correção:**
  - No expurgo, começar a transação com `UPDATE usuario ... WHERE id = $1 AND ativo = false AND inativa_por = 'sem_vinculo' AND inativa_desde < $90d RETURNING id` e pular a conta se nada voltar. Só então apagar a senha, o fator, as sessões e os tokens.
  - No trigger, ler a marca com `SELECT inativa_por ... FOR UPDATE`, para esperar o expurgo e enxergar a versão confirmada.
- **Teste:** recontratar entre o `select` e o expurgo não derruba o job e mantém a senha.

**F2. Usar um token não invalida o da outra clínica.** Com a ressalva 5, a pessoa pode ter um token pendente por clínica. O uso marca só o próprio token. O outro vale até vencer (15 min) e também exige a credencial da pessoa, então o risco é baixo. Mesmo assim, no `usarRecuperacao` bem-sucedido, invalidar todos os pendentes da pessoa. Essa é uma ação da própria pessoa e não reabre o problema da ressalva 5.

**F3. O backfill da 0072 não zera `imagem`.** O expurgo novo zera, mas a migração só troca o nome. Acrescentar `imagem = NULL` (numa migração nova, se a 0072 já tiver rodado em algum ambiente). Antes de aplicar em homologação ou produção, conferir que não existe conta `ativo = true` com e-mail `desligada-%@desligada.invalid`. Uma conta assim teria sido reativada pela 0069 antes da marca e ficaria fora do backfill. Se existir, tratar à mão e registrar.

**F4. `troca_recusada` aponta para `senhaNova` em qualquer erro.** Sessão não "fresca" ou vencida na biblioteca também responde 409 em `senhaNova`, e a tela não tem como pedir reautenticação. O problema é de experiência, não de segurança, porque o caminho não gasta tentativa e não revela a senha. Repassar o código da biblioteca numa lista fechada (por exemplo `PASSWORD_TOO_SHORT`, `SESSION_NOT_FRESH`) e mapear 401 ou 403 para o próprio status.

## Nota do Maestro (10/11/2026)

- **F1:** o expurgo grava a marca primeiro, com a condição repetida e `RETURNING`; se a pessoa foi recontratada no meio, a conta é pulada e o lote segue. No trigger, em vez de `FOR UPDATE` (que reabriria o deadlock entre conexões do 3b-1), a marca é conferida de novo **depois** do UPDATE da recontratação: esse UPDATE espera o expurgo que travou a linha, e o comando seguinte vê a marca e recusa (42501).
- **F2:** usar um token invalida todos os pendentes da pessoa, de qualquer clínica, na mesma transação. Teste estendido.
- **F3:** a 0072 ainda não rodou em ambiente nenhum (só no CI efêmero), então o backfill foi corrigido nela mesma: `imagem = NULL`. A primeira versão também falhava no CI por usar `name` em vez de `nome`; corrigido.
- **F4:** `PASSWORD_TOO_SHORT` e `PASSWORD_TOO_LONG` viram `senha_nova_invalida` (campo `senhaNova`); o resto vira `troca_recusada` sem campo.
