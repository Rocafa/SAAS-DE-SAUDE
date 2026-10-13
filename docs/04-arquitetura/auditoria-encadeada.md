# Auditoria encadeada por clínica (S6)

> Rodada 8, frente Engenharia. Migração `0005_auditoria_encadeada.sql` e verificador `apps/api/src/modules/audit/audit-chain.ts`.
> Origem: item S6 do [relatório da rodada 7](../relatorios/2026-10-10-rodada-7-necessidades-producao.md) ("auditoria completa com encadeamento de hash"). A trilha `audit_log` já era append-only (0002: privilégio + trigger) e isolada por clínica (0003).

## 1. O que muda

Cada linha nova de `audit_log` ganha três colunas, preenchidas **pelo banco**, na mesma transação do INSERT:

| Coluna | Conteúdo |
|---|---|
| `seq` | Posição na cadeia da clínica: 1, 2, 3, … (única por clínica) |
| `prev_hash` | `hash` da linha anterior da mesma clínica; 64 zeros na primeira |
| `hash` | SHA-256 (hex) do **JSON canônico** da linha, que inclui `seq` e `prev_hash` |

JSON canônico (`audit_log_canonical`): `jsonb_build_object(v, tenant_id, seq, prev_hash, id, actor_id, action, scope, metadata, created_at)::text`. O `jsonb` ordena as chaves, elimina duplicatas e tem espaçamento fixo, então o texto é determinístico. A data vai sempre em UTC com microssegundos, independente do fuso da sessão. FATO: "jsonb does not preserve white space, does not preserve the order of object keys, and does not keep duplicate object keys" ([PostgreSQL 16, JSON Types](https://www.postgresql.org/docs/16/datatype-json.html), consultado em 11/10/2026).

O código da aplicação não muda: `recordAudit` grava como antes e o trigger encadeia.

## 2. Sem corrida

O trigger `audit_log_chain` (BEFORE INSERT):
1. pega `pg_advisory_xact_lock` com a chave da clínica, que vale até o fim da transação;
2. lê o último elo da clínica (`seq` máximo);
3. calcula `seq`, `prev_hash` e `hash`.

Duas transações da mesma clínica nunca leem o mesmo último elo. Clínicas diferentes não se bloqueiam. Se a transação desfaz, o elo some com ela e não fica buraco. O índice único `(tenant_id, seq)` é a última barreira.

Custo: as gravações de auditoria de uma mesma clínica ficam em série. ESTIMATIVA: irrelevante no volume de uma clínica, mas a trava vale até o COMMIT, então transações longas que auditam cedo seguram as outras da mesma clínica. Recomendação: auditar perto do fim da transação.

## 2a. Exige READ COMMITTED

O trigger lê o último elo **depois** de pegar a trava, com um snapshot novo, e isso só acontece em `READ COMMITTED`, o padrão do Postgres e do `withTenant`. Em `REPEATABLE READ` ou `SERIALIZABLE`, o snapshot da transação esconderia o elo que outra transação acabou de gravar, e a cadeia bateria em `duplicate key` no índice `(tenant_id, seq)`. Por isso o trigger **recusa** gravar fora de `READ COMMITTED`, com o erro `audit_log exige transação READ COMMITTED`. Há teste para isso.

A data (`created_at`) entra no hash e é sempre a do banco (`now()`): o trigger ignora a enviada por quem grava. Um `CHECK (seq IS NOT NULL) NOT VALID` é a segunda barreira para que nenhuma linha nova fique fora da cadeia.

## 3. Quem pode o quê

- O runtime (`app_user`) **não define** `seq`, `prev_hash` nem `hash`: se tentar, o trigger recusa.
- O dono da tabela ou um superusuário pode trazer elos prontos (carga de dados já encadeados), mas só se continuarem a cadeia e baterem com o próprio conteúdo.
- O `pg_restore` carrega os dados antes de criar os triggers, então a cadeia restaurada é a original. O `test:backup-restore` continua verde.
- Continua valendo da 0002 e 0003: sem UPDATE, DELETE nem TRUNCATE para ninguém (trigger) e RLS FORCE por clínica.

## 4. Verificação

`verifyAuditChain(tx, tenantId, { anchor? })`, rodado dentro de `withTenant`:
- o banco recalcula o JSON canônico a partir das colunas **atuais** e o verificador recalcula o SHA-256 em `node:crypto`;
- confere cada `hash`, cada elo `prev_hash` e a continuidade de `seq`;
- devolve `{ ok, checked, legacy, head, problems[] }`, com o tipo e a posição de cada problema.

| Ataque | Detectado como |
|---|---|
| Alterar uma coluna (ação, autor, escopo, metadados, data) | `hash_mismatch` na linha |
| Alterar e recalcular o hash da própria linha | `broken_link` na linha seguinte |
| Apagar uma linha do meio | `gap` + `broken_link` |
| Reordenar (trocar `seq` entre linhas) | `hash_mismatch` (o `seq` está dentro do hash) |
| Apagar as últimas linhas | `truncated`, **só com âncora** |
| Reescrever a cadeia inteira com hashes novos | `anchor_mismatch`, **só com âncora** |

### Limite: o fim da cadeia precisa de âncora externa

Quem tem acesso privilegiado ao banco pode apagar as últimas linhas ou recalcular a cadeia inteira, e uma cadeia de hash sozinha não percebe. A defesa é publicar o último elo (`auditChainHead`) **fora do banco**, num lugar que nem o administrador consegue reescrever (S3 com Object Lock, que já está no plano de backups), e verificar contra essa âncora. ESTIMATIVA de periodicidade: diária por clínica, junto com o backup.

**Pendente (DevOps + Engenharia):** o job que publica as âncoras e roda a verificação periódica com alerta. Este PR entrega o mecanismo e a função de verificação.

### O que a âncora não cobre

Com âncora, detecta-se corte **até a âncora**: uma linha gravada depois da última âncora publicada e apagada antes da próxima passa sem alarme. Isso é inevitável no modelo, e a frequência de publicação é a janela de exposição. `out_of_order` só aparece quando as linhas chegam fora de ordem à função pura; pelo banco elas vêm ordenadas por `seq`, e a troca de posição aparece como `hash_mismatch`. Os dois casos têm teste.

## 4a. Contrato do `metadata` (ressalva R1 do Guardião)

A trilha é append-only, encadeada e **não cifrada**. Um dado pessoal que entre nela fica para sempre, fora do alcance da criptografia de campo, e removê-lo quebraria a cadeia. Por isso o `metadata` só aceita identificadores, códigos e contagens:

| Regra | Limite |
|---|---|
| Objeto plano | Até 16 chaves. Não há limite de tamanho total separado: os limites por chave e por valor já o fixam (≈ 2 KB), e medir o JSON inteiro daria números diferentes na aplicação (`JSON.stringify`) e no banco (`jsonb::text`, com espaços) |
| Chave | `^[a-zA-Z][a-zA-Z0-9_]{0,39}$`, fora da lista de nomes de conteúdo (`antes`, `depois`, `nome`, `cpf`, `email`, `texto`, `diagnostico`, `evolucao`…) |
| Valor | Só escalar (texto, número, booleano, nulo) |
| Texto | Até 64 caracteres, sem `@` e com **menos de 8 dígitos no total**, contados depois de remover tudo que não é dígito. Pega CPF com qualquer separador (`_`, `/`, NBSP), CNS e telefone com ou sem DDD. UUID e hash hex ficam de fora, porque são referências |
| Número | Abaixo de 10⁷ (um telefone de 9 dígitos digitado como número é recusado) |

Vale **no banco** (`audit_metadata_ok` + `CHECK ... NOT VALID`, então pega também o INSERT que não passa pela API) e **na aplicação** (`assertAuditMetadata` em `recordAudit`, com erro que diz a regra e nunca o valor). Um teste confere que as duas regras concordam em todos os casos. Quando for indispensável registrar o que mudou, registre a **referência** (tabela, coluna, id da linha) e deixe o valor no campo cifrado (S5).

Pendente: o contrato **por ação** (quais chaves cada `action`/`scope` pode ter), versionado, que depende do catálogo de ações do produto.

## 4b. Ações (migração 0006)
O enum `AuditAction` de `packages/shared/src/enums.ts` e o CHECK `audit_log_action_check` têm exatamente os mesmos valores. Um teste de paridade em `test/audit-chain.rls.test.ts` lê o CHECK do catálogo e compara com o enum. Ação nova exige mudar os dois no mesmo PR.

A 0006 acrescentou, por decisão do Maestro (ORDEM-004, resposta 5):

| Ação | Quando |
|---|---|
| `key_provision`, `key_rotate`, `key_destroy` | Ciclo de vida das chaves por clínica (criptografia de campo, migração 0004) |
| `ai_use`, `ai_refusal` | Uso de IA sobre dado da clínica e recusa pela política. Nunca o conteúdo |
| `break_glass` | Acesso de emergência fora da permissão normal; exige revisão posterior |

A migração só amplia o conjunto: as linhas antigas continuam válidas e o hash delas não muda.

**Prazo de guarda (D7, ORDEM-004):** default configurável de 20 anos para eventos de prontuário e 5 anos para os administrativos (proposta de `retencao-e-descarte.md`). A decisão final é dos sócios. O job de expurgo ainda não existe; quando existir, a classificação sai do `scope` e da ação.

## 5. Linhas antigas

Linhas gravadas antes da 0005 ficam com `seq` nulo (fora da cadeia). O append-only impede reescrevê-las e o verificador as conta em `legacy`. Hoje só existem em ambientes de teste, porque não há produção.

## 6. Testes

| Suíte | O que prova |
|---|---|
| `src/modules/audit/audit-chain.test.ts` (8) | Verificador puro: íntegra; adulterar; adulterar com hash recalculado; apagar; reordenar; trocar `seq`; corte do fim e reescrita contra âncora; gênese |
| `test/audit-chain.rls.test.ts` (11, Postgres real) | Elos gerados pelo banco; **30 transações concorrentes** formam cadeia contínua; rollback sem buraco; cadeias independentes e isoladas por clínica; runtime não forja elos nem grava em outra clínica; adulteração **privilegiada** (dono sem RLS forçado e sem trigger) de metadados, ação, autor e data; apagar; reordenar; corte do fim pego pela âncora |
| `src/modules/audit/audit-metadata.test.ts` (21) | Contrato do `metadata`: aceita os formatos em uso (contagem, exportação, id de chave) e recusa CPF, CNS, telefone, e-mail, texto longo, chave de conteúdo, valor aninhado e número grande; o erro não repete o valor |
| `test/audit-chain.rls.test.ts`, contrato (2) | O banco recusa dado pessoal mesmo por SQL direto; as regras do banco e da aplicação concordam em todos os casos |
| `test:backup-restore` | Restauração com `pg_dump`/`pg_restore` segue íntegra com a 0005 |
