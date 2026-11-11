# Parecer do Guardião: código da separação por uso da `RATE_LIMIT_HASH_KEY` (B9)

> 11/11/2026 · Guardião LGPD & Segurança · revisão de **código**, PR #179, branch `eng/hmac-por-uso` (base `eng/better-auth-espelho-convite`, #178), commit `9598e78`.
> Referência: [`2026-11-11-desenho-derivacao-hmac.md`](2026-11-11-desenho-derivacao-hmac.md) (R1 a R7).
> Conferido localmente: `vitest` de `src/security`, `src/modules/auth` e do cursor (124 passando, 6 pulados, que são Redis e RLS e rodam só no CI), `tsc --noEmit` sem erro. O vetor conhecido foi recalculado à parte com `hkdfSync` e bate.

## Veredito: **VETADO** (três pendências pequenas, sem defeito de comportamento em produção)

A derivação está certa e todos os usos foram migrados. O veto existe porque dois testes que o R5 colocou como condição faltam, e porque o parâmetro opcional `chaveDoUserAgent` deixa a separação ser desfeita sem aviso. Corrigidos os itens V1 a V3, o PR está aprovado sem nova rodada de desenho.

## Conferência

| Ponto | Resultado |
|---|---|
| HKDF-SHA256, `salt = "plataforma-saude/hmac"`, `info = "<uso>/v<n>"`, 32 bytes (R2) | ok (`rate-limit-store.ts`, `chaveDeHmac`) |
| Lista fechada com os cinco rótulos e as versões numa constante (`VERSOES_DE_HMAC`) | ok |
| (a) rate limit por IP → `rate-limit` | ok (`http-security.ts:36/119`; `main.ts` passa `undefined` e cai no padrão) |
| (b) vigilância de leitura e do portal → `rate-limit` | ok (`app.module.ts:85` → `VIGILANCIA_OPCOES`, que o `PortalVigilanciaService` também usa) |
| (c) `origemDaRequisicao` → `origem` (log, `sessao.ip_address` via `x-plataforma-origem`, contadores `login-origem`/`fator-origem`) | ok (`log-de-seguranca.ts:175`) |
| (d) bloqueio 5/15 e reuso do TOTP → `bloqueio` | ok (`boot.ts:32`, chega a `protecao.ts` e a `provedor.ts`) |
| (e) user-agent da sessão → `sessao-ua` | ok no `boot.ts:33/46`; ver V3 |
| (f) e-mail do convite → `convite-email` | ok (`convites.ts:72`; criação e aceite usam o mesmo padrão) |
| Nenhum uso com a raiz | ok. `loadRateLimitHashKey` só aparece em `rate-limit-store.ts`. `cursor-de-paginacao.ts` lê `env.RATE_LIMIT_HASH_KEY` só para a regra C1, o que é correto |
| `rl:v3` e prefixo `ip\u001f` (R6) | ok (`rate-limit-store.ts:109`, `http-security.ts:128`, teste do Redis atualizado) |
| C1 do cursor compara com a **raiz** | ok. O código não mudou e os testes de `cursor-de-paginacao.test.ts:199-217` continuam passando |
| Produção sem raiz ou com < 32 bytes falha | ok (teste novo de `chaveDeHmac` e o `boot-producao.test.ts` existente) |
| Chave derivada fora de log e de erro | ok (as mensagens citam só o nome da variável) |
| Documentação (R3, R7) | ok: runbook com rotação por uso e em bloco, a ressalva sobre vazamento da raiz e do processo, e o horário no registro de incidentes; `logs-de-seguranca.md` e checklist atualizados |

## Pendências que bloqueiam

- **V1 — Teste de `origemDaRequisicao` sem segredo devolvendo `undefined` (R5, R9 do #129).** O único teste (`log-de-seguranca.test.ts:194`) cobre o caminho de desenvolvimento, que usa o segredo aleatório do processo. Falta o caso de produção: com `NODE_ENV=production`, sem `RATE_LIMIT_HASH_KEY` e sem segredo explícito, a função tem de devolver `undefined` e não lançar. Agora o caminho passa pelo HKDF, e o teste tem de provar que o `try/catch` continua pegando o erro. Como `segredoDaOrigem` fica em cache no módulo, use `vi.resetModules()` com `vi.stubEnv` e um `import()` dinâmico.
- **V2 — Teste de que um rótulo fora da lista não compila (R5).** Acrescente ao `rate-limit-store.test.ts` uma linha com `// @ts-expect-error` chamando `chaveDeHmac('sessao')` (o rótulo antigo) ou `chaveDeHmac('outro')`. Ela só vale se o `tsc` rodar sobre os testes no CI. Se não rodar, use `expectTypeOf`.
- **V3 — `chaveDoUserAgent` obrigatória.** Em `instancia.ts:48/165`, `chaveDoUserAgent?` com `?? o.chaveHmac` faz o user-agent cair na chave `bloqueio` sem aviso, se algum chamador esquecer o campo. Isso desfaz a separação que este PR existe para garantir. Torne o campo obrigatório e retire o fallback. As duas chamadas da bancada (`contrato-provedor-better-auth.rls.test.ts:56` e `:281`) passam `randomBytes(32)`.

## Recomendações (não bloqueiam)

- **N1 — Fixar o prefixo `ip\u001f` em teste.** No teste do `rateLimiter`, compare a chave vista com `rateLimitKey('ip\u001f198.51.100.1', k)`. Hoje só o formato é conferido, e retirar o prefixo passaria sem falha.
- **N2 — Ampliar a trava do R4.** Além de `loadRateLimitHashKey`, o teste deve recusar `RATE_LIMIT_HASH_KEY` em arquivos de `src` fora de uma lista permitida (`rate-limit-store.ts` e `cursor-de-paginacao.ts`, por causa da C1). Assim ninguém faz `createHmac(Buffer.from(env.RATE_LIMIT_HASH_KEY))` por fora.
- **N3 — Comentários desatualizados:** `protecao.ts:48` ("Mesmo segredo do HMAC de origem"), `instancia.ts:46` ("Segredo do HMAC de origem e user-agent"), `log-de-seguranca.ts:167` ("mesmo segredo do rate limit") e a abertura da seção do runbook ("A mesma chave assina três coisas").
- **N4 — Convites fictícios do staging.** Na nota "No deploy do B9" do runbook, diga que os convites pendentes deixam de ser aceitos (o `email_hmac` muda) e precisam ser reemitidos. É o que o desenho previu na Q2.

## Checagens LGPD

- **Base legal e finalidade:** não mudam (segurança e prevenção à fraude: art. 7º, IX, e art. 11, II, "g"). Nenhum dado novo é coletado.
- **Minimização:** melhora. O IP ganha prefixo de domínio e as finalidades deixam de dividir a mesma chave.
- **Criptografia:** HKDF-SHA256 e HMAC-SHA256 do `node:crypto`. A raiz continua no Secrets Manager, e a derivação fica em memória.
- **Retenção:** não muda (Redis por minutos, sessão por 12 h, log por 180 dias, convite por 30 dias depois do estado final).
- **Isolamento por tenant, controle de acesso e auditoria:** não são afetados.
- **Segredos e dados reais no git:** nenhum. O vetor de teste usa `'a'.repeat(32)`, que é fictício.
- **CFM, ANS e ICP-Brasil:** não se aplicam.

## Nota do Maestro (11/11/2026)

- **V1:** teste novo em `log-de-seguranca.test.ts`. Ele usa `vi.resetModules()`, `vi.stubEnv` (produção, sem raiz) e um `import()` dinâmico, e confirma que `origemDaRequisicao` devolve `undefined` sem lançar.
- **V2:** o teste usa `// @ts-expect-error` com um rótulo fora da lista. Além disso, `chaveDeHmac` passou a recusar em tempo de execução um uso fora de `VERSOES_DE_HMAC`.
- **V3:** `chaveDoUserAgent` ficou obrigatória, sem a volta para a chave do bloqueio. As duas chamadas da bancada usam `randomBytes(32)`.
- **N1:** o teste do rate limit confere o prefixo `ip`.
- **N2:** a trava também recusa `RATE_LIMIT_HASH_KEY` em `src`, fora do store e do cursor.
- **N3:** comentários de `protecao.ts`, `instancia.ts`, `log-de-seguranca.ts` e a abertura da seção do runbook corrigidos.
- **N4:** a nota de deploy do runbook avisa que os convites fictícios pendentes no staging precisam ser reemitidos.
