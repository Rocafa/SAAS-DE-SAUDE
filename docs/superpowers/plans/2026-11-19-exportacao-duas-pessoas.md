# Exportação total com duas pessoas — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Impedir que quem pediu a exportação total aprove o próprio pedido no fluxo de demonstração, mantendo a aprovação por outro administrador e a proteção de privacidade das telas da clínica.

**Architecture:** O pedido fictício passa a guardar o id de quem o criou. O adaptador fake reproduz a recusa 403 exigida para o servidor; a tela apresenta essa recusa sem esconder o estado pendente. A varredura recursiva das telas da clínica e o botão restrito ao modo fake já estão na `origin/main` e serão validados sem reimplementação.

**Tech Stack:** TypeScript, React 19, Next.js 16, Vitest, Playwright, pnpm.

**Spec:** Issue #102; `docs/03-seguranca-lgpd/revisoes/2026-10-29-pr103-front.md` (R6 e R8); `docs/03-seguranca-lgpd/revisoes/2026-11-05-pilha-front-86.md` (P5).

## Global Constraints

- TDD: vermelho pelo comportamento errado antes de cada implementação.
- Sem `any`, `@ts-ignore`, `eslint-disable`, dependências novas ou testes enfraquecidos.
- Erro de autoaprovação: `ErroApi`, status 403, código `autoaprovacao_proibida`.
- Nenhum dado real, segredo, storage, console ou auditoria removida.
- A rota HTTP da exportação ainda não existe; não criar backend nesta tarefa.
- Commits Conventional Commits em português, sem autoria de ferramenta.

## Review Focus

- Mesmo usuário tentando aprovar: manter `aguardando_rt`, sem auditoria de aprovação (Task 1).
- Profissional sem papel admin tentando aprovar um pedido real: recusar 403 (Task 1).
- Outro administrador: permitir aprovação e manter prazo, downloads e auditoria (Task 1).
- Falha do adaptador ao clicar no botão: mostrar o erro real e conservar o aviso de aprovação pendente (Task 2).
- Telas da clínica com console, storage, analytics ou HTML cru: a varredura existente deve falhar (Task 3).

---

### Task 1: Identidade e segregação no adaptador fake

**Files:**
- Modify: `apps/web/lib/api/tipos.ts`
- Modify: `apps/web/lib/api/cliente.ts`
- Modify: `apps/web/lib/api/fake.ts`
- Test: `apps/web/lib/conta.test.ts`
- Test: `apps/web/lib/api/papeis.test.ts`

**Interfaces:**
- Consumes: `ApiClinica.pedirExportacao(codigo)`, `ApiClinica.aprovarExportacao(id)`, `ApiClinica.entrarComo(id)`.
- Produces: `PedidoExportacao.pedidoPor: string`; aprovação por usuário diferente de `pedidoPor`, ainda restrita a admin.

- [ ] **Step 1: Write the failing tests**

Em `conta.test.ts`, criar um pedido como `u1` e exigir primeiro que a aprovação pela mesma instância rejeite com `{ status: 403, codigo: 'autoaprovacao_proibida' }`. Conferir `pedidoPor === 'u1'`, trocar para `u5`, aprovar e verificar `pronto`, 3 downloads, expiração em `2026-10-13` e uma única auditoria de aprovação atribuída a `u5`.

Em `papeis.test.ts`, criar pedido como admin, trocar para `u2` (profissional) e exigir 403 ao aprovar esse id real.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter ./apps/web test -- lib/conta.test.ts lib/api/papeis.test.ts`
Expected: FAIL porque a autoaprovação atual resolve; o vermelho não pode depender da ausência de `pedidoPor`.

- [ ] **Step 3: Implement the minimal contract and guard**

Adicionar `pedidoPor: string` a `PedidoExportacao`, gravando `usuario.id` em `pedirExportacao`. Em `aprovarExportacao`, depois de `exigirAdmin()` e de localizar o pedido, lançar `new ErroApi('Quem pediu a exportação não pode aprovar. O responsável técnico precisa ser outra pessoa.', 403, 'autoaprovacao_proibida')` quando os ids forem iguais. Documentar em `cliente.ts` que a identidade diferente é verificada no servidor.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter ./apps/web test -- lib/conta.test.ts lib/api/papeis.test.ts`
Expected: PASS, incluindo caminho permitido e os dois caminhos negados.

### Task 2: Recusa visível no fluxo da tela

**Files:**
- Modify: `apps/web/components/app/configuracoes.tsx`
- Test: `apps/web/e2e/configuracoes-acesso.spec.ts`

**Interfaces:**
- Consumes: `api.aprovarExportacao(id)` e seu `ErroApi` da Task 1.
- Produces: alerta visível de autoaprovação recusada; pedido continua aguardando responsável técnico.

- [ ] **Step 1: Write the failing E2E test**

No cenário G2 existente, após pedir com MFA e ciência do sigilo, clicar em `Aprovar como responsável técnico (demonstração)`. Exigir `role=alert` com `Quem pediu a exportação não pode aprovar. O responsável técnico precisa ser outra pessoa.` e manter visível `Falta a aprovação do responsável técnico`. Não esperar mais sucesso da mesma pessoa.

- [ ] **Step 2: Run E2E to verify it fails**

Run: `pnpm --filter ./apps/web test:e2e -- configuracoes-acesso.spec.ts --grep "G2"`
Expected: FAIL porque não existe alerta de erro na etapa pendente.

- [ ] **Step 3: Implement approval error handling**

Adicionar estado `erroAprovacao` e função `aprovar()` com `try/catch`. Limpar somente esse erro numa nova tentativa, atualizar o pedido no sucesso e mostrar `err.message` no erro. Renderizar `role="alert"` dentro da etapa pendente, sem substituir os avisos existentes. Não criar estado de carregamento nem nova navegação.

- [ ] **Step 4: Run E2E to verify it passes**

Run: `pnpm --filter ./apps/web test:e2e -- configuracoes-acesso.spec.ts --grep "G2"`
Expected: PASS nos projetos celular e computador.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/api/tipos.ts apps/web/lib/api/cliente.ts apps/web/lib/api/fake.ts apps/web/lib/conta.test.ts apps/web/lib/api/papeis.test.ts apps/web/components/app/configuracoes.tsx apps/web/e2e/configuracoes-acesso.spec.ts
git commit -m "fix(web): exige duas pessoas na exportação total"
```

### Task 3: Varredura e verificação completa

**Files:**
- Verify only: `apps/web/lib/privacidade.test.ts`

**Interfaces:**
- Consumes: varredura recursiva de `app/(app)`, componentes da clínica e `lib/api/fake.ts`, já presente na `origin/main`.

- [ ] **Step 1: Run the real privacy scan**

Run: `pnpm --filter ./apps/web test -- lib/privacidade.test.ts`
Expected: PASS; mais de 20 arquivos da clínica enumerados e nenhum padrão proibido encontrado.

- [ ] **Step 2: Verify that the scan catches a planted violation**

Inserir temporariamente um `console.log` sem dados numa página real de prontuário, rodar o mesmo teste e exigir falha nomeando esse arquivo. Remover a mutação em seguida e repetir o teste até voltar ao verde. Nenhuma mutação pode ser commitada.

- [ ] **Step 3: Run all affected-package checks**

Run: `pnpm --filter ./apps/web lint`
Run: `pnpm --filter ./apps/web typecheck`
Run: `pnpm --filter ./apps/web test`
Run: `pnpm --filter ./apps/web build`
Run: `pnpm --filter ./apps/web test:e2e -- configuracoes-acesso.spec.ts`
Expected: todos com exit 0, sem testes pulados no alvo.

- [ ] **Step 4: Review the complete diff and handoff**

Conferir os 13 itens do brief, `git diff --cached --stat`, ausência de autoria de ferramenta e arquivos fora do escopo. Registrar comandos, resultados, riscos e commits no handoff.

## Correção da revisão independente

A revisão fresca bloqueou a primeira versão: após trocar de usuário, a tela perdia o pedido local e o E2E feliz tinha sido substituído pela recusa. A correção adiciona `obterExportacaoPendente(): Promise<PedidoExportacao | null>` ao contrato e ao fake, com `exigirAdmin()`. A tela recupera o pendente sem storage, com estados de carga/erro e proteção contra duplo clique; após aprovar, atualiza a auditoria.

O teste unitário agora lê o mesmo pedido após o 403 e confirma `aguardando_rt`, antes e depois da troca para `u5`. O E2E navega por links client-side até `/mais`, troca para `u5`, retoma o pendente, aprova e verifica link, 3 downloads e uma única linha de auditoria. Um `page.goto` intermediário foi descartado porque recarregava a página e reinicializava o fake, ao contrário do fluxo real.
