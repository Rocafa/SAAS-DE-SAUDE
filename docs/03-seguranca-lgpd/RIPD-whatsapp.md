# RIPD — Comunicação por WhatsApp ⚖️ RASCUNHO

> ⚖️ **Rascunho para o advogado.** Não é parecer jurídico nem RIPD aprovado. Preenchido a partir de [RIPD-modelo.md](RIPD-modelo.md) (item 2 do Anexo A) pelo agente `guardiao-lgpd` na rodada 8.
> **O tratamento ainda não existe em produção**: não há integração implementada. Este RIPD condiciona o PR que a implementar.
> Diferença essencial em relação ao RIPD da IA: aqui o problema não é o conteúdo que nós enviamos — isso nós controlamos com template. O problema é o **canal**, que é de terceiro, roda fora do Brasil, e é bidirecional: **o paciente responde, e ele escreve o que quiser**.

## 0. Identificação

| Campo | Preenchimento |
|---|---|
| Nome do tratamento / funcionalidade | Comunicação com o paciente por WhatsApp: lembrete e confirmação de consulta, aviso de resultado disponível, cobrança, e **inbox de conversa livre** com a recepção |
| Versão do RIPD / data | 0.1 (rascunho) — 2026-10-11 |
| Controlador | **A clínica contratante** |
| Operador | Nós (plataforma) |
| Suboperadores | **Meta Platforms** (WhatsApp Business Platform) e, se houver, o **BSP** (Business Solution Provider) intermediário. Ambos **fora do Brasil** |
| Encarregado | A nomear |
| Responsável pela elaboração | Agente `guardiao-lgpd` (rascunho) |
| Partes consultadas | Nenhuma. **Pendente:** jurídico (D8), produto, engenharia |
| Motivo do RIPD | ☑ Dado sensível (por inferência e pelo inbox) ☑ Larga escala ☑ Menores ☑ **Transferência internacional** ☐ IA ☑ Nova tecnologia (canal de terceiro) |

## 1. Necessidade do RIPD

Três fatores, cada um suficiente por si:

1. **Transferência internacional obrigatória.** A infraestrutura do WhatsApp é da Meta e está fora do Brasil. Não existe configuração que mantenha a mensagem em território nacional. Logo o art. 33 da LGPD se aplica sempre, e a Res. CD/ANPD 19/2024 exige mecanismo válido — na prática, as **cláusulas-padrão contratuais da ANPD, em texto integral e sem alteração**, cujo prazo de adaptação terminou em **23/08/2025**. Não há período de graça restante.
2. **O dado é sensível mesmo sem conteúdo clínico.** Uma mensagem que diz apenas "sua consulta está confirmada para quinta, 14h" revela, pelo remetente, que aquela pessoa é paciente daquela clínica. Se a clínica se chama "Clínica de Oncologia X" ou "Instituto de Psiquiatria Y", o nome do remetente **é** o dado de saúde. Esse é o risco que o template não resolve.
3. **O canal é bidirecional e o paciente não segue template.** Podemos controlar o que enviamos; não podemos controlar o que ele responde. Na prática ele responde com sintoma, foto de lesão, PDF de exame e pedido de receita. Qualquer RIPD que trate o WhatsApp apenas como canal de saída descreve um sistema que não é o nosso.

## 2. Descrição do tratamento

### 2.1 Natureza

- **Saída (template):** o sistema dispara lembrete, confirmação, aviso de resultado disponível e cobrança, a partir de template aprovado previamente pela Meta e pelo Guardião.
- **Entrada (resposta do paciente):** chega pelo webhook da Meta, é persistida na nossa base e aparece no inbox da recepção.
- **Inbox de conversa livre:** recepção e paciente conversam. É o ponto em que o canal deixa de ser notificação e passa a ser atendimento.
- **Eliminação:** proposta de 12 meses para mensagens fora do prontuário ([requisitos-tecnicos-seguranca.md](requisitos-tecnicos-seguranca.md) §7). O que for incorporado ao prontuário segue o prontuário ([matriz-retencao.md](matriz-retencao.md)).

Fontes dos dados: cadastro do paciente (nome e telefone, fornecidos à clínica) e a própria conversa.

### 2.2 Escopo

| Item | Preenchimento |
|---|---|
| Categorias de titulares | Pacientes, responsáveis legais, e **terceiros**: quem atende aquele número e não é o paciente (ver R15) |
| Inclui crianças e adolescentes? | **Sim**, geralmente pelo número do responsável |
| Categorias de dados pessoais | Nome, telefone, data e hora da consulta, local, valor devido, histórico da conversa |
| Categorias de dados sensíveis | **Por inferência:** a existência do vínculo com a clínica. **Por conteúdo:** tudo o que o paciente escrever no inbox — sintoma, diagnóstico, foto, exame |
| Metadados que a Meta obtém de todo modo | Número do paciente, número da clínica, carimbos de tempo, status de entrega e leitura. Mesmo com conteúdo criptografado, **o grafo de quem fala com qual clínica de saúde é dado sensível** ⚖️ |
| Volume estimado | ESTIMATIVA: 1 a 4 mensagens por consulta, mais o inbox. Larga escala desde o piloto |
| Prazo de retenção | **Lembrete (0032, parecer #69):** conteúdo do envio (texto e número, cifrados) **30 dias**; metadado (status, datas, HMAC do número; resposta só com interpretação e resultado) **acompanha o cadastro do paciente**; opt-in e prova **enquanto vigente + 5 anos** (proposta ⚖️); resposta livre **não é guardada** enquanto não houver inbox (R1). Detalhe em [matriz-retencao.md](matriz-retencao.md) §3. **Inbox (futuro):** mensagem fora do prontuário **12 meses** (proposta); incorporada ao prontuário, segue o prontuário. Na Meta: segundo a política dela, **fora do nosso controle** |
| Abrangência / armazenamento | Nossa cópia: AWS São Paulo. Trânsito e processamento no canal: **exterior** |
| Transferência internacional | **Sim, inevitável.** Art. 33; cláusulas-padrão da Res. CD/ANPD 19/2024 |

### 2.3 Contexto

O WhatsApp é o canal que o paciente brasileiro quer, e esse é o único motivo pelo qual este tratamento existe. Não é uma escolha técnica nossa; é a realidade do mercado — o PRD descreve a visão como "o paciente conversa pelo WhatsApp".

Duas preocupações conhecidas pesam aqui:

- A clínica hoje usa **WhatsApp pessoal da recepção** (problema P3 do PRD). O nosso produto, mesmo com todos os riscos deste RIPD, é **menos** invasivo que o estado atual, em que a conversa com pacientes fica no celular particular de um funcionário, sem registro, sem controle de acesso e sem exclusão quando ele sai da empresa. Isso não é desculpa para os riscos abaixo; é o que define a alternativa realista.
- O precedente da ANPD contra a Meta (medida preventiva, jul/2024) mostra disposição da autoridade de agir sobre essa empresa específica no tratamento de dado sensível. Ser suboperador da Meta é um risco regulatório de reputação, não só técnico.

### 2.4 Finalidade

Reduzir faltas (o PRD estima 15% a 30% de no-show), tirar a conversa com pacientes do celular pessoal da recepção, e dar rastreabilidade ao que foi combinado.

**Finalidades vedadas, escritas para não serem esquecidas:** marketing e promoção sem consentimento específico e separado; enriquecimento de cadastro com dado obtido da conversa para outro fim; qualquer envio de conteúdo clínico, resultado de exame, receita ou laudo pelo canal; e uso do número para público personalizado de anúncio — o que, pelo art. 11 §4º da LGPD, seria comunicação de dado de saúde para vantagem econômica.

## 3. Base legal

| Operação | Base legal | Justificativa | Consentimento? |
|---|---|---|---|
| Lembrete e confirmação de consulta (template sem dado clínico) | **Art. 11, II, "f"** — tutela da saúde ⚖️ | O lembrete é parte da continuidade do cuidado. ⚖️ Leitura alternativa: art. 7º, V (execução de contrato), já que confirmar horário é obrigação contratual, não ato de saúde | **Opt-in registrado**, por decisão nossa, ainda que a base não seja consentimento — e opt-out tão fácil quanto o opt-in |
| Conversa livre no inbox | **Art. 11, II, "f"** | Quando o paciente traz questão clínica, é atendimento | Informar no primeiro contato que o canal é registrado e que não se deve enviar exame ou dado clínico |
| Cobrança por WhatsApp | **Art. 7º, V** (execução de contrato) e art. 7º, VI (exercício regular de direitos) | Cobrança é relação contratual | Não |
| **Transferência internacional** (inerente ao canal) | **Art. 33, II, "a"** — cláusulas-padrão da ANPD (Res. 19/2024) | Não há adequação reconhecida que cubra o caso, e não se deve apoiar em consentimento (art. 33, VIII) para tratamento que o paciente não tem como evitar se quiser ser atendido | Não deve ser a base ⚖️ |
| Marketing e campanha | **Consentimento específico e destacado** | Finalidade distinta do cuidado | **Sim**, separado do opt-in de lembrete |

⚖️ Ponto aberto importante: se a base do lembrete for art. 11, II, "f", ela é mais sólida contra o dado sensível, mas obriga a sustentar que lembrete é ato de tutela da saúde. Se for art. 7º, V, é mais natural, mas não cobre o dado sensível **por inferência** (o vínculo com a clínica). A saída que o Guardião recomenda é tratar o lembrete como **tutela da saúde com opt-in registrado**: a base não depende do consentimento, mas o consentimento documenta a expectativa do titular e resolve o problema de inferência.

## 4. Necessidade e proporcionalidade

- **Mínimo necessário.** O template leva **nome do paciente, data, hora e local** — nada mais. Nunca especialidade, nome do profissional, motivo da consulta, nome de procedimento, nome de medicamento ou valor de item clínico. Resultado de exame **nunca** vai na mensagem: vai um aviso neutro com link para o portal autenticado.
- **Nome do remetente configurável e neutro.** É a mitigação central do risco de inferência, e é requisito de produto, não de compliance: a clínica deve poder exibir um nome neutro ("Clínica — Agendamentos") em vez da razão social que revela a especialidade. Já está escrito em `requisitos-tecnicos-seguranca.md` §12 e precisa chegar à implementação.
- **Alternativa menos invasiva.** SMS e e-mail têm o mesmo problema de inferência e pior entrega. A alternativa real é **notificação no portal do paciente**, que não envolve terceiro nem transferência internacional, e que deve existir como opção para quem der opt-out do WhatsApp. O produto não pode tornar o WhatsApp condição para ser atendido.
- **Qualidade dos dados.** Número de telefone errado ou reciclado é a principal fonte de vazamento a terceiro neste canal (R15). Exige validação do número e reconfirmação periódica.
- **Direitos do art. 18.** Acesso e portabilidade do histórico da conversa pelo portal; eliminação da conversa que **não** faz parte do prontuário a pedido do titular; revogação do opt-in a qualquer momento, com efeito imediato.
- **Como o titular é informado.** Aviso na primeira mensagem, com a informação de que o canal é registrado pela clínica e de como sair; aviso de privacidade da clínica listando a Meta como suboperador e a transferência internacional.
- **Suboperadores.** DPA com o BSP; cláusulas-padrão da ANPD anexadas; a lista de suboperadores precisa nomear **Meta e BSP** explicitamente, porque a clínica assina autorizando.

## 5. Metodologia de coleta e garantia de segurança (art. 38, parágrafo único)

| Controle | Implementado? | Evidência |
|---|---|---|
| Criptografia em trânsito | Parcial | TLS na nossa borda; a criptografia de ponta a ponta do WhatsApp **não** cobre a API de negócio, em que a nossa ponta é um servidor |
| Criptografia em repouso / campo | Não | A conversa é dado sensível por conteúdo: exige campo cifrado com chave do tenant |
| Isolamento multi-tenant | Não (não implementado) | Toda tabela de mensagem precisa de `tenant_id` + RLS `FORCE` e teste de vazamento entre tenants |
| RBAC | Não | Inbox é acesso a dado potencialmente clínico: recepção precisa de perfil próprio, e o histórico não deve ser exportável por padrão |
| Auditoria | Não | Leitura e exportação de conversa são eventos auditáveis (item 14 do checklist) |
| Hospedagem no Brasil | Parcial por definição | A nossa cópia sim; o canal não |
| **Validação do número** | Não | Mitigação de R15 |
| **Nome de remetente neutro** | Não | Mitigação de R8; escrito em §12 dos requisitos técnicos |
| **Template sem dado clínico** | Documentado, não implementado | Checklist item 18; aprovação pelo Guardião antes de cada template novo |
| **Opt-in / opt-out registrado** | Não | §12 dos requisitos técnicos |
| **Cláusulas-padrão da ANPD no contrato** | Não | Pendência jurídica, bloqueante |
| **Tratamento de anexo recebido** | Não | Ver R16: o paciente manda foto e PDF, e o nosso sistema vai receber |

## 6. Identificação e avaliação de riscos

| # | Risco ao titular | Fonte / causa | P | I | Nível |
|---|---|---|---|---|---|
| R8 | **Exposição da condição de saúde a quem vê a tela do celular** | Notificação na tela de bloqueio com nome de clínica que revela a especialidade | **5** | 4 | **20 alto** |
| R15 | **Mensagem entregue a terceiro** | Número errado no cadastro, número reciclado pela operadora, aparelho compartilhado na família, celular do responsável usado por adolescente | 4 | 4 | **16 alto** |
| R16 | **Conteúdo clínico entrando pelo canal** | O paciente manda sintoma, foto de lesão e PDF de exame no inbox, porque é o que as pessoas fazem. Vira dado sensível recebido sem controle, anexo sem verificação de tipo e possível vetor de injeção indireta | **5** | 4 | **20 alto** |
| R3 | Vazamento ou uso secundário pelo suboperador | Incidente na Meta ou no BSP; uso de metadado para finalidade própria | 3 | 4 | **12 médio** |
| R17 | **Transferência internacional sem mecanismo válido** | Integrar antes de anexar as cláusulas-padrão da Res. 19/2024 ao contrato. Risco **regulatório**, não técnico: é infração desde o primeiro envio, e o prazo de adaptação acabou em 23/08/2025 | 3 | 4 | **12 médio** |
| R2 | Acesso indevido interno ao inbox | Recepção com acesso amplo; histórico exportável; funcionário que sai da empresa | 4 | 3 | **12 médio** |
| R5 | Desvio de finalidade para marketing | Número usado em campanha ou público personalizado, sem consentimento separado | 3 | 4 | **12 médio** |
| R10 | Dado de menor tratado pelo número do responsável, ou do próprio adolescente | Cadastro não distingue titular de destinatário | 3 | 3 | **9 médio** |
| R18 | **Dependência de canal que pode ser bloqueado** | Suspensão do número pela Meta por violação de política derruba a comunicação de todas as clínicas de uma vez. Risco de disponibilidade com efeito sobre o cuidado (paciente não avisado de mudança de horário) | 3 | 3 | **9 médio** |
| R4 | Mensagem não entregue | Falha do canal, número inválido | 4 | 2 | 8 médio |

## 7. Medidas de mitigação

| Risco | Medida | Responsável | Prazo | Residual | Aceito? |
|---|---|---|---|---|---|
| R8 | **Nome de remetente neutro, configurável, e com padrão neutro** — não a razão social; template sem especialidade, sem nome de profissional, sem procedimento; aviso ao paciente de que ele pode preferir notificação só no portal | Produto + engenharia | Antes do primeiro envio | 10 médio | Pendente |
| R15 | Validação do número no cadastro; confirmação de que o número é do paciente ou de responsável identificado, com o vínculo registrado; reconfirmação periódica; e **nunca** conteúdo clínico no template, para que a entrega errada não vire vazamento de saúde | Engenharia + produto | Antes do primeiro envio | 8 médio | Pendente |
| R16 | Primeira mensagem avisando que o canal **não** deve receber exame nem dado clínico, com o caminho correto (portal); verificação de tipo e tamanho de anexo recebido, armazenamento cifrado e tratamento como dado C4; nenhum anexo recebido entra em prompt de IA sem passar pelas regras de injeção indireta já previstas em [lgpd-e-ia.md](lgpd-e-ia.md); e, no inbox, botão para o atendente **mover a mensagem para o prontuário** em vez de ela viver num limbo | Engenharia + produto | Antes de abrir o inbox | 12 médio ⚖️ | Pendente |
| R3 | DPA com o BSP; lista de suboperadores nomeando Meta e BSP; vedação contratual de uso do dado para finalidade própria; e a decisão de que **nenhum conteúdo clínico é enviado**, que é o que limita o dano | Jurídico + sócios | Antes da integração | 8 médio | Pendente |
| R17 | **Cláusulas-padrão da ANPD (Res. 19/2024) anexadas em texto integral e sem alteração, antes do primeiro envio.** Bloqueante: o Guardião **veta** a integração sem isso | Jurídico | Bloqueante | 4 baixo | Pendente |
| R2 | Perfil próprio para o inbox; conteúdo clínico fora do alcance de perfil não clínico (item 10 do checklist); auditoria de leitura e exportação; revogação de acesso no desligamento | Engenharia | Com a feature | 6 baixo | Pendente |
| R5 | Consentimento separado para marketing, com revogação independente; proibição técnica de exportar números para plataforma de anúncio; registro da finalidade em cada disparo | Produto + Guardião | Com a feature | 4 baixo | Pendente |
| R10 | Cadastro distingue **titular** de **destinatário da mensagem**, com o vínculo registrado (art. 14 da LGPD); mensagem sobre menor vai ao responsável | Engenharia | Com a feature | 6 baixo | Pendente |
| R18 | Canal alternativo sempre disponível (portal e e-mail); conformidade estrita com a política de template da Meta; e a comunicação crítica (cancelamento, mudança de horário) nunca depende de um canal único | Produto + engenharia | Com a feature | 6 baixo | Pendente |
| R4 | Status de entrega registrado; alternativa automática quando não houver entrega | Engenharia | Com a feature | 4 baixo | Pendente |

## 8. Conclusão e aprovação

- Risco residual global **com as medidas**: ☐ Baixo ☑ **Médio** ☐ Alto
- Risco residual **hoje**: alto, e com um componente que não é técnico — integrar sem as cláusulas-padrão da ANPD é infração desde o primeiro envio (R17).
- **Veto do Guardião, registrado:** nenhuma integração com WhatsApp entra em produção sem (a) cláusulas-padrão da Res. CD/ANPD 19/2024 no contrato com o BSP, (b) nome de remetente neutro implementado, (c) template aprovado sem dado clínico, (d) opt-in e opt-out registrados, e (e) tratamento definido para anexo recebido. Os cinco são baratos; o custo de não tê-los é uma comunicação de incidente.
- Os dois resíduos que ficam médios por natureza do canal: **R8** (inferência pelo remetente é intrínseca a mandar mensagem de uma clínica) e **R16** (não se controla o que o paciente escreve).
- Parecer do encarregado: pendente.
- Aprovação do controlador: cada clínica, com a Meta e o BSP declarados como suboperadores no DPA que ela assina.

## 9. Revisão

| Data | Mudança | Responsável |
|---|---|---|
| 2026-10-11 | Criação do rascunho (rodada 8) | `guardiao-lgpd` |

Revisar: ao escolher o BSP, a cada template novo, ao abrir o inbox de conversa livre, após incidente, e no mínimo anualmente.

## 10. Perguntas para o advogado (⚖️)

1. Base legal do lembrete de consulta: art. 11, II, "f" (tutela da saúde) ou art. 7º, V (execução de contrato)? A escolha muda o que precisa de consentimento e como se trata o dado sensível **por inferência**.
2. O **metadado** que a Meta obtém de todo modo — qual número conversou com qual clínica de saúde, e quando — é tratamento de dado sensível de saúde por ela? Se for, somos nós que o estamos causando, e isso precisa estar no RIPD e no aviso de privacidade.
3. As cláusulas-padrão da ANPD se aplicam na nossa relação com o BSP, com a Meta, ou com os dois? Quem assina o quê, e a clínica precisa ser parte?
4. A mensagem entregue a terceiro por número reciclado (R15) é incidente de segurança comunicável à ANPD em 3 dias úteis (Res. 15/2024)? Se for, precisamos de detecção, não só de prevenção.
5. O paciente pode exigir eliminação do histórico de conversa que **não** integra o prontuário (art. 18, VI), e isso convive com o nosso prazo de 12 meses?
6. Enviar aviso de "resultado disponível" com link para o portal — sem o resultado — já é comunicação de dado de saúde pelo canal?
