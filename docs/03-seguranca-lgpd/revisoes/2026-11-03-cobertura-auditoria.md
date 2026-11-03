# Parecer do Guardião LGPD: PR #117 (`eng/cobertura-auditoria`)

- **Data:** 03/11/2026
- **Escopo:** `git diff main...eng/cobertura-auditoria` (commit `2e1989d`, 4 arquivos): `apps/api/test/cobertura-auditoria/{analise.ts,lista.ts,cobertura-auditoria.test.ts}` e `docs/04-arquitetura/auditoria-encadeada.md` §4d. Fecha a issue #105 (item **S6** do checklist do piloto). Desenho conforme o comentário de @Lopesloro na issue (teste que exige declaração, no lugar do interceptor global) e o aval de @Rocafa.
- **Testes:** rodei `npx vitest run test/cobertura-auditoria` (6/6, ~7 s, sem banco). Rodei também, fora do repositório, uma variante da análise que lista, para cada rota, **quais funções** gravam a trilha no caminho alcançado (incluindo as rotas `GET`). CI do PR: "Lint, typecheck e testes" verde (é o job que roda `vitest run` com `vitest.config.mts`).

## Veredito: **APROVADO COM RESSALVAS**

Não muda código de produção e só **acrescenta** uma trava de CI; não há exposição nova de dado. A classificação atual está correta: conferi as 97 rotas de `AUDITADAS` e **todas** alcançam a trilha por um gravador do próprio domínio da ação (não só por um gravador incidental), e as 2 exceções são legítimas. O problema é de **robustez da trava para o futuro**: nos módulos mais sensíveis (prontuário e portal) a prova é hoje vazia para rota nova (R1). **R1 a R3 são condição para o merge** (são baratas e ficam neste PR). R4 pode vir neste PR ou no próximo. R5 e R6 vão para a fila; R6 é **condição para a D4** (Better Auth).

## Conferência

| Item | Situação |
|---|---|
| Base legal | Trilha de auditoria = medida de segurança e prestação de contas (LGPD art. 6º X, 37, 46; Res. CFM 1.821/2007, rastreabilidade do acesso ao prontuário). O PR reforça, não trata dado novo. ✅ |
| Minimização | Nenhum dado pessoal no diff; a lista contém só rotas e motivos. ✅ |
| Criptografia | Não se aplica (sem dado novo). ✅ |
| Isolamento por tenant | Não muda; a trilha continua na transação de quem age (`recordAudit(tx, ...)`), com o contexto da clínica. ✅ |
| Controle de acesso | Não muda. ✅ |
| Auditoria | É o objeto do PR. Declaração obrigatória + prova por alcance. Ressalvas R1–R6. ⚠️ |
| Retenção | Não muda (trilha append-only, acompanha o prontuário). ✅ |
| Segredos e dados reais | Nenhum no diff. ✅ |
| CI | `vitest.config.mts` inclui `test/**/*.test.ts` e exclui só `*.rls.test.ts` e `*.security.test.ts`; `ci.yml` roda `pnpm turbo run lint typecheck test` → `vitest run`. O teste roda no CI e não depende de Postgres. ✅ |
| CFM/ANS/ICP-Brasil | Não toca assinatura nem TISS. ✅ |

## Respostas às perguntas

### 1. Falso positivo ("audita" quando não audita)

A busca (`analise.ts:105`, `alcanca`) percorre **todo** o corpo do handler e de cada função alcançada, sem olhar fluxo de controle. Portanto conta como "audita":

- **ramo de erro:** `comNegacaoAuditada` (`src/modules/records/acesso-clinico.ts:50`) grava **só no `catch`** (negação de acesso clínico). Toda rota do prontuário passa por ela, então **qualquer rota nova do prontuário "alcança a trilha" mesmo sem gravar a ação em si**. Hoje as 7 rotas do prontuário que a usam também chegam a um gravador do serviço (`ProntuarioService.abrir/salvar/finalizar/adendo`, `NotasPrivadasService.*`) — conferido —, mas a trava não exigiria isso de uma rota nova;
- **gravadores de anomalia (transação própria):** `VigilanciaDeLeituraService.alertar` (`src/modules/patients/vigilancia-de-leitura.ts:143`) e `PortalVigilanciaService.alertar` (`src/modules/portal/portal-vigilancia.ts:127`) gravam só ao estourar limite. Toda rota do portal com vínculo passa pela vigilância; `POST /pacientes/busca`, `POST /financeiro/recibos/:id/via-oficial` e `POST /financeiro/receita-saude/lotes` também. Mesmo efeito: rota nova do **portal** passaria sem gravar a ação;
- **código morto / callback nunca chamado / código depois de `return`:** contado como caminho. Risco baixo (exigiria código escrito para enganar), aceitável;
- **resolução de chamada:** usa `getResolvedSignature` → declaração. Sobrecarga, interface (DI por token) e `abstract` resolvem para declaração **sem corpo**, o que dá falso **negativo** (rota fica vermelha), nunca falso positivo. O fallback `declarations[0]` também só pode errar para negativo na prática. Aceitável.

**O limite documentado ("prova que existe caminho, não que todo ramo grava") é aceitável para o S6** — o objetivo do S6 é "rota nova não entra sem trilha", não verificação formal de cada ramo, e os testes RLS de cada módulo conferem a linha nos casos principais. **Mas não é aceitável que o caminho contado seja o de um gravador incidental** (negação, anomalia): aí a trava fica vazia justamente onde o dado é mais sensível. Ver R1.

### 2. As 2 exceções

- **`POST /portal/convites/resgate/confirmar` → `app_portal_redeem_invite`:** legítima. A última definição é a de `db/migrations/0033_portal_veto_v2_e_ressalvas.sql:394-451` (só 0027 e 0033 a definem). Ela grava `INSERT INTO public.audit_log (... 'paciente_portal', 'create', 'portal_links', ...)` **na mesma transação** que cria o vínculo e marca o convite como resgatado; o metadata é só de ids (`invite_id`, `link_id`, `patient_id`, `acting_as`, `guardian_id`, `otp`). A API não tem contexto de clínica antes da função, então gravar pela função é o desenho certo. Observação: a tentativa com código errado só incrementa `attempts`, sem linha na trilha; está coberta pela vigilância do resgate e pelo teto de 5 tentativas — não é objeto deste PR. Fragilidade do teste: ver R4.
- **`POST /whatsapp/modelos` (`WhatsappController.criarModelo`):** legítima hoje — o corpo é só `throw new ConflitoError('modelo_da_clinica_desligado')` (`src/modules/messaging/whatsapp.controller.ts:38-42`) e nem lê o corpo da requisição. Fragilidade: se alguém implementar a rota **gravando sem auditar**, ela continua em `EXCECOES` em silêncio (o teste só pega a exceção que *passou a auditar*). Ver R2.

### 3. Rotas que o analisador não enxerga

- **Caminho não literal** (`@Controller({ path })`, `@Post(['a','b'])`, constante): o analisador **falha alto** (`argumentoTexto` lança). ✅
- **`@All`, `@Options`, `@Head`, `@Search`:** ignorados em silêncio (`METODOS_DE_ESCRITA`, `analise.ts:17`). Hoje não há nenhum no código (conferido). Ver R3.
- **Decorator renomeado ou composto** (`import { Post as P }`, `applyDecorators(Post(...))`, `@RequestMapping`): `nomeDoDecorator` (`analise.ts:54`) compara o texto do identificador; não seriam vistos. Hoje não há nenhum (conferido). Ver R3.
- **Rotas fora de controller Nest** (`app.use`, `getHttpAdapter().post`, handler de biblioteca): hoje só há middlewares de segurança em `src/security/http-security.ts` (rate limit, no-store, erro), que não gravam dado pessoal. **A D4 (Better Auth) vai montar o handler de login/cadastro/sessão fora de controller**, e ele grava usuário, sessão e evento de login. Ver R6.
- **Portal com sessão própria:** enxergado — os controllers do portal são `@Controller` normais e todas as 10 rotas de escrita estão declaradas. ✅
- **`GET` que grava/altera:** não encontrei `GET` que mude dado de domínio (só contadores de rate limit/vigilância, que não são dado pessoal).
- **`GET` que lê dado sensível:** hoje 50 das 63 rotas `GET` alcançam a trilha; as 13 que não alcançam são health/readiness, sessão atual, membros, vínculo de cuidado (config), política de retenção fiscal, profissionais, tipos de atendimento, termo de importação, config/modelos do WhatsApp, verificação do webhook e avisos — nenhuma devolve prontuário, ficha de paciente ou dado financeiro de paciente. Portanto **não há lacuna atual**, mas também não há trava: uma rota `GET /pacientes/:id/algo` nova sem auditoria de leitura passaria. Vira **item de fila** (R5), não ressalva bloqueante: o S6 é sobre escrita, e a auditoria de leitura do prontuário/ficha já é conferida pelos testes RLS de cada módulo.

### 4. CI

Roda (ver tabela). O `beforeAll` tem 120 s de limite; localmente leva ~7 s.

## Ressalvas

**R1 (condição para o merge) — gravador incidental não pode contar como "auditada".**
`apps/api/test/cobertura-auditoria/analise.ts:105-133`. Hoje `comNegacaoAuditada` (grava só no `catch`) e os `alertar` das vigilâncias (gravam só em anomalia, em transação própria) fazem qualquer rota nova do prontuário e do portal passar como auditada. Correção: na busca, **não atravessar nem contar** uma lista explícita de gravadores incidentais (`GRAVADORES_INCIDENTAIS`, ao lado de `GRAVADOR_DA_TRILHA`): `comNegacaoAuditada` (atravessar só o callback `operacao`, que é o 4º argumento — ou seja, não descer no corpo da própria função), `VigilanciaDeLeituraService.alertar`, `PortalVigilanciaService.alertar`. Conferi com a variante da análise: **as 97 rotas continuam passando** com essa exclusão (todas têm gravador do serviço). Acrescentar um teste de sanidade: um handler sintético que só chama `comNegacaoAuditada(..., async () => tx.insert(...))` sem `recordAudit` tem de dar `alcancaTrilha: false` (pode ser feito com um `ts.createSourceFile` em memória ou um fixture em `test/cobertura-auditoria/fixtures/`, fora de `src/`). Gravador incidental novo (outro "alerta" ou "negação") entra na lista com parecer do Guardião.

**R2 (condição para o merge) — `sem_efeito` precisa ser provado, não declarado.**
`apps/api/test/cobertura-auditoria/lista.ts:116` e `cobertura-auditoria.test.ts:66-73`. Para `tipo: 'sem_efeito'`, o teste deve conferir que o corpo do handler é **um único `throw`** (ou, de forma mais geral, que o handler não alcança nenhuma chamada a `TenantDatabase`/`tx`). Se a rota ganhar implementação, o CI fica vermelho e a rota tem de ir para `AUDITADAS` ou para `banco`. Expor na `RotaDeEscrita` um campo como `soLanca: boolean` resolve.

**R3 (condição para o merge) — decorator HTTP desconhecido tem de falhar alto.**
`analise.ts:17` e `:54`. (a) Incluir `All` em `METODOS_DE_ESCRITA` (rota que aceita qualquer método é de escrita). (b) Dentro de classe `@Controller`, qualquer decorator de método importado de `@nestjs/common` que seja `Get/Post/Put/Patch/Delete/All/Options/Head/Search/RequestMapping` e **não** esteja no conjunto tratado faz o teste falhar com o nome; resolver o decorator pelo símbolo (`checker.getSymbolAtLocation` → `getAliasedSymbol` → nome e módulo `@nestjs/common`) em vez do texto do identificador, para pegar `import { Post as P }`. (c) Falhar também com `applyDecorators` aplicado a método de controller (ou resolvê-lo), até haver necessidade real.

**R4 (pode ser neste PR ou no próximo) — exceção `banco` deve estar ligada ao handler.**
`cobertura-auditoria.test.ts:68-72` só confere que a função SQL citada grava em `audit_log`; não confere que o handler **chama** essa função. Se o resgate passar a chamar outra função (ex.: `app_portal_redeem_invite_v2`) sem `INSERT INTO audit_log`, o teste segue verde. Correção: na análise, coletar os textos de templates `sql\`...\`` alcançados a partir do handler e exigir que contenham `funcaoSql` + `(`. Também falhar se a última definição for `DROP FUNCTION` sem `CREATE` posterior.

**R5 (fila, antes do piloto com dado real) — declaração também para `GET` que devolve dado pessoal ou de saúde.**
Estender o mesmo mecanismo: toda rota `GET` em `AUDITADAS_LEITURA` (com prova de alcance, já com a exclusão de R1) ou em `LEITURA_SEM_DADO_PESSOAL` (com motivo). Hoje não há lacuna (13 `GET` sem trilha, nenhuma sensível), então não bloqueia o S6; mas a auditoria de leitura do prontuário e da ficha é requisito (CFM 1.821/2007; `requisitos-tecnicos-seguranca.md`) e hoje depende só de disciplina + teste RLS por módulo.

**R6 (fila; condição para a D4) — rotas fora de controller Nest.**
Quando o Better Auth (D4) for montado (`app.use`/`toNodeHandler` ou equivalente), login, cadastro, troca de senha, sessão e MFA ficam **fora** do analisador. O PR da D4 tem de: (a) auditar login/logout/falha de login/troca de credencial pelos hooks da biblioteca, na mesma transação quando a biblioteca permitir; e (b) acrescentar ao teste uma conferência de que o único `app.use`/handler de rota fora de controller é a lista conhecida (`http-security.ts` + o handler de auth), com o motivo, para que um terceiro não entre em silêncio.

**R7 (doc, junto com R1) — ajustar o "Limite" do §4d.**
`docs/04-arquitetura/auditoria-encadeada.md` §4d: acrescentar que gravadores incidentais (negação de acesso, alerta de anomalia) **não contam** como trilha da rota, e que a exceção `sem_efeito` é provada pelo teste (R2). Manter a frase "prova que existe caminho, não que todo ramo grava".

## Nota do Maestro (03/11/2026)

- **R1 (feita):** `GRAVADORES_INCIDENTAIS` em `analise.ts` (`comNegacaoAuditada` e os dois `alertar`). A busca não desce neles, mas segue os argumentos, como o callback `operacao`. As 97 rotas continuam passando. No fixture, `so-negacao` e `so-vigilancia` dão `false` e `negacao-com-trilha` dá `true`.
- **R2 (feita):** `soLanca` na análise. Uma exceção `sem_efeito` exige um handler que só lança.
- **R3 (feita):**
  - os decorators são resolvidos pelo símbolo, inclusive com alias de import;
  - `@All` conta como escrita;
  - `@Head/@Options/@Search/@RequestMapping/applyDecorators` e decorator nosso que monta rota por dentro fazem a análise falhar com o nome. Isso é provado por dois fixtures.
- **R4 (feita):**
  - a análise coleta os templates `sql` alcançados a partir do handler, e a exceção `banco` exige a chamada à função citada;
  - um `DROP FUNCTION` depois da última definição faz a conferência falhar.
- **R5 e R6:** na [fila](../../00-governanca/fila.md). A R6 é condição para a D4.
- **R7 (feita):** §4d de `auditoria-encadeada.md`.
