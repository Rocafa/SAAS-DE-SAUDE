# Parecer do guardião LGPD: PR #129, log de segurança (código)

> Data: 04/11/2026. Branch: `eng/log-de-seguranca`. Escopo: `git diff main...eng/log-de-seguranca -- apps .github` e o guia `docs/03-seguranca-lgpd/logs-de-seguranca.md`.
> Evidência: `vitest` nos 2 arquivos novos (18 testes passam), `tsc --noEmit` limpo. Sonda descartável (não commitada) contra a trava e contra `linhaDeSeguranca`. Sem Postgres local; RLS não rodado.

## Veredito: **APROVADO COM RESSALVAS**

Nenhum caminho de hoje vaza dado pessoal: todo chamador passa literal, código de enum (`recusaDeMfa`, `motivoDaFalha`), UUID, HMAC ou o template da rota vindo do Express (`req.route.path`). `a.transicao` e `String(metadata.rule)` vêm de metadados gravados pelo sistema e passam pela validação. `JSON.stringify` com campos validados impede injeção de linha no log. O 401 por requisição é limitado pelo rate limit global por IP (`app.use(rateLimiter…)` roda antes do guard), e a linha tem tamanho fixo e nenhum efeito para fora: não amplifica.

Mas a validação de formato e a trava estática prometem mais do que entregam. R1 a R4 têm de ser resolvidas **antes do merge** (correções pequenas). R5 a R9 podem ir para issue com dono.

## Ressalvas

**Antes do merge**

1. **O formato não barra nome nem CPF.** Prova da sonda: `motivo: 'maria_silva'` e `handler: 'Maria.Silva'` passam, e `rota: 'GET /pacientes/12345678909/joao.souza'` passa inteira. Então o guia (§2, item 2) e o cabeçalho de `log-de-seguranca.ts` erram ao dizer que nome e CPF "não conseguem entrar". Correção:
   - (a) `motivo` e `regra` viram listas fechadas: união de literais no tipo, `Set` no runtime, e o resto vira `[invalido]`. Hoje os valores usados são uns 15 e já conhecidos.
   - (b) `ROTA` recusa segmento que não seja literal ou `:param`: nenhum segmento só com dígitos (≥ 3) e nenhum com `@` ou `.` fora de `:param`. Ou montar a rota a partir de `PATH_METADATA` do Nest em vez de `req`.
   - (c) `HANDLER` tem de bater com o nome de uma classe e um método reais (lista fechada ou sufixo `Controller.`).
   - (d) Testes negativos para os 3 casos acima.
2. **Furos na trava `logs-sem-dado-pessoal.test.ts`.** Prova da sonda: os 9 casos abaixo **passam sem violação**:
   - alias `const log = this.logger; log.warn(p.nome)`;
   - `this.logger[metodo](p.nome)`;
   - `logger.warn({ ...p })`;
   - `logger.warn(JSON.stringify(p))`;
   - `logger.error(String(err))`;
   - `logger.error('x' + err)`;
   - `` `${p['cpf']}` ``;
   - `const { nome: n } = p; logger.warn(n)`;
   - `process.stderr.write(p.nome)`.

   Hoje nenhum desses padrões existe no `src`, mas a trava existe justamente para o próximo PR. Correção mínima:
   - (a) reprovar `ElementAccessExpression` no receptor ou no argumento de log, e literal de string sensível em `['…']`;
   - (b) o identificador de erro (`ERRO`) é reprovado em **qualquer** posição do argumento, não só no topo ou no template;
   - (c) reprovar `JSON.stringify(...)`, spread e objeto literal em argumento de log (ou exigir string/template);
   - (d) reprovar `process.stdout/stderr.write` como o `console`;
   - (e) receptor de log reconhecido pelo tipo (`Logger` via `TypeChecker`) ou, no mínimo, reprovar `= this.logger` / `= logger` em variável;
   - (f) incluir os 9 casos no teste de sanidade.
3. **Inundação no fail-open.** `RATE_LIMIT_FAIL_OPEN` (http-security, vigilância de leitura, portal) grava uma linha `error` com alarme "imediato" **por requisição** enquanto o Redis estiver fora. Isso duplica o `rateLimitLogger.error` que já existia e dispara uma tempestade de alarmes. Correção: registrar só na transição (1ª falha e depois no máximo 1 por minuto, com `contagem` acumulada). O `failOpenCount` já existe.
4. **O guia trata o log como "sem dado pessoal", e ele tem dado pessoal pseudonimizado.** `userId` e `origem` (HMAC do IP) são dado pessoal **pseudonimizado** (LGPD art. 13 §4 e art. 12: quem tem a chave reidentifica, e o IPv4 cabe em 2³² tentativas se a chave vazar). Correção no guia:
   - chamar de "dado pessoal pseudonimizado, mínimo";
   - base legal: art. 7º II/IX e art. 46, segurança;
   - entrada no ROPA;
   - 180 dias de retenção com KMS e acesso restrito, como já escrito;
   - `RATE_LIMIT_HASH_KEY` só no Secrets Manager.

**Pode ir para issue (com dono)**

5. **Marco Civil art. 15:** o HMAC é adequado para o log de segurança (minimização), mas **não cumpre** a guarda de IP, data e hora por 6 meses. A pendência do guia (access logs do ALB, cifrados, acesso restrito, 6 meses ou mais) é **bloqueante para produção**, não para este merge. Atenção: o HMAC usa a mesma chave do rate limit (separada pelo prefixo `log:`, ok), então rodar a chave quebra a correlação histórica. Documentar.
6. **`MFA_RECUSADO` e `SESSAO_INVALIDA` sem amostragem:** um usuário autenticado gera um `MFA_RECUSADO` por requisição mesmo acima do teto (o log vem antes de `registrarRecusa`). Limite: 1 por usuário/handler por janela. O custo de ingestão no CloudWatch com IPs distribuídos é limitado só pelo rate limit por IP: medir no piloto.
7. **`PORTAL_RESGATE_RECUSADO` e `WEBHOOK_ASSINATURA_INVALIDA` sem `origem`:** o alarme de volume não consegue agrupar por origem. Incluir `origem: origemDaRequisicao(req.ip)`.
8. **Teste de `RATE_LIMIT_EXCEDIDO` e dos chamadores dos módulos:** os testes cobrem o formatador e o guard, mas não provam que o rate limiter loga só no `max + 1` nem que os serviços (export, portal, vigilância) emitem o evento certo. Basta um teste por chamador com `vi.spyOn(Logger.prototype, …)`.
9. **`loadRateLimitHashKey()` a cada evento:** lê o env e aloca um buffer por linha, e em produção sem a chave lança exceção **dentro do guard** (o 401 viraria 500). Resolver a chave uma vez, no boot (já é validada lá), e injetar.

## Checklist mínimo

| Item | Situação |
|---|---|
| Base legal | Art. 7º II/IX e art. 46 (segurança). Falta registrar no guia e no ROPA (R4) |
| Minimização | Boa no desenho. Furos de formato (R1) |
| Criptografia | Trânsito: n/a. Repouso: grupo de logs com KMS (pendente da conta AWS) |
| Isolamento por tenant | `tenantId` só para correlação. O log é da operadora, não da clínica: ok |
| Controle de acesso | Papel de operação restrito (pendente da AWS) |
| Auditoria | Não substitui `audit_log`, e `TRILHA_NAO_GRAVADA` cobre a falha da trilha: ok |
| Retenção | 180 dias (log). Prontuário (20 anos): n/a |
| Segredos fora do código | Ok (`RATE_LIMIT_HASH_KEY` via env) |
| Dado real fora do git e dos testes | Ok: os testes usam dados fictícios (`exemplo.com`, CPF de teste, IPs de documentação) |
| CFM/ANS/ICP-Brasil | Não se aplica a este PR |

## Nota do Maestro (04/11/2026)

- **R1 (feita):** `motivo` e `regra` agora são listas fechadas, e um teste confere todo literal usado no `src`. A rota só aceita segmentos fixos, sem dígito ou ponto, ou `:param`, e o `handler` só aceita `XController.metodo`. Os três casos que você provou (`maria_silva`, `Maria.Silva` e a rota com CPF) viraram teste e são recusados. O guia também foi corrigido.
- **R2 (feita):** a trava pega os 9 furos (apelido, `logger[metodo]`, spread, `JSON.stringify`, `String(err)`, concatenação, `p['cpf']`, desestruturação renomeada e `process.stderr.write`), com um teste de sanidade para cada um. Só `codigoDoErro` e `describe` ficam liberados como sanitizadores, e os dois foram conferidos à mão.
- **R3 (feita):** `RATE_LIMIT_FAIL_OPEN` sai no máximo uma vez por minuto por contador.
- **R6 (feita):** `MFA_RECUSADO` sai no máximo uma vez por minuto por usuário, rota e motivo.
- **R9 (feita):** o segredo do HMAC é lido uma vez. Sem ele, `origem` some da linha em vez de virar 500.
- **R4 (feita):** o guia diz que `userId` e `origem` são dado pseudonimizado e registra as bases legais e o ROPA.
- **R5, R7 e R8 (fila):**
  - IP em claro por 6 meses nos logs do ALB: bloqueia produção e depende da AWS e da D8;
  - `origem` no portal e no webhook;
  - testes de emissão do rate limit e dos módulos.
