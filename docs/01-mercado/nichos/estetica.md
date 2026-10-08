# Nicho: Estética / Harmonização (clínicas de estética, biomedicina estética, dermato estética)

> Frente: Pesquisa de Mercado · Executor N3 · Pesquisa realizada em 2026-10-06 (fontes acessadas nessa data, salvo indicação).
> Legenda: **[FATO]** · **[ESTIMATIVA]** · **[INFERÊNCIA]** · **[NÃO VERIFICADO]** (ver `nutricao.md`).

## 1. Tamanho do mercado

| Indicador | Valor | Tipo | Fonte (data) |
|---|---|---|---|
| Procedimentos estéticos não cirúrgicos no Brasil (2024) | 3.123.758; toxina botulínica é o mais comum, seguida de ácido hialurônico | FATO (ISAPS Global Survey 2024) | [ISAPS 2024 – PT-BR](https://www.isaps.org/media/3uhnjvup/2024-global-survey-portuguese-brazilian.pdf); resumo em [CNN Brasil](https://www.cnnbrasil.com.br/saude/brasil-e-o-pais-que-mais-realiza-cirurgia-plastica-no-mundo-diz-relatorio/) |
| Cirurgias plásticas estéticas (2024) | ~2,3 milhões, Brasil nº 1 no mundo | FATO (ISAPS via imprensa) | idem |
| Biomédicos registrados | >150 mil (2025) | NÃO VERIFICADO (trecho de busca) | [CFBM – apresentação na Câmara, 11/11/2025](https://www2.camara.leg.br/atividade-legislativa/comissoes/comissoes-permanentes/cssf/apresentacoes-em-eventos/eventos-2025/11-11-2025-audiencia-publica-projeto-de-lei-no-2717-2019-que-dispoe-sobre-o-reconhecimento-da-saude-estetica-como-area-de-atuacao-profissional/conselho-federal-de-biomedicina/view) |
| Biomédicos habilitados em estética | ~45,9 mil a 52,2 mil (números divergentes entre fontes) | NÃO VERIFICADO | idem |
| Franquias Saúde, Beleza e Bem-Estar (ABF) | R$ 64,8 bi em 2024 (+16,5%); R$ 74,3 bi em 2025 (+14,6%) | FATO (ABF via imprensa) | [Estética & Mercado, 13/02/2025](https://esteticaemercado.com.br/noticia/mercado/mercado-de-saude-e-estetica-cresce-165-em-2024-e-mantem-crescimento-em-2025/); [Monitor Mercantil](https://monitormercantil.com.br/setor-de-saude-e-bem-estar-fatura-r-743-bi/) |
| Pequenos negócios de beleza e estética | >1,1 milhão ativos; ~230 mil CNPJs abertos/ano | ESTIMATIVA (imprensa; inclui salões) | [A Notícia do Ceará](https://anoticiadoceara.com.br/setor-de-beleza-abre-27-negocios-por-hora-no-pais-e-cresce-185-em-2025/) |

**[INFERÊNCIA]** É o nicho com maior **gasto particular** e maior disposição a pagar por software de gestão/CRM. Mas a base é heterogênea: de esteticistas (não-saúde regulada) e salões até clínicas médicas de dermatologia. Profissionais executores: médicos (dermato, plástica), dentistas (HOF), biomédicos, fisioterapeutas dermatofuncionais, farmacêuticos e enfermeiros estetas, esteticistas/cosmetólogos.

## 2. Perfil do cliente, ticket, convênio x particular

- **100% particular** (procedimento estético não tem cobertura de plano). **[FATO-regra geral]**
- **Ticket:** alto e por procedimento/pacote (toxina, preenchimento, bioestimulador, tecnologias como laser/ultrassom microfocado) — **[LACUNA]** não encontramos pesquisa estruturada de ticket médio nesta rodada; não estimar sem fonte.
- **Venda consultiva + parcelamento** (cartão em várias vezes, pacotes de sessões corporais) e forte dependência de Instagram/WhatsApp para captação.
- Comprador do software: dono(a) da clínica, frequentemente o próprio profissional executor; secretária/CRC para comercial.

## 3. Dores e rotina

- **Funil comercial:** lead do Instagram → avaliação → orçamento → fechamento → pacote; follow-up e recall (toxina a cada ~4–6 meses). **[INFERÊNCIA]**
- **Estoque caro e perecível** (toxina, ácido hialurônico, fios, bioestimuladores): fracionamento de frascos entre pacientes, lote/validade, risco de falsificação.
- **Comissões** complexas (por profissional, por procedimento, por venda do comercial).
- **Fotos antes/depois** padronizadas e seguras (não no rolo do celular pessoal).
- **Termos de consentimento** por procedimento com assinatura.
- **Insegurança jurídica** sobre quem pode fazer o quê (ver seção 5).

## 4. Requisitos específicos de software

| Requisito | Detalhe |
|---|---|
| Fotos antes/depois | Captura guiada (mesma pose/luz/ângulo), comparação lado a lado, armazenadas no prontuário (criptografadas), consentimento de uso de imagem separado |
| Mapa facial/corporal | Marcação de pontos de aplicação e unidades de toxina por região |
| Termos de consentimento | Modelos por procedimento, assinatura eletrônica, versão vinculada ao atendimento |
| Estoque com lote/validade | Entrada por NF, lote, validade, GTIN; **baixa por aplicação vinculada ao paciente** (rastreabilidade: qual lote foi em qual paciente); fracionamento de frasco |
| Pacotes/sessões | Pacotes corporais, saldo, validade |
| Orçamentos e CRM | Funil de vendas, orçamento com parcelamento, follow-up, recall automático |
| Comissões | Regras por profissional/procedimento/vendedor, metas |
| Financeiro | Parcelamento, maquininha, split, conciliação |
| Marketing | WhatsApp, campanhas de reativação, aniversário |

## 5. Regulação que impacta o software (ALTO RISCO REGULATÓRIO)

- **Biomédicos:** TRF-1 (7ª Turma) manteve anulação de resolução do CFBM e entendeu que biomédicos **não podem realizar procedimentos estéticos invasivos** (ex.: toxina botulínica, intradermoterapia, carboxiterapia, laser) com base na Lei do Ato Médico (Lei 12.842/2013) — **[FATO]** decisão noticiada em mar/2026 ([ConJur, 26/03/2026](https://conjur.com.br/2026-mar-26/trf-1-proibe-biomedicos-de-fazerem-procedimentos-esteticos-invasivos/); [CFM](https://portal.cfm.org.br/noticias/trf-1-mantem-vitoria-do-cfm-e-rejeita-recurso-do-cfbm-sobre-atos-medicos-invasivos/); [Metrópoles](https://www.metropoles.com/colunas/grande-angular/trf-1-biomedicos-nao-podem-fazer-procedimentos-esteticos-invasivos)). Possibilidade de recursos a tribunais superiores — situação não definitiva (**[INFERÊNCIA]**, checar com jurídico).
- **Dentistas (HOF):** TRF-1 (8ª Turma) declarou ilegal a Res. CFO 198/2019 que reconhecia harmonização orofacial como especialidade; CFO anunciou recurso e orientou manter procedimentos dentro da área legal — **[FATO]** (ago/2026) ([Diário do Nordeste](https://diariodonordeste.verdesmares.com.br/ultima-hora/pais/justica-derruba-resolucao-que-autorizava-dentistas-a-realizarem-harmonizacao-facial-no-brasil-1.3785834); [Itatiaia](https://www.itatiaia.com.br/saude/cfo-vai-recorrer-de-decisao-da-justica-sobre-harmonizacao-orofacial/)).
- **PL 2.717/2019** (reconhecimento da saúde estética como área de atuação) em discussão na Câmara (audiência 11/11/2025) — **[FATO]** ([Câmara](https://www2.camara.leg.br/atividade-legislativa/comissoes/comissoes-permanentes/cssf/apresentacoes-em-eventos/eventos-2025/11-11-2025-audiencia-publica-projeto-de-lei-no-2717-2019-que-dispoe-sobre-o-reconhecimento-da-saude-estetica-como-area-de-atuacao-profissional/conselho-federal-de-biomedicina/view)).
- **Anvisa/Vigilância Sanitária:** roteiro de inspeção de serviços de estética; uso apenas de produtos registrados; recomendação de registrar dose/lote no prontuário; alertas de toxina falsificada (sem GTIN) — **[FATO]** ([Anvisa – Roteiro de Estética](https://www.gov.br/anvisa/pt-br/assuntos/servicosdesaude/projeto-de-melhoria-do-processo-de-inspecao-sanitaria-em-servicos-de-saude-e-de-interesse-para-a-saude/harmonizacao-de-roteiros-objetivos-de-inspecao-roi/copy_of_RoteirodeEsttica_GGTES_verso1.3.pdf); [Afya – alerta lote falso](https://portal.afya.com.br/saude/anvisa-emite-alerta-contra-lote-falso-de-toxina-botulinica)).
- **Publicidade:** cada conselho tem regras próprias sobre antes/depois (CFM, CFO, CFBM, COFFITO, CFN proíbe). **[INFERÊNCIA]** O software deve separar "foto clínica" de "foto autorizada para divulgação" com consentimento específico.
- **Implicação no produto:** cadastro de procedimentos deve permitir **regras de habilitação por categoria profissional** (configurável, já que o cenário jurídico muda); rastreabilidade de lote é argumento de venda (defesa em processo).

## 6. Concorrentes específicos e preços

| Produto | Preço | Destaques | Fonte (data) |
|---|---|---|---|
| **Clinicorp** | Standard R$ 159,90/mês; Premium R$ 369,90/mês (trimestral: R$ 127,19 / R$ 330); combos IA sob consulta; implantação obrigatória | Origem odonto, forte em estética/HOF; CRM, estoque, financeiro, agentes de IA no WhatsApp; ">57 mil profissionais impactados" | [clinicorp.com/planos](https://www.clinicorp.com/planos); [Comparasoftware](https://www.comparasoftware.com/clinicorp) |
| **Clínica Experts** | Preço não exibido no trecho lido | >30 mil profissionais; assistente de IA "Anna" via WhatsApp; estoque, vendas, CRM | [clinicaexperts.com.br](https://www.clinicaexperts.com.br/); [Startupi](https://startupi.com.br/clinica-experts-dobra-de-tamanho/) |
| **Belle Software (Belasis)**, **Trinks**, Gestão DS | Não levantado | Origem em salões/beleza | [Belasis](https://www.belasis.com.br/en/software-para-clinica-de-estetica) |
| **ZenFisio** | R$ 79–439/mês | Também atende estética | [zenfisio.com](https://www.zenfisio.com/) |
| iClinic | R$ 99–299/prof. (estoque só no Pro R$ 169) | — | [iclinic.com.br/precos](https://www.iclinic.com.br/precos/) |

## 7. Uso de IA/LLM no nicho e riscos

- **Em uso:** agentes de atendimento/vendas no WhatsApp (Clinicorp, Clínica Experts "Anna"); simuladores de resultado.
- **Oportunidades:** SDR de IA para qualificar lead e agendar avaliação; recall inteligente; sugestão de orçamento; análise padronizada de fotos (simetria, evolução) **como apoio**.
- **Riscos:** (a) **simulação de resultado por IA** pode configurar promessa de resultado/publicidade enganosa (vedado por vários conselhos; o CFN proibiu expressamente) — **[INFERÊNCIA para os demais conselhos]**; (b) agente de IA prometendo preço/resultado ou dando orientação clínica no WhatsApp; (c) fotos faciais são dado biométrico/sensível (LGPD) — não enviar a LLM de terceiros sem base legal e DPA; (d) risco jurídico de vender para profissional que executa procedimento fora da competência.

## 8. MVP vs desejável

| MVP | Desejável |
|---|---|
| Agenda + confirmação WhatsApp | Agente de IA comercial no WhatsApp (com guardrails) |
| Prontuário estético com mapa facial e fotos antes/depois seguras | Captura de foto guiada + comparação automática |
| Termos de consentimento com assinatura eletrônica | Simulador (só uso interno, com aviso) — avaliar com jurídico |
| Estoque com lote/validade e baixa por paciente | Fracionamento de frascos e custo real por procedimento |
| Orçamento, pacotes, parcelamento | CRM completo com funil e metas |
| Comissões configuráveis | Multiunidade/franquia |
| Regras de habilitação por categoria profissional (configurável) | Programa de fidelidade |
