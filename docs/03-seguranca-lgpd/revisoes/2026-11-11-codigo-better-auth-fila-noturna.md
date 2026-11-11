# Parecer do Guardião LGPD: fila noturna do Better Auth (G3 completa do #176, R4 do 3a, marca de reuso no login, PR #177)

> Data: 11/11/2026. Branch: `eng/better-auth-fila-noturna` (`a2d175e`), base `eng/better-auth-fila-antiga` (#176). Base: G3 de `2026-11-10-codigo-better-auth-fila-antiga.md`, R4/R5 de `2026-11-05-codigo-better-auth-pr3a.md`, migração 0043 (`app_job_tenants()`), 0019 (sentinela de sistema), `RIPD-identidade.md` §3, arquitetura `autenticacao-better-auth.md` §14.8. Revisão estática do diff `origin/eng/better-auth-fila-antiga...HEAD`. A bancada RLS não rodou aqui (sem Postgres).

## Veredito: **VETADO.** O laço novo da anonimização nunca executa: `withTenant` recusa o `USUARIO_SISTEMA` (V1). Toda anonimização passa a terminar em erro, e o HMAC das clínicas sem vínculo continua lá. A correção é de uma linha. O teste da R4 do 3a está bom. A §14.8 se sustenta no resultado, mas a justificativa escrita precisa de ajuste (V3, não bloqueia).

O que está certo:

- **R4 do 3a ✅ (teste HTTP do cookie).** Um controlador de teste atrás do `SessaoGuard` real, com `@Permissao` e `@SemRenovarSessao`, e sessão com fator.
  - Na rota comum: exatamente **um** `Set-Cookie`, com o nome da sessão, `HttpOnly`, `SameSite=Strict` e `Path=/`, e `expiresAt` estendido no banco.
  - No polling: nenhum `Set-Cookie` e `expiresAt` igual.
  - Cobre o que a R4 pediu ("só o da sessão, também no polling"). Se a extração do cookie vier vazia, o teste dá 401 e falha, ou seja, ele se protege sozinho.
  - Limite aceito: o módulo de teste não monta os middlewares globais do `main.ts`. Um cookie posto por middleware (CSRF, por exemplo) ficaria de fora. Isso fica fora do escopo da R4, que trata do guard. O atributo `Secure` e o prefixo `__Host-` (produção) continuam cobertos pelo teste do filtro `^(__Host-)?sessao=`.
- **Uso de `app_job_tenants()` fora do agendador: aceitável, com condições (V2).** A função devolve só ids, é chamada fora de contexto de clínica (o banco recusa dentro dele), e os ids nunca chegam ao cliente. Cada um só serve para abrir uma transação sob RLS com um `UPDATE` filtrado por `tenant_id` e `accepted_user_id`. Nada de outra clínica vaza para a pessoa nem para a clínica que pediu. O objetivo é o mesmo do agendador: uma operação de sistema por clínica. Não fere o desenho de isolamento da 0043. Fere o texto dela ("para nenhum código de domínio usá-la"), que precisa registrar o segundo consumidor.
- **Idempotência ✅.** O filtro `email_hmac <> EMAIL_DESCARTADO` e o erro no fim permitem rodar de novo, e a mensagem de erro não leva dado pessoal.
- **Teste da G3 ✅ no desenho.** A clínica da qual a pessoa saiu, com convite aceito, termina com o HMAC zerado. Ele vai falhar por causa da V1, o que confirma que o teste está certo.

## Checklist

| Item | Situação |
|---|---|
| Base legal | Sem tratamento novo. A anonimização atende ao art. 18 IV. O descarte do HMAC é minimização (art. 6º III). ✅ |
| Minimização e retenção | O objetivo ("na hora", RIPD §3 e §14.7) não é cumprido: o laço novo não zera nada (V1). ❌ |
| Consentimento | Não se aplica. |
| Criptografia | Sem mudança. ✅ |
| Isolamento por tenant | Cada clínica tem a própria transação, com `app_set_tenant`, RLS e filtro explícito por `tenant_id`. A lista de ids não sai do servidor. ✅ (V2 para o registro do desenho) |
| Controle de acesso | O sentinela de sistema é o papel certo para escrever numa clínica da qual a pessoa já saiu, mas tem de ir pelo caminho previsto (`userId` omitido → `app_set_system_user`). ❌ (V1) |
| Trilha | Nas clínicas sem vínculo, nenhum registro: nem trilha da clínica, nem evento com a contagem. A falha é engolida sem causa. ⚠️ (V2) |
| Retenção do prontuário | Não toca. ✅ |
| Segredos e dados reais | Nenhum. Os e-mails de teste são `@exemplo.test` e o nome é fictício. ✅ |
| CFM/ANS/ICP-Brasil | Não se aplica. |

## Problemas e correções

**V1 (bloqueia). `withTenant(..., USUARIO_SISTEMA)` sempre rejeita.** Em `apps/api/src/db/tenant-transaction.ts`, o `withTenant` faz:

```ts
if (userId !== undefined && (!UUID_RE.test(userId) || userId === USUARIO_SISTEMA)) {
  throw new Error('user_id inválido: esperado UUID de usuário');
}
```

Como a função é `async`, o `throw` vira uma promessa rejeitada, e o `.catch(() => { falhas += 1; })` a engole. Isso acontece em **todas** as clínicas fora de `clinicasAntes`, e em qualquer base há pelo menos uma. Efeitos:

- nenhum convite é zerado nas clínicas sem vínculo (a G3 não é atendida, e a versão mínima da clínica de origem, que estava no #176, foi apagada);
- `anonimizarConta` **sempre** lança no fim, depois de anonimizar a identidade. O suporte roda de novo e falha de novo, para sempre;
- os três testes que chamam `anonimizarConta` na bancada (linhas ~1083, ~1301 e ~1321) ficam vermelhos no CI.

Correção: omitir o quarto argumento. Sem `userId`, o `withTenant` chama `app_set_system_user()`, que é o caminho do sentinela previsto na 0019 e o mesmo que os jobs usam. O `team_invites` (0067) não tem gatilho de autoria que recuse o sistema, então o `UPDATE` passa sob a policy `tenant_isolation`. Depois disso, remover o import de `USUARIO_SISTEMA` de `provedor.ts`.

Acrescentar um teste em que a anonimização **não lança** quando há outras clínicas na base. O teste da G3 já cobre isso de forma indireta, mas um `await expect(provedor.anonimizarConta(id)).resolves.toBeUndefined()` deixa explícito.

**V2 (antes do merge, pequenas).**

- **Trilha e causa.** O `.catch` descarta o erro. Registrar `registrarEventoDeSeguranca` com o código do erro (sem dado pessoal) e, no fim, um evento com o número de clínicas em que o `UPDATE` afetou linhas (por exemplo, `CONTA_ANONIMIZADA` com `motivo: 'convites_sem_vinculo'` e `clinicas: n`). É a prova do atendimento ao titular (art. 37) para essas clínicas. Se houver `rowCount > 0`, gravar também a trilha da clínica com ator `sistema`, do mesmo jeito que o executor de jobs faz.
- **Um caminho só para a lista.** Usar `ClinicasDoAgendador.listar()` (ou repetir o `filter(isTenantId)` dela) em vez de `execute` cru em `dbClinica`.
- **Registro do desenho.** Anotar na 0043 (comentário em nova migração ou em `api-dominio.md` §14) e na §14.8 que `app_job_tenants()` tem um segundo consumidor: a anonimização a pedido do titular, fora de contexto, só ids, para operação de sistema.

**V3 (fila).**

- **Custo O(N).** A anonimização abre uma transação por clínica da plataforma. No piloto é irrelevante. Com centenas de clínicas, vale trocar por uma função `SECURITY DEFINER` estreita que devolva só os `tenant_id` com `team_invites.accepted_user_id = $1`, ou por um índice interno no padrão da 0043. Isso também é mais mínimo que varrer todas.
- **§14.8, marca de reuso antes da conferência.** O resultado está certo, mas o motivo escrito não está.
  - "Gravar depois abriria a corrida" é impreciso. Com `hit` atômico, a marca depois da conferência também fecha a corrida (foi o que aprovei no caminho do provedor, R12/R7). O motivo real na rota `/two-factor/verify-totp` é outro: a conferência e a emissão da sessão são da biblioteca, e só existe o gancho "antes". Uma marca no "depois" chegaria com a sessão já emitida e só poderia barrar o replay desfazendo-a.
  - O custo descrito está certo: o valor errado queima a si mesmo por 90 s e o código certo da pessoa é outro valor. A frase final ("só um código certo seguido de outro erro na mesma requisição...") está confusa. Reescrever assim: "se a requisição com o código certo falhar depois do gancho por outro motivo, a pessoa espera o próximo código".
  - Para queimar o código certo de alguém, o atacante precisa da etapa de senha (cookie de 2FA pendente) e do próprio código. Não há DoS novo.
  - Falha aberta no Redis nessa rota: segue a H1 do #176.

## Resumo para o Maestro

- **VETADO** por V1: troque `USUARIO_SISTEMA` por omitir o `userId` no `withTenant` do laço novo. Depois disso, o CI tem de ficar verde nos testes de anonimização.
- V2 entra junto (evento com causa e contagem, `ClinicasDoAgendador`, registro do segundo consumidor da 0043).
- V3 vai para a fila (função estreita no lugar da varredura; texto da §14.8).
- A R4 do 3a está **resolvida**.

## Nota do Maestro (11/11/2026)

- **V1:** o `withTenant` deixa de receber o 4º argumento e usa `app_set_system_user()`, como os jobs; o import de `USUARIO_SISTEMA` saiu. O teste da G3 roda a anonimização duas vezes numa base com muitas clínicas: a segunda não lança e não repete a trilha. O CI do commit anterior confirmou o veto (falha no RLS).
- **V2:** cada clínica que falha gera `TRILHA_NAO_GRAVADA` (motivo novo `anonimizacao_incompleta`, com `tenantId`), e o resumo sai com a `contagem`. O código do erro não entra, porque o log tem lista fechada de campos e o erro pode trazer texto. Onde houve mudança, a trilha da clínica grava `invite_pseudonym_dropped` com ator sistema e a contagem. A lista vem de `listarClinicasDoAgendador`, a mesma do `ClinicasDoAgendador`, e o `api-dominio.md` registra o segundo consumidor.
- **V3:** a §14.8 foi reescrita com o motivo real e a função estreita entrou na fila.
