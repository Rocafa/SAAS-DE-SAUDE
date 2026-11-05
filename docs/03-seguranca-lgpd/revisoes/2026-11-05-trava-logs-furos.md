# Parecer do Guardião LGPD: trava de logs, furos restantes e relógio injetado (PR #154)

> Data: 05/11/2026. Branch: `eng/trava-logs-furos` (até `27c7a2e`), base `main`. Fecha a R2 e a R4 de `2026-11-05-logs-residuos.md` (parecer do #141). Revisão do diff `origin/main...origin/eng/trava-logs-furos`. Os testes rodaram aqui: `npx vitest run src/security/logs-sem-dado-pessoal.test.ts src/security/rate-limit-store.test.ts` deu 23/23. Também rodei uma sonda descartável com casos fictícios (removida, nada foi commitado) para procurar furos abertos pela mudança de escopo.

## Veredito: **APROVADO COM RESSALVAS.** A R1 e a R2 são curtas e entram antes do merge. O resto vai para a fila.

Os sete furos da R2 estão fechados, com teste de sanidade linha a linha:
- template;
- `??` e `||`;
- cópia transitiva, com ponto fixo;
- atribuição a variável já declarada;
- apelido do erro (`const falha = err`);
- `util.format`;
- getter com nome sensível (`getCpf()`).

As marcas agora valem por escopo de função, o que corrige o falso positivo de `tipos` em funções diferentes. A busca sobe pela cadeia de funções, então uma closure que usa uma variável marcada fora dela continua reprovada (conferi na sonda). Nenhuma ocorrência real dos furos abaixo no `src` atual: a trava inteira passa, e procurei os padrões à mão.

A R4 está atendida no store: `MemoryRateLimitStore` aceita `agora` injetado, com teste exato na virada da janela.

## Furos encontrados (sonda com código fictício)

| Caso | Resultado | Origem |
|---|---|---|
| `let ultimo = ''; ps.forEach((p) => { ultimo = p.nome; }); logger.warn(ultimo)` | **passa** | **Aberto pela mudança de escopo**: a atribuição marca o escopo da *callback*, e o log está na função de fora |
| `const erro = codigoDoErro(e)` num método e `catch (erro) { logger.error(\`${erro}\`) }` em outro | **passa** | Antigo, mas agora destoa: `seguras` (liberações) continua **global por nome**, e as marcas viraram por escopo |
| `catch (problema) { logger.error(\`${problema}\`) }` e `.catch((motivo) => logger.error(...))` | passa | Antigo: só os nomes da regex `ERRO` contam como erro |
| `o.doc = p.cpf; logger.warn(\`${o.doc}\`)` | passa | Antigo: atribuição a propriedade |
| `for (const d of ps.map((p) => p.cpf)) logger.warn(d)` | passa | Antigo: `for…of` sem inicializador |
| `this.g(p.cpf)` com `g(v) { logger.warn(v) }` | passa | Limitação conhecida: a trava não segue o valor de uma função para outra |
| `const d = p.cpf; const h = () => logger.warn(d)` | reprovado ✅ | A closure continua coberta |

## Ressalvas

### Antes do merge (neste PR)

1. **A atribuição tem de marcar o escopo da DECLARAÇÃO.** `marcar` usa "a função mais próxima que já marcou o nome, senão a atual". Quando a variável nasce segura fora (`let x = ''`) e é atribuída dentro de uma callback (`forEach`, `map`, `then`), a marca fica presa na callback. O log de fora não a vê. Com as marcas globais de antes, esse caso seria pego, então o furo foi aberto pela mudança.
   - **Correção:** achar a declaração subindo pelos escopos até a função que declara o nome (`VariableDeclaration`, parâmetro ou `catch`) e marcar ali. Se a declaração não for achada, marcar como módulo (`-1`), o que é conservador. A alternativa robusta é usar o `TypeChecker` (`getSymbolAtLocation`) e marcar pelo símbolo, sem depender de nome e posição.
   - **Teste:** pôr o caso da tabela no teste de sanidade.
2. **`seguras` também por escopo.** Hoje uma variável `erro = codigoDoErro(e)` em qualquer método libera **todo** identificador `erro` do arquivo, inclusive um `catch (erro)` cru em outro método, que é o nome mais comum nos dois casos. Usar a mesma chave `<escopo>:<nome>` das marcas. Pôr no teste de sanidade o caso da tabela.

### Fila

3. **Variável do `catch` e parâmetro do `.catch(...)` sempre como erro**, qualquer que seja o nome (`catch (agendar)` já existe no `kms-key-provider.ts`, hoje sem log). A marca é barata: colocar a variável do `CatchClause` em `apelidosDoErro`, e também o primeiro parâmetro de uma função passada a `.catch` ou como segundo argumento de `.then`.
4. **Ponto fixo silencioso.** O laço para em 10 passadas sem avisar. Se não convergir, lançar erro (é um teste) em vez de seguir com marcas incompletas.
5. **Limitações que continuam (registrar no cabeçalho da trava):** atribuição a propriedade (`o.doc = p.cpf`, `this.x = …`), `for…of` sobre valores sensíveis e passagem de valor entre funções. A trava continua sendo uma rede de segurança e não uma prova. A garantia real dos eventos de segurança é o formato fechado de `linhaDeSeguranca`.
6. **R4, parte que falta.** O relógio injetável existe, mas os testes instáveis que motivaram a R4 continuam no relógio real: a virada da janela no teste do rate limit por rota (R5 do #141) e o R9 do `mfa.rls.test.ts`. Para dizer "100% determinístico" na fila, esses testes precisam receber um store com relógio injetado. Também: o #152 acrescenta `peek` e `release` ao `MemoryRateLimitStore` com `Date.now()`. No merge dos dois, os três métodos precisam usar `this.agora`.
7. **Falso positivo esperado.** `format` sozinho em `DESPEJOS` pega também `format(data, 'dd/MM')` (date-fns) dentro de um log. Isso é aceitável, porque a regra é fechada, mas convém citar no comentário.

## Conferência rápida

| Item | Situação |
|---|---|
| Base legal, minimização | Não há tratamento novo. A trava reforça o art. 6º III e o art. 46 (log sem dado pessoal). ✅ |
| Dados reais e segredos | Só código e nomes fictícios no teste de sanidade. ✅ |
| Isolamento, retenção, criptografia | Não mudam. ✅ |
| CFM, ANS e ICP-Brasil | Não se aplicam. ✅ |

## Nota do Maestro (05/11/2026)

- **R1 corrigida.** As marcas vão para o escopo onde a variável foi **declarada**: há uma lista de declarações por função (variável, parâmetro, elemento desestruturado). A atribuição dentro de uma callback marca a variável da função de fora. Tem teste.
- **R2 corrigida.** As liberações (`seguras`) usam a mesma chave por escopo. Tem teste: `codigoDoErro` em um método não libera o `catch (erro)` de outro.
- **R3 feita.** A variável de qualquer `catch` e o parâmetro de `.catch(...)` contam como o erro inteiro, com qualquer nome. Tem teste, e o código atual continua sem acusação.
- **R4 feita.** Se o laço não convergir em 50 passadas, a trava lança um erro em vez de passar calada.
- **R5 e R7 feitas.** O cabeçalho da trava registra o que ela não cobre e o caso do `format` do date-fns.
- **R6 vai para a fila:**
  - relógio injetado nos testes de rate limit por rota e na R9 do `mfa.rls.test.ts`;
  - `peek`/`release` do #152 com `this.agora` quando os dois PRs se encontrarem.

## Reconferência do Guardião (05/11/2026, commit `791a61f`)

Rodei a versão do `791a61f` da trava: 14/14, inclusive a varredura de todo o `src`. Rodei também uma sonda descartável, já removida.

### Veredito final: **APROVADO.**

- **R1:** resolvida. A chave é o escopo da declaração (variável, parâmetro, elemento desestruturado ou variável do `catch`). A atribuição dentro de uma callback marca a variável da função de fora. Um parâmetro que sombreia a variável externa não herda a marca (conferido: sem falso positivo).
- **R2:** resolvida. As liberações usam a mesma chave por escopo.
- **R3:** feita para o `catch` e o `.catch(...)`. Falta o segundo argumento de `.then(ok, falhou)`, que a sonda confirma passar. Fica na fila, sem ocorrência hoje.
- **R4, R5 e R7:** feitas. A trava lança erro se não convergir em 50 passadas, e o cabeçalho lista o que ela não cobre.
- **R6:** na fila.

**Resíduo para a fila:** no **mesmo** método, `const erro = codigoDoErro(e)` e um `catch (erro)` cru compartilham a chave. A liberação vence, e o `${erro}` do `catch` passa. É raro e não ocorre hoje. A correção é dar precedência à marca de erro sobre a liberação quando as duas existirem na mesma chave, ou tratar o `catch` como um escopo próprio.
