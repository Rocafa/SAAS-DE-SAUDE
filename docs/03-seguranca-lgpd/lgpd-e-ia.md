# LGPD e IA (LLM)

> Não é aconselhamento jurídico. ⚖️ = validar com advogado especialista. Complementa `docs/05-ia-llm/`.
>
> Fontes: LGPD arts. 5º (III, XI, XVIII), 6º, 11, 12, 13, 20, 33, 37, 38, 46 ([Planalto](https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm)); Res. CD/ANPD 19/2024 (transferência internacional); Medida Preventiva ANPD/Meta, jul/2024 ([nota](https://desinformante.com.br/wp-content/uploads/2024/07/Nota-004.2024.-Decisao-da-ANPD-sobre-IA-generativa.pdf)); Res. CFM 2.454/2026 ([CFM](https://portal.cfm.org.br/noticias/cfm-normatiza-uso-da-ia-na-medicina); [Demarest](https://www.demarest.com.br/cfm-publica-resolucao-que-regulamenta-o-uso-de-inteligencia-artificial-na-medicina/)); PL 2338/2023 ([Senado](https://www25.senado.leg.br/web/atividade/materias/-/materia/157233)); OWASP Top 10 for LLM 2025 ([genai.owasp.org](https://genai.owasp.org/)).

## 1. Princípios inegociáveis

1. **IA assiste, profissional decide.** Nenhuma saída de IA vira registro clínico, prescrição, diagnóstico, laudo ou mensagem ao paciente sem **revisão e confirmação explícita** do profissional responsável.
2. **Dados de pacientes não treinam modelos por padrão.** Treino/fine-tuning só com dados **anonimizados comprovadamente**, opt-in contratual da clínica, RIPD e aprovação N0 + jurídico.
3. **Provedor externo nunca retém nem treina** com nossos dados (cláusula contratual + configuração técnica verificada).
4. **Mínimo necessário no prompt.** Enviar só o trecho do prontuário necessário para a tarefa, com identificadores diretos removidos ou pseudonimizados.
5. **Transparência ao paciente** e direito de recusa (obrigatório para médicos — CFM 2.454/2026; adotado para todas as profissões).
6. **Tudo auditado**, nada em logs técnicos.

## 2. Anonimização x pseudonimização (art. 5º, III e XI; art. 12; art. 13, §4º)

| | Pseudonimização | Anonimização |
|---|---|---|
| Definição | Dado perde a associação direta ao titular, **mas ela pode ser restabelecida** com informação adicional mantida separadamente (art. 13, §4º) | Dado **não pode ser associado** ao titular considerando meios técnicos razoáveis disponíveis no momento (art. 5º, III e XI) |
| Continua sendo dado pessoal? | **Sim** (e continua sensível) | **Não** (art. 12), **salvo** se o processo for revertido com esforços razoáveis ou se o dado for usado para formar perfil comportamental de pessoa identificada (art. 12, §2º) |
| Uso no produto | Prompts para LLM, logs de IA, ambientes de análise interna | Datasets de treino, benchmarks, estatísticas |
| Exige base legal? | Sim, art. 11 | O **ato de anonimizar** exige (é tratamento); o resultado não |

**Atenção:** texto clínico livre é extremamente difícil de anonimizar. Nome, CPF e telefone são o mínimo; também identificam: datas exatas, cidade pequena, profissão rara, doença rara, descrição de evento ("acidente na BR-101 em março"), nomes de familiares, fotos, áudio/voz, combinações de idade+sexo+CEP. A ANPD ainda tem guia de anonimização na agenda regulatória; até lá, adotamos critério conservador.

### Procedimento mínimo de anonimização para dataset (MUST antes de qualquer treino)

1. Seleção pela finalidade (somente campos necessários; excluir notas psicológicas, dados de menores e categorias de alto risco por padrão).
2. Remoção/substituição de identificadores diretos (NER clínico em PT-BR + regras + listas) e de quasi-identificadores (generalização de datas para mês/ano ou deslocamento aleatório por paciente; idade em faixas; localização até UF).
3. Remoção de imagens, áudio, documentos anexos.
4. Métricas de risco: k-anonimato ≥ 10 sobre quasi-identificadores estruturados; amostragem de **revisão humana** do texto (≥ 1% ou 500 registros) com taxa de identificador residual < 0,1%.
5. **Teste de reidentificação** (equipe interna "red team" tentando ligar registros a pessoas) documentado.
6. Destruição das tabelas de correspondência (senão é pseudonimização).
7. Relatório de anonimização versionado (método, métricas, data, responsável) — disponível à clínica.
8. Reavaliação periódica (anonimização é relativa à tecnologia do momento).

⚖️ Mesmo anonimizado, avaliar o art. 11, §4º (vantagem econômica com dados de saúde) e a transparência às clínicas e pacientes.

## 3. Uso de provedores externos de LLM

| Requisito | Regra |
|---|---|
| Papel | Suboperador (nós somos operador da clínica). Listado publicamente. |
| Contrato | DPA com: proibição de treino com nossos dados; **retenção zero ou mínima** (ex.: ≤ 30 dias só para abuso, preferir ZDR contratual); sigilo; notificação de incidente ≤ 24 h; direito de auditoria/relatórios (SOC 2/ISO 27001); localização dos dados; subcontratados. |
| Transferência internacional | Se processar fora do Brasil: mecanismo do art. 33 — **cláusulas-padrão da ANPD (Res. 19/2024) integralmente**; registrar no ROPA e no RIPD. **Preferir endpoint com processamento no Brasil** (ex.: região sa-east-1 de nuvem que hospede o modelo). ⚖️ |
| Configuração técnica | Desativar logging/armazenamento do provedor quando configurável; não usar recursos que persistem conteúdo (ex.: "memória", arquivos, threads armazenadas) com dados C4; chaves de API por ambiente no Secrets Manager. |
| Gateway interno obrigatório | Toda chamada passa pelo módulo `ai` (gateway): autorização por tenant/usuário, redação/pseudonimização, filtro de saída, rate limit, auditoria, kill switch por tenant e global. **Proibido chamar LLM direto do front-end ou de outros módulos.** |
| Pseudonimização no envio | Substituir nome, CPF, telefone, endereço, e-mail, nº de carteirinha por tokens (`[PACIENTE_1]`) e reidentificar na volta, dentro do nosso ambiente. |
| Modelos self-hosted / open-weights | Preferidos para cargas sensíveis e para fine-tuning (dados não saem da nossa nuvem no Brasil). |
| Avaliação de fornecedor | Questionário de segurança + revisão jurídica + RIPD antes de ativar. Troca de provedor = mudança de suboperador (aviso de 30 dias às clínicas). |

## 4. Treino e fine-tuning com dados de clientes

| Cenário | Situação | Decisão |
|---|---|---|
| Dados identificáveis ou pseudonimizados para modelo compartilhado entre clínicas | Exigiria consentimento específico e destacado de cada paciente (art. 11, I); não somos órgão de pesquisa (art. 5º, XVIII — exige ausência de fins lucrativos), logo não usamos art. 11, II, "c" nem art. 13; legítimo interesse vedado para sensíveis (posição ANPD, 2024); risco do art. 11, §4º | **PROIBIDO** |
| Dados anonimizados (procedimento da seção 2) com opt-in contratual da clínica | Fora da LGPD após anonimização robusta; o ato de anonimizar autorizado em contrato | **Permitido com RIPD + parecer jurídico + aprovação N0** ⚖️ |
| Dados sintéticos gerados sem uso de dados reais, ou corpora públicos licenciados (diretrizes clínicas, bulas, literatura) | Sem dado pessoal | **Preferido** (verificar licenças/direitos autorais) |
| Fine-tuning exclusivo de uma clínica com seus dados | Base legal incerta (tutela da saúde para treino é discutível) | **Não no MVP** ⚖️ |
| Feedback do profissional (👍/👎, correções) | Pode conter dado clínico | Armazenar sem conteúdo clínico (apenas IDs e rótulos) ou passar pelo procedimento de anonimização |
| RAG (busca no prontuário do próprio tenant para responder) | Não é treino; é tratamento para a finalidade de cuidado | Permitido, com índice **por tenant**, ABAC respeitado (a IA só vê o que o usuário pode ver) |

Riscos técnicos específicos do treino: **memorização** e extração de dados de treino (membership inference, regurgitação). Mitigações: deduplicação, remoção de raros, privacidade diferencial quando viável, testes com "canários", avaliação de regurgitação antes de cada release de modelo, versionamento e capacidade de **descartar e retreinar** o modelo se um dado indevido entrar no dataset (dado dentro de pesos não é apagável individualmente).

## 5. Revisão humana, transparência e art. 20

- **Art. 20 LGPD:** titular pode pedir revisão de decisões tomadas **unicamente** com base em tratamento automatizado que afetem seus interesses, e informações sobre critérios. Desde a Lei 13.853/2019 o texto não exige revisão por pessoa natural, mas **nosso padrão exige** — e a Res. CFM 2.454/2026 determina que a palavra final é do médico.
- **Proibido** no produto: decisões automatizadas sobre o paciente sem humano (ex.: negar agendamento por "risco" calculado, priorizar fila por score sem revisão, enviar orientação clínica automática).
- **Requisitos de UX:**
  - Selo visível "Gerado por IA — revise antes de salvar" em todo conteúdo gerado.
  - Conteúdo gerado entra como **rascunho**; salvar exige ação explícita do profissional, que passa a ser autor.
  - **Registro automático no prontuário** de que houve apoio de IA (tipo de ferramenta, versão do modelo, data) — exigência CFM 2.454/2026.
  - **Aviso ao paciente** (aviso de privacidade da clínica + aviso no portal/TCLE) e **opção de recusa** por paciente (flag `ai_opt_out` respeitado pelo gateway).
  - Chatbot de paciente: identificar-se como IA, não diagnosticar, escalonar para humano, disclaimers de emergência (orientar SAMU 192).
- **Comissão de IA e Telemedicina** (CFM 2.454/2026): instituições médicas que desenvolvem ou contratam IA devem ter. Forneceremos às clínicas uma **ficha técnica por funcionalidade** (finalidade, classificação de risco baixo/médio/alto, limitações, dados usados, métricas de validação, versão) para alimentar a comissão.
- **Classificação de risco interna** (alinhada à CFM 2.454 e ao PL 2338): administrativo (baixo) → documentação/resumo (médio) → sugestão diagnóstica/terapêutica ou triagem (alto — exige validação clínica, avaliação ANVISA SaMD e aprovação N0) → manipulação/vigilância/score social (inaceitável — proibido).
- **SaMD (ANVISA RDC 657/2022):** funcionalidades com finalidade diagnóstica/terapêutica podem exigir regularização. Enquadramento antes de desenvolver. ⚖️

## 6. Viés e qualidade

- Princípio da **não discriminação** (LGPD art. 6º, IX) e foco do PL 2338 em discriminação algorítmica.
- Conjunto de avaliação por nicho (medicina, odonto, psico, nutri, fisio, fono, estética, TEA) e por subgrupos (sexo, faixa etária, raça/cor quando disponível e consentido, região, pessoas com deficiência, neurodivergentes, linguagem coloquial/regional).
- Métricas: precisão factual, alucinação (ex.: medicamento ou dose inexistente), omissão de alergias, diferenças de desempenho entre subgrupos (limite de tolerância definido por funcionalidade).
- Avaliação **antes de cada troca de modelo/prompt** e monitoramento contínuo com amostragem revisada por profissionais.
- Guardrails clínicos: checagem de doses/interações quando a saída mencionar medicamento; nunca gerar receita completa sem validação; linguagem não estigmatizante (saúde mental, TEA, obesidade).

## 7. Logs de prompts e respostas

- Prompts e respostas com dados clínicos são **C4** (mesmo nível do prontuário).
- Armazenamento: banco/bucket cifrado com DEK do tenant; **retenção ≤ 30 dias** para o que não for incorporado ao prontuário (o que for incorporado segue a regra do prontuário).
- Trilha de auditoria (sempre, retida como auditoria): usuário, tenant, paciente (ID), funcionalidade, modelo/versão, hash do prompt/resposta, tokens, latência, se foi aceito/editado/descartado. **Sem o texto.**
- **Proibido** enviar prompts/respostas para APM, Sentry, ferramentas de observabilidade de LLM de terceiros ou planilhas. Observabilidade de LLM só self-hosted ou com dados redigidos.
- Acesso de engenheiros ao conteúdo: break-glass apenas, com chamado.

## 8. Segurança específica de LLM (OWASP Top 10 LLM 2025)

- **Prompt injection** (direta e indireta — ex.: texto malicioso em PDF de exame anexado ou mensagem de WhatsApp): separar instruções de dados, o modelo **não tem ferramentas com permissão maior que a do usuário**, nenhuma ação com efeito (enviar mensagem, alterar prontuário, prescrever) sem confirmação humana.
- **Vazamento entre tenants**: contexto montado somente com dados do tenant e do paciente em atendimento; testes automatizados de isolamento no gateway.
- **Divulgação de informação sensível**: filtro de saída (PII de terceiros, segredos).
- **Saída insegura**: sanitizar antes de renderizar (XSS via markdown/HTML).
- **Consumo ilimitado**: quotas por tenant/usuário.
- **Cadeia de suprimentos de modelos**: modelos open-weights de fontes confiáveis, hash verificado, licença revisada.

## 9. Checklist rápido para qualquer feature de IA

- [ ] Finalidade e classificação de risco documentadas; RIPD atualizado.
- [ ] Passa pelo gateway `ai`; nada de chamada direta ao provedor.
- [ ] Mínimo necessário + pseudonimização no prompt.
- [ ] Provedor com DPA, sem treino, retenção zero/mínima, CPC se fora do Brasil.
- [ ] Resultado como rascunho + revisão humana obrigatória + registro de uso de IA no prontuário.
- [ ] Respeita `ai_opt_out` do paciente.
- [ ] Avaliação de qualidade e viés executada e anexada ao PR.
- [ ] Testes de prompt injection e isolamento de tenant.
- [ ] Nada de prompt/resposta em logs técnicos.
- [ ] Enquadramento SaMD avaliado se houver sugestão clínica.
