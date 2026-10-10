# Relatório da Rodada 7: o que falta para o aplicativo ir para produção

**Data:** 10/10/2026 · **Responsável:** Maestro · **Agentes:** nenhum (pesquisa e escrita feitas direto, para economizar tokens)
**Pedido dos sócios:** "entender e contextualizar o contexto 6, extrair e maximizar, pesquisando todas as necessidades para a produção do aplicativo, e registrar tudo em relatório com commit".

**Como o pedido foi lido.** "Contexto 6" é a §6 do [CONTEXTO.md](../../CONTEXTO.md) (Tecnologia: o esqueleto existe, mas nada roda em produção). Ela foi cruzada com a §6.4 do [Relatório Geral](RELATORIO-GERAL.md), que lista o que os testes ainda não cobrem. O objetivo deste relatório é sair de "temos fundação" para "temos uma lista completa e ordenada do que precisa existir antes do primeiro paciente real". Ele reúne o que já estava espalhado no repositório e acrescenta uma pesquisa externa nova, com fontes, sobre regulação, fornecedores e custos.

**Legenda:** 🔴 bloqueia o piloto · 🟠 bloqueia o lançamento comercial (GA) · 🟡 pode vir depois · **[FATO]** tem fonte · **[ESTIMATIVA]** é cálculo nosso · ⚖️ precisa de advogado (D8)

---

## 1. Resumo executivo

1. **A §6 do CONTEXTO.md estava desatualizada.** Ela dizia que o código "ainda não foi executado". Hoje a API, o banco com isolamento por clínica, a garantia de saída e 9 checks de CI rodam e estão verdes na `main` (PRs #7 a #13). O texto foi corrigido nesta rodada. **Continua valendo:** não existe nenhum ambiente na AWS, nenhuma tela de negócio e nenhum login.
2. **A pesquisa encontrou 4 mudanças regulatórias de 2026 que o plano ainda não previa:**
   - **Receita de controle especial digital (Anvisa RDC 1.000/2025).** Só vale se for emitida por um sistema integrado ao **SNCR**, o novo sistema nacional da Anvisa, via API. O prazo de operação foi adiado para **30/09/2026**, com transição até cerca de 29/10/2026. [FATO]
   - **Plataformas de prescrição precisam ser inscritas no CRM** da jurisdição (Res. CFM 2.299/2021, art. 5º). Documentos médicos digitais exigem ICP-Brasil **NGS2**. [FATO]
   - **Resolução CFM 2.454/2026 sobre IA** está **em vigor desde cerca de agosto de 2026** (publicada em 27/02/2026, com prazo de 180 dias). [FATO]
   - **ANPD virou agência reguladora** pela Lei 15.352/2026. O prazo de 3 dias úteis para comunicar incidente (Res. 15/2024) continua valendo. [FATO]
3. **Infraestrutura de produção é a maior lacuna técnica.** Faltam o Terraform, as contas AWS, o RDS Multi-AZ, o CD, os segredos, a observabilidade e o backup testado na nuvem. Isso é o pré-requisito **P7** do plano de piloto. Custo estimado de staging + produção no MVP: **cerca de US$ 750 a 1.050 por mês de AWS, ou US$ 800 a 1.200 somando as ferramentas** [ESTIMATIVA, §6].
4. **Os 5 bloqueios do piloto, em ordem:** D4 (autenticação) → infraestrutura AWS (P7) → M0 completo (RBAC, MFA, criptografia de campo, auditoria) → advogado (D8: DPA, RIPD, CRM, termos) → pentest externo (P2).

---

## 2. Estado real hoje (corrige a §6 do CONTEXTO.md)

| Camada | Existe e está testado | Não existe |
|---|---|---|
| Código | API NestJS (`/health`, `/health/ready`, contexto de clínica), migrações 0001–0003 com RLS forçado, garantia de saída com `audit_log` append-only, helmet, CORS, limite de corpo, rate limit e encerramento gracioso | Login, RBAC, MFA, criptografia de campo, todos os módulos de negócio (`apps/api/src/modules/*` estão vazios) |
| Web | Next.js com página "em construção" e teste de cabeçalhos de segurança | Qualquer tela |
| CI | gitleaks, lint/typecheck/test, RLS, `pnpm audit`, CodeQL, testes ofensivos, ZAP, resiliência, backup/restore e k6 | Proteção da `main` (exige plano pago), CD, Trivy de imagem |
| Infra | `docker-compose` local (Postgres 16 + Redis 7) | `infra/` só tem `local/`. Não há Terraform, conta AWS nem domínio |
| Dependências | TS 6.0.3, actions novas (rodada 6) | 13 PRs do Dependabot abertos (#14–#26), entre eles **NestJS 12**, **Vitest 5** e **ESLint 10**, que são versões principais novas e precisam ser testadas uma a uma |

Pendências técnicas herdadas da §6.4 do Relatório Geral, conferidas no código em 10/10/2026:

| Pendência | Situação conferida | Prioridade |
|---|---|---|
| `node dist/main.js` não sobe porque `packages/shared` exporta `.ts` cru (`"main": "./src/index.ts"`) | Confirmado em `packages/shared/package.json` | 🔴 Precisa ser resolvido antes do primeiro deploy. Opções: compilar o `shared` (`tsc` para `dist/` com `exports` condicionais) ou empacotar a API com `tsup`/`esbuild` |
| Rate limit em memória, por instância | Confirmado em `apps/api/src/security/http-security.ts` | 🟠 Migrar para Redis quando houver mais de uma instância (em produção serão no mínimo 2) |
| Erro 25006 (banco em modo somente leitura) vira 500 | Nenhum tratamento encontrado em `apps/api/src` | 🟠 Mapear para 503. Acontece durante o failover do RDS Multi-AZ |
| Patch do postgres.js 3.4.9 | A 3.4.9 (05/04/2026) **continua sendo a última versão publicada** | 🟠 Abrir a issue no `porsager/postgres` e manter o patch. Não há correção upstream |
| Réplica de leitura incompatível com a trava de clínica | Sem mudança | 🟡 Só quando houver réplica |
| Execução de SQL com várias instruções | Sem mudança; a defesa é a consulta parametrizada | 🟡 Proibir no lint (sem `sql.unsafe` fora das migrações) |

---

## 3. Necessidades regulatórias e jurídicas (pesquisa nova)

| # | Obrigação | O que exige do produto | Quando | Fonte |
|---|---|---|---|---|
| R1 | **LGPD + Lei 15.352/2026** (ANPD agora é agência reguladora) | Encarregado (DPO) nomeado. Dado de saúde é sensível, então não contar com o regime simplificado de agente de pequeno porte ⚖️. Canal do titular, ROPA, RIPD | 🔴 Piloto | Res. CD/ANPD 18/2024; Res. 2/2022; Lei 15.352/2026 |
| R2 | **Comunicação de incidente em 3 dias úteis** (comunicado complementar em até 20 dias úteis); registro de incidentes guardado por 5 anos | Plano de incidentes (LGP-03.4) com *tabletop* (P3), detecção e registro | 🔴 Piloto | Res. CD/ANPD 15/2024 |
| R3 | **Prontuário: guarda mínima de 20 anos** a partir do último registro (Lei 13.787/2018). Registros de **psicologia: mínimo de 5 anos** (Res. CFP 001/2009) | Política de retenção **por tipo de registro e por conselho**. Isso afeta a eliminação certificada da garantia de saída (EXP-01.6) e a D7 ⚖️ | 🔴 Antes de eliminar qualquer dado | Lei 13.787/2018; CFP |
| R4 | **Certificação SBIS S-RES, nível NGS2** (manual vigente 5.2). É o que permite prontuário 100% digital sem papel | Planejar os requisitos do manual SBIS desde o M0 (auditoria, assinatura, carimbo de tempo). Certificar em seguida | 🟠 GA (diferencial de venda; sem ela a clínica precisa guardar papel) | SBIS; Res. CFM 1.821/2007 |
| R5 | **Documentos médicos digitais com ICP-Brasil NGS2**, validáveis no ITI | Fluxo de assinatura em nuvem (BirdID, VIDaaS etc.) já previsto em `integracoes.md` §4 | 🟠 M3 | Res. CFM 2.299/2021, art. 4º |
| R6 | **Plataforma de prescrição inscrita no CRM** da jurisdição | Inscrever a empresa no CRM, o que provavelmente exige um médico responsável técnico ⚖️, ou delegar a prescrição a um parceiro já inscrito (Memed) | 🟠 Antes de prescrição nativa | Res. CFM 2.299/2021, art. 5º |
| R7 | **Receita de controle especial e de retenção (antimicrobianos, canetas GLP-1) só vale se emitida por serviço integrado ao SNCR via API** | Decisão nova **D10**: integrar ao SNCR ou usar parceiro integrado. Sem isso, a receita controlada da plataforma **não tem validade** | 🟠 M3, para nichos com médico | Anvisa RDC 1.000/2025; CFF |
| R8 | **IA na medicina (CFM 2.454/2026, em vigor)**: decisão clínica humana, proibido delegar à IA a comunicação de diagnóstico ou conduta | O escriba entrega "rascunho para revisar e assinar"; guardar registro de revisão humana; paciente pode recusar | 🔴 Antes de qualquer IA com médico | CFM 2.454/2026 |
| R9 | **Anvisa RDC 657/2022 (software como dispositivo médico)**: software com finalidade médica pode precisar de notificação ou registro; uma revisão com regras específicas para IA está em andamento | Manter a IA **fora** de finalidade diagnóstica (sem sugerir CID automaticamente no MVP) até haver parecer ⚖️ | 🔴 Antes da sugestão de CID | Anvisa; Mattos Filho |
| R10 | **PL 2.338/2023 (lei de IA)** está na Câmara, em comissão especial; não há confirmação de votação | Monitorar; a arquitetura de governança de IA já prevista em `05-ia-llm/` deve bastar | 🟡 | Senado/Câmara |
| R11 | **NFS-e no padrão nacional, obrigatório desde 01/01/2026**, com grupo **IBS/CBS** na DPS (NT 003/2025). São Paulo, Barueri e Salvador mantêm sistema próprio com layout adaptado | O provedor de NFS-e escolhido precisa suportar o layout com IBS/CBS e os municípios fora do emissor nacional | 🟠 Financeiro | LC 214/2025; EY |
| R12 | **Receita Saúde** (profissional pessoa física): recibo eletrônico obrigatório desde 01/01/2025. A Receita aceita **arquivo de integração para emissão em lote** gerado por software de consultório (manual v2.1, perguntas 24 e 25) | Funcionalidade de exportar o arquivo de lote. É argumento forte de venda para psicólogos e fisioterapeutas autônomos (nicho D1) | 🟠 M1/M2 | Receita Federal via Fenacon/CRC-SP |
| R13 | **TISS 04.03.00 obrigatória desde 01/07/2026** (substitui a 04.02.00); o Componente Organizacional teve versões até 09/2026 | O gerador TISS (Fase 2) já deve nascer na 04.03.00 e permitir trocar a versão | 🟡 Fase 2 | ANS; Unimed |
| R14 | **Teleconsulta** (Lei 14.510/2022, CFM 2.314/2022) | Já previsto em `integracoes.md` §6 | 🟡 Fase 2 | — |
| R15 | **CDC: oferta e publicidade** (garantias G1–G9 não podem prometer o que o código não cumpre) | Carta só é publicada depois da D8 | 🟠 GA | CDC art. 37 |

---

## 4. Infraestrutura de produção (P7): o que precisa ser construído

Tudo já está desenhado em [ambientes-e-devops.md](../04-arquitetura/ambientes-e-devops.md) e [seguranca-na-arquitetura.md](../04-arquitetura/seguranca-na-arquitetura.md). Falta executar. Lista na ordem de construção:

| # | Item | Detalhe | Prioridade |
|---|---|---|---|
| I1 | **AWS Organizations** com contas `staging` e `prod` separadas, SSO com MFA, CloudTrail organizacional e GuardDuty | Acesso humano à produção só *just-in-time* | 🔴 |
| I2 | **Terraform em `infra/`** (rede, RDS, ECS, ElastiCache, S3, KMS, WAF) com plano revisado em PR e estado remoto cifrado | Nenhuma mudança manual no console | 🔴 |
| I3 | **VPC sa-east-1 com 2 ou 3 AZs**, sub-redes privadas para app e banco, VPC endpoints (S3, ECR, Secrets Manager, KMS) para reduzir o custo de NAT | — | 🔴 |
| I4 | **RDS PostgreSQL 16 Multi-AZ**, cifrado com KMS, PITR ligado, `rds.force_ssl`, papéis `app_user` e `app_migrator` e **repetir o `REVOKE TEMPORARY`** (achado da rodada 5) | Testar failover de verdade e mapear o erro 25006 para 503 | 🔴 |
| I5 | **ECS Fargate** com 3 serviços (api, web, worker), no mínimo 2 tarefas por serviço em AZs diferentes, ALB com TLS (ACM) e **AWS WAF** | Health check em `/health` e readiness em `/health/ready` (já fora do rate limit) | 🔴 |
| I6 | **ElastiCache Redis** (BullMQ + rate limit distribuído) | Cifrado em trânsito e em repouso | 🔴 |
| I7 | **S3** privado com SSE-KMS, *block public access*, versionamento e *Object Lock* para exportações e documentos assinados | URLs pré-assinadas curtas | 🔴 |
| I8 | **Secrets Manager** + **KMS** com chave por ambiente e envelope de chave por clínica (DEK) | Nada em `.env` de produção | 🔴 |
| I9 | **CD**: `deploy-staging.yml` (build → ECR → Trivy → migração → deploy → smoke) e `deploy-prod.yml` (promove a mesma imagem por SHA, com aprovação de sócio no *environment*), autenticação GitHub → AWS por **OIDC** | Rollback automático | 🔴 |
| I10 | **Build de produção da API** (resolver o `packages/shared` em `.ts`) e imagem Docker *distroless* sem root | Ver §2 | 🔴 |
| I11 | **Backup e DR**: snapshot diário + PITR com 35 dias, cópia cifrada para outra região **só se a D8 aprovar** (dado de saúde fora de sa-east-1 é transferência que precisa de análise) e **restauração testada todo mês** | O CI já testa `pg_dump`/`pg_restore`; falta o teste com o RDS | 🔴 |
| I12 | **Observabilidade sem dado de saúde**: logs estruturados (CloudWatch ou Grafana), traces com OpenTelemetry, Sentry com remoção de PII, alarmes de 5xx, latência, conexões e espaço em disco | Ninguém de plantão sem alerta | 🔴 |
| I13 | **Domínio, DNS (Route 53), e-mail transacional** com SPF, DKIM e DMARC | Necessário para o login e para "não fui eu" | 🔴 |
| I14 | **Status page pública** e **uptime externo** (garantia G da D9) | — | 🟠 |
| I15 | **Proteção da `main`** (plano GitHub Team, cerca de US$ 4 por usuário por mês) | Hoje o CI vermelho não impede merge (risco 9 do Relatório Geral) | 🟠 Antes do primeiro deploy automático em produção |

---

## 5. Engenharia de produto: o mínimo para o piloto (M0 + M1)

Já está no [backlog do MVP](../02-produto/backlog-mvp.md). Aqui fica só a ordem que destrava produção:

1. **D4: autenticação.** A pesquisa confirma as três opções viáveis com dados no Brasil: **Keycloak** (TOTP e WebAuthn nativos, multi-tenant por *realm*, extensões em Java), **Zitadel** (feito para SaaS B2B com organizações) e **módulo próprio em TypeScript** (Better Auth ou equivalente; checar suporte a passkey). **Recomendação:** Keycloak ou Zitadel hospedado em sa-east-1, porque login, MFA e recuperação de conta são o tipo de código que não vale escrever do zero em produto com dado de saúde. A decisão continua sendo dos sócios.
2. **RBAC + MFA obrigatório** para perfis clínicos e para a exportação (G2 e risco 7).
3. **Criptografia de campo** (KMS + DEK por clínica) nos campos marcados em [modelo-de-dados.md](../04-arquitetura/modelo-de-dados.md).
4. **Auditoria completa com encadeamento de hash** (requisito também do manual SBIS).
5. **Rota HTTP de exportação** com os controles anti-exfiltração.
6. **Pacientes, agenda e prontuário por nicho** (M1), cada tabela nova entrando no teste de RLS.
7. **Arquivo de lote do Receita Saúde** (R12): é barato de fazer e vende para o nicho D1.
8. **E2E com Playwright** do login à evolução no prontuário, rodando no CI contra staging.

---

## 6. Custo mensal de infraestrutura (MVP) [ESTIMATIVA]

Base: o RDS `db.t4g.medium` custa **cerca de US$ 100 por mês em sa-east-1 contra US$ 47 em us-east-1** [FATO, Bytebase], ou seja, São Paulo sai cerca de 2,1 vezes mais caro. Para os itens sem preço regional encontrado, aplicamos o fator de 1,5 a 2,1 sobre us-east-1. **Confirmar na AWS Pricing Calculator antes de aprovar o orçamento.**

| Item (produção) | Dimensionamento | US$/mês |
|---|---|---|
| RDS PostgreSQL Multi-AZ | `db.t4g.medium` × 2 + 100 GB gp3 + backup | 230–260 |
| ECS Fargate | api 2× (0,5 vCPU/1 GB), web 2×, worker 1× | 120–180 |
| ALB + WAF | 1 ALB, regras gerenciadas | 50–70 |
| ElastiCache Redis | `cache.t4g.small` com réplica | 50–70 |
| NAT / VPC endpoints | 1 NAT + endpoints | 60–110 |
| S3, KMS, Secrets, CloudWatch, GuardDuty, Route 53 | volume de piloto | 60–100 |
| **Subtotal produção** | | **570–790** |
| Staging (single-AZ, 1 tarefa por serviço) | | 180–260 |
| **Total AWS** | | **~750–1.050** |
| Ferramentas | GitHub Team, Sentry, status page, e-mail | 50–150 |

Fora da AWS (custos de projeto, não mensais):
- **Pentest externo (P2):** US$ 5.000 a 30.000 para aplicação web + API + nuvem em SaaS multi-tenant; fornecedores com atuação no Brasil: DeepStrike, Blaze, eSecurity, DM11, Resh. **Pedir proposta em reais.** Desconfiar de "pentest" barato e rápido, que costuma ser só um scanner automático [FATO, guias de preço de 2026].
- **Certificação SBIS:** pedir orçamento à SBIS (não encontramos preço público).
- **Advogado (D8)** e **DPO terceirizado:** pedir proposta.

---

## 7. Integrações: o que mudou na pesquisa

| Integração | Novidade de 2026 | Efeito no plano |
|---|---|---|
| **WhatsApp Cloud API** | A Meta passou a cobrar em **reais** para contas brasileiras desde 01/07/2026. A partir de **01/10/2026**, *template* de utilidade enviado com a janela de 24 h aberta **passa a ser cobrado** (antes era grátis). A Meta pode reclassificar *template* de utilidade como marketing, que é mais caro | Recalcular o custo do lembrete por consulta antes de fechar o preço (D2), já que o WhatsApp está incluso no plano |
| **Gemini (Vertex AI) em São Paulo** | Gemini 2.5 Flash, Pro e Flash-Lite aparecem em `southamerica-east1`. **Atenção:** estar listado na região não garante que o processamento aconteça lá; é preciso usar o *endpoint* regional (nunca o global) e conferir a tabela de *data residency* por funcionalidade | Já atende a D3 em tese; o contrato e a tabela de capacidades precisam ser conferidos antes do piloto (P6) |
| **Memed / prescrição** | O SNCR torna obrigatória a integração para receitas controladas | Perguntar à Memed se ela já está integrada ao SNCR. Se estiver, ela resolve R6 e R7 no MVP |
| **NFS-e** | Padrão nacional com IBS/CBS | Escolher o provedor (Focus, eNotas, PlugNotas, NFE.io) pelo suporte ao layout novo |
| **TISS** | Versão 04.03.00 | Fase 2 já começa nela |

---

## 8. Checklist de go-live (ordem dos portões)

**Portão A, antes do primeiro deploy em staging:** I1–I3, I8, I10, CD de staging (I9) e domínio (I13).

**Portão B, antes do piloto com dado real** (soma P1–P7 do [plano de piloto](../02-produto/plano-piloto.md) com o que esta pesquisa trouxe):
- [ ] D4 decidida, com login, RBAC e MFA em produção
- [ ] Infra I1–I13 em produção, com **failover e restauração testados no RDS**
- [ ] Erro 25006 → 503 e rate limit em Redis
- [ ] Criptografia de campo e auditoria com hash
- [ ] Encarregado (DPO) nomeado e canal do titular publicado (R1)
- [ ] RIPD do produto e do piloto assinados (P1); plano de incidentes testado (P3, R2)
- [ ] DPA e termo de piloto validados pelo advogado (P4, P5)
- [ ] Política de retenção por conselho definida (R3, D7)
- [ ] Pentest externo sem achado crítico ou alto aberto (P2)
- [ ] IA desligada **ou** com revisão humana registrada (R8) e provedor no Brasil (P6)

**Portão C, antes do lançamento comercial (GA):** R4 (SBIS) em andamento, R5–R7 resolvidos para os nichos com médico, R11–R12 no financeiro, I14–I15, Carta de Compromissos publicada (D9), status page.

---

## 9. Decisões novas para os sócios

Adicionadas ao [registro de decisões](../00-governanca/decisoes.md):

| # | Decisão | Recomendação |
|---|---|---|
| **D10** | Receita controlada (SNCR) | No MVP, usar parceiro já integrado ao SNCR (confirmar com a Memed) em vez de integrar direto |
| **D11** | Inscrição no CRM como plataforma de prescrição | Só inscrever se formos ter prescrição nativa; até lá, delegar ao parceiro. Validar com o advogado ⚖️ |
| **D12** | Certificação SBIS S-RES NGS2 | Desenhar o M0 já seguindo o manual 5.2; certificar depois do GA |
| **D13** | Orçamento de infraestrutura e pentest | Aprovar cerca de US$ 1.000 por mês de nuvem e reservar US$ 5.000 a 30.000 para o pentest |

---

## 10. Próximos passos (rodada 8, até 3 agentes)

- **Sócios:** decidir D4 e D13; contratar o advogado (D8); perguntar à Memed sobre o SNCR (D10); pedir 2 ou 3 propostas de pentest em reais.
- **`devops-ci`:** criar `infra/` com Terraform (I1–I8) para staging; workflow `deploy-staging.yml` com OIDC; testar os PRs grandes do Dependabot (NestJS 12, Vitest 5, ESLint 10) um por vez, como na rodada 6.
- **`engenharia`:** build de produção da API (I10), 25006 → 503, rate limit em Redis, issue no `porsager/postgres`; depois da D4, login + RBAC + MFA.
- **`guardiao-lgpd`:** política de retenção por conselho (R3), nomeação do DPO (R1), começar o RIPD do produto.

---

## 11. Ponto de retomada

Se a sessão acabar no meio da próxima rodada, retomar a partir daqui: este relatório, a §6 corrigida do CONTEXTO.md e as decisões D10–D13 estão no branch `pesquisa/necessidades-producao`. Nada de código foi alterado nesta rodada.

---

## 12. Fontes (consultadas em 10/10/2026)

- Anvisa RDC 1.000/2025 e SNCR: [CFF, 10/12/2025](https://site.cff.org.br/noticia/Noticias-gerais/10/12/2025/anvisa-aprova-nova-rdc-que-regulamenta-o-receituario-eletronico-de-medicamentos-controlados) · [CFF, 21/05/2026](https://site.cff.org.br/noticia/Noticias-gerais/21/05/2026/sncr-o-que-muda-para-farmacias-e-drogarias-com-o-novo-sistema-de-controle-de-receitas) · [Afya, adiamento](https://portal.afya.com.br/saude/anvisa-adia-implementacao-nacional-de-receituarios-eletronicos-controlados) · [Bip, prazo de setembro](https://www.usebip.com/blogs/bip-insights/prescricao-eletronica-2026-prazo-do-sncr-muda-para-setembro) · [ACBr, API do SNCR](https://www.projetoacbr.com.br/forum/topic/93263-nova-api-sncr-sistema-nacional-de-controle-de-receitu%C3%A1rio-anvisa/)
- CFM 2.454/2026 (IA): [Mattos Filho](https://www.mattosfilho.com.br/unico/cfm-ia-medicina/) · [Demarest](https://www.demarest.com.br/cfm-publica-resolucao-que-regulamenta-o-uso-de-inteligencia-artificial-na-medicina/) · [Cescon Barrieu](https://cesconbarrieu.com.br/resolucao-cfm-no-2-454-2026-regulamenta-o-uso-de-inteligencia-artificial-na-medicina/)
- CFM 2.299/2021 (documentos digitais, NGS2, inscrição no CRM): [texto no DOU](https://ses.sp.bvs.br/wp-content/uploads/2021/10/U_RS-CFM-2299_300921.pdf) · [Mattos Filho](https://www.mattosfilho.com.br/unico/cfm-emissao-documentos-eletronicos/)
- SBIS S-RES: [certificado com manual 5.2/NGS2](https://sbis.org.br/certificacao/certificados/5_2/Certificado_SBIS_SRES_141-TISAUDE.pdf) · [certificado de 08/2026](https://sbis.org.br/wp-content/uploads/2026/08/Certificado_SBIS_SRES_203_PRONTU.pdf)
- Anvisa RDC 657/2022 (SaMD) e IA: [Mattos Filho](https://www.mattosfilho.com.br/unico/inteligencia-artificial-dispositivos-medicos/) · [Machado Meyer, Regulação da Saúde Digital 2026](https://www.machadomeyer.com.br/images/ebooks/Regulacao_saude_Digital_2026.pdf) · [Câmara, apresentação da Anvisa](https://www2.camara.leg.br/atividade-legislativa/comissoes/comissoes-permanentes/cssf/apresentacoes-em-eventos/eventos-2025/05-08-2025-audiencia-publica-regulacao-da-inteligencia-artificial-no-setor-saude-beneficios-e-riscos-1/apresentacao-anvisa/view)
- ANPD agência (Lei 15.352/2026): [Teletime](https://teletime.com.br/24/02/2026/senado-aprova-mp-que-transforma-a-anpd-em-agencia/) · [Relatório anual da ANPD 2025](https://www2.camara.leg.br/atividade-legislativa/comissoes/comissoes-permanentes/cffc/expedientes-recebidos/RelatorioAnualANPD2025.pdf)
- Incidentes (Res. 15/2024): [KLA](https://klalaw.com.br/anpd-aprova-regulamento-comunicacao-incidente-seguranca/) · [gov.br, apresentação de 30/04/2025](https://www.gov.br/governodigital/pt-br/privacidade-e-seguranca/centro-de-excelencia-em-privacidade-e-seguranca/webnario/apresentacaocis-30abr2025-_final.pdf/@@download/file)
- Encarregado (Res. 18/2024): [texto](https://www.tjba.jus.br/extrajudicial/wp-content/uploads/2024/08/RESOLUCAO-ANPD-No-18-Encarregado-de-Dados.pdf) · [Lefosse, agentes de pequeno porte](https://lefosse.com/noticias/alerta/anpd-publica-regulamento-que-flexibiliza-a-aplicacao-da-lgpd-a-microempresas-empresas-de-pequeno-porte-startups-e-associacoes-sem-fins-lucrativos/)
- Guarda de prontuário: [CFP, FAQ de guarda e descarte](https://site.cfp.org.br/faq/como-devo-fazer-guarda-e-descarte-de-documentos-utilizados-no-atendimento/) · [SES-SP, tabela de temporalidade](https://www.saude.sp.gov.br/resources/ses/perfil/profissional-da-saude/homepage/cada/ttd_fim_saude_atualizacao_final_apesp_ttd.pdf)
- NFS-e nacional e IBS/CBS: [EY, layouts da NFS-e 2026](https://www.ey.com/content/dam/ey-unified-site/ey-com/pt-br/campaigns/reforma-tributaria/documents/ey-serie-reforma-tributaria-layouts-da-nfs-e-2026.pdf) · [Barbieri Advogados](https://www.barbieriadvogados.com/nfs-e-nacional-a-padronizacao-que-comporta-divergencias/)
- Receita Saúde: [Fenacon, emissão em lote](https://fenacon.org.br/noticias/disponibilizada-nova-funcionalidade-para-emissao-em-lote-de-recibos-do-receita-saude/) · [CRC-SP](https://online.crcsp.org.br/portal/noticias/noticia.asp?c=10027) · [Fenacon, prazo de 2025](https://fenacon.org.br/noticias/profissionais-de-saude-devem-regularizar-recibos-eletronicos-de-2025-ate-fevereiro-de-2026/)
- TISS: [Unimed, informativo 04/2026](https://www.unimed.coop.br/site/web/planaltomedio/informativo-tiss-n-04-2026) · [ANS, Componente Organizacional 09/2026](https://www.gov.br/ans/pt-br/assuntos/prestadores/padrao-para-troca-de-informacao-de-saude-suplementar-2013-tiss/PadroTISS_ComponenteOrganizacional_202609.pdf)
- PL 2.338/2023: [Senado](https://www25.senado.leg.br/web/atividade/materias/-/materia/157233)
- WhatsApp: [Meta, preços](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing) · [Zenvia, regras de cobrança](https://zenvia.movidesk.com/kb/en/article/600343/frequently-asked-questions-new-whatsapp-business-pricing-rules-2)
- Vertex AI em São Paulo: [locais](https://cloud.google.com/vertex-ai/generative-ai/docs/learn/locations-genai) · [data residency](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/data-residency)
- Autenticação: [Authgear, MFA open source 2026](https://www.authgear.com/post/top-open-source-mfa-solutions-for-enterprise-applications-2026/) · [Keycloak vs Ory](https://guptadeepak.com/compare/keycloak-vs-ory/) · [Skycloak](https://skycloak.io/blog/auth0-alternatives-open-source-managed/)
- Custos AWS: [Bytebase, db.t4g.medium por região](https://www.bytebase.com/dbcost/rds/instance/db.t4g.medium/) · [AWS, preços do RDS](https://aws.amazon.com/rds/postgresql/pricing) · [AWS, preços do ECS](https://aws.amazon.com/ecs/pricing/)
- Pentest: [Blaze, preços 2026](https://www.blazeinfosec.com/post/how-much-does-penetration-testing-cost/) · [DeepStrike, empresas no Brasil](https://deepstrike.io/blog/penetration-testing-companies-brazil) · [Startup Defense](https://www.startupdefense.io/pt-br/blog/quanto-custa-um-pentest)
- postgres.js: `gh release list -R porsager/postgres` (última versão: v3.4.9, de 05/04/2026)
