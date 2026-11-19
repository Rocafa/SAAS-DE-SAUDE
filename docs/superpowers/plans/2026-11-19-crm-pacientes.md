# CRM Pacientes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Entregar componentes CRM reutilizáveis e aplicá-los à lista e à ficha de Pacientes, com comportamento acessível e todos os estados explícitos.

**Architecture:** Funções puras cuidam de filtro, ordenação e paginação; componentes clientes cuidam da interação e reutilizam os estados existentes. As telas mantêm os adaptadores atuais. A ficha usa links com query string para quatro visões, mantendo a Visão geral compatível com os fluxos atuais.

**Tech Stack:** Next.js 16, React 19, TypeScript, Tailwind 4, Vitest com `renderToStaticMarkup`, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-19-crm-pacientes-design.md`, `docs/02-produto/PRD.md`, `docs/02-produto/jornadas.md` e a tarefa recebida.

## Global Constraints

- Somente `apps/web` em código de produto; sem backend, banco ou dependências novas.
- Somente tokens existentes; foco visível, contraste AA, alvo de 48 px e modo escuro preservados.
- Sem mudança de papéis, visibilidade clínica, busca auditada no servidor ou regras de inativação.
- TDD: cada comportamento começa com teste vermelho pelo motivo esperado.
- Sem `any`, `@ts-ignore`, `eslint-disable`, testes pulados ou comentários de regra apagados.
- Conventional Commits em português, sem autoria de ferramenta.

## Review Focus

- Busca no modo HTTP não deve ser refiltrada localmente nem perder a chamada auditada ao servidor: E2E fake cobre o caminho local e typecheck preserva o ramo HTTP.
- Busca sem resultado precisa oferecer limpeza de busca/filtro, sem confundir base vazia com ausência de resultado: E2E nas tarefas 2 e 3.
- Paginação deve voltar à primeira página e limitar páginas inválidas quando os resultados diminuem: Vitest e E2E.
- Tabela e cartões não podem coexistir como elementos acessíveis no mesmo viewport: E2E móvel e axe nos specs existentes.
- Autor/origem da timeline nunca pode ser atribuído ao usuário que está vendo a ficha: teste estático usa autor explícito e fallback neutro.

### Task 1: Lógica pura e estados estáticos dos componentes CRM

**Files:**
- Create: `apps/web/components/crm/registros.ts`
- Create: `apps/web/components/crm/registros.test.ts`
- Create: `apps/web/components/crm/cabecalho-pagina.tsx`
- Create: `apps/web/components/crm/selo-status.tsx`
- Create: `apps/web/components/crm/linha-do-tempo.tsx`
- Create: `apps/web/components/crm/estados.test.tsx`
- Modify: `apps/web/lib/api/tipos.ts`
- Modify: `apps/web/lib/api/fake.ts`

**Interfaces:**
- Produces: `filtrarPorTexto<T>(registros: readonly T[], termo: string, texto: (registro: T) => string): T[]`.
- Produces: `filtrarPorStatus<T>(registros: readonly T[], status: string, obterStatus: (registro: T) => string): T[]`.
- Produces: `ordenarRegistros<T>(registros: readonly T[], valor: (registro: T) => string | number, direcao: 'ascendente' | 'descendente'): T[]`.
- Produces: `paginarRegistros<T>(registros: readonly T[], pagina: number, porPagina: number): { itens: T[]; pagina: number; totalPaginas: number; total: number }`.
- Produces: `CabecalhoPagina({ titulo, descricao, status, acaoPrincipal, acoesSecundarias })`.
- Produces: `SeloStatus` para status de agendamento por meio de `Status`, e para texto explícito de situação.
- Consumes: `EventoLinhaTempo` ganha `autor?: string`; `LinhaDoTempo({ eventos, agora? })` mostra autor ou “Autor não informado”.

- [ ] Escrever testes de filtro sem acento, filtro de status, estabilidade de ordenação, ambas as direções, paginação, página fora do limite e imutabilidade das entradas.
- [ ] Rodar `pnpm --filter ./apps/web test -- components/crm/registros.test.ts` e confirmar falha por módulo inexistente.
- [ ] Implementar somente as quatro funções puras, reutilizando `normalizar` de `lib/texto.ts`.
- [ ] Escrever testes `renderToStaticMarkup` para cabeçalho/ações, selos com texto, carregando/vazio/erro reutilizados, timeline com data/tipo/autor e fallback neutro.
- [ ] Rodar `pnpm --filter ./apps/web test -- components/crm` e confirmar falha pelos componentes inexistentes.
- [ ] Implementar os componentes e adicionar autores fictícios de origem aos eventos fake; não inserir conteúdo clínico.
- [ ] Rodar os testes dos componentes e depois `pnpm --filter ./apps/web test`; esperar 0 falhas.
- [ ] Commit `feat(web): cria base de componentes CRM`.

### Task 2: Tabela acessível, responsiva e interativa

**Files:**
- Create: `apps/web/components/crm/tabela-registros.tsx`
- Create: `apps/web/components/crm/ficha-registro.tsx`
- Create: `apps/web/components/crm/estrutura.test.tsx`
- Create: `apps/web/e2e/crm-pacientes.spec.ts`
- Modify: `apps/web/app/(app)/pacientes/page.tsx`

**Interfaces:**
- Produces: `ColunaRegistro<T> = { id: string; titulo: string; celula: (registro: T) => ReactNode; valorOrdenacao?: (registro: T) => string | number }`.
- Produces: `TabelaRegistros<T>` com `registros`, `colunas`, `obterId`, `textoBusca`, `busca`, `aoMudarBusca`, estado de consulta, opções de status, `obterStatus`, `filtrar`, `vazio`, `porPagina` e `buscaNoServidor`.
- Produces: `FichaRegistro({ nome, descricao, status, metadados, acaoPrincipal, acoesSecundarias, voltar, abas, abaAtual, children })`; cada aba tem `id`, `rotulo` e `href`.
- Consumes: funções puras da tarefa 1 e `Carregando`, `Vazio`, `Erro` existentes.

- [ ] Escrever o spec E2E com busca que filtra, ordenação que muda a ordem, paginação, vazio com recuperação, abertura da ficha e cartões no viewport pequeno.
- [ ] Escrever HTML estático para `caption`, `th scope`, `aria-sort`, painel de ficha e navegação de abas com `aria-current`.
- [ ] Rodar `pnpm --filter ./apps/web test -- components/crm` e `pnpm --filter ./apps/web test:e2e -- e2e/crm-pacientes.spec.ts`; confirmar falhas por componentes/tela ausentes.
- [ ] Implementar tabela desktop, cartões móveis, controles com rótulos, estados explícitos e paginação de 10 itens usando as funções reais da tarefa 1.
- [ ] Integrar `CabecalhoPagina` e `TabelaRegistros` em Pacientes, preservando `acharPacientes`, busca HTTP, debounce, truncamento e inativos ocultos por padrão.
- [ ] Rodar unitários, typecheck e build; em seguida rodar o novo spec nos dois projetos Playwright; esperar 0 falhas.
- [ ] Commit `feat(web): aplica tabela CRM em pacientes`.

### Task 3: Ficha com abas e timeline

**Files:**
- Modify: `apps/web/app/(app)/pacientes/[id]/page.tsx`
- Modify: `apps/web/e2e/crm-pacientes.spec.ts`

**Interfaces:**
- Consumes: `FichaRegistro` e `LinhaDoTempo` das tarefas anteriores.
- Produces: URLs `/pacientes/:id`, `?aba=agenda`, `?aba=financeiro` e `?aba=documentos`; valor desconhecido cai em Visão geral.

- [ ] Acrescentar E2E de troca de aba com mudança de URL e conteúdo, retorno à lista, teclado até abrir ficha e aba inválida sem tela quebrada.
- [ ] Rodar `pnpm --filter ./apps/web test:e2e -- e2e/crm-pacientes.spec.ts`; confirmar falha pela ausência das abas.
- [ ] Integrar `FichaRegistro` sem apagar regras de prontuário, anexos, retenção, correção, cancelamento, desfazer ou inativação.
- [ ] Substituir a lista artesanal de eventos por `LinhaDoTempo` na Visão geral; as outras abas isolam as seções já existentes.
- [ ] Rodar o novo spec, `agenda-pacientes.spec.ts`, `atendimento-documentos.spec.ts`, `configuracoes-acesso.spec.ts` e `ajudante.spec.ts`; esperar 0 falhas.
- [ ] Commit `feat(web): organiza ficha do paciente em abas`.

### Task 4: Verificação completa, revisão e handoff

**Files:**
- Modify only if a test exposes a defect within scope.
- Write: `/Users/lopes/SAAS-DE-SAUDE/.orchestration/saas/claude-crm-base-pacientes/handoff.md`

- [ ] Rodar `pnpm --filter ./apps/web lint`, `typecheck`, `test`, `build` e `test:e2e`, sem filtros na suíte final.
- [ ] Se uma falha aparecer, reproduzir, identificar causa raiz e corrigir com teste; não enfraquecer a asserção.
- [ ] Revisar `git diff --check`, `git diff --cached --stat`, o diff completo e os 13 itens do checklist da tarefa.
- [ ] Confirmar que a navegação existente continua fixa, com `aria-current`, quatro itens + Mais no celular e Ajudante íntegro.
- [ ] Commit de eventual correção com tipo fiel e teste correspondente.
- [ ] Escrever handoff com resumo, arquivos, comandos/resultados, riscos, commits e telas da parte 2: Agenda, Atendimento, Financeiro, Documentos e Configurações.
