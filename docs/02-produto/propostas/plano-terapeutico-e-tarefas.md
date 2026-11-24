# Proposta — Plano terapêutico e tarefas internas da clínica

> Data: 2026-11-23 · Frente: Produto · Status: **PRECISA DE HUMANO — não aprovada para implementação**.
>
> Este documento registra o recorte pedido, separa o que já está especificado do que ainda exige decisão e não altera PRD, WBS ou critérios de aceite existentes. Nenhuma regra marcada como pergunta aberta deve ser inferida pela engenharia.

## 1. Verificação prévia

Em `origin/main` `492835eb3ff43221a0b2d40a1458a53ab5543ff7`:

- não existe implementação de plano terapêutico ou de tarefas internas da clínica;
- a busca por PRs abertos com “plano terapêutico” não retornou resultados; os PRs encontrados pela busca ampla por “tarefas” tratam de provisionamento/infraestrutura ou de conteúdo clínico, não deste recorte;
- `PRO-03.7` e `HU-PRO-021` especificam **plano de sessões com metas** no MVP;
- não há em `docs/02-produto` especificação de tarefas internas com responsável, prazo e tela de pendências da clínica.

Por isso, o pedido combinado não está completo na especificação de produto. A implementação fica bloqueada até as decisões da seção 9.

## 2. O que já está especificado

### 2.1 Plano de sessões — MVP

As fontes existentes são [WBS `PRO-03.7`](../WBS-micropartes.md) e [HU-PRO-021](../backlog-mvp.md):

- plano terapêutico com número de sessões, metas e evolução por sessão;
- vínculo com pacote e agenda;
- a sessão finalizada decrementa o saldo;
- o registro da evolução atualiza o percentual de progresso de cada meta;
- sem saldo, uma nova sessão vinculada gera aviso de plano encerrado e sugestão de renovação;
- vale para fisio/TO, fono/TEA e psicologia;
- depende de `PRO-02.1` e `AGD-02.4`, tem flag LGPD `S` e 8 pontos.

A [jornada de fisio/TO](../jornadas.md) também relaciona o plano a avaliação com escalas, saldo e guia SP/SADT. Isso não acrescenta, por si só, regras de cálculo das metas.

### 2.2 Plano multiprofissional — Fase 2

`PRO-03.11` trata de metas compartilhadas entre fono, TO e psicologia e de relatórios para família, escola e operadora, com aprovação de cada profissional. Essa entrega é Fase 2 e não deve ser absorvida silenciosamente pelo recorte do MVP.

### 2.3 Pendências citadas sem modelo de tarefa

Os documentos citam pendências financeiras, de assinatura, de validação de guia e de direitos do titular. Essas menções não definem uma entidade comum de tarefas, seus perfis de acesso, ciclo de vida ou retenção.

## 3. Escopo proposto para validação

### 3.1 Plano terapêutico por paciente

O recorte recebido pede:

1. um plano associado a um paciente;
2. objetivos terapêuticos;
3. metas mensuráveis e prazo;
4. evolução ligada ao prontuário (`records`);
5. preservação das regras já escritas para número de sessões, saldo, pacote e agenda.

A proposta precisa deixar explícita a relação entre objetivo, meta, evolução, registro de prontuário e sessão. Não está definido se “evolução” é um dado novo ou uma leitura estruturada de registros já existentes.

### 3.2 Tarefas internas da equipe

O recorte recebido pede pendências do atendimento de três tipos:

- documento a emitir;
- retorno a marcar;
- guia a enviar.

Cada tarefa teria responsável e prazo e apareceria numa tela de pendências da clínica. A tarefa guardaria somente referência ao item de origem, **sem conteúdo clínico**.

Não se propõe aqui um quarto tipo genérico, descrição livre, subtarefas, recorrência, prioridade, notificações ou automações. Esses pontos só entram por decisão explícita.

### 3.3 Fora do recorte até nova decisão

- plano multiprofissional e relatórios externos de `PRO-03.11`;
- escalas e instrumentos clínicos não descritos nesta proposta;
- exposição do plano ou das tarefas no portal do paciente;
- envio de conteúdo por WhatsApp, SMS ou e-mail;
- geração por IA, treino de modelos ou uso por novo suboperador;
- alteração das regras existentes de assinatura e imutabilidade do prontuário.

## 4. Telas e fluxos a prototipar

Os protótipos precisam de aprovação de Produto e `design-ui`, conforme a [Definição de Pronto](../definicao-de-pronto.md).

### 4.1 Plano no prontuário do paciente

A tela deve permitir compreender o plano, seus objetivos, as metas com prazo, o progresso e as evoluções relacionadas ao prontuário. Também precisa representar o saldo de sessões e o aviso já especificado para plano esgotado.

O desenho deve separar claramente:

- dado clínico do plano;
- referência ao registro de prontuário que originou uma evolução;
- dados administrativos de agenda e pacote;
- estados vazio, carregando, erro e acesso negado.

Ficam fora do protótipo, até resposta: quem pode criar ou alterar cada parte, se há renovação como ação na tela e como correções de evolução convivem com registros assinados.

### 4.2 Pendências da clínica

A tela deve apresentar as tarefas dos três tipos pedidos com responsável e prazo, sem mostrar conteúdo clínico. O protótipo precisa definir com Produto:

- quais colunas e filtros são necessários;
- como se distinguem pendente, concluída e vencida, caso esses estados sejam aprovados;
- o que acontece ao abrir a referência sem permissão para o recurso de destino;
- os estados vazio, carregando, erro, acesso negado e dupla ação simultânea.

A referência não pode virar atalho para contornar RBAC, vínculo de cuidado ou auditoria do recurso de destino.

## 5. Dados e fronteiras a fechar

A tabela abaixo é um mapa conceitual, **não um schema aprovado**.

| Conceito | Dados decorrentes do pedido ou da HU | Decisão ainda necessária |
|---|---|---|
| Plano | paciente, objetivos, prazo, número de sessões e vínculos com pacote/agenda | cardinalidade, ciclo de vida, responsável clínico, obrigatoriedade e renovação |
| Meta | descrição mensurável e progresso | valor inicial, alvo, unidade, direção da melhora, fórmula do percentual e tratamento de meta qualitativa |
| Evolução | sessão e referência ao prontuário | origem, cardinalidade dos vínculos, momento de atualização e comportamento diante de adendo |
| Tarefa | tipo, responsável, prazo e referência | estados, permissões, visibilidade do paciente, ordenação, conclusão e destino exato de cada referência |

Independente das respostas, toda referência entre entidades deve permanecer no mesmo tenant e preservar as autorizações do recurso referenciado. Identificadores não tornam neutra uma referência que revela vínculo com atendimento de saúde.

## 6. Regras de produto que não devem ser presumidas

1. “Meta mensurável” não define uma fórmula universal de percentual. Metas em que menor valor é melhor, metas binárias e metas com diferentes unidades não podem receber um cálculo inventado.
2. “Evolução ligada ao prontuário” não autoriza copiar conteúdo clínico para o plano nem alterar um registro assinado.
3. “Sessão finalizada” precisa ser relacionado ao status e às transições já existentes na agenda, sem criar um segundo evento divergente de consumo.
4. “Tarefa sem conteúdo clínico” não significa tarefa sem dado pessoal: responsável, paciente referenciado, especialidade e tipo de pendência podem revelar informação sensível no contexto.
5. Uma pendência concluída não deve apagar a trilha nem alterar retroativamente o documento, agendamento ou guia de origem sem regra aprovada.

## 7. Regras LGPD e de segurança obrigatórias

Estas são travas da plataforma, não decisões clínicas novas:

- **Finalidade e papéis:** apoiar cuidado e gestão da clínica; a clínica é controladora e a plataforma, operadora.
- **Base legal:** o fluxo de prontuário já usa tutela da saúde (LGPD art. 11, II, “f”) e obrigação legal/regulatória (art. 11, II, “a”), conforme [matriz de bases legais](../../03-seguranca-lgpd/bases-legais-e-consentimento.md). A base e a finalidade das tarefas precisam ser registradas; consentimento não deve virar padrão.
- **Classificação e minimização:** objetivos, metas e evolução clínica são C4. A classificação de cada campo da tarefa e de suas referências precisa de revisão do Guardião. Não criar campo livre “por via das dúvidas”.
- **Criptografia:** campos C4 usam criptografia em nível de campo com chave do tenant; nenhum fallback em claro.
- **Acesso:** RBAC e, para conteúdo clínico, vínculo de cuidado/ABAC no servidor. Recepção e financeiro continuam sem acesso a conteúdo clínico. MFA e código recente seguem as regras já vigentes para os perfis e ações sensíveis.
- **Isolamento:** toda tabela nova com dado da clínica exige `tenant_id`, RLS com `FORCE`, filtros na aplicação e testes em Postgres real provando que outro tenant não lê nem escreve. Ausência de contexto de tenant falha fechada.
- **Auditoria:** leituras, escritas e exportações de C3/C4 geram evento na mesma transação. A trilha guarda somente identificadores e metadados permitidos, nunca objetivo, meta, evolução ou texto clínico.
- **Logs e URLs:** nenhum dado clínico, nome ou termo de busca em logs, APM, Sentry, path ou query string.
- **Retenção e exportação:** o que integrar o prontuário segue a política de prontuário. A [G2](../garantias-ao-cliente.md) já exige exportação de todas as entidades do tenant, inclusive das tarefas, com manifesto e isolamento; essa inclusão não é opcional. A retenção das tarefas e a representação minimizada dos novos dados na exportação precisam ser decididas antes do schema.
- **ROPA/RIPD:** o novo fluxo sensível precisa ser registrado e revisto pelo Guardião. Nenhum suboperador novo está proposto.
- **Testes e ambientes:** somente dados sintéticos, sem dado real de paciente em fixtures, capturas ou prompts.

## 8. Evidências exigidas depois da aprovação

Além dos cenários já escritos na `HU-PRO-021`, a história final precisa de critérios Gherkin para as decisões tomadas. A implementação deverá comprovar:

1. comportamento real das telas com Playwright E2E, incluindo erro de rede, 401, 403, 404 e 500, carregamento e duplo clique;
2. caminhos negados de perfil sem permissão e de profissional sem vínculo de cuidado;
3. RLS entre tenants para leitura e escrita de cada tabela nova, inclusive referências cruzadas;
4. ausência de conteúdo clínico na tarefa, na listagem, nos logs e na auditoria;
5. concorrência quando duas ações puderem consumir a mesma sessão ou concluir a mesma tarefa;
6. migrations novas, aditivas e reversíveis, sem alterar migrações existentes;
7. preservação da imutabilidade, adendos, retenção, exportação e auditoria do prontuário.

## 9. Perguntas abertas para o time

### Bloqueiam o modelo do plano

1. Este pedido amplia `HU-PRO-021` ou cria outra história? Quais IDs de WBS e qual marco cobrem objetivos, prazo e vínculo com `records`?
2. Quantos planos podem coexistir por paciente e quais estados e transições são necessários?
3. Quais campos tornam uma meta “mensurável”? Como se calcula progresso para valores maiores, menores, binários e qualitativos?
4. O prazo pertence ao plano, a cada objetivo, a cada meta ou a mais de um nível? É data civil ou data/hora com fuso?
5. A evolução é um registro novo ou deriva de `record_entry`? Pode haver várias metas por registro e vários registros por meta?
6. A atualização ocorre em rascunho, somente após assinatura ou em outro evento? Como adendo, estorno de atendimento e correção de sessão afetam progresso e saldo?
7. Quem pode criar, editar, concluir e renovar o plano, inclusive em atendimento multiprofissional e psicologia?
8. Qual é a cardinalidade entre plano, objetivos e metas? Objetivo e plano possuem progresso agregado; se sim, com qual fórmula e eventual ponderação entre metas?
9. Quando houver vários planos ou pacotes ativos, como a sessão escolhe qual plano atualizar e qual saldo consumir? Esse vínculo é explícito, automático ou alterável, inclusive numa renovação?
10. Alterações de valor inicial, alvo, unidade ou direção de uma meta depois de evoluções já registradas preservam versões? O progresso histórico é recalculado ou a mudança vale apenas para novas evoluções?
11. Plano, objetivos e metas integram formalmente o prontuário para retenção, controle de acesso e marcação de sigilo no manifesto da exportação, ou terão política própria? A inclusão na exportação total da G2 vale nos dois casos.

### Bloqueiam as tarefas internas

12. As tarefas nascem manualmente, automaticamente ou de ambas as formas? Qual evento cria cada um dos três tipos?
13. Quais perfis podem listar, criar, atribuir, concluir, reabrir e cancelar cada tipo? O escopo é da clínica inteira, da equipe ou do responsável?
14. Quais estados existem e o que define “vencida”? O prazo é data ou timestamp e em qual fuso?
15. Qual recurso cada referência aponta e quais dados mínimos aparecem na lista? Recepção pode ver paciente, profissional e especialidade em cada tipo?
16. Ao concluir uma tarefa, o sistema apenas registra a conclusão ou também executa uma ação no documento, retorno ou guia?
17. Qual a retenção das tarefas abertas, concluídas e canceladas? Qual classificação e representação minimizada elas terão na exportação total já exigida pela G2?
18. É permitido texto livre na tarefa? Se não houver finalidade demonstrada, a proposta deve permanecer somente com tipo e referências estruturadas.
19. Se o documento, retorno ou guia de origem for concluído, cancelado, excluído ou reaberto fora da tarefa, o que acontece com ela? Pode existir mais de uma tarefa aberta do mesmo tipo para a mesma origem?

## 10. Portão para implementação

Antes de escrever testes de implementação ou migrations, Produto deve transformar as respostas em história com Gherkin e atualizar os documentos formais aplicáveis. `design-ui` deve aprovar os protótipos; o Guardião deve revisar finalidade, classificação, acesso, retenção e minimização. A liberação final segue a cadeia Produto (N2), Maestro (N1) e sócios quando houver decisão de escopo.
