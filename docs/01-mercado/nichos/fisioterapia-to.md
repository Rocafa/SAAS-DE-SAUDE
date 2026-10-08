# Nicho: Fisioterapia e Terapia Ocupacional

> Frente: Pesquisa de Mercado · Executor N3 · Pesquisa realizada em 2026-10-06 (fontes acessadas nessa data, salvo indicação).
> Legenda: **[FATO]** · **[ESTIMATIVA]** · **[INFERÊNCIA]** · **[NÃO VERIFICADO]** (ver definição em `nutricao.md`).

## 1. Tamanho do mercado

| Indicador | Valor | Tipo | Fonte (data) |
|---|---|---|---|
| Fisioterapeutas + terapeutas ocupacionais registrados (COFFITO/CREFITOs) | ~480 mil (somados) | FATO (citado pelo sistema COFFITO/CREFITO em notícia de mar/2026) | [CREFITO-14, 26/03/2026](https://www.crefito14.org.br/noticias/noticias-congresso-nacional-fisioterapeutas-e-terapeutas-ocupacionais-de-todo-o-brasil-cobram-aprovacao-do-piso-salarial-2026-03-26) |
| Terapeutas ocupacionais | ~17.500 (6,6/100 mil hab.); déficit estimado ~24 mil | NÃO VERIFICADO (página com 403; data da matéria desconhecida) | [SEGS](https://www.segs.com.br/educacao/402869-brasil-tem-deficit-de-mais-de-20-000-profissionais-de-terapia-ocupacional) |
| Fisioterapeutas (estudo georreferenciado, base ~2018) | 206.170; 55,9% no Sudeste | FATO (antigo) | [Interfisio](https://interfisio.com.br/distribuicao-territorial-dos-profissionais-de-fisioterapia-no-brasil/) |
| Recibos Receita Saúde emitidos por fisio/TO autônomos | ~92.829 só em jan/2025 (SP 27.202; RJ 19.301) | FATO | [COFFITO, 18/03/2025](https://www.coffito.gov.br/nsite/?p=32882) |

**[INFERÊNCIA]** Mesmo descontando TO (~17,5 mil), há centenas de milhares de fisioterapeutas — o segundo maior contingente de saúde não médica, com forte presença de **clínicas** (ortopedia/esportiva, neuro, pélvica, pilates, home care) além de autônomos. O número de 480 mil inclui inscrições possivelmente inativas; usar com cautela.

**Lacuna:** nº de clínicas de fisioterapia (CNES/CNAE 8650-0/04) não levantado nesta rodada — pesquisar no CNES.

## 2. Perfil do cliente, ticket, convênio x particular

- **Segmentos:** (a) autônomo/atendimento domiciliar; (b) clínica pequena (2–10 fisios) de ortopedia/esportiva com forte **convênio**; (c) studios de pilates (mensalidade); (d) clínicas de reabilitação neuro/infantil (cruza com TEA, ver `fono-e-terapias-tea.md`); (e) TO em reabilitação, saúde mental e infantil/TEA.
- **Referencial:** COFFITO publica o Referencial Nacional de Procedimentos Fisioterapêuticos; Coeficiente de Valoração subiu de R$ 0,79 (2024) para R$ 0,85 (2025); tabela de TO ainda em elaboração — **[FATO]** ([CREFITO-7, 13/01/2025](https://crefito7.gov.br/atualizacao-do-referencial-nacional-de-honorarios-fisioterapeuticos-2025/)).
- **Convênio:** queixa histórica de remuneração muito baixa por sessão (CREFITO-8 citou R$ 5–7 por procedimento) — **[FATO antigo, data não confirmada]** ([Tribuna PR](https://www.tribunapr.com.br/noticias/economia/fisioterapeutas-querem-negociar-valor-de-procedimentos/amp/)). **[INFERÊNCIA]** convênio dá volume, particular dá margem; clínicas mistas são a norma.
- **Fim do limite de sessões:** RN ANS 541/2022 (vigência 01/08/2022) acabou com limite de sessões de fisioterapia, fono, TO e psicologia nos planos regulamentados — **[FATO]** ([Migalhas](https://www.migalhas.com.br/depeso/369757/ans-aprovou-fim-da-limitacao-de-sessoes); [Idec](https://idec.org.br/dicas-e-direitos/fim-do-limite-de-sessoes-de-fono-fisioterapeuta-e-psicologo-o-que-fazer-em-caso-de)). Ainda assim, operadoras controlam via **autorização de guias** (nº de sessões por guia/pedido médico).

## 3. Dores e rotina

- Alto volume de sessões curtas, recorrentes (2–3x/semana, 10–20 sessões por plano) → agenda de **horário recorrente**, remarcação e faltas.
- **Guias de convênio:** autorização prévia, controle de sessões autorizadas x realizadas, **assinatura do paciente por sessão** (comprovação), faturamento TISS em lote, glosas.
- Venda de **pacotes** particulares (10 sessões) e mensalidade de pilates; controle de saldo.
- Evolução diária curta por sessão (muitas por dia) — digitação é gargalo.
- Repasse/comissão para fisioterapeutas PJ por sessão.
- Emissão de recibo Receita Saúde (autônomos) e NFS-e (clínicas).

## 4. Requisitos específicos de software

| Requisito | Detalhe |
|---|---|
| Agenda multi-sala/aparelho | Atendimento simultâneo (1 fisio x 2–4 pacientes), salas, aparelhos de pilates |
| Agenda recorrente | Gerar série de sessões a partir do plano; remarcar em bloco |
| Pacotes e saldo | Pacote de N sessões, consumo automático, validade, mensalidade pilates |
| Convênio / TISS | Guia SP/SADT, nº de sessões autorizadas, alerta de guia vencendo/esgotada, assinatura digital do paciente por sessão, lote XML TISS, controle de glosa |
| Evolução por sessão | Template rápido (SOAP), escalas (EVA dor, goniometria, força, testes ortopédicos, Barthel/FIM para TO), gráfico de evolução |
| Avaliação | Fichas por especialidade (ortopédica, neuro, respiratória, pélvica, dermatofuncional); body chart |
| Exercícios domiciliares | Biblioteca de vídeos + prescrição pelo app (diferencial do Physitrack) |
| Repasse | Comissão por sessão/profissional, por convênio |
| Fiscal | Receita Saúde (autônomo PF) e NFS-e |
| Telessaúde | Teleconsulta/telemonitoramento com registro (Res. COFFITO 619/2025) |

## 5. Regulação que impacta o software

- **Res. COFFITO 414/2012:** registro obrigatório em prontuário (papel ou eletrônico), guarda e descarte; prontuário é propriedade física da instituição — **[FATO]** ([LegisWeb](https://www.legisweb.com.br/legislacao/?id=241547)).
- **Res. COFFITO 619/2025 (28/05/2025):** atualiza telefisioterapia/teleterapia ocupacional — **[FATO: existência]** ([ABMES](https://abmes.org.br/legislacoes/detalhe/5208/resolucao-coffito-n-619)); detalhes a confirmar ([Physitrack – resumo](https://www.physitrack.com/pt/insights/resolucao-coffito-619-2025-telefisioterapia-brasil)).
- **Receita Saúde (IN RFB 2.240/2024):** obrigatório desde 01/01/2025 para fisio e TO pessoa física — **[FATO]** ([COFFITO](https://www.coffito.gov.br/nsite/?p=32882); [LegisWeb IN 2240](https://www.legisweb.com.br/legislacao/?id=470239)).
- **ANS – RN 541/2022:** sem limite de sessões (ver seção 2). Padrão **TISS** para faturamento.
- **IA:** não foi encontrada resolução COFFITO específica sobre IA (busca em 2026-10-06). Referência analógica: Res. CFM 2.454/2026 (IA como apoio; profissional responsável) — **[FATO]** (citada em busca; texto não aberto).

## 6. Concorrentes específicos e preços

| Produto | Preço/mês | Destaques | Fonte (data) |
|---|---|---|---|
| **ZenFisio** | Profissional R$ 79 (1 prof.); Equipe R$ 179 (5 prof.); Clínica R$ 439 (20 prof.); add-ons financeiro R$ 29–39, marketing R$ 29–69, assinatura eletrônica R$ 19–49 | Foco fisio/TO/pilates/estética; app paciente FiqueZen; ZenPago; captação BuscaFisio | [zenfisio.com](https://www.zenfisio.com/) (2026-10-06) |
| **Physitrack** | R$ 169/profissional | Biblioteca 18 mil+ vídeos de exercícios, IA scribe, app PhysiApp | [Physitrack comparativo, 04/10/2026](https://www.physitrack.com/pt/insights/melhor-software-fisioterapia-brasil-comparativo) (conteúdo do próprio fornecedor — viés) |
| **Vedius** | R$ 79,90 (individual) | Prontuário por voz com IA, agenda WhatsApp | idem |
| **Kynesia** | Grátis a R$ 89,90 | Evolução por voz/texto, sugestão de testes ortopédicos, laudos por IA | idem |
| **Fisioly** | Grátis a R$ 149,90 | Plano gratuito permanente | idem |
| iClinic (generalista) | R$ 99–299/prof. (TISS a partir do Plus R$ 129) | — | [iclinic.com.br/precos](https://www.iclinic.com.br/precos/) |

**[INFERÊNCIA]** Mercado de software de fisio é fragmentado e barato (R$ 0–180 por profissional). Concorrentes de nicho já usam **IA por voz na evolução** — isso já é commodity, não diferencial.

## 7. Uso de IA/LLM no nicho e riscos

- **Em uso:** ditado/transcrição para evolução (Vedius, Kynesia, Physitrack), sugestão de testes, laudos gerados por IA.
- **Oportunidades:** evolução por voz com preenchimento de escalas; resumo para relatório ao médico solicitante/operadora; prescrição de exercícios por IA a partir do diagnóstico funcional (com revisão); análise de movimento por vídeo (futuro).
- **Riscos:** laudos/relatórios para convênio gerados por IA com dados inventados (alucinação ⇒ glosa ou fraude); responsabilidade profissional (o fisioterapeuta assina); áudio de consulta é dado sensível (LGPD, consentimento para gravação); prescrição de exercício inadequada.

## 8. MVP vs desejável

| MVP | Desejável |
|---|---|
| Agenda recorrente, multi-paciente por horário, salas | Biblioteca de exercícios em vídeo + app do paciente |
| Pacotes de sessões com saldo; mensalidade (pilates) | Evolução por voz com IA + escalas auto-preenchidas |
| Guia de convênio: sessões autorizadas x realizadas, alerta, assinatura do paciente por sessão | Faturamento TISS completo com conciliação de glosas |
| Evolução por sessão com templates SOAP + escalas (EVA, goniometria) | Relatórios automáticos ao médico/operadora |
| Repasse por sessão | Telemonitoramento |
| Receita Saúde / recibo e NFS-e | Integração com wearables/dinamometria |
