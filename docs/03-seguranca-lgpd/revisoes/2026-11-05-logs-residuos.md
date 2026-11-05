# Parecer do guardião LGPD — PR #141 (`eng/logs-residuos`)

**Data:** 05/11/2026 · **Base:** `eng/origem-no-portal` · **Testes:** `npx vitest run src/security test/security/http-attacks.test.ts` → 5 arquivos, 87 testes, todos passaram.

## Veredito: VETADO até corrigir a R1 (uma linha). Depois disso, APROVADO com as ressalvas R2 a R5.

## O que está certo

- **Origem na sessão do portal:** o guard monta uma cópia (`{ ...sessao, origem }`) só em `req.portal`. O mapa de sessões do provedor (`sessoes.set`) não recebe a origem, e ela não entra no `anomaly_alert` (`alertar` não a recebe) nem nas respostas. É o HMAC truncado (16 hex) com o segredo do rate limit, o mesmo pseudônimo de correlação que a equipe já usa. Não vira identificador guardado além do log de segurança.
- **401 do portal:** `SESSAO_INVALIDA` com `motivo: 'portal'` (está em `MOTIVOS`) e `origem`. Não leva token, IP nem rota. O volume tem o mesmo limite do 401 da equipe: o rate limit global por IP roda como middleware antes do guard, então a inundação do log para no 429.
- **Trava:** `describe` só vale em `lifecycle/graceful-shutdown.ts`. `util.inspect`, `Object.*` e `String(obj)` são reprovados, e a cópia direta (`const x = p.nome`) também. Na sonda, `p.cpf.trim()`, `String(o)` e `Object.keys(o)` foram reprovados como deviam.
- **Testes de rate limit:** cada um esgota o próprio limite (máx. 5, até 10 tentativas), então não dependem mais da ordem.

## Ressalvas

1. **(bloqueante) A correção do nome composto não cobre o nome.** `PALAVRAS_SENSIVEIS` não tem `nome`. Pela sonda, `p.nomeDoPaciente` e `nomeCompleto` passam pela trava, e o nome é o dado pessoal mais comum. Também faltam `mensagem`, `message`, `stack`, `body`, `corpo` e `payload`: `p.mensagemDoErro` e `requestBody` passam. Testei com essas palavras na lista: **zero falso positivo no código atual** (5/5 testes da trava passaram). O comentário diz que só `name` e `texto` geram ruído, então a omissão não tem motivo. Corrigir: incluir `nome`, `nomes`, `mensagem`, `message`, `stack`, `body`, `corpo` e `payload`, e pôr `nomeDoPaciente` no teste de sanidade. A `fila.md` e o `logs-de-seguranca.md` só podem dizer "feito" depois disso.
2. **Falsos negativos que continuam (baixo risco, sem ocorrência hoje; registrar na fila):** a cópia só é pega na forma direta. Passam: `` `${p.nome}` ``, `p.nome ?? ''`, `p['cpf']`, cópia transitiva (`const y = x`), atribuição (`x = p.cpf`), apelido do erro (`const falha = err`), `util.format`, getter (`p.getCpf()`) e chamada (`telefone()`). A trava é uma rede de segurança, não uma prova. O formato fechado de `linhaDeSeguranca` continua sendo a garantia real dos eventos de segurança.
3. **Falta teste da parte (1).** Nenhum teste cobre o 401 do `PortalGuard` emitindo `SESSAO_INVALIDA` com `motivo: 'portal'` e a origem em HMAC (e sem token). Nenhum teste confere `origem` nos três `ALERTA_ANOMALIA` da vigilância: o teste da linha ~138 de `emissao-de-eventos.test.ts` confere só a `regra`. Hoje o PR não prova o que diz no item (1). Incluir esses testes antes do merge, junto com a R1.
4. **Provedor real (D4):** `origem` virou campo opcional de `SessaoDoPortal`. Quando o provedor real persistir a sessão (Redis/banco), ela **não** pode ser gravada junto. Documentar isso no tipo ("só por requisição, nunca persistir") e conferir na D4.
5. **Instabilidade que sobra no teste de rate limit:** se a janela fixa de 60 s virar entre o laço e o `expect(429)` seguinte (`/health/../qualquer-rota`), o teste ainda falha. A chance é pequena. A solução de fundo continua sendo o relógio injetado; manter na fila em vez de dar o item por encerrado.

## Conferência rápida

Base legal: sem tratamento novo; é log de segurança, legítimo interesse/segurança (art. 7º IX e art. 46). Minimização: ok, só HMAC. Segredos: fora do código (`loadRateLimitHashKey`). Dados reais: não há nenhum no diff nem nos testes (IPs de documentação, RFC 5737). Isolamento por tenant e retenção: não mudam.

## Nota do Maestro (05/11/2026)

- **R1 (feita):** `nome`, `mensagem`, `message`, `stack`, `body`, `corpo` e `payload` entraram nas palavras dos nomes compostos. `p.nomeDoPaciente` entrou no teste de sanidade, e o código atual continua sem nenhuma acusação.
- **R3 (feita):** há teste de que o 401 do portal gera `SESSAO_INVALIDA` (`motivo: portal`, com a origem em HMAC e sem o IP), de que a origem vai numa **cópia** na requisição e a sessão do provedor não muda, e de que o alerta da vigilância do portal carrega a origem.
- **R2 e R4 (fila):**
  - os furos restantes da trava, sem ocorrência hoje: template, `??`, cópia transitiva, atribuição, `const falha = err`, `util.format` e `getCpf()`;
  - o relógio injetado no rate limit;
  - a `origem` não pode ser gravada na sessão do provedor real (D4).
