# Parecer do Guardião LGPD: exceção de auditoria GHSA-fc5q-39xc-vjpf (picomatch)

## Veredito: **VETADO** (duas correções simples; reaprovo assim que entrarem)

A exceção em si é defensável. Não há versão corrigida, e nenhum código da API alcança o picomatch com padrão vindo de
fora. Mas o registro afirma como **FATO** que o picomatch "vem só do ferramental" e não chega à produção. Isso é
**falso**: ele entra na imagem da API. Um registro de exceção de segurança com fato errado não pode ir para a main.
Além disso, a trava da CI só cobre esta GHSA, e uma próxima exceção poderia entrar sem data.

- **Data:** 2026-11-17
- **Revisado:** `git diff` do worktree `eng/excecao-picomatch` (`package.json`: `pnpm.auditConfig.ignoreGhsas`;
  `.github/workflows/ci.yml`: passo `excecoes-de-auditoria`) e o arquivo novo `docs/03-seguranca-lgpd/excecoes-de-auditoria.md`.
- **Execução:** rodei `pnpm why picomatch -r` e simulei o build da imagem com
  `pnpm --filter @plataforma/api deploy --prod --prefer-offline <scratch>` (o mesmo comando do `apps/api/Dockerfile`).
  Não consultei o GHSA nem o npm: os dados de 17/11 (faixa `<= 4.0.7`, sem correção; 4.0.7 é a mais recente) são do solicitante.

## 1. Alcance: o picomatch entra na imagem de produção

| Item | Situação | Evidência |
|---|---|---|
| picomatch no `deploy --prod` | 🔴 | O `node_modules/.pnpm` gerado contém `picomatch@4.0.7`, `fdir`, `tinyglobby`, `vite@7.3.7`, `@vitest/mocker`, `@vitest/spy`, `playwright`, `playwright-core` e `next` (268 MB no total). |
| Por quê | 🔴 | `better-auth@1.7.12` é dependência de **produção** da API e declara `vitest`, `next` e `react` como *peers* opcionais. O lockfile resolve esses peers (snapshot `better-auth@1.7.12(...)(next@16.4.3...)(vitest@5.0.5...)`), e o `deploy --prod` os leva junto. O `pnpm why` já mostra isso, na seção `dependencies:` da API, não em `devDependencies`. |
| Alguém carrega o picomatch em runtime | ✅ | A API importa só `better-auth/{api,node,adapters/drizzle,plugins/two-factor}`. Dentro do better-auth, o único arquivo que importa vitest/vite é `dist/test-utils/test-instance.mjs`, que a API não importa. No código da API (`apps/api/src`, `apps/api/scripts`, `packages/shared/src`) não há picomatch, minimatch nem glob. |
| Trivy da imagem (`imagem.yml`) | 🟡 | Usa `--ignore-unfixed`, então hoje não acusa este alerta. Quando sair a correção, a imagem passa a falhar até a dependência ser atualizada, o que está correto. |

**Conclusão:** o código vulnerável está **presente** na imagem, mas **não é alcançável**. Nenhum caminho de execução
da API carrega o picomatch. O risco residual é baixo e aceitável por 14 dias. A frase do registro, porém, tem de
dizer isso, e não "só ferramental".

## 2. Entrada de glob do usuário

✅ Nenhuma rota, job ou script recebe padrão glob. Os únicos "patterns" da API são a expressão cron dos jobs
(`agendador-bullmq.ts`), que é fixa no código e vai para o BullMQ, não para o picomatch, e os `RegExp` fixos de
`field-format.ts`. Os padrões do ferramental (vitest, vite, typescript-eslint) vêm da configuração do repositório.
No CI, um PR de fora poderia mudar essa config, mas, nesse caso, ele já executa código arbitrário no runner. O ReDoS
não acrescenta nada a isso.

## 3. Data de revisão e trava

| Item | Situação | Evidência |
|---|---|---|
| Prazo de 01/12/2026 | ✅ | 14 dias, adequado para um alerta alto sem correção e sem alcance. |
| Trava | ✅ | O `run` do Actions usa `bash -e`, então o `return 1` de `vencida` derruba o passo. A comparação de datas ISO com `\>` funciona. O passo falha a partir de 02/12 (UTC), o que bate com "até 01/12". |
| GHSA ignorada sem registro | ✅ | O laço exige que cada GHSA do `package.json` apareça no documento. |
| Toda exceção tem data | 🔴 | A data fica numa linha fixa do `ci.yml`, escrita para esta GHSA. Uma segunda GHSA só precisa ser **citada** no documento para passar, e fica **sem prazo**, o que contraria a regra do próprio documento ("com data de revisão, conferida pela própria CI"). |
| Correção antes do prazo | 🟡 | Se a 4.0.8 sair antes de 01/12, nada força a remoção antecipada. O Dependabot e o Trivy vão apontar a correção, e isso basta, desde que alguém remova a exceção nesse momento. |

## Correções obrigatórias (condição de merge)

1. **Corrigir o FATO do registro** em `excecoes-de-auditoria.md`. Trocar "vem só do ferramental" por algo como:
   "o picomatch 4.0.7 **entra na imagem da API** como dependência transitiva dos *peers* opcionais do `better-auth`
   (vitest/vite), mas nenhum código de runtime o carrega: a API não importa vitest/vite, e o único uso dentro do
   better-auth é `dist/test-utils`. Verificado com `pnpm deploy --prod` em 17/11/2026." A avaliação de risco passa a
   ser "presente, mas não alcançável", e não "não está na produção".
2. **Ligar a trava a cada exceção.** O prazo deve sair do documento, e não de uma linha fixa no `ci.yml`. Por
   exemplo, cada exceção ganha uma linha `Vence: AAAA-MM-DD` no documento. Para cada GHSA do `ignoreGhsas`, a CI
   extrai a data da seção dela e **falha se não houver data** ou se ela já tiver passado.

## Recomendações (não bloqueiam este merge)

- **R1 (média):** tirar da imagem de produção os *peers* de teste do better-auth (vitest, vite, playwright, next,
  ~268 MB de código sem uso em runtime). Isso reduz a superfície de ataque e o ruído de scanner. Opções a avaliar pela
  engenharia: `pnpm.peerDependencyRules`/`packageExtensions` para não resolver esses peers no pacote da API, ou podar
  o `/out/node_modules` no estágio de build. Depois, conferir com `deploy --prod` e com o SBOM do Trivy.
- **R2 (baixa):** registrar no documento quem remove a exceção quando sair a correção: o primeiro PR do Dependabot
  que trouxer a 4.0.8 retira a GHSA do `ignoreGhsas`, no mesmo PR.

## Fora de escopo LGPD

A mudança não toca dado pessoal, base legal, tenant, criptografia nem trilha de auditoria. Não há segredo nem dado
real no diff.

## Reconferência (17/11/2026, commit `75e564e`, PR #209)

### Veredito: **APROVADO**, e o veto acima fica levantado

| Correção | Situação | Evidência |
|---|---|---|
| 1. FATO do registro | ✅ | `excecoes-de-auditoria.md` agora diz "presente na imagem de produção da API, mas não é alcançável". Cita a origem nos *peers* opcionais do `better-auth` e no `pnpm deploy --prod` do Dockerfile, e ajusta a avaliação de risco. |
| 2. Trava por exceção | ✅ | O `ci.yml` não tem mais data fixa. Para cada GHSA do `package.json`, o passo lê a linha `<!-- vence: <GHSA> <AAAA-MM-DD> -->` do documento e falha se ela faltar ou se a data tiver passado. Rodei o mesmo script localmente: data presente = passa; hoje = 01/12 = passa; hoje = 02/12 = falha ("venceu"); linha removida = falha ("sem data"). A linha de exemplo da seção "Formato" usa `<GHSA>` literal e não casa com a regex, então não gera um falso registro. |
| R2. Quem remove | ✅ | O Maestro, no primeiro ciclo depois da publicação da correção. |
| R1. Os 268 MB na imagem | 🟡 | Registrada como pendência no documento, mas sem dono e sem prazo. Continua recomendação, não bloqueia. |

**Observação (não bloqueia):** a trava não limita o prazo máximo. Uma data como `2099-12-31` passaria. A defesa é que
toda mudança no documento de exceções precisa de parecer do Guardião, que confere se o prazo é razoável (até 30 dias
para alerta alto sem correção).
