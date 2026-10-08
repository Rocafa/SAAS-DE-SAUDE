# Casos de uso de IA — por funcionalidade e por nicho

> Parte de [`README.md`](README.md). Para cada funcionalidade: tipo de modelo, entrada/saída, risco clínico, guarda-corpos e onde está o humano no loop.
> Custos e volumes aqui são **ESTIMATIVA**; normas citadas são **FATO** (fontes em [`avaliacao-e-seguranca.md`](avaliacao-e-seguranca.md)).

## Princípios que valem para todos os casos

1. **A IA rascunha, o profissional decide e assina.** Nada vai para o prontuário, para o convênio ou para o paciente sem aceite explícito de um profissional habilitado (Res. CFM 2.454/2026 exige supervisão humana e veda diagnóstico automático e comunicação de diagnóstico/conduta pela IA diretamente ao paciente; aplicamos o mesmo padrão a todos os conselhos).
2. **Rastreabilidade:** todo conteúdo gerado leva marca "gerado com IA — revisado por <profissional> em <data>", versão do modelo e do prompt, e o diff entre rascunho e versão final fica no log de auditoria.
3. **Saída estruturada** (JSON com schema) sempre que possível — facilita validação automática e reduz alucinação de formato.
4. **Citar a fonte** (trecho da transcrição, página do laudo, código da tabela) para cada afirmação relevante.
5. **Minimização:** só enviar ao modelo o necessário para a tarefa; pseudonimizar identificadores diretos.
6. **Opção de desligar:** cada clínica, profissional e paciente pode recusar o uso de IA (direito de recusa previsto pela Res. CFM 2.454/2026 para o paciente).

### Legenda de risco clínico

| Nível | Significado | Exigência mínima |
|---|---|---|
| 🟢 Baixo | Administrativo, sem efeito sobre conduta clínica | Monitoramento por amostragem |
| 🟡 Médio | Afeta documentação clínica; erro pode induzir erro se não revisado | Revisão humana obrigatória antes de salvar |
| 🟠 Alto | Sugere códigos/condutas que influenciam decisão ou faturamento | Revisão obrigatória + evidência citada + eval por nicho + avaliação SaMD |
| 🔴 Crítico | Diagnóstico/prescrição/triagem clínica autônoma | **Fora do escopo** (exigiria registro ANVISA e é vedado sem supervisão) |

---

## 1. Escriba clínico (transcrição de áudio → evolução estruturada)

| Item | Definição |
|---|---|
| **Tipo de modelo** | STT (speech-to-text) com diarização (separar falantes) + LLM de geração estruturada. Opcional: modelo pequeno para detectar seções |
| **Entrada** | Áudio da consulta (gravado no app, com consentimento registrado do paciente), nicho, template do profissional, (opcional) resumo prévio do paciente via RAG |
| **Saída** | Rascunho em formato do nicho (SOAP; anamnese + exame + conduta; evolução de sessão), com cada item ligado ao trecho da transcrição de origem; lista "pontos não mencionados" em vez de inventar |
| **Risco clínico** | 🟡 Médio — erro de transcrição em dose/lado/medicamento ("hiper" × "hipo", "direito" × "esquerdo"), alucinação de exame que não foi feito, omissão de alergia |
| **Guarda-corpos** | (1) Prompt proíbe inferir o que não foi dito; campos sem evidência ficam vazios. (2) Verificador automático: toda frase do rascunho precisa de âncora na transcrição (checagem por LLM-juiz ou similaridade). (3) Destaque visual para números, medicamentos, doses, lateralidade e negações. (4) Dicionário de termos/medicamentos (RAG) para corrigir STT. (5) Áudio apagado após aprovação (política de retenção). (6) Consentimento de gravação visível e registrado |
| **Humano no loop** | Profissional revisa lado a lado (rascunho × transcrição), edita e **assina**. Sem assinatura, nada é salvo no prontuário. Diff é guardado para avaliação/treino (se houver base legal) |
| **Custo estimado** | R$ 0,30–0,70 por consulta de 15 min (ver `arquitetura-ia.md`) |

## 2. Resumo do paciente ("o que preciso saber antes de entrar")

| Item | Definição |
|---|---|
| **Tipo de modelo** | LLM + RAG sobre o prontuário **do próprio paciente e da própria clínica** (isolamento por tenant) |
| **Entrada** | Evoluções, exames, prescrições, alergias, problemas ativos (estruturados + texto) |
| **Saída** | Resumo de ½ página: problemas ativos, medicamentos em uso, alergias, últimos exames relevantes, pendências; cada item com link para o documento de origem |
| **Risco clínico** | 🟡 Médio — omitir alergia ou medicamento, misturar pacientes (falha de isolamento = incidente grave) |
| **Guarda-corpos** | Alergias e medicamentos vêm **do campo estruturado**, não do LLM (o LLM só resume texto livre). Filtro de tenant + paciente aplicado na busca, testado em CI. Citações obrigatórias. Aviso "resumo gerado por IA, pode estar incompleto" |
| **Humano no loop** | Uso informativo; profissional consulta as fontes. Resumo não é salvo como documento clínico salvo se o profissional aceitar |

## 3. Sugestão de CID-10 (e CIAP-2 quando aplicável) e TUSS

| Item | Definição |
|---|---|
| **Tipo de modelo** | Recuperação híbrida (busca léxica + embeddings) nas tabelas oficiais + LLM para *re-ranking* e justificativa. Na Fase 2, candidato a fine-tune (classificador) |
| **Entrada** | Texto da evolução aprovada (ou trecho), nicho, procedimento realizado |
| **Saída** | Top-3 a 5 códigos com descrição oficial, trecho da evolução que justifica e nível de confiança. Para TUSS: procedimento + código + regras do convênio (quando houver base) |
| **Risco clínico** | 🟠 Alto — código errado gera glosa, informação falsa ao convênio, viés estatístico; CID em atestado/guia tem implicação ética e de sigilo |
| **Guarda-corpos** | O LLM **só pode escolher entre códigos recuperados** da tabela oficial (nunca inventar código). Validação de existência e vigência do código. Não pré-selecionar automaticamente. Regras por nicho (ex.: psicologia normalmente não usa CID em documentos ao paciente sem necessidade). Tabelas versionadas (CID-10 DATASUS, TUSS/ANS) |
| **Humano no loop** | Profissional escolhe; métrica "aceito sem edição" × "trocado" alimenta eval |

## 4. Extração de dados de exames (PDF/foto de laudo → campos estruturados)

| Item | Definição |
|---|---|
| **Tipo de modelo** | OCR/visão (LLM multimodal) + extração estruturada com schema (analito, valor, unidade, referência, data, laboratório). Ótimo candidato a fine-tune de modelo pequeno na Fase 2 |
| **Entrada** | PDF ou foto enviada pela clínica/paciente |
| **Saída** | JSON validado + gráfico de evolução de analitos; cada valor com recorte da imagem de origem |
| **Risco clínico** | 🟡/🟠 — vírgula decimal (1,5 × 15), unidade trocada (mg/dL × mmol/L), referência errada |
| **Guarda-corpos** | Validação de faixa plausível por analito; normalização de unidades com tabela; comparação com exame anterior (variação absurda → alerta); valores com baixa confiança ficam marcados; **não** gera interpretação ("anemia") — apenas sinaliza fora da referência do próprio laudo |
| **Humano no loop** | Confirmação dos campos antes de gravar como dado estruturado |

## 5. Chatbot WhatsApp — agendamento e triagem **administrativa**

| Item | Definição |
|---|---|
| **Tipo de modelo** | LLM pequeno/rápido com *tool use* (consultar agenda, marcar, remarcar, cancelar, enviar endereço/preparo) + classificador de intenção. API oficial WhatsApp Business (Cloud API) |
| **Entrada** | Mensagens do paciente; agenda; regras da clínica (convênios aceitos, preparo, endereço, valores) via RAG |
| **Saída** | Respostas; ações na agenda; transferência para humano |
| **Risco clínico** | 🟡 Médio por **desvio de escopo**: paciente relata sintoma grave, pede orientação de remédio, ideação suicida, emergência |
| **Guarda-corpos** | Escopo estritamente administrativo no prompt e em classificador separado. **Detector de urgência/risco** (dor torácica, falta de ar, sangramento, ideação suicida, violência) → resposta fixa e aprovada: orientar SAMU 192 / CVV 188 / pronto-socorro e acionar humano — nunca gerar conselho clínico. Recusa padronizada para perguntas clínicas ("vou encaminhar ao profissional"). Bot se identifica como assistente virtual. Proteção contra *prompt injection* (mensagens do paciente são dados, não instruções; ferramentas com permissão mínima, ex.: só ver horários livres, nunca dados de outros pacientes). Opt-in LGPD e opt-out ("SAIR"). Não pedir/receber exames ou dados clínicos pelo bot salvo fluxo seguro definido |
| **Humano no loop** | Fila de atendimento humano; escalonamento automático por baixa confiança, insatisfação ou 2 falhas de entendimento; revisão amostral de conversas (com anonimização) |

## 6. Previsão de faltas (*no-show*) — **ML clássico, não LLM**

| Item | Definição |
|---|---|
| **Tipo de modelo** | Gradient boosting (LightGBM/XGBoost) ou regressão logística, por clínica/nicho, com calibração de probabilidade |
| **Entrada** | Histórico de comparecimento, antecedência do agendamento, dia/horário, canal, confirmação, distância, clima (opcional), convênio × particular. **Sem** diagnóstico, sem raça/religião etc. |
| **Saída** | Probabilidade de falta por agendamento → ações: lembrete extra, pedido de confirmação, sugestão de *overbooking* controlado à recepção |
| **Por que não LLM** | Problema tabular; ML clássico é mais preciso, barato (centavos/mês), explicável (SHAP) e roda no nosso servidor no Brasil |
| **Risco** | 🟢 Baixo clínico; ⚠️ risco de **discriminação** (penalizar perfis socioeconômicos) |
| **Guarda-corpos** | Proibido usar a previsão para negar/penalizar atendimento automaticamente (LGPD art. 20); auditoria de viés por bairro/convênio; uso só para ações de lembrete; métricas AUC, Brier, calibração |
| **Humano no loop** | Recepção decide o overbooking |

## 7. Relatórios para convênio — TEA (fono, TO, psico, ABA, fisio)

| Item | Definição |
|---|---|
| **Tipo de modelo** | LLM + RAG (evoluções do período, plano terapêutico, metas, escalas aplicadas) + templates por operadora |
| **Entrada** | Evoluções das sessões do período, metas do PTS/PEI, frequência, escalas (resultados inseridos pelo profissional) |
| **Saída** | Rascunho de relatório de evolução/justificativa de continuidade com: objetivos, carga horária, frequência real, progresso por meta (com citação das sessões), próximos objetivos |
| **Risco clínico** | 🟠 Alto — relatório falso/inflado tem implicação ética (conselhos), contratual e potencialmente penal; erro pode gerar glosa e interromper terapia da criança |
| **Guarda-corpos** | Números (frequência, horas, escores) **vêm do banco**, não do LLM; cada afirmação de progresso cita sessões específicas; proibido "melhorar" resultados; linguagem do profissional, não da IA; comparação automática "frequência declarada × frequência registrada" |
| **Humano no loop** | Profissional responsável revisa e assina; coordenador clínico pode exigir dupla revisão |

## 8. Plano alimentar (nutrição)

| Item | Definição |
|---|---|
| **Tipo de modelo** | **Motor determinístico** de cálculo (TACO/TBCA, metas de kcal/macro/micronutrientes definidas pelo nutricionista) + LLM apenas para montar cardápios variados, substituições e texto de orientação |
| **Entrada** | Metas definidas pelo nutricionista, restrições (alergias, intolerâncias, preferências, religião, orçamento), rotina |
| **Saída** | Rascunho de cardápio + lista de substituições + totais calculados pelo motor (não pelo LLM) |
| **Risco clínico** | 🟠 Alto — alergia alimentar ignorada (anafilaxia), DRC, diabetes, gestação, transtorno alimentar |
| **Guarda-corpos** | Alergias/restrições como **filtro rígido** no motor (alimento proibido nunca entra); cálculo nutricional sempre do motor; o LLM não define metas; alertas para populações de risco; nada é enviado ao paciente sem aprovação do nutricionista |
| **Humano no loop** | Nutricionista ajusta e assina; só então o plano vai ao paciente |

## 9. Outros casos (backlog priorizado)

| Caso | Tipo | Risco | Observação |
|---|---|---|---|
| Rascunho de atestado/declaração/encaminhamento | LLM + template | 🟡 | Dados vêm do prontuário; profissional assina digitalmente |
| Busca semântica no prontuário ("quando foi o último HbA1c?") | RAG | 🟡 | Sempre com citação |
| Codificação odontológica (odontograma por voz) | STT + extração | 🟡 | Mapeia fala → dente/face/procedimento; confirmação visual |
| Orçamento estética/odonto a partir do plano | LLM + tabela de preços | 🟢 | Valores sempre da tabela |
| Mensagens de retorno/aniversário/reativação | LLM | 🟢 | Respeitar opt-in e evitar menção a diagnóstico em WhatsApp |
| Resumo financeiro/insights de gestão | LLM sobre dados agregados | 🟢 | Sem dado clínico |
| Triagem clínica de sintomas | — | 🔴 | **Fora de escopo** (SaMD + vedação CFM) |
| Sugestão de diagnóstico/prescrição | — | 🔴 | **Fora de escopo** nesta fase; só reavaliar com estratégia regulatória ANVISA própria |

---

## Matriz por nicho

| Nicho | Prioridade 1 | Prioridade 2 | Cuidados específicos |
|---|---|---|---|
| **Medicina** | Escriba SOAP; CID-10/TUSS; extração de exames | Resumo do paciente; atestados | Res. CFM 2.454/2026 (supervisão, registro do uso de IA, direito de recusa); CID em atestado só com autorização do paciente; prescrição nunca gerada pela IA |
| **Odontologia** | Odontograma por voz; orçamento | Evolução por procedimento; TUSS odonto | Normas do CFO sobre prontuário e publicidade; imagens radiográficas: **não** interpretar (seria SaMD) |
| **Psicologia** | Escriba de sessão **opcional** com consentimento reforçado; resumo de evolução | Relatórios/documentos psicológicos (rascunho) | Sigilo reforçado (Código de Ética do CFP; normas de documentos psicológicos). Preferir rota **100% Brasil** e retenção mínima; muitos profissionais não vão querer gravar — oferecer "ditado pós-sessão" em vez de gravar a sessão; nunca usar conteúdo de sessão para treino sem anonimização forte e consentimento específico |
| **Nutrição** | Plano alimentar (motor + LLM) | Extração de exames; anamnese alimentar por voz | Tabelas TACO/TBCA; transtornos alimentares → linguagem cuidadosa e sem metas automáticas |
| **Fisioterapia** | Escriba de evolução por sessão | Relatórios para convênio; prescrição de exercícios a partir de biblioteca **escolhida pelo fisioterapeuta** | Escalas (dor, ADM, força) como campos estruturados |
| **Estética** | Orçamento; termo de consentimento; follow-up | Evolução com fotos (só organização, sem análise automática de pele) | Fotos são dado sensível/biométrico em potencial; nada de "antes/depois" gerado ou alterado por IA; publicidade segue regras dos conselhos |
| **Fono / TEA (multi)** | Relatórios para convênio; escriba de sessão | Acompanhamento de metas PEI/PTS; comunicação com família/escola | Pacientes crianças → dados de criança e adolescente (LGPD art. 14, melhor interesse); consentimento dos responsáveis; relatórios com alto risco de glosa — dados quantitativos sempre do banco |

---

## Ordem de lançamento sugerida (ESTIMATIVA)

1. **MVP IA (mês 2–3):** chatbot WhatsApp administrativo + previsão de faltas + extração de exames.
2. **Mês 3–5:** escriba clínico (medicina, fisio, nutri) + resumo do paciente.
3. **Mês 5–7:** CID/TUSS, relatórios TEA, plano alimentar, odontograma por voz.
4. **Psicologia:** escriba só depois de validar consentimento, rota nacional e retenção com o Guardião LGPD.
