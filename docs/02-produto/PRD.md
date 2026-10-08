# PRD — Plataforma de Gestão para Clínicas de Saúde (nome provisório: **Plataforma Saúde**)

> Frente: 🧩 Produto (N2) · Executor: N3 PRD + WBS · Versão 0.1 (rascunho para revisão do Maestro e do Guardião LGPD) · Data: 2026-10-06
> Documentos irmãos: [WBS-micropartes.md](./WBS-micropartes.md) · [roadmap.md](./roadmap.md) · [jornadas.md](./jornadas.md)
> Status das premissas de mercado: **hipóteses** — devem ser validadas pela frente 📊 Pesquisa de Mercado (`docs/01-mercado/`).

---

## 1. Visão

Ser o sistema operacional da clínica de saúde brasileira — de qualquer especialidade — onde **o paciente conversa pelo WhatsApp, o profissional atende sem digitar e a clínica recebe sem burocracia**, com os dados do paciente protegidos por padrão e sempre portáveis.

**Frase de posicionamento (hipótese):**
> Para profissionais e clínicas de saúde que perdem horas com agenda, prontuário e cobrança, a Plataforma Saúde é o sistema de gestão que **atende pelo WhatsApp, escreve o prontuário com IA e recebe por Pix** — diferente de iClinic/Feegow/Ninsaúde, porque é nativo de IA, tem preço transparente e deixa você levar seus dados embora quando quiser.

## 2. Problema

| # | Dor | Quem sente | Evidência/hipótese a validar |
|---|---|---|---|
| P1 | Profissional gasta 30–40% do tempo de consulta digitando prontuário; atendimento perde qualidade e o prontuário fica pobre | Profissional | Hipótese — validar em entrevistas por nicho |
| P2 | Faltas (no-show) de 15–30% corroem receita; confirmação manual por WhatsApp consome a recepção | Dono, recepção | Hipótese |
| P3 | Recepção opera em 3–5 ferramentas (WhatsApp pessoal, planilha, agenda de papel, maquininha, sistema) — sem histórico, sem rastreabilidade, risco LGPD | Recepção, dono | Hipótese |
| P4 | Faturamento de convênio (TISS) gera glosas, retrabalho e atraso de caixa | Faturista, dono | Hipótese |
| P5 | Emissão de NFS-e e conciliação de recebíveis manuais; contador cobra mais | Dono | Hipótese |
| P6 | Sistemas atuais são genéricos (pensados para medicina) — nichos como odonto, psico, nutri, fisio, estética, fono/TEA adaptam campos livres | Profissionais de nicho | Hipótese |
| P7 | Lock-in: migrar de sistema é doloroso e exportar dados é difícil ou pago | Dono | Hipótese |
| P8 | Preço opaco ("fale com consultor"), módulos cobrados à parte, aumento surpresa | Dono, autônomo | Hipótese |
| P9 | Paciente não tem acesso fácil a receitas, exames, recibos e histórico; liga para a clínica | Paciente, recepção | Hipótese |
| P10 | Insegurança jurídica com LGPD (dados sensíveis de saúde, art. 11) e com uso de IA sobre dados de pacientes | Dono, profissional | Hipótese |

## 3. Personas

### 3.1 Dr. Rafael — médico autônomo (consultório próprio)
- 38 anos, clínico/endocrinologista, atende sozinho com uma secretária meio período, 60% particular / 40% 2–3 convênios.
- **Objetivos:** atender mais sem perder qualidade; reduzir faltas; parar de digitar receita; receber rápido.
- **Frustrações:** prontuário lento; receita em papel/Memed separado; TISS manual; WhatsApp pessoal misturado com pacientes.
- **Momento “uau”:** termina a consulta e o prontuário + receita já estão rascunhados pelo escriba.

### 3.2 Carla — dona de clínica multiprofissional
- 45 anos, gestora (pode ou não ser profissional de saúde), clínica com 8–15 profissionais de várias áreas (psico, nutri, fisio, fono), 2 recepcionistas.
- **Objetivos:** visão de faturamento por profissional, repasse correto, ocupação de salas, controle de inadimplência, conformidade LGPD.
- **Frustrações:** repasse calculado em planilha; não sabe a taxa real de no-show; cada profissional quer um prontuário diferente.
- **Momento “uau”:** dashboard de ocupação e repasse calculado automaticamente com split Pix.

### 3.3 Juliana — secretária/recepção
- 27 anos, atende telefone, WhatsApp, balcão; agenda para 4 profissionais.
- **Objetivos:** responder rápido, encaixar pacientes, confirmar consultas, cobrar sem constrangimento.
- **Frustrações:** WhatsApp no celular pessoal, mensagens perdidas, confirmações manuais, troca de turno sem contexto.
- **Momento “uau”:** inbox compartilhada do WhatsApp com bot que já confirma e remarca sozinho.

### 3.4 Profissionais de nicho
| Persona | Nicho | Necessidades específicas |
|---|---|---|
| Dra. Bianca | Odontologia | Odontograma, plano de tratamento com orçamento por dente/face, aprovação do orçamento, estoque de materiais, parcelamento |
| Marcos | Psicologia | Sessões recorrentes, evolução sigilosa (anotações privadas do profissional), pacotes, teleatendimento, recibo para reembolso/IR, CFP |
| Lívia | Nutrição | Antropometria, bioimpedância, gráficos de evolução, plano alimentar, recordatório, app do paciente |
| Diego | Fisioterapia / TO | Plano de sessões, escalas funcionais (ex.: goniometria, EVA de dor), pacotes, guias de convênio com múltiplas sessões |
| Dra. Paula | Estética | Fotos antes/depois padronizadas, mapa de aplicação (toxina/preenchedor), lote/validade de produto, termo de consentimento por procedimento, estoque |
| Renata | Fonoaudiologia / TEA (equipe multi) | Plano terapêutico multiprofissional, metas, registro por sessão, relatórios para escola/família/plano, guias com autorização recorrente |
| Dr. Rafael | Medicina | Anamnese/exame físico, CID, prescrição com assinatura digital, pedidos de exame, atestados, TISS |

### 3.5 Seu Antônio / Ana — paciente
- Do idoso que só usa WhatsApp à jovem que prefere app.
- **Objetivos:** marcar sem ligar, lembrar da consulta, pagar fácil (Pix), receber receita/atestado no celular, ver histórico, saber o que a clínica faz com seus dados.
- **Frustrações:** esperar no telefone, perder receita, não conseguir recibo para reembolso.

### 3.6 Fernanda — faturista
- Atua em clínica média com convênios (ou terceirizada).
- **Objetivos:** gerar lotes TISS sem erro, acompanhar glosas, recursar, conciliar pagamentos dos convênios.
- **Frustrações:** regras diferentes por operadora, tabelas TUSS desatualizadas, retrabalho por guia incompleta.

## 4. Proposta de valor

| Diferencial | O que entrega | Persona principal | Prova esperada |
|---|---|---|---|
| **Escriba de IA** (LLM própria fine-tuned + RAG) | Transcreve a consulta, gera rascunho de prontuário no modelo do nicho, sugere CID/TUSS, gera resumo para o paciente; profissional revisa e assina | Profissional | Tempo de documentação ↓ 50% |
| **WhatsApp como canal principal** | Bot de agendamento/confirmação/remarcação + inbox compartilhada da recepção, número oficial (API Cloud) | Recepção, paciente | No-show ↓ 30% |
| **Pix / split / NFS-e** | Cobrança Pix na confirmação, link de pagamento, split automático para repasse, NFS-e emitida no recebimento | Dono | Dias para receber ↓; conciliação automática |
| **TISS sem dor** | Guias pré-preenchidas, validação antes do envio, lotes XML, controle de glosas | Faturista | Taxa de glosa ↓ |
| **Portal do paciente** | Agendamentos, documentos, pagamentos, consentimentos, direitos LGPD em autoatendimento | Paciente | Ligações à recepção ↓ |
| **Exportação total de dados** | Exporta tudo (pacientes, prontuários, financeiro, anexos) em formatos abertos, a qualquer momento, sem custo | Dono | Confiança / argumento comercial |
| **Migração assistida** | Importadores dos concorrentes + planilhas + time de migração | Dono | Tempo de ativação ↓ |
| **Construtor de prontuário por especialidade** | Modelos prontos por nicho + editor drag-and-drop + componentes especiais (odontograma, antropometria, fotos, escalas) | Profissional de nicho | Adoção por nicho |
| **Preço transparente** | Tabela pública, sem taxa de setup, sem fidelidade, IA inclusa em cota | Dono, autônomo | Conversão do trial |
| **LGPD by design** | Consentimentos granulares, trilha de auditoria, controle de acesso por papel, criptografia, portal de direitos do titular, RIPD pronto | Dono | Zero incidente; argumento de venda |

## 5. Métricas de sucesso

### 5.1 North Star Metric
**Consultas concluídas com prontuário assinado por semana (CCPA/semana)** — considera apenas consultas que passaram por agenda → atendimento → prontuário assinado na plataforma.
- Por que: captura uso real do núcleo clínico (não só agenda), cresce com nº de clientes e com profundidade de uso, e é pré-condição de faturamento (financeiro/TISS).
- Métrica de apoio da North Star: **% de CCPA com escriba de IA usado** (penetração do diferencial).

### 5.2 KPIs por dimensão

| Dimensão | KPI | Meta inicial (hipótese, 12 meses pós-lançamento) |
|---|---|---|
| Aquisição | Trials iniciados / mês | 500 |
| Ativação | % trials que agendam ≥ 10 consultas e assinam ≥ 3 prontuários em 14 dias | ≥ 40% |
| Conversão | Trial → pago | ≥ 20% |
| Receita | MRR; ARPA (receita média por conta) | MRR R$ 300 mil; ARPA R$ 350 |
| Retenção | Churn de logo mensal; NRR | ≤ 2,5%; NRR ≥ 105% |
| Valor (clínica) | Redução de no-show vs. linha de base do cliente | −30% |
| Valor (profissional) | Tempo médio de documentação por consulta (com escriba) | −50% |
| Valor (financeiro) | % recebimentos via Pix conciliados automaticamente | ≥ 90% |
| Valor (convênios) | Taxa de glosa em lotes gerados pela plataforma | ≤ 3% |
| IA | Taxa de aceitação do rascunho do escriba sem edição relevante (edit distance < 20%) | ≥ 60% |
| Satisfação | NPS clientes (clínicas); NPS pacientes | ≥ 50; ≥ 70 |
| Suporte | Tempo 1ª resposta; CSAT | < 15 min (horário comercial); ≥ 90% |
| Migração | Tempo médio de migração assistida | ≤ 5 dias úteis |
| LGPD/Segurança | Incidentes com dados pessoais; SLA atendimento a direitos do titular | 0; ≤ 15 dias (prazo legal de referência) |
| Confiabilidade | Disponibilidade mensal | ≥ 99,9% |

## 6. Escopo

> O detalhamento completo (cada microparte com ID, fase e critério de pronto) está em [WBS-micropartes.md](./WBS-micropartes.md). Aqui está o resumo.

### 6.1 MVP (Fase 1) — "Atender, documentar e receber"
Público-alvo do MVP: **profissionais autônomos e clínicas pequenas (até 10 profissionais), particular-first**, nichos: medicina, psicologia, nutrição, odontologia, fisioterapia e estética (fono/TEA com modelos genéricos).

- **Núcleo:** multi-tenant, usuários, papéis/permissões (RBAC), MFA, trilha de auditoria, unidades e salas, configurações da clínica.
- **Pacientes:** cadastro, busca, deduplicação, responsáveis legais, anexos, tags.
- **Agenda:** grade por profissional, tipos de atendimento, bloqueios, encaixe, recorrência, lista de espera simples, status do atendimento.
- **Agendamento online:** página pública da clínica/profissional + agendamento pelo bot de WhatsApp.
- **Comunicação:** WhatsApp Business API oficial (bot de agendamento/confirmação/remarcação + inbox compartilhada), lembretes automáticos, e-mail transacional; templates aprovados.
- **Prontuário:** construtor de modelos, modelos prontos por nicho, evolução, anamnese, anexos, assinatura do registro, bloqueio pós-assinatura, versionamento; componentes de nicho essenciais: odontograma básico, antropometria + gráficos, plano de sessões, fotos clínicas (estética), escalas simples.
- **Prescrição/documentos:** receituário simples e de controle especial (modelos), atestados, declarações, pedidos de exame, assinatura digital ICP-Brasil (via provedor), envio ao paciente por WhatsApp.
- **IA:** escriba (transcrição + rascunho estruturado do prontuário com revisão obrigatória), resumo do histórico, sugestão de CID (assistiva).
- **Financeiro:** contas a receber, caixa, formas de pagamento, recibos, repasse simples por profissional.
- **Pagamentos:** Pix (QR/copia-e-cola, cobrança com vencimento), link de pagamento, cartão via gateway, conciliação automática de Pix.
- **Fiscal:** NFS-e para municípios prioritários (via provedor agregador).
- **NPS pós-consulta** via WhatsApp.
- **Relatórios essenciais:** agenda/ocupação, no-show, faturamento por profissional.
- **Portal do paciente (web, mobile-first):** próximas consultas, documentos, pagamentos, consentimentos.
- **Migração/Exportação:** importação de planilha (pacientes/agenda) + importadores para 2 concorrentes principais; exportação total em formatos abertos.
- **Billing da plataforma:** planos, trial, assinatura recorrente, cotas de IA/WhatsApp.
- **Admin/backoffice + suporte:** gestão de tenants, impersonação auditada, central de ajuda, chat de suporte.
- **LGPD:** consentimentos granulares, termo de uso de IA, política de privacidade versionada, portal de direitos do titular, registro de operações (ROPA), RIPD do produto, gestão de incidentes, retenção de prontuário (20 anos — Lei 13.787/2018).

### 6.2 Fase 2 — "Clínicas com convênio e equipes"
- **Convênios/TISS completo:** cadastro de operadoras/planos, tabelas TUSS/preços, guias (consulta, SP/SADT, honorários), autorização, lotes XML, retorno/glosas, recurso de glosa.
- **Teleconsulta** integrada (vídeo no navegador, sala de espera, link por WhatsApp, gravação opcional com consentimento para o escriba).
- **Split de pagamentos** automático (repasse a profissionais via subcontas).
- **Estoque** (estética/odonto): produtos, lotes/validade, baixa por procedimento, alertas.
- **CRM/Marketing:** funil de leads, campanhas segmentadas (com base legal), reativação de inativos, aniversários.
- **IA avançada:** previsão de faltas, sugestão TUSS, chatbot de triagem/FAQ com RAG da clínica, resumo para paciente.
- **Integrações:** Memed (alternativa de prescrição), laboratórios (resultado de exames), Google Agenda.
- **Relatórios/BI** avançados (DRE gerencial, coortes de pacientes, desempenho por canal).
- **Odontograma completo**, plano de tratamento com orçamento e aprovação, módulos de fono/TEA (plano terapêutico multiprofissional).
- **App do paciente** (iOS/Android) e app do profissional (agenda + escriba no celular).
- **Migração:** importadores para demais concorrentes.

### 6.3 Fase 3 — "Ecossistema e escala"
- **RNDS** (Rede Nacional de Dados em Saúde) — envio de registros conforme padrões FHIR/BR Core aplicáveis.
- **API pública + webhooks + marketplace** de integrações.
- **Multiunidade/franquias** com consolidação gerencial.
- **IA:** codificação automática assistida de guias TISS, auditoria pré-envio de glosa por IA, copiloto de gestão (perguntas em linguagem natural sobre os dados da clínica), escriba multilíngue/multiparticipante.
- **Financeiro avançado:** antecipação de recebíveis (parceiro), conciliação bancária Open Finance, integração contábil.
- **Telemonitoramento** e formulários remotos (PROMs).
- **White-label** do portal do paciente.

## 7. Fora de escopo (por ora)
- Gestão hospitalar (internação, centro cirúrgico, farmácia hospitalar, CCIH).
- Laboratório de análises clínicas / LIS e PACS/RIS de imagem (apenas integração).
- Faturamento SUS (BPA/APAC/AIH).
- Diagnóstico autônomo por IA ou qualquer IA que tome decisão clínica sem revisão humana (a IA é sempre **assistiva**; caracterização como SaMD/ANVISA será avaliada pela frente IA + Guardião antes de qualquer feature de suporte à decisão clínica).
- Venda de dados, uso de dados de pacientes para publicidade ou compartilhamento com terceiros fora da finalidade.
- Treino da LLM com dados identificáveis de pacientes sem base legal, anonimização robusta e aprovação do Guardião LGPD.
- Folha de pagamento / RH completo; contabilidade completa (apenas integração).
- Marketplace de pacientes ("encontre um médico") no MVP.
- Operação em outros países/idiomas.

## 8. Riscos

| # | Risco | Prob. | Impacto | Mitigação |
|---|---|---|---|---|
| R1 | Vazamento de dado sensível de saúde (art. 11 LGPD) | Média | Crítico | LGPD by design, criptografia em repouso/trânsito, RBAC, auditoria, pentest, Guardião com veto, seguro cyber |
| R2 | Alucinação do escriba gerando registro clínico errado | Alta | Alto | Revisão e assinatura humana obrigatórias, destaque de trechos incertos, rastreabilidade áudio→texto, avaliação contínua por nicho, termo de uso |
| R3 | Custo de inferência da LLM própria inviabiliza margem | Média | Alto | Cotas por plano, modelo menor fine-tuned + roteamento, cache, medição de custo por consulta desde o MVP |
| R4 | Dependência da API do WhatsApp (Meta): bloqueio de número, mudança de preço/política | Média | Alto | Uso de API oficial, templates aprovados, opt-in, fallback SMS/e-mail, monitoramento de qualidade do número |
| R5 | Regulação: CFM (telemedicina, prontuário eletrônico), CFO, CFP, CFN, COFFITO, CFFa; NGS2 SBIS; ANVISA para software médico | Média | Alto | Consultoria regulatória, roadmap de certificação SBIS (F2/F3), IA estritamente assistiva |
| R6 | Complexidade de NFS-e (5.570 municípios) e transição para padrão nacional | Alta | Médio | Provedor agregador; priorizar municípios por base de clientes; acompanhar NFS-e Nacional |
| R7 | Complexidade TISS / regras por operadora | Alta | Médio | Deixar para F2, validações por operadora configuráveis, piloto com faturistas |
| R8 | Escopo amplo demais (todos os nichos) dilui o MVP | Alta | Alto | Construtor de prontuário genérico + componentes de nicho priorizados por pesquisa; MVP particular-first |
| R9 | Migração falha / dados perdidos na entrada | Média | Alto | Validação, dry-run, relatório de divergências, rollback, aceite do cliente |
| R10 | Concorrentes incumbentes reagem com IA e preço | Alta | Médio | Velocidade, foco em WhatsApp + escriba por nicho, transparência e portabilidade como marca |
| R11 | Fraude/chargeback em pagamentos e split | Baixa | Médio | Gateway com antifraude, KYC das subcontas, limites |
| R12 | Indisponibilidade em horário de atendimento | Baixa | Alto | SLO 99,9%, multi-AZ, modo degradado (agenda offline de leitura), status page |

## 9. Modelo de precificação sugerido (hipóteses a validar)

Princípios: **preço público no site**, sem taxa de implantação, sem fidelidade, migração assistida inclusa nos planos anuais, exportação de dados sempre gratuita. Cobrança **por profissional ativo** (quem tem agenda), recepção ilimitada.

| Plano | Para quem | Preço (hipótese, mensal / anual com desconto) | Inclui |
|---|---|---|---|
| **Essencial** | Autônomo começando | R$ 99 / profissional (R$ 79 no anual) | Agenda, agendamento online, prontuário com construtor, documentos, financeiro básico, portal do paciente, lembretes por e-mail, 1 número WhatsApp com bot básico (cota de conversas), 20 h/mês de escriba |
| **Profissional** | Autônomo/consultório estabelecido | R$ 189 / profissional (R$ 159 no anual) | Tudo do Essencial + inbox WhatsApp, Pix/link de pagamento, NFS-e (cota), NPS, escriba 60 h/mês, sugestão CID, relatórios |
| **Clínica** | Clínicas 3+ profissionais | R$ 249 / profissional (R$ 209 no anual) | Tudo do Profissional + multi-salas/unidades, repasse e split, estoque, CRM, BI, TISS (F2), permissões avançadas, escriba 100 h/mês |
| **Enterprise** | Redes/franquias | Sob proposta (com tabela base pública) | SSO, API, SLA dedicado, multiunidade, RNDS, ambiente dedicado |

Adicionais (pay-as-you-go, preço público): horas extras de escriba; pacote de conversas WhatsApp (repasse de custo Meta + margem); NFS-e excedente; taxa de transação de pagamentos (MDR Pix fixo baixo — ex.: R$ 0,99/transação; cartão conforme gateway); teleconsulta incluída a partir do Profissional.

Hipóteses a validar: disposição a pagar por nicho (psico e nutri mais sensíveis a preço; odonto e estética valorizam estoque/orçamento), elasticidade da cota de IA, receita de pagamentos como 20–30% da receita total no ano 2, trial de 14 dias sem cartão.

## 10. Requisitos não funcionais (resumo)
- **Segurança/LGPD:** criptografia AES-256 em repouso e TLS 1.2+ em trânsito; segregação lógica por tenant com testes; MFA obrigatório para profissionais; logs de auditoria imutáveis; dados hospedados no Brasil (preferencial); retenção do prontuário por 20 anos; backups criptografados com teste de restauração.
- **Desempenho:** P95 < 300 ms em telas de agenda; escriba entrega rascunho < 60 s após o fim da consulta.
- **Disponibilidade:** 99,9%/mês; RPO ≤ 15 min; RTO ≤ 4 h.
- **Acessibilidade:** WCAG 2.1 AA no portal do paciente e na página de agendamento.
- **Compatibilidade:** web responsivo (Chrome, Edge, Safari, Firefox — 2 últimas versões); mobile-first no portal do paciente.
- **Conformidade:** LGPD; Resoluções CFM de telemedicina e prontuário eletrônico; ICP-Brasil para assinatura; padrão TISS vigente (ANS); roadmap NGS2/SBIS.

## 11. Premissas e dependências externas
- Provedor de WhatsApp Business Platform (Cloud API) ou BSP homologado.
- Provedor de assinatura digital ICP-Brasil (certificado em nuvem A3/“cloud”).
- Gateway de pagamentos com Pix, cartão, split e subcontas (instituição autorizada BCB).
- Agregador de NFS-e.
- Infra de IA (GPU) para a LLM própria e STT (speech-to-text) em português clínico — definida pela frente 🤖 IA/LLM (`docs/05-ia-llm/`).

## 12. Questões em aberto
1. Escriba no MVP: STT + LLM própria desde o dia 1 ou LLM de terceiros com contrato de não-retenção como ponte, migrando para a própria em F2? (decisão IA + Guardião + Sócios)
2. Hospedagem de dados obrigatoriamente no Brasil?
3. Nicho de entrada para go-to-market (psico/nutri têm ciclo de venda curto; odonto/estética têm ticket maior)?
4. Certificação SBIS NGS2 — em que fase?
5. TISS no MVP para atrair médicos com convênio ou manter em F2?
