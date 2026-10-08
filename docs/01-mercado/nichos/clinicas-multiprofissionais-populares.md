# Nicho: Clínicas Multiprofissionais / Populares (cartão de desconto, assinatura)

> Frente: Pesquisa de Mercado · Executor N3 · Pesquisa realizada entre 2026-10-06 e 2026-10-08 (fontes acessadas nesse período, salvo indicação).
> Legenda: **[FATO]** = dado publicado por fonte identificada · **[ESTIMATIVA]** = número aproximado/projeção de terceiros ou nossa · **[INFERÊNCIA]** = conclusão nossa a partir dos fatos · **[NÃO VERIFICADO]** = apareceu em busca, mas a página primária não foi aberta/confirmada.

## 1. Tamanho do mercado

| Indicador | Valor | Tipo | Fonte (data) |
|---|---|---|---|
| Usuários de cartões de desconto em saúde | ~60 milhões | ESTIMATIVA (fonte não identificada pelo veículo; a ANS diz não haver dado oficial) | [Futuro da Saúde, abr/2026](https://futurodasaude.com.br/cartoes-de-desconto-ans-processo-regulatorio/) |
| Cartão de TODOS – clientes | ~20 milhões; >400 unidades | FATO (dado da empresa, via imprensa) | [Folha Vitória](https://www.folhavitoria.com.br/geral/cartao-de-todos-garante-produtos-e-servicos-essenciais-a-precos-populares/); [Medicina S/A](https://medicinasa.com.br/?p=135102) |
| AmorSaúde – unidades | 478 (dez/2024); >485 (2025/2026); média de >50 aberturas/ano; meta de 1.000 | FATO (dado da empresa) | [Mercado & Consumo, 18/12/2024](https://mercadoeconsumo.com.br/18/12/2024/noticias-varejo/rede-de-clinicas-amorsaude-atinge-478-unidades-e-avanca-para-chile-e-colombia/amp/); [ABC da Comunicação](https://www.abcdacomunicacao.com.br/amorsaude-celebra-o-marco-de-478-clinicas-no-brasil-e-a-abertura-de-novas-unidades-no-chile-e-na-colombia-durante-congresso-anual/) |
| AmorSaúde – volume anual | >18 mi consultas, >1 mi procedimentos odontológicos, >35 mi exames | NÃO VERIFICADO (trecho de busca) | busca citando [Medicina S/A](https://medicinasa.com.br/?p=135102) |
| Franquias Saúde, Beleza e Bem-Estar (ABF) | R$ 64,8 bi (2024, +16,5%); R$ 74,3 bi (2025, +14,6%) | FATO (inclui estética) | [Monitor Mercantil](https://monitormercantil.com.br/setor-de-saude-e-bem-estar-fatura-r-743-bi/) |
| Dr. Consulta – receita | R$ 310 mi (2021), projeção R$ 403 mi (2022) | FATO (antigo) | [Portal do Franchising](https://www.portaldofranchising.com.br/noticias/clinica-popular-um-negocio-em-expansao/) |
| Preço de consulta em clínica popular | R$ 69–120 (média ~R$ 100); exemplos de R$ 89 | FATO (imprensa; datas variadas) | [Portal do Franchising](https://www.portaldofranchising.com.br/noticias/clinica-popular-um-negocio-em-expansao/); [Correio Braziliense](https://blogs.correiobraziliense.com.br/vicente/clinicas-populares-ganham-espaco-com-consulta-a-r-89/) |

**[INFERÊNCIA]** O mercado é grande em volume de atendimentos, mas **concentrado em redes** (AmorSaúde, Dr. Consulta, redes regionais) que já têm software corporativo, e **pulverizado na cauda** (clínica popular independente no interior, centros médicos de bairro, clínicas multiprofissionais com médico + psicologia + nutri + fisio). O nº total de clínicas populares não tem fonte oficial — **[LACUNA]**.

## 2. Perfil do cliente, ticket, convênio x particular

- **Paciente:** classes C/D/E sem plano de saúde, paga consulta avulsa barata ou mensalidade de cartão de desconto/assinatura. **[FATO de contexto]** ([Futuro da Saúde – "terceira via"](https://futurodasaude.com.br/?p=13863); [A Tarde](https://atarde.com.br/brasil/com-8-milhoes-de-clientes-cartao-de-desconto-atrai-orfaos-de-plano-de-saude-1013688)).
- **Comprador do software:** (a) franqueadora/rede (decide centralmente, contrato enterprise); (b) dono de clínica popular independente/multiprofissional (decisão local, sensível a preço); (c) empresa de cartão de desconto/assinatura que credencia rede de clínicas.
- **Receita da clínica:** particular a preço baixo + parceria com cartões de desconto + às vezes convênios pequenos/regionais; exames e odontologia como receita adicional. Lucro depende de **volume** e baixo custo ([Portal do Franchising](https://www.portaldofranchising.com.br/noticias/clinica-popular-um-negocio-em-expansao/)).
- **Profissionais:** muitos PJ/plantonistas por turno, com repasse por atendimento.

## 3. Dores e rotina

- **Alto volume na recepção:** fila, encaixes, faltas, várias especialidades no mesmo dia; atendimento majoritariamente por WhatsApp.
- **Elegibilidade:** checar se o paciente é assinante/portador do cartão e está adimplente; aplicar tabela de preço certa (cartão A, cartão B, particular).
- **Repasse a médicos e terapeutas** por atendimento, com regras diferentes; fechamento de caixa por turno e por unidade.
- **Conversão de consulta → exame/procedimento** (orçamento, agendamento do exame).
- **Gestão multiunidade** (franquias): padronização, relatórios consolidados, royalties.
- **Cobrança recorrente** de assinaturas com inadimplência alta. **[INFERÊNCIA]**

## 4. Requisitos específicos de software

| Requisito | Detalhe |
|---|---|
| Múltiplas tabelas de preço | Particular, cartão de desconto X/Y, assinatura, convênio; regra por procedimento/especialidade |
| Elegibilidade de cartão/assinatura | Consulta por CPF/carteirinha via API do parceiro ou base importada; status de adimplência |
| Assinatura própria | Planos mensais (individual/família), cobrança recorrente (cartão/Pix automático/boleto), carência, limite de uso por período, régua de inadimplência |
| Agenda de alto volume | Várias especialidades/salas, encaixe, fila de espera, painel de chamada, check-in por totem/QR |
| Multiprofissional | Prontuário com modelos por profissão (médico, psico, nutri, fisio, odonto), compartilhamento controlado entre profissionais (com perfil de acesso — sigilo da psicologia) |
| Repasse | Por atendimento, por profissional, por tabela; PJ; extrato para o profissional |
| Caixa e financeiro | Caixa por recepcionista/turno, maquininha, Pix, split, conciliação |
| Multiunidade/franquia | Visão consolidada, permissões por unidade, padronização de cadastros, royalties |
| Exames | Pedido, orçamento, agendamento, integração com laboratório/imagem (desejável) |
| Atendimento WhatsApp | Agendamento automático, confirmação, lista de espera |

## 5. Regulação que impacta o software

- **Cartões de desconto não são planos de saúde** e hoje não são regulados pela ANS. Em **17/04/2026** a ANS abriu chamada pública e criou comitê interno (90 dias) para estudar a regulação de cartões de desconto, pré-pagos e correlatos, e encerrou a proposta de sandbox de planos só de consultas e exames — **[FATO]** ([Futuro da Saúde](https://futurodasaude.com.br/cartoes-de-desconto-ans-processo-regulatorio/); [ANS – chamamento público](https://www.gov.br/ans/pt-br/assuntos/noticias/sociedade/ans-abre-chamamento-publico-sobre-cartoes-de-desconto-e-pre-pagos-na-area-da-saude)). Prazo de contribuições prorrogado até 18/08/2026 — **[FATO]** ([Acessa.com, ago/2026](https://www.acessa.com/economia/2026/08/336022-ans-prorroga-ate-18-8-prazo-da-consulta-publica-sobre-cartoes-de-desconto-em-saude.html)). Regra final ainda **inexistente** em out/2026.
- **[INFERÊNCIA]** Se a ANS regular, cartões/assinaturas podem passar a exigir registro, garantias e envio de dados — o software precisa de **modelo de produto flexível** (não "hard-code" de cartão de desconto) e capacidade de gerar relatórios de utilização. Assinatura "de consultas" da própria clínica pode ser interpretada como plano de saúde disfarçado — validar com jurídico antes de oferecer como feature.
- **Conselhos profissionais:** cada profissão segue sua resolução de prontuário (CFM, CFP, CFN, COFFITO, CFFa, CFO); em clínica multiprofissional, **sigilo da psicologia** exige separação de anotações ([ver `psicologia-saude-mental.md`]).
- **Fiscal:** NFS-e da PJ; profissionais PF parceiros sujeitos ao Receita Saúde (médico, psicólogo, fisio, fono, TO, dentista) — **[FATO]** ([COAD](https://www.coad.com.br/home/noticias-detalhe/129492/recibo-eletronico-de-servicos-de-saude-sera-obrigatorio-a-partir-de-2025)).
- **Publicidade médica de preço:** **[LACUNA]** verificar regras do CFM sobre divulgação de valores de consulta antes de criar features de vitrine/marketplace.

## 6. Concorrentes específicos e preços

| Produto | Preço | Destaques | Fonte (data) |
|---|---|---|---|
| **Feegow (Docplanner/Doctoralia)** | não divulgado no levantamento | Atende redes de clínicas populares, incl. AmorSaúde; adquirida pela Doctoralia em 2022 com foco em clínicas populares; ~40 mil profissionais (na aquisição); split, autorização de convênio, reconhecimento facial | [Startups.com.br](https://startups.com.br/negocios/doctoralia-compra-brasileira-feegow-e-mira-gestao-para-clinicas/); [Medicina S/A](https://medicinasa.com.br/feegow-clinic-gestao-integrada/) |
| **Amplimed (RD Saúde)** | não divulgado | >67 mil profissionais, 64 operadoras; adquirida pela Raia Drogasil em dez/2021 | [Baguete](https://www.baguete.com.br/noticias/unimed-sp-telemedicina-e-prontuario-eletronico-com-amplimed); [CB Insights](https://www.cbinsights.com/company/amplimedcombr/alternatives-competitors) |
| **iClinic (Afya)** | R$ 99–299/profissional/mês | Generalista; cobra por profissional — caro para clínica com muitos plantonistas | [iclinic.com.br/precos](https://www.iclinic.com.br/precos/) |
| Ninsaúde Clinic, Clinicorp, ZenFisio | ver demais arquivos / não levantado | — | — |
| Sistemas próprios das redes (Dr. Consulta) | — | Dr. Consulta investiu em prontuário próprio e IA | [BP Money](https://bpmoney.com.br/negocios/dr-consulta-inteligencia-artificial-remedio-diminuir-custos-pacientes) |

**[INFERÊNCIA]** Modelo de preço "por profissional" penaliza clínica popular (muitos profissionais com poucas horas cada). Oportunidade: preço **por unidade/por volume de atendimentos** ou por agenda ativa.

## 7. Uso de IA/LLM no nicho e riscos

- **Em uso:** Dr. Consulta usa IA para analisar dados e apoiar recomendações médicas e reduzir custo ([BP Money](https://bpmoney.com.br/negocios/dr-consulta-inteligencia-artificial-remedio-diminuir-custos-pacientes)).
- **Oportunidades:** atendente de IA no WhatsApp para agendamento de alto volume (maior ROI do nicho); triagem administrativa (qual especialidade/qual exame); previsão de no-show e overbooking inteligente; resumo do prontuário para o próximo profissional (multiprofissional); cobrança/recuperação de inadimplência de assinaturas.
- **Riscos:** (a) IA de triagem que vire **orientação clínica** (responsabilidade; Res. CFM 2.454/2026 trata IA como apoio com médico responsável — citada em busca, texto não aberto); (b) público de baixa literacia digital — erro de agendamento custa caro; (c) compartilhamento indevido de prontuário entre profissões (psicologia); (d) volume alto ⇒ custo de tokens relevante — precisa de arquitetura barata (modelo pequeno + regras).

## 8. MVP vs desejável

| MVP | Desejável |
|---|---|
| Agenda de alto volume multi-especialidade, encaixe, lista de espera | Atendente de IA no WhatsApp (agendamento/confirmação) |
| Múltiplas tabelas de preço (particular/cartão/assinatura/convênio) | API de elegibilidade com empresas de cartão de desconto |
| Prontuário multiprofissional com modelos por profissão e permissões | Totem/QR de check-in e painel de chamada |
| Repasse por atendimento | Previsão de no-show e overbooking |
| Caixa por turno, Pix/cartão, NFS-e | Assinatura própria com cobrança recorrente (após parecer jurídico/ANS) |
| Multiunidade básica | Gestão de franquia (royalties, padronização) |
| Pedido e orçamento de exames | Integração laboratório/imagem |
