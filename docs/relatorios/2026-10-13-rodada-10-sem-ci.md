# Relatório da Rodada 10: o que destrava o projeto enquanto o CI está parado

**Data:** 13/10/2026 · **Responsável:** Maestro (sessão @Rocafa) · **Agentes:** 3 de no máximo 3 (engenharia, pesquisa-mercado, guardiao-lgpd)
**Contexto:** o GitHub Actions parou na noite de 12/10 por billing da conta, e PR de código não entra sem CI verde. A rodada focou no que trava o projeto e **não depende de CI**: as três decisões mais urgentes dos sócios.

## Entregas (todas na `main`)

| Entrega | Arquivo | Commit | Para destravar |
|---|---|---|---|
| **Recomendação da D4: Better Auth** | [memos/D04-recomendacao.md](../00-governanca/memos/D04-recomendacao.md) | `16906cb` | Login, MFA, permissões, telas ligadas à API e exportação real |
| **Kit de entrevistas com clínicas** | [01-mercado/kit-entrevistas/](../01-mercado/kit-entrevistas/) | `aa50995` | D1 (nicho) e D2 (preço) |
| **Pacote para o advogado** | [03-seguranca-lgpd/pacote-advogado.md](../03-seguranca-lgpd/pacote-advogado.md) | `dc44c99` | D8 (contratar o advogado), que trava o piloto com dado real |

### D4: login
- **Recomendação:** Better Auth. Na PoC, a clínica ativa fica na sessão do servidor, e uma clínica enviada pelo navegador foi ignorada. No Zitadel, o caminho usual de troca de clínica é por cabeçalho do cliente, ou seja, o caminho fácil é o inseguro. O Better Auth também não cria um serviço a mais para operar e guarda os dados de login no nosso Postgres.
- **6 regras que viram requisito:**
  1. a clínica vem sempre da sessão, nunca do cliente;
  2. MFA obrigatório para perfis clínicos, financeiros e admin, e MFA recente para prontuário e exportação;
  3. sessão curta e revogável (troca o "refresh rotativo" e **precisa do aval do Guardião**);
  4. schema de login separado, sem o CLI oficial, e bloqueio de tentativas em Redis;
  5. login do portal do paciente separado do da clínica;
  6. versão fixada e revisão mensal de avisos de segurança.
- **Depois do "sim":** cerca de 2 a 3 semanas de código.
- **Não medido na PoC:** custo AWS, passkey real no navegador e login do portal.
- **3 perguntas aos sócios:**
  1. Aprovam o Better Auth com as 6 regras?
  2. Algum cliente do 1º ano vai exigir SSO corporativo?
  3. O paciente entra no portal por SMS/WhatsApp ou por e-mail?

### D1 e D2: entrevistas
- **Quem:** 8 a 10 entrevistas em 2 semanas (13/10 a 26/10): 4–5 de fisio/TO, 2–3 psicólogos e 1–2 de TEA, encontrados por canais públicos, sem raspagem de dados pessoais.
- **Roteiro:** estilo "Mom Test", que pergunta sobre o comportamento real do passado e não sobre opiniões. Cada pergunta está ligada a uma hipótese (H1–H10).
- **Preço:** calculado pelo método Van Westendorp, em que cada clínica diz a partir de que valor o produto parece barato demais, caro e caro demais.
- **Critérios de "decidido":** definidos no README. Os percentuais são critérios nossos, não dado de mercado.
- **Limite:** as hipóteses de TEA (H3, H9) ficam inconclusivas com só 1–2 clínicas.
- **Antes da 1ª entrevista:** o termo de consentimento passa pelo Guardião LGPD (revisão em andamento nesta rodada).

### D8: advogado
- **Escopo:** 30 itens em 3 lotes. **Lote 1:** 14 itens que travam o piloto com dado real. **Lote 2:** 11 itens antes do lançamento. **Lote 3:** 5 itens para depois.
- **Mapeamento:** 171 marcas ⚖️ no repositório. A tabela cobre as que trazem pergunta jurídica, ligadas a um lote.
- **Urgente:**
  - a pergunta **1.11** (prontuário único da psicologia) trava a arquitetura do prontuário: resposta pedida em 2 semanas;
  - o **acordo de sócios e CNPJ** (1.14) estão no Lote 1, porque o contrato com as clínicas e o RIPD precisam da razão social. Pode ser feito por outro escritório.
- **Contratação:** o pacote traz perfil do escritório ideal e perguntas para comparar propostas. Horas por lote são **ESTIMATIVA**, sem valores em reais (pedir 2 a 3 propostas).

## Estado geral
- **Parado por billing do Actions:** #43 (Agenda e Pacientes, pronto), #54 (economia de minutos), #49–#53 (Dependabot).
- **Com o sócio:** correções B1–B3 das telas vetadas (#44, #46, #47).

## O que os sócios fazem agora (sem código)
1. **Ler e decidir a D4** (15 minutos) e responder as 3 perguntas do memo.
2. **Mandar o pacote do advogado** para 2 ou 3 escritórios e pedir proposta.
3. **Marcar as primeiras entrevistas**, depois que o termo de consentimento for aprovado.
4. **Resolver o billing do GitHub**, para o CI voltar.
