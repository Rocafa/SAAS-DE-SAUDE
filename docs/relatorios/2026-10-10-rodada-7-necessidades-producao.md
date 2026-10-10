# Relatório da Rodada 7: tudo o que falta para colocar o aplicativo em produção

**Data:** 10/10/2026 · **Responsável:** Maestro · **Agentes:** nenhum (feito direto, sem subagentes)
**Pedido dos sócios:** "extrair e maximizar, pesquisando todas as necessidades para a produção do aplicativo, e registrar tudo em um relatório".
**Base:** leitura do repositório (`main` em `9bf134f`) + pesquisa web feita em 10/10/2026. Cada fato externo tem fonte e está marcado como **FATO** (fonte oficial ou várias fontes concordando), **A CONFIRMAR** (fonte única, comercial ou desatualizada) ou **ESTIMATIVA**.

> **Resumo em 5 linhas**
> 1. O código hoje é **fundação**: isolamento por clínica, garantia de saída e testes de ataque/resiliência. **Nenhuma tela ou rota de negócio existe**: `auth`, `patients`, `records`, `scheduling`, `billing`, `prescriptions` e `audit` são arquivos de 3 linhas, e o site é uma página de 11 linhas.
> 2. **Não existe infraestrutura de produção.** Não há conta AWS, Terraform, domínio, e-mail transacional, observabilidade nem status page. Só existe o `docker-compose` local.
> 3. A pesquisa achou **5 mudanças externas** que os documentos ainda não refletem: SNCR da Anvisa (receita controlada), Receita Saúde, TISS 4.03.00, cobrança do WhatsApp em reais e o fato de que **Claude no Bedrock em São Paulo não fica no Brasil**. Ver §3.
> 4. Para o **piloto com dado real** faltam os itens P0 da §2. Os bloqueios de verdade são três decisões dos sócios: **D4 (login)**, **D8 (advogado)** e **D1 (nicho)**.
> 5. A ordem recomendada está na §6, com no máximo 3 agentes por rodada (regra do `AGENTS.md`).

---

## 1. Onde estamos de verdade (fatos do repositório)

| Área | Existe | Não existe |
|---|---|---|
| API (NestJS) | Bootstrap, health (`/health`), borda HTTP endurecida, `withTenant` + RLS forçado, módulo de exportação (G1–G3), `audit_log`, 3 migrations | Login, sessão, RBAC, MFA, qualquer CRUD de paciente, agenda, prontuário, financeiro, receita |
| Web (Next.js) | `layout.tsx` + `page.tsx` (11 linhas) | Telas do profissional, portal do paciente, PWA |
| Banco | Postgres 16 local, papéis de app/migração, isolamento testado | RDS, PITR, réplica, criptografia de campo, chaves no KMS |
| Filas | Redis local no compose | BullMQ configurado, workers, dead-letter |
| CI | 4 workflows verdes (CI, Segurança com ZAP, Testes de produção, CodeQL); Dependabot | Deploy (CD), proteção da `main`, ambientes `staging`/`prod` |
| Infra | `infra/local/postgres-init.sh` | Terraform, contas AWS, VPC, WAF, Secrets Manager, domínio, TLS, CDN |
| Pendências técnicas já conhecidas (relatório geral §6.4) | — | Build da API não sobe sem carregador TS; erro 25006 vira 500; rate limit em memória; réplicas de leitura × trava de clínica |
| Dependências | — | 13 PRs do Dependabot abertos (#14–#26), entre eles NestJS 12, ESLint 10 e Vitest 5 |

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
| J1 | **Advogado de saúde + LGPD contratado (D8)** | P0 | ❌ | Sócios | Destrava J2–J7. É o item que mais trava o piloto |
| J2 | Contrato SaaS + **DPA (contrato de operador)** + política de suboperadores | P0 | ❌ | Advogado + Guardião | Lista de suboperadores: AWS, WhatsApp/BSP, gateway Pix, NFS-e, PSC ICP-Brasil, provedor de LLM, e-mail, Sentry |
| J3 | **RIPD do produto** (modelo já existe em [RIPD-modelo.md](../03-seguranca-lgpd/RIPD-modelo.md)) | P0 | 📋 | Guardião | Tratamento de alto risco: o regime simplificado de pequeno porte não se aplica |
| J4 | **Encarregado (DPO)** nomeado por ato escrito, com canal público | P0 | ❌ | Sócios | Res. CD/ANPD 18/2024 |
| J5 | Termos de uso, política de privacidade (clínica e paciente), Carta de Compromissos G1–G9 (D9) | P0 | 📋 | Advogado + Produto | Carta só é publicada depois de J1 (risco CDC art. 37) |
| J6 | Termo de confidencialidade para toda pessoa com acesso a produção | P0 | ❌ | Sócios | Código Penal art. 154 |
| J7 | Cláusulas-padrão da ANPD (Res. 19/2024) com cada fornecedor estrangeiro (Meta, Sentry, LLM fora do Brasil) | P0 | ❌ | Advogado | Ver §3.5 sobre LLM |
| J8 | Enquadramento ANVISA das funções de IA (SaMD, RDC 657/2022) | P1 | ❌ | Advogado + IA | A Anvisa colocou a revisão da RDC 657 na Agenda Regulatória 2026–2027 (§3.6) |
| J9 | Matriz de regras por conselho (CFM, CFP, COFFITO, CFO, CFN, CFFa) para prontuário, teleatendimento e publicidade | P1 | 📋 | Produto + Advogado | Para o nicho de entrada (fisio/TO + psico), COFFITO e CFP primeiro |
| J10 | Seguro de responsabilidade civil e cyber | P1 | ❌ | Sócios | ESTIMATIVA: cotar antes do piloto |
| J11 | Registro de marca (INPI) e domínio definitivo | P1 | ❌ | Sócios | O nome ainda é provisório |
| J12 | Política de retenção da auditoria (D7) e de logs de acesso (Marco Civil: ≥ 6 meses) | P0 | 📋 | Sócios + Guardião | Sugestão atual: mínimo de 5 anos |

### 2.2 Identidade, acesso e segurança da aplicação

| # | Item | Prio | Estado | Observação |
|---|---|---|---|---|
| S1 | **Decisão D4** (login próprio × Keycloak no Brasil) | P0 | ❌ | Bloqueio técnico nº 1 |
| S2 | Login + sessão (cookie HttpOnly, access token ≤ 15 min, refresh rotativo com detecção de reuso) | P0 | ❌ | Especificado em [seguranca-na-arquitetura](../04-arquitetura/seguranca-na-arquitetura.md) |
| S3 | MFA obrigatório para profissional e admin; MFA recente para exportação (G2) | P0 | ❌ | Controle anti-exfiltração da EXP-01.5 |
| S4 | RBAC por papel + nota psicológica em compartimento próprio (CFP) | P0 | ❌ | Psico é nicho de entrada |
| S5 | Criptografia de campo (envelope com KMS) para prontuário e anexos | P0 | ❌ | Rodada 8 do plano antigo |
| S6 | Auditoria completa com encadeamento de hash | P0 | 🛠️ | A `audit_log` existe; falta o interceptor geral e o encadeamento |
| S7 | Rate limit em Redis (hoje em memória, por instância) | P0 | ❌ | Pendência §6.4 |
| S8 | **Pentest externo** antes do piloto | P0 | ❌ | Pré-requisito P2 do plano de piloto. ESTIMATIVA: cotar 2–3 empresas |
| S9 | Acesso de suporte ao prontuário só por chamado + *break-glass* auditado | P0 | ❌ | Garantia de sigilo |
| S10 | OWASP ASVS 5.0 nível 2 (nível 3 em auth, prontuário e cripto) como checklist do PR | P1 | 📋 | Adotado como padrão interno |

### 2.3 Infraestrutura e operação (AWS São Paulo)

| # | Item | Prio | Estado | Observação |
|---|---|---|---|---|
| I1 | Contas AWS separadas (`staging`, `prod`) com SSO e MFA; acesso humano *just-in-time* | P0 | ❌ | [ambientes-e-devops](../04-arquitetura/ambientes-e-devops.md) |
| I2 | **Terraform** em `infra/` (VPC, RDS Multi-AZ, ElastiCache, ECS/Fargate ou EKS, S3 cifrado, KMS, Secrets Manager, WAF, CloudFront) | P0 | ❌ | "a criar" desde a rodada 1 |
| I3 | **Resolver o build da API** (`packages/shared` em TS puro) e gerar imagem Docker única por SHA | P0 | ❌ | Sem isso não há deploy |
| I4 | CD: staging automático a cada merge; produção por promoção manual da mesma imagem | P0 | ❌ | |
| I5 | Backups: PITR do RDS, teste de restauração mensal, RPO ≤ 15 min, RTO ≤ 4 h | P0 | 📋 | Metas já definidas; nunca testadas na AWS |
| I6 | Observabilidade sem dado de saúde: OpenTelemetry, logs estruturados, Sentry com `beforeSend` que remove corpo e cabeçalhos | P0 | ❌ | Sentry é suboperador estrangeiro (J7), ou usar alternativa hospedada no Brasil |
| I7 | Alertas e plantão (quem acorda às 3 h) + runbooks de incidente (prazo de 3 dias úteis para comunicar à ANPD) | P0 | 📋 | Runbooks listados em [requisitos-tecnicos-seguranca](../03-seguranca-lgpd/requisitos-tecnicos-seguranca.md) §13 |
| I8 | Erro 25006 (banco somente leitura) virar 503 | P1 | ❌ | Pendência §6.4 |
| I9 | Status page pública (SUP-01.6) e roadmap público (SUP-01.7) | P1 | ❌ | Fazem parte da D9 |
| I10 | E-mail transacional com domínio próprio (SPF, DKIM, DMARC), de preferência com dados no Brasil | P0 | ❌ | Necessário para login, convite e recuperação de senha |
| I11 | Proteção da `main` (plano pago do GitHub) + usuário do sócio no `CODEOWNERS` | P1 | ❌ | Risco nº 9 do relatório geral |
| I12 | Teste de falha de zona (Multi-AZ) e DR em outra região | P2 | ❌ | Só depois que I2 existir |
| I13 | Orçamento mensal de infraestrutura | P0 | ❌ | ESTIMATIVA: fazer na AWS Pricing Calculator quando I2 tiver tamanho definido |

### 2.4 Integrações obrigatórias para o nicho de entrada (fisio/TO + psico)

| # | Item | Prio | Estado | O que muda com a pesquisa de hoje |
|---|---|---|---|---|
| N1 | **NFS-e** via provedor (Focus, eNotas, PlugNotas, NFE.io) já no **padrão nacional** | P0 (clínica PJ) | ❌ | §3.1: padrão nacional em transição desde jan/2026 |
| N2 | **Receita Saúde** para profissional PF | P0 (autônomo PF) | ❌ | §3.2: obrigatório desde 01/01/2025. Ainda não há desenho de integração |
| N3 | **Gateway de pagamento (D5)** com Pix + **Pix Automático** para a assinatura do próprio SaaS | P0 | ❌ | §3.4 |
| N4 | **WhatsApp Cloud API** (lembrete e confirmação) com templates aprovados | P0 | ❌ | §3.3: cobrança em reais por mensagem |
| N5 | Assinatura ICP-Brasil em nuvem (BirdID, VIDaaS etc.) | P1 | ❌ | Necessária para NGS2 e documentos assinados |
| N6 | TISS (guias) | P1 (controle de guia simples já no M1) | ❌ | §3.7: versão 04.03.00 obrigatória desde 01/07/2026 |
| N7 | Prescrição: Memed e **SNCR** | P2 para o nicho de entrada; P0 se entrar medicina | ❌ | §3.8 |
| N8 | Teleconsulta (D6, LiveKit) | P2 | ❌ | Fase 2 |

### 2.5 Produto mínimo para o piloto

Tudo isso já está no [backlog do MVP](../02-produto/backlog-mvp.md) (M0 + M1: 79 histórias, 377 pontos). O que precisa estar pronto **antes do primeiro paciente real**:
- cadastro de clínica, profissional e paciente; agenda (inclusive simultânea); evolução/prontuário por especialidade (fisio e psico); pacotes e controle de guia simples; financeiro básico; exportação total (G2) pela tela, com MFA;
- **migração/importação** de dados dos concorrentes. Mercado de troca: 92% já usam sistema. Sem importador não há venda. **Não conferi se esse item está como P0 no backlog: verificar na rodada 8**;
- onboarding guiado e suporte (canal, SLA, base de conhecimento). As queixas nº 1 do mercado são suporte lento e cancelamento difícil;
- PWA do portal do paciente (POR-03.1): pode ficar para P1. **Não há aplicativo nativo previsto, e não é preciso publicar em App Store ou Play Store para o MVP.**

### 2.6 Certificações (trilha, não bloqueio do piloto)

| Certificação | Para quê | Prio | Nota |
|---|---|---|---|
| **SBIS S-RES NGS1** e depois **NGS2** | Permitir que a clínica médica dispense o papel (CFM 1.821/2007); argumento de venda | P2 (NGS1 como meta do 1º ano) | §3.9 |
| ISO/IEC 27001 / 27701 | Venda para clínicas maiores e redes | P2 | Já listada como trilha futura |
| ISO/IEC 42001 | Gestão de IA | P2 | Idem |

---

## 3. O que a pesquisa de hoje mudou (10/10/2026)

### 3.1 NFS-e: padrão nacional em transição
- **FATO:** a LC 214/2025 (reforma tributária) obriga os municípios a aderir ao ambiente nacional da NFS-e a partir de jan/2026, por emissor próprio integrado ou pelo emissor nacional gratuito. Quem não aderir perde transferências voluntárias da União. Em 2025, cerca de 1.472 municípios já tinham aderido, somando ~70% das emissões. Fontes: [Contábeis](https://www.contabeis.com.br/noticias/71679/nfs-e-nacional-sera-obrigatoria-para-municipios-a-partir-de-2026/), [Reforma Tributária: adesão de 1.472 municípios](https://www.reformatributaria.com/tecnologia/governo-informa-adesao-de-1-472-municipios-a-nfs-e-nacional/).
- **A CONFIRMAR:** há leitura jurídica de que a obrigação de 2026 é só de compartilhar dados, e não de migrar a emissão ([Reforma Tributária: a verdade por trás da obrigatoriedade](https://www.reformatributaria.com/nfse-nacional-em-2026-a-verdade-por-tras-da-obrigatoriedade-e-migracao-dos-municipios/)).
- **Impacto:** reforça usar provedor de NFS-e (N1) em vez de integrar prefeitura por prefeitura. Critério de escolha do provedor: suporte ao padrão nacional e aos campos de IBS/CBS.

### 3.2 Receita Saúde: obrigatório para profissional PF
- **FATO:** desde 01/01/2025, médicos, dentistas, psicólogos, fisioterapeutas, fonoaudiólogos e terapeutas ocupacionais que atendem como **pessoa física** devem emitir o recibo pelo Receita Saúde. O papel acabou. Quem atende por CNPJ emite NFS-e. Recibos de 2025 podiam ser regularizados até 28/02/2026. Fontes: [Fenacon](https://fenacon.org.br/noticias/profissionais-de-saude-devem-regularizar-recibos-eletronicos-de-2025-ate-fevereiro-de-2026/), [COAD](https://www.coad.com.br/home/noticias-detalhe/135981/prazo-para-emissao-do-recibo-eletronico-receita-saude-ano-calendario-2025).
- **ESTIMATIVA:** pela mesma regra, atendimentos de 2026 vão até 28/02/2027.
- **Impacto:** o **psicólogo autônomo** (metade do nicho de entrada) é PF. O produto precisa ao menos gerar o relatório de recibos a emitir e conciliar o que foi emitido. **A CONFIRMAR:** se a Receita oferece API para terceiros. A pesquisa não achou API pública; se não houver, o MVP faz "lista do que falta emitir + atalho" e não a emissão automática. A D2 promete "Receita Saúde incluso", então isso precisa estar claro antes da página de preço.

### 3.3 WhatsApp: cobrança por mensagem e em reais
- **FATO (Meta):** desde 01/07/2025 a cobrança é **por mensagem entregue**, por categoria (marketing, utilidade, autenticação). Mensagens de serviço dentro da janela aberta pelo cliente são grátis. Desde 01/07/2026 clientes com faturamento no Brasil podem ser cobrados em **BRL**, e as WABAs elegíveis precisam migrar para BRL até 30/06/2027, ou a Meta para de entregar. Fonte: [Meta — Pricing on the WhatsApp Business Platform](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing).
- **A CONFIRMAR (fontes comerciais divergem):** utilidade entre R$ 0,04 e R$ 0,08 por mensagem e marketing por ~R$ 0,38–0,39 ([Hyperleap](https://hyperleap.ai/whatsapp-pricing-calculator-brazil), [Message Central](https://www.messagecentral.com/blog/whatsapp-business-api-pricing-brazil)). Usar a tabela oficial da Meta para o modelo de custo.
- **Impacto:** lembrete e confirmação de consulta devem ser **templates de utilidade**, nunca de marketing (custa de 5 a 8 vezes mais). Isso afeta a D2 (WhatsApp incluso no preço). ESTIMATIVA: uma clínica com 400 consultas/mês e 2 mensagens por consulta gasta entre R$ 32 e R$ 64 por mês só de Meta.

### 3.4 Pix Automático para a assinatura do SaaS
- **FATO (documentação do Asaas):** o Pix Automático já está em produção para recorrência. Na "Jornada 3", um único QR paga a 1ª cobrança e autoriza as seguintes. Desde 19/05/2026 o Asaas gera as próximas cobranças sozinho com `paymentCreationMode: SUBSCRIPTION`. Fonte: [Asaas — Pix Automático](https://docs.asaas.com/docs/pix-automatico), [changelog](https://docs.asaas.com/changelog/pix-automático-cobranças-recorrentes-automatizadas).
- **Lacuna:** não achei a documentação equivalente da Efí. Comparar antes de fechar a D5.
- **Impacto:** a D5 deve ser decidida em duas partes: (a) cobrança do **nosso** SaaS (Pix Automático + cartão) e (b) cobrança da **clínica ao paciente** (Pix, boleto e split).

### 3.5 IA: "Claude no Bedrock São Paulo" não é dado no Brasil
- **FATO (documentação da Anthropic e da AWS):** em `sa-east-1`, Claude só está disponível pelo endpoint **Global**, que pode processar em qualquer região. Não há opção *in-region* nem *geo* para São Paulo. Fonte: [Claude in Amazon Bedrock](https://platform.claude.com/docs/build-with-claude/claude-in-amazon-bedrock), [AWS — Regional availability](https://docs.aws.amazon.com/it_it/bedrock/latest/userguide/models-region-compatibility.html).
- **FATO (Google):** o Vertex AI tem garantia de processamento em `southamerica-east1` para modelos Gemini listados na tabela de residência, **desde que se chame o endpoint regional e não o global**. Conferir o modelo exato na tabela. Fonte: [Vertex AI — Data residency](https://cloud.google.com/vertex-ai/generative-ai/docs/learn/data-residency).
- **Impacto na D3:** confirma a recomendação atual. Dado sensível vai para Gemini regional em São Paulo ou para Maritaca/Sabiá. Claude e GPT só com dado pseudonimizado e cláusulas-padrão (J7). Adicionar ao gateway de IA uma **trava técnica que recusa endpoint global** para requisições com dado sensível.

### 3.6 ANVISA e ANPD: regulação em movimento
- **FATO:** a Anvisa incluiu a revisão da regulação de SaMD (RDC 657/2022) na Agenda Regulatória 2026–2027, com mecanismos específicos para IA. Não achei consulta pública aberta. Fontes: [Mattos Filho](https://www.mattosfilho.com.br/unico/inteligencia-artificial-dispositivos-medicos/), [Migalhas — CFM 2.454/26](https://www.migalhas.com.br/depeso/451919/ia-na-medicina-riscos-regulatorios-da-resolucao-cfm-2-454-26).
- **FATO:** a ANPD tem "dados de saúde" na Agenda Regulatória 2025–2026 (Res. CD/ANPD 23/2024). Não achei norma final. **A CONFIRMAR:** a meta de pelo menos 10 fiscalizações em saúde, biometria e finanças até o fim de 2026. Fontes: [Legismap](https://legismap.com.br/conteudos/artigos-e-noticias/anpd-amplia-rigor-sobre-dados-de-saude-e-biometria-alerta-advogada), [Convergência Digital](https://convergenciadigital.com.br/governo/conselho-quer-foco-da-anpd-em-criancas-saude-alto-risco-e-seguranca/).
- **Impacto:** manter o escriba como "rascunho que o profissional revisa e assina" e **não** oferecer sugestão de CID ou diagnóstico no MVP até o parecer J8.

### 3.7 TISS: versão 04.03.00
- **FATO (comunicação de operadora citando a ANS):** a versão 04.03.00 do Padrão TISS é obrigatória desde **01/07/2026**. Os componentes organizacionais de jul/2026 e set/2026 já estão publicados. Fontes: [Unimed — Informativo TISS 04/2026](https://www.unimed.coop.br/site/web/planaltomedio/informativo-tiss-n-04-2026), [ANS — Componente Organizacional 202609](https://www.gov.br/ans/pt-br/assuntos/prestadores/padrao-para-troca-de-informacao-de-saude-suplementar-2013-tiss/PadroTISS_ComponenteOrganizacional_202609.pdf).
- **Impacto:** o gerador TISS deve nascer em 04.03.00, com a versão como dado (`tiss_guide.tiss_version`, já previsto), e com uma rotina mensal para checar nova versão.

### 3.8 Receita controlada: SNCR da Anvisa
- **FATO:** a RDC 1.000/2025 cria o **SNCR**, com numeração nacional para notificações de receita, receitas de controle especial e receitas sujeitas à retenção (antimicrobianos, GLP-1). Receita eletrônica desses tipos **só vale se emitida por serviço de prescrição integrado ao SNCR**. Controle especial exige assinatura ICP-Brasil; retenção aceita assinatura avançada (gov.br). Em 27/05/2026 o prazo foi adiado para **30/09/2026**, já vencido. Fontes: [CFF](https://site.cff.org.br/noticia/Noticias-gerais/27/05/2026/anvisa-prorroga-para-30-de-setembro-o-prazo-do-novo-sistema-de-receitas-controladas), [Afya](https://portal.afya.com.br/saude/prescricao-eletronica-rdc1000-25).
- **A CONFIRMAR:** a publicação da prorrogação no DOU (uma fonte cita a RDC 1.028/2026) e um suposto período de transição até 29/10.
- **Impacto:** **não fazer prescrição nativa de controlados**. Para medicina, integrar com quem já é integrado ao SNCR (Memed, Nexodata etc.) e exigir isso por contrato. Para o nicho de entrada (fisio/TO + psico) o tema não se aplica, porque essas profissões não prescrevem medicamentos.

### 3.9 SBIS: manual 5.2 ainda em uso
- **FATO:** certificados emitidos até ago/2026 ainda citam o **Manual de Certificação 2021 v5.2**. Existe menção a uma v5.3 sem confirmação de vigência. NGS1 e NGS2 estão em uso, e a validade inicial aparente é de ~2 anos. Fontes: [Certificado SBIS 206](https://sbis.org.br/wp-content/uploads/2026/08/Certificado_SBIS_SRES_206_PRONTU.pdf), [Certificado SBIS 194](https://sbis.org.br/wp-content/uploads/2026/06/Certificado_SBIS_SRES_194_SOSDOCS.pdf).
- **Lacuna:** custo e prazo não são públicos. Pedir a cotação em sbis@sbis.org.br.

---

## 4. Documentos que precisam ser atualizados (dívida desta rodada)

| Documento | O que falta | Dono |
|---|---|---|
| [integracoes.md](../04-arquitetura/integracoes.md) | Seções novas: **Receita Saúde**, **SNCR**, **Pix Automático**, TISS 04.03.00, WhatsApp por mensagem em BRL | Engenharia |
| [03-seguranca-lgpd/README.md](../03-seguranca-lgpd/README.md) | Mapa regulatório: incluir RDC 1.000/2025 + SNCR, LC 214/2025 (NFS-e), Receita Saúde, Agenda Anvisa 2026–2027 | Guardião |
| [05-ia-llm](../05-ia-llm/) | Registrar que Bedrock sa-east-1 é só Global e a trava contra endpoint global | IA |
| [decisoes.md](../00-governanca/decisoes.md) | Dividir a D5 em (a) cobrança do SaaS e (b) cobrança da clínica; incluir a D10: escopo do Receita Saúde no MVP | Maestro |
| [backlog-mvp.md](../02-produto/backlog-mvp.md) | Conferir se o **importador de dados dos concorrentes** está como P0 | Produto |

Nesta rodada não editei esses documentos, para manter o commit só com o relatório. Isso fica para a próxima rodada.

---

## 5. Novos riscos (complementam o top 10 do relatório geral)

| # | Risco | Mitigação |
|---|---|---|
| R11 | Prometer "Receita Saúde incluso" (D2) sem API pública para emitir | Confirmar a API antes da página de preço; se não houver, vender como "controle do que falta emitir" |
| R12 | Custo do WhatsApp corroer a margem se templates forem classificados como marketing | Só templates de utilidade; medir o custo por clínica desde o piloto |
| R13 | Uso acidental do endpoint global de LLM com dado sensível | Trava no gateway de IA + teste automatizado |
| R14 | Entrar em medicina sem integração ao SNCR | Medicina só na onda 4; nunca prescrição nativa de controlados |
| R15 | Nenhuma infraestrutura de produção a ~3 semanas do início previsto do MVP (nov/2026) | Terraform e build da API na próxima rodada, em paralelo à D4 |

---

## 6. Ordem recomendada (até 3 agentes por rodada)

**Antes de qualquer código, os sócios precisam:** decidir a **D4**, contratar o advogado (**D8**), agendar as entrevistas da **D1/D2** e nomear o **DPO** (J4).

**Rodada 8: fundação de produção** (não depende da D4)
- `devops-ci`: I3 (build da API + imagem Docker) e o esqueleto de I2 (Terraform da conta `staging`: VPC, RDS, Redis, ECS, Secrets Manager), sem aplicar em produção.
- `engenharia`: S7 (rate limit em Redis), I8 (25006 → 503) e os PRs do Dependabot de risco baixo e médio (#14, #15, #17, #24).
- `guardiao-lgpd`: atualizar o mapa regulatório (§4) e começar o RIPD do produto (J3).

**Rodada 9: M0 de identidade** (depende da D4)
- `engenharia`: S2–S4 (login, MFA, RBAC) e I10 (e-mail transacional).
- `qa-testes`: isolamento para as tabelas novas e E2E do login.
- `guardiao-lgpd`: revisar o PR de auth e a política de retenção (D7/J12).

**Rodada 10: M0 completo + integrações do nicho**
- `engenharia`: S5–S6 (criptografia de campo, auditoria encadeada), N3 (gateway, depois da D5) e N1 (provedor de NFS-e).
- `produto`: importador de dados dos concorrentes + desenho do Receita Saúde (N2).
- `devops-ci`: I4–I7 (CD, backups testados, observabilidade, alertas) e preparação do pentest (S8).

---

## 7. Fontes consultadas nesta rodada
- Meta — WhatsApp pricing: https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing
- Hyperleap — calculadora WhatsApp Brasil: https://hyperleap.ai/whatsapp-pricing-calculator-brazil
- Message Central — WhatsApp Brasil: https://www.messagecentral.com/blog/whatsapp-business-api-pricing-brazil
- Contábeis — NFS-e nacional 2026: https://www.contabeis.com.br/noticias/71679/nfs-e-nacional-sera-obrigatoria-para-municipios-a-partir-de-2026/
- Reforma Tributária — adesão dos municípios: https://www.reformatributaria.com/tecnologia/governo-informa-adesao-de-1-472-municipios-a-nfs-e-nacional/
- Reforma Tributária — leitura divergente: https://www.reformatributaria.com/nfse-nacional-em-2026-a-verdade-por-tras-da-obrigatoriedade-e-migracao-dos-municipios/
- Fenacon — Receita Saúde: https://fenacon.org.br/noticias/profissionais-de-saude-devem-regularizar-recibos-eletronicos-de-2025-ate-fevereiro-de-2026/
- COAD — Receita Saúde: https://www.coad.com.br/home/noticias-detalhe/135981/prazo-para-emissao-do-recibo-eletronico-receita-saude-ano-calendario-2025
- SBIS — certificados 194 e 206: https://sbis.org.br/wp-content/uploads/2026/06/Certificado_SBIS_SRES_194_SOSDOCS.pdf · https://sbis.org.br/wp-content/uploads/2026/08/Certificado_SBIS_SRES_206_PRONTU.pdf
- Anthropic — Claude in Amazon Bedrock: https://platform.claude.com/docs/build-with-claude/claude-in-amazon-bedrock
- AWS — Bedrock regional availability: https://docs.aws.amazon.com/it_it/bedrock/latest/userguide/models-region-compatibility.html
- Google — Vertex AI data residency: https://cloud.google.com/vertex-ai/generative-ai/docs/learn/data-residency
- Mattos Filho — IA em dispositivos médicos: https://www.mattosfilho.com.br/unico/inteligencia-artificial-dispositivos-medicos/
- Migalhas — CFM 2.454/26: https://www.migalhas.com.br/depeso/451919/ia-na-medicina-riscos-regulatorios-da-resolucao-cfm-2-454-26
- Legismap — ANPD e dados de saúde: https://legismap.com.br/conteudos/artigos-e-noticias/anpd-amplia-rigor-sobre-dados-de-saude-e-biometria-alerta-advogada
- Convergência Digital — CNPD e ANPD: https://convergenciadigital.com.br/governo/conselho-quer-foco-da-anpd-em-criancas-saude-alto-risco-e-seguranca/
- Unimed — Informativo TISS 04/2026: https://www.unimed.coop.br/site/web/planaltomedio/informativo-tiss-n-04-2026
- ANS — Componente Organizacional 202609: https://www.gov.br/ans/pt-br/assuntos/prestadores/padrao-para-troca-de-informacao-de-saude-suplementar-2013-tiss/PadroTISS_ComponenteOrganizacional_202609.pdf
- CFF — prorrogação do SNCR: https://site.cff.org.br/noticia/Noticias-gerais/27/05/2026/anvisa-prorroga-para-30-de-setembro-o-prazo-do-novo-sistema-de-receitas-controladas
- Afya — RDC 1.000/2025: https://portal.afya.com.br/saude/prescricao-eletronica-rdc1000-25
- Asaas — Pix Automático: https://docs.asaas.com/docs/pix-automatico · https://docs.asaas.com/changelog/pix-automático-cobranças-recorrentes-automatizadas
