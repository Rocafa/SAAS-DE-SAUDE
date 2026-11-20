# Conteúdo clínico da issue 167 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Completar, sem inventar conteúdo clínico, os campos textuais e as validações de medidas que a issue 167 e o parecer do Guardião especificam.

**Architecture:** A API continua validando o conteúdo real em `modelos.ts`; o catálogo de instrumentos ganha tipo fechado e a TO declara seus tipos e instrumentos permitidos. O front usa o mesmo contrato textual já aceito pela API e pelo adaptador fake. Não se altera o adaptador HTTP, que pertence ao PR aberto #158, nem o cadastro de conselho/supervisão, que pertence ao PR #194 e ao desenho de cofinalização.

**Tech Stack:** TypeScript, NestJS 12, Next.js 16, React 19, Vitest e Playwright em modo fake.

**Spec:** Issue #167 (`gh issue view 167`), `docs/03-seguranca-lgpd/revisoes/2026-11-13-codigo-modelos-por-especialidade.md`, `docs/04-arquitetura/supervisor-do-estagiario.md` e `docs/02-produto/backlog-mvp.md` (HU-PRO-015, HU-PRO-022 e HU-PRO-023).

## Global Constraints

- Implementar somente nomes, faixas e pontos de corte explícitos na issue ou nos docs.
- Não incorporar COPM nem testes psicológicos; psicologia só referencia instrumentos em texto livre.
- Preservar compatibilidade do rótulo como reserva ao instrumento explícito e todos os comentários de regra.
- Não alterar migrações, RLS, autenticação, auditoria ou retenção; não tocar o adaptador HTTP do PR #158 nem o cadastro do PR #194. Preservar a regra de compatibilidade por especialidade do PR #219, sem incorporar o trabalho dele.
- TDD: cada mudança de produção começa por teste vermelho executado contra o código real.
- Sem `any`, `@ts-ignore`, `eslint-disable`, dependências novas ou atribuição adicional nos commits.

## Review Focus

- Valores exatamente nos limites e imediatamente fora deles: a validação deve aceitar os primeiros e rejeitar os demais; Task 1.
- Escala livre ou instrumento de fisioterapia enviado à TO: recusar sem bloquear o catálogo da fisioterapia; Task 1.
- Registro antigo com rótulo “Barthel” ou “MIF”, sem `instrumento`: continuar válido pela reserva já documentada; Task 1.
- Psicologia com instrumento textual e com `medidas`: aceitar somente a referência textual, sem liberar pontuação; Tasks 1 e 2.
- Campos novos após assinatura: precisam persistir e reaparecer na tela, sem relaxar os obrigatórios; Task 2.

### Task 1: Catálogo tipado e validação por especialidade

**Files:**
- Modify: `apps/api/src/modules/records/modelos.ts`
- Test: `apps/api/src/modules/records/modelos.test.ts`

**Interfaces:**
- Consumes: `validarConteudo(modelo, valor)` e `EntradaInvalidaError.campos`.
- Produces: `InstrumentoConhecido`, catálogo `INSTRUMENTOS` tipado, e restrições declarativas da TO em `MODELOS`.

- [ ] **Step 1: Write the failing tests**

Adicionar casos reais de `validarConteudo` para: psicologia aceitar `instrumentos` como texto e continuar recusando `medidas`; TO aceitar somente `escala` de Barthel/MIF e suas subescalas; TO recusar EVA, força, goniometria, perimetria, Berg, NPRS, escala livre e COPM; fisioterapia manter esses instrumentos permitidos, exceto COPM. Cobrir limites literais: EVA e NPRS 0/10; MRC 0/5; Barthel 0/100; MIF 18/126; MIF motora 13/91; MIF cognitiva 5/35; valores fora de cada faixa e decimais nos instrumentos inteiros.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @plataforma/api exec vitest run src/modules/records/modelos.test.ts`
Expected: falhas pelos campos ainda desconhecidos e pelas medidas da TO ainda aceitas; nenhuma falha por erro de sintaxe ou fixture.

- [ ] **Step 3: Implement the minimal validation**

Tipar `INSTRUMENTOS` com `as const`, expor `InstrumentoConhecido = keyof typeof INSTRUMENTOS` e usar esse tipo em `Medida.instrumento`. Em `DefinicaoModelo`, adicionar listas opcionais de tipos de medida e instrumentos. Na TO, permitir somente `escala` e `barthel`, `mif`, `mif_motora`, `mif_cognitiva`. Passar o modelo a `validarMedidas`; resolver primeiro o instrumento explícito ou o rótulo de compatibilidade e aplicar a lista da especialidade. Adicionar `instrumentos` aos textos da psicologia, mantendo `medidas: false`.

- [ ] **Step 4: Run the API checks**

Run: `pnpm --filter @plataforma/api exec vitest run src/modules/records/modelos.test.ts`
Expected: todos os testes do arquivo passam.

Run: `pnpm --filter @plataforma/api lint && pnpm --filter @plataforma/api typecheck && pnpm --filter @plataforma/api test && pnpm --filter @plataforma/api build`.
Expected: exit 0 em todos; nenhuma falha omitida.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/records/modelos.ts apps/api/src/modules/records/modelos.test.ts
git commit -m "fix(prontuario): restringe medidas da TO e referencia instrumentos psicológicos"
```

### Task 2: Campos clínicos na tela de atendimento

**Files:**
- Modify: `apps/web/lib/prontuario.ts`
- Test: `apps/web/lib/prontuario.test.ts`
- Test: `apps/web/e2e/atendimento-documentos.spec.ts`

**Interfaces:**
- Consumes: as chaves textuais `diagnostico`, `exames`, `nivel_assistencia` e `instrumentos` aceitas pela API.
- Produces: campos opcionais nos modelos visíveis; obrigatórios atuais permanecem inalterados.

- [ ] **Step 1: Write the failing unit and E2E tests**

No Vitest, verificar os campos e a preservação dos obrigatórios por especialidade. No Playwright, preencher, salvar, assinar e reler diagnóstico/exames na fisioterapia; diagnóstico/exames/nível de assistência na TO; referência de instrumento na psicologia. Na TO, tentar assinar sem objetivo/atividades deve mostrar as faltas antes do preenchimento. Conferir o aviso de responsabilidade pela conferência no SATEPSI.

- [ ] **Step 2: Build and run E2E to verify it fails**

Run: `pnpm --filter @plataforma/web exec vitest run lib/prontuario.test.ts`
Expected: falhas porque os campos novos ainda não existem.

Run: `pnpm --filter @plataforma/web build && pnpm --filter ./apps/web test:e2e -- atendimento-documentos.spec.ts`
Expected: seletores dos campos novos não encontrados; os demais comportamentos continuam íntegros.

- [ ] **Step 3: Implement the specified fields**

Adicionar campos opcionais com os nomes clínicos da issue: diagnóstico e prognóstico fisioterapêuticos; diagnóstico e prognóstico terapêuticos ocupacionais; exames complementares realizados ou solicitados; nível de assistência em texto livre. Em psicologia, adicionar referência textual a instrumentos, sem escore, com ajuda que atribui ao profissional a conferência no SATEPSI. Nenhuma categoria de assistência, instrumento psicológico ou conteúdo de teste será predefinida.

- [ ] **Step 4: Run the web checks**

Run: `pnpm --filter @plataforma/web exec vitest run lib/prontuario.test.ts`
Expected: todos os testes do arquivo passam.

Run: `pnpm --filter @plataforma/web lint && pnpm --filter @plataforma/web typecheck && pnpm --filter @plataforma/web test && pnpm --filter @plataforma/web build && pnpm --filter ./apps/web test:e2e -- atendimento-documentos.spec.ts`.
Expected: exit 0 em todos; E2E verde nos projetos celular e computador.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/prontuario.ts apps/web/lib/prontuario.test.ts apps/web/e2e/atendimento-documentos.spec.ts
git commit -m "feat(web): exibe campos clínicos da COFFITO e referência ao SATEPSI"
```

### Task 3: Revisão e handoff

- [ ] Reler o diff contra a issue, os 13 itens do pedido e os comentários preservados.
- [ ] Executar os testes RLS de prontuário se o banco estiver disponível; registrar explicitamente qualquer bloqueio de infraestrutura.
- [ ] Registrar como `PRECISA DE HUMANO`: licença e faixas da COPM; articulações/movimentos e faixas de referência da goniometria; variante Barthel 0–20; tela e perfil do aviso de propriedade/acesso ao prontuário; decisão sobre estagiários do piloto.
- [ ] Registrar que o PR #194 já cobre o pré-requisito de registro no conselho e que a cofinalização segue o desenho próprio.
- [ ] Escrever o handoff com comandos, resultados, riscos e commits; deixar o branch limpo.
