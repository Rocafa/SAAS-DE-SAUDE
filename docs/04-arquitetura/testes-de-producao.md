# Testes de produção e resiliência

Como a API se comporta quando algo dá errado — e como isso é **provado** em teste contra Postgres
real. Workflow: `.github/workflows/producao.yml` (todo PR, push na `main`, semanal às segundas 06:00 UTC
e manual). Só dados fictícios gerados a cada execução; nenhuma credencial além das senhas descartáveis
dos containers efêmeros de CI.

## 1. Saúde: liveness x readiness

| Endpoint | Pergunta | Toca o banco? | Falha => | Uso |
|---|---|---|---|---|
| `GET /health` | O processo está vivo e servindo HTTP? | **Não** | (só falha se o processo travar) | liveness do orquestrador (ECS/K8s): reinicia o container |
| `GET /health/ready` | Esta instância pode receber tráfego? | Sim: `select 1` com timeout total de 1 s, conexão **própria** (max 1) | `503 {"status":"indisponivel"}` | health check do balanceador: tira/devolve a instância do pool |

- Banco fora **não** derruba a liveness: evita reinício em loop de todas as instâncias por causa de um
  problema que não é delas.
- A sonda de readiness usa conexão separada do pool de domínio: carga alta no pool não tira a
  instância do balanceador (não há efeito cascata). Pool esgotado é tratado na própria requisição (503).
- Durante o encerramento (SIGTERM) a readiness responde 503 para o balanceador drenar a instância.
- O corpo é sempre só `{status}`: sem host, versão, latência ou mensagem de erro.

## 2. Ajustes do banco (`apps/api/src/db/pool-config.ts`)

| Variável | Padrão | Efeito |
|---|---|---|
| `DB_POOL_MAX` | 10 | conexões por instância (dimensionar: instâncias x max < `max_connections` do RDS, com folga para migração/admin) |
| `DB_CONNECT_TIMEOUT_S` | 5 | TCP + autenticação |
| `DB_IDLE_TIMEOUT_S` | 30 | fecha conexões ociosas |
| `DB_MAX_LIFETIME_S` | 1800 | recicla conexões (pega o novo primário após failover/troca de DNS) |
| `DB_STATEMENT_TIMEOUT_MS` | 5000 | `statement_timeout` **por conexão** (pacote de startup): o Postgres cancela a query (57014) |
| `DB_IDLE_IN_TX_TIMEOUT_MS` | 10000 | `idle_in_transaction_session_timeout`: transação esquecida aberta é encerrada pelo Postgres |
| `DB_ACQUIRE_TIMEOUT_MS` | 2000 | espera máxima por vaga no pool; depois `PoolExhaustedError` (503) em vez de fila infinita |
| `DB_TRANSACTION_TIMEOUT_MS` | 15000 | prazo **do cliente** para a transação inteira; se estourar, 503 e a transação é forçada a ROLLBACK quando terminar |

Valor inválido derruba o boot (erro de deploy, não ajuste silencioso). Reconexão: o cliente
(postgres.js) reconecta sozinho; o backoff foi limitado a 1 s (ver achado A2).

Erros viram resposta genérica no `AllExceptionsFilter` (`apps/api/src/lifecycle/`):
- falha de conexão, timeout, pool esgotado, SQLSTATE classes 08/53/57, 25P03, 40001/40P01 → **503** +
  `Retry-After: 5`, corpo `{"statusCode":503,"message":"Serviço temporariamente indisponível"}`;
- qualquer outro erro → **500** `{"statusCode":500,"message":"Erro interno"}`;
- `HttpException` mantém o status intencional. Nunca há stack, SQL, SQLSTATE ou mensagem interna na
  resposta; o log leva só nome + código do erro (mensagens/`detail` do Postgres podem conter valores de
  linha, i.e., dado pessoal).

Encerramento (`installGracefulShutdown`, em `main.ts`): SIGTERM/SIGINT → readiness 503 → `app.close()`
(para de aceitar conexões, espera as requisições em curso, depois fecha pool e sonda) → `exit(0)`;
watchdog de 25 s força `exit(1)`. `unhandledRejection` é registrado e **não** derruba o processo;
`uncaughtException` faz encerramento gracioso com código 1 (estado desconhecido → orquestrador substitui).

## 3. Catálogo de modos de falha

Testes em `apps/api/test/resiliencia/` (`pnpm --filter @plataforma/api test:resiliencia`). A queda do
banco é injetada por um **proxy TCP** entre a API e o Postgres real (mesmo comportamento local e no CI).

| # | Falha | Detecção | Comportamento esperado | Teste | Status |
|---|---|---|---|---|---|
| F1 | Banco parado (conexões derrubadas, porta recusando) | erro de conexão (ECONNREFUSED/CONNECTION_CLOSED) | `/health` 200; `/health/ready` 503 em < 2,5 s; rotas com banco 503 genérico + Retry-After; processo vivo | `banco-fora` › banco PARADO | ✅ |
| F2 | Banco volta | sonda de readiness | ready volta a 200 e o domínio funciona **sem reiniciar a API** | `banco-fora` › banco VOLTA | ✅ (após correção A2) |
| F3 | Rede particionada (TCP aceita, ninguém responde) | timeout de conexão + prazo da transação | 503 em ≤ prazo (teste: 3 s), recupera ao normalizar | `banco-fora` › rede particionada | ✅ (após correção A1) |
| F4 | Query lenta | `statement_timeout` (57014) | Postgres cancela; 503 | `banco-fora` e `transacoes` › CANCELADA | ✅ |
| F5 | Transação esquecida aberta | `idle_in_transaction_session_timeout` (servidor encerra a sessão) | erro transitório na requisição; **sem crash**; pool se recupera | `transacoes` › esquecida (4 variações de tempo) | ✅ (após correção A3) |
| F6 | Erro no meio de `withTenant` (aplicação ou banco) | exceção na transação | ROLLBACK total: nada parcial gravado, **inclusive a auditoria do export** | `transacoes` › rollback (erro de app e statement_timeout após o audit) | ✅ |
| F7 | Pool esgotado | `acquireTimeout` | `PoolExhaustedError` → 503 em ~300 ms (teste); readiness continua 200; normaliza depois | `transacoes` e `banco-fora` › pool | ✅ |
| F8 | Transação passa do prazo do cliente | `transactionTimeout` | 503 imediato; transação termina em ROLLBACK (nunca "falhou" para algo gravado); vaga só volta quando a conexão libera | `transacoes` › prazo do cliente | ✅ |
| F9 | SIGTERM com requisição em curso | sinal | requisição termina 200; readiness 503; nenhuma conexão da API sobra no Postgres; `exit(0)` | `encerramento` (processo falso) + job `carga` (SIGTERM real no Linux) | ✅ |
| F10 | Encerramento que não drena | watchdog | `exit(1)` no prazo | `encerramento` › watchdog | ✅ |
| F11 | Exceção não tratada / erro SQL não transitório | filtro global | 500 genérico sem stack, caminho, SQL ou SQLSTATE | `banco-fora` › exceções | ✅ |
| F12 | Promise rejeitada sem tratamento / exceção não capturada | handlers de processo | rejeição: log e segue; exceção: encerramento gracioso com 1 | `encerramento` › erros fora do ciclo | ✅ |
| F13 | Perda/corrupção do banco → restauração de backup | `test:backup-restore` | dump restaura com contagens iguais; migrações no-op; RLS ENABLE+FORCE, policies, dono `app_migrator`, isolamento por tenant e append-only do `audit_log` (privilégio + trigger, inclusive contra superusuário) valem no restaurado | `backup-restore.mjs` (CI: `pg_dump`/`pg_restore` do container) | ✅ CI / local via `template` |
| F14 | Carga moderada | k6 thresholds | p95 < 300 ms e erros < 1% em `/health` e `/health/ready` (smoke 15 s + rampa a 50 req/s por 1 min) | `tests/carga/health.k6.js` (job `carga`) | ✅ CI (k6 não roda localmente) |

### Achados corrigidos nesta rodada

- **A1 — requisição pendurada com rede particionada.** O postgres.js re-enfileira a query a cada
  `CONNECT_TIMEOUT`; a requisição levava ~16 s (sem limite real). Correção: prazo do cliente por
  transação (`DB_TRANSACTION_TIMEOUT_MS`) com ROLLBACK forçado se a transação terminar depois do prazo.
- **A2 — API demorava até 20 s para voltar a usar o banco recuperado.** O backoff padrão do postgres.js
  cresce `3^n/100` s (teto 20 s) por falha acumulada. Correção: backoff com teto de 1 s (o `SlotLimiter`
  já limita a pressão no banco).
- **A3 — bug do postgres.js 3.4.9 (última versão publicada) que derruba o processo e cruza contexto de
  transação.** Quando o servidor encerra a conexão de uma transação (ex.: `idle_in_transaction_session_timeout`,
  failover, restart): (a) a próxima escrita lança `TypeError` **não capturado** (o Node encerra o
  processo); (b) um timer "velho" impede a reconexão daquela conexão (CONNECT_TIMEOUT eterno — instância
  zumbi com readiness 200); (c) o callback da transação continua emitindo queries que vão para a mesma
  conexão **já reconectada**: fora da transação, sem contexto de tenant (observado: `count(*) = 0`) ou
  dentro da transação de **outra** requisição; também corrompia o handshake (`expected password response,
  got message type 81`). RLS + WITH CHECK fazem falhar fechado, mas é exatamente a classe de bug que a
  defesa em profundidade não deveria precisar segurar. Correção: `patches/postgres@3.4.9.patch`
  (`pnpm.patchedDependencies`): guarda de socket nulo em `nextWrite`, reset do timer em `closed()`, e
  `begin()` rejeita queries do callback depois que a conexão da transação caiu. **Pendência:** reportar
  upstream; ao atualizar o postgres.js o patch deixa de aplicar e o install falha — rodar
  `test:resiliencia` antes de remover o patch.

## 4. Backup e restauração

`pnpm --filter @plataforma/api test:backup-restore` (`apps/api/test/resiliencia/backup-restore.mjs`):
semeia 3 tenants fictícios (5 pacientes + 2 eventos de auditoria cada), faz `pg_dump --format=custom`,
restaura com `pg_restore --exit-on-error` em `<banco>_restaurado`, roda `db:migrate` (precisa ser no-op)
e verifica os itens de F13. Variáveis: `DATABASE_URL`, `DATABASE_MIGRATOR_URL`, `BACKUP_ADMIN_URL`
(superusuário do cluster **de teste**), `BACKUP_METHOD` (`pg_dump` | `template`), `PG_DUMP_CMD`,
`PG_RESTORE_CMD`. Privilégios de **banco** (`GRANT CONNECT`, `REVOKE TEMPORARY`) não fazem parte do
dump: vêm da infraestrutura (`infra/local/postgres-init.sh` / Terraform) e o script os reaplica.
O método `template` (cópia física) existe só para máquinas sem cliente do Postgres; não prova o `pg_dump`.

Isto prova que o **dump lógico** restaura íntegro e seguro. Não substitui o teste de restauração do
backup gerenciado (snapshot/PITR do RDS) — ver §6.

## 5. Carga

`tests/carga/health.k6.js` (k6 1.8.1 fixado no workflow): smoke (1 VU, 15 s) + carga moderada
(`ramping-arrival-rate` até 50 req/s, 1 min sustentado). Thresholds: `http_req_failed < 1%`,
p95 < 300 ms por endpoint, `checks > 99%`. 50 req/s é ESTIMATIVA de ordem de grandeza para uma
instância em pico, não medição de produção. A API sobe compilada (`node --import
./tests/carga/resolver-ts.mjs apps/api/dist/main.js`): o resolver só existe porque `packages/shared` é
TypeScript puro (importa `./x.js` apontando para `./x.ts`); a imagem de produção deve empacotar o shared
compilado (pendência de build). Depois do k6 o job envia **SIGTERM real** e exige encerramento gracioso.

## 6. O que AINDA não é coberto (só documentado)

| Cenário | Por que não está coberto | Como cobrir |
|---|---|---|
| Failover Multi-AZ do RDS | exige RDS real; o proxy simula a queda/volta mas não a troca de DNS do endpoint | game day em staging: `reboot-db-instance --force-failover` com k6 rodando; medir janela de 503 e confirmar que `DB_MAX_LIFETIME_S`/reconexão pegam o novo primário |
| Restauração de snapshot/PITR do RDS | backup gerenciado não roda no CI | restauração trimestral em conta isolada + `backup-restore.mjs` adaptado (sem semear) para verificar RLS/append-only; registrar RTO/RPO medidos |
| DR regional (perda de sa-east-1) | sem réplica cross-region definida; envolve LGPD (transferência internacional) | decisão de arquitetura + parecer do Guardião LGPD antes de qualquer cópia fora do país |
| Latência/perda parcial de pacotes, banco lento sem cair | proxy atual só faz "parado" e "buraco negro" | adicionar modo de latência/jitter ao proxy (ou toxiproxy) |
| Banco somente leitura (réplica promovida errada, disco cheio) | 53100 (disco cheio) já vira 503; 25006 (read-only) hoje vira 500; sem teste dedicado | classificar 25006 como transitório + teste com `default_transaction_read_only` na conexão |
| Redis/BullMQ, S3, integrações externas (WhatsApp, pagamento, NFS-e, assinatura) | ainda não existem no código | circuit breaker + timeout por integração, com teste de falha no mesmo padrão |
| Carga em rotas de domínio (agenda, prontuário) e soak test | rotas ainda não expostas (dependem de auth/RBAC) | estender o k6 com usuários e tenants fictícios quando houver auth |
| Exaustão de `max_connections` do servidor (várias instâncias) | teste cobre o pool de uma instância | dimensionar `DB_POOL_MAX` x instâncias; avaliar RDS Proxy |
