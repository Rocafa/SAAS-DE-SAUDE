# Fila de trabalho compartilhada

> **Para que serve:** há dois Maestros trabalhando no mesmo repositório, a sessão do @Rocafa e a do @Lopesloro. **Antes de pegar um item, confira aqui. Ao pegar, coloque seu nome e commite na `main`.** Ao terminar, mova o item para "Feito".
> Regra: **quem abriu o PR faz o merge**, salvo pedido explícito do outro sócio.

> ⚠️ **12/10/2026 (noite): o GitHub Actions parou** ("recent account payments have failed or your spending limit needs to be increased"). Nenhum CI roda até ajustar o billing da conta Rocafa. **Não fazer merge de PR de código sem CI verde.** PRs só de documentação podem entrar (processo-de-trabalho.md §5). Também parados: os PRs do Dependabot #49–#53 (#49 sobe o ioredis para a versão principal 6 e precisa de teste); com o #54, as actions passam a vir num PR agrupado.

## Em andamento

| Item | Quem pegou | Desde | Onde |
|---|---|---|---|
| Rodada 9.1: ✅ #41, #31, #33 mergeados; Dependabot #14–#26 fechados sozinhos; #18 já ignorado no dependabot.yml | Maestro @Rocafa | 12/10/2026 | concluído |
| Rodada 9.2: ✅ #38 mergeado (conflito no README de LGPD resolvido mantendo os links dos dois lados) | Maestro @Rocafa | 12/10/2026 | concluído |
| Rodada 9.5: **#54** economia de minutos do Actions (PRs de docs sem CI; ZAP só na main; timeouts; Dependabot agrupado). **Só entra depois que o CI voltar e rodar verde** | Maestro @Rocafa | 13/10/2026 | PR #54 |
| Rodada 9.3: parecer do Guardião commitado (#42/#43/#45 aprovados com ressalvas; **#44, #46, #47 VETADOS**, comentários nos PRs). ✅ #42 mergeado (com correção de caminhos no Windows). **#43 pronto** (main juntada, 12/12 local), **parado: GitHub Actions sem minutos/pagamento**. Correções B1–B3 das telas vetadas: com o front (@Lopesloro) | Maestro @Rocafa | 12/10/2026 | PRs |
| Rodada 9.4: atualizar RELATORIO-GERAL (rodadas 6–8), CONTEXTO.md e orquestra.html | Maestro @Rocafa | 12/10/2026 | — |
| Rodada 11.1: ✅ **PR #57** (rotas de pacientes e agenda, auth plugável, exportação G2) — aguarda CI | Maestro @Rocafa | 13/10/2026 | PR #57 |
| Rodada 11.2: ✅ **PR #58** (Terraform do staging + infra.yml) — aguarda CI (checkov só roda lá) | Maestro @Rocafa | 13/10/2026 | PR #58 |
| Rodada 11.3: ✅ **PR #56** (golden sets 50/nicho) — aguarda CI e revisão clínica humana | Maestro @Rocafa | 13/10/2026 | PR #56 |
| Rodada 12.1: ✅ pareceres #56/#57/#58 + re-revisão: todos APROVADOS COM RESSALVAS | Maestro @Rocafa | 13/10/2026 | concluído |
| Rodada 12.2: ✅ **PR #60** telas ligadas à API real (empilhado sobre #57) — aguarda CI | Maestro @Rocafa | 13/10/2026 | PR #60 |
| Rodada 12.3: ✅ **PR #59** imagem Docker + E2E no CI — aguarda CI | Maestro @Rocafa | 13/10/2026 | PR #59 |
| Rodada 13.1: ✅ **PR #61** vínculo de cuidado, limite por usuário + alerta, pseudônimo via KMS (migração 0010) — aguarda CI | Maestro @Rocafa | 14/10/2026 | PR #61 |
| Rodada 13.2: ✅ **PR #62** guias de convênio e pacotes (migração 0011, empilhado sobre #61) — aguarda CI | Maestro @Rocafa | 14/10/2026 | PR #62 |
| Rodada 13.3: ✅ #58 atualizado com R2, R4, R5, R7, N1, N2 (R6/R9 parametrizadas) — aguarda CI | Maestro @Rocafa | 14/10/2026 | PR #58 |
| Rodada 13.4: ✅ relatório geral e CONTEXTO com as rodadas 10–13 | Maestro @Rocafa | 14/10/2026 | concluído |
| Rodada 14.1: ✅ **PR #63** prontuário (migrações 0012/0015), aprovado com ressalvas após 1 veto; #61 e #62 atualizados (0013/0014) — aguarda CI | Maestro @Rocafa | 14/10/2026 | PR #63 |
| Rodada 14.2: ✅ pareceres #61 (2 vetos → aprovado c/ ressalvas), #62 e #63 | Maestro @Rocafa | 14/10/2026 | concluído |
| Rodada 15.1: ✅ ressalvas #61 (0016) e #63 (0017) — aprovados com ressalvas — aguarda CI | Maestro @Rocafa | 15/10/2026 | PRs #61, #63 |
| Rodada 15.2: ✅ **PR #65** financeiro (0018), aprovado com ressalvas — aguarda CI | Maestro @Rocafa | 15/10/2026 | PR #65 |
| Rodada 15.3: ✅ pareceres #61, #63, #65 | Maestro @Rocafa | 15/10/2026 | concluído |
| Rodada 16.1: ressalvas em sequência na pilha — #61 R10 (userId em toda transação + sentinela; migração **0019**), #63 R13/R14 (banco sabe quem é admin/psicólogo; **0020**), #65 R1, R2, R5, R7, R9, R10 (**0021**) | Maestro @Rocafa (agente engenharia) | 15/10/2026 | pilha #61→#62→#63→#65 |
| Rodada 16.2: R11 do #61 — registro de DDL no RDS (pgaudit) no Terraform | Maestro @Rocafa (agente devops-ci) | 15/10/2026 | PR #58 |
| Rodada 16.3: R6 do #65 (financeiro no ROPA) + relatório geral e CONTEXTO com as rodadas 14–15 | Maestro @Rocafa | 15/10/2026 | main |

## Livre (pegue colocando seu nome)

| Item | Referência |
|---|---|
| Reportar o bug do postgres.js 3.4.9 | idem §3 |

## Feito
| Item | Quem | Quando |
|---|---|---|
| Rodada 10 (sem CI): memo de recomendação da D4, kit de entrevistas (D1/D2), pacote para o advogado (D8) | Maestro @Rocafa | 13/10/2026 |
| @Lopesloro no CODEOWNERS (#48) | @Rocafa | 12/10/2026 |
| Relatório "o que falta" | @Rocafa | 12/10/2026 |
