# Ensaio do merge do login real — 11/11/2026

> Maestro (@Rocafa). Mesmo método do [ensaio de 25/10](2026-10-25-ensaio-de-merge.md): juntar localmente tudo o que está para entrar, sobre a `main` de hoje, e rodar a bateria. Nada foi para a `main`; a branch do ensaio (`ensaio/merge-11-11`) ficou só no disco.

## O que entrou no ensaio

Sobre `origin/main`, nesta ordem:

| Ordem | Branch | PR | Resultado |
|---|---|---|---|
| 1 | `eng/hmac-por-uso` (topo da pilha; traz #149 → #179) | #149 a #179 | sem conflito |
| 2 | `eng/mfa-recusa-rota-comum` | #153 | sem conflito |
| 3 | `eng/trava-logs-furos` | #154 | sem conflito |
| 4 | `eng/e2e-hoje-no-fuso-da-clinica` | #172 | sem conflito |
| 5 | `eng/trilha-do-login` (do @Lopesloro) | #166 | **conflito** em 2 arquivos, resolvido (abaixo) |
| 6 | `eng/sair-pelo-botao-na-trilha` | #169 | sem conflito |

O #174 (abertura) ficou de fora de propósito: só entra depois do checklist B1–B9.

## Bateria (sem Postgres local: a RLS roda só no CI)

| Onde | Resultado |
|---|---|
| install com lock congelado | OK |
| API: `tsc --noEmit`, `eslint src` | limpos |
| API: `vitest run` | **1147 verdes**, 6 pulados (depois da correção abaixo; antes, 1 falha) |
| web: `tsc --noEmit`, `eslint .` | limpos |
| web: `vitest run` | **412 verdes** |

## Achado 1: a trava de logs do #154 reprovava o job da plataforma (corrigido no #154)

A trava endurecida no #154 trata `Object.entries(...)` e `String(...)` como despejo de objeto. O job da plataforma (PR 3a da D4, `executor-de-jobs.ts:137`) monta o log das contagens exatamente assim. Cada PR passava sozinho; juntos, a `main` ficaria vermelha no primeiro merge que reunisse os dois.

O objeto já passou por `contagensParaTrilha`: só números e booleanos, chaves validadas, no máximo 12, com teste. A correção foi no #154 (`192c707`):
- a liberação por arquivo (`PERMITIDOS_POR_ARQUIVO`) passa a valer também na regra de despejo;
- `resultado` e `v` foram liberados só em `modules/jobs/executor-de-jobs.ts`, com o motivo;
- um autoteste prova que o mesmo código em outro arquivo continua reprovado.

Com a correção no #154, a trava fica certa em qualquer ordem de merge.

## Achado 2: o #166 conflita com a pilha (resolução documentada)

O #166 (fim da sessão na trilha) aponta para `eng/better-auth-base`, e a pilha acrescentou funções no mesmo ponto de `provedor.ts`. São dois conflitos só de justaposição:
- **`provedor.ts`:** fica tudo o que a pilha acrescentou (`aposMfaVerificado`, `aposMfaRecusado`, `trilhaDoFator`), seguido do JSDoc novo do `encerrar` que vem do #166;
- **teste do contrato:** ficam os imports da pilha, acrescentando o `auditLog` que o #166 usa (`import { auditLog, tenants } from '../src/db/schema'`).

Quando o #166 entrar na base, o conflito aparece no primeiro PR da pilha que traz `aposMfaVerificado` (o #152). Resolvo lá e propago pela pilha com merge da base em cada branch, como de costume.

## Ordem de merge recomendada

1. #166 → `eng/better-auth-base` (o merge é do sócio) e #169 logo depois.
2. Pilha #149 → #179, propagando o conflito do achado 2.
3. Avulsos #153, #154 e #172 (qualquer ordem).
4. #116 (postgres.js 4) e #151 (Dependabot) por último, por causa do lockfile.
