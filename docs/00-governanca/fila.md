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
| Rodada 11.1: rotas de negócio da API (pacientes e agenda) seguindo a `ApiClinica`, com autenticação plugável (pronta para Better Auth, D4 recomendada) | Maestro @Rocafa (agente engenharia) | 13/10/2026 | branch `eng/rotas-pacientes-agenda` |
| Rodada 11.2: PR do Terraform do staging + `infra.yml` + requisitos do Guardião | Maestro @Rocafa (agente devops-ci) | 13/10/2026 | branch `devops/terraform-staging-b` |
| Rodada 11.3: golden sets de IA, 50 por nicho (sintéticos) + checklist de revisão clínica | Maestro @Rocafa (agente ia-llm) | 13/10/2026 | branch `ia/golden-sets-50` |

## Livre (pegue colocando seu nome)

| Item | Referência |
|---|---|
| Dockerfile + `imagem.yml` + job de E2E do front no CI | idem §3 |
| Reportar o bug do postgres.js 3.4.9 | idem §3 |

## Feito
| Item | Quem | Quando |
|---|---|---|
| Rodada 10 (sem CI): memo de recomendação da D4, kit de entrevistas (D1/D2), pacote para o advogado (D8) | Maestro @Rocafa | 13/10/2026 |
| @Lopesloro no CODEOWNERS (#48) | @Rocafa | 12/10/2026 |
| Relatório "o que falta" | @Rocafa | 12/10/2026 |
