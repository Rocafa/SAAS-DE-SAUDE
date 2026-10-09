# Testes de segurança ofensivos

> O atacante tenta; o teste prova que falha. Um ataque que passa é **achado**: corrige-se e o
> teste vira regressão permanente no CI. Somente dados fictícios, gerados a cada execução.
> Complementa [seguranca-na-arquitetura.md](seguranca-na-arquitetura.md) e
> [garantia-de-saida.md](garantia-de-saida.md).

## Como rodar

| Suíte | Onde | Comando | Requer |
|---|---|---|---|
| Banco (ofensiva) | `apps/api/test/security/db-attacks.security.test.ts` | `pnpm --filter @plataforma/api test:security` | Postgres 16 com `infra/local/postgres-init.sh` + `db:migrate`; `DATABASE_URL` = `app_user` (igual ao `test:rls`) |
| HTTP (ofensiva) | `apps/api/test/security/http-attacks.test.ts` | idem, e também em `pnpm test` | nada (API Nest em processo) |
| Web (headers) | `apps/web/security-headers.test.ts` | `pnpm --filter @plataforma/web test` | nada |
| DAST | `.github/workflows/seguranca.yml`, job `dast` | só no CI | API real (`serve:dast`) + Postgres service + `ghcr.io/zaproxy/zaproxy:2.16.1` |

O workflow `seguranca.yml` roda em PR, push na `main`, semanalmente e manualmente. O job
`ataques` repete o padrão do job `rls` do `ci.yml`; o job `dast` falha se o ZAP baseline
reportar qualquer alerta de risco **Alto** (riskcode 3) e publica o resumo no job summary.

## Ataques → testes

Modelo de ameaça do banco: o atacante executa SQL arbitrário como `app_user` (ex.: injeção
num repositório), dentro ou fora de `withTenant`.

| # | Ataque | Teste | Resultado esperado | ASVS 4.0.3 / Top 10 2021 |
|---|---|---|---|---|
| 1 | `set_config('app.tenant_id', B)` / `SET LOCAL` no meio da transação de A e ler | `troca de contexto de tenant` | nenhuma linha de B (a GUC não tem mais efeito) | V4.1.1, V4.2.1 / A01 |
| 2 | Chamar `app_set_tenant(B)` dentro da transação de A (direto ou via savepoint) | idem | erro `contexto de tenant já definido nesta transação` | V4.1.3 / A01 |
| 3 | `RESET app.tenant_id`, `RESET ALL`, `SET SESSION`/`BEGIN; SET LOCAL` fora de `withTenant` | idem | 0 linhas em `patients`, `tenants`, `audit_log` (falha fechada) | V4.1.5 / A01 |
| 4 | Ler/gravar/apagar `tenant_context` | idem | `permission denied` | V4.1.3 / A01 |
| 5 | `SET ROLE app_migrator`/`postgres`, `SET SESSION AUTHORIZATION`, `ALTER ROLE … BYPASSRLS`, `CREATE ROLE` | `escalada de privilégio e DDL` | `permission denied` | V1.4.3, V4.1.3 / A01 |
| 6 | `ALTER TABLE … DISABLE/NO FORCE ROW LEVEL SECURITY`, `DISABLE TRIGGER`, `DROP/ALTER/CREATE POLICY`, `DROP TABLE`, `ALTER FUNCTION … OWNER` | idem | `must be owner` | V1.4.3, V14.2 / A05 |
| 7 | `CREATE TABLE/FUNCTION/SCHEMA` em `public` (inclusive substituir `app_current_tenant`) | idem | `permission denied` | V1.4.3 / A05 |
| 8 | `CREATE TEMP TABLE patients` (sombrear a tabela real na conexão do pool) e função em `pg_temp` | idem | `permission denied` | V1.4.3 / A01, A05 |
| 9 | Ler `pg_authid`/`pg_shadow`; `pg_read_file`; `COPY … TO` arquivo/PROGRAM; ler `schema_migrations` | idem | `permission denied` | V2.4.1, V12.3 / A01, A02 |
| 10 | `UPDATE`/`DELETE`/`TRUNCATE` em `audit_log` com contexto do próprio tenant | `auditoria append-only` | `permission denied` | V7.3.3, V7.3.4 / A09 |
| 11 | A insere `audit_log` com `tenant_id` de B; A faz UPDATE/DELETE/INSERT cruzado em `patients` de B | idem | erro de RLS / 0 linhas afetadas; B intacto | V4.2.1, V7.3.3 / A01 |
| 12 | SQLi no `tenantId` (`' OR 1=1 --`, `'; DROP TABLE patients; --`, UNION, fullwidth, RTL, UUID + `\n`) em `withTenant` e `exportTenantData` | `SQL injection via funções públicas` | `tenant_id inválido` antes de abrir transação | V5.3.4, V5.1.3 / A03 |
| 13 | Mesmos payloads em `display_name` via `createPatient`/`listPatients`/export | idem | gravados e lidos **literalmente**; `patients` existe; B intacto | V5.3.4 / A03 |
| 14 | Byte nulo em texto; `userId` (actor_id) malicioso | idem | erro do banco, nada gravado | V5.1.4 / A03 |
| 15 | CSV injection: `=`, `+`, `-`, `@`, TAB, CR, espaço/LF antes de `=`, `＝` fullwidth | `CSV injection na exportação` + `csv.test.ts` | campo prefixado com `'` no `pacientes.csv`; JSON mantém o valor original | V5.3.10 (CWE-1236) / A03 |
| 16 | Requisição sem headers seguros / clickjacking / sniffing | `borda HTTP endurecida` | `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, CSP `default-src 'none'; frame-ancestors 'none'`, HSTS, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, sem `X-Powered-By` | V14.4.1–V14.4.7, V8.2.1 / A05 |
| 17 | CORS de origem desconhecida, `null`, sufixo enganoso, porta diferente (simples e preflight) | idem | sem `Access-Control-Allow-*`; allowlist recebe a origem exata, nunca `*` | V14.5.3 / A05 |
| 18 | Config `CORS_ALLOWED_ORIGINS=*`, `null`, curinga, `http://` não-local, com caminho | `configuração da borda` | API não sobe (erro de configuração) | V14.5.3, V14.1.3 / A05 |
| 19 | Corpo de 200 KB (limite 100 KB) | `borda HTTP endurecida` | `413 {"statusCode":413,"message":"Payload Too Large"}` | V13.1.3, V12.1.1 / A04 |
| 20 | JSON malformado; charset desconhecido | idem | `400`/`415` genéricos, sem mensagem do parser nem stack | V7.4.1 / A05 |
| 21 | Rajada acima do limite por IP | `rate limit global` | `429` com `Retry-After` | V11.1.4, V13.2.6 / A04 |
| 22 | Rota inexistente (`/admin/../../etc/passwd`); exceção interna com caminho/segredo na mensagem | `borda HTTP endurecida` | `404` JSON / `500 Internal server error`, sem stack, caminho ou mensagem interna | V7.4.1 / A05 |
| 23 | Métodos inesperados (PUT/DELETE/PATCH/POST em `/health`), `TRACE` (XST) | idem | `404`; TRACE não ecoa headers | V14.5.1 / A05 |
| 24 | Front sem CSP / embutível em iframe / APIs de dispositivo | `security-headers.test.ts` | CSP `default-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`, sem `'unsafe-eval'` em produção; `Permissions-Policy` nega câmera/microfone/geolocalização/pagamento; origem da API com curinga é recusada | V14.4.3, V14.4.6, V14.4.7 / A05 |
| 25 | Varredura passiva (ZAP baseline) da API real | job `dast` | 0 alertas de risco Alto | V14 / A05 |

## Achados desta rodada (corrigidos)

1. **Troca de tenant no meio da transação (crítico, A01).** As policies liam a GUC
   `app.tenant_id`, alterável por qualquer sessão. Com SQL injetado dentro de `withTenant(A)`,
   `set_config('app.tenant_id', B, true)` ou `SET LOCAL` davam leitura/escrita em B; `SET SESSION`
   numa conexão crua também. **Correção:** migração `0003_contexto_tenant_travado.sql` — o tenant
   da transação é gravado uma única vez em `tenant_context` (chave = `txid_current()`, tabela sem
   nenhum privilégio para `app_user` e com RLS forçado), por `app_set_tenant(uuid)` (SECURITY
   DEFINER, `search_path` fixo); as policies usam `(SELECT app_current_tenant())`. Uma segunda
   chamada com outro tenant na mesma transação é recusada. `withTenant` passou a chamar
   `app_set_tenant`. Limite conhecido: quem executa SQL arbitrário pode abrir uma **nova**
   transação e chamar `app_set_tenant(B)` — essa é a porta legítima; a defesa ali é a
   autenticação/RBAC que decide o `tenantId` (TenantGuard, microparte própria). Custo: cada
   transação com tenant passa a ter xid (uma escrita em tabela UNLOGGED); não serve para réplica
   de leitura (anotar quando houver).
2. **Tabela TEMP sombreando `patients` na conexão do pool (alto, A01/A05).** `TEMPORARY` era
   concedido a `PUBLIC` por padrão; `pg_temp` vem antes de `public` no `search_path`, então
   `CREATE TEMP TABLE patients` capturaria inserts de outros tenants que reutilizassem a conexão.
   **Correção:** `REVOKE TEMPORARY ON DATABASE … FROM PUBLIC` em `infra/local/postgres-init.sh`
   (o mesmo script do CI; em staging/prod, aplicar no provisionamento do RDS).
3. **Mensagem interna do parser na resposta (baixo, A05).** JSON malformado devolvia
   `"Expected double-quoted property name in JSON at position 13"`. **Correção:** handler de erro
   em `applyHttpSecurity` devolve só `400/413/415` genéricos.
4. **CSV injection — variantes (baixo, endurecimento).** `csv.ts` já neutralizava `= + - @ TAB CR`
   no início; passou a neutralizar também após espaços/quebras de linha iniciais e as formas
   fullwidth (`＝ ＋ － ＠`).
5. **Borda HTTP sem endurecimento (médio, A05).** `applyHttpSecurity(app)` (helmet, CORS por
   allowlist, limite de corpo, rate limit, erros genéricos) passou a ser chamado em `main.ts`.

## Pendências conhecidas (não bloqueiam esta entrega)

- **`node dist/main.js` não sobe**: `@plataforma/shared` é publicado como TypeScript-fonte com
  imports `./x.js`, que o Node não resolve. Por isso o DAST sobe a API via `serve:dast` (vitest).
  Corrigir no build/deploy (compilar `shared` ou empacotar a API) em microparte própria.
- Rate limit em memória (por instância). Meta: Redis por IP/usuário/tenant (seguranca-na-arquitetura.md).
  Atrás do ALB, configurar `HTTP_TRUST_PROXY_HOPS=1` para usar o IP real.
- CSP do web usa `script-src 'unsafe-inline'` (scripts inline de hidratação do App Router).
  Próximo passo: CSP com nonce em `proxy.ts`.
- ZAP não roda localmente nesta entrega (Docker no CI). O baseline é passivo; o scan ativo
  (`zap-full-scan`) entra quando houver rotas autenticadas e um ambiente de staging descartável.

## Configuração da borda (variáveis)

| Variável | Padrão | Regra |
|---|---|---|
| `CORS_ALLOWED_ORIGINS` | vazio (nenhuma origem cruzada) | lista separada por vírgula; `esquema://host[:porta]`; `http` só para `localhost`; `*`/`null` recusados |
| `HTTP_BODY_LIMIT` | `100kb` | `N(b|kb|mb)` |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | `300` / `60000` | por IP, janela fixa |
| `HTTP_TRUST_PROXY_HOPS` | `0` | `1` atrás do ALB |
| `NEXT_PUBLIC_API_ORIGIN` (web) | vazio | entra no `connect-src`; curinga recusado |
