# O que ainda falta: visão consolidada depois da Rodada 8

**Data:** 12/10/2026 · **Autor:** Maestro (sessão local do Matheus) · **Base:** `main` em `bbe26b4` + 21 PRs abertos + branches remotas.
**Fontes:** [estado da rodada 8](2026-10-12-estado-rodada-8.md) (escrito às 3h, antes de 10 merges), os PRs #27–#47, os commits da `main`, [decisoes.md](../00-governanca/decisoes.md) e os memos em `docs/00-governanca/memos/`.

> **Resumo em 4 linhas**
> 1. A **fundação técnica está forte**: isolamento por clínica, criptografia por clínica, auditoria encadeada, garantia de saída, 9 checks no CI, testes de ataque, carga e resiliência.
> 2. **Ainda não existe produto que uma clínica possa usar**: as telas (#42–#47) rodam com dados fictícios e a API não tem nenhuma rota de negócio.
> 3. **A decisão D4 (login) é o gargalo.** Sem ela não dá para ligar telas à API, ter permissões, MFA ou exportação real.
> 4. Do lado do negócio faltam **entrevistas com clínicas, advogado, DPO e nome/marca**. Nada disso depende de código.

---

## 1. Conferência: o que a Rodada 8 resolveu desde o relatório das 3h
Entraram na `main` (CI verde) os PRs #27, #28, #29, #30, #32, #34, #35, #37, #39, #40 e #48. **Os ajustes exigidos foram feitos antes de cada merge:**
- **Revisor:** B1 (destruição de chave em duas fases), B2–B4 (auditoria), B5 (GRANT por coluna na guarda de schema);
- **Guardião:** R1–R4 do rate limit e R1/R2 da IA (consentimento com 3 estados, avaliação de risco CFM).

Também resolvidos: **build definitivo da API**, **erro 25006 → 503**, **rate limit em Redis**, **NestJS 12**, **@Lopesloro no CODEOWNERS** (#48).

---

## 2. Fila imediata: PRs abertos (falta revisar, ajustar e mergear)

| Ordem sugerida | PR | Estado | O que falta |
|---|---|---|---|
| 1 | **#41** eventos de chave usam `key_*` (0006) | CI 9/9 | Revisão e merge (complementa o #40, que já entrou) |
| 2 | **#38** pareceres LGPD, mapa regulatório, matriz de retenção, RIPD da IA e do WhatsApp | ❌ **Conflito com a `main`** | Rebase. Existe a branch `lgpd/mapa-regulatorio-rebase`, mas ela não virou PR. Fechar o #38 e abrir o PR do rebase, ou atualizar o #38 |
| 3 | **#31** bloco 1 do Dependabot (CodeQL v4, upload-artifact, helmet) | CI 9/9 | Merge. Depois fechar #14, #15, #17, #24 (os individuais #17 e #24 falham porque o CodeQL v4 exige `init` e `analyze` juntos) |
| 4 | **#33** bloco 3 do Dependabot (ESLint 10, globals 17, Vitest 5, @types/supertest 7) | CI 9/9 | Merge depois do #31. Depois fechar #16, #19, #21, #22, #26 |
| — | **#18** @types/node 26 | CI verde, mas **recusado de propósito** (o runtime é Node 22) | Fechar com comentário e ignorar `@types/node >= 23` no `dependabot.yml` |
| 5–10 | **#42 → #47** telas do front (em pilha) | CI 9/9 cada | **Revisão do Guardião** em #42, #44, #46 e #47. Merge na ordem, trocando a base para `main`. Pontos levantados pelo próprio front: (a) a ficha mostra o **telefone inteiro**; (b) a lista de pacientes fica **em memória na aba** |
| — | **#36** PoC da D4 (rascunho) | Só registro | Fechar depois da decisão D4 |

---

## 3. 🟡 Começado e parado

| Item | O que existe | O que falta |
|---|---|---|
| **Terraform do staging** | Branch `devops/terraform-staging-b` (VPC 3 AZs, RDS Multi-AZ, Redis, ECS, ALB, S3, KMS, OIDC) | Abrir o PR; workflow `infra.yml` (fmt, validate, tflint, checkov); Redis privado com TLS e AUTH; âncora da auditoria em S3 Object Lock em conta separada; KEK por clínica no KMS |
| **Imagem Docker da API** | Só o levantamento | Dockerfile, `.dockerignore` e workflow `imagem.yml` |
| **E2E do front no CI** | 117+ testes Playwright rodam localmente | Job no CI (DevOps) |
| **Golden sets de IA** | 8 casos por nicho (fisio/TO e psicologia) | Pelo menos 50 por nicho, com **revisão clínica** de um profissional (gate do M3) |
| **Bug do postgres.js 3.4.9** | Rascunho com reprodução mínima | Reportar ao projeto e acompanhar, para remover o patch |
| **Rate limit** | R1–R4 resolvidos | R5: teste do `trustProxyHops`, que depende da topologia do ALB |
| **Auditoria encadeada** | Hash por clínica com verificador | Âncora externa imutável (depende do Terraform) e prazo da trilha (depende da D7) |

---

## 4. ⬜ Ainda não começou

### 4.1 Produto utilizável (o maior buraco)
- **Rotas de negócio na API**: clínica, profissional, paciente, agenda (inclusive atendimento simultâneo), atendimento e prontuário por nicho, pacotes, guias, financeiro. **Hoje a API só tem `/health`.**
  - **O contrato já existe:** a interface `ApiClinica` do front (#42). O caminho natural é implementar a API seguindo essa interface e trocar o adaptador fake pelo real.
- **Auditoria de leitura e escrita de prontuário** (interceptor) e **criptografia ligada às colunas reais** do prontuário. Hoje a cripto existe, mas não protege nenhum campo de negócio, porque eles ainda não existem.
- **Importador de dados dos concorrentes.** O mercado é de troca de sistema: sem importador, não há venda.
- **Testes E2E de ponta a ponta reais** (login → agenda → evolução → recibo), quando houver backend.

### 4.2 Bloqueado por decisão dos sócios
| Item | Decisão |
|---|---|
| Login, MFA, perfis e permissões (RBAC) e e-mail transacional (convite, recuperação, alerta "não fui eu") | **D4**, a mais urgente; a PoC já mediu Zitadel × Better Auth |
| Adaptador real de LLM, pseudonimização pt-BR antes do LLM, escriba | **D3** + condições do Guardião |
| Pix, cartão, Pix Automático | **D5** |
| Receita Saúde em lote, NFS-e nacional, receita de controlados (SNCR) | **D14**, **D10** |
| WhatsApp Cloud API real | Conta Meta + RIPD do WhatsApp (#38) |

### 4.3 Infraestrutura e operação
- **Ambientes:** staging automático a cada merge e produção por promoção manual (CD).
- **Monitoramento:** observabilidade sem dado de saúde, alertas, plantão e runbooks.
- **Banco de verdade:** restauração e failover testados no RDS real; teste de falha de zona.
- **Transparência:** status page e roadmap público (D9).
- **Proteção da `main`** (exige plano pago do GitHub).

### 4.4 LGPD, jurídico e certificações
- **Contratar o advogado** (D8): valida DPA, Carta de Compromissos, matriz de retenção, RIPDs, termos e enquadramento Anvisa da IA.
- **Nomear o encarregado (DPO)** com canal público.
- **Termos de uso, política de privacidade** e termo de confidencialidade para quem acessa produção.
- **Pentest externo** antes do piloto (orçamento na D13).
- **Trilha SBIS** (D12) e inscrição no CRM, se aplicável (D11).

### 4.5 Negócio: não aparece em nenhum documento do repositório (sugestão do Maestro)
- **Validar com clínicas:** 5 a 10 entrevistas para fechar D1 (nicho) e D2 (preço). O roteiro está pronto no relatório de mercado.
- **Recrutar as 5 clínicas parceiras de design** da onda 0 do plano de piloto.
- **Nome do produto e marca:** a visão ainda diz `[nome do produto]`; falta busca no INPI e domínio.
- **Estrutura da empresa:** CNPJ, conta PJ, **acordo de sócios** (participação, papéis, vesting, saída) e contas oficiais (AWS, Meta Business, PSP de pagamento, e-mail) no nome da empresa, não de pessoa física.
- **Landing page** com lista de espera, quando houver nome e Carta aprovada.

---

## 5. Decisões dos sócios, por urgência
1. **D4: login.** Desbloqueia a ligação das telas à API, permissões, MFA, exportação real e e-mail. Insumo: memo D04 e PoC #36.
2. **D8: advogado** e **DPO (J4).** Destravam o piloto com dado real, o DPA, a Carta e os termos.
3. **D1 e D2: nicho e preço.** Pedem as entrevistas da §4.5.
4. **D13: orçamento** de infraestrutura e pentest.
5. **D3: provedor de LLM** no Brasil.
6. **D7: retenção da auditoria.** Já há proposta: 20 anos para a auditoria de prontuário, 5 anos para a administrativa, 12 meses para logs de acesso.
7. **D5, D9, D10–D12, D14:** um memo de 1 página cada em `docs/00-governanca/memos/`.

---

## 6. Higiene do projeto (achados desta leitura)
- **Dois Maestros em paralelo:** a sessão na nuvem do @Lopesloro e a sessão local do @Rocafa. Para não trabalharem nos mesmos PRs, propomos:
  - um único arquivo de fila na `main` (`docs/00-governanca/fila.md`) com quem pegou cada item;
  - a regra "quem abriu o PR faz o merge, salvo pedido";
  - as ordens das abas, hoje em `~/Documents/Dev/projetos/.maestro/` no Mac do sócio e fora do git, também versionadas, para os dois verem.
- **Documentos desatualizados:**
  - `RELATORIO-GERAL.md` vai só até a rodada 5;
  - `decisoes.md` lista D1–D9, mas os memos já vão até D14;
  - a página da orquestra (`orquestra.html`) e o `CONTEXTO.md` não mencionam a rodada 8 nem as telas.
- **PRs do Dependabot acumulados:** 13 abertos, que serão absorvidos pelos blocos #31 e #33. Fechar os individuais depois, para a lista de PRs voltar a ser útil.

---

## 7. Próximas rodadas sugeridas (até 3 agentes cada)
| Rodada | Agente 1 | Agente 2 | Agente 3 |
|---|---|---|---|
| **9 — Fila e higiene** | `revisor-codigo` + Maestro: merge #41, #31, #33; rebase do #38; fechar Dependabot | `guardiao-lgpd`: revisar #42, #44, #46, #47 → merge das telas | Maestro: atualizar RELATORIO-GERAL, decisoes.md (D10–D14), CONTEXTO, orquestra, `fila.md` |
| **10 — Infra** | `devops-ci`: PR do Terraform + `infra.yml` | `devops-ci`: Dockerfile + `imagem.yml` + E2E no CI | `engenharia`: relatar o bug do postgres.js; teste R5 |
| **11 — Produto real** *(depois da D4)* | `engenharia`: login/RBAC/MFA conforme a D4 | `engenharia`: rotas de clínica, paciente e agenda seguindo a `ApiClinica` | `qa-testes`: E2E real do login à agenda + auditoria de prontuário |
