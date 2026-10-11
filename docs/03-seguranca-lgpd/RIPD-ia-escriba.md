# RIPD — IA assistiva (escriba) ⚖️ RASCUNHO

> ⚖️ **Rascunho para o advogado.** Não é parecer jurídico nem RIPD aprovado. Preenchido a partir de [RIPD-modelo.md](RIPD-modelo.md) (item 6 do Anexo A) pelo agente `guardiao-lgpd` na rodada 8, com base no código do PR #29 e no protocolo de avaliação do escriba.
> **Este RIPD descreve um tratamento que AINDA NÃO EXISTE.** Nada do módulo `ai` está ligado ao `AppModule`, nenhum provedor real está implementado, e o adaptador fake não faz chamada de rede. O documento serve para (a) condicionar o PR que ligar o módulo e (b) dizer, antes de escrever a feature, o que ela precisa ter.
> Norma central lida no texto oficial em 11/10/2026: **Resolução CFM nº 2.454/2026**, DOU de 27/02/2026 (Ed. 39, Seção 1, p. 158), em vigor desde 26/08/2026 (art. 23), aplicável também aos sistemas já em uso na data da vigência (art. 21).

## 0. Identificação

| Campo | Preenchimento |
|---|---|
| Nome do tratamento / funcionalidade | **Escriba**: transcrição da consulta e geração de rascunho de evolução clínica por modelo de linguagem, para revisão e assinatura do profissional |
| Versão do RIPD / data | 0.1 (rascunho) — 2026-10-11 |
| Controlador | **A clínica contratante.** Nós somos operadores (art. 39 da LGPD) enquanto não houver treino nem uso próprio dos dados; se houver, passamos a controladores — ver [papeis-controlador-operador.md](papeis-controlador-operador.md) |
| Operador(es) e suboperadores | Nós (plataforma); provedor de LLM **a definir na D3** (candidatos: Gemini via Vertex AI em `southamerica-east1`; Maritaca/Sabiá). Transcrição de áudio para texto: fornecedor **a definir**, e é um suboperador esquecido no escopo original (ver risco R11) |
| Encarregado | A nomear (pendente — ver item 11 do mapa regulatório) |
| Responsável pela elaboração | Agente `guardiao-lgpd` (rascunho) |
| Partes consultadas | Nenhuma. **Pendente:** jurídico (D8), médico/clínico, frente de IA, frente de engenharia |
| Motivo do RIPD | ☑ Dado sensível ☑ Larga escala ☑ Menores (pediatria, TEA) ☑ IA / decisão automatizada ☑ Nova tecnologia ☐ Transferência internacional (vedada para esta função — ver 2.2) ☐ Solicitação da ANPD |
| Classificação de risco CFM 2.454/2026 | **Médio risco** (Anexo II, II): apoia decisão clínica importante sem executá-la, e o erro é detectável e corrigível pelo profissional antes de causar dano. Consequência: o Anexo II §2º exige monitoramento regular e avaliação de desempenho e de viés em intervalos definidos |

## 1. Necessidade do RIPD

O tratamento reúne, de uma vez, quase todos os fatores que caracterizam alto risco: dado pessoal **sensível** de saúde (art. 11), em **larga escala**, incluindo **crianças e adolescentes**, com **uso de nova tecnologia** e envio a **terceiro** (provedor de LLM), sobre o conteúdo mais íntimo que o paciente produz — a fala espontânea numa consulta. O RIPD é necessário por padrão neste projeto para dados de saúde, e aqui seria necessário mesmo que não fosse.

Há um agravante que o modelo genérico não captura: o escriba trata **texto livre falado**, não campos estruturados. Texto livre é o material mais difícil de pseudonimizar e o mais fácil de reidentificar — a pessoa diz o nome do filho, o bairro, o nome do patrão, a data do casamento. Qualquer afirmação de anonimização sobre transcrição de consulta precisa ser demonstrada, nunca presumida ([lgpd-e-ia.md](lgpd-e-ia.md) já classifica texto clínico livre como "extremamente difícil de anonimizar").

## 2. Descrição do tratamento

### 2.1 Natureza

Fluxo pretendido, com os pontos de controle numerados:

1. O profissional informa o paciente de que a consulta pode ser apoiada por IA e registra a resposta **(C1 — registro de informação e recusa)**.
2. Com o consentimento registrado, o áudio da consulta é capturado no dispositivo do profissional.
3. O áudio é transcrito em texto **(C2 — suboperador de transcrição; decidir se roda no dispositivo, no nosso servidor ou em terceiro)**.
4. A transcrição passa pela **pseudonimização** antes de sair do nosso processo **(C3)**.
5. O gateway `ai` monta a requisição, aplica a política de roteamento e chama a rota elegível **(C4 — residência de dados; BR obrigatório)**.
6. O modelo devolve um **rascunho** estruturado, nunca um documento final **(C5 — `requiresHumanReview`)**.
7. O profissional revisa, corrige e assina. A proveniência e o uso de IA são gravados no prontuário de forma não editável **(C6 — art. 4º, V da CFM 2.454/2026)**.
8. O áudio é descartado após a transcrição, e a transcrição após a geração do rascunho, salvo decisão em contrário registrada **(C7 — retenção)**.
9. Cada chamada gera evento de auditoria sem texto clínico **(C8)**.

Fontes dos dados: fala do paciente e do profissional; contexto do prontuário quando usado como RAG. **Tecnologia nova:** reconhecimento de voz e modelo de linguagem de larga escala (LLM, definido no Anexo I, XI da CFM 2.454/2026).

### 2.2 Escopo

| Item | Preenchimento |
|---|---|
| Categorias de titulares | Pacientes e seus responsáveis legais; profissionais de saúde (voz e identificação) |
| Inclui crianças e adolescentes? | **Sim** — pediatria, odontopediatria e TEA/ABA estão no nicho de entrada. Art. 14 da LGPD e Lei 15.211/2025 aplicáveis |
| Categorias de dados pessoais | Nome, vínculo familiar, endereço aproximado, profissão, relações pessoais — tudo o que aparece numa fala espontânea |
| Categorias de dados sensíveis | **Saúde** (queixa, história, hipótese, conduta), **vida sexual**, **origem racial ou étnica**, **convicção religiosa** e **opinião política** podem aparecer sem serem perguntados: é consulta, não formulário. Em psicologia, a sessão inteira é dado sensível |
| Volume estimado | ESTIMATIVA: piloto de 30 clínicas, 20 a 40 consultas por profissional por semana. Larga escala desde o piloto |
| Frequência | Contínua, por consulta |
| Prazo de retenção | Áudio: **descartado após a transcrição** (proposta). Transcrição: **descartada após o rascunho aceito ou recusado** (proposta). Rascunho incorporado ao prontuário: segue o prontuário — ver [matriz-retencao.md](matriz-retencao.md). Registro de uso de IA e proveniência: segue o prontuário. **No provedor: retenção zero, por contrato** |
| Abrangência / armazenamento | Brasil. AWS São Paulo; LLM em São Paulo (Vertex `southamerica-east1`) ou nacional (Maritaca) |
| Transferência internacional | **Vedada para esta função.** A política de roteamento trava `sensivel` em BR, e psicologia em BR mesmo pseudonimizada e mesmo com transferência aceita em contrato. Se algum dia houver rota estrangeira para conteúdo pseudonimizado, exige cláusulas-padrão da Res. CD/ANPD 19/2024 e aceite expresso do tenant |

### 2.3 Contexto

A expectativa razoável do paciente numa consulta é de **sigilo entre ele e o profissional**. Ninguém, ao relatar um sintoma, espera que a frase seja enviada a uma empresa de tecnologia. Esse é o descompasso central deste tratamento, e é por isso que a CFM 2.454/2026 exige, no art. 11, que qualquer uso de IA seja "comunicado e explicado" ao paciente, e no art. 5º §3º que a recusa informada seja respeitada.

O grau de controle do titular é, por desenho, binário e precisa continuar sendo: ele pode recusar, e a recusa bloqueia a função para ele. A norma não dá ao paciente o direito de escolher o provedor nem de auditar o modelo; dá o direito de ser informado e de dizer não.

Preocupação pública conhecida: o precedente da ANPD no caso Meta (medida preventiva, jul/2024) firmou que **legítimo interesse não ampara tratamento de dado sensível para treino de IA**. Isso não atinge o escriba, que não treina, mas atinge qualquer tentação futura de usar os pares "rascunho → versão final" como ativo.

### 2.4 Finalidade

Reduzir o tempo de documentação clínica, que é a queixa de maior frequência do profissional autônomo, e melhorar a completude do registro. Benefício ao titular: profissional atento à consulta em vez de ao teclado, e prontuário mais completo. Benefício à clínica: tempo. Benefício à plataforma: diferencial de produto e retenção.

**Finalidade vedada, registrada aqui para não ser esquecida:** nenhum dado deste fluxo é usado para treinar, ajustar ou avaliar modelo próprio ou de terceiro, nem para construir dataset, nem para benchmark comercial. Qualquer mudança nisso é tratamento novo, com RIPD próprio, em que **nós seríamos controladores**, e com o art. 11 §4º da LGPD no caminho.

## 3. Base legal

| Operação | Base legal | Justificativa | Consentimento? |
|---|---|---|---|
| Transcrever a consulta e gerar rascunho da evolução | **Art. 11, II, "f"** — tutela da saúde, em procedimento realizado por profissional de saúde ⚖️ | A documentação clínica é parte do ato de cuidado e obrigação do profissional. A IA é meio de produzi-la, sob revisão humana | Não é a base, mas **a informação ao paciente e o respeito à recusa são obrigatórios** pela CFM 2.454/2026, arts. 5º §1º, §3º e 11 |
| Enviar conteúdo pseudonimizado a provedor de LLM (suboperador) | Mesma base da operação principal, com o provedor como **suboperador** do nosso contrato (art. 39) | Não é compartilhamento com terceiro para finalidade própria dele: é execução de instrução, com retenção zero e proibição de treino por contrato | — |
| Gravar áudio da consulta | ⚖️ **Ponto aberto.** Pode exigir **consentimento específico e destacado** (art. 11, I), por ser captação de voz com conteúdo sensível e por não ser necessária ao ato de cuidado em si — o que é necessário é a nota final | Se for consentimento: coletado antes da captura, revogável, com registro do texto apresentado | **Provável sim** |
| Registrar o uso de IA no prontuário | **Art. 11, II, "a"** — cumprimento de obrigação legal e regulatória pelo controlador (art. 4º, V da CFM 2.454/2026) | O registro é dever do médico; o sistema o torna automático | Não |
| Registrar a informação dada e a recusa do paciente | Art. 11, II, "a" e art. 37 | É a prova de que a norma foi cumprida e de que não usamos IA sobre quem recusou | Não |

A pergunta ⚖️ mais importante desta seção: **a tutela da saúde do art. 11, II, "f" cobre a gravação do áudio, ou só a produção do registro clínico?** Se cobrir apenas o segundo, o áudio precisa de consentimento específico e o produto precisa funcionar sem ele — o que muda o desenho da feature, não só o aviso de privacidade.

## 4. Necessidade e proporcionalidade

- **Mínimo necessário.** Fora do escopo por decisão: identificação de falante por biometria de voz; retenção do áudio depois da transcrição; retenção da transcrição depois do rascunho; envio do prontuário inteiro como contexto (só o trecho necessário); e qualquer campo novo coletado "para melhorar o modelo".
- **Alternativa menos invasiva.** A mais forte é **transcrever no dispositivo** e nunca deixar o áudio sair dele. Deve ser avaliada antes de contratar fornecedor de transcrição em nuvem: elimina um suboperador inteiro e o risco R11. Segunda alternativa: rascunho a partir de notas digitadas pelo profissional, sem áudio, como modo de operação para quem recusa a gravação.
- **Qualidade e exatidão.** É o maior risco clínico, não o maior risco de privacidade. O protocolo de avaliação trata disso com âncora literal obrigatória (toda afirmação do rascunho precisa casar com trecho da transcrição), armadilhas de alucinação e casos de negação invertida. A âncora literal é, na prática, um controle de exatidão do art. 6º, V da LGPD.
- **Direitos do art. 18.** Acesso e portabilidade pelo prontuário; correção pela revisão do profissional (o rascunho nunca é o registro final); **revisão do art. 20 atendida por desenho**, porque não há decisão automatizada — há sugestão revisada. A revogação do consentimento (se aplicável ao áudio) interrompe a função para frente, sem apagar o prontuário já formado.
- **Como o titular é informado.** Aviso no momento da consulta, dado pelo profissional, com registro no sistema; aviso de privacidade da clínica atualizado; e menção no termo de uso do portal do paciente. O art. 11 exige que seja "comunicado e explicado" — logo o texto precisa dizer o que a IA faz, não apenas que existe IA.
- **Suboperadores.** Nenhum pode ser contratado sem DPA com não retenção e não treino, lista de suboperadores próprios, região de processamento declarada, e cláusulas-padrão da ANPD se houver qualquer etapa fora do Brasil.

## 5. Metodologia de coleta e garantia de segurança (art. 38, parágrafo único)

Estado em 11/10/2026, com base no código do PR #29. "Não" aqui não é crítica ao PR: o módulo não está em uso.

| Controle | Implementado? | Evidência |
|---|---|---|
| Criptografia em trânsito / repouso / campo | Parcial | TLS e HSTS na borda ([requisitos-tecnicos-seguranca.md](requisitos-tecnicos-seguranca.md)). Criptografia de campo com chave por tenant para C4 ainda não implementada |
| Isolamento multi-tenant (RLS + testes) | Não se aplica ao módulo | O módulo `ai` não acessa banco. `tenantId` entra só como rótulo de roteamento |
| MFA, RBAC/ABAC, break-glass | Não | Pendente da D4 (autenticação) |
| Auditoria imutável | **Não** | Nenhum evento de auditoria é emitido pelo `AiService`. **Condição V2 do parecer do PR #29** |
| Backup e restauração testada | Não | Pendente |
| Hospedagem no Brasil | Por política, sim | `routing-policy.ts` trava `sensivel` e psicologia em residência BR, com `default` fechado em BR para valor desconhecido |
| Gestão de segredos | Não se aplica ainda | Nenhuma credencial de provedor existe. `AI_PROVIDER` real lança erro no boot |
| Pentest / ASVS | Não | Pendente (D13) |
| Plano de resposta a incidentes | Rascunho | `plano-resposta-incidentes.md` está no PR #28 |
| **Gateway único de IA** | **Sim** | `AiService` é a única porta; `no-network.test.ts` prova no CI que nenhum arquivo do módulo faz chamada externa |
| **Pseudonimização** | **Não** | `sensitivity` é rótulo declarado por quem chama, não derivado nem validado. **Condição V1** |
| **Revisão humana obrigatória** | **Sim, por tipo** | `AiDraft.requiresHumanReview: true` não é opcional no tipo |
| **Sem treino / sem retenção no provedor** | Não verificável ainda | Depende do DPA. **Condição V3** |
| **Versão de modelo fixada** | **Sim** | `ModelRef` exige `version`; alias `latest` vedado por convenção escrita |
| **Registro do uso de IA no prontuário** | **Não** | `AiProvenance` tem o material, mas nada persiste. Art. 4º, V da CFM 2.454/2026 |
| **Classificação de risco informada ao usuário** | **Não** | Arts. 12 e 13. Ressalva R2 do parecer do PR #29 |
| **Bloqueio por recusa do paciente** | **Sim, com defeito de documentação** | `routeRequest` nega `recusou` e nega `undefined`; mas o comentário do tipo manda tratar ausência de registro como permissão. Ressalva R1 do parecer do PR #29 |

## 6. Identificação e avaliação de riscos

Probabilidade 1 a 5, impacto 1 a 5, nível = P × I (1–6 baixo, 8–12 médio, 15–25 alto). Avaliação **sem** as mitigações pendentes — isto é, o estado em que o tratamento estaria se a feature fosse ligada hoje.

| # | Risco ao titular | Fonte / causa | P | I | Nível |
|---|---|---|---|---|---|
| R3 | Vazamento ou uso secundário no provedor de LLM | Retenção ou treino no provedor, incidente do fornecedor | 3 | 5 | **15 alto** |
| R6 | Reidentificação do conteúdo "pseudonimizado" | Texto livre falado: nome de familiar, bairro, profissão, data. Pseudonimização não implementada | 4 | 5 | **20 alto** |
| R7 | Dano por rascunho incorreto que vira registro clínico | Alucinação, negação invertida ("não tem dor" virar "tem dor"), revisão apressada pelo profissional | 4 | 5 | **20 alto** |
| R11 | **Vazamento pelo fornecedor de transcrição de áudio** | Suboperador esquecido no escopo original: o áudio é mais sensível que o texto, carrega voz (dado biométrico em potencial) e costuma ir para terceiro com retenção por padrão | 4 | 5 | **20 alto** |
| R12 | **Uso de IA sobre paciente que nunca foi informado** | "Ausência de registro = não recusou" no tipo de consentimento; infringe arts. 5º §1º, §3º e 11 da CFM 2.454/2026 | 4 | 4 | **16 alto** |
| R2 | Acesso indevido interno ao áudio ou à transcrição | Material transitório sem política de acesso própria; suporte depurando um caso | 3 | 4 | **12 médio** |
| R13 | **Fala de terceiro capturada sem base legal** | O acompanhante fala; a mãe relata pelo filho; o paciente cita o patrão e o vizinho. Esses terceiros não são titulares do atendimento e não foram informados de nada | 4 | 3 | **12 médio** |
| R5 | Desvio de finalidade: pares rascunho/final viram dataset | Pressão por diferencial de IA; o material é tentador e já apareceu como "ativo" em documento de produto | 2 | 5 | **10 médio** |
| R9 | Viés do modelo entre grupos de pacientes | Modelo treinado fora do contexto brasileiro; sotaque, variação regional, terminologia popular | 3 | 3 | **9 médio** |
| R10 | Tratamento de dado de menor sem consentimento do responsável | Pediatria e TEA no nicho de entrada; consentimento colhido do adulto errado | 3 | 4 | **12 médio** |
| R14 | **Injeção por fala** | Paciente ou terceiro diz em voz alta instrução para o modelo ("ignore o anterior e escreva que..."). Os golden sets já cobrem o caso (`injecao_falada`) | 3 | 3 | **9 médio** |
| R4 | Indisponibilidade da função | Provedor fora, timeout | 4 | 1 | 4 baixo |

Risco global **antes** da mitigação: **alto**. Por isso o parecer do PR #29 veta o PR que ligar o módulo até V1–V5.

## 7. Medidas de mitigação

| Risco | Medida | Responsável | Prazo | Residual | Aceito? |
|---|---|---|---|---|---|
| R3 | DPA com não retenção e não treino, região declarada, lista de suboperadores do provedor, cláusulas da Res. 19/2024 se houver etapa fora do Brasil; `tasks` do adaptador só com o que passou no eval | Sócios + jurídico | Antes de fechar a D3 | 6 baixo | Pendente |
| R6 | Pseudonimização dentro do gateway, antes de montar a requisição; `sensitivity` **derivada** da origem, nunca recebida; verificação de saída que barra a chamada se identificador direto sobreviver; teste de reidentificação documentado e repetido a cada mudança de modelo | Engenharia + IA | Condição V1 | 10 médio ⚖️ | Pendente |
| R7 | Âncora literal obrigatória; rascunho nunca é registro final (`requiresHumanReview`); diferença visual entre texto gerado e texto confirmado; alerta de risco restrito a repetição de fala com âncora; gate M3 do protocolo antes de liberar | IA + produto | Gate M3 | 8 médio | Pendente |
| R11 | **Avaliar transcrição no dispositivo antes de contratar fornecedor em nuvem.** Se for em nuvem: DPA, retenção zero, região BR, e proibição explícita de uso da voz para biometria ou treino. Descartar o áudio imediatamente após a transcrição, e nunca persistir áudio por padrão | Engenharia + jurídico | Antes de escolher fornecedor | 8 médio | Pendente |
| R12 | Três estados de consentimento, com **`nao_informado` negando** a chamada; registro do texto apresentado, canal, data e quem informou; recusa com validade duradoura, não por sessão | Engenharia | Condição V1 e ressalva R1 do PR #29 | 4 baixo | Pendente |
| R2 | Áudio e transcrição como classe própria de dado, sem acesso de suporte; nenhum conteúdo em log, APM ou Sentry (já é regra do checklist, item 13); break-glass auditado se for inevitável | Engenharia | Com a feature | 6 baixo | Pendente |
| R13 | Instrução no prompt de sistema e regra de pós-processamento: terceiro citado entra na nota apenas como relação ("acompanhante relata"), nunca nominado. Os golden sets já cobrem (`terceiro_citado`). Aviso ao acompanhante presente na sala | IA + produto | Com a feature | 8 médio ⚖️ | Pendente |
| R5 | Finalidade vedada escrita neste RIPD, no DPA e no contrato; qualquer dataset exige RIPD próprio com nós como controladores e decisão de N0; remover a promessa de "ativo de IA" de documento de produto | Guardião + sócios | Imediato | 4 baixo | Pendente |
| R9 | Avaliação estratificada de desempenho, exigida pelo Anexo II §2º e pelo Anexo III, II da CFM 2.454/2026; métricas por nicho e, quando possível, por região; medida corretiva ou descontinuação em caso de viés não eliminável | IA | Gate M3 e revisão periódica | 6 baixo | Pendente |
| R10 | Consentimento e informação colhidos do responsável legal, com registro do vínculo; art. 14 da LGPD; perfil de menor gerido pelo responsável no portal | Produto + engenharia | Com a feature | 8 médio ⚖️ | Pendente |
| R14 | Separação entre prefixo de sistema e conteúdo variável (já existe em `LlmRequest`); saída estruturada por schema; âncora literal derruba instrução injetada que não corresponda a fala | IA | Já previsto no protocolo | 6 baixo | Parcial |
| R4 | Fallback entre rotas BR, timeout por chamada, e falha que **nega** em vez de degradar controle (V5) | Engenharia | Condição V5 | 2 baixo | Pendente |

## 8. Conclusão e aprovação

- Risco residual global **se todas as medidas forem implementadas**: ☐ Baixo ☑ **Médio** ☐ Alto
- Risco residual **hoje**, sem as medidas: **alto**. O tratamento **não pode ser iniciado** neste estado.
- Os dois resíduos que permanecem médios mesmo com tudo implementado, e que precisam de decisão consciente: **R6** (nenhuma pseudonimização de texto livre falado é perfeita — a pergunta honesta não é "é anônimo?", é "o risco residual é aceitável para o benefício?") e **R13** (fala de terceiro em consulta não tem solução técnica completa).
- Parecer do encarregado: pendente — encarregado não nomeado.
- Aprovação do controlador: **cada clínica**, como controladora, precisa aprovar o uso da função. Proposta de produto: a função de IA vem **desligada por padrão** no tenant (privacy by default, Anexo I, XVI da CFM 2.454/2026) e a clínica a liga com aceite registrado.
- Ciência do Guardião: emitida com os condicionantes V1 a V5 do [parecer do PR #29](revisoes/2026-10-11-pr29.md).

## 9. Revisão

| Data | Mudança | Responsável |
|---|---|---|
| 2026-10-11 | Criação do rascunho (rodada 8), a partir do código do PR #29 e do texto oficial da CFM 2.454/2026 | `guardiao-lgpd` |

Revisar obrigatoriamente: ao escolher o provedor (D3), ao escolher o fornecedor de transcrição, a cada troca de versão de modelo, após qualquer incidente, e no mínimo anualmente.

## 10. Perguntas para o advogado (⚖️)

1. A tutela da saúde do art. 11, II, "f" cobre a **gravação do áudio** da consulta, ou apenas a produção do registro clínico? Se não cobrir, o áudio exige consentimento específico e destacado, e o produto precisa funcionar sem ele.
2. A voz do paciente, captada para transcrição e descartada em seguida, é **dado biométrico** para fins do art. 5º, II? A resposta muda o requisito do fornecedor de transcrição.
3. Qual base legal ampara a **fala de terceiro** capturada na consulta (acompanhante, pessoas citadas)?
4. O estado "informado e não recusou" precisa do mesmo rigor de prova do consentimento (texto apresentado, hash, carimbo de tempo), ou basta registrar que a comunicação do art. 11 foi feita?
5. Somos "desenvolvedor" e "distribuidor" de sistema de IA pelo Anexo I, V e IX da CFM 2.454/2026. Quais deveres da resolução, escrita para médicos, nos alcançam por via contratual e pela responsabilidade solidária do art. 42 §1º da LGPD?
6. O escriba que emite **alerta de risco clínico** se enquadra como SaMD (RDC Anvisa 657/2022)? Ver ressalva R3 do parecer do PR #29.
