# Pacote para o escritório de advocacia (D8)

> **Para quem:** escritório de advocacia com prática em **direito da saúde** e **proteção de dados**.
> **De quem:** os sócios da plataforma (N0). Preparado pelo agente `guardiao-lgpd` em 12/10/2026, a partir dos documentos do repositório.
> **Objetivo:** permitir que o escritório faça uma proposta de escopo fechado e trabalhe direto nas perguntas, sem gastar horas descobrindo o que fazemos e o que precisamos.
> **Aviso:** nada neste pacote é parecer jurídico. Ver a §6.
> **Dado pessoal:** este pacote e os documentos que ele cita não contêm dado de paciente, nem real nem de exemplo identificável. Pedimos que o escritório também não nos envie dado real de paciente.

---

## 1. Quem somos e o produto

1. Somos dois sócios que estão construindo um **sistema de gestão para clínicas e consultórios de saúde**, vendido por assinatura mensal.
2. O sistema faz agenda, agendamento online, **prontuário eletrônico**, documentos clínicos, financeiro, cobrança por Pix, nota fiscal e lembretes por WhatsApp.
3. Atende **várias profissões**: começamos por fisioterapeutas, terapeutas ocupacionais e psicólogos; médicos, dentistas, nutricionistas e fonoaudiólogos vêm depois.
4. Tem um **assistente de IA** que ouve a consulta (com aviso ao paciente) e escreve um **rascunho** da evolução; o profissional revisa e assina. Nada é registrado sem revisão humana.
5. Há um **portal do paciente** para ver agendamentos e documentos; pacientes podem ser crianças, com conta gerida pelo responsável.
6. **A clínica é a dona dos dados** (controladora). Nós guardamos e processamos em nome dela (operadores). Não usamos os dados para fins próprios.
7. Os dados ficam em nuvem no Brasil (AWS São Paulo), separados por clínica e cifrados com chave própria de cada clínica.
8. Prometemos ao cliente que **atraso de pagamento nunca bloqueia o prontuário** e que a saída é livre: 90 dias para exportar tudo, de graça.
9. Ainda **não temos cliente nem dado real**. O próximo passo é um **piloto com cerca de 30 clínicas**, que só começa com o Lote 1 abaixo resolvido.
10. O lançamento comercial do MVP está estimado entre nov/2026 e jun/2027.

Para mais contexto: [CONTEXTO.md](../../CONTEXTO.md) (5 minutos de leitura) e o [mapa regulatório](README.md) que montamos.

---

## 2. O que pedimos, em lotes priorizados

**Como ler:** cada item traz o documento que já preparamos (rascunho técnico, não jurídico), a pergunta que precisamos responder, por que ela importa e o prazo desejado. Preferimos resposta **objetiva** (sim/não ou escolha entre opções) com a fundamentação curta. Onde pedimos **redação**, o documento ainda não existe.

Prazos contados a partir da assinatura da proposta.

### Lote 1 — trava o piloto com dado real (prazo desejado: até 6 semanas)

| # | Documento | Pergunta jurídica objetiva | Por que importa | Prazo |
|---|---|---|---|---|
| 1.1 | [dpa-minuta.md](dpa-minuta.md) e [papeis-controlador-operador.md](papeis-controlador-operador.md) | (a) A minuta de contrato de operador (DPA) pode ser usada, com quais ajustes? (b) A recusa de instrução ilícita (cl. 1.3) e a pausa da exportação por suspeita de invasão (cl. 16.3) podem ser lidas como retenção indevida de dados? Sim/não. (c) Em clínica com profissionais autônomos que alugam sala, há **co-controladoria**? Sim/não, e como o contrato a reflete. | Sem DPA assinado não há piloto com dado real (Portão B). | 3 semanas |
| 1.2 | [dpa-minuta.md](dpa-minuta.md) cl. 7.4 e [plano-resposta-incidentes.md](plano-resposta-incidentes.md) §8 | Quando o incidente ocorre na **nossa** infraestrutura e a clínica não age no prazo de 3 dias úteis, nós comunicamos a ANPD diretamente? Sim/não. Qual o critério para **não** comunicar um incidente de severidade alta? | Define quem responde perante a ANPD e o texto do contrato. | 3 semanas |
| 1.3 | (não existe) **Termo de piloto** | Redigir o termo do piloto: gratuidade, prazo, sandbox com dado fictício antes do DPA, proibição de compartilhar dado de paciente em grupos e prints de feedback. Ver [plano-piloto.md](../02-produto/plano-piloto.md) P4 e P5. | Documento que as clínicas do piloto assinam. | 3 semanas |
| 1.4 | (não existe) **Aviso de privacidade ao paciente** (modelo para a clínica usar) | Redigir o modelo de aviso que a clínica apresenta ao paciente, incluindo o uso de IA assistiva e o WhatsApp. | É obrigação da clínica; nós fornecemos o modelo. | 4 semanas |
| 1.5 | [dpa-minuta.md](dpa-minuta.md) Anexo de suboperadores (l. 131–134) e [README.md](README.md) item 8 | Para cada suboperador fora do Brasil (e-mail transacional, ferramenta de erros, provedor de IA, Meta/WhatsApp), o mecanismo é **cláusulas-padrão da ANPD (Res. 19/2024) em texto integral**? Sim/não. Quem assina: nós, a clínica, ou ambos? Revisar os termos padrão desses fornecedores. | Transferência internacional sem mecanismo válido é irregular desde 23/08/2025. | 4 semanas |
| 1.6 | [RIPD-plataforma.md](RIPD-plataforma.md) | O RIPD da plataforma está suficiente para ser assinado? As bases legais da §3 estão corretas? Sim/não, com ajustes. | Tratamento de alto risco; o RIPD é exigível. | 4 semanas |
| 1.7 | [RIPD-ia-escriba.md](RIPD-ia-escriba.md) §10 | (a) A **tutela da saúde** (art. 11, II, "f") cobre a **gravação do áudio** da consulta, ou só a produção do registro clínico? (b) A voz captada e descartada é **dado biométrico**? Sim/não. (c) "Informado e não recusou" precisa da mesma prova do consentimento? Sim/não. | Se o áudio exigir consentimento específico, o desenho da funcionalidade muda, não só o aviso. | 4 semanas |
| 1.8 | [checklist-cfm-2454.md](checklist-cfm-2454.md) §6 e [lgpd-e-ia.md](lgpd-e-ia.md) | Res. CFM 2.454/2026: (a) vigência em 26/08/2026? Sim/não. (b) A clínica que só **contrata** nossa IA precisa de Comissão de IA e Telemedicina? Sim/não. (c) Aceitam a classificação de risco proposta (escriba = médio)? (d) Como "desenvolvedor e distribuidor" (Anexo I), quais deveres nos alcançam por contrato e pelo art. 42, §1º da LGPD? (e) Aplicar o padrão CFM a fisio, psicologia e nutrição cria obrigação perante os outros conselhos? Sim/não. | A resolução vale desde a vigência, sem transição, para sistemas já em uso. | 4 semanas |
| 1.9 | [matriz-retencao.md](matriz-retencao.md) §6 e [retencao-e-descarte.md](retencao-e-descarte.md) §6 | (a) O piso de **20 anos** da Lei 13.787/2018 (art. 6º, §5º) vale para prontuário de **todas** as profissões? Sim/não. (b) "Guarda permanente" (CFO, CFN, CFFa) é compatível com o princípio de necessidade (art. 6º, III)? (c) Na clínica multiprofissional, 20 anos para todos conflita com o mínimo de 5 anos do CFP? | A retenção é configurada por tipo de registro no sistema; o número errado é retrabalho. | 4 semanas |
| 1.10 | [garantias-ao-cliente.md](../02-produto/garantias-ao-cliente.md) G3, [papeis-controlador-operador.md](papeis-controlador-operador.md) cl. 12 e [revisoes/2026-10-11-pr35.md](revisoes/2026-10-11-pr35.md) §4 | **Eliminação após os 90 dias de saída:** (a) ao fim do contrato, a guarda dos anos restantes do prontuário é da clínica, nossa, ou há dever de entrega formal? (b) Destruir a chave de cifragem da clínica (o dado fica ilegível) vale como "eliminação" para os arts. 16 e 18, VI? Sim/não. (c) Backups imutáveis que expiram em até 12 meses atendem ao art. 16? Sim/não. | Define se o nosso custo de guarda tem fim e se o processo técnico de eliminação já construído é válido. | 4 semanas |
| 1.11 | [matriz-retencao.md](matriz-retencao.md) §6 item 3 e [README.md](README.md) item 19 | O art. 6º da Res. CFP 001/2009 obriga **prontuário único** com compartimento restrito do psicólogo, ou admite prontuários separados por profissional com visão consolidada? Escolha. | **Trava a arquitetura** do prontuário; é a pergunta mais urgente para a engenharia. | 2 semanas |
| 1.12 | [README.md](README.md) itens 5, 10 e 11 | **Encarregado (DPO):** (a) somos obrigados a nomear (operador de alto risco, fora do regime de pequeno porte)? Sim/não. (b) Pode ser terceirizado (PJ externa)? Sim/não. (c) Requisitos do ato de nomeação (Res. CD/ANPD 18/2024). | O piloto exige canal de contato com o encarregado publicado. | 2 semanas |
| 1.13 | [RIPD-plataforma.md](RIPD-plataforma.md) l. 45, [RIPD-ia-escriba.md](RIPD-ia-escriba.md) R10 e [plano-resposta-incidentes.md](plano-resposta-incidentes.md) §8 item 4 | **Menores de idade:** (a) conta gerida pelo responsável e consentimento do responsável para a IA atendem ao art. 14 da LGPD? Sim/não. (b) O portal do paciente está sujeito à Lei 15.211/2025 (ECA Digital)? Sim/não; confirmar vigência. (c) Texto do aviso de incidente ao menor e ao responsável. | Fisio pediátrica no nicho de entrada; TEA na onda 2. | 4 semanas |
| 1.15 | [api-dominio.md](../04-arquitetura/api-dominio.md) §11 (A1 b/c, migração 0056) e [revisoes/2026-10-20-pr67.md](revisoes/2026-10-20-pr67.md) A1 | **Sigilo do adolescente perante os responsáveis:** (a) O pedido de sigilo só vale de 12 a 17 anos (ECA art. 2º). Uma criança com discernimento, abaixo de 12, também pode pedir? Sim/não. (b) A divisão entre escopo `essencial` (orientações, cuidados, riscos) e `integral` (conteúdo clínico) atende ao CEM art. 74 e ao CFP art. 13? E as demais profissões (fisio, nutrição, fono)? (c) A exceção por risco (nova decisão do profissional, justificada) está alinhada ao CEM art. 74, parte final, e ao ECA arts. 13 e 245? Há caso em que o profissional deve comunicar sem decisão própria (Conselho Tutelar)? (d) O responsável legal pode exigir, pelo art. 18 da LGPD, os dados do adolescente que pediu sigilo? | O portal do responsável e as comunicações ao responsável dependem disso; hoje o padrão é o protetor. | 4 semanas |
| 1.14 | (outro escritório pode fazer) **Acordo de sócios e estrutura societária** | Constituição da empresa, acordo de sócios (participação, papéis, vesting, saída), e titularidade das contas oficiais em nome da empresa. Ver [o-que-falta](../relatorios/2026-10-12-o-que-falta.md). | O DPA e o RIPD precisam de razão social e CNPJ ([RIPD-plataforma.md](RIPD-plataforma.md) l. 15). **Pode ser outro escritório, de direito societário.** | 3 semanas |

### Lote 2 — antes do lançamento comercial (prazo desejado: até 90 dias)

| # | Documento | Pergunta jurídica objetiva | Por que importa | Prazo |
|---|---|---|---|---|
| 2.1 | (não existe) **Termos de uso (contrato SaaS B2B)** | Redigir o contrato de assinatura, com o DPA como anexo. Incluir: sem fidelidade, cancelamento online, limitação de responsabilidade compatível com a LGPD (DPA cl. 13), foro, seguro (cl. 13.2), auditoria (cl. 9.2). | Hoje só existe o DPA; o contrato principal não existe. | 60 dias |
| 2.2 | (não existe) **Política de privacidade** da plataforma | Redigir a política para os dados em que **nós** somos controladores (usuários, cobrança da assinatura, logs de acesso, site). | Obrigatória para lançar o site e a cobrança. | 60 dias |
| 2.3 | [garantias-ao-cliente.md](../02-produto/garantias-ao-cliente.md) §2 e [revisoes/2026-10-09-garantias.md](revisoes/2026-10-09-garantias.md) | A **Carta de Compromissos** pode ser publicada como está, sem risco de publicidade enganosa (CDC art. 37) por promessa absoluta? Sim/não, com o texto ajustado. A promessa "90% dos chamados em 15 minutos" precisa de ressalva? | É o principal argumento de venda contra a concorrência. | 45 dias |
| 2.4 | [checklist-cfm-2454.md](checklist-cfm-2454.md) C12 | Revisar os textos comerciais sobre IA frente à Res. CFM 2.336/2023 (publicidade médica). | Nada de "IA que diagnostica" no marketing. | 60 dias |
| 2.5 | [RIPD-whatsapp.md](RIPD-whatsapp.md) §10 | (a) Base do lembrete de consulta: art. 11, II, "f" ou art. 7º, V? Escolha. (b) O metadado que a Meta obtém (quem falou com qual clínica) é dado sensível de saúde? Sim/não. (c) Mensagem entregue a número reciclado é incidente comunicável? Sim/não. (d) O paciente pode exigir a eliminação da conversa que não integra o prontuário? Sim/não. (e) Aviso de "resultado disponível" com link é comunicação de dado de saúde? Sim/não. | O WhatsApp é a funcionalidade mais pedida e envolve transferência internacional inevitável. | 60 dias |
| 2.6 | [lgpd-e-ia.md](lgpd-e-ia.md), [checklist-cfm-2454.md](checklist-cfm-2454.md) item 5 e [revisoes/2026-10-11-pr29.md](revisoes/2026-10-11-pr29.md) §5 | **Anvisa RDC 657/2022 (software como dispositivo médico):** (a) a **sugestão de CID** se enquadra? Sim/não; se sim, notificação ou registro? (b) O escriba que destaca **alerta de risco** (repetição literal da fala do paciente, sem juízo clínico) se enquadra? Sim/não. (c) Efeito da revisão da RDC na agenda 2026–2027. | A sugestão de CID está fora do MVP até esta resposta. | 90 dias |
| 2.7 | [D14](../00-governanca/memos/D14-receita-saude-mvp.md) | **Receita Saúde:** vender como "gera o lote para o Receita Saúde" (o profissional envia) evita promessa enganosa? Sim/não. Qual a IN da Receita aplicável? (Pode ser com o contador.) | Metade do nicho de entrada é psicólogo pessoa física. | 60 dias |
| 2.8 | [retencao-e-descarte.md](retencao-e-descarte.md) D7.1–D7.2 e [revisoes/2026-10-11-pr37.md](revisoes/2026-10-11-pr37.md) §4 | **Trilha de auditoria:** (a) prazo defensável: igual ao prontuário (20 anos), 5 anos para a administrativa, 12 meses para logs de acesso? (b) Convive com o direito de eliminação quando o titular registrado não é o paciente? (c) Para valer como prova, a cadeia de hash basta, ou precisa de carimbo de tempo ICP-Brasil ou âncora externa? Escolha. | Define custo de armazenamento e um requisito técnico. | 90 dias |
| 2.9 | [revisoes/2026-10-09-garantias.md](revisoes/2026-10-09-garantias.md) M2 | A exportação total feita por administrador não profissional de saúde, com aprovação registrada do responsável técnico, respeita o sigilo profissional (CFM, CFP, CFO)? Sim/não. | É a garantia G2 (portabilidade). | 60 dias |
| 2.10 | [bases-legais-e-consentimento.md](bases-legais-e-consentimento.md) | Revisar a tabela de base legal por fluxo (marketing da clínica, cobrança, triagem por IA, prova do consentimento por 5 anos após revogação). A descrição genérica na NFS-e ("Consulta") é aceitável? (Com o contador.) | Configuração padrão que entregamos às clínicas. | 90 dias |
| 2.11 | [README.md](README.md) item 20 | Teleodontologia (Res. CFO 278/2025): o que é permitido a distância? | Só quando entrar odontologia. | 90 dias |

### Lote 3 — depois do lançamento (sob demanda)

| # | Documento | Pergunta jurídica objetiva | Por que importa | Prazo |
|---|---|---|---|---|
| 3.1 | [D10](../00-governanca/memos/D10-receita-controlada-sncr.md) | **Receita controlada (SNCR, RDC Anvisa 1.000/2025):** integrar por parceiro já integrado ao SNCR transfere a obrigação regulatória ao parceiro? Sim/não. Que cláusulas exigir dele? | Só quando entrar medicina. | Sob demanda |
| 3.2 | [D11](../00-governanca/memos/D11-inscricao-crm-prescricao.md) | **Inscrição no CRM como plataforma de prescrição** (Res. CFM 2.299/2021, art. 5º): (a) integrar com parceiro inscrito dispensa a nossa inscrição? Sim/não. (b) A inscrição vale por estado? Sim/não. | Só quando entrar medicina. | Sob demanda |
| 3.3 | [lgpd-e-ia.md](lgpd-e-ia.md) e [bases-legais-e-consentimento.md](bases-legais-e-consentimento.md) | **Uso de dados para melhorar a IA:** (a) anonimizar com opt-in da clínica e usar no ajuste do modelo esbarra no art. 11, §4º (vantagem econômica)? Sim/não. (b) Fine-tuning exclusivo de uma clínica: qual base legal? (c) Benchmarks agregados entre clínicas: autorização contratual basta? | Fase 2 da IA; proibido por padrão até lá. | Sob demanda |
| 3.4 | [README.md](README.md) item 33 | Reforma tributária (LC 214/2025 e LC 227/2026): efeitos no serviço de saúde e no nosso produto. (Com o contador.) | Precificação e módulo financeiro. | Sob demanda |
| 3.5 | [decisoes.md](../00-governanca/decisoes.md) D8 | Nichos futuros: limites de estética (decisões do TRF-1 sobre biomédicos e harmonização orofacial) e eventual regulação de cartões de desconto pela ANS. | Só se entrarmos nesses nichos. | Sob demanda |

---

## 3. Todos os itens ⚖️ encontrados no repositório

**Como foi feito:** busca por "⚖️" em todo o repositório em 12/10/2026. Foram **171 linhas** com o marcador dentro de `docs/`: **127** nos documentos vigentes, **20** nos pareceres do Guardião (`revisoes/`) e **24** nos relatórios (`docs/relatorios/`). Os relatórios só repetem o que está nos documentos e não estão na tabela. Há ainda 1 ocorrência no modelo de issue do GitHub (não é pergunta). Cópias em `.claude/worktrees/` e na pasta duplicada `plataforma-saude/` foram ignoradas.

Das 127 linhas vigentes, **29 são legenda ou título** ("⚖️ = precisa de validação"), sem pergunta própria: README.md:3, 26, 27, 87; RIPD-ia-escriba.md:1, 3, 173; RIPD-modelo.md:5; RIPD-plataforma.md:3; RIPD-whatsapp.md:1, 3, 155; bases-legais-e-consentimento.md:3; checklist-cfm-2454.md:3, 67, 69; dpa-minuta.md:3, 145; lgpd-e-ia.md:3; matriz-retencao.md:3, 84; papeis-controlador-operador.md:3; plano-resposta-incidentes.md:3, 151; retencao-e-descarte.md:3, 93; memos/D08:8, 32, 35. As outras **98** estão abaixo, junto com as **56 perguntas numeradas** das seções "Perguntas para o advogado" (que ficam sob um título ⚖️) e os **12** marcadores com conteúdo dos pareceres. Linhas que tratam da mesma pergunta estão agrupadas.

Caminhos relativos a `docs/03-seguranca-lgpd/`, salvo indicação. A coluna "Lote" remete à §2.

### 3.1 Documentos vigentes

| Arquivo:linha | Pergunta | Lote |
|---|---|---|
| README.md:42; bases-legais-e-consentimento.md:42; papeis-controlador-operador.md:26, 47; dpa-minuta.md:67; lgpd-e-ia.md:38 | Monetizar ou treinar IA com dado de saúde: o art. 11, §4º veda mesmo com dado anonimizado e opt-in da clínica? | 3.3 |
| README.md:89 | Contrato SaaS + DPA modelo + cláusula de uso de dados para melhoria e treino de IA estão adequados? | 1.1, 2.1 |
| README.md:90 | As funções de IA são SaMD (Anvisa)? Qual a responsabilidade civil? | 2.6 |
| README.md:91; bases-legais-e-consentimento.md:43; lgpd-e-ia.md:58, 60 | Qual base legal para fine-tuning, inclusive o exclusivo de uma clínica, e para anonimizar com opt-in? | 3.3 |
| README.md:92; matriz-retencao.md:23, 86, 87 | O piso de 20 anos (Lei 13.787, art. 6º, §5º) vale para todas as profissões? "Guarda permanente" é compatível com o art. 6º, III? | 1.9 |
| README.md:49, 93; dpa-minuta.md:43, 131, 132, 133, 134; lgpd-e-ia.md:46; RIPD-plataforma.md:52 | Cada suboperador estrangeiro exige CPC da ANPD em texto integral? Quem assina? | 1.5 |
| README.md:61, 94 | O que a Res. CFO 278/2025 permite em teleodontologia? | 2.11 |
| README.md:70, 95; RIPD-plataforma.md:45; RIPD-ia-escriba.md:152 | Conta do menor gerida pelo responsável atende ao art. 14 e ao ECA Digital (Lei 15.211/2025)? Qual a vigência? | 1.13 |
| README.md:96; requisitos-tecnicos-seguranca.md:146; plano-resposta-incidentes.md:23, 58 | Qual o critério de "risco ou dano relevante" para notificar? Quando um incidente S2 pode deixar de ser comunicado? | 1.2 |
| README.md:97; decisoes.md (00-governanca):19; memos/D11:18, 23 | Integrar com parceiro inscrito dispensa a nossa inscrição no CRM? A inscrição vale por estado? | 3.2 |
| README.md:60, 98; matriz-retencao.md:71, 88 | Res. CFP 001/2009, art. 6º: prontuário único obrigatório ou prontuários separados com visão consolidada? | 1.11 |
| README.md:51; plano-resposta-incidentes.md:15 | Estamos fora do regime de pequeno porte (Res. 2/2022) por tratamento de alto risco? Clínicas pequenas também? | 1.12, 1.2 |
| README.md:59 | Confirmar artigos da RDC Anvisa 1.000/2025 (receituário) no texto oficial antes de usar em contrato. | 3.1 |
| README.md:65; checklist-cfm-2454.md:18, 40 | Quais deveres da CFM 2.454 nos alcançam como desenvolvedor e distribuidor? A clínica que só contrata precisa de Comissão de IA? | 1.8 |
| README.md:67; lgpd-e-ia.md:78; checklist-cfm-2454.md:54 | Sugestão de CID e alerta de risco do escriba são SaMD (RDC 657/2022)? | 2.6 |
| README.md:74 | Res. CFM 2.299/2021 revogou o selo CFM/SBIS (art. 10 da 1.821/2007)? Confirmar. | 3.2 |
| README.md:75 | Efeitos da LC 214/2025 e LC 227/2026 no serviço de saúde (com contador). | 3.4 |
| README.md:76 | Qual a IN da Receita Federal do Receita Saúde? O recibo exige linha própria no ROPA? | 2.7 |
| RIPD-ia-escriba.md:77, 79, 83, 175 | Tutela da saúde cobre a gravação do áudio, ou o áudio exige consentimento específico? | 1.7 |
| RIPD-ia-escriba.md:176 | Voz captada e descartada é dado biométrico? | 1.7 |
| RIPD-ia-escriba.md:149, 177 | Qual base legal ampara a fala de terceiro (acompanhante) captada na consulta? | 1.7 |
| RIPD-ia-escriba.md:178 | "Informado e não recusou" precisa da mesma prova do consentimento? | 1.7 |
| RIPD-ia-escriba.md:179 | Deveres da CFM 2.454 que nos alcançam como desenvolvedor e distribuidor (art. 42, §1º LGPD). | 1.8 |
| RIPD-ia-escriba.md:180 | Escriba com alerta de risco clínico é SaMD? | 2.6 |
| RIPD-ia-escriba.md:144 | A pseudonimização antes de enviar ao modelo de IA, com teste de reidentificação, é medida suficiente? | 1.7 |
| RIPD-modelo.md:113 | Risco alto após mitigação: quando cabe consulta prévia à ANPD? | 1.6 |
| RIPD-plataforma.md:15 | Razão social e CNPJ da operadora (a definir). | 1.14 |
| RIPD-plataforma.md:64 | As bases legais da §3 do RIPD da plataforma estão corretas? | 1.6 |
| RIPD-whatsapp.md:73, 79, 157 | Lembrete de consulta: art. 11, II, "f" ou art. 7º, V? | 2.5 |
| RIPD-whatsapp.md:48, 158 | O metadado que a Meta obtém (quem falou com qual clínica) é dado sensível de saúde? | 2.5 |
| RIPD-whatsapp.md:76, 159 | As CPC se aplicam na relação com o BSP, com a Meta, ou com os dois? A clínica é parte? | 1.5, 2.5 |
| RIPD-whatsapp.md:160 | Mensagem entregue a número reciclado é incidente comunicável em 3 dias úteis? | 2.5 |
| RIPD-whatsapp.md:161 | O paciente pode exigir eliminação da conversa que não integra o prontuário, frente ao prazo de 12 meses? | 2.5 |
| RIPD-whatsapp.md:162 | Aviso de "resultado disponível" com link já é comunicação de dado de saúde? | 2.5 |
| RIPD-whatsapp.md:129 | Anexo clínico recebido pelo WhatsApp: tratá-lo como dado C4 e avisar que o canal não recebe exames basta? | 2.5 |
| bases-legais-e-consentimento.md:32 | Descrição genérica na NFS-e ("Consulta") é aceitável? (Com contador.) | 2.10 |
| bases-legais-e-consentimento.md:34 | Marketing da clínica segmentado por dado de saúde exige consentimento específico (art. 11, I)? | 2.10 |
| bases-legais-e-consentimento.md:39 | Benchmarks entre clínicas sobre dado anonimizado: autorização contratual para anonimizar basta? | 3.3 |
| bases-legais-e-consentimento.md:41 | Chatbot de triagem com paciente: base legal e risco de SaMD. | 2.6, 2.10 |
| bases-legais-e-consentimento.md:54; requisitos-tecnicos-seguranca.md:78; retencao-e-descarte.md:41 | Prova de consentimento guardada pela duração do tratamento + 5 anos após revogação é defensável? | 2.10 |
| checklist-cfm-2454.md:11, 71 | A CFM 2.454 vigora desde 26/08/2026 ou setembro? | 1.8 |
| checklist-cfm-2454.md:72 | Clínica que só contrata nossa IA precisa de Comissão de IA e Telemedicina? | 1.8 |
| checklist-cfm-2454.md:45, 73 | A classificação de risco proposta (escriba = médio) se sustenta? | 1.8 |
| checklist-cfm-2454.md:74 | Aplicar o padrão CFM a fisio, psicologia e nutrição cria obrigação perante outros conselhos? | 1.8 |
| checklist-cfm-2454.md:75 | Relação com a Anvisa (RDC 657/2022) para sugestão de CID. | 2.6 |
| checklist-cfm-2454.md:37 | Textos comerciais sobre IA frente à Res. CFM 2.336/2023. | 2.4 |
| dpa-minuta.md:18, 103, 147 | Recusa de instrução ilícita e pausa da exportação podem ser lidas como retenção de dados? | 1.1 |
| dpa-minuta.md:79, 148 | Backups com até 12 meses atendem ao art. 16 da LGPD? | 1.10 |
| dpa-minuta.md:51, 149; plano-resposta-incidentes.md:35, 153 | A comunicação à ANPD cabe sempre à clínica, mesmo com incidente na nossa infraestrutura? | 1.2 |
| dpa-minuta.md:61, 84, 85, 150 | Custo e frequência da auditoria; limitação de responsabilidade; valor do seguro. | 2.1 |
| dpa-minuta.md:93 | Foro do contrato. | 2.1 |
| dpa-minuta.md:151; papeis-controlador-operador.md:13, 17 | Co-controladoria em clínica com profissionais autônomos; configuração do tenant (clínica, autônomo, rede). | 1.1 |
| papeis-controlador-operador.md:35 | Redação final do anexo ao contrato SaaS (Termos de Uso B2B). | 2.1 |
| papeis-controlador-operador.md:49; garantias-ao-cliente.md (02-produto):22; matriz-retencao.md:91 | Após os 90 dias, de quem é a guarda dos anos restantes do prontuário? A custódia opcional é válida? | 1.10 |
| matriz-retencao.md:54; requisitos-tecnicos-seguranca.md:74; retencao-e-descarte.md:31, 40 | Documentos fiscais por 5 anos (CTN 173–174): confirmar com contador. | 2.10 |
| matriz-retencao.md:89; retencao-e-descarte.md:11, 12; requisitos-tecnicos-seguranca.md:53; memos/D07:22 | Prazo da trilha de auditoria (20 anos, 5 anos, 12 meses) é defensável? | 2.8 |
| matriz-retencao.md:90 | Confirmar a vigência da Res. CFFa 777/2025 e a revogação da 649/2022. | 1.9 |
| plano-resposta-incidentes.md:154 | Critério para não comunicar um S2. | 1.2 |
| plano-resposta-incidentes.md:155 | O prazo em dobro do pequeno porte vale para clínicas pequenas clientes? | 1.2 |
| plano-resposta-incidentes.md:136, 156 | Texto do aviso ao paciente menor e ao responsável; WhatsApp só como aviso de que há comunicado. | 1.13 |
| requisitos-tecnicos-seguranca.md:70; retencao-e-descarte.md:24, 25, 26, 95, 98 | Prazo de prontuário por profissão (CFO 20 anos; CFP 5 anos; fisio/TO, nutrição e fono por analogia) e conflito na clínica multiprofissional. | 1.9 |
| retencao-e-descarte.md:96 | 5 anos de auditoria administrativa e 12 meses de logs de acesso são defensáveis? | 2.8 |
| retencao-e-descarte.md:97 | Declarar o prazo de 12 meses dos backups imutáveis basta como eliminação? | 1.10 |
| retencao-e-descarte.md:48 | A rotina anual de descarte com aprovação da clínica atende a Lei 13.787, art. 6º, §1º? | 1.9 |
| decisoes.md (00-governanca):16 | Escopo da D8: CFM 2.454, TRF-1 estética, ANS cartões de desconto, DPA. | 1.1, 1.8, 3.5 |
| garantias-ao-cliente.md (02-produto):14, 39 | A Carta de Compromissos pode ser publicada sem violar o CDC art. 37? | 2.3 |
| garantias-ao-cliente.md (02-produto):21 | Exportação total por administrador com ciência do responsável técnico respeita o sigilo profissional? | 2.9 |
| plano-piloto.md (02-produto):23 | Validar CFM 2.454, DPA e termo de piloto antes do piloto (P5). | 1.1, 1.3, 1.8 |

### 3.2 Pareceres do Guardião (`revisoes/`)

| Arquivo:linha | Pergunta | Lote |
|---|---|---|
| revisoes/2026-10-08-pr5.md:40 | Pares rascunho/versão final de evolução como ativo de treino: risco de desvio de finalidade e art. 11, §4º. | 3.3 |
| revisoes/2026-10-08-pr5.md:79; revisoes/2026-10-11-pr29.md:94, 137 | Sugestão de CID e alerta de risco do escriba são SaMD? Efeito da revisão da RDC 657. | 2.6 |
| revisoes/2026-10-08-pr5.md:108 | Aprovação do risco residual do piloto exige parecer jurídico. | 1.6 |
| revisoes/2026-10-09-garantias.md:44, 87 | Sigilo profissional na exportação total. | 2.9 |
| revisoes/2026-10-09-garantias.md:46, 88 | Prazos de guarda por conselho na garantia de saída. | 1.9, 1.10 |
| revisoes/2026-10-12-front-r8.md:69 | Acesso de emergência (break-glass) a notas de psicologia: é admissível? Com quais limites? | 1.11 |
| revisoes/2026-10-12-front-r8.md:82 | Um número de celular do responsável com vários dependentes no portal. | 1.13 |
| revisoes/2026-10-12-front-r8.md:90 | O recibo que diz "Atendimento de psicologia" revela o tipo de cuidado; é exigência fiscal? | 2.7 |
| revisoes/2026-10-11-pr29.md:129, 140 | RIPD da IA aprovado e base legal por tarefa de IA; prova do "informado e não recusou". | 1.7 |
| revisoes/2026-10-11-pr29.md:138 | Deveres de desenvolvedor e distribuidor (CFM 2.454, Anexo I). | 1.8 |
| revisoes/2026-10-11-pr29.md:139 | Base legal de cada tarefa de IA (tutela da saúde ou consentimento) e o art. 11, §4º. | 1.7 |
| revisoes/2026-10-11-pr35.md:128 | Destruir a chave (crypto-shredding) vale como eliminação (arts. 16 e 18, VI)? | 1.10 |
| revisoes/2026-10-11-pr35.md:129 | Qual a janela aceitável entre o pedido de eliminação e a ilegibilidade efetiva? | 1.10 |
| revisoes/2026-10-11-pr35.md:130 | A clínica precisa receber a exportação em claro antes da destruição da chave, como condição técnica? | 1.10 |
| revisoes/2026-10-11-pr37.md:113 | Prazo defensável da trilha de auditoria de acesso a prontuário. | 2.8 |
| revisoes/2026-10-11-pr37.md:114 | Auditoria append-only convive com eliminação quando o titular registrado não é o paciente? | 2.8 |
| revisoes/2026-10-11-pr37.md:115 | Cadeia de hash basta como prova, ou precisa de carimbo de tempo ICP-Brasil ou âncora externa? | 2.8 |

---

## 4. Perfil do escritório ideal e como escolher

**Perfil:**
- prática **conjunta** em proteção de dados (LGPD, ANPD) e **direito da saúde** (CFM e demais conselhos, Anvisa);
- já atendeu **healthtech ou empresa de software em saúde** como operadora de dados, não só hospitais e clínicas;
- conhece **IA em saúde** (Res. CFM 2.454/2026) e **software como dispositivo médico** (RDC 657/2022);
- aceita **escopo fechado por lote**, com entregável definido (minuta, parecer curto, resposta objetiva);
- responde por escrito e em linguagem que os sócios entendem; e aceita trabalhar sobre os rascunhos que já fizemos, em vez de recomeçar do zero.

**As 6 perguntas para comparar propostas:**

1. Quais clientes **healthtech ou de software de saúde** o escritório atendeu nos últimos 2 anos, e algum era operador de dados de prontuário? (Pedir casos, não nomes, se houver sigilo.)
2. O escritório já emitiu parecer sobre a **Res. CFM 2.454/2026** ou sobre enquadramento de software na **RDC 657/2022**? Quem da equipe fará esse trabalho?
3. Qual o **modelo de cobrança** para cada lote: valor fechado, horas com teto, ou mensalidade (*retainer*)? O que acontece se o escopo crescer?
4. Em **quantos dias úteis** entregam o Lote 1, sabendo que a pergunta 1.11 (prontuário único) trava a engenharia e precisamos dela em 2 semanas?
5. A proposta inclui **uma rodada de revisão** das minutas depois dos nossos comentários? E as perguntas de dúvida durante o piloto?
6. O escritório pode atuar como **encarregado (DPO) terceirizado**, ou indicar quem faça? Há conflito de interesse em acumular parecerista e encarregado?

---

## 5. Estimativa de escopo em horas

> **ESTIMATIVA**, feita pelo Guardião LGPD, **não** dado de mercado nem orçamento. Serve só para os sócios conferirem se as propostas estão na mesma ordem de grandeza.
> **Base:** contamos as perguntas de cada item e aplicamos faixas de esforço que nós supusemos: resposta objetiva com fundamentação curta = 1 a 3 h; parecer curto sobre um tema = 4 a 10 h; revisão de minuta já existente = 8 a 20 h; redação de documento do zero = 12 a 30 h. As faixas assumem que o escritório parte dos nossos rascunhos. Não incluem reuniões além de uma de abertura por lote, nem negociação com clientes ou fornecedores.

| Lote | Itens | Composição (ESTIMATIVA) | Horas (ESTIMATIVA) |
|---|---|---|---|
| **Lote 1** | 1.1 a 1.14 | revisão do DPA e anexo de suboperadores (15–30 h); termo de piloto e aviso de privacidade do zero (15–30 h); 2 RIPDs (10–20 h); pareceres curtos de CFM 2.454, retenção, eliminação, prontuário único, DPO e menores (25–45 h); societário, se for o mesmo escritório (10–20 h) | **75–145 h** (sem societário: 65–125 h) |
| **Lote 2** | 2.1 a 2.11 | termos de uso e política de privacidade do zero (25–50 h); Carta de Compromissos e marketing (5–10 h); RIPD do WhatsApp (8–15 h); Anvisa (8–15 h); auditoria, sigilo, bases legais, Receita Saúde e teleodontologia (12–25 h) | **58–115 h** |
| **Lote 3** | 3.1 a 3.5 | pareceres curtos sob demanda | **20–45 h** |

**Valores em reais:** não estimamos. **Pedir 2 a 3 propostas** com este pacote anexado e comparar pelas 6 perguntas da §4. Pedir que cada proposta separe o preço por lote, para que o Lote 1 possa ser contratado sozinho.

**Como reduzir horas:** enviar este pacote e os documentos citados antes da primeira reunião; pedir respostas no formato da coluna "Pergunta jurídica objetiva"; concentrar as dúvidas em um único interlocutor do nosso lado.

---

## 6. O que NÃO é aconselhamento jurídico

- Este pacote, os rascunhos citados (DPA, RIPDs, matrizes, planos, checklists) e os pareceres do Guardião LGPD foram preparados por **agentes de IA** sob supervisão dos sócios. São **orientação técnico-regulatória** para engenharia e produto, **não** são parecer jurídico e **não** devem ser usados com cliente, fornecedor ou autoridade antes da revisão do escritório.
- Leituras marcadas como "NOSSA LEITURA", "PROPOSTA" ou ⚖️ são hipóteses de trabalho, não conclusões.
- As referências a normas foram conferidas nas datas indicadas em cada documento (a maioria em 10 e 11/10/2026). Normas mudam; o escritório deve conferir a versão vigente.
- As estimativas de horas da §5 são **ESTIMATIVA** interna e não substituem a proposta do escritório.
- Nenhum documento deste pacote contém dado real de paciente. Se o escritório precisar de exemplo, usaremos dado fictício.
