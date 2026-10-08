# Nicho: Nutrição

> Frente: Pesquisa de Mercado · Executor N3 · Pesquisa realizada em 2026-10-06 (todas as fontes acessadas nessa data, salvo indicação).
> Legenda: **[FATO]** = dado publicado por fonte identificada · **[ESTIMATIVA]** = número aproximado/projeção de terceiros ou nossa · **[INFERÊNCIA]** = conclusão nossa a partir dos fatos · **[NÃO VERIFICADO]** = apareceu em busca, mas a página primária não foi aberta/confirmada.

## 1. Tamanho do mercado

| Indicador | Valor | Tipo | Fonte (data) |
|---|---|---|---|
| Nutricionistas inscritos no Sistema CFN/CRN | 194.018 (fev/2024) | FATO | [Perfil da Nutrição no Brasil – CFN](https://pesquisa.cfn.org.br/) |
| Crescimento de inscritos 2021→2024 | ~158 mil → ~194 mil (+22%) | FATO reportado por imprensa | [Jornal O Candeeiro](https://www.jornalocandeeiro.com.br/noticia-35200-pesquisaconfirmacrescimentode22denutricionistasnobrasil) |
| Inscritos em jul/2025 | 220.152 | NÃO VERIFICADO (trecho de busca; página primária não confirmada) | busca em [CRN-1 – Indicadores do Sistema CFN/CRN 2025](https://novoportal.crn1.org.br/relatorio-de-gestao-2025/indicadores-do-sistema-cfn-crn/) — a página aberta mostrou apenas dados regionais do CRN-1 (17.967 nutricionistas ativos em DF/GO/MT/TO em 2025) |
| Nutricionistas com vínculo formal (RAIS 2022) | 54.282; remuneração média R$ 4.156 (R$ 4.516 deflacionado p/ dez/2024); 41,7% em empresas privadas | FATO | [DIEESE/FNN – Perfil dos Nutricionistas no Brasil, mar/2025](https://www.fnn.org.br/arquivos/noticias/relatorio-nutricionistas-2025.pdf) |
| Pesquisa CFN (2016, amostra 1.104): ~29,7% atuam em nutrição clínica; 10,6% autônomos | FATO (antigo) | [pesquisa.cfn.org.br](https://pesquisa.cfn.org.br/) |

**[INFERÊNCIA]** ~194 mil inscritos vs. ~54 mil com carteira assinada ⇒ a maior parte atua como autônomo/PJ, em consultório próprio, online ou fora da profissão. É o maior contingente entre os nichos não médicos analisados, mas altamente pulverizado (profissional solo), com baixa renda média — ARPA baixo.

## 2. Perfil do cliente, ticket, convênio x particular

- **Cliente típico do software:** nutricionista autônomo (solo), atendimento presencial + online; minoria em clínicas multiprofissionais/academias. **[INFERÊNCIA]**
- **Ticket da consulta:** avaliação inicial R$ 150–400 nas capitais; planos de acompanhamento mensal R$ 300–700 — **[ESTIMATIVA]** de matéria jornalística (não pesquisa estruturada): [Monitor do Mercado, 2026](https://monitordomercado.com.br/noticias/399238-quanto-um-nutricionista-cobra-por-consulta-e-acompanhamento-mensal-em-2026-e-a-diferenca-entre-clinico-e-esportivo/).
- **Renda:** entre nutricionistas clínicos (CFN 2016), 36,9% ganhavam 3–5 salários mínimos e 32,6% 1–3 SM — **[FATO, antigo]** ([pesquisa.cfn.org.br](https://pesquisa.cfn.org.br/)).
- **Convênio x particular:** predominantemente **particular**. Nutrição não é dedutível no IRPF e nutricionistas **não** estão obrigados ao Receita Saúde — **[FATO]** ([CFN, sobre Receita Saúde](https://cfn.org.br/sobre-a-exigencia-do-nutricionista-no-sistema-receita-saude/)). Cobertura de consulta com nutricionista por planos existe pelo Rol, mas remuneração baixa faz o consultório viver de particular **[INFERÊNCIA]**.

## 3. Dores e rotina

- Montagem de plano alimentar demorada (cálculo de macros/micros, substituições, lista de compras). **[INFERÊNCIA a partir das features que os líderes vendem]**
- Adesão do paciente entre consultas (diário alimentar, lembretes de hidratação, chat) — principal alavanca de retenção/receita recorrente.
- Captação via Instagram/WhatsApp; agenda e confirmação por WhatsApp.
- Restrições éticas de marketing (sem antes/depois, sem promessa de resultado) dificultam publicidade — ver seção 5.
- Venda de "planos de acompanhamento" (pacote mensal/trimestral) com cobrança recorrente.

## 4. Requisitos específicos de software

| Requisito | Detalhe |
|---|---|
| Cálculo de dieta | Base de alimentos (TACO/TBCA, IBGE, rótulos), cálculo de macro/micronutrientes, GET/TMB (Harris-Benedict, Mifflin etc.), substituições, receitas, lista de compras |
| Antropometria | Protocolos de dobras (Pollock 3/7, Jackson, Durnin), circunferências, bioimpedância (importação), gráficos de evolução |
| Anamnese/recordatório | Recordatório 24h, frequência alimentar, questionário pré-consulta enviado por link |
| Exames | Solicitação e registro de exames laboratoriais |
| Prescrição | Suplementos/fitoterápicos (quando habilitado) com assinatura digital |
| App do paciente | Plano alimentar no celular, diário alimentar com foto, hidratação, metas, chat — **é o diferencial competitivo nº 1 do nicho** (Dietbox, WebDiet) |
| Teleconsulta | Vídeo integrado + registro em prontuário (telenutrição) |
| Planos de acompanhamento | Venda de pacote mensal, cobrança recorrente (cartão/Pix) |
| Materiais | Templates de orientações, integração Canva, e-books |

## 5. Regulação que impacta o software

- **Res. CFN nº 856/2026 – novo Código de Ética e Conduta** (publicada abr/2026, vigência 90 dias; revoga Res. 599/2018). Tem seção própria de IA (arts. 32–38): IA permitida como apoio, **não substitui** o nutricionista na avaliação/definição de conduta nem a relação com o paciente; uso de IA deve ser declarado em divulgações; **proibido** criar imagens/vídeos com IA generativa que simulem resultados; mantida proibição de divulgar fotos antes/depois e medidas de pacientes — **[FATO]** ([Exame](https://exame.com/brasil/o-que-o-novo-codigo-de-nutricionistas-define-sobre-uso-de-ia-e-redes-sociais/); [CFN](https://cfn.org.br/cfn-atualiza-codigo-de-etica-e-reforca-protecao-ao-paciente-e-a-pratica-profissional-na-nutricao/); [Nutritotal](https://nutritotal.com.br/pro/material/novo-codigo-de-etica-do-nutricionista-o-que-mudou/)).
- **Telenutrição:** Res. CFN 646/2020, 666/2020 (plataforma e-Nutricionista), 684/2021, 751/2023; Manual Prático de Telenutrição CFN 2024 (rev. 2026) — **[FATO]** ([Manual CFN](https://cfn.org.br/wp-content/uploads/2026/09/Manual-Pratico-de-Telenutricao-CFN-2024-rev.2026.pdf)). **Requisito:** registrar modalidade remota no prontuário, consentimento, sigilo.
- **Receita Saúde:** não obrigatório para nutricionista (ver seção 2).
- **LGPD:** dado de saúde é dado sensível (consentimento, controle de acesso, log).
- **Implicação no produto:** módulo de IA deve gerar *rascunho* com revisão/assinatura obrigatória do profissional; nunca gerar "antes/depois" simulado; marca d'água/declaração de uso de IA em materiais exportados.

## 6. Concorrentes específicos e preços (consultados em 2026-10-06)

| Produto | Preço | Destaques | Fonte |
|---|---|---|---|
| **Dietbox** | Premium R$ 133,90/mês (mensal); plano profissional anual com promoção de R$ 49,90/mês renovando a R$ 91,90/mês; estudante grátis/R$ 19,90–24,90 | Líder percebido; app do paciente, "Assistente Dietbox" (IA para otimizar plano), WhatsSync, antropometria, site profissional, Academy | [dietbox.me](https://dietbox.me/pt-BR) — **atenção:** a extração da tabela de preços veio ambígua; reconfirmar manualmente |
| **WebDiet** | Premium R$ 49,90/mês (3 primeiros meses) → R$ 94,90; Black R$ 139,90/mês | "Clara IA" (assistente nutricional) e Body3D no Black; mentoria; WhatsApp Connect | [pt.webdiet.com.br/assine.php](https://pt.webdiet.com.br/assine.php) |
| Dietpro, Avanutri, Nutrium (PT) | não levantado | — | — |
| iClinic (generalista) | R$ 99–299/profissional/mês | Não tem motor de cálculo de dieta nativo | [iclinic.com.br/precos](https://www.iclinic.com.br/precos/) |

**[INFERÊNCIA]** Preço de referência do nicho: R$ 50–140/mês por profissional. O nutricionista não paga preço de software médico (R$ 99–299). Concorrer exige base de alimentos + app do paciente — difícil de ganhar só com "agenda + prontuário".

## 7. Uso de IA/LLM no nicho e riscos

- **Em uso:** geração/otimização de plano alimentar (Dietbox Assistente, WebDiet Clara IA); estudos acadêmicos de geração de planos por IA ([Agência FAPESP](https://agencia.fapesp.br/ferramenta-baseada-em-inteligencia-artificial-cria-planos-alimentares-personalizados/44698)); chatbots de adesão.
- **Oportunidades:** foto do prato → estimativa de nutrientes no diário do paciente; transcrição da consulta → anamnese estruturada; rascunho de plano a partir de metas + preferências; resumo de evolução para retorno.
- **Riscos:** (a) ético-regulatório — Código CFN 2026 proíbe substituir o profissional e simular resultados; (b) clínico — erro de cálculo/alergias/interações (ex.: renal, diabetes, gestante) ⇒ validação determinística dos números (o LLM nunca calcula macros; quem calcula é o motor); (c) concorrência de apps de consumo (ChatGPT montando dieta) que desvalorizam a consulta ([Metrópoles](https://www.metropoles.com/saude/ia-pode-montar-dieta-riscos); [Congresso em Foco](https://www.congressoemfoco.com.br/artigo/114419/a-dieta-de-bolso-da-ia-o-risco-silencioso-de-uma-nutricao-generica)); (d) LGPD — fotos/medidas corporais enviadas a LLM de terceiros.

## 8. MVP vs desejável

| MVP (para entrar no nicho) | Desejável (diferenciação) |
|---|---|
| Agenda + confirmação WhatsApp, link de agendamento | IA: foto do prato → diário; rascunho de plano com revisão obrigatória |
| Prontuário com anamnese nutricional e recordatório 24h | Integração com balanças de bioimpedância e wearables |
| Antropometria com protocolos e gráficos | Gamificação/metas no app do paciente |
| Motor de cálculo de dieta com TACO/TBCA, substituições, PDF do plano | Marketplace de receitas/materiais; site profissional |
| App/portal do paciente (ver plano, diário simples) | Cobrança recorrente de planos de acompanhamento |
| Teleconsulta com registro de modalidade remota | Relatórios para academias/clínicas multiprofissionais |
| Financeiro simples + recibo | |

**Lacunas de pesquisa:** nº de consultórios/clínicas de nutrição (não há fonte); share real dos concorrentes; preço Dietpro/Avanutri.
