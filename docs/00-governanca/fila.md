# Fila de trabalho compartilhada

> **Para que serve:** há dois Maestros trabalhando no mesmo repositório, a sessão do @Rocafa e a do @Lopesloro. **Antes de pegar um item, confira aqui. Ao pegar, coloque seu nome e commite na `main`.** Ao terminar, mova o item para "Feito".
> Regra: **quem abriu o PR faz o merge**, salvo pedido explícito do outro sócio.

> ⚠️ **13/10/2026: o GitHub Actions parou** ("recent account payments have failed or your spending limit needs to be increased"). Nenhum CI roda até ajustar o billing da conta Rocafa. **Não fazer merge sem CI verde.**

## Em andamento

| Item | Quem pegou | Desde | Onde |
|---|---|---|---|
| Rodada 9.1: ✅ #41, #31, #33 mergeados; Dependabot #14–#26 fechados sozinhos; #18 já ignorado no dependabot.yml | Maestro @Rocafa | 12/10/2026 | concluído |
| Rodada 9.2: rebase/atualização do #38 (LGPD) | Maestro @Rocafa | 12/10/2026 | `lgpd/mapa-regulatorio-rebase` |
| Rodada 9.3: parecer do Guardião commitado (#42/#43/#45 aprovados com ressalvas; **#44, #46, #47 VETADOS**, comentários nos PRs). ✅ #42 mergeado (com correção de caminhos no Windows). **#43 pronto** (main juntada, 12/12 local), **parado: GitHub Actions sem minutos/pagamento**. Correções B1–B3 das telas vetadas: com o front (@Lopesloro) | Maestro @Rocafa | 12/10/2026 | PRs |
| Rodada 9.4: atualizar RELATORIO-GERAL (rodadas 6–8), CONTEXTO.md e orquestra.html | Maestro @Rocafa | 12/10/2026 | — |

## Livre (pegue colocando seu nome)

| Item | Referência |
|---|---|
| PR do Terraform do staging + `infra.yml` | [o-que-falta §3](../relatorios/2026-10-12-o-que-falta.md) |
| Dockerfile + `imagem.yml` + job de E2E do front no CI | idem §3 |
| Reportar o bug do postgres.js 3.4.9 | idem §3 |
| Golden sets de IA: 50 por nicho com revisão clínica | idem §3 |
| Rotas de negócio da API seguindo a `ApiClinica` *(depois da D4)* | idem §4.1 |

## Feito
| Item | Quem | Quando |
|---|---|---|
| @Lopesloro no CODEOWNERS (#48) | @Rocafa | 12/10/2026 |
| Relatório "o que falta" | @Rocafa | 12/10/2026 |
