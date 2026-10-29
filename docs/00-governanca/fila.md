# Fila de trabalho compartilhada

> **Para que serve:** há dois Maestros trabalhando no mesmo repositório, a sessão do @Rocafa e a do @Lopesloro. **Antes de pegar um item, confira aqui. Ao pegar, coloque seu nome e commite na `main`.** Ao terminar, mova o item para "Feito".
> Regra: **quem abriu o PR faz o merge**, salvo pedido explícito do outro sócio.

> ⚠️ **12/10/2026 (noite): o GitHub Actions parou** ("recent account payments have failed or your spending limit needs to be increased"). Nenhum CI roda até ajustar o billing da conta Rocafa. **Não fazer merge de PR de código sem CI verde.** PRs só de documentação podem entrar (processo-de-trabalho.md §5). Também parados: os PRs do Dependabot #49–#53 (#49 sobe o ioredis para a versão principal 6 e precisa de teste); com o #54, as actions passam a vir num PR agrupado.


> 🔴 **Ordem dos Dependabot quando o CI voltar** ([teste local de 24/10](../relatorios/2026-10-24-dependabot-local.md)): **#72** (next 16.4.2, 2 críticas) → **#74** (multer/body-parser; logo em seguida, para o check de auditoria ficar verde) → #70+#71 → #52/#51 → #49 (ioredis 6: testar BullMQ com Redis real e ElastiCache ≥ 6; pedir `@dependabot rebase` depois do #72).
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

| Rodada 20.1: ✅ #65 R18–R21 (0041/0042) e S1 do #73 — **#65 APROVADO** em 23/10 | Maestro @Rocafa | 23/10/2026 | `eng/integracao-r19` |
| Rodada 20.2: ✅ #63 R17 (runbook + correção do fundador em dois passos, 0042) — **#63 APROVADO** em 23/10 | Maestro @Rocafa | 23/10/2026 | `eng/integracao-r19` |
| Rodada 20.3: ✅ observações da R10 do #58 — aprovado com ressalva (fmt corrigido) | Maestro @Rocafa | 23/10/2026 | PR #58 |
| Rodada 20.4: ✅ **agendador real dos jobs** (BullMQ, 7 jobs, 0043) — aprovado com ressalvas; R1/R2/R6 resolvidas. **Condição de merge do #73: os 3 testes com Redis real (`JOBS_REDIS_TESTE=1`) verdes no CI, saída anexada** | Maestro @Rocafa | 23/10/2026 | `eng/integracao-r19` |

| Rodada 21.1: ✅ jobs R3 no IaC (10 alarmes, DPO só retenção/revogação, canary do `/health/ready`) + trava de TLS no CI | Maestro @Rocafa | 23/10/2026 | PR #58 |
| Rodada 21.2: ✅ #63 O-R17c (0044) — **APROVADO** | Maestro @Rocafa | 23/10/2026 | `eng/integracao-r19` |
| Rodada 21.3: ✅ #67 N1–N3 (0045) + R4 (teste da corrida discriminante, vermelho sem a trava e verde com ela) | Maestro @Rocafa | 23/10/2026 | `eng/integracao-r19` |

| Rodada 22.1: ✅ **#66 R3/R9** (0046) + R3-a/R3-b — **importador APROVADO pelo código**; liga em produção quando IAM/KMS (Terraform), alarme `CHAVE_LOTE_PRESA`, R10 e 1º ciclo do agendador estiverem prontos | Maestro @Rocafa | 23/10/2026 | `eng/integracao-r19` |
| Rodada 22.2: ✅ #63 O-R17b/d/e (0047) — **APROVADO** | Maestro @Rocafa | 23/10/2026 | `eng/integracao-r19` |
| Rodada 22.3: ✅ importador R5, responsáveis (0048) — **APROVADO** | Maestro @Rocafa | 23/10/2026 | `eng/integracao-r19` |
| Rodada 22.4: ✅ IAM das chaves KMS no Terraform (b9eb6a5) | Maestro @Rocafa | 23/10/2026 | PR #58 |
| Rodada 23.1: ✅ varredura de testes instáveis (2 marcadores, 6+21 ordenações, 8 conexões) — rls 5× seguidas verde — **APROVADO** | Maestro @Rocafa | 23/10/2026 | `eng/integracao-r19` |
| Rodada 23.2: ✅ importador — chave `pending` antes de criar, órfã com alarme, NotFound = destruída, tipo do erro, timeout ambíguo fica para o job (0049) — **APROVADO** | Maestro @Rocafa | 23/10/2026 | `eng/integracao-r19` |
| Rodada 23.3: ✅ portal — titular que passa a menor revogado na correção e pelo job diário (0050) — **APROVADO** | Maestro @Rocafa | 23/10/2026 | `eng/integracao-r19` |

| Rodada 24.1: ✅ re-revisão dos vetos do front (#44 e #47 aprovados c/ ressalvas, #46 aprovado) | Maestro @Rocafa | 24/10/2026 | PRs #44/#46/#47 |
| Rodada 24.2: ✅ Dependabot testados localmente + **PR #74** (multer/body-parser) | Maestro @Rocafa | 24/10/2026 | PR #74 |
| Rodada 24.3: ✅ contrato **`ApiPortal`** em `packages/shared` + C1–C5 + documento obrigatório ao reduzir idade (0051/0052) — **adaptador HTTP do portal liberado** pelo Guardião | Maestro @Rocafa | 24/10/2026 | `eng/integracao-r19` |
| Rodada 25.1: ✅ **PR #75** — portal ligado ao backend real, empilhado sobre o #47 (aprovado c/ ressalvas, R1–R4 corrigidas); aguarda @Lopesloro aceitar/descartar | Maestro @Rocafa | 25/10/2026 | PR #75 |
| Rodada 25.2: ✅ ressalvas do portal (0053) — **APROVADO** | Maestro @Rocafa | 25/10/2026 | `eng/integracao-r19` |

| Rodada 26.1: ✅ ensaio local do merge completo (24 PRs; API 923, web 293, rls 605, audit limpo) + import duplicado do #75 corrigido | Maestro @Rocafa | 25/10/2026 | [relatório](../relatorios/2026-10-25-ensaio-de-merge.md) |
| Rodada 26.2: ✅ RELATORIO-GERAL até a rodada 25; #74 logo depois do #72 | Maestro @Rocafa | 25/10/2026 | main |
| Rodada 26.3: ✅ **PR #76** (pacientes/agenda alinhados ao backend r19+) — vetado e corrigido; **veto levantado**; R5/R6 feitas | Maestro @Rocafa | 25/10/2026 | PR #76 |

| Rodada 27.1: ✅ Guardião conferiu segredos no Terraform (#58) e cursor no front (#76) — aprovados c/ condições (C1-b XFF, V2-a/b/c, K-a/b/c) | Maestro @Rocafa | 26/10/2026 | PRs #58/#76 |
| Rodada 27.2: ✅ cursor v2 — R7/R8/R9 + V2-a/b (marca do nome com chave própria, escopo clínica+âncora; 8a5dee3); V2-c no ROPA (f5a2523) | Maestro @Rocafa | 26/10/2026 | `eng/integracao-r19` |
| Rodada 27.3: ✅ boot em produção com KMS real e pseudônimo — só a D4 impede a subida | Maestro @Rocafa | 26/10/2026 | `eng/integracao-r19` |
| Rodada 27.4: ✅ #58 — XFF append, R7 (logs do ALB), AWS_REGION, veto à cadeia de credenciais (K-a/b), contexto tenant_id no gestor e break-glass (K-c) (5dc085b, aaf2f32); **key policy das chaves por clínica aguarda decisão** | Maestro @Rocafa | 27/10/2026 | PR #58 |
| Rodada 27.5: ✅ Guardião: #58 **APROVADO** (apply após plano verde no CI), V2-a/b aprovados, R7 no ROPA (2f2c71c); **K-a1 bloqueia o merge do #73**; K-c2/K-c3 bloqueiam o piloto | Maestro @Rocafa | 27/10/2026 | PR #58 / `eng/integracao-r19` |
| Rodada 27.6: ✅ #76 — busca com checagem de sessão e aviso de truncamento acima de 1.000 (b43ab1e; web 232/232) | Maestro @Rocafa | 27/10/2026 | PR #76 |
| Rodada 27.7: ✅ API — K-a1 (lista de variáveis AWS igual à do Terraform), K-c2 (key policy com tenant_id literal no CreateKey), K-c3 unitário, K-c4 (cdf7152) — **K-a1 aprovado: bloqueio de merge do #73 levantado** | Maestro @Rocafa | 27/10/2026 | `eng/integracao-r19` |
| Rodada 27.8: ✅ #58 — R7-a, K-a2, K-c1 e registro da decisão K-c2 (6ba44ea, 96df2c9) — **APROVADO** (e320f95) | Maestro @Rocafa | 27/10/2026 | PR #58 |
| Rodada 27.9: ✅ antes do piloto — K-c4a (verificarChave só com GenerateMac) + trava das listas AWS (#73); F-1 marcar consulta com busca (#76); K-c5 alarmes de PutKeyPolicy/ScheduleKeyDeletion/DisableKey/CreateGrant (#58) — **APROVADOS** (c7c25e4) · [relatório](../relatorios/2026-10-27-rodada-27.md) | Maestro @Rocafa | 27/10/2026 | PRs #73/#76/#58 |

| Rodada 28.1: ✅ kit do primeiro dia do staging — roteiro + scripts das provas K-c3/K-c5 (d81d995) | Maestro @Rocafa | 27/10/2026 | PR #58 |
| Rodada 28.2: ✅ 2º ensaio do merge completo — 25 PRs, api 986, web 349, rls 618, E2E 223, audit limpo ([relatório](../relatorios/2026-10-27-ensaio-de-merge-2.md)); teste do adaptador web corrigido no #76 (f260a16) | Maestro @Rocafa | 27/10/2026 | main / PR #76 |
| Rodada 28.3: ✅ R4 na key policy por clínica — `HumanoNaoDecifra` (humano não decifra fora do break-glass), achado pelo kit do staging — API (15e3303) e Terraform (f4a679d, c2e0c77) — **APROVADO** (1f30a20) | Maestro @Rocafa | 27/10/2026 | `eng/integracao-r19` |
| Rodada 28.4: ✅ condições da evidência das provas (H3 pela sessão SSO, SHA da política e do commit, eventos da K-c5, evidência sem dado pessoal) + `kms:CreateGrant` no HumanoNaoDecifra (API e Terraform) — **APROVADO** (7ea09ec; condição 1 em c4eaf69) · [relatório](../relatorios/2026-10-27-rodada-28.md) | Maestro @Rocafa | 27/10/2026 | PRs #58/#73 |
| Rodada 29 (merges): ✅ repositório **público** → Actions de volta. Entraram com CI verde: #77, #52, #51, #43, #57, #61, #62, #63, #65, #78, #79, #56, #59, #73 (com #66–#69), #60, #58, #76, #83, #84, #81, #82. 4 defeitos que só o CI real mostrou, corrigidos (imagem, Trivy/OpenSSL, k6, infra) · [relatório](../relatorios/2026-10-27-rodada-29-merges.md). #49 (ioredis 6) entrou depois, com os testes de Redis real rodando (88/88). #85 (client-kms 3.1156.0, bullmq 6.4.2) também entrou. Pilha do front: proposta pronta no **#86** (rascunho, #44→#47 + #75 sobre a main, CI todo verde com E2E e RLS), aguardando o @Lopesloro decidir o `fake.ts`. **Proteção da `main` ligada** (28/10): PR obrigatório e 10 checks. **#88**: job diário `cpf-indice-reindexacao` (índice cego do CPF sem script manual), APROVADO pelo Guardião após a C1/C2. #54 fechado (incompatível com a proteção). **#89**: índice cego do CPF também nos responsáveis (0054), APROVADO após a C1. **#90**: CodeQL publica na aba Security (0 alertas na main) | Maestro @Rocafa | 27/10/2026 | main |

## Livre (pegue colocando seu nome)

| Item | Referência |
|---|---|
| **Antes do piloto (devops-ci, em staging):** K-c3 de integração (chave por clínica não abre sem contexto/outro tenant) e prova de disparo do alarme K-c5 | parecer #76, conferência K-c4a/F-1/K-c5 (27/10/2026) |
| **R10 do #66 (infra, dono devops-ci):** apagar `IMPORT_CPF_FP_KEY` do cofre e registrar o descarte — antes da 1ª importação real | parecer do importador, conferência 22/10/2026 |
| **Checklist do GA:** conferir na trilha de cada clínica que o job `cpf-indice-reindexacao` chegou a `pending = 0` em produção, nos pacientes e nos responsáveis (`table: 'guardians'`) | pareceres do #88 e #89 |
| Reportar o bug do postgres.js 3.4.9 | idem §3 |
| **R4 do parecer do apoiador (#109):** pai/mãe ou tutor confirmado para paciente maior fica só na trilha; se a data de nascimento for cadastrada depois e mostrar um adulto, criar pendência de revisão do vínculo | [parecer de 29/10](../03-seguranca-lgpd/revisoes/2026-10-29-apoiador.md) |
| **A1 (b)/(c) do #67:** escopo da informação ao responsável e pedido de sigilo do adolescente (bloqueia consumidor de `podeReceberInformacaoClinica`) | parecer do #67 (21/10) |

## Feito
| Item | Quem | Quando |
|---|---|---|
| Rodada 10 (sem CI): memo de recomendação da D4, kit de entrevistas (D1/D2), pacote para o advogado (D8) | Maestro @Rocafa | 13/10/2026 |
| @Lopesloro no CODEOWNERS (#48) | @Rocafa | 12/10/2026 |
| Relatório "o que falta" | @Rocafa | 12/10/2026 |
