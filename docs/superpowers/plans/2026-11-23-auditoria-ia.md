# Auditoria de IA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Registrar toda chamada de IA na trilha transacional existente e permitir que o gestor consulte e exporte somente metadados pseudonimizados.

**Architecture:** `AiService` continua sendo a única porta dos provedores e passa a depender de `AuditoriaIaService`. Cada tentativa, recusa e revisão humana grava `audit_log` dentro de `escreverNaClinica`; a revisão é um novo evento ligado por `use_id`, pois a trilha é append-only. A consulta reutiliza RBAC, MFA, RLS e cursor da auditoria atual. O web usa os adaptadores fake/HTTP e Playwright, sem nova dependência.

**Tech Stack:** NestJS 12, TypeScript, Drizzle/PostgreSQL RLS, Vitest, Next.js 16, React 19, Playwright.

**Spec:** pedido `AUDITORIA DE IA (API + tela)` desta tarefa; `docs/05-ia-llm/`; `docs/02-produto/backlog-mvp.md` HU-NUC-018/019; `docs/04-arquitetura/api-dominio.md` §18.

## Global Constraints

- Nenhum prompt, saída, nome, CPF ou conteúdo clínico em claro na trilha, CSV, tela ou testes.
- Paciente aparece somente por UUID; usuário e tenant vêm do `RequestContext`, nunca do navegador.
- Toda chamada sem gravação falha; nenhum `catch` vazio, `any`, `@ts-ignore` ou `eslint-disable`.
- Não editar migrações existentes, não criar perfil de DPO nem política de retenção sem decisão humana.
- Commits Conventional Commits em português, sem atribuição a IA.

## Review Focus

- Falha do `INSERT` de auditoria depois da resposta do provedor: não devolver rascunho; teste na Task 1.
- Dois usos no mesmo milissegundo: cursor por `(created_at, id)` sem perda; teste RLS na Task 2.
- Filtro profissional/finalidade: somente a clínica da sessão e metadados permitidos; teste RLS na Task 2.
- Exportação CSV: neutralizar fórmula, omitir conteúdo e registrar `export`; testes nas Tasks 2 e 3.
- Troca rápida de filtros, erro e duplo clique na exportação: não mostrar resposta antiga nem baixar duas vezes; Playwright na Task 3.

### Task 1: Registro transacional de uso e revisão

**Files:**
- Create: `apps/api/src/modules/audit/registro-ia.ts`
- Modify: `apps/api/src/modules/ai/ai.service.ts`, `ai.module.ts`, `ai.service.test.ts`, `audit.module.ts`
- Create: `apps/api/src/modules/audit/registro-ia.test.ts`

**Interfaces:**
- `AuditoriaIaService.chamar(ctx, dados, provedor): Promise<ResultadoChamadaIa>` executa uma tentativa e grava `ai_use`/`ai_generation` na mesma transação.
- `AiGenerateInput` recebe `ctx: RequestContext`, `patientId?: string` e `professionalId?: string`; `AiDraft.auditId` liga a revisão.
- `registrarRevisao(ctx, { useId, decisao, textoFinal? })` grava `aceita`, `editada` ou `rejeitada`; edição exige hash do texto final.

- [ ] Escrever testes que executam `AiService` + `AuditoriaIaService` + `recordAudit` reais: metadados completos, pseudônimos, revisão, recusa e falha de inserção.
- [ ] Rodar `pnpm --filter ./apps/api exec vitest run src/modules/ai/ai.service.test.ts src/modules/audit/registro-ia.test.ts` e confirmar vermelho por ausência de comportamento.
- [ ] Implementar hashes SHA-256 do prompt completo e da saída, tokens, latência, modelo/versão, usuário/tenant e estados de revisão.
- [ ] Repetir os testes e confirmar verde.
- [ ] Commit `feat(auditoria): registra uso e revisão humana de IA`.

### Task 2: Consulta paginada, CSV e isolamento

**Files:**
- Create: `apps/api/src/modules/audit/consulta-ia.ts`, `consulta-ia.test.ts`
- Create: `apps/api/db/migrations/0066_indices_auditoria_ia.sql`
- Create: `apps/api/test/auditoria-ia.rls.test.ts`
- Modify: `apps/api/src/modules/audit/audit.module.ts`, `docs/04-arquitetura/api-dominio.md`

**Interfaces:**
- `GET /clinica/auditoria-ia`: `de`, `ate`, `profissionalId`, `finalidade`, `limite`, `cursor`.
- `GET /clinica/auditoria-ia/exportar.csv`: mesma página filtrada, CSV RFC 4180, evento `export`.
- Ambos exigem `auditoria:consultar` + MFA recente; hoje `admin` é o gestor documentado.

- [ ] Escrever validação e testes RLS/HTTP para filtros, página seguinte, 400/401/403, outro tenant, ausência de PII e auditoria de leitura/exportação.
- [ ] Rodar os testes novos e confirmar vermelho pelo motivo esperado.
- [ ] Implementar consulta na `audit_log`, projeção da revisão mais recente, índices aditivos e CSV com `toCsv` existente.
- [ ] Rodar testes unitários e `test:rls` se Postgres estiver disponível; registrar qualquer limitação sem omiti-la.
- [ ] Commit `feat(auditoria): consulta e exporta metadados de IA`.

### Task 3: Tela “Auditoria de IA”

**Files:**
- Create: `apps/web/components/app/auditoria-ia.tsx`, `apps/web/lib/auditoria-ia.ts`, testes puros necessários
- Create: `apps/web/e2e/auditoria-ia.spec.ts`
- Modify: `apps/web/lib/api/{cliente,tipos,fake,http}.ts`, `apps/web/components/app/configuracoes.tsx`, `apps/web/e2e/telas.spec.ts`

**Interfaces:**
- `listarAuditoriaIa(filtro): Promise<PaginaAuditoriaIa>` e `exportarAuditoriaIaCsv(filtro): Promise<string>` nos dois adaptadores.
- Seção `/configuracoes/auditoria-ia`: filtros, tabela de metadados, anterior/próxima e exportação da página claramente identificada.

- [ ] Escrever Playwright para carregar, filtrar, paginar, baixar CSV sem identificadores, negar recepção, mostrar vazio/erro/rede/lento e bloquear duplo clique.
- [ ] Escrever testes do adaptador HTTP para query sem tenant, CSV e erros reais `ErroApi` 401/403/404/500/rede.
- [ ] Rodar E2E e adaptador, confirmando vermelho por funcionalidade ausente.
- [ ] Implementar tela e adaptadores com dados 100% fictícios.
- [ ] Rodar `pnpm --filter ./apps/web test:e2e -- e2e/auditoria-ia.spec.ts` e testes do adaptador até verde.
- [ ] Commit `feat(web): mostra auditoria de IA com exportação CSV`.

### Task 4: Verificação e handoff

- [ ] Revisar o diff contra os 13 itens do pedido e procurar dado identificável em todos os artefatos.
- [ ] Rodar lint, typecheck, test e build de `shared`, `api` e `web`; rodar E2E afetado e `test:rls` quando disponível.
- [ ] Conferir `git diff --check`, arquivos terminados em nova linha e `git diff --cached --stat` antes de cada commit.
- [ ] Atualizar handoff com inventário, evidências, riscos, commits e perguntas `PRECISA DE HUMANO` sobre retenção e DPO.
