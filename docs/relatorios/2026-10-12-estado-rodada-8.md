# Estado do projeto: rodada 8 (12/10/2026, 03h)

**Responsável:** Maestro (sessão na nuvem) · **Base:** `main` em `cec77ed`, PRs #29 a #38, branch `devops/terraform-staging-b` e arquivos de status das 4 abas.
**Escopo da rodada:** CONTEXTO.md §5 a §9 (LGPD, tecnologia, IA, decisões), em 4 abas do Terminal: ENG, DevOps, LGPD e QA.

**Legenda:**
- ✅ feito e na `main`;
- 🟢 feito, com PR verde, esperando ajuste pequeno ou a vez de entrar;
- 🟡 pela metade;
- ⬜ falta, não começou;
- ⚖️ depende do advogado (D8);
- 🧑‍💼 depende de decisão dos sócios.

---

## 1. ✅ Feito e já na `main`

### Rodadas 1 a 6 (antes desta)
- Pesquisa de mercado (11 segmentos), PRD, WBS (332 micropartes), roadmap, backlog do MVP (176 histórias), garantias G1 a G9.
- Fundação do código:
  - monorepo pnpm e Turborepo;
  - API NestJS com `/health` e `/health/ready`;
  - site Next.js (só a página inicial);
  - PostgreSQL com isolamento por clínica (RLS forçado e `withTenant`).
- Garantia de saída em código: status de assinatura, exportação total e `audit_log` append-only.
- Testes de segurança e de produção:
  - 74 ataques ao banco e à API, mais o OWASP ZAP;
  - resiliência, backup e restauração, e carga com k6.
- CI com 9 checks, Actions fixadas por SHA e TypeScript 6.

### Rodada 7, que entrou em 11/10 às 14h44
- **#27:** relatório consolidado das necessidades de produção. Traz o checklist P0/P1/P2, os portões A, B e C, o custo estimado e as decisões novas D10 a D14.
- **#28:** documentos de LGPD:
  - ressalvas M1 a M6 das garantias aplicadas;
  - RIPD da plataforma;
  - minuta do contrato de operador (DPA);
  - proposta de retenção e descarte (D7);
  - plano de resposta a incidente (3 dias úteis);
  - checklist da Res. CFM 2.454/2026.

---

## 2. 🟢 Feito, com PR verde (CI 9/9), na fila de merge

| PR | O que entrega | O que falta para entrar | Quem |
|---|---|---|---|
| **#34** guarda de schema | Teste que lê o catálogo do banco e falha se alguma tabela ficar sem RLS forçado, sem policy, com privilégio a mais ou fora do teste de isolamento. Testado com 8 mutações: a guarda pegou todas | Ajuste do Revisor (B5): usar `has_any_column_privilege`, porque hoje um GRANT por coluna passa despercebido. Também tornar os testes independentes do idioma do Postgres | QA |
| **#30** pendências de produção | Build definitivo (`node dist/main.js` sobe sem carregador), erro 25006 vira 503, rate limit compartilhado em Redis com fallback, rascunho do bug do postgres.js 3.4.9 | Guardião **sem veto**, mas o merge fica condicionado a 2 ressalvas: **R2** (o store em memória guarda o IP em claro) e **R3** (sem `REDIS_URL` em produção só aparece um aviso; precisa ser erro). Antes de tráfego externo: **R1** (HMAC com segredo no lugar de SHA-256 puro) | ENG |
| **#32** NestJS 12 | Atualização para o NestJS 12.1.2, testada em conjunto com o #30 | Nada. Entra logo depois do #30 | Maestro |
| **#37** auditoria encadeada | Cada registro de auditoria carrega o hash do anterior, por clínica, calculado por trigger no banco, mais um verificador. Detecta alteração, exclusão e reordenação | Ajustes do Revisor: **B2**, a aplicação e o banco medem o tamanho do metadata de jeitos diferentes; **B3**, a heurística de dado pessoal deixa passar CPF com `_` ou `/`, números de até 9 dígitos e espaço NBSP; **B4**, a trigger só funciona em READ COMMITTED. Mais: `created_at` forçado a `now()` | ENG |
| **#35** criptografia por clínica | AES-256-GCM com chave por clínica (envelope). Destruir a chave deixa os dados da clínica ilegíveis, inclusive nos backups. Já tem as ressalvas R1 a R6 do Guardião aplicadas | Ajustes do Revisor: **B1**, a destruição no KMS acontece antes do COMMIT (se o COMMIT falhar, a clínica perde os dados sem alerta); FK composta; declarar `tenant_master_keys` e `tenant_data_keys` na guarda e no `schema.ts` | ENG |
| **#29** IA | Golden sets sintéticos (8 casos de fisio/TO e 8 de psicologia), protocolo do gate do M3, interface de LLM com adaptador falso, 14 memorandos de decisão (D1 a D14) | O merge fica condicionado a 2 ressalvas do Guardião: **R1**, consentimento de IA com 3 estados ("não informado" também nega); **R2**, classificação de risco dos arts. 12 e 13 da CFM 2.454. Há **veto prévio** a registrar o `AiModule` ou a um adaptador real antes das condições do parecer | QA (cobrindo a frente de IA) |
| **#38** LGPD | Pareceres de #29, #30, #35 e #37; mapa regulatório atualizado; matriz de retenção por conselho (J13); RIPD da IA (escriba) e do WhatsApp; linha do rate limit no ROPA | **Conflito com a `main`** depois do #28: precisa de rebase | LGPD |
| **#31** e **#33** (Dependabot, blocos 1 e 3) | Actions do CodeQL e upload-artifact, helmet, ESLint 10, globals 17, Vitest 5. Fecham os PRs #14 a #26 | Conflito com o #30 (`package.json` e lockfile): rebase depois que o #30 entrar. O #18 (@types/node 26) foi recusado de propósito, porque o runtime é Node 22 | ENG |
| **#36** PoC da D4 *(rascunho, só para registro)* | Zitadel v4.19.4 contra Better Auth 1.7.7, medidos em 14 critérios. Resultados no memo D04 | Não vai para a `main` como código. Serve de insumo para a decisão da D4 | — |

**Ordem de merge decidida:** #34 → #30 → #32 → #37 → #35 → #29 → #38 → #31 → #33.
Os PRs #14 a #26 do Dependabot fecham sozinhos com os blocos.

**Achados da PoC da D4 (FATO medido; não decidem nada):**
- **Zitadel:**
  - o access token vem com 12 h por padrão, e os 15 min do requisito exigem configuração;
  - a troca de clínica mais usada é por cabeçalho enviado pelo cliente. Se ele for escolhido, vira regra escrita: o `withTenant` lê o claim do token assinado, nunca o cabeçalho;
  - sobe em 1,4 s.
- **Better Auth:**
  - sessão em cookie opaco, sem refresh rotativo (é outro desenho, não uma falha);
  - o cabeçalho de clínica enviado pelo cliente é ignorado;
  - a recuperação de conta não revela se o e-mail existe;
  - o CLI oficial está atrás da biblioteca e puxa uma versão vulnerável dela, só como dependência de desenvolvimento.
- **Não medido**, porque exige navegador: fluxo `authorization_code`, passkey real e detecção de reuso de refresh token.

---

## 3. 🟡 Pela metade

- **Terraform do staging (DevOps-B).**
  - **O que existe:** o branch `devops/terraform-staging-b`, commit `724bbc0`, com 1.931 linhas:
    - VPC em 3 AZs, RDS PostgreSQL 16 Multi-AZ cifrado, Redis, ECS Fargate com ALB, S3, KMS, OIDC do GitHub;
    - estado remoto;
    - bootstrap do RDS com `REVOKE TEMPORARY` e um script de teste.
  - **Falta:**
    - abrir o PR;
    - o workflow `infra.yml` (fmt, validate, tflint, checkov);
    - os requisitos novos do Guardião: Redis privado, com TLS e AUTH (item 22); âncora da auditoria em S3 com Object Lock em conta separada (R2 do #37); uma KEK por clínica no KMS (#35).
  - **Parado** desde 11/10 às 14h58 por limite de uso da conta. Já recebeu a ordem de retomar.
- **Imagem Docker da API (DevOps-A).**
  - **O que existe:** só o levantamento:
    - o build depende do #30;
    - `migrate.mjs` e as migrações precisam ir na imagem;
    - usuário 1000:1000;
    - o certificado do RDS é baixado no build com checksum.
  - **Falta:** o Dockerfile, o `.dockerignore` e o workflow `imagem.yml` inteiros.
  - O Mac não tem Docker: a prova da imagem é feita pelo Maestro na nuvem e pelo CI.
- **Rate limit do #30.** R1 (HMAC), R4 (log e métrica quando o limite falha aberto) e R5 (teste do `trustProxyHops`, que depende da topologia definida pela DevOps).
- **Auditoria (#37).**
  - **R2:** âncora externa imutável, que depende da DevOps;
  - **R3:** prazo da trilha, que depende da D7 🧑‍💼;
  - **R4:** ações novas no enum (`key_*`, uso e recusa de IA, break-glass). A ENG está autorizada a fazer, numa migração 0006.
- **Golden sets de IA.** São 8 casos por nicho, mas o gate do M3 exige pelo menos 50, com revisão clínica de um profissional do nicho.
- **Bug do postgres.js 3.4.9.** O rascunho com reprodução mínima está pronto; ainda não foi reportado ao projeto.

---

## 4. ⬜ Falta (não começou)

### Bloqueado por decisão dos sócios
- **Login, MFA e RBAC (S2 a S4)**: depende da **D4** 🧑‍💼. Sem isso não existe nenhuma tela de negócio nem a rota HTTP de exportação com MFA recente (G2).
- **E-mail transacional com domínio próprio** (I10): login, convite, recuperação de senha e o alerta "não fui eu".
- **Adaptadores reais de LLM** (Vertex São Paulo ou Maritaca): dependem da **D3** 🧑‍💼 e do veto prévio do Guardião.
- **Pix, cartão e Pix Automático** (N3): dependem da **D5** 🧑‍💼.

### Engenharia e produto
- Interceptor geral de auditoria (leitura e escrita de prontuário) e a criptografia ligada às colunas reais de prontuário.
- Pseudonimização em pt-BR antes de qualquer LLM (microparte `ia/pseudonimizacao-ptbr`).
- **Telas e rotas de negócio:** cadastro de clínica, profissional e paciente; agenda (inclusive simultânea); prontuário por especialidade; pacotes e guias; financeiro. **Hoje não existe nenhuma tela.**
- Importador de dados dos concorrentes: é um mercado de troca de sistema, sem importador não há venda.
- Arquivo de lote do Receita Saúde (N2, D14), NFS-e no padrão nacional (N1) e WhatsApp Cloud API (N4).
- Testes E2E com Playwright, do login à evolução no prontuário (S11).

### Infraestrutura e operação
- CD: staging automático a cada merge e produção por promoção manual (I4).
- Observabilidade sem dado de saúde, alertas, plantão e runbooks (I6 e I7).
- Restauração e failover testados no RDS de verdade (I5); teste de falha de zona (I12).
- Status page e roadmap público (I9).
- Proteção da `main` com plano pago e o usuário do sócio no `CODEOWNERS` (I11).

### LGPD, jurídico e certificações
- **Contratar o advogado** (D8) ⚖️. Ele valida o DPA, a Carta de Compromissos, a matriz de retenção, os RIPDs e o enquadramento Anvisa da IA.
- **Nomear o encarregado (DPO)** com canal público (J4) 🧑‍💼. Trava o plano de incidente e o RIPD.
- Termos de uso, política de privacidade e termo de confidencialidade para quem acessa produção (J5 e J6).
- **Pentest externo** antes do piloto (S8): orçamento na D13 🧑‍💼.
- Trilha de certificação SBIS S-RES (D12).

---

## 5. 🧑‍💼 Decisões dos sócios em aberto

| # | Decisão | Situação |
|---|---|---|
| **D4** | Autenticação | **A mais urgente.** A PoC da D4 já mediu Zitadel e Better Auth (§2). Falta escolher |
| **D8** | Contratar o advogado de saúde + LGPD | Trava o piloto com dado real, o DPA e a publicação da Carta |
| **D1** e **D2** | Nicho de entrada e preço | Precisam de 5 a 10 entrevistas com clínicas |
| **D13** | Orçamento de infraestrutura e pentest | Inclui uma KEK por clínica no KMS, ESTIMATIVA de US$ 1 a 3 por clínica por mês |
| **D7** | Retenção da auditoria | Proposta: 20 anos para a auditoria de prontuário, 5 anos para a administrativa, 12 meses para logs de acesso |
| **D3** | Provedor de LLM no Brasil | Gemini São Paulo ou Maritaca |
| **D5**, **D9**, **D10** a **D12**, **D14** | Pix, Carta de Compromissos, SNCR, inscrição no CRM, SBIS, Receita Saúde | Memorandos de 1 página em `docs/00-governanca/memos/` (no PR #29) |
| **J4** | Nomear o DPO | — |

---

## 6. Como a orquestra está rodando

- **As 4 abas trabalham em `/loop`.** A cada volta, cada uma:
  - lê as próprias ordens em `~/Documents/Dev/projetos/.maestro/ordens-<frente>.md`;
  - avança o trabalho;
  - escreve o andamento em `status-<frente>.md`.
- **Regra fixa:** nenhuma aba abre menu de pergunta. Dúvida vai para o status.
- **O Maestro:**
  - lê os status e o GitHub e testa cada branch separadamente;
  - pede a revisão de código (Revisor, N1) antes do merge;
  - faz os merges na ordem da §2.
- **O Guardião LGPD continua com veto absoluto:** nenhum PR com veto entra sem decisão dos sócios.
- **Testes isolados por aba:** o Mac não tem Docker, então cada aba roda o próprio Postgres e Redis nativos, com porta e pasta de dados próprias (ENG 5441, DevOps 5442, QA 5444).
- **Limitação conhecida:** os ciclos agendados do Maestro só rodam quando esta conversa está ativa. Durante a madrugada de 11 para 12/10, as abas seguiram sozinhas pelo `/loop`.
