# 05 — IA / LLM: estratégia

> Frente IA/LLM do SaaS de gestão para clínicas (medicina, odonto, psico, nutri, fisio, estética, fono/TEA).
> Versão 1.0 — outubro/2026. Preços e status regulatórios pesquisados em set–out/2026 (fontes ao final). Revisar a cada trimestre: preços de modelos caem e versões mudam rápido.

> **Convenção FATO × ESTIMATIVA (AGENTS.md §6):** preços de fornecedores, normas e datas são **FATO** com fonte ao final de cada documento. Custos por clínica, custos de fase, volumes e prazos são **ESTIMATIVA** do executor N3 (premissas explícitas no texto) e devem ser recalculados com dados reais.
> **Governança:** esta é uma entrega N3 da frente 🤖 IA/LLM. Tudo que envolve dado de saúde (datasets, prompts, subprocessadores) depende de aprovação do 🛡️ Guardião LGPD antes do merge; decisões de fase/orçamento são dos sócios (N0).

Documentos desta pasta:

| Arquivo | Conteúdo |
|---|---|
| `README.md` (este) | Conceitos para leigos, estratégia em fases, custos, LGPD |
| [`casos-de-uso.md`](casos-de-uso.md) | Cada funcionalidade de IA: modelo, entrada/saída, risco, guarda-corpos, humano no loop |
| [`dados-e-treino.md`](dados-e-treino.md) | Origem dos dados, anonimização, rotulagem, governança, o que nunca fazer |
| [`avaliacao-e-seguranca.md`](avaliacao-e-seguranca.md) | Métricas, evals, red-teaming, monitoramento, ANVISA/CFM/PL 2338 |
| [`arquitetura-ia.md`](arquitetura-ia.md) | Pipeline, gateway de modelos, cache, custo por consulta |

---

## 1. Resumo executivo (para os sócios)

**"Usar uma LLM e ela vai ser treinada"** é possível, mas a palavra "treinar" esconde quatro coisas muito diferentes, com custos que vão de **centavos por consulta** a **milhões de dólares**. A recomendação é:

1. **Fase 1 (0–6 meses): API + RAG + prompts bem feitos.** Lança o produto, gera receita e — mais importante — começa a coletar, *com consentimento e de forma anonimizada*, os dados de correção dos profissionais. Custo de IA estimado: **R$ 0,30 a R$ 0,70 por consulta** com escriba.
2. **Fase 2 (6–18 meses): fine-tuning leve (LoRA/QLoRA) de um modelo open-weight**, só nas tarefas onde as avaliações mostrarem que a API não basta ou que o custo/volume justifica (ex.: sugestão de CID/TUSS, extração de exames, estilo de evolução por nicho).
3. **Fase 3 (18+ meses): modelo próprio ajustado e hospedado no Brasil**, para os fluxos com dado sensível mais pesado, quando houver volume que pague GPUs dedicadas (estimativa: de ~75–160 mil consultas/mês se substituir rota Claude a ~320–700 mil se substituir Gemini Flash; ver `arquitetura-ia.md` §4.4) — ou antes, se um cliente exigir processamento 100% no Brasil.
4. **Treinar um modelo do zero: não.** Custa dezenas de milhões, exige equipe de pesquisa e não traz vantagem para o nosso problema.

A "IA que aprende com a clínica" acontece desde o dia 1 — não por treinar pesos do modelo, mas por **memória (RAG), modelos/templates por nicho, few-shot com exemplos aprovados e um ciclo de avaliação contínua** alimentado pelas correções dos profissionais.

---

## 2. As quatro formas de "ter uma IA" — explicado para leigos

Analogia: o modelo de linguagem (LLM) é um **profissional recém-formado muito culto**.

### (a) LLM de API com *prompt engineering*
**O que é:** alugamos o "cérebro" de um grande fornecedor (Anthropic Claude, OpenAI GPT, Google Gemini, Maritaca Sabiá) e mandamos instruções bem escritas a cada pedido ("Você é um assistente de prontuário de fisioterapia; organize esta transcrição no formato SOAP; nunca invente dados...").
**Analogia:** contratar um consultor brilhante por hora e entregar um **manual de procedimentos** a cada atendimento.
**O modelo aprende?** Não altera os pesos. Mas melhora muito com instruções, exemplos e formato de saída estruturado.

| Prós | Contras |
|---|---|
| Começa em dias; qualidade de ponta | Custo por uso (escala com volume) |
| Zero infraestrutura de GPU | Dependência de fornecedor (mitigar com gateway multi-modelo) |
| Modelos melhoram sozinhos a cada versão | Dados saem do nosso ambiente → LGPD (transferência internacional, se fora do Brasil) |

### (b) RAG — *Retrieval-Augmented Generation* (geração com busca)
**O que é:** antes de perguntar ao modelo, o sistema **busca** os trechos relevantes numa base nossa (tabela CID-10, TUSS, protocolos, histórico do próprio paciente, modelos de laudo da clínica) e coloca no pedido. O modelo responde "com a consulta aberta na mesa".
**Analogia:** o consultor agora tem acesso à **biblioteca e ao prontuário** na hora de responder.
**Por que é essencial em saúde:** reduz alucinação, permite **citar a fonte** ("CID F84.0 — conforme tabela CID-10 DATASUS"), e atualiza conhecimento sem retreinar (nova tabela TUSS = reindexar, não retreinar).

| Prós | Contras |
|---|---|
| Conhecimento sempre atualizado e auditável | Qualidade depende da busca (indexação, *chunking*) |
| Isolamento por clínica (cada tenant busca só nos seus dados) | Mais componentes (banco vetorial, embeddings) |
| Barato (embeddings custam centavos) | Não muda "estilo" nem raciocínio do modelo |

### (c) Fine-tuning (LoRA / QLoRA) de modelo *open-weight*
**O que é:** pegamos um modelo aberto (Qwen 3.5, Llama 4, Gemma 4, Mistral Small 4, DeepSeek; ou brasileiros como a família Sabiá da Maritaca, quando o fornecedor oferecer ajuste) e fazemos um **treino complementar** com milhares de exemplos nossos (entrada → saída ideal). **LoRA** treina só pequenos "adaptadores" (≈0,1–1% dos parâmetros); **QLoRA** faz isso com o modelo comprimido (4 bits), cabendo numa única GPU.
**Analogia:** uma **residência/especialização**: o recém-formado passa meses com nossos preceptores e passa a escrever exatamente no estilo e no formato que queremos.

| Prós | Contras |
|---|---|
| Modelo menor fica ótimo numa tarefa específica (ex.: extrair laudo → JSON) | Precisa de **dados rotulados de qualidade** (o caro é o dado, não a GPU) |
| Pode rodar **100% no Brasil**, em infraestrutura nossa | Precisamos operar GPUs (MLOps, plantão, escalabilidade) |
| Custo marginal baixo em alto volume | Modelo "congela" — cada melhoria exige novo ciclo de treino/avaliação |
| Independência de fornecedor | Raramente supera um modelo de ponta em raciocínio geral |

### (d) Treinar um modelo do zero (*pre-training*)
**O que é:** criar um LLM novo a partir de trilhões de palavras.
**Analogia:** fundar uma **faculdade de medicina** para formar um único profissional.
**Custo:** dezenas a centenas de milhões de dólares em GPUs, meses de treino, equipe de pesquisa dedicada. Mesmo modelos nacionais (ex.: Sabiá) partem de bases existentes e fazem *continued pre-training* em português.
**Veredito:** **fora de escopo.** Não há vantagem competitiva para um SaaS de gestão.

### Tabela comparativa

| | (a) API + prompt | (b) RAG | (c) Fine-tune LoRA | (d) Do zero |
|---|---|---|---|---|
| Tempo até produção | dias | 2–6 semanas | 2–4 meses (incl. dados) | anos |
| Custo inicial | ~R$ 0 | R$ 5–30 mil (eng.) | R$ 80–250 mil (rotulagem + eng. + GPU) | US$ 10M+ |
| Custo recorrente | por token | por token + banco vetorial | GPU 24×7 (R$ 15–40 mil/mês com redundância) ou serverless | — |
| Dados ficam no Brasil? | depende do fornecedor/região | base sim; inferência depende | **sim** (se hospedado no BR) | — |
| Quando usar | sempre como ponto de partida | sempre que houver conhecimento de referência | tarefa estreita, alto volume, ou exigência de residência | nunca (para nós) |

> **(a), (b) e (c) não são excludentes.** A arquitetura-alvo combina os três: RAG alimentando um modelo (de API ou próprio), escolhido por um **gateway** por tarefa, custo e sensibilidade do dado.

---

## 3. Estratégia em fases

### Fase 1 — API + RAG + humano no loop (meses 0–6)

**Objetivo:** lançar funcionalidades de IA com segurança, medir valor e montar o *flywheel* de dados.

- Funcionalidades: escriba clínico (áudio → rascunho SOAP/evolução), resumo do paciente, sugestão CID-10/TUSS com citação, extração de exames (PDF/foto → campos), chatbot WhatsApp **administrativo** (agendamento, confirmação, dúvidas operacionais), previsão de faltas (**ML clássico**, sem LLM). Detalhes em [`casos-de-uso.md`](casos-de-uso.md).
- Modelos (via **gateway** — ver [`arquitetura-ia.md`](arquitetura-ia.md)):
  - **Rota "dado sensível / residência BR":** Gemini via Vertex AI em endpoint **regional `southamerica-east1`** (o Google documenta processamento de ML na região do endpoint regional; **não** usar endpoint global) e/ou **Maritaca Sabiá-4 / Sabiazinho-4** (empresa brasileira; confirmar contratualmente local de processamento e retenção).
  - **Rota "qualidade máxima", com pseudonimização prévia:** Claude Sonnet 5.5 / Haiku 4.5 (Anthropic) ou GPT-5.x — aceitando **transferência internacional** amparada por cláusulas-padrão da ANPD (Res. CD/ANPD 19/2024), DPA e retenção zero quando disponível.
    - Atenção: no Amazon Bedrock, a região `sa-east-1` (São Paulo) só oferece **endpoint Global** para Claude — a inferência pode ser roteada para fora do Brasil. Endpoints regionais (com residência) existem hoje só em regiões dos EUA, UE, Japão e Austrália. Portanto, Claude = transferência internacional em qualquer caminho, hoje.
  - STT (transcrição): Deepgram Nova-3, OpenAI gpt-4o-transcribe/mini, AssemblyAI ou Whisper/derivados auto-hospedados no BR (avaliar WER em PT-BR clínico antes de decidir).
- **Tudo é rascunho**: nada entra no prontuário sem o profissional revisar e assinar.
- Coleta de dados para a Fase 2: guardar (com base legal e anonimização — ver [`dados-e-treino.md`](dados-e-treino.md)) pares *rascunho da IA → versão final aprovada*. **Esse diff é o ativo mais valioso da empresa em IA.**
- Avaliação desde o dia 1: conjunto de testes ("evals") por funcionalidade e por nicho.

**Custos Fase 1 (estimativa):**

| Item | Estimativa |
|---|---|
| IA por consulta com escriba (STT 15 min + LLM) | R$ 0,30–0,70 (ver cálculo em `arquitetura-ia.md`) |
| Resumo/CID/extração | R$ 0,01–0,10 por chamada |
| Clínica média (4 profissionais, ~600 consultas/mês com escriba) | ~R$ 200–450/mês de custo direto |
| Engenharia (2 devs + 0,5 ML/eng. de dados + consultoria clínica/jurídica) | R$ 60–110 mil/mês (custo de pessoal, não de IA) |
| Banco vetorial (pgvector no Postgres existente) | ~R$ 0 adicional na escala inicial |

Sugestão de precificação: IA como **add-on por profissional** (ex.: R$ 79–199/mês), margem bruta-alvo > 70% sobre o custo de tokens.

### Fase 2 — Fine-tuning em dados anonimizados (meses 6–18)

**Gatilhos para entrar** (pelo menos um):
- eval mostra que a melhor API + RAG não atinge a meta numa tarefa (ex.: precisão top-3 de CID < 85% em algum nicho);
- custo de API de uma tarefa de alto volume > custo de servir um modelo menor;
- cliente/segmento exige processamento 100% no Brasil (hospitais, operadoras, governo).

**O que fazer:**
- Escolher 1–2 tarefas **estreitas e bem avaliáveis**: extração estruturada de exames, sugestão CID/TUSS, normalização de evolução no padrão do nicho, classificação de intenção do chatbot.
- Modelo base: open-weight de 7–35B parâmetros com licença comercial limpa (Apache 2.0: Qwen, Mistral, Gemma 4; MIT: DeepSeek; Llama tem licença própria — checar cláusulas). Testar 2–3 candidatos com bom português.
- Técnica: **QLoRA/LoRA** + opcionalmente **destilação** (usar um modelo grande, em dados sintéticos/anonimizados, para gerar exemplos de treino do modelo pequeno — verificar se os termos de uso do fornecedor permitem).
- Dados: 2–10 mil exemplos por tarefa, **anonimizados, revisados por profissionais** do nicho.
- Infra de treino: GPU sob demanda (1× H100/A100 por algumas horas a dias por rodada) — **US$ 50–500 por rodada de treino**; o grosso do custo é rotulagem.

**Custos Fase 2 (estimativa):**

| Item | Estimativa |
|---|---|
| Rotulagem/revisão clínica (5 mil exemplos × R$ 10–30) | R$ 50–150 mil por tarefa |
| Engenheiro(a) de ML dedicado | R$ 25–40 mil/mês |
| GPU para treino (várias rodadas) | US$ 1–5 mil no período |
| Serving inicial (serverless/endpoint gerenciado ou 1 GPU L40S/H100) | R$ 5–25 mil/mês |

### Fase 3 — Modelo próprio hospedado no Brasil (18+ meses)

- Modelo(s) ajustado(s) da Fase 2 servido(s) em **nuvem com região São Paulo** (AWS `sa-east-1`, Google `southamerica-east1`, Azure Brazil South, OCI São Paulo) ou provedores nacionais, com vLLM/TGI, autoscaling, 2+ GPUs para alta disponibilidade.
- Gateway passa a mandar **por padrão** os fluxos com dado identificável ao modelo nacional; APIs externas ficam para tarefas não sensíveis, para *fallback* e como "professor" na geração de dados sintéticos.
- **Ponto de equilíbrio:** GPUs dedicadas custam R$ 15–40 mil/mês (2 GPUs + operação). Se o custo de API das rotas migradas for menor que isso, **não migre por custo** — migre só por exigência regulatória/comercial.
- Diferencial comercial: "IA clínica processada 100% no Brasil" — argumento forte para redes, hospitais e operadoras.

### O que **não** recomendamos
- Treinar do zero.
- Fine-tuning **antes** de ter evals e um baseline com API + RAG (sem eval, não se sabe se o fine-tune melhorou ou piorou).
- Treinar com dados de clientes sem base legal, sem contrato e sem anonimização (ver [`dados-e-treino.md`](dados-e-treino.md)).
- Qualquer funcionalidade que **diagnostique, prescreva ou comunique conduta ao paciente** sem um profissional no meio — vedado pela Resolução CFM 2.454/2026 e potencialmente SaMD pela ANVISA (ver [`avaliacao-e-seguranca.md`](avaliacao-e-seguranca.md)).

---

## 4. LGPD — pontos que decidem a arquitetura

| Tema | O que diz / implica | Decisão |
|---|---|---|
| **Dado de saúde é dado sensível** (LGPD art. 5º II e art. 11) | Tratamento só com base do art. 11 (ex.: tutela da saúde por profissionais/serviços de saúde; consentimento específico) | Clínica = **controladora**; nós = **operadora**. IA para o atendimento cabe na finalidade do serviço; **uso para treino** é outra finalidade → exige base própria (ver `dados-e-treino.md`) |
| **Transferência internacional** (art. 33; Res. CD/ANPD 19/2024) | Enviar dado pessoal a servidor fora do Brasil só com mecanismo válido — na prática, **cláusulas-padrão contratuais da ANPD** incorporadas ao contrato com o fornecedor | Mapear cada subprocessador (Anthropic, OpenAI, Google, Deepgram...) e onde processa; contratos com cláusulas-padrão; listar subprocessadores no DPA com as clínicas |
| **Pseudonimização ≠ anonimização** (art. 12) | Transcrição de consulta quase nunca é anônima de verdade (relatos de vida, nomes de familiares, locais). Dado pseudonimizado **continua sendo dado pessoal** | Mesmo removendo nome/CPF antes de enviar à API, tratar como transferência de dado pessoal sensível |
| **Retenção zero / não uso para treino** | Fornecedores de API corporativa em geral não treinam com dados de API por padrão; alguns oferecem *Zero Data Retention* (ZDR) mediante contrato. Atenção: alguns modelos de ponta exigem retenção de 30 dias (ex.: a Anthropic informa que o Claude Fable 5.1 não está disponível sob ZDR sem autorização) | Exigir por contrato: não uso para treino, retenção mínima/zero, deleção, região. Preferir modelos elegíveis a ZDR para dado clínico |
| **Hospedagem nacional** | Elimina a discussão de transferência internacional para a inferência | Fase 1: rotas regionais BR (Vertex `southamerica-east1`, Maritaca); Fase 3: modelo próprio no BR |
| **Direitos do titular / revisão de decisão automatizada** (art. 20) | Paciente pode pedir revisão de decisões tomadas unicamente por tratamento automatizado | Nenhuma decisão clínica é automática; previsão de falta não pode gerar penalidade automática ao paciente |
| **Guarda de prontuário** (Lei 13.787/2018: mínimo 20 anos) | Áudio bruto não precisa virar prontuário | Política: apagar áudio após transcrição aprovada (ex.: 7–30 dias), manter só o texto assinado |

> Validar este quadro com o DPO/jurídico (frente `03-seguranca-lgpd`). Este documento é técnico, não parecer jurídico.

---

## 5. Decisões a tomar pelos sócios

1. Aprovar Fase 1 com **gateway multi-fornecedor** (não casar com um só modelo).
2. Política de dados: **opt-in contratual** da clínica (e, quando aplicável, do paciente) para uso de dados anonimizados na melhoria dos modelos.
3. Contratar **revisores clínicos por nicho** (meio período / por demanda) — são eles que "treinam" de verdade a IA.
4. Definir a meta que dispara a Fase 2 (ex.: 50 clínicas ativas com escriba ou exigência de cliente âncora).
5. Nomear um **responsável técnico (médico) e um comitê de IA** (exigência prática da Res. CFM 2.454/2026 e boa governança).

---

## Fontes

- Preços e modelos Claude (Opus 5.5 US$ 4/20, Sonnet 5.5 US$ 2/10, Haiku 4.5 US$ 1/5 por milhão de tokens; ZDR): documentação Anthropic — [platform.claude.com/docs](https://platform.claude.com/docs/en/about-claude/pricing) (consultado em out/2026).
- Claude no Amazon Bedrock, regiões e tipos de endpoint (São Paulo = só Global; regionais com +10%): [Claude in Amazon Bedrock](https://platform.claude.com/docs/build-with-claude/claude-in-amazon-bedrock).
- Gemini no Vertex AI, endpoint regional `southamerica-east1` e residência de dados: [Vertex AI — locations](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/locations), [Data residency](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/data-residency).
- Maritaca (Sabiá-4: R$ 5/R$ 20; Sabiazinho-4: R$ 1/R$ 4 por milhão de tokens): [maritaca.ai/en/api](https://www.maritaca.ai/en/api).
- GPT-5 mini (US$ 0,25/2,00) e Gemini 2.5 Flash (US$ 0,30/2,50): [pricepertoken — GPT-5 mini](https://pricepertoken.com/pricing-page/model/openai-gpt-5-mini), [pricepertoken — Gemini 2.5 Flash](https://pricepertoken.com/pricing-page/model/google-gemini-2.5-flash), [morphllm — OpenAI pricing 2026](https://morphllm.com/openai-api-pricing).
- Modelos open-weight 2026 (Qwen 3.5, Gemma 4, Llama 4, Mistral Small 4/Large 3 Apache 2.0, DeepSeek V4): [BenchLM — best open source LLM](https://www.benchlm.ai/blog/posts/best-open-source-llm), [Featherless — best open source LLMs 2026](https://featherless.ai/blog/best-open-source-llms-2026).
- Preços de GPU (H100 mediana ~US$ 3/h; OCI H100 US$ 10,75/h; L40S): [Spheron — H100 price 2026](https://www.spheron.network/blog/h100-price-per-hour-2026/), [Spheron — GPU cloud LatAm 2026](https://www.spheron.network/blog/gpu-cloud-brazil-mexico-latin-america-2026/).
- Transferência internacional — Res. CD/ANPD 19/2024: [Demarest](https://www.demarest.com.br/anpd-aprova-o-regulamento-de-transferencia-internacional-de-dados/), [Migalhas](https://www.migalhas.com.br/coluna/migalhas-de-protecao-de-dados/414287/breve-analise-sobre-a-transferencia-internacional-de-dados).
- Resolução CFM 2.454/2026: [Mattos Filho](https://www.mattosfilho.com.br/unico/cfm-ia-medicina/), [Demarest](https://www.demarest.com.br/cfm-publica-resolucao-que-regulamenta-o-uso-de-inteligencia-artificial-na-medicina/), [Mayer Brown](https://www.mayerbrown.com/pt/insights/publications/2026/03/brazilian-cfm-issues-resolution-on-the-use-of-artificial-intelligence-in-medicine).
