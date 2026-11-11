# Parecer do Guardião LGPD: espelho dos convites aceitos (V3 do #177, PR #178)

> Data: 11/11/2026. Branch: `eng/better-auth-espelho-convite` (`6a329ef`), base `eng/better-auth-fila-noturna` (#177). Base: V3 de `2026-11-11-codigo-better-auth-fila-noturna.md`, migrações 0064 (espelho `identidade.vinculo`), 0067 (`team_invites`) e 0043, `convites.ts` (`aceitar`, `descartarEncerradosComoSistema`), `RIPD-identidade.md` §3, `matriz-retencao.md`. Revisão estática do diff `origin/eng/better-auth-fila-noturna...HEAD`. A bancada RLS não rodou aqui (sem Postgres).

## Veredito: **VETADO.** O desenho está certo e resolve a V3: o espelho guarda só ids, fica fora do alcance do `app_user`, não cria deadlock e se recupera bem de falha. O problema é a retenção. O espelho só tem uso enquanto o convite aceito ainda guarda o HMAC do e-mail, ou seja, até 30 dias depois do aceite. O PR, porém, guarda a linha "enquanto a conta existir", e a conta nunca é apagada (R18). Isso dá um registro permanente, fora da RLS da clínica, de todas as clínicas por onde a pessoa passou, sem finalidade depois do dia 30 (art. 6º III, art. 15 I e art. 16). A correção é pequena (V1).

O que está certo:

- **Minimização do conteúdo ✅.** São só dois uuids (pessoa e clínica), sem papel, datas, e-mail ou nome. O dado já existe em `team_invites.accepted_user_id`. O espelho só o expõe ao `app_auth`, que já conhece a pessoa, e nunca ao `app_user` (`REVOKE ALL FROM PUBLIC`, `GRANT SELECT, DELETE` só ao `app_auth`, sem `INSERT`/`UPDATE`). É mais estreito que a varredura de `app_job_tenants()` que ele substitui: a anonimização não descobre mais quais clínicas existem na plataforma. Cumpre a V3.
- **Isolamento ✅.** O espelho não cria nenhuma política nova em `team_invites`. Os ids lidos só servem para abrir uma transação da própria clínica, com RLS, e o `UPDATE` continua filtrado por `tenant_id` e `accepted_user_id`. Uma linha a mais no espelho (por exemplo, `accepted_user_id` alterado por SQL injetado no `app_user`) só faz a anonimização visitar uma clínica e não mudar nada. Não há vazamento nem escalada.
- **Trigger ✅.** `SECURITY DEFINER`, `search_path` fixo com `pg_temp` por último, nome qualificado `identidade.convite_aceito`, `REVOKE` da função para `PUBLIC`, `AFTER ... FOR EACH ROW` com `RETURN NULL`. Segue o padrão da 0064. `UPDATE OF accepted_user_id` dispara nos dois aceites de `convites.ts`, porque os dois põem `acceptedUserId` no `SET`. O descarte de 30 dias e a anonimização mexem só em `email_hmac`, então não disparam o trigger. Se `accepted_user_id` mudar de A para B, a linha de A fica no espelho. É um superconjunto inofensivo, e com a V1 sai no prazo.
- **Sem FK para `identidade.usuario` ✅ (manter).** No aceite com conta nova, o `UPDATE` do convite (e o trigger) roda antes de `criarContaDoConvite` criar a conta, em outra conexão. Uma FK faria o aceite falhar. Também evitaria criar um lock de chave entre as duas conexões. Vale deixar isso num comentário da migração.
- **Deadlock ✅.**
  - No aceite, a transação da clínica insere `(pessoa, clínica)` no espelho e, ainda aberta, chama o `app_auth` (`criarContaDoConvite`). Esse caminho não lê nem grava `convite_aceito`. É a mesma forma que o espelho de vínculos já tinha (`gravarConcessao` com o trigger da 0064, na mesma transação). Não aparece aresta nova.
  - Na anonimização, o `SELECT` do espelho não trava. Cada transação de clínica faz commit antes do `DELETE` final, que roda em autocommit no `app_auth`. Nenhuma conexão segura lock de `team_invites` enquanto espera o espelho, nem o contrário.
  - Um `INSERT ... ON CONFLICT` concorrente com o `DELETE` da mesma chave só espera o commit curto do outro. É espera, não ciclo.
  - Se o aceite desfaz a transação, a linha do espelho sai junto, porque está na mesma transação.
- **Carga inicial ✅.** `migrate.mjs` roda cada migração em `sql.begin`. O `NO FORCE` e o `FORCE` ficam na mesma transação, e uma falha desfaz os dois. O `ACCESS EXCLUSIVE` em `team_invites` dura só a carga. É o mesmo padrão da 0043 e da 0064.
- **Falha no meio ✅.** Se uma clínica falha, o espelho fica intacto, o erro sobe e o suporte roda de novo. A anonimização é idempotente: o filtro `email_hmac <> EMAIL_DESCARTADO` e a trilha só aparecem quando algo muda. O espelho só é esvaziado com falhas = 0. Se o laço de `clinicasAntes` ou o `DELETE` final falhar, o espelho também fica, e rodar de novo resolve. Nenhum caminho apaga o espelho antes de zerar o HMAC.
- **Segredos e dados reais ✅.** O teste usa `@exemplo.test` e "Pessoa Ficticia".

## Checklist

| Item | Situação |
|---|---|
| Base legal | Sem tratamento novo. É uma cópia de ids que já existem, com a única finalidade de atender ao art. 18 IV. ✅ |
| Minimização (conteúdo) | Só ids, só para o `app_auth`. ✅ |
| Retenção | "Enquanto a conta existir" significa para sempre (R18). A finalidade acaba quando o HMAC do convite é descartado (≤ 30 dias depois do aceite). ❌ (V1) |
| Consentimento | Não se aplica. |
| Criptografia | Sem mudança. ✅ |
| Isolamento por tenant | Nenhuma política nova em `team_invites`. O `UPDATE` continua sob RLS da clínica. ✅ |
| Controle de acesso | O `app_user` não tem GRANT. O `app_auth` tem SELECT e DELETE. Falta o teste negativo do `app_user` (V2). ⚠️ |
| Trilha | Igual ao #177, com ator sistema e contagem. ✅ |
| Retenção do prontuário | Não toca. ✅ |
| Segredos e dados reais | Nenhum. ✅ |
| CFM/ANS/ICP-Brasil | Não se aplica. |

## Problemas e correções

**V1 (bloqueia). O espelho tem de sair quando o HMAC sai.** O `convites-descarte` (`descartarEncerradosComoSistema`) zera o HMAC de todo convite aceito há mais de 30 dias. A partir daí, a anonimização não tem mais nada a zerar naquela clínica, e a linha do espelho vira só um histórico de "esta pessoa entrou nesta clínica", guardado para sempre fora da clínica. Escolher uma destas correções:

- **(a) Pelo trigger (preferida, no padrão do ramo `ELSE` da 0064).** Ampliar o trigger para `AFTER INSERT OR UPDATE OF accepted_user_id, email_hmac`. Quando `NEW.accepted_user_id IS NOT NULL` e `NEW.email_hmac = repeat('0', 32)`, apagar `(NEW.accepted_user_id, NEW.tenant_id)` do espelho, a menos que exista outro convite aceito pela mesma pessoa na mesma clínica com o HMAC ainda vivo (`NOT EXISTS` em `public.team_invites` com `tenant_id = NEW.tenant_id`; o dono enxerga a clínica corrente pela policy, como na 0064). Assim, o job de 30 dias e a anonimização limpam o espelho no mesmo `UPDATE`, na mesma transação. No `INSERT` e no aceite, só gravar se o HMAC não estiver descartado.
- **(b) Por prazo.** Acrescentar `aceito_em timestamptz NOT NULL` (com `ON CONFLICT ... DO UPDATE SET aceito_em = greatest(...)`) e apagar no `identidade-expurgo` as linhas com `aceito_em < now() - interval '31 days'`. Exige `DELETE` do job no espelho, que o `app_auth` já tem.

Nas duas opções:

- **Carga inicial:** filtrar `AND i.email_hmac <> repeat('0', 32)`, para não carregar linhas que já nascem sem finalidade.
- **Documentação:** corrigir a linha do RIPD §3 e a da matriz para "até o HMAC do convite ser descartado (≤ 30 dias depois do aceite) ou até a anonimização", com o mecanismo escolhido.
- **Teste:** um convite aceito cujo HMAC foi zerado pelo `descartarEncerradosComoSistema` (data do aceite forçada para trás) não deixa linha no espelho.

**V2 (antes do merge, pequenas).**

- **O teste novo não exercita o caminho da V3.** A pessoa aceita e continua com vínculo, então a clínica está em `clinicasAntes` e o laço do espelho a pula. O teste só prova o `DELETE` final. Acrescentar o caso que justificou a V3: a pessoa aceita em A, é desligada de A (vínculo revogado) e é anonimizada. O teste deve conferir que o HMAC em A está zerado, que existe a trilha `invite_pseudonym_dropped` com ator sistema e que o espelho ficou vazio. Acrescentar também o caso de falha: com uma clínica forçada a falhar, `anonimizarConta` rejeita e a linha do espelho continua lá.
- **Teste negativo de acesso.** Repetir para `identidade.convite_aceito` o que a linha ~364 do contrato faz para `identidade.vinculo`: o `app_user` não lê.
- **`DELETE` final restrito ao que foi lido.** Trocar por `where usuario_id = $1 and clinica_id in (<clínicas lidas>)`. Hoje não há corrida real, porque a conta anonimizada perdeu o e-mail e não aceita convite novo. Mesmo assim, apagar só o que foi processado deixa a garantia explícita ("nada sai do espelho sem ter sido zerado").
- **Docs inconsistentes.**
  - `autenticacao-better-auth.md` §14.8: o mesmo item ainda começa dizendo que a anonimização "percorre a lista do agendador... segundo consumidor da `app_job_tenants()`", e só no fim diz que isso saiu. Reescrever o início no presente certo.
  - `RIPD-identidade.md` §3, linha "Conta": ainda diz "nas demais, em até 30 dias, pelo `convites-descarte`". Desde o #177, o descarte é na hora em todas as clínicas onde a pessoa aceitou convite. Atualizar.
- **`identidade.ts`:** o JSDoc do `vinculo` ficou em cima do `conviteAceito` (dois blocos seguidos), e o `vinculo` ficou sem doc. Devolver o comentário para o lugar dele.

**V3 (fila).**

- Quando a clínica for eliminada no fim do ciclo de saída, as linhas do espelho com aquele `clinica_id` também devem sair. Com a V1 (a), isso acontece sozinho se a eliminação passar pelo descarte do HMAC. Se a eliminação apagar `team_invites` direto, incluir o espelho no roteiro de eliminação da clínica.

## Resumo para o Maestro

- **VETADO** por V1. O espelho não pode ser permanente. Ele tem de sair quando o HMAC do convite é descartado: pelo trigger em `email_hmac` (preferida) ou por prazo de 31 dias no `identidade-expurgo`. A carga inicial deve filtrar os convites com HMAC já descartado, e o RIPD e a matriz precisam ser corrigidos.
- V2: teste do caminho desligado (o que motivou a V3) e da falha, teste negativo do `app_user`, `DELETE` restrito às clínicas lidas, ajustes de docs e do JSDoc.
- Minimização do conteúdo, isolamento, trigger, ausência de deadlock, carga inicial e comportamento na falha: aprovados.

## Nota do Maestro (11/11/2026)

- **V1, opção preferida:** o trigger dispara também em `UPDATE OF email_hmac`. Com o HMAC zerado, ele apaga a linha `(pessoa, clínica)`, salvo se restar outro convite aceito com HMAC vivo da mesma pessoa na clínica, no padrão do ramo ELSE da 0064. O INSERT só acontece com HMAC vivo, e a carga inicial deixa de fora os convites já descartados. RIPD §3 e matriz de retenção atualizados. Teste: o `convites-descarte` de 31 dias tira a clínica do espelho.
- **V2:**
  - **Desligada:** o teste da G3 confere que o espelho termina vazio.
  - **Falha no meio:** teste com o banco da clínica fora; o espelho mantém a clínica e a nova tentativa completa.
  - **Teste negativo:** o `app_user` não lê o espelho.
  - **Apagamento final:** limitado às clínicas lidas no início.
  - **Docs:** a §14.8 e a linha "Conta" do RIPD foram corrigidas, e o JSDoc do `vinculo` voltou para o lugar.
- **V3:** entrou na fila, na §14.8: apagar as linhas do espelho quando a clínica for eliminada.
