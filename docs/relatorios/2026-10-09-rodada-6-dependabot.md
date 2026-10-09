# Relatório da Rodada 6: atualizações do Dependabot

**Data:** 09/10/2026 · **Responsável:** Maestro · **Agentes:** nenhum (feito direto, sem subagentes)
**Pedido dos sócios:** "testar e fazer o merge dos PRs do Dependabot".

## Resultado

| PR | Atualização | Teste | Decisão |
|---|---|---|---|
| #3 | actions/checkout v4 → v7.0.1 | CI 9/9; SHA conferido com a tag oficial | ✅ Merge `7934a52` |
| #2 | actions/setup-node v4 → v7.0.0 | CI 9/9; SHA conferido | ✅ Merge `33b7839` |
| #1 | pnpm/action-setup v4 → v6.1.0 | Conflito depois do #2 → `@dependabot rebase` → CI 9/9; SHA conferido | ✅ Merge `45206a3` |
| #4 | TypeScript 5.9.3 → **7.0.2** | Typecheck, testes e builds ✅, mas **o lint quebra**: `typescript-eslint does not support TS 7.0` (peer `>=4.8.4 <6.1.0`) | ❌ Fechado com explicação |
| #13 | TypeScript 5.9.3 → **6.0.3** (versão mais nova suportada) + Dependabot ignora `typescript >= 7` | Local: lint/typecheck/test 9/9, `next build`, build da API, audit limpo; CI 9/9 com as actions novas | ✅ Merge `7fcacc3` |

**Como foi feito:**
- Os PRs de actions tinham sido abertos antes de fixarmos as actions por SHA e só cobriam 1–2 workflows. Pedimos `@dependabot recreate`, e ele refez os PRs cobrindo os 4 workflows, mantendo a fixação por SHA.
- Cada SHA foi conferido contra a tag oficial do repositório da action (cadeia de suprimentos).
- **A `main` final está verde nos 4 workflows** (CI, Segurança, Testes de produção, CodeQL). Os 3 primeiros chegaram a ser cancelados porque 2 merges seguidos se atropelaram (`cancel-in-progress`), e passaram ao serem rodados de novo.

## Pendente: 13 PRs novos do Dependabot (#14–#26)
Abertos automaticamente depois da atualização do `dependabot.yml`. **Não foram mergeados**: vários são versões maiores com risco de quebra e precisam da mesma bateria de testes.

| Risco | PRs |
|---|---|
| 🟢 Baixo (minor/patch) | #15 helmet 8.3.0 |
| 🟡 Médio (actions, conferir SHA) | #14 upload-artifact v7, #17/#24 codeql-action v4 (init e analyze juntos) |
| 🔴 Alto (major de framework/ferramenta) | #25/#23/#20 NestJS 12 (core, platform-express e testing juntos), #19/#21 ESLint 10, #22 Vitest 5, #18 @types/node 26 (o CI usa Node 22), #16 @types/supertest 7, #26 globals 17 |

**Próxima rodada sugerida (até 3 agentes):**
1. `devops-ci`: helmet + actions (#15, #14, #17, #24).
2. `engenharia`: NestJS 12 em bloco (#20, #23, #25), rodando resiliência, segurança e carga.
3. `qa-testes`: ESLint 10 + globals + Vitest 5 + types (#16, #18, #19, #21, #22, #26).
