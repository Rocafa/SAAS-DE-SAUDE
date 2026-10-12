# Rascunho de relato: bug do postgres.js 3.4.9 em transação cuja conexão cai

> **Estado:** rascunho interno. **Não foi aberta issue externa.** Quem decide abrir o relato no
> [porsager/postgres](https://github.com/porsager/postgres/issues) são os sócios ou o Maestro; o texto em
> inglês da §4 está pronto para colar.
> **Versão afetada:** `postgres@3.4.9`, a última publicada (05/04/2026, conferido com
> `gh release list -R porsager/postgres` em 10/10/2026).
> **Nossa correção:** [`patches/postgres@3.4.9.patch`](../../patches/postgres@3.4.9.patch), aplicada pelo
> `pnpm.patchedDependencies`. Achado A3 em [testes-de-producao.md](testes-de-producao.md) §3.

## 1. O problema em uma frase

Quando o servidor encerra a conexão de uma transação aberta com `sql.begin()` (timeout de transação
ociosa, failover, restart, rede), o postgres.js 3.4.9 pode continuar executando as queries do callback na
conexão **já reconectada**, fora da transação. A aplicação recebe "transação concluída" com os dados
errados gravados.

## 2. Sintomas (os três que encontramos)

| # | Sintoma | Efeito |
|---|---|---|
| a | A próxima escrita no socket fechado lança `TypeError` **não capturado** em `nextWrite` | O Node encerra o processo |
| b | Um `nextWriteTimer` antigo sobrevive ao `closed()` e impede o `StartupMessage` da reconexão | `CONNECT_TIMEOUT` eterno naquela conexão: a instância fica zumbi com readiness 200 |
| c | O callback da transação continua emitindo queries, e elas vão para a conexão reconectada: fora da transação, ou dentro da transação de **outra** chamada | `begin()` resolve com sucesso e grava dado parcial ou duplicado; no nosso caso, sem o contexto de clínica (o RLS bloqueou, mas é a camada errada para segurar isso) |

## 3. Reprodução mínima (Postgres 16 local, sem a nossa aplicação)

Banco descartável, superusuário só para criar a tabela. Executado em 10/10/2026 com Node 24.

```js
// repro-escrita.mjs — uso: DATABASE_URL=postgres://... node repro-escrita.mjs <pasta com node_modules/postgres>
import { createRequire } from 'node:module';
const require = createRequire(process.argv[2] + '/');
const postgres = require('postgres');
const sql = postgres(process.env.DATABASE_URL, {
  max: 1,
  onnotice: () => {},
  connection: { idle_in_transaction_session_timeout: 300 },
});
process.on('uncaughtException', (e) => console.log('UNCAUGHT EXCEPTION:', e.name, e.message));
await sql`drop table if exists conta`;
await sql`create table conta (id int primary key, saldo int not null)`;
for (const idle of [350, 400, 450, 500, 550, 600]) {
  await sql`truncate conta`;
  await sql`insert into conta values (1, 100), (2, 0)`;
  let resultado;
  try {
    await sql.begin(async (tx) => {
      await tx`update conta set saldo = saldo - 100 where id = 1`; // débito
      await new Promise((r) => setTimeout(r, idle)); // o servidor mata a sessão ociosa
      await tx`update conta set saldo = saldo + 100 where id = 2`; // crédito
    });
    resultado = 'begin RESOLVEU';
  } catch (e) {
    resultado = `begin rejeitou ${e.code ?? e.name}`;
  }
  const linhas = await sql`select id, saldo from conta order by id`;
  console.log(`idle=${idle}: ${resultado}; saldos=${linhas.map((l) => `${l.id}:${l.saldo}`).join(' ')}`);
}
await sql.end({ timeout: 1 });
```

**Resultado com `postgres@3.4.9` do npm (sem patch):**

```
idle=350: begin rejeitou CONNECTION_CLOSED; saldos=1:100 2:0
idle=400: begin RESOLVEU; saldos=1:0 2:200
idle=450: begin rejeitou CONNECTION_CLOSED; saldos=1:100 2:0
idle=500: begin RESOLVEU; saldos=1:0 2:200
idle=550: begin rejeitou CONNECTION_CLOSED; saldos=1:100 2:0
idle=600: begin RESOLVEU; saldos=1:0 2:200
```

O certo seria `begin` rejeitar sempre, com saldos `1:100 2:0`. Em metade das rodadas, `begin()`
**resolve** e o banco termina com `1:0 2:200`: o débito e **dois** créditos foram gravados, embora a
transação desta rodada só tivesse um. Hipótese, coerente com o sintoma (c): o crédito da transação morta
da rodada anterior ficou na fila e foi executado na conexão reconectada, junto com a transação seguinte.
Numa variação só com `select`, o Postgres registra `WARNING 25P01: there is no transaction in progress` no
`COMMIT`, o que confirma que as queries do callback rodaram fora da transação.

**Resultado com o nosso patch:** as 6 rodadas rejeitam com `CONNECTION_CLOSED` e os saldos ficam
`1:100 2:0` em todas.

No repositório, o teste de regressão é `transacoes.resiliencia.ts` ("transação esquecida aberta é
encerrada pelo Postgres, sem crash, e o pool se recupera"), que roda no CI (job de resiliência).

## 4. Texto da issue (inglês, pronto para colar)

> **Title:** `sql.begin()` keeps running callback queries on the reconnected connection after the transaction's connection is closed (partial/duplicate commits, uncaught TypeError, stuck reconnect)
>
> **Version:** postgres 3.4.9 (latest), Node 22/24, PostgreSQL 16.
>
> **What happens.** When the server terminates the connection that holds a `sql.begin()` transaction
> (e.g. `idle_in_transaction_session_timeout`, failover, restart) while the callback is still running:
>
> 1. Queries issued by the callback after the close are sent on the *same* `Connection` object once it
>    reconnects — outside any transaction, or interleaved with the next transaction that reuses it.
>    `begin()` can then **resolve successfully** while only part of the work (or duplicated work) is
>    committed. With `select`s only, the final `COMMIT` logs `WARNING 25P01: there is no transaction in
>    progress`.
> 2. `nextWrite()` can run after `socket` was cleared and throws an **uncaught** `TypeError`, which
>    crashes the process.
> 3. `closed()` calls `clearImmediate(nextWriteTimer)` but does not reset `chunk`/`nextWriteTimer`, so the
>    stale value prevents the reconnect's `StartupMessage` from being written: that connection never
>    reconnects (endless `CONNECT_TIMEOUT`).
>
> **Repro.** Script above (`max: 1`, `idle_in_transaction_session_timeout: 300`, callback sleeps
> 350–600 ms between two updates). Expected: every iteration rejects and balances stay `1:100 2:0`.
> Actual: every other iteration resolves with `1:0 2:200`.
>
> **Suggested fix** (what we run in production as a patch, ~20 lines, `src/` and `cjs/src/`):
> - in `begin()`, mark the transaction as lost when `connection.onclose` fires, and make the scoped
>   `handler(q)` reject new queries with `CONNECTION_CLOSED` instead of executing them;
> - in `nextWrite()`, return early when `socket` is null (clear the timer and chunk);
> - in `closed()`, reset `chunk = nextWriteTimer = null` after `clearImmediate`.
>
> Happy to open a PR with these changes and a test if that helps.

## 5. Como sair do patch

1. Quando sair uma versão do postgres.js com a correção, atualizar a dependência. O install falha se o
   patch não aplicar, então ninguém esquece.
2. Remover a entrada de `pnpm.patchedDependencies` e o arquivo do patch.
3. Rodar `pnpm --filter @plataforma/api test:resiliencia` e o script da §3 contra a versão nova. Só
   remover o patch se as duas coisas passarem.

## 6. Atenção ao subir o pnpm

O pnpm 10+ avisa `The "pnpm" field in package.json is no longer read` e ignora o
`pnpm.patchedDependencies` do `package.json` (o aviso já aparece nesta máquina, que tem um pnpm global
mais novo). O projeto fixa `pnpm@9.12.0` (`packageManager`) e o lockfile registra o hash do patch, então
hoje o patch é aplicado (`node_modules/.pnpm/postgres@3.4.9_patch_hash=...`). Antes de subir para o pnpm
10, mover a configuração para `pnpm-workspace.yaml` (`patchedDependencies:`), senão a correção some sem
aviso.
