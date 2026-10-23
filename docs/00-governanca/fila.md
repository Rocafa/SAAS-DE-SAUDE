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
| Rodada 16.1: ✅ ressalvas #61 (0019), #63 (0020), #65 (0021) — aprovados com ressalvas — aguarda CI | Maestro @Rocafa | 15/10/2026 | PRs #61, #63, #65 |
| Rodada 16.2: ✅ pgaudit + alarme de DDL no #58 | Maestro @Rocafa | 15/10/2026 | PR #58 |
| Rodada 16.3: ✅ financeiro no ROPA; relatório geral e CONTEXTO | Maestro @Rocafa | 15/10/2026 | concluído |
| Rodada 17.1: ✅ ressalvas #63 (0022) e #65 (0023) | Maestro @Rocafa | 15/10/2026 | concluído |
| Rodada 17.2: ✅ alarme de função/policy + conferência pós-deploy (#58) | Maestro @Rocafa | 15/10/2026 | concluído |
| Rodada 17.3: ✅ **PR #66** importador (0024) — **VETADO** (V1), correção em andamento: teste instável #63, #65 R14–R16 (0025), #66 V1+R1/R2/R4/R6 (0026) | Maestro @Rocafa (agente engenharia) | 16/10/2026 | PR #66 |
| Rodada 18.1: backend do **portal do paciente** com contrato próprio (ApiPortal; servidor descobre o paciente pela sessão — correção estrutural do B3 do #47) — migração **0027**, sobre #65 | Maestro @Rocafa (agente engenharia) | 19/10/2026 | branch `eng/portal-paciente` |
| Rodada 18.2: **responsáveis do paciente** (menores, representante legal, pagador) — migração **0028**, sobre #65 | Maestro @Rocafa (agente engenharia) | 19/10/2026 | branch `eng/responsaveis` |
| Rodada 18.3: **lembretes e confirmação por WhatsApp** (provedor plugável com adaptador falso; templates neutros; opt-in; respostas confirmam/cancelam) — migração **0032**, sobre #65 | Maestro @Rocafa (agente engenharia) | 20/10/2026 | branch `eng/whatsapp-lembretes` |
| Rodada 19.1: ✅ correção do veto do **#67** (responsáveis; pagador congelado no recebimento) — migração **0031** — **APROVADO COM RESSALVAS** | Maestro @Rocafa (agente engenharia) | 21/10/2026 | branch `eng/responsaveis` |
| Pendências do #67 (parecer 21/10, C2): A1 escopo da informação e pedido de sigilo do adolescente; A3 tipo `apoiador`; A4 responsáveis na retenção de 20 anos; CPF completo no recibo emitido pela recepção; R1 anular pagador com recebimentos exige `financeiro:operar` e marca `pagador_anulado`; R2 documentar como o financeiro resolve `pagador_responsavel`. **C1:** merge só com `responsaveis.rls` e `financeiro.rls` verdes no CI. **C3:** nada consome a marca clínica (portal/comunicação) sem A1 e novo parecer | Maestro @Rocafa | 21/10/2026 | a fazer |
| Rodada 19.2: ✅ correção do veto do **#68** (portal, 0033) — **APROVADO COM RESSALVAS** em 22/10; ressalvas R1–R4/R7 em andamento | Maestro @Rocafa (agente engenharia) | 22/10/2026 | branch `eng/portal-paciente` |
| Rodada 19.4: ✅ ressalvas do #67 (R1, R2, A4, recibo mascarado) — migração **0034**, G2 1.15.0 | Maestro @Rocafa (agente engenharia) | 22/10/2026 | branch `eng/responsaveis` |
| Rodada 19.5: **#69** WhatsApp (0032) **VETADO** em 21/10 (opt-in sem número, menor sem nascimento, modelo sem lista fechada) — correção em andamento | Maestro @Rocafa (agente engenharia) | 22/10/2026 | PR #69 |
| Rodada 19.3: ✅ integração **PR #73** (#66/#67/#68/#69 sobre #65, migrações 0024–0038, G2 1.17.0) — **APROVADO** pelo Guardião em 23/10; rls 517/517 local. **Entra no lugar dos 4 PRs** quando o CI voltar | Maestro @Rocafa | 23/10/2026 | PR #73 |

| Rodada 20.1: ressalvas abertas do **#65** (R18/R19) e S1 do #73 — feitas **sobre a integração** (#73), migração **0041** | Maestro @Rocafa (agente engenharia) | 23/10/2026 | branch `eng/integracao-r19` |
| Rodada 20.2: R17 do **#63** (runbook de confirmação do fundador) sobre a integração; migração **0042** se precisar | Maestro @Rocafa (agente engenharia) | 23/10/2026 | branch `eng/integracao-r19` |
| Rodada 20.3: observações da R10 do **#58** (CREATE TRIGGER, REVOKE ROLE, DROP CASCADE; atributos de papéis na conferência) | Maestro @Rocafa (agente devops-ci) | 23/10/2026 | PR #58 |

## Livre (pegue colocando seu nome)

| Item | Referência |
|---|---|
| **R10 do #66 (infra, dono devops-ci):** apagar `IMPORT_CPF_FP_KEY` do cofre e registrar o descarte — antes da 1ª importação real | parecer do importador, conferência 22/10/2026 |
| **#66 R3/R9:** crypto-shredding por lote e índice cego HMAC no KMS — R3 antes de ligar o importador em produção; R9 antes do GA | idem |
| **#67 N1–N3:** guarda de 20 anos considerar `patients.updated_at`, sessões e assinaturas de guia; via oficial do recibo (IR) pelo financeiro; corrida recebimento × anulação | parecer #67, conferência 22/10/2026 |
| **#73 S1 (opcional):** teste do destinatário tentando alterar outra coluna ou desmarcar a leitura de `clinical_notices` por SQL (N1/N2/N3/O1 ✅ em 0039/0040) | parecer #73, 23/10/2026 |
| Reportar o bug do postgres.js 3.4.9 | idem §3 |

## Feito
| Item | Quem | Quando |
|---|---|---|
| Rodada 10 (sem CI): memo de recomendação da D4, kit de entrevistas (D1/D2), pacote para o advogado (D8) | Maestro @Rocafa | 13/10/2026 |
| @Lopesloro no CODEOWNERS (#48) | @Rocafa | 12/10/2026 |
| Relatório "o que falta" | @Rocafa | 12/10/2026 |
