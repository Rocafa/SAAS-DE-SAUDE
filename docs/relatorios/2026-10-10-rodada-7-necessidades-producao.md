# Relatório da Rodada 7: tudo o que falta para colocar o aplicativo em produção

**Data:** 10/10/2026 · **Responsável:** Maestro · **Agentes:** nenhum (feito direto, sem subagentes)
**Pedido dos sócios:** "entender e contextualizar o contexto 6 (§6 do CONTEXTO.md, Tecnologia), extrair e maximizar, pesquisando todas as necessidades para a produção do aplicativo, e registrar tudo em um relatório".
**Base:** leitura do repositório (`main` em `9bf134f`) + pesquisa web feita em 10/10/2026. Cada fato externo tem fonte e está marcado como **FATO** (fonte oficial ou várias fontes concordando), **A CONFIRMAR** (fonte única, comercial ou desatualizada) ou **ESTIMATIVA**. ⚖️ = precisa de advogado (D8).

> **Consolidação.** Duas sessões fizeram esta pesquisa em paralelo e geraram dois relatórios (`...-necessidades-producao.md` e `...-necessidades-de-producao.md`). Este arquivo junta os dois, sem perder nenhuma fonte; o segundo arquivo foi removido.

> **Resumo em 6 linhas**
> 1. O código hoje é **fundação**: isolamento por clínica, garantia de saída e testes de ataque/resiliência, com 9 checks verdes. **Nenhuma tela ou rota de negócio existe**: `auth`, `patients`, `records`, `scheduling`, `billing`, `prescriptions` e `audit` são arquivos de 3 linhas, e o site é uma página de 11 linhas. (A §6 do CONTEXTO.md dizia que o código "ainda não foi executado"; isso estava desatualizado e foi corrigido.)
> 2. **Não existe infraestrutura de produção.** Não há conta AWS, Terraform, domínio, e-mail transacional, observabilidade nem status page. ESTIMATIVA de custo: **US$ 750 a 1.050 por mês de AWS** (staging + produção), ou US$ 800 a 1.200 somando as ferramentas (§4).
> 3. A pesquisa achou **mudanças externas** que os documentos ainda não refletem: SNCR da Anvisa (receita controlada), inscrição de plataforma de prescrição no CRM, CFM 2.454/2026 já em vigor, ANPD como agência (Lei 15.352/2026), Receita Saúde com arquivo de lote, NFS-e com IBS/CBS, TISS 04.03.00, cobrança do WhatsApp em reais e o fato de que **Claude no Bedrock em São Paulo não fica no Brasil**. Ver §3.
> 4. Para o **piloto com dado real** faltam os itens P0 da §2. Os bloqueios de verdade são três decisões dos sócios: **D4 (login)**, **D8 (advogado)** e **D1 (nicho)**.
> 5. O checklist em portões (staging → piloto → lançamento) está na §5; as decisões novas D10–D14, na §6.
> 6. A ordem recomendada está na §9, com no máximo 3 agentes por rodada (regra do `AGENTS.md`).

---

## 1. Onde estamos de verdade (fatos do repositório)

| Área | Existe | Não existe |
|---|---|---|
| API (NestJS) | Bootstrap, health (`/health`, `/health/ready`), borda HTTP endurecida (helmet, CORS, limite de corpo, rate limit, erros genéricos), `withTenant` + RLS forçado, módulo de exportação (G1–G3), `audit_log` append-only, 3 migrations, encerramento gracioso | Login, sessão, RBAC, MFA, qualquer CRUD de paciente, agenda, prontuário, financeiro, receita |
| Web (Next.js) | `layout.tsx` + `page.tsx` (11 linhas) e teste de cabeçalhos de segurança | Telas do profissional, portal do paciente, PWA |
| Banco | Postgres 16 local, papéis de app/migração, isolamento testado | RDS, PITR, réplica, criptografia de campo, chaves no KMS |
| Filas | Redis local no compose | BullMQ configurado, workers, dead-letter |
| CI | 4 workflows verdes (CI, Segurança com ZAP, Testes de produção, CodeQL); Dependabot | Deploy (CD), proteção da `main`, ambientes `staging`/`prod`, Trivy de imagem |
| Infra | `infra/local/postgres-init.sh` | Terraform, contas AWS, VPC, WAF, Secrets Manager, domínio, TLS, CDN |
| Dependências | TS 6.0.3, actions novas (rodada 6) | 13 PRs do Dependabot abertos (#14–#26), entre eles NestJS 12, ESLint 10 e Vitest 5 (versões principais, testar uma a uma) |

**Pendências técnicas da §6.4 do Relatório Geral, conferidas no código em 10/10/2026:**

| Pendência | Situação conferida | Prioridade |
|---|---|---|
| `node dist/main.js` não sobe porque `packages/shared` exporta `.ts` cru (`"main": "./src/index.ts"`) | Confirmado em `packages/shared/package.json` | P0: sem isso não há deploy. Opções: compilar o `shared` para `dist/` ou empacotar a API |
| Rate limit em memória, por instância | Confirmado em `apps/api/src/security/http-security.ts` | P0: em produção haverá no mínimo 2 instâncias |
| Erro 25006 (banco somente leitura) vira 500 | Nenhum tratamento em `apps/api/src` | P1: acontece no failover do RDS Multi-AZ |
| Patch do postgres.js 3.4.9 | A 3.4.9 (05/04/2026) **continua sendo a última versão publicada** (`gh release list -R porsager/postgres`) | P1: manter o patch e reportar o bug |
| Réplica de leitura incompatível com a trava de clínica | Sem mudança | P2: só quando houver réplica |
| SQL com várias instruções | Sem mudança; a defesa é a consulta parametrizada | P2: proibir `sql.unsafe` fora das migrações no lint |

Conclusão: o MVP previsto para nov/2026–jun/2027 ([roadmap](../02-produto/roadmap.md)) ainda não começou o M0. **Este relatório é o checklist do que precisa existir entre hoje e o primeiro paciente real.**

---

## 2. Checklist de produção

**Legenda de prioridade:**
- **P0:** bloqueia o piloto com dado real (30 clínicas, [plano-piloto](../02-produto/plano-piloto.md)).
- **P1:** bloqueia a venda aberta (lançamento).
- **P2:** pode vir depois do lançamento.

### 2.1 Jurídico, regulatório e empresa

| # | Item | Prio | Estado | Dono | Observação |
|---|---|---|---|---|---|
| J1 | **Advogado de saúde + LGPD contratado (D8)** | P0 | ❌ | Sócios | Destrava J2–J7 e J13–J15. É o item que mais trava o piloto |
| J2 | Contrato SaaS + **DPA (contrato de operador)** + política de suboperadores | P0 | ❌ | Advogado + Guardião | Lista de suboperadores: AWS, WhatsApp/BSP, gateway Pix, NFS-e, PSC ICP-Brasil, provedor de LLM, e-mail, Sentry |
| J3 | **RIPD do produto** (modelo já existe em [RIPD-modelo.md](../03-seguranca-lgpd/RIPD-modelo.md)) | P0 | 📋 | Guardião | Tratamento de alto risco: o regime simplificado de pequeno porte não se aplica ⚖️ |
| J4 | **Encarregado (DPO)** nomeado por ato escrito, com canal público | P0 | ❌ | Sócios | Res. CD/ANPD 18/2024; a ANPD agora é agência reguladora (Lei 15.352/2026, §3.10) |
| J5 | Termos de uso, política de privacidade (clínica e paciente), Carta de Compromissos G1–G9 (D9) | P0 | 📋 | Advogado + Produto | Carta só é publicada depois de J1 (risco CDC art. 37) |
| J6 | Termo de confidencialidade para toda pessoa com acesso a produção | P0 | ❌ | Sócios | Código Penal art. 154 |
| J7 | Cláusulas-padrão da ANPD (Res. 19/2024) com cada fornecedor estrangeiro (Meta, Sentry, LLM fora do Brasil) | P0 | ❌ | Advogado | Ver §3.5 sobre LLM |
| J8 | Enquadramento ANVISA das funções de IA (SaMD, RDC 657/2022) | P1 | ❌ | Advogado + IA | A Anvisa colocou a revisão da RDC 657 na Agenda Regulatória 2026–2027 (§3.6) |
| J9 | Matriz de regras por conselho (CFM, CFP, COFFITO, CFO, CFN, CFFa) para prontuário, teleatendimento e publicidade | P1 | 📋 | Produto + Advogado | Para o nicho de entrada (fisio/TO + psico), COFFITO e CFP primeiro |
| J10 | Seguro de responsabilidade civil e cyber | P1 | ❌ | Sócios | ESTIMATIVA: cotar antes do piloto |
| J11 | Registro de marca (INPI) e domínio definitivo | P1 | ❌ | Sócios | O nome ainda é provisório |
| J12 | Política de retenção da auditoria (D7) e de logs de acesso (Marco Civil: ≥ 6 meses) | P0 | 📋 | Sócios + Guardião | Sugestão atual: mínimo de 5 anos |
| J13 | **Retenção do prontuário por conselho**: mínimo de 20 anos após o último registro (Lei 13.787/2018); registros psicológicos: mínimo de 5 anos (Res. CFP 001/2009) | P0 | ❌ | Guardião + Advogado | Afeta a eliminação certificada da garantia de saída (EXP-01.6). §3.11 ⚖️ |
| J14 | **Plano de incidentes**: comunicado preliminar à ANPD e aos titulares em 3 dias úteis, complementar em até 20 dias úteis, registro de incidentes guardado por 5 anos | P0 | 📋 | Guardião | Res. CD/ANPD 15/2024. *Tabletop* = pré-requisito P3 |
| J15 | **Inscrição no CRM** se houver prescrição nativa (Res. CFM 2.299/2021, art. 5º), provavelmente com médico responsável técnico | P2 para o nicho de entrada; P0 se entrar medicina | ❌ | Sócios + Advogado | §3.8 e D11 ⚖️ |

### 2.2 Identidade, acesso e segurança da aplicação

| # | Item | Prio | Estado | Observação |
|---|---|---|---|---|
| S1 | **Decisão D4** (login próprio × Keycloak/Zitadel no Brasil) | P0 | ❌ | Bloqueio técnico nº 1. Opções na §3.12 |
| S2 | Login + sessão (cookie HttpOnly, access token ≤ 15 min, refresh rotativo com detecção de reuso) | P0 | ❌ | Especificado em [seguranca-na-arquitetura](../04-arquitetura/seguranca-na-arquitetura.md) |
| S3 | MFA obrigatório para profissional e admin; MFA recente para exportação (G2) | P0 | ❌ | Controle anti-exfiltração da EXP-01.5 |
| S4 | RBAC por papel + nota psicológica em compartimento próprio (CFP) | P0 | ❌ | Psico é nicho de entrada |
| S5 | Criptografia de campo (envelope com KMS, DEK por clínica) para prontuário e anexos | P0 | ❌ | Campos marcados em [modelo-de-dados.md](../04-arquitetura/modelo-de-dados.md) |
| S6 | Auditoria completa com encadeamento de hash | P0 | 🛠️ | A `audit_log` existe; falta o interceptor geral e o encadeamento. Também é requisito do manual SBIS |
| S7 | Rate limit em Redis (hoje em memória, por instância) | P0 | ❌ | Pendência §6.4 |
| S8 | **Pentest externo** antes do piloto | P0 | ❌ | Pré-requisito P2 do plano de piloto. Custo na §4 |
| S9 | Acesso de suporte ao prontuário só por chamado + *break-glass* auditado | P0 | ❌ | Garantia de sigilo |
| S10 | OWASP ASVS 5.0 nível 2 (nível 3 em auth, prontuário e cripto) como checklist do PR | P1 | 📋 | Adotado como padrão interno |
| S11 | E2E com Playwright do login à evolução no prontuário, rodando no CI contra staging | P0 | ❌ | — |

### 2.3 Infraestrutura e operação (AWS São Paulo)

| # | Item | Prio | Estado | Observação |
|---|---|---|---|---|
| I1 | Contas AWS separadas (`staging`, `prod`) via AWS Organizations, com SSO e MFA, CloudTrail organizacional e GuardDuty; acesso humano *just-in-time* | P0 | ❌ | [ambientes-e-devops](../04-arquitetura/ambientes-e-devops.md) |
| I2 | **Terraform** em `infra/` (VPC com 2–3 AZs e sub-redes privadas, VPC endpoints para S3/ECR/Secrets/KMS, RDS Multi-AZ, ElastiCache, ECS/Fargate, S3 cifrado, KMS, Secrets Manager, WAF, CloudFront), plano revisado em PR e estado remoto cifrado | P0 | ❌ | "a criar" desde a rodada 1 |
| I3 | **Resolver o build da API** (`packages/shared` em TS puro) e gerar imagem Docker única por SHA, sem root | P0 | ❌ | Sem isso não há deploy |
| I4 | CD: staging automático a cada merge (build → ECR → Trivy → migração → deploy → smoke); produção por promoção manual da mesma imagem com aprovação de sócio; GitHub → AWS por **OIDC**; rollback automático | P0 | ❌ | |
| I5 | Backups: PITR do RDS (35 dias), teste de restauração mensal, RPO ≤ 15 min, RTO ≤ 4 h. Cópia para outra região **só se a D8 aprovar** | P0 | 📋 | Metas definidas; nunca testadas na AWS |
| I6 | Observabilidade sem dado de saúde: OpenTelemetry, logs estruturados, Sentry com `beforeSend` que remove corpo e cabeçalhos; alarmes de 5xx, latência, conexões e disco | P0 | ❌ | Sentry é suboperador estrangeiro (J7), ou usar alternativa hospedada no Brasil |
| I7 | Alertas e plantão (quem acorda às 3 h) + runbooks de incidente | P0 | 📋 | Runbooks listados em [requisitos-tecnicos-seguranca](../03-seguranca-lgpd/requisitos-tecnicos-seguranca.md) §13 |
| I8 | Erro 25006 (banco somente leitura) virar 503 | P1 | ❌ | Pendência §6.4 |
| I9 | Status page pública (SUP-01.6) e roadmap público (SUP-01.7) | P1 | ❌ | Fazem parte da D9 |
| I10 | E-mail transacional com domínio próprio (SPF, DKIM, DMARC), de preferência com dados no Brasil; DNS no Route 53 | P0 | ❌ | Necessário para login, convite, recuperação de senha e alerta "não fui eu" |
| I11 | Proteção da `main` (GitHub Team, ~US$ 4 por usuário por mês) + usuário do sócio no `CODEOWNERS` | P1 | ❌ | Risco nº 9 do relatório geral |
| I12 | Teste de falha de zona (Multi-AZ) e DR em outra região | P2 | ❌ | Só depois que I2 existir |
| I13 | Orçamento mensal de infraestrutura | P0 | 📋 | ESTIMATIVA na §4; confirmar na AWS Pricing Calculator |
| I14 | No RDS de produção: repetir o `REVOKE TEMPORARY` (achado da rodada 5), `rds.force_ssl` e os papéis `app_user`/`app_migrator` | P0 | ❌ | Senão o ataque de "tabela temporária sombra" volta a funcionar |
| I15 | S3 privado com SSE-KMS, *block public access*, versionamento e *Object Lock* para exportações e documentos assinados | P0 | ❌ | URLs pré-assinadas curtas |

### 2.4 Integrações obrigatórias para o nicho de entrada (fisio/TO + psico)

| # | Item | Prio | Estado | O que muda com a pesquisa de hoje |
|---|---|---|---|---|
| N1 | **NFS-e** via provedor (Focus, eNotas, PlugNotas, NFE.io) já no **padrão nacional** com IBS/CBS | P0 (clínica PJ) | ❌ | §3.1 |
| N2 | **Receita Saúde** para profissional PF | P0 (autônomo PF) | ❌ | §3.2: a Receita aceita **arquivo de integração para emissão em lote** gerado por software de consultório |
| N3 | **Gateway de pagamento (D5)** com Pix + **Pix Automático** para a assinatura do próprio SaaS | P0 | ❌ | §3.4 |
| N4 | **WhatsApp Cloud API** (lembrete e confirmação) com templates aprovados | P0 | ❌ | §3.3: cobrança em reais por mensagem |
| N5 | Assinatura ICP-Brasil em nuvem (BirdID, VIDaaS etc.), nível NGS2, validável no ITI | P1 | ❌ | Exigida pela Res. CFM 2.299/2021 para documentos médicos |
| N6 | TISS (guias) | P1 (controle de guia simples já no M1) | ❌ | §3.7: versão 04.03.00 obrigatória desde 01/07/2026 |
| N7 | Prescrição: Memed e **SNCR** | P2 para o nicho de entrada; P0 se entrar medicina | ❌ | §3.8 |
| N8 | Teleconsulta (D6, LiveKit; Lei 14.510/2022, CFM 2.314/2022) | P2 | ❌ | Fase 2 |

### 2.5 Produto mínimo para o piloto

Tudo isso já está no [backlog do MVP](../02-produto/backlog-mvp.md) (M0 + M1: 79 histórias, 377 pontos). O que precisa estar pronto **antes do primeiro paciente real**:
- cadastro de clínica, profissional e paciente; agenda (inclusive simultânea); evolução/prontuário por especialidade (fisio e psico); pacotes e controle de guia simples; financeiro básico; exportação total (G2) pela tela, com MFA;
- **migração/importação** de dados dos concorrentes. Mercado de troca: 92% já usam sistema. Sem importador não há venda. **Não conferi se esse item está como P0 no backlog: verificar na rodada 8**;
- **arquivo de lote do Receita Saúde** (N2): barato de fazer e vende para o psicólogo e o fisioterapeuta autônomos;
- onboarding guiado e suporte (canal, SLA, base de conhecimento). As queixas nº 1 do mercado são suporte lento e cancelamento difícil;
- PWA do portal do paciente (POR-03.1): pode ficar para P1. **Não há aplicativo nativo previsto, e não é preciso publicar em App Store ou Play Store para o MVP.**

### 2.6 Certificações (trilha, não bloqueio do piloto)

| Certificação | Para quê | Prio | Nota |
|---|---|---|---|
| **SBIS S-RES NGS1** e depois **NGS2** | Permitir que a clínica médica dispense o papel (CFM 1.821/2007); argumento de venda | P2 (NGS1 como meta do 1º ano) | §3.9. Desenhar o M0 já seguindo o manual 5.2 (D12) |
| ISO/IEC 27001 / 27701 | Venda para clínicas maiores e redes | P2 | Já listada como trilha futura |
| ISO/IEC 42001 | Gestão de IA | P2 | Idem |

---

## 3. O que a pesquisa de hoje mudou (10/10/2026)

### 3.1 NFS-e: padrão nacional, com IBS/CBS
- **FATO:** a LC 214/2025 (reforma tributária) obriga os municípios a aderir ao ambiente nacional da NFS-e a partir de jan/2026, por emissor próprio integrado ou pelo emissor nacional gratuito. Quem não aderir perde transferências voluntárias da União (art. 62, §7º). Em 2025, cerca de 1.472 municípios já tinham aderido, somando ~70% das emissões. Fontes: [Contábeis](https://www.contabeis.com.br/noticias/71679/nfs-e-nacional-sera-obrigatoria-para-municipios-a-partir-de-2026/), [Reforma Tributária: adesão de 1.472 municípios](https://www.reformatributaria.com/tecnologia/governo-informa-adesao-de-1-472-municipios-a-nfs-e-nacional/).
- **FATO:** a Nota Técnica 003/2025 consolidou a 3ª versão do leiaute, com o grupo **IBSCBS** na DPS. São Paulo, Barueri e Salvador mantêm sistema próprio, com layout adaptado e envio de dados ao ambiente nacional. O ISS continua sendo pago por guias municipais na maioria das cidades. Fontes: [EY — layouts da NFS-e 2026](https://www.ey.com/content/dam/ey-unified-site/ey-com/pt-br/campaigns/reforma-tributaria/documents/ey-serie-reforma-tributaria-layouts-da-nfs-e-2026.pdf), [Barbieri Advogados](https://www.barbieriadvogados.com/nfs-e-nacional-a-padronizacao-que-comporta-divergencias/).
- **A CONFIRMAR:** há leitura jurídica de que a obrigação de 2026 é só de compartilhar dados, e não de migrar a emissão ([Reforma Tributária: a verdade por trás da obrigatoriedade](https://www.reformatributaria.com/nfse-nacional-em-2026-a-verdade-por-tras-da-obrigatoriedade-e-migracao-dos-municipios/)).
- **Impacto:** reforça usar provedor de NFS-e (N1) em vez de integrar prefeitura por prefeitura. Critério de escolha do provedor: suporte ao padrão nacional, aos campos de IBS/CBS e às cidades fora do emissor nacional.

### 3.2 Receita Saúde: obrigatório para profissional PF, com emissão em lote
- **FATO:** desde 01/01/2025, médicos, dentistas, psicólogos, fisioterapeutas, fonoaudiólogos e terapeutas ocupacionais que atendem como **pessoa física** devem emitir o recibo pelo Receita Saúde. O papel acabou. Quem atende por CNPJ emite NFS-e. Recibos de 2025 podiam ser regularizados até 28/02/2026. Fontes: [Fenacon](https://fenacon.org.br/noticias/profissionais-de-saude-devem-regularizar-recibos-eletronicos-de-2025-ate-fevereiro-de-2026/), [COAD](https://www.coad.com.br/home/noticias-detalhe/135981/prazo-para-emissao-do-recibo-eletronico-receita-saude-ano-calendario-2025).
- **FATO:** desde 04/11/2025 a Receita aceita **arquivos de integração** gerados por softwares de gestão de consultório para emitir vários recibos de uma vez. O formato está nas perguntas 24 e 25 do Manual do Receita Saúde v2.1. Não há API pública documentada; a integração é por arquivo. Fontes: [Fenacon — emissão em lote](https://fenacon.org.br/noticias/disponibilizada-nova-funcionalidade-para-emissao-em-lote-de-recibos-do-receita-saude/), [CRC-SP](https://online.crcsp.org.br/portal/noticias/noticia.asp?c=10027).
- **ESTIMATIVA:** pela mesma regra, atendimentos de 2026 vão até 28/02/2027.
- **Impacto:** o **psicólogo autônomo** (metade do nicho de entrada) é PF. O MVP gera o arquivo de lote no formato do manual v2.1 e concilia o que foi emitido. Como não há API, a promessa da D2 deve ser "gera o lote para o Receita Saúde", e não "emite sozinho" (D14).

### 3.3 WhatsApp: cobrança por mensagem e em reais
- **FATO (Meta):** desde 01/07/2025 a cobrança é **por mensagem entregue**, por categoria (marketing, utilidade, autenticação). Desde 01/07/2026 clientes com faturamento no Brasil podem ser cobrados em **BRL**, e as WABAs elegíveis precisam migrar para BRL até 30/06/2027, ou a Meta para de entregar. Utilidade e autenticação têm faixas de volume que só mudam no 1º dia de um trimestre. Fonte: [Meta — Pricing on the WhatsApp Business Platform](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing).
- **A CONFIRMAR (BSP):** a partir de **01/10/2026**, template de utilidade enviado com a janela de 24 h já aberta **passa a ser cobrado** (antes era grátis). Fonte: [Zenvia — novas regras de cobrança](https://zenvia.movidesk.com/kb/en/article/600343/frequently-asked-questions-new-whatsapp-business-pricing-rules-2). A Meta pode reclassificar template de utilidade como marketing ([Courier](https://www.courier.com/guides/whatsapp-pricing)).
- **A CONFIRMAR (fontes comerciais divergem):** utilidade entre R$ 0,04 e R$ 0,08 por mensagem e marketing por ~R$ 0,38–0,39 ([Hyperleap](https://hyperleap.ai/whatsapp-pricing-calculator-brazil), [Message Central](https://www.messagecentral.com/blog/whatsapp-business-api-pricing-brazil)). Usar a tabela oficial da Meta para o modelo de custo.
- **Impacto:** lembrete e confirmação de consulta devem ser **templates de utilidade**, nunca de marketing (custa de 5 a 8 vezes mais). Isso afeta a D2 (WhatsApp incluso no preço). ESTIMATIVA: uma clínica com 400 consultas/mês e 2 mensagens por consulta gasta entre R$ 32 e R$ 64 por mês só de Meta.

### 3.4 Pix Automático para a assinatura do SaaS
- **FATO (documentação do Asaas):** o Pix Automático já está em produção para recorrência. Na "Jornada 3", um único QR paga a 1ª cobrança e autoriza as seguintes. Desde 19/05/2026 o Asaas gera as próximas cobranças sozinho com `paymentCreationMode: SUBSCRIPTION`. Fonte: [Asaas — Pix Automático](https://docs.asaas.com/docs/pix-automatico), [changelog](https://docs.asaas.com/changelog/pix-automático-cobranças-recorrentes-automatizadas).
- **Lacuna:** não achei a documentação equivalente da Efí. Comparar antes de fechar a D5.
- **Impacto:** a D5 deve ser decidida em duas partes: (a) cobrança do **nosso** SaaS (Pix Automático + cartão) e (b) cobrança da **clínica ao paciente** (Pix, boleto e split).

### 3.5 IA: "Claude no Bedrock São Paulo" não é dado no Brasil
- **FATO (documentação da Anthropic e da AWS):** em `sa-east-1`, Claude só está disponível pelo endpoint **Global**, que pode processar em qualquer região. Não há opção *in-region* nem *geo* para São Paulo. Fonte: [Claude in Amazon Bedrock](https://platform.claude.com/docs/build-with-claude/claude-in-amazon-bedrock), [AWS — Regional availability](https://docs.aws.amazon.com/it_it/bedrock/latest/userguide/models-region-compatibility.html).
- **FATO (Google):** o Vertex AI lista Gemini 2.5 Flash, Pro e Flash-Lite em `southamerica-east1`, com garantia de processamento na região **desde que se chame o endpoint regional e não o global**, e só para as funcionalidades da tabela de residência. Conferir modelo e funcionalidade exatos. Fontes: [Vertex AI — Data residency](https://cloud.google.com/vertex-ai/generative-ai/docs/learn/data-residency), [Vertex AI — locais](https://cloud.google.com/vertex-ai/generative-ai/docs/learn/locations-genai).
- **Impacto na D3:** confirma a recomendação atual. Dado sensível vai para Gemini regional em São Paulo ou para Maritaca/Sabiá. Claude e GPT só com dado pseudonimizado e cláusulas-padrão (J7). Adicionar ao gateway de IA uma **trava técnica que recusa endpoint global** para requisições com dado sensível.

### 3.6 ANVISA, CFM e lei de IA: regulação em movimento
- **FATO:** a Resolução **CFM 2.454/2026** foi aprovada em 11/02/2026, publicada em 27/02/2026 e entrou em vigor 180 dias depois (por volta de agosto de 2026). A decisão clínica continua humana; é proibido delegar à IA a comunicação de diagnóstico ou conduta sem mediação do médico. Fontes: [Mattos Filho](https://www.mattosfilho.com.br/unico/cfm-ia-medicina/), [Demarest](https://www.demarest.com.br/cfm-publica-resolucao-que-regulamenta-o-uso-de-inteligencia-artificial-na-medicina/), [Cescon Barrieu](https://cesconbarrieu.com.br/resolucao-cfm-no-2-454-2026-regulamenta-o-uso-de-inteligencia-artificial-na-medicina/), [Migalhas — CFM 2.454/26](https://www.migalhas.com.br/depeso/451919/ia-na-medicina-riscos-regulatorios-da-resolucao-cfm-2-454-26).
- **FATO:** a Anvisa incluiu a revisão da regulação de SaMD (RDC 657/2022) na Agenda Regulatória 2026–2027, com mecanismos específicos para IA. Para regularizar IA, já exige a descrição das bases de treino e validação. Não achei consulta pública aberta. Fontes: [Mattos Filho](https://www.mattosfilho.com.br/unico/inteligencia-artificial-dispositivos-medicos/), [Machado Meyer — Regulação da Saúde Digital 2026](https://www.machadomeyer.com.br/images/ebooks/Regulacao_saude_Digital_2026.pdf), [Câmara — apresentação da Anvisa](https://www2.camara.leg.br/atividade-legislativa/comissoes/comissoes-permanentes/cssf/apresentacoes-em-eventos/eventos-2025/05-08-2025-audiencia-publica-regulacao-da-inteligencia-artificial-no-setor-saude-beneficios-e-riscos-1/apresentacao-anvisa/view).
- **FATO:** o **PL 2.338/2023** (lei de IA) foi aprovado no Senado e está na Câmara, em comissão especial. Não achamos confirmação de votação. Fonte: [Senado](https://www25.senado.leg.br/web/atividade/materias/-/materia/157233).
- **FATO:** a ANPD tem "dados de saúde" na Agenda Regulatória 2025–2026 (Res. CD/ANPD 23/2024). Não achei norma final. **A CONFIRMAR:** a meta de pelo menos 10 fiscalizações em saúde, biometria e finanças até o fim de 2026. Fontes: [Legismap](https://legismap.com.br/conteudos/artigos-e-noticias/anpd-amplia-rigor-sobre-dados-de-saude-e-biometria-alerta-advogada), [Convergência Digital](https://convergenciadigital.com.br/governo/conselho-quer-foco-da-anpd-em-criancas-saude-alto-risco-e-seguranca/).
- **Impacto:** manter o escriba como "rascunho que o profissional revisa e assina", guardar o registro dessa revisão e **não** oferecer sugestão de CID ou diagnóstico no MVP até o parecer J8.

### 3.7 TISS: versão 04.03.00
- **FATO (comunicação de operadora citando a ANS):** a versão 04.03.00 do Padrão TISS é obrigatória desde **01/07/2026** e substitui a 04.02.00. Os componentes organizacionais de jan, mai, jul e set/2026 estão publicados. Fontes: [Unimed — Informativo TISS 04/2026](https://www.unimed.coop.br/site/web/planaltomedio/informativo-tiss-n-04-2026), [ANS — Componente Organizacional 202609](https://www.gov.br/ans/pt-br/assuntos/prestadores/padrao-para-troca-de-informacao-de-saude-suplementar-2013-tiss/PadroTISS_ComponenteOrganizacional_202609.pdf).
- **Impacto:** o gerador TISS deve nascer em 04.03.00, com a versão como dado (`tiss_guide.tiss_version`, já previsto), e com uma rotina mensal para checar nova versão.

### 3.8 Prescrição: SNCR da Anvisa e inscrição no CRM
- **FATO:** a RDC 1.000/2025 (aprovada em 10/12/2025) cria o **SNCR**, com numeração nacional para notificações de receita, receitas de controle especial e receitas sujeitas à retenção (antimicrobianos, GLP-1). Receita eletrônica desses tipos **só vale se for nata digital e emitida por serviço de prescrição integrado ao SNCR via API**. Controle especial exige assinatura ICP-Brasil; retenção aceita assinatura avançada (gov.br). Em 27/05/2026 o prazo foi adiado para **30/09/2026**, já vencido. Receitas em papel continuam existindo. Prescritores não acessam o SNCR diretamente. Fontes: [CFF — aprovação da RDC](https://site.cff.org.br/noticia/Noticias-gerais/10/12/2025/anvisa-aprova-nova-rdc-que-regulamenta-o-receituario-eletronico-de-medicamentos-controlados), [CFF — prorrogação](https://site.cff.org.br/noticia/Noticias-gerais/27/05/2026/anvisa-prorroga-para-30-de-setembro-o-prazo-do-novo-sistema-de-receitas-controladas), [CFF — o que muda para farmácias](https://site.cff.org.br/noticia/Noticias-gerais/21/05/2026/sncr-o-que-muda-para-farmacias-e-drogarias-com-o-novo-sistema-de-controle-de-receitas), [Afya — RDC 1.000/2025](https://portal.afya.com.br/saude/prescricao-eletronica-rdc1000-25), [Afya — adiamento](https://portal.afya.com.br/saude/anvisa-adia-implementacao-nacional-de-receituarios-eletronicos-controlados).
- **A CONFIRMAR:** a publicação da prorrogação no DOU (uma fonte cita a RDC 1.028/2026), um período de transição até 29/10/2026 e problemas de acesso à API relatados por desenvolvedores ("Domínio não Autorizado"). Fontes: [Bip — prazo de setembro](https://www.usebip.com/blogs/bip-insights/prescricao-eletronica-2026-prazo-do-sncr-muda-para-setembro), [ACBr — API do SNCR](https://www.projetoacbr.com.br/forum/topic/93263-nova-api-sncr-sistema-nacional-de-controle-de-receitu%C3%A1rio-anvisa/).
- **FATO:** a **Res. CFM 2.299/2021** exige ICP-Brasil **NGS2** para documentos médicos digitais, validáveis pelo ITI ou pelo validador do CFM (art. 4º), e **inscrição no CRM da jurisdição** para plataformas de prescrição eletrônica (art. 5º). Fontes: [texto no DOU](https://ses.sp.bvs.br/wp-content/uploads/2021/10/U_RS-CFM-2299_300921.pdf), [Mattos Filho](https://www.mattosfilho.com.br/unico/cfm-emissao-documentos-eletronicos/).
- **Impacto:** **não fazer prescrição nativa de controlados**. Para medicina, integrar com quem já é integrado ao SNCR e inscrito no CRM (Memed, Nexodata etc.) e exigir isso por contrato (D10, D11). Para o nicho de entrada (fisio/TO + psico) o tema não se aplica, porque essas profissões não prescrevem medicamentos.

### 3.9 SBIS: manual 5.2 ainda em uso
- **FATO:** certificados emitidos até ago/2026 ainda citam o **Manual de Certificação 2021 v5.2**. Existe menção a uma v5.3 sem confirmação de vigência. NGS1 e NGS2 estão em uso, e a validade inicial aparente é de ~2 anos. Só o NGS2 permite prontuário 100% digital sem papel (CFM 1.821/2007). Fontes: [Certificado SBIS 141](https://sbis.org.br/certificacao/certificados/5_2/Certificado_SBIS_SRES_141-TISAUDE.pdf), [Certificado SBIS 194](https://sbis.org.br/wp-content/uploads/2026/06/Certificado_SBIS_SRES_194_SOSDOCS.pdf), [Certificado SBIS 203](https://sbis.org.br/wp-content/uploads/2026/08/Certificado_SBIS_SRES_203_PRONTU.pdf), [Certificado SBIS 206](https://sbis.org.br/wp-content/uploads/2026/08/Certificado_SBIS_SRES_206_PRONTU.pdf), [Senior — PEP e NGS2](https://documentacao.senior.com.br/gestao-de-pessoas-hcm/6.10.4/manual-processos/qualidade-de-vida/medicina-ocupacional/pep.htm).
- **Lacuna:** custo e prazo não são públicos. Pedir a cotação em sbis@sbis.org.br.

### 3.10 ANPD: agência reguladora e prazo de incidente
- **FATO:** a MP 1.317/2025 foi convertida na **Lei 15.352/2026** (25/02/2026). A ANPD virou agência reguladora (Agência Nacional de Proteção de Dados), com mais estrutura de fiscalização. Fontes: [Teletime](https://teletime.com.br/24/02/2026/senado-aprova-mp-que-transforma-a-anpd-em-agencia/), [Relatório anual da ANPD 2025](https://www2.camara.leg.br/atividade-legislativa/comissoes/comissoes-permanentes/cffc/expedientes-recebidos/RelatorioAnualANPD2025.pdf).
- **FATO:** a Res. CD/ANPD 15/2024 continua valendo: comunicado preliminar em 3 dias úteis, complementar em até 20 dias úteis, registro de incidentes por 5 anos; agente de pequeno porte tem prazo em dobro. Fontes: [KLA](https://klalaw.com.br/anpd-aprova-regulamento-comunicacao-incidente-seguranca/), [gov.br — apresentação de 30/04/2025](https://www.gov.br/governodigital/pt-br/privacidade-e-seguranca/centro-de-excelencia-em-privacidade-e-seguranca/webnario/apresentacaocis-30abr2025-_final.pdf/@@download/file).
- **FATO / A CONFIRMAR:** a Res. CD/ANPD 18/2024 regula o encarregado; agentes de pequeno porte podem ser dispensados, mas o regime simplificado não se aplica a quem trata dado sensível em larga escala (fonte secundária, confirmar no texto da Res. 2/2022). Fontes: [texto da Res. 18/2024](https://www.tjba.jus.br/extrajudicial/wp-content/uploads/2024/08/RESOLUCAO-ANPD-No-18-Encarregado-de-Dados.pdf), [Lefosse](https://lefosse.com/noticias/alerta/anpd-publica-regulamento-que-flexibiliza-a-aplicacao-da-lgpd-a-microempresas-empresas-de-pequeno-porte-startups-e-associacoes-sem-fins-lucrativos/).

### 3.11 Guarda do prontuário
- **FATO:** a Lei 13.787/2018 fixa guarda mínima de **20 anos** a partir do último registro para prontuários. A Res. CFP 001/2009 fixa **no mínimo 5 anos** para registros psicológicos; depois disso o CFP orienta a destruição. Tabelas de temporalidade institucionais tratam os dois separadamente. Não achamos a regra do COFFITO. Fontes: [CFP — guarda e descarte](https://site.cfp.org.br/faq/como-devo-fazer-guarda-e-descarte-de-documentos-utilizados-no-atendimento/), [SES-SP — tabela de temporalidade](https://www.saude.sp.gov.br/resources/ses/perfil/profissional-da-saude/homepage/cada/ttd_fim_saude_atualizacao_final_apesp_ttd.pdf).
- **Impacto:** a retenção precisa ser configurada **por tipo de registro e por conselho** (J13), e a eliminação certificada da garantia de saída precisa respeitar esses prazos.

### 3.12 Autenticação (para a D4)
- **FATO (comparativos, fontes de fornecedores):** **Keycloak** tem TOTP e WebAuthn nativos e multi-tenancy, com extensões em Java. **Zitadel** é voltado a SaaS B2B, com organizações e SCIM. **Ory** é API-first, com extensões por webhook. **Better Auth** é uma biblioteca TypeScript com 2FA e multi-tenant; suporte a passkey e integração com NestJS a conferir. Fontes: [Authgear — MFA open source 2026](https://www.authgear.com/post/top-open-source-mfa-solutions-for-enterprise-applications-2026/), [Keycloak vs Ory](https://guptadeepak.com/compare/keycloak-vs-ory/), [Skycloak — alternativas ao Auth0](https://skycloak.io/blog/auth0-alternatives-open-source-managed/), [OpenAlternative — Better Auth vs Ory](https://openalternative.co/compare/better-auth/vs/ory).
- **Recomendação:** Keycloak ou Zitadel hospedado em sa-east-1. Login, MFA e recuperação de conta não valem ser escritos do zero em produto com dado de saúde. A decisão continua sendo dos sócios.

---

## 4. Custos estimados

**Base:** o RDS `db.t4g.medium` custa **cerca de US$ 100 por mês em sa-east-1 contra US$ 47 em us-east-1** (FATO, [Bytebase](https://www.bytebase.com/dbcost/rds/instance/db.t4g.medium/)), ou seja, São Paulo sai cerca de 2,1 vezes mais caro. Para os itens sem preço regional encontrado, aplicamos o fator de 1,5 a 2,1 sobre us-east-1 ([AWS — RDS](https://aws.amazon.com/rds/postgresql/pricing), [AWS — ECS](https://aws.amazon.com/ecs/pricing/)). **Tudo abaixo é ESTIMATIVA: confirmar na AWS Pricing Calculator antes de aprovar o orçamento.**

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

**Custos de projeto (não mensais):**
- **Pentest externo (S8):** US$ 5.000 a 30.000 para aplicação web + API + nuvem; SaaS multi-tenant com pagamentos e muitas integrações tende ao topo. Duração típica de 1 a 3 semanas. Fornecedores com atuação no Brasil: DeepStrike, Blaze, eSecurity, DM11, Resh. **Pedir 2 ou 3 propostas em reais.** Desconfiar de "pentest" barato e rápido, que costuma ser só um scanner automático. Fontes: [Blaze — preços 2026](https://www.blazeinfosec.com/post/how-much-does-penetration-testing-cost/), [DeepStrike — empresas no Brasil](https://deepstrike.io/blog/penetration-testing-companies-brazil), [Startup Defense](https://www.startupdefense.io/pt-br/blog/quanto-custa-um-pentest).
- **Certificação SBIS:** sem preço público; pedir cotação.
- **Advogado (D8)**, **DPO terceirizado** e **seguro (J10):** pedir propostas.
- **WhatsApp:** ver §3.3 (R$ 32 a 64 por clínica por mês, ESTIMATIVA).

---

## 5. Checklist de go-live em portões

**Portão A, antes do primeiro deploy em staging:** I1, I2 (rede, Secrets/KMS), I3, I4 (só staging), I10 (domínio e DNS).

**Portão B, antes do piloto com dado real** (soma P1–P7 do [plano de piloto](../02-produto/plano-piloto.md) com o que esta pesquisa trouxe):
- [ ] D4 decidida, com login, RBAC e MFA em produção (S1–S4)
- [ ] Infra I1–I7, I10, I14 e I15 em produção, com **failover e restauração testados no RDS**
- [ ] Erro 25006 → 503 e rate limit em Redis (I8, S7)
- [ ] Criptografia de campo e auditoria com hash (S5, S6)
- [ ] Encarregado (DPO) nomeado e canal do titular publicado (J4)
- [ ] RIPD do produto e do piloto assinados (J3, P1); plano de incidentes testado (J14, P3)
- [ ] DPA e termo de piloto validados pelo advogado (J2, P4, P5)
- [ ] Política de retenção por conselho definida (J12, J13, D7)
- [ ] Pentest externo sem achado crítico ou alto aberto (S8, P2)
- [ ] IA desligada **ou** com revisão humana registrada (CFM 2.454/2026) e provedor no Brasil (P6, §3.5)

**Portão C, antes do lançamento comercial:** SBIS em andamento (D12), N5–N7 resolvidos para os nichos com médico, N1–N3 no financeiro, I9 e I11, Carta de Compromissos publicada (D9).

---

## 6. Decisões novas para os sócios

Registradas no [registro de decisões](../00-governanca/decisoes.md):

| # | Decisão | Recomendação |
|---|---|---|
| **D10** | Receita controlada (SNCR) | No MVP, usar parceiro já integrado ao SNCR (confirmar com a Memed) em vez de integrar direto |
| **D11** | Inscrição no CRM como plataforma de prescrição | Só inscrever se houver prescrição nativa; até lá, delegar ao parceiro. Validar com o advogado ⚖️ |
| **D12** | Certificação SBIS S-RES | Desenhar o M0 já seguindo o manual 5.2; NGS1 como meta do 1º ano e NGS2 depois |
| **D13** | Orçamento de infraestrutura e pentest | Aprovar ~US$ 1.000 por mês de nuvem e reservar US$ 5.000 a 30.000 para o pentest |
| **D14** | Escopo do Receita Saúde no MVP | Gerar o arquivo de lote (manual v2.1) e conciliar; vender como "gera o lote", não "emite sozinho" |

Também sugerido: dividir a **D5** em (a) cobrança do nosso SaaS (Pix Automático + cartão) e (b) cobrança da clínica ao paciente (Pix, boleto e split).

---

## 7. Documentos que precisam ser atualizados (dívida desta rodada)

| Documento | O que falta | Dono |
|---|---|---|
| [integracoes.md](../04-arquitetura/integracoes.md) | Seções novas: **Receita Saúde** (arquivo de lote), **SNCR**, **Pix Automático**, TISS 04.03.00, WhatsApp por mensagem em BRL, NFS-e com IBS/CBS | Engenharia |
| [03-seguranca-lgpd/README.md](../03-seguranca-lgpd/README.md) | Mapa regulatório: incluir RDC 1.000/2025 + SNCR, CFM 2.299/2021 (NGS2 e CRM), CFM 2.454/2026 em vigor, Lei 15.352/2026, LC 214/2025, Receita Saúde, retenção por conselho, Agenda Anvisa 2026–2027 | Guardião |
| [05-ia-llm](../05-ia-llm/) | Registrar que Bedrock sa-east-1 é só Global e a trava contra endpoint global | IA |
| [backlog-mvp.md](../02-produto/backlog-mvp.md) | Conferir se o **importador de dados dos concorrentes** está como P0; incluir o arquivo de lote do Receita Saúde | Produto |

---

## 8. Novos riscos (complementam o top 10 do relatório geral)

| # | Risco | Mitigação |
|---|---|---|
| R11 | Prometer "Receita Saúde incluso" (D2) quando só existe integração por arquivo | Vender como "gera o lote para o Receita Saúde" (D14) |
| R12 | Custo do WhatsApp corroer a margem se templates forem classificados como marketing, ou com a cobrança de utilidade dentro da janela | Só templates de utilidade; medir o custo por clínica desde o piloto |
| R13 | Uso acidental do endpoint global de LLM com dado sensível | Trava no gateway de IA + teste automatizado |
| R14 | Entrar em medicina sem integração ao SNCR e sem inscrição no CRM | Medicina só na onda 4; nunca prescrição nativa de controlados |
| R15 | Nenhuma infraestrutura de produção a ~3 semanas do início previsto do MVP (nov/2026) | Terraform e build da API na próxima rodada, em paralelo à D4 |
| R16 | Eliminar registro antes do prazo legal do conselho (20 anos × 5 anos) | Retenção configurável por tipo de registro (J13) antes de ligar a eliminação certificada |

---

## 9. Ordem recomendada (até 3 agentes por rodada)

**Antes de qualquer código, os sócios precisam:** decidir a **D4** e a **D13**, contratar o advogado (**D8**), agendar as entrevistas da **D1/D2**, nomear o **DPO** (J4), perguntar à Memed sobre o SNCR (**D10**) e pedir propostas de pentest.

**Rodada 8: fundação de produção** (não depende da D4)
- `devops-ci`: I3 (build da API + imagem Docker) e o esqueleto de I2 (Terraform da conta `staging`: VPC, RDS, Redis, ECS, Secrets Manager), sem aplicar em produção.
- `engenharia`: S7 (rate limit em Redis), I8 (25006 → 503), rascunho do bug do postgres.js e os PRs do Dependabot em blocos, testados como na rodada 6.
- `guardiao-lgpd`: atualizar o mapa regulatório (§7), definir a retenção por conselho (J13) e começar o RIPD do produto (J3).

**Rodada 9: M0 de identidade** (depende da D4)
- `engenharia`: S2–S4 (login, MFA, RBAC) e I10 (e-mail transacional).
- `qa-testes`: isolamento para as tabelas novas e E2E do login (S11).
- `guardiao-lgpd`: revisar o PR de auth e a política de retenção (D7/J12).

**Rodada 10: M0 completo + integrações do nicho**
- `engenharia`: S5–S6 (criptografia de campo, auditoria encadeada), N3 (gateway, depois da D5) e N1 (provedor de NFS-e).
- `produto`: importador de dados dos concorrentes + arquivo de lote do Receita Saúde (N2).
- `devops-ci`: I4–I7 (CD, backups testados, observabilidade, alertas) e preparação do pentest (S8).

---

## 10. Fontes consultadas nesta rodada

As fontes estão citadas ao lado de cada fato nas §3 e §4. Lista completa:

- Meta — WhatsApp pricing: https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing
- Zenvia — novas regras de cobrança do WhatsApp: https://zenvia.movidesk.com/kb/en/article/600343/frequently-asked-questions-new-whatsapp-business-pricing-rules-2
- Courier — WhatsApp pricing: https://www.courier.com/guides/whatsapp-pricing
- Hyperleap — calculadora WhatsApp Brasil: https://hyperleap.ai/whatsapp-pricing-calculator-brazil
- Message Central — WhatsApp Brasil: https://www.messagecentral.com/blog/whatsapp-business-api-pricing-brazil
- Contábeis — NFS-e nacional 2026: https://www.contabeis.com.br/noticias/71679/nfs-e-nacional-sera-obrigatoria-para-municipios-a-partir-de-2026/
- Reforma Tributária — adesão dos municípios: https://www.reformatributaria.com/tecnologia/governo-informa-adesao-de-1-472-municipios-a-nfs-e-nacional/
- Reforma Tributária — leitura divergente: https://www.reformatributaria.com/nfse-nacional-em-2026-a-verdade-por-tras-da-obrigatoriedade-e-migracao-dos-municipios/
- EY — layouts da NFS-e 2026: https://www.ey.com/content/dam/ey-unified-site/ey-com/pt-br/campaigns/reforma-tributaria/documents/ey-serie-reforma-tributaria-layouts-da-nfs-e-2026.pdf
- Barbieri Advogados — NFS-e nacional: https://www.barbieriadvogados.com/nfs-e-nacional-a-padronizacao-que-comporta-divergencias/
- Fenacon — Receita Saúde (prazo de 2025): https://fenacon.org.br/noticias/profissionais-de-saude-devem-regularizar-recibos-eletronicos-de-2025-ate-fevereiro-de-2026/
- Fenacon — Receita Saúde (emissão em lote): https://fenacon.org.br/noticias/disponibilizada-nova-funcionalidade-para-emissao-em-lote-de-recibos-do-receita-saude/
- CRC-SP — Receita Saúde (emissão em lote): https://online.crcsp.org.br/portal/noticias/noticia.asp?c=10027
- COAD — Receita Saúde: https://www.coad.com.br/home/noticias-detalhe/135981/prazo-para-emissao-do-recibo-eletronico-receita-saude-ano-calendario-2025
- SBIS — certificados 141, 194, 203 e 206: https://sbis.org.br/certificacao/certificados/5_2/Certificado_SBIS_SRES_141-TISAUDE.pdf · https://sbis.org.br/wp-content/uploads/2026/06/Certificado_SBIS_SRES_194_SOSDOCS.pdf · https://sbis.org.br/wp-content/uploads/2026/08/Certificado_SBIS_SRES_203_PRONTU.pdf · https://sbis.org.br/wp-content/uploads/2026/08/Certificado_SBIS_SRES_206_PRONTU.pdf
- Senior — PEP e NGS2: https://documentacao.senior.com.br/gestao-de-pessoas-hcm/6.10.4/manual-processos/qualidade-de-vida/medicina-ocupacional/pep.htm
- Anthropic — Claude in Amazon Bedrock: https://platform.claude.com/docs/build-with-claude/claude-in-amazon-bedrock
- AWS — Bedrock regional availability: https://docs.aws.amazon.com/it_it/bedrock/latest/userguide/models-region-compatibility.html
- Google — Vertex AI data residency: https://cloud.google.com/vertex-ai/generative-ai/docs/learn/data-residency
- Google — Vertex AI locais: https://cloud.google.com/vertex-ai/generative-ai/docs/learn/locations-genai
- Mattos Filho — IA em dispositivos médicos: https://www.mattosfilho.com.br/unico/inteligencia-artificial-dispositivos-medicos/
- Mattos Filho — CFM 2.454/2026: https://www.mattosfilho.com.br/unico/cfm-ia-medicina/
- Mattos Filho — CFM 2.299/2021: https://www.mattosfilho.com.br/unico/cfm-emissao-documentos-eletronicos/
- Demarest — CFM 2.454/2026: https://www.demarest.com.br/cfm-publica-resolucao-que-regulamenta-o-uso-de-inteligencia-artificial-na-medicina/
- Cescon Barrieu — CFM 2.454/2026: https://cesconbarrieu.com.br/resolucao-cfm-no-2-454-2026-regulamenta-o-uso-de-inteligencia-artificial-na-medicina/
- Migalhas — CFM 2.454/26: https://www.migalhas.com.br/depeso/451919/ia-na-medicina-riscos-regulatorios-da-resolucao-cfm-2-454-26
- Machado Meyer — Regulação da Saúde Digital 2026: https://www.machadomeyer.com.br/images/ebooks/Regulacao_saude_Digital_2026.pdf
- Câmara — apresentação da Anvisa sobre IA: https://www2.camara.leg.br/atividade-legislativa/comissoes/comissoes-permanentes/cssf/apresentacoes-em-eventos/eventos-2025/05-08-2025-audiencia-publica-regulacao-da-inteligencia-artificial-no-setor-saude-beneficios-e-riscos-1/apresentacao-anvisa/view
- CFM 2.299/2021 — texto no DOU: https://ses.sp.bvs.br/wp-content/uploads/2021/10/U_RS-CFM-2299_300921.pdf
- Senado — PL 2.338/2023: https://www25.senado.leg.br/web/atividade/materias/-/materia/157233
- Legismap — ANPD e dados de saúde: https://legismap.com.br/conteudos/artigos-e-noticias/anpd-amplia-rigor-sobre-dados-de-saude-e-biometria-alerta-advogada
- Convergência Digital — CNPD e ANPD: https://convergenciadigital.com.br/governo/conselho-quer-foco-da-anpd-em-criancas-saude-alto-risco-e-seguranca/
- Teletime — ANPD agência: https://teletime.com.br/24/02/2026/senado-aprova-mp-que-transforma-a-anpd-em-agencia/
- ANPD — relatório anual 2025: https://www2.camara.leg.br/atividade-legislativa/comissoes/comissoes-permanentes/cffc/expedientes-recebidos/RelatorioAnualANPD2025.pdf
- KLA — comunicação de incidente: https://klalaw.com.br/anpd-aprova-regulamento-comunicacao-incidente-seguranca/
- gov.br — apresentação sobre incidentes (30/04/2025): https://www.gov.br/governodigital/pt-br/privacidade-e-seguranca/centro-de-excelencia-em-privacidade-e-seguranca/webnario/apresentacaocis-30abr2025-_final.pdf/@@download/file
- ANPD — Res. 18/2024 (encarregado): https://www.tjba.jus.br/extrajudicial/wp-content/uploads/2024/08/RESOLUCAO-ANPD-No-18-Encarregado-de-Dados.pdf
- Lefosse — agentes de pequeno porte: https://lefosse.com/noticias/alerta/anpd-publica-regulamento-que-flexibiliza-a-aplicacao-da-lgpd-a-microempresas-empresas-de-pequeno-porte-startups-e-associacoes-sem-fins-lucrativos/
- CFP — guarda e descarte: https://site.cfp.org.br/faq/como-devo-fazer-guarda-e-descarte-de-documentos-utilizados-no-atendimento/
- SES-SP — tabela de temporalidade: https://www.saude.sp.gov.br/resources/ses/perfil/profissional-da-saude/homepage/cada/ttd_fim_saude_atualizacao_final_apesp_ttd.pdf
- Unimed — Informativo TISS 04/2026: https://www.unimed.coop.br/site/web/planaltomedio/informativo-tiss-n-04-2026
- ANS — Componente Organizacional 202609: https://www.gov.br/ans/pt-br/assuntos/prestadores/padrao-para-troca-de-informacao-de-saude-suplementar-2013-tiss/PadroTISS_ComponenteOrganizacional_202609.pdf
- CFF — aprovação da RDC 1.000/2025: https://site.cff.org.br/noticia/Noticias-gerais/10/12/2025/anvisa-aprova-nova-rdc-que-regulamenta-o-receituario-eletronico-de-medicamentos-controlados
- CFF — prorrogação do SNCR: https://site.cff.org.br/noticia/Noticias-gerais/27/05/2026/anvisa-prorroga-para-30-de-setembro-o-prazo-do-novo-sistema-de-receitas-controladas
- CFF — SNCR para farmácias: https://site.cff.org.br/noticia/Noticias-gerais/21/05/2026/sncr-o-que-muda-para-farmacias-e-drogarias-com-o-novo-sistema-de-controle-de-receitas
- Afya — RDC 1.000/2025: https://portal.afya.com.br/saude/prescricao-eletronica-rdc1000-25
- Afya — adiamento do SNCR: https://portal.afya.com.br/saude/anvisa-adia-implementacao-nacional-de-receituarios-eletronicos-controlados
- Bip — prazo de setembro: https://www.usebip.com/blogs/bip-insights/prescricao-eletronica-2026-prazo-do-sncr-muda-para-setembro
- ACBr — API do SNCR: https://www.projetoacbr.com.br/forum/topic/93263-nova-api-sncr-sistema-nacional-de-controle-de-receitu%C3%A1rio-anvisa/
- Asaas — Pix Automático: https://docs.asaas.com/docs/pix-automatico · https://docs.asaas.com/changelog/pix-automático-cobranças-recorrentes-automatizadas
- Authgear — MFA open source 2026: https://www.authgear.com/post/top-open-source-mfa-solutions-for-enterprise-applications-2026/
- Keycloak vs Ory: https://guptadeepak.com/compare/keycloak-vs-ory/
- Skycloak — alternativas ao Auth0: https://skycloak.io/blog/auth0-alternatives-open-source-managed/
- OpenAlternative — Better Auth vs Ory: https://openalternative.co/compare/better-auth/vs/ory
- Bytebase — db.t4g.medium por região: https://www.bytebase.com/dbcost/rds/instance/db.t4g.medium/
- AWS — preços do RDS: https://aws.amazon.com/rds/postgresql/pricing
- AWS — preços do ECS: https://aws.amazon.com/ecs/pricing/
- Blaze — preços de pentest 2026: https://www.blazeinfosec.com/post/how-much-does-penetration-testing-cost/
- DeepStrike — empresas de pentest no Brasil: https://deepstrike.io/blog/penetration-testing-companies-brazil
- Startup Defense — quanto custa um pentest: https://www.startupdefense.io/pt-br/blog/quanto-custa-um-pentest
- postgres.js — releases: `gh release list -R porsager/postgres` (última versão: v3.4.9, de 05/04/2026)
