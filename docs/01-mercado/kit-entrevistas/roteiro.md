# Roteiro de entrevista (30 minutos)

> Evolução do roteiro curto do [relatório executivo §6.3](../relatorio-executivo-mercado.md), reescrito no estilo **"Mom Test"**: perguntar sobre **o que a pessoa fez** (passado, concreto), não sobre o que ela acha ou faria. Cada pergunta indica a hipótese que testa (H1–H10 do relatório §6.2) e a coluna do `planilha-respostas.csv`.

## Regras de ouro (ler antes de cada entrevista)
1. **Não venda e não explique o produto** até o bloco 8. Se perguntarem "o que vocês vão fazer?", responda: "Ainda estamos decidindo, por isso estou aqui. No final eu conto."
2. **Passado e números, não opinião.** Troque "você usaria...?" por "da última vez que..., o que você fez?". Elogio ("que ideia ótima!") não é dado; anote, mas não conte como sinal.
3. **Cave cada dor com 3 perguntas:** "Quando foi a última vez?", "O que você fez para resolver?", "Quanto isso custou (tempo ou dinheiro)?". Dor sem gasto de tempo, dinheiro ou gambiarra é dor fraca.
4. **Fale 20%, ouça 80%.** Silêncio depois da resposta costuma trazer o detalhe mais útil.
5. **Nenhum dado de paciente** (consentimento.md §3). Peça exemplos genéricos.
6. Quem anota marca, ao lado de cada resposta: **[C]** confirma, **[R]** refuta, **[I]** inconclusivo, para a hipótese indicada.

Siglas: (A) só fisio/TO · (B) só psicólogo · (C) só TEA. Sem marca = todos.

---

## Bloco 0. Abertura e consentimento (0–3 min)
- Agradecer, dizer o objetivo e o tempo (30 min), reforçar que não é venda.
- Ler o texto do [consentimento.md](consentimento.md) §1 e registrar as duas respostas.

## Bloco 1. Contexto (3–6 min)
| # | Pergunta | Testa | Coluna |
|---|---|---|---|
| 1.1 | Quantos profissionais atendem aqui e em que regime (sócio, PJ, CLT)? Tem recepção? | perfil, H7 | `porte_profissionais`, `regime`, `tem_recepcao` |
| 1.2 | Quantas sessões vocês fizeram na semana passada, mais ou menos? | perfil | `sessoes_semana` |
| 1.3 | Dos atendimentos do último mês, que parte foi particular, convênio e reembolso/liminar? | H2, lacuna L7 | `pct_particular`, `pct_convenio` |
| 1.4 | Atende como pessoa física, PJ ou os dois? (B, e fisio autônomo) | D14 | `pessoa_fisica` |

## Bloco 2. Sistema atual e troca (6–11 min)
| # | Pergunta | Testa | Coluna |
|---|---|---|---|
| 2.1 | Que sistemas, planilhas ou cadernos vocês usam hoje para agenda, prontuário e financeiro? Me mostre de cabeça como é um dia. | H9, L6 | `sistema_atual`, `qtd_ferramentas` |
| 2.2 | Quanto pagaram no último mês **no total**, somando extras (WhatsApp, assinatura eletrônica, IA, Pix, NFS-e)? | H1, H4, G5 | `gasto_mensal_total_rs`, `paga_extras` |
| 2.3 | Conte a **última vez** que pensaram em trocar de sistema. O que aconteceu? | H4 | `pensou_trocar_12m`, `motivo_troca` |
| 2.4 | E o que impediu (ou o que deu trabalho, se trocaram)? Quanto tempo levou da ideia à troca? | H5 | `barreira_troca`, `migracao_principal_barreira` |
| 2.5 | Já tiveram problema com cancelamento, cobrança a mais ou suporte demorado? O que fizeram? | H4, garantias G1–G7 | `motivo_troca` |

## Bloco 3. Agenda e faltas (11–14 min)
| # | Pergunta | Testa | Coluna |
|---|---|---|---|
| 3.1 | Na semana passada, quantos pacientes faltaram ou desmarcaram em cima da hora? | valor do WhatsApp incluído (D2/G5) | `faltas_semana` |
| 3.2 | O que vocês fazem hoje para lembrar o paciente? Quem faz, e quanto tempo leva por dia? | D2/G5 | `lembrete_atual`, `min_lembrete_dia` |
| 3.3 | (A) Como vocês marcam vários pacientes no mesmo horário (ginásio, pilates)? | escopo M1 | `agenda_simultanea` |

## Bloco 4. Pacotes, guias de convênio e repasse (14–19 min)
| # | Pergunta | Testa | Coluna |
|---|---|---|---|
| 4.1 | Como controlam hoje o saldo de um pacote de sessões? Me conte a última vez que o saldo deu errado. | escopo M1, dor | `controle_pacotes` |
| 4.2 | (A, C) Como controlam as guias: sessões autorizadas, realizadas, validade e assinatura do paciente? Quem faz e quanto tempo leva? | H2 | `controle_guias` |
| 4.3 | (A, C) Como e onde fazem o faturamento do convênio (portal da operadora, XML pelo sistema, faturista)? | H2 | `faturamento_convenio` |
| 4.4 | (A, C, só se atendem convênio) Imagine que, durante 6 meses, o sistema controlasse guia, saldo e assinatura, mas o envio do lote continuasse no portal da operadora, como fazem hoje ou não. Isso impediria vocês de usar? Por quê? *(única pergunta hipotética do bloco: anotar o motivo, não só o sim/não)* | **H2** | `opera_sem_xml_6m` |
| 4.5 | (A, C, 3+ profissionais) Como calcularam o repasse de cada profissional no mês passado? Quanto tempo levou o fechamento? | **H7** | `repasse_como`, `horas_fechamento_mes` |
| 4.6 | (C) Como provam para a operadora que a sessão aconteceu? Na última auditoria, houve glosa ou corte de horas? Quanto custou? | **H3** | `glosa_ultima_auditoria`, `custo_glosa_rs` |
| 4.7 | (C) Quantos sistemas e planilhas usam para gestão, programa ABA e faturamento? | **H9** | `qtd_ferramentas` |

## Bloco 5. Cobrança, Pix e recibos (19–22 min)
| # | Pergunta | Testa | Coluna |
|---|---|---|---|
| 5.1 | Como os pacientes pagaram no último mês (Pix, cartão, dinheiro, pacote, mensalidade)? | H10 | `meio_pagamento_principal` |
| 5.2 | Quanto ficou em aberto no fim do mês passado? O que fizeram para cobrar? | H10 | `inadimplencia_pct`, `como_cobra` |
| 5.3 | Hoje o dinheiro cai direto na conta de vocês. O que teria de ser verdade para aceitarem receber por uma plataforma (com taxa)? | **H10** | `aceita_gateway` |
| 5.4 | (pessoa física) Como emitiram os recibos do Receita Saúde no último mês? Quanto tempo levou? | **D14** | `receita_saude_como`, `min_receita_saude_mes` |

## Bloco 6. Prontuário (22–24 min)
| # | Pergunta | Testa | Coluna |
|---|---|---|---|
| 6.1 | Onde escrevem a evolução hoje? Quanto tempo por dia cada profissional gastou com isso ontem? Escrevem na hora ou depois do expediente? | **H8** | `min_evolucao_dia`, `escreve_depois_expediente` |
| 6.2 | Já perderam acesso a prontuário, ou tiveram medo de perder, por atraso de pagamento ou troca de sistema? | H4, G1–G3 | `medo_perder_prontuario` |

## Bloco 7. IA (24–25 min)
| # | Pergunta | Testa | Coluna |
|---|---|---|---|
| 7.1 | Alguém aqui já usou alguma ferramenta de IA (ChatGPT, transcrição, scribe) para escrever evolução ou relatório? Como foi? *(se sim: com qual cuidado sobre o dado do paciente?)* | **H8** | `ja_usou_ia` |
| 7.2 | Se um rascunho viesse pronto e vocês tivessem de revisar e assinar, quanto tempo de revisão seria aceitável? Algum paciente ou família já recusou gravação ou algo parecido? | **H8** | `usaria_escriba`, `pacientes_recusariam` |

## Bloco 8. Preço: Van Westendorp simplificado (25–28 min)
Só agora descreva o conceito, **lendo exatamente** o texto abaixo (todos ouvem a mesma coisa):

> "Imagine um sistema com agenda, prontuário, controle de pacotes e guias, repasse, lembretes por WhatsApp, Pix, recibos e um rascunho de evolução por IA que você revisa. Tudo incluído num preço único, sem fidelidade, com exportação dos seus dados grátis a qualquer momento."

Pergunte **na unidade do perfil**: (A) por profissional por mês · (B) por mês, para você · (C) por paciente ativo por mês. Anote o número que a pessoa disser, sem sugerir valores.

| # | Pergunta | Coluna |
|---|---|---|
| 8.1 | A partir de que preço seria **tão barato** que você desconfiaria da qualidade? | `vw_barato_demais` |
| 8.2 | A que preço você acharia **uma pechincha**, um bom negócio? | `vw_barato` |
| 8.3 | A partir de que preço começaria a achar **caro**, mas ainda pensaria? | `vw_caro` |
| 8.4 | A partir de que preço seria **caro demais**, nem consideraria? | `vw_caro_demais` |

Testa **H1** (A), **H6** (B), **H3** (C). Lembrete: resposta de preço é opinião; compare com o `gasto_mensal_total_rs` (bloco 2), que é comportamento.

## Bloco 9. Fechamento (28–30 min)
| # | Pergunta | Coluna |
|---|---|---|
| 9.1 | De tudo o que conversamos, o que mais atrapalha a sua semana? (anotar as palavras da pessoa) | `dor_1` |
| 9.2 | Estamos chamando 5 clínicas para serem **parceiras de design**: testar telas com dados fictícios, 1 conversa a cada 2 semanas, sem custo e sem compromisso de compra. Topa que eu te mande os detalhes? *(compromisso de tempo = sinal forte)* | `aceita_parceira_design` |
| 9.3 | Quem mais você conhece que eu deveria ouvir? Pode me apresentar? *(pedir que a pessoa avise o indicado antes)* | `indicacoes_qtd` |
| 9.4 | Agradecer, lembrar que tudo é apagado em 12 meses e dar o e-mail de contato. | — |

---

## Depois da entrevista (até 2 h depois, os dois sócios juntos)
1. Preencher uma linha no `planilha-respostas.csv`, com as dores 1–5 em ordem de força (critério: evidência de gasto de tempo/dinheiro).
2. Marcar o sinal de cada hipótese (C/R/I/NA) nas colunas `H1`–`H10`.
3. Uma citação marcante, sem nome e sem dado de paciente, em `citacao_chave`.
4. Guardar áudio e notas brutas fora do git (consentimento.md §3) e criar o lembrete de exclusão em 12 meses.
